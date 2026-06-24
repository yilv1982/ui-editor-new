using UnityEditor;
using UnityEngine;
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;

[InitializeOnLoad]
public static class UIEditorNewBridgeServer
{
    private const int BridgePort = 18082;
    private static TcpListener _listener;
    private static Thread _thread;
    private static bool _running;
    private static SynchronizationContext _mainContext;
    private static readonly object PendingLock = new object();
    private static readonly Queue<PendingRequest> PendingRequests = new Queue<PendingRequest>();
    private static readonly object PerfLogLock = new object();
    private static readonly List<string> PerfLogs = new List<string>();

    static UIEditorNewBridgeServer()
    {
        _mainContext = SynchronizationContext.Current;
        EditorApplication.delayCall -= UIEditorNewBridgeCore.CleanupBridgeRuntimeState;
        EditorApplication.delayCall += UIEditorNewBridgeCore.CleanupBridgeRuntimeState;
        EditorApplication.update += ProcessPendingRequests;
        Start();
        EditorApplication.quitting += Stop;
        AssemblyReloadEvents.beforeAssemblyReload += Stop;
    }

    [MenuItem("UIEditorNew/Start Bridge")]
    private static void StartFromMenu()
    {
        Start(true);
    }

    public static void Start()
    {
        Start(false);
    }

    private static void Start(bool showDialog)
    {
        if (_running)
        {
            string message = "UIEditorNewBridge is already running at http://127.0.0.1:" + BridgePort;
            Debug.Log("[UIEditorNewBridge] " + message);
            if (showDialog) EditorUtility.DisplayDialog("UIEditorNew Bridge", message, "OK");
            return;
        }

        try
        {
            _listener = new TcpListener(IPAddress.Loopback, BridgePort);
            _listener.Start();
            _running = true;
            _thread = new Thread(AcceptLoop) { IsBackground = true, Name = "UIEditorNewBridgeServer" };
            _thread.Start();
            string message = "Local bridge started: http://127.0.0.1:" + BridgePort;
            Debug.Log("[UIEditorNewBridge] " + message);
            if (showDialog) EditorUtility.DisplayDialog("UIEditorNew Bridge", message, "OK");
        }
        catch (Exception ex)
        {
            string message = "Failed to start on " + BridgePort + ". It will not fall back to old UIEditor 8081: " + ex.Message;
            Debug.LogWarning("[UIEditorNewBridge] " + message);
            if (showDialog) EditorUtility.DisplayDialog("UIEditorNew Bridge", message, "OK");
        }
    }

    [MenuItem("UIEditorNew/Stop Bridge")]
    public static void Stop()
    {
        UIEditorNewBridgeCore.CleanupBridgeRuntimeState();
        _running = false;
        try { _listener?.Stop(); } catch {}
        try { _listener?.Server?.Close(); } catch {}
        _listener = null;
        try
        {
            if (_thread != null && _thread.IsAlive) _thread.Join(1000);
        }
        catch {}
        _thread = null;
        UIEditorNewBridgeCore.CleanupBridgeRuntimeState();
    }

    private static void AcceptLoop()
    {
        while (_running)
        {
            try
            {
                TcpClient client = _listener.AcceptTcpClient();
                ThreadPool.QueueUserWorkItem(_ => HandleClient(client));
            }
            catch (SocketException) { break; }
            catch (ObjectDisposedException) { break; }
            catch {}
        }
    }

    private static void HandleClient(TcpClient client)
    {
        NetworkStream stream = null;
        try
        {
            long requestReceivedAt = System.Diagnostics.Stopwatch.GetTimestamp();
            client.ReceiveTimeout = 30000;
            client.SendTimeout = 30000;
            stream = client.GetStream();

            string method;
            string path;
            Dictionary<string, string> headers;
            byte[] body;
            if (!ReadHttpRequest(stream, out method, out path, out headers, out body))
                return;

            string corsHeaders =
                "Access-Control-Allow-Origin: *\r\n" +
                "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n" +
                "Access-Control-Allow-Headers: Content-Type, Accept, Access-Control-Request-Private-Network\r\n" +
                "Access-Control-Allow-Private-Network: true\r\n" +
                "Timing-Allow-Origin: *\r\n";

            if (method == "OPTIONS")
            {
                WriteResponse(stream, 204, "No Content", corsHeaders, null);
                return;
            }

            path = StripQuery(path);

            if (method == "GET" && (path == "/" || path == "/health"))
            {
                WriteJson(stream, 200, "OK", corsHeaders, UIEditorNewBridgeCore.HealthJson());
                return;
            }

            if (method == "GET" && path == "/perf-logs")
            {
                WriteJson(stream, 200, "OK", corsHeaders, PerfLogsJson());
                return;
            }

            if (method == "GET" && path.StartsWith("/snapshots/", StringComparison.Ordinal))
            {
                ServeSnapshot(stream, corsHeaders, path.Substring("/snapshots/".Length));
                return;
            }

            if (method == "POST" && IsBridgeEndpoint(path))
            {
                string json = body != null ? Encoding.UTF8.GetString(body) : "";
                if (path == "/perf-log")
                {
                    AddPerfLog(json);
                    WriteJson(stream, 200, "OK", corsHeaders, "{\"ok\":true}");
                    return;
                }
                if (path == "/perf-logs/clear")
                {
                    ClearPerfLogs();
                    WriteJson(stream, 200, "OK", corsHeaders, "{\"ok\":true}");
                    return;
                }
                PendingRequest pending = EnqueueRequest(path, json, requestReceivedAt);
                if (!pending.Done.WaitOne(120000))
                {
                    WriteJson(stream, 504, "Gateway Timeout", corsHeaders, "{\"ok\":false,\"error\":{\"code\":\"TIMEOUT\",\"message\":\"bridge request timed out\"}}");
                    return;
                }
                pending.ResponseReadyAt = System.Diagnostics.Stopwatch.GetTimestamp();
                pending.ResponseJson = AttachServerProfile(pending.ResponseJson, pending);

                WriteJson(stream, 200, "OK", corsHeaders,
                    string.IsNullOrEmpty(pending.ResponseJson)
                        ? "{\"ok\":false,\"error\":{\"code\":\"EMPTY_RESPONSE\",\"message\":\"empty bridge response\"}}"
                        : pending.ResponseJson);
                return;
            }

            WriteJson(stream, 404, "Not Found", corsHeaders, "{\"ok\":false,\"error\":{\"code\":\"NOT_FOUND\",\"message\":\"not found\"}}");
        }
        catch (Exception ex)
        {
            try
            {
                if (stream != null)
                    WriteJson(stream, 500, "Error", "Access-Control-Allow-Origin: *\r\n", UIEditorNewBridgeCore.FailJson("SERVER_ERROR", ex.Message));
            }
            catch {}
        }
        finally
        {
            try { stream?.Close(); } catch {}
            try { client?.Close(); } catch {}
        }
    }

    private static bool IsBridgeEndpoint(string path)
    {
        return path == "/create-blank-artboard" ||
               path == "/resume-session" ||
               path == "/open-prefab" ||
               path == "/export-node-tree" ||
               path == "/render-snapshot" ||
               path == "/capture-scene-gameview" ||
               path == "/apply-visual-patch" ||
               path == "/move-node" ||
               path == "/resize-node" ||
               path == "/set-text" ||
               path == "/set-text-style" ||
               path == "/set-image" ||
               path == "/set-visible" ||
               path == "/reparent-node" ||
               path == "/insert-prefab" ||
               path == "/create-frame-node" ||
               path == "/create-text-node" ||
               path == "/create-image-node" ||
               path == "/create-widget-node" ||
               path == "/duplicate-nodes" ||
               path == "/copy-nodes-to-session" ||
               path == "/group-nodes" ||
               path == "/ungroup-nodes" ||
               path == "/delete-node" ||
               path == "/undo-artboard" ||
               path == "/redo-artboard" ||
               path == "/validate-protected-diff" ||
               path == "/save-prefab" ||
               path == "/save-artboard" ||
               path == "/close-prefab" ||
               path == "/cleanup-runtime-state" ||
               path == "/perf-log" ||
               path == "/perf-logs/clear";
    }

    private static void AddPerfLog(string json)
    {
        if (string.IsNullOrWhiteSpace(json)) return;
        lock (PerfLogLock)
        {
            PerfLogs.Add(json);
            while (PerfLogs.Count > 1000) PerfLogs.RemoveAt(0);
        }
    }

    private static void ClearPerfLogs()
    {
        lock (PerfLogLock)
        {
            PerfLogs.Clear();
        }
    }

    private static string PerfLogsJson()
    {
        lock (PerfLogLock)
        {
            return "{\"ok\":true,\"logs\":[" + string.Join(",", PerfLogs.ToArray()) + "]}";
        }
    }

    private static PendingRequest EnqueueRequest(string path, string json, long requestReceivedAt)
    {
        PendingRequest pending = new PendingRequest
        {
            Path = path,
            Json = json,
            RequestReceivedAt = requestReceivedAt,
            EnqueuedAt = System.Diagnostics.Stopwatch.GetTimestamp()
        };
        lock (PendingLock)
        {
            PendingRequests.Enqueue(pending);
        }
        _mainContext?.Post(_ => ProcessPendingRequests(), null);
        return pending;
    }

    private static void ProcessPendingRequests()
    {
        while (true)
        {
            PendingRequest pending = null;
            lock (PendingLock)
            {
                if (PendingRequests.Count > 0)
                    pending = PendingRequests.Dequeue();
                else
                    return;
            }

            try
            {
                pending.DequeuedAt = System.Diagnostics.Stopwatch.GetTimestamp();
                pending.ResponseJson = UIEditorNewBridgeCore.Handle(pending.Path, pending.Json);
                pending.HandledAt = System.Diagnostics.Stopwatch.GetTimestamp();
                pending.Ok = pending.ResponseJson != null && pending.ResponseJson.Contains("\"ok\":true");
            }
            catch (Exception ex)
            {
                pending.HandledAt = System.Diagnostics.Stopwatch.GetTimestamp();
                pending.ResponseJson = UIEditorNewBridgeCore.FailJson("UNHANDLED_EXCEPTION", ex.Message);
                pending.Ok = false;
            }
            finally
            {
                pending.Done.Set();
            }
        }
    }

    private static string AttachServerProfile(string json, PendingRequest pending)
    {
        if (string.IsNullOrEmpty(json)) return json;
        int insertAt = json.LastIndexOf('}');
        if (insertAt <= 0) return json;

        string profile =
            "\"serverProfile\":{" +
            "\"path\":\"" + EscapeJson(pending.Path) + "\"," +
            "\"requestReadMs\":" + FormatMs(pending.RequestReceivedAt, pending.EnqueuedAt) + "," +
            "\"mainThreadQueueMs\":" + FormatMs(pending.EnqueuedAt, pending.DequeuedAt) + "," +
            "\"mainThreadHandleMs\":" + FormatMs(pending.DequeuedAt, pending.HandledAt) + "," +
            "\"workerWaitMs\":" + FormatMs(pending.EnqueuedAt, pending.ResponseReadyAt) + "," +
            "\"responseJsonBytes\":" + Encoding.UTF8.GetByteCount(json) +
            "}";

        string prefix = json.Substring(0, insertAt).TrimEnd();
        string separator = prefix.EndsWith("{", StringComparison.Ordinal) ? "" : ",";
        return json.Substring(0, insertAt) + separator + profile + json.Substring(insertAt);
    }

    private static string FormatMs(long start, long end)
    {
        if (start <= 0 || end <= 0 || end < start) return "0";
        double ms = (end - start) * 1000.0 / System.Diagnostics.Stopwatch.Frequency;
        return ms.ToString("0.###", CultureInfo.InvariantCulture);
    }

    private static string EscapeJson(string value)
    {
        if (string.IsNullOrEmpty(value)) return "";
        return value.Replace("\\", "\\\\").Replace("\"", "\\\"");
    }

    private static void ServeSnapshot(NetworkStream stream, string corsHeaders, string fileName)
    {
        fileName = Uri.UnescapeDataString(fileName ?? "");
        fileName = Path.GetFileName(fileName);
        bool isPng = fileName.EndsWith(".png", StringComparison.OrdinalIgnoreCase);
        bool isJpg = fileName.EndsWith(".jpg", StringComparison.OrdinalIgnoreCase) || fileName.EndsWith(".jpeg", StringComparison.OrdinalIgnoreCase);
        if (string.IsNullOrEmpty(fileName) || (!isPng && !isJpg))
        {
            WriteJson(stream, 400, "Bad Request", corsHeaders, "{\"ok\":false,\"error\":{\"code\":\"BAD_SNAPSHOT_PATH\",\"message\":\"invalid snapshot path\"}}");
            return;
        }

        string path = UIEditorNewBridgeCore.ResolveSnapshotPath(fileName);
        if (!File.Exists(path))
        {
            WriteJson(stream, 404, "Not Found", corsHeaders, "{\"ok\":false,\"error\":{\"code\":\"SNAPSHOT_NOT_FOUND\",\"message\":\"snapshot not found\"}}");
            return;
        }

        string contentType = isJpg ? "image/jpeg" : "image/png";
        byte[] bytes = File.ReadAllBytes(path);
        WriteResponse(stream, 200, "OK",
            corsHeaders + "Content-Type: " + contentType + "\r\nContent-Length: " + bytes.Length + "\r\n",
            bytes);
    }

    private static bool ReadHttpRequest(NetworkStream stream, out string method, out string path, out Dictionary<string, string> headers, out byte[] body)
    {
        method = null;
        path = null;
        headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        body = null;

        List<byte> headerBytes = new List<byte>(4096);
        int previous3 = -1;
        int previous2 = -1;
        int previous1 = -1;
        while (true)
        {
            int value = stream.ReadByte();
            if (value < 0) return false;
            headerBytes.Add((byte)value);
            if (previous3 == '\r' && previous2 == '\n' && previous1 == '\r' && value == '\n')
                break;
            previous3 = previous2;
            previous2 = previous1;
            previous1 = value;
            if (headerBytes.Count > 65536) return false;
        }

        string headerText = Encoding.ASCII.GetString(headerBytes.ToArray());
        string[] lines = headerText.Split(new[] { "\r\n" }, StringSplitOptions.None);
        if (lines.Length == 0) return false;

        string[] requestParts = lines[0].Split(' ');
        if (requestParts.Length < 2) return false;
        method = requestParts[0].ToUpperInvariant();
        path = requestParts[1];

        for (int i = 1; i < lines.Length; i++)
        {
            int separator = lines[i].IndexOf(':');
            if (separator > 0)
                headers[lines[i].Substring(0, separator).Trim()] = lines[i].Substring(separator + 1).Trim();
        }

        string contentLengthText;
        if (headers.TryGetValue("content-length", out contentLengthText))
        {
            int contentLength;
            if (int.TryParse(contentLengthText, out contentLength) && contentLength > 0)
            {
                body = new byte[contentLength];
                int offset = 0;
                while (offset < contentLength)
                {
                    int read = stream.Read(body, offset, contentLength - offset);
                    if (read <= 0) break;
                    offset += read;
                }
            }
        }

        return true;
    }

    private static string StripQuery(string path)
    {
        if (string.IsNullOrEmpty(path)) return path;
        int query = path.IndexOf('?');
        return query >= 0 ? path.Substring(0, query) : path;
    }

    private static void WriteJson(NetworkStream stream, int statusCode, string statusText, string corsHeaders, string json)
    {
        byte[] body = Encoding.UTF8.GetBytes(json ?? "{}");
        WriteResponse(stream, statusCode, statusText,
            corsHeaders + "Content-Type: application/json\r\nContent-Length: " + body.Length + "\r\n",
            body);
    }

    private static void WriteResponse(NetworkStream stream, int statusCode, string statusText, string extraHeaders, byte[] body)
    {
        StringBuilder sb = new StringBuilder();
        sb.Append("HTTP/1.1 ").Append(statusCode).Append(' ').Append(statusText).Append("\r\n");
        sb.Append("Connection: close\r\n");
        if (!string.IsNullOrEmpty(extraHeaders)) sb.Append(extraHeaders);
        sb.Append("\r\n");

        byte[] headerData = Encoding.ASCII.GetBytes(sb.ToString());
        stream.Write(headerData, 0, headerData.Length);
        if (body != null && body.Length > 0)
            stream.Write(body, 0, body.Length);
        stream.Flush();
    }

    private class PendingRequest
    {
        public string Path;
        public string Json;
        public string ResponseJson;
        public bool Ok;
        public long RequestReceivedAt;
        public long EnqueuedAt;
        public long DequeuedAt;
        public long HandledAt;
        public long ResponseReadyAt;
        public ManualResetEvent Done = new ManualResetEvent(false);
    }
}

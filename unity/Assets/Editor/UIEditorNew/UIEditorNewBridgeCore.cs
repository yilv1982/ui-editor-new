using UnityEditor;
using UnityEngine;
using UnityEngine.UI;
using UnityEngine.SceneManagement;
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Reflection;

public static partial class UIEditorNewBridgeCore
{
    private const string PrefabRoot = "Assets/HotRes2/UIs/Prefabs";
    private const string TempPrefabRoot = "Assets/Temp/UIEditorNew";
    private const string SnapshotFolder = "Temp/UIEditorNew/Snapshots";
    private const string BridgeVersion = "UIEditor_new-bridge-mvp-81-ngui-preserve-static-widget-size";
    private const int CaptureLayer = 31;
    private const int SnapshotJpegQuality = 80;
    private const double MemoryAutosaveIdleSeconds = 15.0;
    private const string FrameworkUGUI = "ugui";
    private const string FrameworkNGUI = "ngui";
    private const string FrameworkMixed = "mixed";
    private const string FrameworkUnknown = "unknown";
    private static readonly string BridgeLoadId = Guid.NewGuid().ToString("N");
    private static readonly string BridgeLoadedAtUtc = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture);
    private static readonly Dictionary<string, SessionState> Sessions = new Dictionary<string, SessionState>();
    private static readonly object HealthCacheLock = new object();
    private static string CachedProjectPath = "";
    private static string CachedUnityVersion = "";
    private static EditorStatus CachedEditorStatus = new EditorStatus();

    static UIEditorNewBridgeCore()
    {
        EditorApplication.delayCall -= CleanupBridgeRuntimeState;
        EditorApplication.delayCall += CleanupBridgeRuntimeState;
        EditorApplication.update -= UpdateHealthCache;
        EditorApplication.update += UpdateHealthCache;
        EditorApplication.update -= ProcessIdleAutosaves;
        EditorApplication.update += ProcessIdleAutosaves;
    }

    private static void UpdateHealthCache()
    {
        lock (HealthCacheLock)
        {
            CachedProjectPath = ProjectRoot().Replace("\\", "/");
            CachedUnityVersion = Application.unityVersion;
            CachedEditorStatus = new EditorStatus
            {
                isCompiling = EditorApplication.isCompiling,
                isUpdating = EditorApplication.isUpdating,
                isPlaying = EditorApplication.isPlaying,
                isPlayingOrWillChangePlaymode = EditorApplication.isPlayingOrWillChangePlaymode,
                timeSinceStartup = EditorApplication.timeSinceStartup
            };
        }
    }

    private static EditorStatus CloneEditorStatus(EditorStatus status)
    {
        if (status == null) return new EditorStatus();
        return new EditorStatus
        {
            isCompiling = status.isCompiling,
            isUpdating = status.isUpdating,
            isPlaying = status.isPlaying,
            isPlayingOrWillChangePlaymode = status.isPlayingOrWillChangePlaymode,
            timeSinceStartup = status.timeSinceStartup
        };
    }

    public static string Handle(string path, string json)
    {
        if (path == "/create-blank-artboard") return CreateBlankArtboard(json);
        if (path == "/resume-session") return ResumeSession(json);
        if (path == "/open-prefab") return OpenPrefab(json);
        if (path == "/export-node-tree") return ExportNodeTree(json);
        if (path == "/render-snapshot") return RenderSnapshot(json);
        if (path == "/capture-scene-gameview") return CaptureSceneGameView(json);
        if (path == "/apply-visual-patch") return ApplyVisualPatch(json);
        if (path == "/move-node") return MoveNode(json);
        if (path == "/resize-node") return ResizeNode(json);
        if (path == "/set-text") return SetText(json);
        if (path == "/set-text-style") return SetTextStyle(json);
        if (path == "/set-image") return SetImage(json);
        if (path == "/set-visible") return SetVisible(json);
        if (path == "/reparent-node") return ReparentNode(json);
        if (path == "/insert-prefab") return InsertPrefab(json);
        if (path == "/create-frame-node") return CreateFrameNode(json);
        if (path == "/create-text-node") return CreateTextNode(json);
        if (path == "/create-image-node") return CreateImageNode(json);
        if (path == "/create-widget-node") return CreateWidgetNode(json);
        if (path == "/duplicate-nodes") return DuplicateNodes(json);
        if (path == "/copy-nodes-to-session") return CopyNodesToSession(json);
        if (path == "/group-nodes") return GroupNodes(json);
        if (path == "/ungroup-nodes") return UngroupNodes(json);
        if (path == "/delete-node") return DeleteNode(json);
        if (path == "/undo-artboard") return UndoArtboard(json);
        if (path == "/redo-artboard") return RedoArtboard(json);
        if (path == "/validate-protected-diff") return ValidateProtectedDiff(json);
        if (path == "/save-prefab") return SavePrefab(json);
        if (path == "/save-artboard") return SaveArtboard(json);
        if (path == "/close-prefab") return ClosePrefab(json);
        if (path == "/cleanup-runtime-state") return CleanupRuntimeState(json);
        return FailJson("NOT_FOUND", "Unknown endpoint: " + path);
    }

    public static string HealthJson()
    {
        string projectPath;
        string unityVersion;
        EditorStatus editor;
        lock (HealthCacheLock)
        {
            projectPath = CachedProjectPath;
            unityVersion = CachedUnityVersion;
            editor = CloneEditorStatus(CachedEditorStatus);
        }
        return JsonUtility.ToJson(new HealthResponse
        {
            ok = true,
            name = "UIEditorNewBridge",
            version = BridgeVersion,
            loadId = BridgeLoadId,
            loadedAtUtc = BridgeLoadedAtUtc,
            unityVersion = unityVersion,
            projectPath = projectPath,
            editor = editor,
            capabilities = new[]
            {
                "openPrefab",
                "createBlankArtboard",
                "resumeSession",
                "exportNodeTree",
                "renderSnapshot",
                "applyVisualPatch",
                "frameworkRouting",
                "nguiAdapter",
                "nguiSceneInstanceSnapshot",
                "remotePrefabOperations",
                "createVisualNodes",
                "createWidgetNodes",
                "duplicateNodes",
                "copyNodesToSession",
                "groupNodes",
                "ungroupNodes",
                "validateProtectedDiff",
                "savePrefab",
                "saveArtboard",
                "closePrefab"
            }
        });
    }

    public static string FailJson(string code, string message)
    {
        return JsonUtility.ToJson(new BaseResponse
        {
            ok = false,
            error = new ErrorInfo { code = code, message = message }
        });
    }

    public static string ResolveSnapshotPath(string fileName)
    {
        return Path.Combine(ProjectRoot(), SnapshotFolder, Path.GetFileName(fileName));
    }

    private static string CleanupRuntimeState(string json)
    {
        int sessionsBefore = Sessions.Count;
        CleanupBridgeRuntimeState();
        return JsonUtility.ToJson(new RuntimeCleanupResponse
        {
            ok = true,
            sessionsBefore = sessionsBefore,
            sessionsAfter = Sessions.Count
        });
    }

    private static string CreateBlankArtboard(string json)
    {
        CreateBlankRequest request = JsonUtility.FromJson<CreateBlankRequest>(json);
        string name = request != null && !string.IsNullOrEmpty(request.name) ? SanitizeAssetName(request.name) : "NewUI";
        int width = request != null && request.width > 0 ? request.width : 1080;
        int height = request != null && request.height > 0 ? request.height : 1920;

        EnsureAssetFolder(TempPrefabRoot);
        string workingPrefabPath = TempPrefabRoot + "/" + name + "__uieditor_new_blank_" + Guid.NewGuid().ToString("N").Substring(0, 8) + ".prefab";

        Scene previewScene = CreateBridgePreviewScene();
        GameObject root = new GameObject(name);
        MoveRootToScene(root, previewScene);
        try
        {
            RectTransform rect = root.AddComponent<RectTransform>();
            rect.anchorMin = new Vector2(0.5f, 0.5f);
            rect.anchorMax = new Vector2(0.5f, 0.5f);
            rect.pivot = new Vector2(0.5f, 0.5f);
            rect.anchoredPosition = Vector2.zero;
            rect.sizeDelta = new Vector2(width, height);
            PrefabUtility.SaveAsPrefabAsset(root, workingPrefabPath);
        }
        finally
        {
            UnityEngine.Object.DestroyImmediate(root);
            CloseBridgePreviewScene(previewScene);
        }

        SessionState session = CreateSession(null, workingPrefabPath, "temp-copy", ReadAssetText(workingPrefabPath));
        BridgeTiming timing = new BridgeTiming(request != null && request.profile);
        return BuildArtboardResponseJson(session, null, request == null || !request.skipSnapshot, timing);
    }

    private static string ResumeSession(string json)
    {
        ResumeSessionRequest request = JsonUtility.FromJson<ResumeSessionRequest>(json);
        if (request == null || string.IsNullOrEmpty(request.workingPrefabPath))
            return FailJson("BAD_REQUEST", "workingPrefabPath is required");

        string workingPrefabPath = NormalizeAssetPath(request.workingPrefabPath);
        SessionState existing = FindSessionByWorkingPrefabPath(workingPrefabPath);
        if (existing != null)
            return BuildArtboardResponseJson(existing, request.selectedNodeId);

        GameObject prefab = AssetDatabase.LoadAssetAtPath<GameObject>(workingPrefabPath);
        if (prefab == null)
            return FailJson("PREFAB_NOT_FOUND", "Working prefab not found: " + workingPrefabPath);

        string sourcePrefabPath = string.IsNullOrEmpty(request.sourcePrefabPath) ? null : NormalizePrefabPath(request.sourcePrefabPath);
        // Browser recovery only stores the working prefab path. The working prefab is the
        // authoritative temporary edit state, so after a refresh we accept its current
        // structure as the protected baseline and protect subsequent edits from there.
        string baseline = ReadAssetText(workingPrefabPath);
        SessionState session = CreateSession(sourcePrefabPath, workingPrefabPath, "temp-copy", baseline);
        InitializeNguiSnapshotScale(session, prefab);
        return BuildArtboardResponseJson(session, request.selectedNodeId);
    }

    private static string OpenPrefab(string json)
    {
        CleanupBridgeRuntimeState();
        OpenPrefabRequest request = JsonUtility.FromJson<OpenPrefabRequest>(json);
        if (request == null || string.IsNullOrEmpty(request.prefabPath))
            return FailJson("BAD_REQUEST", "prefabPath is required");

        string sourcePrefabPath = NormalizePrefabPath(request.prefabPath);
        GameObject prefab = AssetDatabase.LoadAssetAtPath<GameObject>(sourcePrefabPath);
        if (prefab == null)
            return FailJson("PREFAB_NOT_FOUND", "Prefab not found: " + sourcePrefabPath);

        string mode = string.IsNullOrEmpty(request.mode) ? "temp-copy" : request.mode;
        if (mode == "source")
            return FailJson("SAVE_REJECTED", "source mode is disabled for UIEditor_new MVP");
        if (mode != "readonly" && mode != "temp-copy")
            return FailJson("BAD_REQUEST", "Unsupported mode: " + mode);

        string workingPrefabPath = sourcePrefabPath;
        if (mode == "temp-copy")
        {
            EnsureAssetFolder(TempPrefabRoot);
            string fileName = Path.GetFileNameWithoutExtension(sourcePrefabPath) + "__uieditor_new_tmp_" + Guid.NewGuid().ToString("N").Substring(0, 8) + ".prefab";
            workingPrefabPath = TempPrefabRoot + "/" + fileName;
            if (!AssetDatabase.CopyAsset(sourcePrefabPath, workingPrefabPath))
                return FailJson("COPY_FAILED", "Failed to copy temp prefab: " + workingPrefabPath);
        }

        SessionState session = CreateSession(sourcePrefabPath, workingPrefabPath, mode, ReadAssetText(sourcePrefabPath));
        InitializeNguiSnapshotScale(session, prefab);
        if (request.width > 0) session.snapshotWidth = request.width;
        if (request.height > 0) session.snapshotHeight = request.height;
        if (!string.IsNullOrEmpty(request.backgroundColor)) session.snapshotBackgroundColor = request.backgroundColor;

        return JsonUtility.ToJson(new OpenPrefabResponse
        {
            ok = true,
            session = ToSessionInfo(session)
        });
    }

    private static string ExportNodeTree(string json)
    {
        SessionRequest request = JsonUtility.FromJson<SessionRequest>(json);
        SessionState session;
        if (!TryGetSession(request != null ? request.sessionId : null, out session))
            return FailJson("SESSION_NOT_FOUND", "sessionId not found");

        GameObject root = GetWorkingRoot(session);
        if (root == null)
            return FailJson("PREFAB_NOT_FOUND", "Working prefab not found: " + session.workingPrefabPath);

        List<NodeRecord> nodes = new List<NodeRecord>();
        CollectNodes(root.transform, null, root.transform, nodes, session);
        return JsonUtility.ToJson(new ExportNodeTreeResponse
        {
            ok = true,
            revision = RevisionText(session),
            rootNodeId = nodes.Count > 0 ? nodes[0].nodeId : null,
            nodes = nodes.ToArray()
        });
    }

    // 临时诊断端点：返回 NGUI working root 子树与 UIDrawCall 的 layer/scene/active 实况，定位空图根因。
    private static string RenderSnapshot(string json)
    {
        RenderSnapshotRequest request = JsonUtility.FromJson<RenderSnapshotRequest>(json);
        SessionState session;
        if (!TryGetSession(request != null ? request.sessionId : null, out session))
            return FailJson("SESSION_NOT_FOUND", "sessionId not found");

        BridgeTiming timing = new BridgeTiming(request != null && request.profile);
        if (request != null)
        {
            if (request.width > 0) session.snapshotWidth = request.width;
            if (request.height > 0) session.snapshotHeight = request.height;
            if (!string.IsNullOrEmpty(request.backgroundColor)) session.snapshotBackgroundColor = request.backgroundColor;
        }
        SnapshotRecord snapshot;
        string errorCode;
        string errorMessage;
        if (!RenderSnapshotInternal(session, request, out snapshot, out errorCode, out errorMessage, timing))
            return FailJson(errorCode, errorMessage);

        return JsonUtility.ToJson(new RenderSnapshotResponse
        {
            ok = true,
            revision = RevisionText(session),
            snapshot = snapshot,
            profile = timing.Finish()
        });
    }

    // 只读截当前已加载场景里某 prefab 实例的相机 = Unity Game View 真值，用于对照 bridge 离屏渲染。
    // 不刷新 NGUI、不改 transform、不动任何 live 状态。
    private static string ApplyVisualPatch(string json)
    {
        ApplyPatchRequest request = JsonUtility.FromJson<ApplyPatchRequest>(json);
        SessionState session;
        if (!TryGetSession(request != null ? request.sessionId : null, out session))
            return FailJson("SESSION_NOT_FOUND", "sessionId not found");
        if (session.mode == "readonly")
            return FailJson("SAVE_REJECTED", "readonly session cannot apply patch");
        if (request.patch == null)
            return FailJson("BAD_REQUEST", "patch is required");
        if (!string.IsNullOrEmpty(request.patch.baseRevision) && request.patch.baseRevision != RevisionText(session))
            return FailJson("REVISION_CONFLICT", "Patch baseRevision " + request.patch.baseRevision + " does not match current " + RevisionText(session));

        List<PatchChange> applied = new List<PatchChange>();
        List<PatchReject> rejected = new List<PatchReject>();
        GameObject root = null;
        bool undoPushed = false;
        try
        {
            root = request.dryRun ? CloneWorkingRoot(session) : GetWorkingRoot(session);
            if (root == null)
                return FailJson("PREFAB_NOT_FOUND", "Working prefab not found: " + session.workingPrefabPath);
            if (!request.dryRun)
            {
                PushUndo(session);
                undoPushed = true;
            }

            Dictionary<string, Transform> targets = BuildTargetMap(root.transform, session.workingPrefabPath);
            VisualPatchOperation[] operations = request.patch.operations ?? new VisualPatchOperation[0];
            for (int i = 0; i < operations.Length; i++)
            {
                VisualPatchOperation op = operations[i];
                Transform target;
                if (op == null || string.IsNullOrEmpty(op.nodeId) || !targets.TryGetValue(op.nodeId, out target))
                {
                    rejected.Add(new PatchReject { nodeId = op != null ? op.nodeId : null, field = op != null ? op.field : null, reason = "NODE_NOT_FOUND" });
                    continue;
                }
                if (!IsFieldEditable(target, op.field))
                {
                    rejected.Add(new PatchReject { nodeId = op.nodeId, field = op.field, reason = "FIELD_NOT_EDITABLE" });
                    continue;
                }

                string before = ReadFieldAsString(target, op.field);
                string error;
                if (!ApplyOperation(target, op, out error))
                {
                    rejected.Add(new PatchReject { nodeId = op.nodeId, field = op.field, reason = error });
                    continue;
                }
                string after = ReadFieldAsString(target, op.field);
                applied.Add(new PatchChange { nodeId = op.nodeId, field = op.field, before = before, after = after });
            }

            if (!request.dryRun && applied.Count > 0)
            {
                MarkSessionEdited(session);
                AfterEditAppliedForFramework(session, root);
                session.appliedChanges.AddRange(applied);
            }
        }
        catch
        {
            if (undoPushed) PopUndoIfLastWasCurrent(session);
            throw;
        }
        finally
        {
            if (request != null && request.dryRun && root != null)
                UnityEngine.Object.DestroyImmediate(root);
        }

        ProtectedDiffResult diff = BuildProtectedDiff(session, null);
        SnapshotRecord snapshot = null;
        if (request.renderAfter && !request.dryRun)
        {
            RenderSnapshotRequest renderRequest = new RenderSnapshotRequest
            {
                sessionId = session.sessionId,
                width = request.width,
                height = request.height,
                backgroundColor = request.backgroundColor,
                includeBboxes = true,
                imageMode = request.imageMode
            };
            string errorCode = null;
            string errorMessage = null;
            RenderSnapshotInternal(session, renderRequest, out snapshot, out errorCode, out errorMessage);
        }

        return JsonUtility.ToJson(new ApplyPatchResponse
        {
            ok = true,
            revision = RevisionText(session),
            applied = applied.ToArray(),
            rejected = rejected.ToArray(),
            protectedDiff = diff,
            snapshot = snapshot
        });
    }

    private static string MoveNode(string json)
    {
        MoveNodeRequest request = JsonUtility.FromJson<MoveNodeRequest>(json);
        return ApplySingleFieldOperation(request != null ? request.sessionId : null, request != null ? request.nodeId : null, "rectTransform.anchoredPosition", request != null ? Floats(request.x, request.y) : null, null, false, 0f, request != null ? request.nodeId : null, request == null || !request.skipSnapshot, request != null && request.profile);
    }

    private static string ResizeNode(string json)
    {
        ResizeNodeRequest request = JsonUtility.FromJson<ResizeNodeRequest>(json);
        return ApplySingleFieldOperation(request != null ? request.sessionId : null, request != null ? request.nodeId : null, "rectTransform.sizeDelta", request != null ? Floats(Mathf.Max(1f, request.width), Mathf.Max(1f, request.height)) : null, null, false, 0f, request != null ? request.nodeId : null, request == null || !request.skipSnapshot, request != null && request.profile);
    }

    private static string SetText(string json)
    {
        SetTextRequest request = JsonUtility.FromJson<SetTextRequest>(json);
        return ApplySingleFieldOperation(request != null ? request.sessionId : null, request != null ? request.nodeId : null, "Text.text", null, request != null ? request.text : "", false, 0f, request != null ? request.nodeId : null, request == null || !request.skipSnapshot, request != null && request.profile);
    }

    private static string SetTextStyle(string json)
    {
        SetTextStyleRequest request = JsonUtility.FromJson<SetTextStyleRequest>(json);
        SessionState session;
        if (!TryGetSession(request != null ? request.sessionId : null, out session))
            return FailJson("SESSION_NOT_FOUND", "sessionId not found");
        if (string.IsNullOrEmpty(request.nodeId))
            return FailJson("BAD_REQUEST", "nodeId is required");

        List<VisualPatchOperation> operations = new List<VisualPatchOperation>();
        if (request.fontSize > 0)
            operations.Add(new VisualPatchOperation { op = "set", nodeId = request.nodeId, field = "Text.fontSize", numberValue = request.fontSize });
        if (!string.IsNullOrEmpty(request.color))
            operations.Add(new VisualPatchOperation { op = "set", nodeId = request.nodeId, field = "Text.color", stringValue = request.color });
        if (!string.IsNullOrEmpty(request.fontPath))
            operations.Add(new VisualPatchOperation { op = "set", nodeId = request.nodeId, field = "Text.font", stringValue = request.fontPath });
        return ApplyOperationsAndReturnState(session, operations.ToArray(), request.nodeId, !request.skipSnapshot, request.profile);
    }

    private static string SetImage(string json)
    {
        SetImageRequest request = JsonUtility.FromJson<SetImageRequest>(json);
        return ApplySingleFieldOperation(request != null ? request.sessionId : null, request != null ? request.nodeId : null, "Image.sprite", null, request != null ? request.spritePath : null, false, 0f, request != null ? request.nodeId : null, request == null || !request.skipSnapshot, request != null && request.profile);
    }

    private static string SetVisible(string json)
    {
        SetVisibleRequest request = JsonUtility.FromJson<SetVisibleRequest>(json);
        return ApplySingleFieldOperation(request != null ? request.sessionId : null, request != null ? request.nodeId : null, "activeSelf", null, null, request != null && request.visible, 0f, request != null ? request.nodeId : null, request == null || !request.skipSnapshot, request != null && request.profile);
    }

    private static string ApplySingleFieldOperation(string sessionId, string nodeId, string field, float[] value, string stringValue, bool boolValue, float numberValue, string selectedNodeId, bool includeSnapshot, bool includeProfile)
    {
        SessionState session;
        if (!TryGetSession(sessionId, out session))
            return FailJson("SESSION_NOT_FOUND", "sessionId not found");
        if (string.IsNullOrEmpty(nodeId))
            return FailJson("BAD_REQUEST", "nodeId is required");

        VisualPatchOperation op = new VisualPatchOperation
        {
            op = "set",
            nodeId = nodeId,
            field = field,
            value = value,
            stringValue = stringValue,
            boolValue = boolValue,
            numberValue = numberValue,
            source = new PatchSource { kind = "remote-artboard" }
        };
        return ApplyOperationsAndReturnState(session, new[] { op }, selectedNodeId, includeSnapshot, includeProfile);
    }

    private static string ReparentNode(string json)
    {
        ReparentNodeRequest request = JsonUtility.FromJson<ReparentNodeRequest>(json);
        SessionState session;
        if (!TryGetSession(request != null ? request.sessionId : null, out session))
            return FailJson("SESSION_NOT_FOUND", "sessionId not found");
        if (string.IsNullOrEmpty(request.nodeId))
            return FailJson("BAD_REQUEST", "nodeId is required");

        return MutatePrefabAndReturnState(session, request.nodeId, root =>
        {
            Dictionary<string, Transform> targets = BuildTargetMap(root.transform, session.workingPrefabPath);
            Transform node;
            if (!targets.TryGetValue(request.nodeId, out node))
                throw new BridgeRequestException("NODE_NOT_FOUND", "nodeId not found: " + request.nodeId);
            if (node == root.transform)
                throw new BridgeRequestException("ROOT_REPARENT_REJECTED", "root cannot be reparented");

            Transform parent = root.transform;
            if (!string.IsNullOrEmpty(request.parentId) && !targets.TryGetValue(request.parentId, out parent))
                throw new BridgeRequestException("PARENT_NOT_FOUND", "parentId not found: " + request.parentId);
            node.SetParent(parent, false);
            if (request.index >= 0)
                node.SetSiblingIndex(Mathf.Min(request.index, parent.childCount - 1));
        }, null, !request.skipSnapshot, request.profile, true);
    }

    private static string InsertPrefab(string json)
    {
        InsertPrefabRequest request = JsonUtility.FromJson<InsertPrefabRequest>(json);
        SessionState session;
        if (!TryGetSession(request != null ? request.sessionId : null, out session))
            return FailJson("SESSION_NOT_FOUND", "sessionId not found");
        if (request == null || string.IsNullOrEmpty(request.prefabPath))
            return FailJson("BAD_REQUEST", "prefabPath is required");

        string insertPath = NormalizePrefabPath(request.prefabPath);
        GameObject insertPrefab = AssetDatabase.LoadAssetAtPath<GameObject>(insertPath);
        if (insertPrefab == null)
            return FailJson("PREFAB_NOT_FOUND", "Prefab not found: " + insertPath);

        string selectedNodeId = null;
        return MutatePrefabAndReturnState(session, null, root =>
        {
            Dictionary<string, Transform> targets = BuildTargetMap(root.transform, session.workingPrefabPath);
            Transform parent = root.transform;
            if (!string.IsNullOrEmpty(request.parentId) && !targets.TryGetValue(request.parentId, out parent))
                throw new BridgeRequestException("PARENT_NOT_FOUND", "parentId not found: " + request.parentId);

            GameObject instance = UnityEngine.Object.Instantiate(insertPrefab, parent);
            instance.name = insertPrefab.name;
            RectTransform rect = instance.GetComponent<RectTransform>();
            if (rect != null)
            {
                rect.anchoredPosition = new Vector2(request.x, request.y);
                if (request.width > 0f || request.height > 0f)
                    rect.sizeDelta = new Vector2(request.width > 0f ? request.width : rect.sizeDelta.x, request.height > 0f ? request.height : rect.sizeDelta.y);
            }
            if (request.index >= 0)
                instance.transform.SetSiblingIndex(Mathf.Min(request.index, parent.childCount - 1));
            selectedNodeId = BuildNodeId(root.transform, instance.transform);
        }, () => selectedNodeId, !request.skipSnapshot, request.profile, true);
    }

    private static string CreateFrameNode(string json)
    {
        CreateFrameNodeRequest request = JsonUtility.FromJson<CreateFrameNodeRequest>(json);
        SessionState session;
        if (!TryGetSession(request != null ? request.sessionId : null, out session))
            return FailJson("SESSION_NOT_FOUND", "sessionId not found");

        string selectedNodeId = null;
        return MutatePrefabAndReturnState(session, null, root =>
        {
            Transform parent = ResolveParentTransform(root.transform, session.workingPrefabPath, request != null ? request.parentId : null);
            GameObject go = new GameObject(request != null && !string.IsNullOrEmpty(request.name) ? request.name : "Frame");
            go.transform.SetParent(parent, false);
            RectTransform rect = go.AddComponent<RectTransform>();
            rect.anchorMin = new Vector2(0.5f, 0.5f);
            rect.anchorMax = new Vector2(0.5f, 0.5f);
            rect.pivot = new Vector2(0.5f, 0.5f);
            rect.anchoredPosition = new Vector2(request != null ? request.x : 0f, request != null ? request.y : 0f);
            rect.sizeDelta = new Vector2(request != null && request.width > 0f ? request.width : 300f, request != null && request.height > 0f ? request.height : 200f);
            selectedNodeId = BuildNodeId(root.transform, go.transform);
        }, () => selectedNodeId, request == null || !request.skipSnapshot, request != null && request.profile, true);
    }

    private static string CreateTextNode(string json)
    {
        CreateTextNodeRequest request = JsonUtility.FromJson<CreateTextNodeRequest>(json);
        SessionState session;
        if (!TryGetSession(request != null ? request.sessionId : null, out session))
            return FailJson("SESSION_NOT_FOUND", "sessionId not found");

        string selectedNodeId = null;
        return MutatePrefabAndReturnState(session, null, root =>
        {
            Transform parent = ResolveParentTransform(root.transform, session.workingPrefabPath, request != null ? request.parentId : null);
            GameObject go = new GameObject(!string.IsNullOrEmpty(request.name) ? request.name : "Text");
            go.transform.SetParent(parent, false);
            RectTransform rect = go.AddComponent<RectTransform>();
            rect.anchorMin = new Vector2(0.5f, 0.5f);
            rect.anchorMax = new Vector2(0.5f, 0.5f);
            rect.pivot = new Vector2(0.5f, 0.5f);
            rect.anchoredPosition = new Vector2(request != null ? request.x : 0f, request != null ? request.y : 0f);
            rect.sizeDelta = new Vector2(request != null && request.width > 0f ? request.width : 240f, request != null && request.height > 0f ? request.height : 64f);
            Text text = go.AddComponent<Text>();
            text.text = request != null && !string.IsNullOrEmpty(request.text) ? request.text : "Text";
            text.fontSize = request != null && request.fontSize > 0 ? request.fontSize : 32;
            text.color = ParseColor(request != null ? request.color : null, Color.white);
            text.alignment = TextAnchor.MiddleCenter;
            Font defaultFont = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
            if (defaultFont != null) text.font = defaultFont;
            selectedNodeId = BuildNodeId(root.transform, go.transform);
        }, () => selectedNodeId, request == null || !request.skipSnapshot, request != null && request.profile, true);
    }

    private static string CreateImageNode(string json)
    {
        CreateImageNodeRequest request = JsonUtility.FromJson<CreateImageNodeRequest>(json);
        SessionState session;
        if (!TryGetSession(request != null ? request.sessionId : null, out session))
            return FailJson("SESSION_NOT_FOUND", "sessionId not found");

        string selectedNodeId = null;
        return MutatePrefabAndReturnState(session, null, root =>
        {
            Transform parent = ResolveParentTransform(root.transform, session.workingPrefabPath, request != null ? request.parentId : null);
            GameObject go = new GameObject(!string.IsNullOrEmpty(request.name) ? request.name : "Image");
            go.transform.SetParent(parent, false);
            RectTransform rect = go.AddComponent<RectTransform>();
            rect.anchorMin = new Vector2(0.5f, 0.5f);
            rect.anchorMax = new Vector2(0.5f, 0.5f);
            rect.pivot = new Vector2(0.5f, 0.5f);
            rect.anchoredPosition = new Vector2(request != null ? request.x : 0f, request != null ? request.y : 0f);
            rect.sizeDelta = new Vector2(request != null && request.width > 0f ? request.width : 160f, request != null && request.height > 0f ? request.height : 160f);
            Image image = go.AddComponent<Image>();
            image.color = ParseColor(request != null ? request.color : null, Color.white);
            if (request != null && !string.IsNullOrEmpty(request.spritePath))
            {
                Sprite sprite = LoadSprite(request.spritePath);
                if (sprite == null)
                    throw new BridgeRequestException("SPRITE_NOT_FOUND", "Sprite not found: " + request.spritePath);
                image.sprite = sprite;
                image.type = Image.Type.Sliced;
            }
            selectedNodeId = BuildNodeId(root.transform, go.transform);
        }, () => selectedNodeId, request == null || !request.skipSnapshot, request != null && request.profile, true);
    }

    private static string CreateWidgetNode(string json)
    {
        CreateWidgetNodeRequest request = JsonUtility.FromJson<CreateWidgetNodeRequest>(json);
        SessionState session;
        if (!TryGetSession(request != null ? request.sessionId : null, out session))
            return FailJson("SESSION_NOT_FOUND", "sessionId not found");
        if (request == null || string.IsNullOrEmpty(request.widgetType))
            return FailJson("BAD_REQUEST", "widgetType is required");

        string selectedNodeId = null;
        return MutatePrefabAndReturnState(session, null, root =>
        {
            Transform parent = ResolveParentTransform(root.transform, session.workingPrefabPath, request.parentId);
            string widgetType = request.widgetType.ToLowerInvariant();
            GameObject go = new GameObject(!string.IsNullOrEmpty(request.name) ? request.name : request.widgetType);
            RectTransform rect = go.AddComponent<RectTransform>();
            rect.SetParent(parent, false);
            rect.anchorMin = new Vector2(0.5f, 0.5f);
            rect.anchorMax = new Vector2(0.5f, 0.5f);
            rect.pivot = new Vector2(0.5f, 0.5f);
            rect.anchoredPosition = new Vector2(request.x, request.y);
            rect.sizeDelta = new Vector2(request.width > 0f ? request.width : DefaultWidgetWidth(widgetType), request.height > 0f ? request.height : DefaultWidgetHeight(widgetType));

            if (widgetType == "button") BuildButtonWidget(go);
            else if (widgetType == "scrollview") BuildScrollViewWidget(go);
            else if (widgetType == "toggle") BuildToggleWidget(go);
            else if (widgetType == "inputfield") BuildInputFieldWidget(go);
            else if (widgetType == "rawimage") BuildRawImageWidget(go);
            else if (widgetType == "image") go.AddComponent<Image>().color = Color.white;
            else if (widgetType == "text") BuildTextGraphic(go, "Text", 32, TextAnchor.MiddleCenter);
            else if (widgetType != "frame")
                throw new BridgeRequestException("BAD_WIDGET_TYPE", "Unsupported widgetType: " + request.widgetType);

            selectedNodeId = BuildNodeId(root.transform, go.transform);
        }, () => selectedNodeId, request == null || !request.skipSnapshot, request != null && request.profile, true);
    }

    private static string DeleteNode(string json)
    {
        NodeRequest request = JsonUtility.FromJson<NodeRequest>(json);
        SessionState session;
        if (!TryGetSession(request != null ? request.sessionId : null, out session))
            return FailJson("SESSION_NOT_FOUND", "sessionId not found");
        if (string.IsNullOrEmpty(request.nodeId))
            return FailJson("BAD_REQUEST", "nodeId is required");

        return MutatePrefabAndReturnState(session, null, root =>
        {
            Dictionary<string, Transform> targets = BuildTargetMap(root.transform, session.workingPrefabPath);
            Transform node;
            if (!targets.TryGetValue(request.nodeId, out node))
                throw new BridgeRequestException("NODE_NOT_FOUND", "nodeId not found: " + request.nodeId);
            if (node == root.transform)
                throw new BridgeRequestException("ROOT_DELETE_REJECTED", "root cannot be deleted");
            UnityEngine.Object.DestroyImmediate(node.gameObject);
        }, null, !request.skipSnapshot, request.profile, true);
    }

    private static string DuplicateNodes(string json)
    {
        DuplicateNodesRequest request = JsonUtility.FromJson<DuplicateNodesRequest>(json);
        SessionState session;
        if (!TryGetSession(request != null ? request.sessionId : null, out session))
            return FailJson("SESSION_NOT_FOUND", "sessionId not found");
        if (request == null || request.nodeIds == null || request.nodeIds.Length == 0)
            return FailJson("BAD_REQUEST", "nodeIds is required");

        List<string> selectedNodeIds = new List<string>();
        return MutatePrefabAndReturnState(session, null, root =>
        {
            Dictionary<string, Transform> targets = BuildTargetMap(root.transform, session.workingPrefabPath);
            HashSet<Transform> requested = new HashSet<Transform>();
            for (int i = 0; i < request.nodeIds.Length; i++)
            {
                string nodeId = request.nodeIds[i];
                Transform node;
                if (!targets.TryGetValue(nodeId, out node))
                    throw new BridgeRequestException("NODE_NOT_FOUND", "nodeId not found: " + nodeId);
                if (node == root.transform)
                    throw new BridgeRequestException("ROOT_DUPLICATE_REJECTED", "root cannot be duplicated");
                requested.Add(node);
            }

            List<Transform> rootsToDuplicate = new List<Transform>();
            foreach (Transform node in requested)
            {
                bool hasSelectedAncestor = false;
                Transform parent = node.parent;
                while (parent != null && parent != root.transform.parent)
                {
                    if (requested.Contains(parent))
                    {
                        hasSelectedAncestor = true;
                        break;
                    }
                    parent = parent.parent;
                }
                if (!hasSelectedAncestor) rootsToDuplicate.Add(node);
            }

            rootsToDuplicate.Sort((a, b) => a.GetSiblingIndex().CompareTo(b.GetSiblingIndex()));
            for (int i = 0; i < rootsToDuplicate.Count; i++)
            {
                Transform source = rootsToDuplicate[i];
                Transform parent = source.parent != null ? source.parent : root.transform;
                GameObject clone = UnityEngine.Object.Instantiate(source.gameObject, parent);
                clone.name = source.gameObject.name + "_copy";
                if (PrefabUtility.IsPartOfPrefabInstance(clone))
                    PrefabUtility.UnpackPrefabInstance(clone, PrefabUnpackMode.Completely, InteractionMode.AutomatedAction);
                RectTransform sourceRect = source as RectTransform;
                RectTransform cloneRect = clone.transform as RectTransform;
                if (sourceRect != null && cloneRect != null)
                {
                    cloneRect.anchorMin = sourceRect.anchorMin;
                    cloneRect.anchorMax = sourceRect.anchorMax;
                    cloneRect.pivot = sourceRect.pivot;
                    cloneRect.sizeDelta = sourceRect.sizeDelta;
                    cloneRect.anchoredPosition = sourceRect.anchoredPosition + new Vector2(request.offsetX, request.offsetY);
                    cloneRect.localScale = sourceRect.localScale;
                    cloneRect.localEulerAngles = sourceRect.localEulerAngles;
                }
                clone.transform.SetSiblingIndex(Mathf.Min(source.GetSiblingIndex() + 1 + i, parent.childCount - 1));
                selectedNodeIds.Add(BuildNodeId(root.transform, clone.transform));
            }
        }, () => selectedNodeIds.Count > 0 ? selectedNodeIds[0] : null, !request.skipSnapshot, request.profile, true);
    }

    private static string CopyNodesToSession(string json)
    {
        CopyNodesToSessionRequest request = JsonUtility.FromJson<CopyNodesToSessionRequest>(json);
        SessionState sourceSession;
        SessionState targetSession;
        if (!TryGetSession(request != null ? request.sourceSessionId : null, out sourceSession))
            return FailJson("SOURCE_SESSION_NOT_FOUND", "sourceSessionId not found");
        if (!TryGetSession(request != null ? request.targetSessionId : null, out targetSession))
            return FailJson("TARGET_SESSION_NOT_FOUND", "targetSessionId not found");
        if (request == null || request.nodeIds == null || request.nodeIds.Length == 0)
            return FailJson("BAD_REQUEST", "nodeIds is required");

        GameObject sourceRoot = GetWorkingRoot(sourceSession);
        if (sourceRoot == null)
            return FailJson("SOURCE_PREFAB_NOT_FOUND", "Source working prefab not found: " + sourceSession.workingPrefabPath);

        Dictionary<string, Transform> sourceTargets = BuildTargetMap(sourceRoot.transform, sourceSession.workingPrefabPath);
        List<Transform> sourceNodes;
        try
        {
            sourceNodes = ResolveUniqueTransforms(request.nodeIds, sourceTargets, sourceRoot.transform, "COPY");
        }
        catch (BridgeRequestException ex)
        {
            return FailJson(ex.Code, ex.Message);
        }

        HashSet<Transform> requested = new HashSet<Transform>(sourceNodes);
        List<Transform> rootsToCopy = new List<Transform>();
        foreach (Transform node in sourceNodes)
        {
            bool hasSelectedAncestor = false;
            Transform parent = node.parent;
            while (parent != null && parent != sourceRoot.transform.parent)
            {
                if (requested.Contains(parent))
                {
                    hasSelectedAncestor = true;
                    break;
                }
                parent = parent.parent;
            }
            if (!hasSelectedAncestor) rootsToCopy.Add(node);
        }
        rootsToCopy.Sort((a, b) => a.GetSiblingIndex().CompareTo(b.GetSiblingIndex()));

        List<string> selectedNodeIds = new List<string>();
        return MutatePrefabAndReturnState(targetSession, null, targetRoot =>
        {
            Transform targetParent = ResolveParentTransform(targetRoot.transform, targetSession.workingPrefabPath, request.targetParentId);
            if (targetParent == null) targetParent = targetRoot.transform;

            for (int i = 0; i < rootsToCopy.Count; i++)
            {
                Transform source = rootsToCopy[i];
                GameObject clone = UnityEngine.Object.Instantiate(source.gameObject, targetParent);
                clone.name = UniqueChildName(targetParent, source.gameObject.name + "_copy", clone.transform);
                if (PrefabUtility.IsPartOfPrefabInstance(clone))
                    PrefabUtility.UnpackPrefabInstance(clone, PrefabUnpackMode.Completely, InteractionMode.AutomatedAction);

                RectTransform sourceRect = source as RectTransform;
                RectTransform cloneRect = clone.transform as RectTransform;
                if (sourceRect != null && cloneRect != null)
                {
                    cloneRect.anchorMin = sourceRect.anchorMin;
                    cloneRect.anchorMax = sourceRect.anchorMax;
                    cloneRect.pivot = sourceRect.pivot;
                    cloneRect.sizeDelta = sourceRect.sizeDelta;
                    cloneRect.anchoredPosition = sourceRect.anchoredPosition + new Vector2(request.offsetX, request.offsetY);
                    cloneRect.localScale = sourceRect.localScale;
                    cloneRect.localEulerAngles = sourceRect.localEulerAngles;
                }

                clone.transform.SetSiblingIndex(targetParent.childCount - 1);
                selectedNodeIds.Add(BuildNodeId(targetRoot.transform, clone.transform));
            }
        }, () => selectedNodeIds.Count > 0 ? selectedNodeIds[0] : null, !request.skipSnapshot, request.profile, true);
    }

    private static string GroupNodes(string json)
    {
        GroupNodesRequest request = JsonUtility.FromJson<GroupNodesRequest>(json);
        SessionState session;
        if (!TryGetSession(request != null ? request.sessionId : null, out session))
            return FailJson("SESSION_NOT_FOUND", "sessionId not found");
        if (request == null || request.nodeIds == null || request.nodeIds.Length == 0)
            return FailJson("BAD_REQUEST", "nodeIds is required");

        string selectedNodeId = null;
        return MutatePrefabAndReturnState(session, null, root =>
        {
            Dictionary<string, Transform> targets = BuildTargetMap(root.transform, session.workingPrefabPath);
            List<Transform> selected = ResolveUniqueTransforms(request.nodeIds, targets, root.transform, "GROUP");
            if (selected.Count == 0)
                throw new BridgeRequestException("BAD_REQUEST", "No valid nodes to group");

            Transform parent = selected[0].parent != null ? selected[0].parent : root.transform;
            for (int i = 0; i < selected.Count; i++)
                if (selected[i].parent != parent)
                    throw new BridgeRequestException("GROUP_PARENT_MISMATCH", "Only sibling nodes can be grouped");

            RectTransform parentRect = parent as RectTransform;
            if (parentRect == null)
                throw new BridgeRequestException("GROUP_PARENT_NOT_RECT", "Parent must be a RectTransform");

            Bounds localBounds = CalculateLocalBounds(parentRect, selected);
            int insertIndex = parent.childCount;
            for (int i = 0; i < selected.Count; i++)
                insertIndex = Mathf.Min(insertIndex, selected[i].GetSiblingIndex());

            GameObject group = new GameObject(!string.IsNullOrEmpty(request.name) ? request.name : "Group");
            RectTransform groupRect = group.AddComponent<RectTransform>();
            groupRect.SetParent(parent, false);
            groupRect.anchorMin = new Vector2(0.5f, 0.5f);
            groupRect.anchorMax = new Vector2(0.5f, 0.5f);
            groupRect.pivot = new Vector2(0.5f, 0.5f);
            groupRect.localPosition = new Vector3(localBounds.center.x, localBounds.center.y, 0f);
            groupRect.sizeDelta = new Vector2(Mathf.Max(1f, localBounds.size.x), Mathf.Max(1f, localBounds.size.y));
            groupRect.SetSiblingIndex(insertIndex);

            selected.Sort((a, b) => a.GetSiblingIndex().CompareTo(b.GetSiblingIndex()));
            for (int i = 0; i < selected.Count; i++)
                selected[i].SetParent(groupRect, true);

            selectedNodeId = BuildNodeId(root.transform, group.transform);
        }, () => selectedNodeId, request == null || !request.skipSnapshot, request != null && request.profile, true);
    }

    private static string UngroupNodes(string json)
    {
        GroupNodesRequest request = JsonUtility.FromJson<GroupNodesRequest>(json);
        SessionState session;
        if (!TryGetSession(request != null ? request.sessionId : null, out session))
            return FailJson("SESSION_NOT_FOUND", "sessionId not found");
        if (request == null || request.nodeIds == null || request.nodeIds.Length == 0)
            return FailJson("BAD_REQUEST", "nodeIds is required");

        List<string> selectedAfter = new List<string>();
        return MutatePrefabAndReturnState(session, null, root =>
        {
            Dictionary<string, Transform> targets = BuildTargetMap(root.transform, session.workingPrefabPath);
            List<Transform> groups = ResolveUniqueTransforms(request.nodeIds, targets, root.transform, "UNGROUP");
            groups.Sort((a, b) => b.GetSiblingIndex().CompareTo(a.GetSiblingIndex()));
            for (int i = 0; i < groups.Count; i++)
            {
                Transform group = groups[i];
                if (group.childCount == 0) continue;
                Transform parent = group.parent != null ? group.parent : root.transform;
                int insertIndex = group.GetSiblingIndex();
                List<Transform> children = new List<Transform>();
                foreach (Transform child in group) children.Add(child);
                for (int childIndex = 0; childIndex < children.Count; childIndex++)
                {
                    Transform child = children[childIndex];
                    child.SetParent(parent, true);
                    child.SetSiblingIndex(insertIndex + childIndex);
                    selectedAfter.Add(BuildNodeId(root.transform, child));
                }
                UnityEngine.Object.DestroyImmediate(group.gameObject);
            }
        }, () => selectedAfter.Count > 0 ? selectedAfter[0] : null, request == null || !request.skipSnapshot, request != null && request.profile, true);
    }

    private static string UndoArtboard(string json)
    {
        SessionRequest request = JsonUtility.FromJson<SessionRequest>(json);
        SessionState session;
        if (!TryGetSession(request != null ? request.sessionId : null, out session))
            return FailJson("SESSION_NOT_FOUND", "sessionId not found");
        if (session.undoStack == null || session.undoStack.Count == 0)
            return FailJson("UNDO_EMPTY", "nothing to undo");

        BridgeTiming timing = new BridgeTiming(request != null && request.profile);
        GameObject current = timing.Measure("cloneCurrentForRedo", () => CloneWorkingRoot(session));
        GameObject previous = timing.Measure("popUndo", () => PopLast(session.undoStack));
        if (session.redoStack == null) session.redoStack = new List<GameObject>();
        timing.Measure("pushRedo", () => session.redoStack.Add(current));
        timing.Measure("replaceWorkingRoot", () => ReplaceWorkingRoot(session, previous, false));
        timing.Measure("markMemoryDirty", () => MarkSessionEdited(session));
        timing.Measure("refreshProtectedBaseline", () => RefreshProtectedBaseline(session));
        return BuildArtboardResponseJson(session, null, request == null || !request.skipSnapshot, timing);
    }

    private static string RedoArtboard(string json)
    {
        SessionRequest request = JsonUtility.FromJson<SessionRequest>(json);
        SessionState session;
        if (!TryGetSession(request != null ? request.sessionId : null, out session))
            return FailJson("SESSION_NOT_FOUND", "sessionId not found");
        if (session.redoStack == null || session.redoStack.Count == 0)
            return FailJson("REDO_EMPTY", "nothing to redo");

        BridgeTiming timing = new BridgeTiming(request != null && request.profile);
        GameObject current = timing.Measure("cloneCurrentForUndo", () => CloneWorkingRoot(session));
        GameObject next = timing.Measure("popRedo", () => PopLast(session.redoStack));
        if (session.undoStack == null) session.undoStack = new List<GameObject>();
        timing.Measure("pushUndo", () => session.undoStack.Add(current));
        timing.Measure("replaceWorkingRoot", () => ReplaceWorkingRoot(session, next, false));
        timing.Measure("markMemoryDirty", () => MarkSessionEdited(session));
        timing.Measure("refreshProtectedBaseline", () => RefreshProtectedBaseline(session));
        return BuildArtboardResponseJson(session, null, request == null || !request.skipSnapshot, timing);
    }

    private static string ValidateProtectedDiff(string json)
    {
        ValidateDiffRequest request = JsonUtility.FromJson<ValidateDiffRequest>(json);
        SessionState session;
        if (!TryGetSession(request != null ? request.sessionId : null, out session))
            return FailJson("SESSION_NOT_FOUND", "sessionId not found");

        FlushSessionToDisk(session);
        string validationId = Guid.NewGuid().ToString("N");
        ProtectedDiffResult diff = BuildProtectedDiff(session, validationId);
        session.lastValidationId = validationId;
        session.lastValidationOk = diff.ok;

        return JsonUtility.ToJson(new ValidateDiffResponse
        {
            ok = diff.ok,
            validationId = validationId,
            allowedChanges = diff.allowedChanges,
            protectedChanges = diff.protectedChanges,
            summary = diff.summary,
            error = diff.ok ? null : new ErrorInfo { code = "PROTECTED_DIFF", message = "Protected diff contains blocked changes" }
        });
    }

    private static string SavePrefab(string json)
    {
        SavePrefabRequest request = JsonUtility.FromJson<SavePrefabRequest>(json);
        SessionState session;
        if (!TryGetSession(request != null ? request.sessionId : null, out session))
            return FailJson("SESSION_NOT_FOUND", "sessionId not found");
        if (session.mode != "temp-copy")
            return FailJson("SAVE_REJECTED", "UIEditor_new MVP only saves temp-copy sessions");
        if (string.IsNullOrEmpty(request.validationId) || request.validationId != session.lastValidationId || !session.lastValidationOk)
            return FailJson("SAVE_REJECTED", "A successful validate-protected-diff result is required before save");

        FlushSessionToDisk(session);
        AssetDatabase.ImportAsset(session.workingPrefabPath);
        return JsonUtility.ToJson(new SavePrefabResponse
        {
            ok = true,
            savedPath = session.workingPrefabPath,
            sourcePrefabPath = session.sourcePrefabPath,
            revision = RevisionText(session)
        });
    }

    private static string SaveArtboard(string json)
    {
        SaveArtboardRequest request = JsonUtility.FromJson<SaveArtboardRequest>(json);
        SessionState session;
        if (!TryGetSession(request != null ? request.sessionId : null, out session))
            return FailJson("SESSION_NOT_FOUND", "sessionId not found");
        if (session.mode != "temp-copy")
            return FailJson("SAVE_REJECTED", "Only temp-copy artboards can be saved");

        string targetPrefabPath = !string.IsNullOrEmpty(request.targetPrefabPath)
            ? NormalizePrefabPath(request.targetPrefabPath)
            : session.sourcePrefabPath;
        if (string.IsNullOrEmpty(targetPrefabPath))
            return FailJson("TARGET_REQUIRED", "targetPrefabPath is required for a new UI artboard");

        FlushSessionToDisk(session);
        ProtectedDiffResult diff = BuildProtectedDiff(session, Guid.NewGuid().ToString("N"));
        if (!diff.ok)
        {
            Debug.LogWarning("[UIEditorNewBridge] Save rejected for " + session.workingPrefabPath + " -> " + targetPrefabPath + ": " + DescribeProtectedDiff(diff));
            return JsonUtility.ToJson(new SaveArtboardResponse
            {
                ok = false,
                error = new ErrorInfo { code = "PROTECTED_DIFF", message = "Save rejected because non-UI fields changed" },
                protectedDiff = diff
            });
        }

        EnsureAssetFolder(Path.GetDirectoryName(targetPrefabPath).Replace("\\", "/"));
        string workingAbs = Path.Combine(ProjectRoot(), session.workingPrefabPath).Replace("\\", "/");
        string targetAbs = Path.Combine(ProjectRoot(), targetPrefabPath).Replace("\\", "/");
        if (File.Exists(targetAbs))
        {
            File.Copy(workingAbs, targetAbs, true);
            AssetDatabase.ImportAsset(targetPrefabPath);
        }
        else
        {
            if (!AssetDatabase.CopyAsset(session.workingPrefabPath, targetPrefabPath))
                return FailJson("COPY_FAILED", "Failed to save prefab: " + targetPrefabPath);
            AssetDatabase.ImportAsset(targetPrefabPath);
        }

        session.sourcePrefabPath = targetPrefabPath;
        session.baselineYaml = ReadAssetText(targetPrefabPath);
        session.lastValidationId = null;
        session.lastValidationOk = false;
        session.appliedChanges.Clear();
        session.dirty = false;
        return JsonUtility.ToJson(new SaveArtboardResponse
        {
            ok = true,
            savedPath = targetPrefabPath,
            sourcePrefabPath = session.sourcePrefabPath,
            workingPrefabPath = session.workingPrefabPath,
            revision = RevisionText(session),
            protectedDiff = diff
        });
    }

    private static string ClosePrefab(string json)
    {
        ClosePrefabRequest request = JsonUtility.FromJson<ClosePrefabRequest>(json);
        SessionState session;
        if (!TryGetSession(request != null ? request.sessionId : null, out session))
            return FailJson("SESSION_NOT_FOUND", "sessionId not found");

        bool deleteTemp = request != null && request.deleteTempObjects;
        if (!deleteTemp)
            FlushSessionToDisk(session);

        DestroySessionMemory(session);
        if (deleteTemp && session.mode == "temp-copy" && session.workingPrefabPath.StartsWith(TempPrefabRoot + "/", StringComparison.Ordinal))
        {
            AssetDatabase.DeleteAsset(session.workingPrefabPath);
            AssetDatabase.Refresh();
        }
        Sessions.Remove(session.sessionId);
        return JsonUtility.ToJson(new BaseResponse { ok = true });
    }

    private static bool RenderSnapshotInternal(SessionState session, RenderSnapshotRequest request, out SnapshotRecord snapshot, out string errorCode, out string errorMessage, BridgeTiming timing = null)
    {
        snapshot = null;
        errorCode = null;
        errorMessage = null;

        int width = request != null && request.width > 0 ? request.width : (session.snapshotWidth > 0 ? session.snapshotWidth : 1080);
        int height = request != null && request.height > 0 ? request.height : (session.snapshotHeight > 0 ? session.snapshotHeight : 1920);
        string imageMode = request != null && !string.IsNullOrEmpty(request.imageMode) ? request.imageMode : "file";
        Color background = ParseColor(request != null ? request.backgroundColor : null, new Color(0.086f, 0.176f, 0.247f, 1f));
        GameObject prefab = GetWorkingRoot(session);
        if (prefab == null)
        {
            errorCode = "PREFAB_NOT_FOUND";
            errorMessage = "Working prefab not found: " + session.workingPrefabPath;
            return false;
        }

        IUIEditorNewFrameworkAdapter adapter = ResolveFrameworkAdapter(session, prefab);
        return adapter.RenderSnapshot(session, request, prefab, width, height, imageMode, background, out snapshot, out errorCode, out errorMessage, timing);
    }

    private static string ApplyOperationsAndReturnState(SessionState session, VisualPatchOperation[] operations, string selectedNodeId, bool includeSnapshot = true, bool includeProfile = false)
    {
        if (session.mode == "readonly")
            return FailJson("SAVE_REJECTED", "readonly session cannot be edited");

        BridgeTiming timing = new BridgeTiming(includeProfile);
        bool undoPushed = false;
        try
        {
            timing.Measure("pushUndoClone", () => { PushUndo(session); undoPushed = true; });
            GameObject root = timing.Measure("getWorkingRoot", () => GetWorkingRoot(session));
            if (root == null)
                return FailJson("PREFAB_NOT_FOUND", "Working prefab not found: " + session.workingPrefabPath);
            Dictionary<string, Transform> targets = timing.Measure("buildTargetMap", () => BuildTargetMap(root.transform, session.workingPrefabPath));
            List<PatchChange> applied = new List<PatchChange>();
            VisualPatchOperation[] ops = operations ?? new VisualPatchOperation[0];
            timing.Measure("applyOperations", () =>
            {
                for (int i = 0; i < ops.Length; i++)
                {
                    VisualPatchOperation op = ops[i];
                    Transform target;
                    if (op == null || string.IsNullOrEmpty(op.nodeId) || !targets.TryGetValue(op.nodeId, out target))
                        throw new BridgeRequestException("NODE_NOT_FOUND", "nodeId not found: " + (op != null ? op.nodeId : ""));
                    if (!IsFieldEditable(target, op.field))
                        throw new BridgeRequestException("FIELD_NOT_EDITABLE", "Field is not editable: " + op.field);

                    string before = ReadFieldAsString(target, op.field);
                    string error;
                    if (!ApplyOperation(target, op, out error))
                        throw new BridgeRequestException(error ?? "FIELD_APPLY_FAILED", "Failed to apply field: " + op.field);
                    string after = ReadFieldAsString(target, op.field);
                    applied.Add(new PatchChange { nodeId = op.nodeId, field = op.field, before = before, after = after });
                }
            });

            timing.Measure("markMemoryDirty", () => MarkSessionEdited(session));
            timing.Measure("cleanupNguiRuntimeObjects", () => AfterEditAppliedForFramework(session, root));
            session.appliedChanges.AddRange(applied);
            return BuildArtboardResponseJson(session, selectedNodeId, includeSnapshot, timing);
        }
        catch (BridgeRequestException ex)
        {
            if (undoPushed) PopUndoIfLastWasCurrent(session);
            return FailJson(ex.Code, ex.Message);
        }
        catch (Exception ex)
        {
            if (undoPushed) PopUndoIfLastWasCurrent(session);
            return FailJson("OPERATION_FAILED", ex.Message);
        }
    }

    private static string MutatePrefabAndReturnState(SessionState session, string selectedNodeId, Action<GameObject> mutator, Func<string> selectedAfter = null, bool includeSnapshot = true, bool includeProfile = false, bool refreshProtectedBaseline = false)
    {
        if (session.mode == "readonly")
            return FailJson("SAVE_REJECTED", "readonly session cannot be edited");

        BridgeTiming timing = new BridgeTiming(includeProfile);
        bool undoPushed = false;
        try
        {
            timing.Measure("pushUndoClone", () => { PushUndo(session); undoPushed = true; });
            GameObject root = timing.Measure("getWorkingRoot", () => GetWorkingRoot(session));
            if (root == null)
                return FailJson("PREFAB_NOT_FOUND", "Working prefab not found: " + session.workingPrefabPath);
            timing.Measure("mutator", () => mutator(root));
            timing.Measure("cleanupNguiRuntimeObjects", () => AfterEditAppliedForFramework(session, root));
            timing.Measure("markMemoryDirty", () => MarkSessionEdited(session));
            if (refreshProtectedBaseline)
                timing.Measure("refreshProtectedBaseline", () => RefreshProtectedBaseline(session));
            return BuildArtboardResponseJson(session, selectedAfter != null ? selectedAfter() : selectedNodeId, includeSnapshot, timing);
        }
        catch (BridgeRequestException ex)
        {
            if (undoPushed) PopUndoIfLastWasCurrent(session);
            return FailJson(ex.Code, ex.Message);
        }
        catch (Exception ex)
        {
            if (undoPushed) PopUndoIfLastWasCurrent(session);
            return FailJson("OPERATION_FAILED", ex.Message);
        }
    }

    private static string BuildArtboardResponseJson(SessionState session, string selectedNodeId, bool includeSnapshot = true, BridgeTiming timing = null)
    {
        GameObject root = timing != null ? timing.Measure("getWorkingRootForResponse", () => GetWorkingRoot(session)) : GetWorkingRoot(session);
        if (root == null)
            return FailJson("PREFAB_NOT_FOUND", "Working prefab not found: " + session.workingPrefabPath);
        if (timing != null) timing.Measure("cleanupNguiRuntimeObjectsForResponse", () => AfterEditAppliedForFramework(session, root));
        else AfterEditAppliedForFramework(session, root);

        List<NodeRecord> nodes = new List<NodeRecord>();
        if (timing != null)
            timing.Measure("collectNodes", () => CollectNodes(root.transform, null, root.transform, nodes, session));
        else
            CollectNodes(root.transform, null, root.transform, nodes, session);

        SnapshotRecord snapshot = null;
        if (includeSnapshot)
        {
            string errorCode = null;
            string errorMessage = null;
            RenderSnapshotRequest renderRequest = new RenderSnapshotRequest
            {
                sessionId = session.sessionId,
                width = session.snapshotWidth > 0 ? session.snapshotWidth : 1080,
                height = session.snapshotHeight > 0 ? session.snapshotHeight : 1920,
                backgroundColor = string.IsNullOrEmpty(session.snapshotBackgroundColor) ? "#162D3FFF" : session.snapshotBackgroundColor,
                includeBboxes = true,
                imageMode = "file"
            };
            bool rendered = timing != null
                ? timing.Measure("renderSnapshot", () => RenderSnapshotInternal(session, renderRequest, out snapshot, out errorCode, out errorMessage, timing))
                : RenderSnapshotInternal(session, renderRequest, out snapshot, out errorCode, out errorMessage);
            if (!rendered) return FailJson(errorCode, errorMessage);
        }

        string finalSelected = selectedNodeId;
        if (!string.IsNullOrEmpty(finalSelected) && !NodeExists(nodes, finalSelected))
            finalSelected = ResolveSelectedNodeId(nodes, finalSelected);
        if (string.IsNullOrEmpty(finalSelected) && nodes.Count > 0)
            finalSelected = nodes[0].nodeId;

        return JsonUtility.ToJson(new ArtboardStateResponse
        {
            ok = true,
            session = ToSessionInfo(session),
            revision = RevisionText(session),
            rootNodeId = nodes.Count > 0 ? nodes[0].nodeId : null,
            nodes = nodes.ToArray(),
            snapshot = snapshot,
            selectedNodeId = finalSelected,
            dirty = session.dirty,
            undoAvailable = session.undoStack != null && session.undoStack.Count > 0,
            redoAvailable = session.redoStack != null && session.redoStack.Count > 0,
            profile = timing != null ? timing.Finish() : null
        });
    }

    private static bool NodeExists(List<NodeRecord> nodes, string nodeId)
    {
        if (nodes == null || string.IsNullOrEmpty(nodeId)) return false;
        for (int i = 0; i < nodes.Count; i++)
            if (nodes[i].nodeId == nodeId) return true;
        return false;
    }

    private static string ResolveSelectedNodeId(List<NodeRecord> nodes, string selectedNodeId)
    {
        // 主键现为结构索引 "si:..."，精确匹配 nodeId 优先；保留 "path:" 容错以兼容历史/在途请求。
        if (nodes == null || string.IsNullOrEmpty(selectedNodeId)) return null;
        string path = selectedNodeId.StartsWith("path:", StringComparison.Ordinal) ? selectedNodeId.Substring("path:".Length) : selectedNodeId;
        for (int i = 0; i < nodes.Count; i++)
            if (nodes[i].nodeId == selectedNodeId || nodes[i].path == path || ("path:" + nodes[i].path) == selectedNodeId)
                return nodes[i].nodeId;
        return null;
    }

    private static void PushUndo(SessionState session)
    {
        if (session.undoStack == null) session.undoStack = new List<GameObject>();
        GameObject snapshot = CloneWorkingRoot(session);
        if (snapshot == null)
            throw new BridgeRequestException("PREFAB_NOT_FOUND", "Working prefab not found: " + session.workingPrefabPath);
        session.undoStack.Add(snapshot);
        if (session.undoStack.Count > 50)
        {
            UnityEngine.Object.DestroyImmediate(session.undoStack[0]);
            session.undoStack.RemoveAt(0);
        }
        if (session.redoStack == null) session.redoStack = new List<GameObject>();
        DestroyRootList(session, session.redoStack);
        session.redoStack.Clear();
    }

    private static void PopUndoIfLastWasCurrent(SessionState session)
    {
        if (session.undoStack != null && session.undoStack.Count > 0)
        {
            int index = session.undoStack.Count - 1;
            if (session.undoStack[index] != null)
            {
                UnityEngine.Object.DestroyImmediate(session.undoStack[index]);
            }
            session.undoStack.RemoveAt(index);
        }
    }

    private static T PopLast<T>(List<T> list)
    {
        int index = list.Count - 1;
        T value = list[index];
        list.RemoveAt(index);
        return value;
    }

    private static SessionState CreateSession(string sourcePrefabPath, string workingPrefabPath, string mode, string baselineYaml)
    {
        string sessionId = Guid.NewGuid().ToString("N");
        SessionState session = new SessionState
        {
            sessionId = sessionId,
            sourcePrefabPath = sourcePrefabPath,
            workingPrefabPath = workingPrefabPath,
            mode = mode,
            framework = DetectPrefabFramework(workingPrefabPath),
            revision = 1,
            snapshotWidth = 1080,
            snapshotHeight = 1920,
            snapshotBackgroundColor = "#162D3FFF",
            baselineYaml = baselineYaml ?? ReadAssetText(workingPrefabPath),
            lastValidationId = null,
            lastValidationOk = false,
            appliedChanges = new List<PatchChange>(),
            dirty = false,
            undoStack = new List<GameObject>(),
            redoStack = new List<GameObject>(),
            memoryDirty = false,
            lastEditTime = 0.0,
            lastFlushTime = EditorApplication.timeSinceStartup
        };
        Sessions[sessionId] = session;
        return session;
    }

    private static GameObject GetWorkingRoot(SessionState session)
    {
        if (session == null) return null;
        if (session.workingRoot != null) return session.workingRoot;

        GameObject root = PrefabUtility.LoadPrefabContents(session.workingPrefabPath);
        if (root == null) return null;
        root.hideFlags = HideFlags.HideAndDontSave;
        session.workingRoot = root;
        session.workingRootLoadedFromPrefabContents = true;
        // 把 working root 移进 session 私有 preview scene 并保持 NGUI 全程 suspended，
        // 使其永不被 NGUI 的 [ExecuteInEditMode] 回调重排子节点（否则 nodeId 漂移 + undo 快照污染）。
        MoveRootToScene(root, EnsureSessionPreviewScene(session));
        PrepareWorkingRootForFramework(session, root);
        return root;
    }

    private static GameObject CloneWorkingRoot(SessionState session)
    {
        GameObject source = GetWorkingRoot(session);
        if (source == null) return null;
        GameObject clone = UnityEngine.Object.Instantiate(source);
        clone.name = source.name;
        clone.hideFlags = HideFlags.HideAndDontSave;
        MoveRootToScene(clone, EnsureSessionPreviewScene(session));
        // 冻结快照：undo/redo 栈里的 clone 不参与编辑也不参与渲染。SetActive(false) 让 NGUI
        // [ExecuteInEditMode] 走 OnDisable 自动销毁其 drawcall，不在 previewScene 里产生几何，
        // 也不会被任何相机渲染。被 ReplaceWorkingRoot 取出设为活动 root 时再解冻（SetActive(true)+EnableAndPrimeNgui）。
        clone.SetActive(false);
        return clone;
    }

    private static void ReplaceWorkingRoot(SessionState session, GameObject nextRoot, bool loadedFromPrefabContents)
    {
        DestroyWorkingRoot(session);
        session.workingRoot = nextRoot;
        session.workingRootLoadedFromPrefabContents = loadedFromPrefabContents;
        if (session.workingRoot != null)
        {
            session.workingRoot.hideFlags = HideFlags.HideAndDontSave;
            if (!session.workingRoot.activeSelf)
                session.workingRoot.SetActive(true); // 从冻结快照恢复为活动 root
            if (!loadedFromPrefabContents)
                MoveRootToScene(session.workingRoot, EnsureSessionPreviewScene(session));
            PrepareWorkingRootForFramework(session, session.workingRoot);
        }
    }

    private static void MarkSessionEdited(SessionState session)
    {
        session.revision++;
        session.dirty = true;
        session.memoryDirty = true;
        session.lastEditTime = EditorApplication.timeSinceStartup;
        session.lastValidationId = null;
        session.lastValidationOk = false;
    }

    private static void RefreshProtectedBaseline(SessionState session)
    {
        if (session == null || session.mode == "readonly") return;
        FlushSessionToDisk(session);
        session.baselineYaml = ReadAssetText(session.workingPrefabPath);
        session.appliedChanges.Clear();
        session.lastValidationId = null;
        session.lastValidationOk = false;
    }

    private static void FlushSessionToDisk(SessionState session)
    {
        FlushSessionToDisk(session, null, "saveAsPrefabAsset");
    }

    private static void FlushSessionToDisk(SessionState session, BridgeTiming timing, string profileName)
    {
        if (session == null || session.isFlushing || session.mode == "readonly") return;
        if (!session.memoryDirty || session.workingRoot == null) return;

        session.isFlushing = true;
        // 不再 flush 前 resume NGUI：落盘序列化的是结构，不需要 NGUI enabled；
        // resume 会触发 [ExecuteInEditMode] 重排 source 子节点，正是要避免的污染。
        try
        {
            HideFlags previousHideFlags = session.workingRoot.hideFlags;
            session.workingRoot.hideFlags = HideFlags.None;
            if (timing != null)
                timing.Measure(profileName, () => PrefabUtility.SaveAsPrefabAsset(session.workingRoot, session.workingPrefabPath));
            else
                PrefabUtility.SaveAsPrefabAsset(session.workingRoot, session.workingPrefabPath);
            session.workingRoot.hideFlags = previousHideFlags;
            session.memoryDirty = false;
            session.lastFlushTime = EditorApplication.timeSinceStartup;
        }
        catch
        {
            if (session.workingRoot != null)
                session.workingRoot.hideFlags = HideFlags.HideAndDontSave;
            throw;
        }
        finally
        {
            session.isFlushing = false;
        }
    }

    private static void ProcessIdleAutosaves()
    {
        double now = EditorApplication.timeSinceStartup;
        List<SessionState> pending = null;
        foreach (SessionState session in Sessions.Values)
        {
            if (session == null || !session.memoryDirty || session.isFlushing || session.workingRoot == null) continue;
            if (now - session.lastEditTime < MemoryAutosaveIdleSeconds) continue;
            if (pending == null) pending = new List<SessionState>();
            pending.Add(session);
        }
        if (pending == null) return;

        for (int i = 0; i < pending.Count; i++)
        {
            try
            {
                FlushSessionToDisk(pending[i], null, "autosaveIdle");
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[UIEditorNewBridge] Idle autosave failed for " + pending[i].workingPrefabPath + ": " + ex.Message);
            }
        }
    }

    private static SessionState FindSessionByWorkingPrefabPath(string workingPrefabPath)
    {
        string normalized = NormalizeAssetPath(workingPrefabPath);
        foreach (SessionState session in Sessions.Values)
            if (session != null && NormalizeAssetPath(session.workingPrefabPath) == normalized)
                return session;
        return null;
    }

    private static void DestroySessionMemory(SessionState session)
    {
        if (session == null) return;
        DestroyWorkingRoot(session);
        DestroyRootList(session, session.undoStack);
        DestroyRootList(session, session.redoStack);
        if (session.undoStack != null) session.undoStack.Clear();
        if (session.redoStack != null) session.redoStack.Clear();
        DestroySessionNguiCamera(session);
        CloseSessionPreviewScene(session);
    }

    private static void DestroyWorkingRoot(SessionState session)
    {
        if (session == null || session.workingRoot == null) return;
        GameObject root = session.workingRoot;
        bool loadedFromPrefabContents = session.workingRootLoadedFromPrefabContents;
        session.workingRoot = null;
        session.workingRootLoadedFromPrefabContents = false;
        try
        {
            // 常驻实例方案：root 在 session PreviewScene 内、NGUI 组件常开。销毁 root 时 UIPanel.OnDisable
            // 自动销毁其 drawcall；无需再做 suspend/静态表清理。
            if (loadedFromPrefabContents)
                PrefabUtility.UnloadPrefabContents(root);
            else
                UnityEngine.Object.DestroyImmediate(root);
        }
        catch
        {
            if (root != null)
                UnityEngine.Object.DestroyImmediate(root);
        }
    }

    private static void DestroyRootList(SessionState session, List<GameObject> roots)
    {
        if (roots == null) return;
        for (int i = 0; i < roots.Count; i++)
        {
            GameObject root = roots[i];
            if (root == null) continue;
            // undo/redo 栈里是 SetActive(false) 冻结的实例，drawcall 已随 OnDisable 销毁；直接销毁实例即可。
            UnityEngine.Object.DestroyImmediate(root);
        }
    }

    private static void CollectNodes(Transform root, Transform parent, Transform current, List<NodeRecord> nodes, SessionState session)
    {
        string nodeId = BuildNodeId(root, current);
        string parentId = parent != null ? BuildNodeId(root, parent) : null;
        List<string> childIds = new List<string>();
        foreach (Transform child in current)
            childIds.Add(BuildNodeId(root, child));

        RectTransform rect = current as RectTransform;
        RectTransformRecord rectRecord = rect != null ? ToRectRecord(rect) : ToNguiRectRecord(current, current == root ? session : null);
        nodes.Add(new NodeRecord
        {
            nodeId = nodeId,
            unityFileId = GetSourceFileId(current.gameObject),
            path = GetTransformPath(root, current),
            name = current.name,
            framework = DetectNodeFramework(current.gameObject),
            parentId = parentId,
            siblingIndex = current.GetSiblingIndex(),
            children = childIds.ToArray(),
            activeSelf = current.gameObject.activeSelf,
            activeInHierarchy = current.gameObject.activeInHierarchy,
            rectTransform = rectRecord,
            components = CollectComponentRecords(current.gameObject),
            editableFields = BuildEditableFields(current),
            protectedFields = BuildProtectedFields(current),
            bbox = new BboxRecord { nodeId = nodeId, path = GetTransformPath(root, current), x = 0f, y = 0f, width = 0f, height = 0f, activeInHierarchy = current.gameObject.activeInHierarchy, space = "not-rendered" }
        });

        foreach (Transform child in current)
            CollectNodes(root, current, child, nodes, session);
    }

    private static ComponentRecord[] CollectComponentRecords(GameObject go)
    {
        List<ComponentRecord> components = new List<ComponentRecord>();
        Component[] raw = go.GetComponents<Component>();
        for (int i = 0; i < raw.Length; i++)
        {
            Component component = raw[i];
            if (component == null) continue;
            Behaviour behaviour = component as Behaviour;
            components.Add(new ComponentRecord
            {
                type = component.GetType().Name,
                enabled = GetEffectiveBehaviourEnabled(behaviour),
                summary = BuildComponentSummary(component)
            });
        }
        return components.ToArray();
    }

    private static ComponentSummary BuildComponentSummary(Component component)
    {
        Text text = component as Text;
        if (text != null)
            return new ComponentSummary
            {
                text = text.text,
                fontSize = text.fontSize,
                color = ColorToHex(text.color),
                fontPath = text.font != null ? AssetDatabase.GetAssetPath(text.font) : null,
                fontStyle = (int)text.fontStyle,
                alignment = text.alignment.ToString(),
                alignmentValue = (int)text.alignment,
                richText = text.supportRichText,
                horizontalOverflow = (int)text.horizontalOverflow,
                verticalOverflow = (int)text.verticalOverflow,
                lineSpacing = text.lineSpacing,
                bestFit = text.resizeTextForBestFit,
                bestFitMinSize = text.resizeTextMinSize,
                bestFitMaxSize = text.resizeTextMaxSize,
                raycastTarget = text.raycastTarget
            };

        Image image = component as Image;
        if (image != null)
        {
            Sprite sprite = image.overrideSprite != null ? image.overrideSprite : image.sprite;
            string spritePath = sprite != null ? AssetDatabase.GetAssetPath(sprite) : null;
            return new ComponentSummary
            {
                color = ColorToHex(image.color),
                sprite = sprite != null ? sprite.name : null,
                spritePath = spritePath,
                imageType = image.type.ToString(),
                enabled = image.enabled,
                raycastTarget = image.raycastTarget,
                fillCenter = image.fillCenter,
                fillMethod = (int)image.fillMethod,
                fillOrigin = image.fillOrigin,
                fillAmount = image.fillAmount,
                fillClockwise = image.fillClockwise,
                useSpriteMesh = image.useSpriteMesh,
                preserveAspect = image.preserveAspect
            };
        }

        RawImage rawImage = component as RawImage;
        if (rawImage != null)
            return new ComponentSummary
            {
                color = ColorToHex(rawImage.color),
                enabled = rawImage.enabled,
                raycastTarget = rawImage.raycastTarget
            };

        Button button = component as Button;
        if (button != null)
            return new ComponentSummary
            {
                interactable = button.interactable,
                transition = (int)button.transition,
                normalColor = ColorToHex(button.colors.normalColor),
                highlightedColor = ColorToHex(button.colors.highlightedColor),
                pressedColor = ColorToHex(button.colors.pressedColor),
                disabledColor = ColorToHex(button.colors.disabledColor),
                colorMultiplier = button.colors.colorMultiplier,
                fadeDuration = button.colors.fadeDuration
            };

        Outline outline = component as Outline;
        if (outline != null)
            return new ComponentSummary { enabled = outline.enabled, color = ColorToHex(outline.effectColor), distanceX = outline.effectDistance.x, distanceY = outline.effectDistance.y, useGraphicAlpha = outline.useGraphicAlpha };

        Shadow shadow = component as Shadow;
        if (shadow != null)
            return new ComponentSummary { enabled = shadow.enabled, color = ColorToHex(shadow.effectColor), distanceX = shadow.effectDistance.x, distanceY = shadow.effectDistance.y, useGraphicAlpha = shadow.useGraphicAlpha };

        Mask mask = component as Mask;
        if (mask != null)
            return new ComponentSummary { enabled = mask.enabled, showMaskGraphic = mask.showMaskGraphic };

        RectMask2D rectMask = component as RectMask2D;
        if (rectMask != null)
            return new ComponentSummary { enabled = rectMask.enabled };

        ScrollRect scrollRect = component as ScrollRect;
        if (scrollRect != null)
            return new ComponentSummary { horizontal = scrollRect.horizontal, vertical = scrollRect.vertical };

        Toggle toggle = component as Toggle;
        if (toggle != null)
            return new ComponentSummary { isOn = toggle.isOn, interactable = toggle.interactable };

        CanvasGroup canvasGroup = component as CanvasGroup;
        if (canvasGroup != null)
            return new ComponentSummary
            {
                alpha = canvasGroup.alpha,
                interactable = canvasGroup.interactable,
                blocksRaycasts = canvasGroup.blocksRaycasts,
                ignoreParentGroups = canvasGroup.ignoreParentGroups
            };

        LayoutElement layoutElement = component as LayoutElement;
        if (layoutElement != null)
            return new ComponentSummary
            {
                ignoreLayout = layoutElement.ignoreLayout,
                minWidth = layoutElement.minWidth,
                minHeight = layoutElement.minHeight,
                preferredWidth = layoutElement.preferredWidth,
                preferredHeight = layoutElement.preferredHeight,
                flexibleWidth = layoutElement.flexibleWidth,
                flexibleHeight = layoutElement.flexibleHeight
            };

        ContentSizeFitter fitter = component as ContentSizeFitter;
        if (fitter != null)
            return new ComponentSummary { enabled = fitter.enabled, horizontalFit = (int)fitter.horizontalFit, verticalFit = (int)fitter.verticalFit };

        HorizontalOrVerticalLayoutGroup hvLayout = component as HorizontalOrVerticalLayoutGroup;
        if (hvLayout != null)
            return new ComponentSummary
            {
                enabled = hvLayout.enabled,
                layoutType = hvLayout is HorizontalLayoutGroup ? "Horizontal" : "Vertical",
                spacing = hvLayout.spacing,
                padLeft = hvLayout.padding.left,
                padRight = hvLayout.padding.right,
                padTop = hvLayout.padding.top,
                padBottom = hvLayout.padding.bottom,
                childAlignment = (int)hvLayout.childAlignment,
                childControlWidth = hvLayout.childControlWidth,
                childControlHeight = hvLayout.childControlHeight,
                childForceExpandWidth = hvLayout.childForceExpandWidth,
                childForceExpandHeight = hvLayout.childForceExpandHeight,
                reverseArrangement = ReadOptionalBoolProperty(hvLayout, "reverseArrangement")
            };

        GridLayoutGroup grid = component as GridLayoutGroup;
        if (grid != null)
            return new ComponentSummary
            {
                enabled = grid.enabled,
                layoutType = "Grid",
                spacing = grid.spacing.x,
                spacingY = grid.spacing.y,
                padLeft = grid.padding.left,
                padRight = grid.padding.right,
                padTop = grid.padding.top,
                padBottom = grid.padding.bottom,
                childAlignment = (int)grid.childAlignment,
                cellSizeX = grid.cellSize.x,
                cellSizeY = grid.cellSize.y,
                startCorner = (int)grid.startCorner,
                startAxis = (int)grid.startAxis,
                constraint = (int)grid.constraint,
                constraintCount = grid.constraintCount
            };

        if (IsTypeOrBaseName(component.GetType(), "UILabel"))
            return BuildNguiLabelSummary(component);

        if (IsTypeOrBaseName(component.GetType(), "UIButton") || IsTypeOrBaseName(component.GetType(), "UIButtonColor"))
            return BuildNguiButtonSummary(component);

        if (IsTypeOrBaseName(component.GetType(), "UIBasicSprite") || IsTypeOrBaseName(component.GetType(), "UISprite") || IsTypeOrBaseName(component.GetType(), "UITexture") || IsTypeOrBaseName(component.GetType(), "UI2DSprite"))
            return BuildNguiSpriteSummary(component);

        if (IsTypeOrBaseName(component.GetType(), "UIWidget"))
            return BuildNguiWidgetSummary(component);

        if (IsTypeOrBaseName(component.GetType(), "UIPanel"))
            return BuildNguiPanelSummary(component);

        return new ComponentSummary();
    }

    private static string[] BuildEditableFields(Transform transform)
    {
        List<string> fields = new List<string>();
        fields.Add("GameObject.name");
        fields.Add("activeSelf");
        if (transform is RectTransform)
        {
            fields.Add("rectTransform.anchorMin");
            fields.Add("rectTransform.anchorMax");
            fields.Add("rectTransform.pivot");
            fields.Add("rectTransform.anchoredPosition");
            fields.Add("rectTransform.sizeDelta");
            fields.Add("rectTransform.localScale");
            fields.Add("rectTransform.localEulerAngles.z");
        }
        else if (HasNguiRect(transform))
        {
            fields.Add("rectTransform.anchoredPosition");
            if (GetNguiWidgetComponent(transform.gameObject) != null)
                fields.Add("rectTransform.sizeDelta");
            fields.Add("rectTransform.localScale");
            fields.Add("rectTransform.localEulerAngles.z");
        }
        if (transform.GetComponent<Text>() != null)
        {
            fields.Add("Text.text");
            fields.Add("Text.fontSize");
            fields.Add("Text.color");
            fields.Add("Text.font");
            fields.Add("Text.fontStyle");
            fields.Add("Text.alignment");
            fields.Add("Text.richText");
            fields.Add("Text.horizontalOverflow");
            fields.Add("Text.verticalOverflow");
            fields.Add("Text.lineSpacing");
            fields.Add("Text.bestFit");
            fields.Add("Text.bestFitMinSize");
            fields.Add("Text.bestFitMaxSize");
            fields.Add("Text.raycastTarget");
        }
        else if (GetFirstComponentByTypeName(transform.gameObject, "UILabel") != null)
        {
            fields.Add("Text.text");
            fields.Add("Text.fontSize");
            fields.Add("Text.color");
            fields.Add("Text.fontStyle");
            fields.Add("Text.alignment");
            fields.Add("Text.richText");
        }
        if (transform.GetComponent<Image>() != null)
        {
            fields.Add("Image.enabled");
            fields.Add("Image.color");
            fields.Add("Image.sprite");
            fields.Add("Image.type");
            fields.Add("Image.raycastTarget");
            fields.Add("Image.fillCenter");
            fields.Add("Image.fillMethod");
            fields.Add("Image.fillOrigin");
            fields.Add("Image.fillAmount");
            fields.Add("Image.fillClockwise");
            fields.Add("Image.useSpriteMesh");
            fields.Add("Image.preserveAspect");
        }
        else if (GetNguiSpriteComponent(transform.gameObject) != null)
        {
            fields.Add("Image.enabled");
            fields.Add("Image.color");
            fields.Add("Image.sprite");
            fields.Add("Image.type");
            fields.Add("Image.fillCenter");
            fields.Add("Image.fillMethod");
            fields.Add("Image.fillAmount");
        }
        if (transform.GetComponent<Graphic>() != null)
        {
            fields.Add("Graphic.alpha");
        }
        else if (transform is RectTransform || HasNguiRect(transform))
        {
            fields.Add("Graphic.alpha");
        }
        if (transform.GetComponent<Button>() != null)
        {
            fields.Add("Button.interactable");
            fields.Add("Button.transition");
            fields.Add("Button.colors.normalColor");
            fields.Add("Button.colors.highlightedColor");
            fields.Add("Button.colors.pressedColor");
            fields.Add("Button.colors.disabledColor");
            fields.Add("Button.colors.colorMultiplier");
            fields.Add("Button.colors.fadeDuration");
        }
        else if (GetFirstComponentByTypeName(transform.gameObject, "UIButton") != null)
        {
            fields.Add("Button.interactable");
            fields.Add("Button.normalSprite");
            fields.Add("Button.hoverSprite");
            fields.Add("Button.pressedSprite");
            fields.Add("Button.disabledSprite");
        }
        if (transform is RectTransform)
        {
            fields.Add("Outline.enabled");
            fields.Add("Outline.color");
            fields.Add("Outline.distance");
            fields.Add("Outline.useGraphicAlpha");
            fields.Add("Shadow.enabled");
            fields.Add("Shadow.color");
            fields.Add("Shadow.distance");
            fields.Add("Shadow.useGraphicAlpha");
            fields.Add("Mask.type");
            fields.Add("Mask.showGraphic");
            fields.Add("ScrollRect.horizontal");
            fields.Add("ScrollRect.vertical");
            fields.Add("Toggle.isOn");
            fields.Add("LayoutElement.ignoreLayout");
            fields.Add("LayoutElement.minWidth");
            fields.Add("LayoutElement.minHeight");
            fields.Add("LayoutElement.preferredWidth");
            fields.Add("LayoutElement.preferredHeight");
            fields.Add("LayoutElement.flexibleWidth");
            fields.Add("LayoutElement.flexibleHeight");
            fields.Add("LayoutGroup.type");
            fields.Add("LayoutGroup.enabled");
            fields.Add("LayoutGroup.spacing");
            fields.Add("LayoutGroup.spacingY");
            fields.Add("LayoutGroup.padding.left");
            fields.Add("LayoutGroup.padding.right");
            fields.Add("LayoutGroup.padding.top");
            fields.Add("LayoutGroup.padding.bottom");
            fields.Add("LayoutGroup.childAlignment");
            fields.Add("LayoutGroup.childControlWidth");
            fields.Add("LayoutGroup.childControlHeight");
            fields.Add("LayoutGroup.childForceExpandWidth");
            fields.Add("LayoutGroup.childForceExpandHeight");
            fields.Add("LayoutGroup.reverseArrangement");
            fields.Add("GridLayoutGroup.cellSize");
            fields.Add("GridLayoutGroup.startCorner");
            fields.Add("GridLayoutGroup.startAxis");
            fields.Add("GridLayoutGroup.constraint");
            fields.Add("GridLayoutGroup.constraintCount");
            fields.Add("ContentSizeFitter.enabled");
            fields.Add("ContentSizeFitter.horizontalFit");
            fields.Add("ContentSizeFitter.verticalFit");
        }
        return fields.ToArray();
    }

    private static string[] BuildProtectedFields(Transform transform)
    {
        return new[]
        {
            "GameObject fileID",
            "PrefabInstance source",
            "MonoBehaviour.m_Script",
            "Lua/schema/items bindings",
            "Button.onClick",
            "Non-whitelisted components"
        };
    }

    private static Dictionary<string, Transform> BuildTargetMap(Transform root, string prefabPath)
    {
        Dictionary<string, Transform> result = new Dictionary<string, Transform>();
        AddTargetMap(root, root, result);
        AddPersistentFileIdAliases(root, prefabPath, result);
        return result;
    }

    private static Transform ResolveParentTransform(Transform root, string prefabPath, string parentId)
    {
        if (root == null) return null;
        if (string.IsNullOrEmpty(parentId)) return root;
        Dictionary<string, Transform> targets = BuildTargetMap(root, prefabPath);
        Transform parent;
        if (!targets.TryGetValue(parentId, out parent))
            throw new BridgeRequestException("PARENT_NOT_FOUND", "parentId not found: " + parentId);
        return parent;
    }

    private static void AddTargetMap(Transform root, Transform current, Dictionary<string, Transform> result)
    {
        string nodeId = BuildNodeId(root, current);
        if (!string.IsNullOrEmpty(nodeId) && !result.ContainsKey(nodeId)) result.Add(nodeId, current);
        string pathId = "path:" + GetTransformPath(root, current);
        if (!result.ContainsKey(pathId)) result.Add(pathId, current);
        foreach (Transform child in current)
            AddTargetMap(root, child, result);
    }

    private static void AddPersistentFileIdAliases(Transform loadedRoot, string prefabPath, Dictionary<string, Transform> result)
    {
        GameObject persistentPrefab = AssetDatabase.LoadAssetAtPath<GameObject>(prefabPath);
        if (persistentPrefab == null) return;

        Dictionary<string, Transform> loadedByPath = new Dictionary<string, Transform>();
        AddLoadedPathMap(loadedRoot, loadedRoot, loadedByPath);
        AddPersistentFileIdAliasesRecursive(persistentPrefab.transform, persistentPrefab.transform, loadedByPath, result);
    }

    private static void AddLoadedPathMap(Transform root, Transform current, Dictionary<string, Transform> loadedByPath)
    {
        string path = GetTransformPath(root, current);
        if (!string.IsNullOrEmpty(path) && !loadedByPath.ContainsKey(path))
            loadedByPath.Add(path, current);
        string relativePath = StripRootPath(path);
        if (!string.IsNullOrEmpty(relativePath) && !loadedByPath.ContainsKey(relativePath))
            loadedByPath.Add(relativePath, current);
        foreach (Transform child in current)
            AddLoadedPathMap(root, child, loadedByPath);
    }

    private static void AddPersistentFileIdAliasesRecursive(Transform persistentRoot, Transform current, Dictionary<string, Transform> loadedByPath, Dictionary<string, Transform> result)
    {
        string path = GetTransformPath(persistentRoot, current);
        Transform loaded;
        string fileId = GetPersistentFileId(current.gameObject);
        if (!string.IsNullOrEmpty(fileId) && (loadedByPath.TryGetValue(path, out loaded) || loadedByPath.TryGetValue(StripRootPath(path), out loaded)))
        {
            string nodeId = "fileID:" + fileId;
            if (!result.ContainsKey(nodeId))
                result.Add(nodeId, loaded);
        }

        foreach (Transform child in current)
            AddPersistentFileIdAliasesRecursive(persistentRoot, child, loadedByPath, result);
    }

    private static string StripRootPath(string path)
    {
        if (string.IsNullOrEmpty(path)) return path;
        int slash = path.IndexOf('/');
        return slash >= 0 && slash + 1 < path.Length ? path.Substring(slash + 1) : "";
    }

    private static List<Transform> ResolveUniqueTransforms(string[] nodeIds, Dictionary<string, Transform> targets, Transform root, string operation)
    {
        List<Transform> result = new List<Transform>();
        HashSet<Transform> seen = new HashSet<Transform>();
        for (int i = 0; i < nodeIds.Length; i++)
        {
            string nodeId = nodeIds[i];
            Transform node;
            if (!targets.TryGetValue(nodeId, out node))
                throw new BridgeRequestException("NODE_NOT_FOUND", "nodeId not found: " + nodeId);
            if (node == root)
                throw new BridgeRequestException("ROOT_" + operation + "_REJECTED", "root cannot be used for this operation");
            if (seen.Add(node)) result.Add(node);
        }
        return result;
    }

    private static Bounds CalculateLocalBounds(RectTransform parentRect, List<Transform> nodes)
    {
        Vector3[] corners = new Vector3[4];
        bool hasPoint = false;
        Vector3 min = Vector3.zero;
        Vector3 max = Vector3.zero;
        for (int i = 0; i < nodes.Count; i++)
        {
            RectTransform rect = nodes[i] as RectTransform;
            if (rect == null) continue;
            rect.GetWorldCorners(corners);
            for (int c = 0; c < corners.Length; c++)
            {
                Vector3 local = parentRect.InverseTransformPoint(corners[c]);
                if (!hasPoint)
                {
                    min = local;
                    max = local;
                    hasPoint = true;
                }
                else
                {
                    min = Vector3.Min(min, local);
                    max = Vector3.Max(max, local);
                }
            }
        }
        if (!hasPoint)
            return new Bounds(Vector3.zero, Vector3.one);
        return new Bounds((min + max) * 0.5f, max - min);
    }

    private static float DefaultWidgetWidth(string widgetType)
    {
        if (widgetType == "scrollview") return 400f;
        if (widgetType == "inputfield") return 300f;
        if (widgetType == "toggle") return 120f;
        if (widgetType == "rawimage" || widgetType == "image") return 200f;
        if (widgetType == "frame") return 300f;
        return 200f;
    }

    private static float DefaultWidgetHeight(string widgetType)
    {
        if (widgetType == "scrollview") return 300f;
        if (widgetType == "inputfield") return 50f;
        if (widgetType == "toggle") return 40f;
        if (widgetType == "rawimage" || widgetType == "image") return 200f;
        if (widgetType == "frame") return 200f;
        if (widgetType == "text") return 40f;
        return 60f;
    }

    private static Font DefaultFont()
    {
        return Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
    }

    private static Text BuildTextGraphic(GameObject go, string textValue, int fontSize, TextAnchor alignment)
    {
        Text text = go.AddComponent<Text>();
        text.text = textValue;
        text.fontSize = fontSize;
        text.color = Color.white;
        text.alignment = alignment;
        Font font = DefaultFont();
        if (font != null) text.font = font;
        return text;
    }

    private static GameObject CreateRectChild(Transform parent, string name, Vector2 anchorMin, Vector2 anchorMax, Vector2 offsetMin, Vector2 offsetMax)
    {
        GameObject child = new GameObject(name);
        RectTransform rect = child.AddComponent<RectTransform>();
        rect.SetParent(parent, false);
        rect.anchorMin = anchorMin;
        rect.anchorMax = anchorMax;
        rect.offsetMin = offsetMin;
        rect.offsetMax = offsetMax;
        return child;
    }

    private static void BuildButtonWidget(GameObject go)
    {
        Image image = go.AddComponent<Image>();
        image.color = new Color(0.35f, 0.52f, 0.95f, 1f);
        Button button = go.AddComponent<Button>();
        button.targetGraphic = image;
        GameObject label = CreateRectChild(go.transform, "Text", Vector2.zero, Vector2.one, Vector2.zero, Vector2.zero);
        BuildTextGraphic(label, "Button", 24, TextAnchor.MiddleCenter);
    }

    private static void BuildRawImageWidget(GameObject go)
    {
        RawImage raw = go.AddComponent<RawImage>();
        raw.color = Color.white;
    }

    private static void BuildScrollViewWidget(GameObject go)
    {
        Image image = go.AddComponent<Image>();
        image.color = new Color(1f, 1f, 1f, 0.08f);
        ScrollRect scroll = go.AddComponent<ScrollRect>();
        scroll.horizontal = false;
        scroll.vertical = true;

        GameObject viewport = CreateRectChild(go.transform, "Viewport", Vector2.zero, Vector2.one, Vector2.zero, Vector2.zero);
        Image viewportImage = viewport.AddComponent<Image>();
        viewportImage.color = new Color(1f, 1f, 1f, 0.01f);
        viewport.AddComponent<RectMask2D>();

        GameObject content = CreateRectChild(viewport.transform, "Content", new Vector2(0f, 1f), new Vector2(1f, 1f), new Vector2(0f, -300f), Vector2.zero);
        RectTransform contentRect = content.GetComponent<RectTransform>();
        contentRect.pivot = new Vector2(0.5f, 1f);
        scroll.viewport = viewport.GetComponent<RectTransform>();
        scroll.content = contentRect;
    }

    private static void BuildToggleWidget(GameObject go)
    {
        Toggle toggle = go.AddComponent<Toggle>();
        GameObject background = CreateRectChild(go.transform, "Background", new Vector2(0f, 0.5f), new Vector2(0f, 0.5f), new Vector2(0f, -10f), new Vector2(20f, 10f));
        Image bgImage = background.AddComponent<Image>();
        bgImage.color = Color.white;
        GameObject checkmark = CreateRectChild(background.transform, "Checkmark", Vector2.zero, Vector2.one, new Vector2(3f, 3f), new Vector2(-3f, -3f));
        Image checkImage = checkmark.AddComponent<Image>();
        checkImage.color = new Color(0.35f, 0.8f, 0.35f, 1f);
        GameObject label = CreateRectChild(go.transform, "Label", Vector2.zero, Vector2.one, new Vector2(28f, 0f), Vector2.zero);
        BuildTextGraphic(label, "Toggle", 20, TextAnchor.MiddleLeft);
        toggle.targetGraphic = bgImage;
        toggle.graphic = checkImage;
        toggle.isOn = false;
    }

    private static void BuildInputFieldWidget(GameObject go)
    {
        Image image = go.AddComponent<Image>();
        image.color = Color.white;
        InputField input = go.AddComponent<InputField>();
        GameObject placeholder = CreateRectChild(go.transform, "Placeholder", Vector2.zero, Vector2.one, new Vector2(10f, 6f), new Vector2(-10f, -6f));
        Text placeholderText = BuildTextGraphic(placeholder, "Input...", 20, TextAnchor.MiddleLeft);
        placeholderText.color = new Color(0.5f, 0.5f, 0.5f, 0.75f);
        GameObject text = CreateRectChild(go.transform, "Text", Vector2.zero, Vector2.one, new Vector2(10f, 6f), new Vector2(-10f, -6f));
        Text textGraphic = BuildTextGraphic(text, "", 20, TextAnchor.MiddleLeft);
        textGraphic.color = Color.black;
        input.targetGraphic = image;
        input.placeholder = placeholderText;
        input.textComponent = textGraphic;
    }

    private static bool IsFieldEditable(Transform target, string field)
    {
        if (string.IsNullOrEmpty(field)) return false;
        string[] fields = BuildEditableFields(target);
        for (int i = 0; i < fields.Length; i++)
            if (fields[i] == field) return true;
        return false;
    }

    private static bool ApplyOperation(Transform target, VisualPatchOperation op, out string error)
    {
        error = null;
        RectTransform rect = target as RectTransform;
        if (op.field == "GameObject.name")
        {
            target.gameObject.name = op.stringValue ?? target.gameObject.name;
            return true;
        }
        if (op.field == "activeSelf")
        {
            target.gameObject.SetActive(op.boolValue);
            return true;
        }
        if (op.field == "rectTransform.anchorMin" && rect != null) { rect.anchorMin = ReadVector2(op, rect.anchorMin); return true; }
        if (op.field == "rectTransform.anchorMax" && rect != null) { rect.anchorMax = ReadVector2(op, rect.anchorMax); return true; }
        if (op.field == "rectTransform.pivot" && rect != null) { rect.pivot = ReadVector2(op, rect.pivot); return true; }
        if (op.field == "rectTransform.sizeDelta" && rect != null) { rect.sizeDelta = ApplyVector2(rect.sizeDelta, op); return true; }
        if (op.field == "rectTransform.anchoredPosition" && rect != null) { rect.anchoredPosition = ApplyVector2(rect.anchoredPosition, op); return true; }
        if (op.field == "rectTransform.localScale" && rect != null) { rect.localScale = ApplyVector3(rect.localScale, op); return true; }
        if (op.field == "rectTransform.localEulerAngles.z" && rect != null)
        {
            Vector3 euler = rect.localEulerAngles;
            euler.z = op.op == "delta" ? euler.z + ReadNumber(op, 0f) : ReadNumber(op, euler.z);
            rect.localEulerAngles = euler;
            return true;
        }
        if (rect == null && op.field.StartsWith("rectTransform.", StringComparison.Ordinal) && ApplyNguiTransformOperation(target, op))
            return true;

        Text text = target.GetComponent<Text>();
        if (op.field == "Text.text" && text != null) { text.text = op.stringValue ?? ""; return true; }
        if (op.field == "Text.fontSize" && text != null) { text.fontSize = Mathf.RoundToInt(ReadNumber(op, text.fontSize)); return true; }
        if (op.field == "Text.color" && text != null) { text.color = ParseColor(op.stringValue, text.color); return true; }
        if (op.field == "Text.font" && text != null)
        {
            Font font = AssetDatabase.LoadAssetAtPath<Font>(op.stringValue);
            if (font == null)
            {
                error = "FONT_NOT_FOUND";
                return false;
            }
            text.font = font;
            return true;
        }
        if (op.field == "Text.fontStyle" && text != null) { text.fontStyle = (FontStyle)Mathf.RoundToInt(ReadNumber(op, (int)text.fontStyle)); return true; }
        if (op.field == "Text.alignment" && text != null) { text.alignment = (TextAnchor)Mathf.RoundToInt(ReadNumber(op, (int)text.alignment)); return true; }
        if (op.field == "Text.richText" && text != null) { text.supportRichText = op.boolValue; return true; }
        if (op.field == "Text.horizontalOverflow" && text != null) { text.horizontalOverflow = (HorizontalWrapMode)Mathf.RoundToInt(ReadNumber(op, (int)text.horizontalOverflow)); return true; }
        if (op.field == "Text.verticalOverflow" && text != null) { text.verticalOverflow = (VerticalWrapMode)Mathf.RoundToInt(ReadNumber(op, (int)text.verticalOverflow)); return true; }
        if (op.field == "Text.lineSpacing" && text != null) { text.lineSpacing = ReadNumber(op, text.lineSpacing); return true; }
        if (op.field == "Text.bestFit" && text != null) { text.resizeTextForBestFit = op.boolValue; return true; }
        if (op.field == "Text.bestFitMinSize" && text != null) { text.resizeTextMinSize = Mathf.RoundToInt(ReadNumber(op, text.resizeTextMinSize)); return true; }
        if (op.field == "Text.bestFitMaxSize" && text != null) { text.resizeTextMaxSize = Mathf.RoundToInt(ReadNumber(op, text.resizeTextMaxSize)); return true; }
        if (op.field == "Text.raycastTarget" && text != null) { text.raycastTarget = op.boolValue; return true; }
        Component nguiLabel = GetFirstComponentByTypeName(target.gameObject, "UILabel");
        if (nguiLabel != null && ApplyNguiLabelOperation(nguiLabel, op, out error))
            return true;

        Image image = target.GetComponent<Image>();
        if (op.field == "Image.enabled" && image != null) { image.enabled = op.boolValue; return true; }
        if (op.field == "Image.color" && image != null) { image.color = ParseColor(op.stringValue, image.color); return true; }
        if (op.field == "Image.sprite" && image != null)
        {
            if (string.IsNullOrEmpty(op.stringValue))
            {
                image.sprite = null;
                return true;
            }
            Sprite sprite = LoadSprite(op.stringValue);
            if (sprite == null)
            {
                error = "SPRITE_NOT_FOUND";
                return false;
            }
            image.sprite = sprite;
            return true;
        }
        if (op.field == "Image.type" && image != null)
        {
            try { image.type = (Image.Type)Enum.Parse(typeof(Image.Type), op.stringValue); return true; }
            catch { error = "BAD_IMAGE_TYPE"; return false; }
        }
        if (op.field == "Image.raycastTarget" && image != null) { image.raycastTarget = op.boolValue; return true; }
        if (op.field == "Image.fillCenter" && image != null) { image.fillCenter = op.boolValue; return true; }
        if (op.field == "Image.fillMethod" && image != null) { image.fillMethod = (Image.FillMethod)Mathf.RoundToInt(ReadNumber(op, (int)image.fillMethod)); return true; }
        if (op.field == "Image.fillOrigin" && image != null) { image.fillOrigin = Mathf.RoundToInt(ReadNumber(op, image.fillOrigin)); return true; }
        if (op.field == "Image.fillAmount" && image != null) { image.fillAmount = Mathf.Clamp01(ReadNumber(op, image.fillAmount)); return true; }
        if (op.field == "Image.fillClockwise" && image != null) { image.fillClockwise = op.boolValue; return true; }
        if (op.field == "Image.useSpriteMesh" && image != null) { image.useSpriteMesh = op.boolValue; return true; }
        if (op.field == "Image.preserveAspect" && image != null) { image.preserveAspect = op.boolValue; return true; }
        Component nguiSprite = GetNguiSpriteComponent(target.gameObject);
        if (nguiSprite != null && ApplyNguiSpriteOperation(nguiSprite, op, out error))
            return true;

        Graphic graphic = target.GetComponent<Graphic>();
        if (op.field == "Graphic.alpha" && graphic != null)
        {
            Color color = graphic.color;
            color.a = Mathf.Clamp01(ReadNumber(op, color.a));
            graphic.color = color;
            return true;
        }
        Component nguiWidget = GetNguiWidgetComponent(target.gameObject);
        if (op.field == "Graphic.alpha" && nguiWidget != null)
        {
            SetReflectedProperty(nguiWidget, "alpha", Mathf.Clamp01(ReadNumber(op, ReadReflectedFloat(nguiWidget, "alpha", 1f))));
            InvokeReflectedMethod(nguiWidget, "MarkAsChanged");
            return true;
        }
        if (op.field == "Graphic.alpha")
        {
            CanvasGroup canvasGroup = target.GetComponent<CanvasGroup>();
            if (canvasGroup == null)
            {
                canvasGroup = target.gameObject.AddComponent<CanvasGroup>();
                canvasGroup.interactable = true;
                canvasGroup.blocksRaycasts = true;
                canvasGroup.ignoreParentGroups = false;
            }
            canvasGroup.alpha = Mathf.Clamp01(ReadNumber(op, canvasGroup.alpha));
            return true;
        }

        Button button = target.GetComponent<Button>();
        if (op.field == "Button.interactable" && button != null) { button.interactable = op.boolValue; return true; }
        if (op.field == "Button.transition" && button != null) { button.transition = (Selectable.Transition)Mathf.RoundToInt(ReadNumber(op, (int)button.transition)); return true; }
        if (button != null && op.field.StartsWith("Button.colors.", StringComparison.Ordinal))
        {
            ColorBlock colors = button.colors;
            if (op.field == "Button.colors.normalColor") colors.normalColor = ParseColor(op.stringValue, colors.normalColor);
            else if (op.field == "Button.colors.highlightedColor") colors.highlightedColor = ParseColor(op.stringValue, colors.highlightedColor);
            else if (op.field == "Button.colors.pressedColor") colors.pressedColor = ParseColor(op.stringValue, colors.pressedColor);
            else if (op.field == "Button.colors.disabledColor") colors.disabledColor = ParseColor(op.stringValue, colors.disabledColor);
            else if (op.field == "Button.colors.colorMultiplier") colors.colorMultiplier = ReadNumber(op, colors.colorMultiplier);
            else if (op.field == "Button.colors.fadeDuration") colors.fadeDuration = ReadNumber(op, colors.fadeDuration);
            else { error = "FIELD_APPLY_FAILED"; return false; }
            button.colors = colors;
            return true;
        }
        Component nguiButton = GetFirstComponentByTypeName(target.gameObject, "UIButton");
        if (nguiButton != null && ApplyNguiButtonOperation(nguiButton, op, out error))
            return true;

        if (op.field == "Outline.enabled") { GetOrAddComponent<Outline>(target.gameObject).enabled = op.boolValue; return true; }
        if (op.field == "Outline.color") { GetOrAddComponent<Outline>(target.gameObject).effectColor = ParseColor(op.stringValue, Color.black); return true; }
        if (op.field == "Outline.distance") { GetOrAddComponent<Outline>(target.gameObject).effectDistance = ReadVector2(op, Vector2.one); return true; }
        if (op.field == "Outline.useGraphicAlpha") { GetOrAddComponent<Outline>(target.gameObject).useGraphicAlpha = op.boolValue; return true; }
        if (op.field == "Shadow.enabled") { GetOrAddComponent<Shadow>(target.gameObject).enabled = op.boolValue; return true; }
        if (op.field == "Shadow.color") { GetOrAddComponent<Shadow>(target.gameObject).effectColor = ParseColor(op.stringValue, Color.black); return true; }
        if (op.field == "Shadow.distance") { GetOrAddComponent<Shadow>(target.gameObject).effectDistance = ReadVector2(op, Vector2.one); return true; }
        if (op.field == "Shadow.useGraphicAlpha") { GetOrAddComponent<Shadow>(target.gameObject).useGraphicAlpha = op.boolValue; return true; }

        if (op.field == "Mask.type") { ApplyMaskType(target.gameObject, op.stringValue); return true; }
        if (op.field == "Mask.showGraphic") { GetOrAddComponent<Mask>(target.gameObject).showMaskGraphic = op.boolValue; return true; }

        if (op.field == "ScrollRect.horizontal") { GetOrAddComponent<ScrollRect>(target.gameObject).horizontal = op.boolValue; return true; }
        if (op.field == "ScrollRect.vertical") { GetOrAddComponent<ScrollRect>(target.gameObject).vertical = op.boolValue; return true; }
        if (op.field == "Toggle.isOn") { GetOrAddComponent<Toggle>(target.gameObject).isOn = op.boolValue; return true; }

        if (op.field.StartsWith("LayoutElement.", StringComparison.Ordinal))
        {
            LayoutElement layoutElement = GetOrAddComponent<LayoutElement>(target.gameObject);
            if (op.field == "LayoutElement.ignoreLayout") layoutElement.ignoreLayout = op.boolValue;
            else if (op.field == "LayoutElement.minWidth") layoutElement.minWidth = ReadNumber(op, layoutElement.minWidth);
            else if (op.field == "LayoutElement.minHeight") layoutElement.minHeight = ReadNumber(op, layoutElement.minHeight);
            else if (op.field == "LayoutElement.preferredWidth") layoutElement.preferredWidth = ReadNumber(op, layoutElement.preferredWidth);
            else if (op.field == "LayoutElement.preferredHeight") layoutElement.preferredHeight = ReadNumber(op, layoutElement.preferredHeight);
            else if (op.field == "LayoutElement.flexibleWidth") layoutElement.flexibleWidth = ReadNumber(op, layoutElement.flexibleWidth);
            else if (op.field == "LayoutElement.flexibleHeight") layoutElement.flexibleHeight = ReadNumber(op, layoutElement.flexibleHeight);
            else { error = "FIELD_APPLY_FAILED"; return false; }
            return true;
        }

        if (op.field == "LayoutGroup.type") { ApplyLayoutGroupType(target.gameObject, op.stringValue); return true; }
        if (op.field.StartsWith("LayoutGroup.", StringComparison.Ordinal) || op.field.StartsWith("GridLayoutGroup.", StringComparison.Ordinal))
        {
            LayoutGroup layout = target.GetComponent<LayoutGroup>();
            if (layout == null) layout = target.gameObject.AddComponent<HorizontalLayoutGroup>();
            if (op.field == "LayoutGroup.enabled") layout.enabled = op.boolValue;
            else if (op.field == "LayoutGroup.padding.left") layout.padding.left = Mathf.RoundToInt(ReadNumber(op, layout.padding.left));
            else if (op.field == "LayoutGroup.padding.right") layout.padding.right = Mathf.RoundToInt(ReadNumber(op, layout.padding.right));
            else if (op.field == "LayoutGroup.padding.top") layout.padding.top = Mathf.RoundToInt(ReadNumber(op, layout.padding.top));
            else if (op.field == "LayoutGroup.padding.bottom") layout.padding.bottom = Mathf.RoundToInt(ReadNumber(op, layout.padding.bottom));
            else if (op.field == "LayoutGroup.childAlignment") layout.childAlignment = (TextAnchor)Mathf.RoundToInt(ReadNumber(op, (int)layout.childAlignment));
            else if (ApplyHorizontalOrVerticalLayoutField(layout as HorizontalOrVerticalLayoutGroup, op)) return true;
            else if (ApplyGridLayoutField(layout as GridLayoutGroup, op)) return true;
            else { error = "FIELD_APPLY_FAILED"; return false; }
            return true;
        }

        if (op.field.StartsWith("ContentSizeFitter.", StringComparison.Ordinal))
        {
            ContentSizeFitter fitter = GetOrAddComponent<ContentSizeFitter>(target.gameObject);
            if (op.field == "ContentSizeFitter.enabled") fitter.enabled = op.boolValue;
            else if (op.field == "ContentSizeFitter.horizontalFit") fitter.horizontalFit = (ContentSizeFitter.FitMode)Mathf.RoundToInt(ReadNumber(op, (int)fitter.horizontalFit));
            else if (op.field == "ContentSizeFitter.verticalFit") fitter.verticalFit = (ContentSizeFitter.FitMode)Mathf.RoundToInt(ReadNumber(op, (int)fitter.verticalFit));
            else { error = "FIELD_APPLY_FAILED"; return false; }
            return true;
        }

        error = "FIELD_APPLY_FAILED";
        return false;
    }

    private static ProtectedDiffResult BuildProtectedDiff(SessionState session, string validationId)
    {
        string baselineYaml = NormalizeYamlForProtectedDiff(session.baselineYaml, session);
        string currentYaml = NormalizeYamlForProtectedDiff(ReadAssetText(session.workingPrefabPath), session);
        List<DiffChange> allowed = BuildAllowedDiffChanges(session);
        List<DiffChange> protectedChanges = new List<DiffChange>();

        CompareSignatureMultiset("yaml.protectedLine", ExtractProtectedLineSignatures(baselineYaml), ExtractProtectedLineSignatures(currentYaml), protectedChanges);
        CompareSignatureMultiset("yaml.protectedPropertyModification", ExtractProtectedPropertyModificationSignatures(baselineYaml), ExtractProtectedPropertyModificationSignatures(currentYaml), protectedChanges);

        return new ProtectedDiffResult
        {
            ok = protectedChanges.Count == 0,
            validationId = validationId,
            allowedChanges = allowed.ToArray(),
            protectedChanges = protectedChanges.ToArray(),
            summary = new DiffSummary { allowedCount = allowed.Count, protectedCount = protectedChanges.Count }
        };
    }

    private static string DescribeProtectedDiff(ProtectedDiffResult diff)
    {
        if (diff == null || diff.protectedChanges == null || diff.protectedChanges.Length == 0)
            return "no protected changes";
        List<string> parts = new List<string>();
        int max = Mathf.Min(6, diff.protectedChanges.Length);
        for (int i = 0; i < max; i++)
        {
            DiffChange change = diff.protectedChanges[i];
            if (change == null) continue;
            parts.Add(change.field + " before=[" + Shorten(change.before, 160) + "] after=[" + Shorten(change.after, 160) + "]");
        }
        if (diff.protectedChanges.Length > max)
            parts.Add("+" + (diff.protectedChanges.Length - max).ToString(CultureInfo.InvariantCulture) + " more");
        return string.Join("; ", parts.ToArray());
    }

    private static string Shorten(string value, int maxLength)
    {
        if (string.IsNullOrEmpty(value)) return "";
        string normalized = value.Replace("\r", " ").Replace("\n", " ");
        return normalized.Length <= maxLength ? normalized : normalized.Substring(0, maxLength) + "...";
    }

    private static List<DiffChange> BuildAllowedDiffChanges(SessionState session)
    {
        List<DiffChange> result = new List<DiffChange>();
        if (session.appliedChanges == null) return result;
        for (int i = 0; i < session.appliedChanges.Count; i++)
        {
            PatchChange change = session.appliedChanges[i];
            if (change == null) continue;
            result.Add(new DiffChange
            {
                nodeId = change.nodeId,
                field = change.field,
                before = change.before,
                after = change.after,
                line = 0
            });
        }
        return result;
    }

    private static string NormalizeYamlForProtectedDiff(string yaml, SessionState session)
    {
        string normalized = (yaml ?? "").Replace("\r\n", "\n");
        if (session != null && !string.IsNullOrEmpty(session.sourcePrefabPath) && !string.IsNullOrEmpty(session.workingPrefabPath))
        {
            string sourceName = Path.GetFileNameWithoutExtension(session.sourcePrefabPath);
            string workingName = Path.GetFileNameWithoutExtension(session.workingPrefabPath);
            if (!string.IsNullOrEmpty(sourceName) && !string.IsNullOrEmpty(workingName) && sourceName != workingName)
                normalized = normalized.Replace(workingName, sourceName);
        }
        return normalized;
    }

    private static Dictionary<string, int> ExtractObjectClassSignatures(string yaml)
    {
        Dictionary<string, int> result = new Dictionary<string, int>(StringComparer.Ordinal);
        string[] lines = (yaml ?? "").Split('\n');
        for (int i = 0; i < lines.Length; i++)
        {
            string line = lines[i].Trim();
            if (!line.StartsWith("--- !u!", StringComparison.Ordinal)) continue;
            int start = "--- !u!".Length;
            int end = line.IndexOf(' ', start);
        string classId = end > start ? line.Substring(start, end - start) : line.Substring(start);
            if (classId == "225") continue;
            AddSignature(result, "class:" + classId);
        }
        return result;
    }

    private static Dictionary<string, int> ExtractProtectedLineSignatures(string yaml)
    {
        Dictionary<string, int> result = new Dictionary<string, int>(StringComparer.Ordinal);
        string[] prefixes =
        {
            "m_TargetAssemblyTypeName:",
            "m_MethodName:",
            "m_Mode:",
            "m_CallState:",
            "m_SourcePrefab:",
            "m_RemovedComponents:"
        };

        string[] lines = (yaml ?? "").Split('\n');
        for (int i = 0; i < lines.Length; i++)
        {
            string line = lines[i].Trim();
            for (int j = 0; j < prefixes.Length; j++)
            {
                if (line.StartsWith(prefixes[j], StringComparison.Ordinal))
                {
                    AddSignature(result, line);
                    break;
                }
            }
        }
        return result;
    }

    private static Dictionary<string, int> ExtractProtectedPropertyModificationSignatures(string yaml)
    {
        Dictionary<string, int> result = new Dictionary<string, int>(StringComparer.Ordinal);
        string currentProperty = null;
        string[] lines = (yaml ?? "").Split('\n');
        for (int i = 0; i < lines.Length; i++)
        {
            string line = lines[i].Trim();
            if (line.StartsWith("propertyPath:", StringComparison.Ordinal))
            {
                currentProperty = line.Substring("propertyPath:".Length).Trim();
                continue;
            }

            if (string.IsNullOrEmpty(currentProperty)) continue;
            if (line.StartsWith("value:", StringComparison.Ordinal) || line.StartsWith("objectReference:", StringComparison.Ordinal))
            {
                if (!IsAllowedYamlPropertyPath(currentProperty))
                    AddSignature(result, "propertyPath:" + currentProperty + "|" + line);
            }
        }
        return result;
    }

    private static void AddSignature(Dictionary<string, int> map, string signature)
    {
        if (string.IsNullOrEmpty(signature)) return;
        int count;
        map.TryGetValue(signature, out count);
        map[signature] = count + 1;
    }

    private static void CompareSignatureMultiset(string field, Dictionary<string, int> before, Dictionary<string, int> after, List<DiffChange> protectedChanges)
    {
        foreach (KeyValuePair<string, int> pair in before)
        {
            int afterCount;
            after.TryGetValue(pair.Key, out afterCount);
            if (afterCount != pair.Value)
            {
                protectedChanges.Add(new DiffChange
                {
                    nodeId = null,
                    field = field,
                    before = pair.Key + " x" + pair.Value.ToString(CultureInfo.InvariantCulture),
                    after = pair.Key + " x" + afterCount.ToString(CultureInfo.InvariantCulture),
                    line = 0
                });
            }
        }

        foreach (KeyValuePair<string, int> pair in after)
        {
            if (before.ContainsKey(pair.Key)) continue;
            protectedChanges.Add(new DiffChange
            {
                nodeId = null,
                field = field,
                before = pair.Key + " x0",
                after = pair.Key + " x" + pair.Value.ToString(CultureInfo.InvariantCulture),
                line = 0
            });
        }
    }

    private static bool IsAllowedYamlPropertyPath(string propertyPath)
    {
        if (string.IsNullOrEmpty(propertyPath)) return false;
        string[] allowedPrefixes =
        {
            "m_IsActive",
            "m_AnchoredPosition",
            "m_SizeDelta",
            "m_AnchorMin",
            "m_AnchorMax",
            "m_Pivot",
            "m_LocalScale",
            "m_LocalRotation",
            "m_LocalEulerAnglesHint",
            "m_Text",
            "m_FontSize",
            "m_Font",
            "m_FontData",
            "m_Color",
            "m_Sprite",
            "m_Material",
            "m_Type",
            "m_Interactable",
            "m_FontStyle",
            "m_Alignment",
            "m_RichText",
            "m_HorizontalOverflow",
            "m_VerticalOverflow",
            "m_LineSpacing",
            "m_BestFit",
            "m_MinSize",
            "m_MaxSize",
            "m_RaycastTarget",
            "m_Enabled",
            "m_FillCenter",
            "m_FillMethod",
            "m_FillOrigin",
            "m_FillAmount",
            "m_FillClockwise",
            "m_UseSpriteMesh",
            "m_PreserveAspect",
            "m_EffectColor",
            "m_EffectDistance",
            "m_UseGraphicAlpha",
            "m_ShowMaskGraphic",
            "m_Horizontal",
            "m_Vertical",
            "m_IsOn",
            "m_IgnoreLayout",
            "m_MinWidth",
            "m_MinHeight",
            "m_PreferredWidth",
            "m_PreferredHeight",
            "m_FlexibleWidth",
            "m_FlexibleHeight",
            "m_Padding",
            "m_ChildAlignment",
            "m_Spacing",
            "m_ChildControlWidth",
            "m_ChildControlHeight",
            "m_ChildForceExpandWidth",
            "m_ChildForceExpandHeight",
            "m_ReverseArrangement",
            "m_CellSize",
            "m_StartCorner",
            "m_StartAxis",
            "m_Constraint",
            "m_ConstraintCount",
            "m_HorizontalFit",
            "m_VerticalFit",
            "m_Alpha",
            "m_BlocksRaycasts",
            "m_IgnoreParentGroups",
            "mWidth",
            "mHeight",
            "mColor",
            "mText",
            "mFontSize",
            "mFontStyle",
            "mAlignment",
            "mSpriteName",
            "mType",
            "mFillAmount",
            "hoverSprite",
            "pressedSprite",
            "disabledSprite",
            "mNormalSprite",
            "normalColor",
            "highlightedColor",
            "pressedColor",
            "disabledColor",
            "colorMultiplier",
            "fadeDuration"
        };
        for (int i = 0; i < allowedPrefixes.Length; i++)
            if (propertyPath.StartsWith(allowedPrefixes[i], StringComparison.Ordinal)) return true;
        return false;
    }

    private static bool IsAllowedYamlChange(string before, string after)
    {
        string combined = (before ?? "") + "\n" + (after ?? "");
        string[] allowedTokens =
        {
            "m_IsActive:",
            "m_AnchoredPosition:",
            "m_SizeDelta:",
            "m_AnchorMin:",
            "m_AnchorMax:",
            "m_Pivot:",
            "m_LocalScale:",
            "m_LocalRotation:",
            "m_LocalEulerAnglesHint:",
            "m_Text:",
            "m_FontSize:",
            "m_Color:",
            "m_Sprite:",
            "m_Material:",
            "m_Type:",
            "m_Interactable:",
            "m_FontStyle:",
            "m_Alignment:",
            "m_RichText:",
            "m_HorizontalOverflow:",
            "m_VerticalOverflow:",
            "m_LineSpacing:",
            "m_BestFit:",
            "m_MinSize:",
            "m_MaxSize:",
            "m_RaycastTarget:",
            "m_Enabled:",
            "m_FillCenter:",
            "m_FillMethod:",
            "m_FillOrigin:",
            "m_FillAmount:",
            "m_FillClockwise:",
            "m_UseSpriteMesh:",
            "m_PreserveAspect:",
            "m_EffectColor:",
            "m_EffectDistance:",
            "m_UseGraphicAlpha:",
            "m_ShowMaskGraphic:",
            "m_Horizontal:",
            "m_Vertical:",
            "m_IsOn:",
            "m_IgnoreLayout:",
            "m_MinWidth:",
            "m_MinHeight:",
            "m_PreferredWidth:",
            "m_PreferredHeight:",
            "m_FlexibleWidth:",
            "m_FlexibleHeight:",
            "m_Padding:",
            "m_ChildAlignment:",
            "m_Spacing:",
            "m_ChildControlWidth:",
            "m_ChildControlHeight:",
            "m_ChildForceExpandWidth:",
            "m_ChildForceExpandHeight:",
            "m_ReverseArrangement:",
            "m_CellSize:",
            "m_StartCorner:",
            "m_StartAxis:",
            "m_Constraint:",
            "m_ConstraintCount:",
            "m_HorizontalFit:",
            "m_VerticalFit:",
            "mWidth:",
            "mHeight:",
            "mColor:",
            "mText:",
            "mFontSize:",
            "mFontStyle:",
            "mAlignment:",
            "mSpriteName:",
            "mType:",
            "mFillAmount:",
            "hoverSprite:",
            "pressedSprite:",
            "disabledSprite:",
            "mNormalSprite:",
            "normalColor:",
            "highlightedColor:",
            "pressedColor:",
            "disabledColor:",
            "colorMultiplier:",
            "fadeDuration:"
        };
        for (int i = 0; i < allowedTokens.Length; i++)
            if (combined.Contains(allowedTokens[i])) return true;
        return false;
    }

    private static string GuessYamlField(string before, string after)
    {
        string line = !string.IsNullOrEmpty(after) ? after.Trim() : before.Trim();
        int colon = line.IndexOf(':');
        return colon > 0 ? line.Substring(0, colon) : "yaml-line";
    }

    // 在渲染 clone 被 ForceNguiRefresh / 布局重建（可能重排子节点）之前，
    // 按结构索引快照每个 clone Transform 的 nodeId。clone 是 working root 的精确拷贝，
    // 此刻其结构索引与 working root 完全一致，故 bbox 能拿到与层级树相同的 nodeId。
    private static Dictionary<Transform, string> BuildNodeIdByTransform(Transform cloneRoot)
    {
        Dictionary<Transform, string> result = new Dictionary<Transform, string>();
        if (cloneRoot != null)
            AddNodeIdByTransform(cloneRoot, cloneRoot, result);
        return result;
    }

    private static void AddNodeIdByTransform(Transform root, Transform current, Dictionary<Transform, string> result)
    {
        string nodeId = BuildNodeId(root, current);
        if (!string.IsNullOrEmpty(nodeId) && !result.ContainsKey(current))
            result.Add(current, nodeId);
        foreach (Transform child in current)
            AddNodeIdByTransform(root, child, result);
    }

    private static string ResolveCloneNodeId(Transform root, Transform current, Dictionary<Transform, string> nodeIdByTransform)
    {
        if (nodeIdByTransform != null && current != null)
        {
            string nodeId;
            if (nodeIdByTransform.TryGetValue(current, out nodeId) && !string.IsNullOrEmpty(nodeId))
                return nodeId;
        }
        return BuildNodeId(root, current);
    }

    private static RectTransformRecord ToRectRecord(RectTransform rect)
    {
        Vector3 euler = rect.localEulerAngles;
        return new RectTransformRecord
        {
            anchorMin = Floats(rect.anchorMin.x, rect.anchorMin.y),
            anchorMax = Floats(rect.anchorMax.x, rect.anchorMax.y),
            pivot = Floats(rect.pivot.x, rect.pivot.y),
            anchoredPosition = Floats(rect.anchoredPosition.x, rect.anchoredPosition.y),
            sizeDelta = Floats(rect.sizeDelta.x, rect.sizeDelta.y),
            localScale = Floats(rect.localScale.x, rect.localScale.y, rect.localScale.z),
            localEulerAngles = Floats(euler.x, euler.y, euler.z)
        };
    }

    private static string DetectPrefabFramework(string prefabPath)
    {
        GameObject prefab = AssetDatabase.LoadAssetAtPath<GameObject>(prefabPath);
        return DetectFramework(prefab);
    }

    private static string DetectFramework(GameObject root)
    {
        if (root == null) return FrameworkUnknown;
        bool hasUgui = false;
        bool hasNgui = false;
        Component[] components = root.GetComponentsInChildren<Component>(true);
        for (int i = 0; i < components.Length; i++)
        {
            Component component = components[i];
            if (component == null) continue;
            if (IsUguiComponent(component)) hasUgui = true;
            if (IsNguiComponent(component)) hasNgui = true;
        }
        if (hasUgui && hasNgui) return FrameworkMixed;
        if (hasNgui) return FrameworkNGUI;
        if (hasUgui) return FrameworkUGUI;
        return FrameworkUnknown;
    }

    private static string DetectNodeFramework(GameObject go)
    {
        if (go == null) return FrameworkUnknown;
        bool hasUgui = false;
        bool hasNgui = false;
        Component[] components = go.GetComponents<Component>();
        for (int i = 0; i < components.Length; i++)
        {
            Component component = components[i];
            if (component == null) continue;
            if (IsUguiComponent(component)) hasUgui = true;
            if (IsNguiComponent(component)) hasNgui = true;
        }
        if (hasUgui && hasNgui) return FrameworkMixed;
        if (hasNgui) return FrameworkNGUI;
        if (hasUgui) return FrameworkUGUI;
        return FrameworkUnknown;
    }

    private static bool IsUguiComponent(Component component)
    {
        if (component == null) return false;
        return component is RectTransform ||
            component is Canvas ||
            component is CanvasScaler ||
            component is Graphic ||
            component is Selectable ||
            component is LayoutGroup ||
            component is LayoutElement ||
            component is ContentSizeFitter ||
            component is ScrollRect ||
            component is Mask ||
            component is RectMask2D;
    }

    private static bool IsTypeOrBaseName(Type type, string name)
    {
        for (Type current = type; current != null; current = current.BaseType)
            if (current.Name == name) return true;
        return false;
    }

    private static Component GetFirstComponentByTypeName(GameObject go, string typeName)
    {
        if (go == null || string.IsNullOrEmpty(typeName)) return null;
        Component[] components = go.GetComponents<Component>();
        for (int i = 0; i < components.Length; i++)
        {
            Component component = components[i];
            if (component == null) continue;
            if (IsTypeOrBaseName(component.GetType(), typeName)) return component;
        }
        return null;
    }

    private static GameObject FindLoadedScenePrefabInstance(SessionState session)
    {
        if (session == null || string.IsNullOrEmpty(session.sourcePrefabPath)) return null;
        string sourcePath = NormalizeAssetPath(session.sourcePrefabPath);
        if (string.IsNullOrEmpty(sourcePath)) return null;

        HashSet<int> seen = new HashSet<int>();
        for (int sceneIndex = 0; sceneIndex < SceneManager.sceneCount; sceneIndex++)
        {
            Scene scene = SceneManager.GetSceneAt(sceneIndex);
            if (!scene.IsValid() || !scene.isLoaded) continue;

            GameObject[] roots = scene.GetRootGameObjects();
            for (int i = 0; i < roots.Length; i++)
            {
                GameObject match = FindLoadedScenePrefabInstanceRecursive(roots[i], sourcePath, seen);
                if (match != null) return match;
            }
        }
        return null;
    }

    private static GameObject FindLoadedScenePrefabInstanceRecursive(GameObject current, string sourcePath, HashSet<int> seen)
    {
        if (current == null) return null;

        GameObject instanceRoot = null;
        try { instanceRoot = PrefabUtility.GetNearestPrefabInstanceRoot(current); }
        catch {}

        if (instanceRoot != null && !seen.Contains(instanceRoot.GetInstanceID()))
        {
            seen.Add(instanceRoot.GetInstanceID());
            string prefabPath = "";
            try { prefabPath = PrefabUtility.GetPrefabAssetPathOfNearestInstanceRoot(instanceRoot); }
            catch {}
            if (string.Equals(NormalizeAssetPath(prefabPath), sourcePath, StringComparison.OrdinalIgnoreCase))
                return instanceRoot;
        }

        Transform transform = current.transform;
        for (int i = 0; i < transform.childCount; i++)
        {
            GameObject match = FindLoadedScenePrefabInstanceRecursive(transform.GetChild(i).gameObject, sourcePath, seen);
            if (match != null) return match;
        }
        return null;
    }

    // instanceID 全局唯一，跨 session 不会误命中；这两个函数被深层序列化/patch 路径调用，
    // 不便透传 session，故按 instanceID 在所有活跃 session 字典里查找。
    private static object ReadReflectedProperty(object target, string propertyName)
    {
        if (target == null || string.IsNullOrEmpty(propertyName)) return null;
        Type type = target.GetType();
        PropertyInfo property = type.GetProperty(propertyName, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
        if (property != null && property.CanRead)
        {
            try { return property.GetValue(target, null); }
            catch { return null; }
        }
        FieldInfo field = type.GetField(propertyName, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
        if (field != null)
        {
            try { return field.GetValue(target); }
            catch { return null; }
        }
        return null;
    }

    private static bool SetReflectedProperty(object target, string propertyName, object value)
    {
        if (target == null || string.IsNullOrEmpty(propertyName)) return false;
        Type type = target.GetType();
        PropertyInfo property = type.GetProperty(propertyName, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
        if (property != null && property.CanWrite)
        {
            try
            {
                property.SetValue(target, ConvertReflectedValue(value, property.PropertyType), null);
                return true;
            }
            catch { return false; }
        }
        FieldInfo field = type.GetField(propertyName, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
        if (field != null)
        {
            try
            {
                field.SetValue(target, ConvertReflectedValue(value, field.FieldType));
                return true;
            }
            catch { return false; }
        }
        return false;
    }

    private static object ConvertReflectedValue(object value, Type targetType)
    {
        if (targetType == typeof(string)) return value != null ? value.ToString() : "";
        if (targetType == typeof(int)) return Mathf.RoundToInt(Convert.ToSingle(value, CultureInfo.InvariantCulture));
        if (targetType == typeof(float)) return Convert.ToSingle(value, CultureInfo.InvariantCulture);
        if (targetType == typeof(bool)) return value is bool ? value : Convert.ToBoolean(value, CultureInfo.InvariantCulture);
        if (targetType == typeof(Color) && value is Color) return value;
        if (targetType.IsEnum)
        {
            if (value is string)
            {
                try { return Enum.Parse(targetType, (string)value, true); }
                catch { return Enum.ToObject(targetType, 0); }
            }
            return Enum.ToObject(targetType, Mathf.RoundToInt(Convert.ToSingle(value, CultureInfo.InvariantCulture)));
        }
        return value;
    }

    private static bool SetReflectedEnum(object target, string propertyName, int intValue, string stringValue)
    {
        if (!string.IsNullOrEmpty(stringValue))
            return SetReflectedProperty(target, propertyName, stringValue);
        return SetReflectedProperty(target, propertyName, intValue);
    }

    private static bool InvokeReflectedMethod(object target, string methodName)
    {
        if (target == null || string.IsNullOrEmpty(methodName)) return false;
        MethodInfo method = null;
        for (Type type = target.GetType(); type != null && method == null; type = type.BaseType)
            method = type.GetMethod(methodName, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly);
        if (method == null || method.GetParameters().Length != 0) return false;
        try
        {
            method.Invoke(target, null);
            return true;
        }
        catch
        {
            return false;
        }
    }

    private static string ReadUnityObjectPath(object value)
    {
        UnityEngine.Object obj = value as UnityEngine.Object;
        return obj != null ? AssetDatabase.GetAssetPath(obj) : null;
    }

    private static string ReadReflectedString(object target, string propertyName, string fallback)
    {
        object value = ReadReflectedProperty(target, propertyName);
        return value != null ? value.ToString() : fallback;
    }

    private static int ReadReflectedInt(object target, string propertyName, int fallback)
    {
        object value = ReadReflectedProperty(target, propertyName);
        if (value == null) return fallback;
        try { return Convert.ToInt32(value, CultureInfo.InvariantCulture); }
        catch { return fallback; }
    }

    private static float ReadReflectedFloat(object target, string propertyName, float fallback)
    {
        object value = ReadReflectedProperty(target, propertyName);
        if (value == null) return fallback;
        try { return Convert.ToSingle(value, CultureInfo.InvariantCulture); }
        catch { return fallback; }
    }

    private static bool ReadReflectedBool(object target, string propertyName, bool fallback)
    {
        object value = ReadReflectedProperty(target, propertyName);
        if (value == null) return fallback;
        try { return Convert.ToBoolean(value, CultureInfo.InvariantCulture); }
        catch { return fallback; }
    }

    private static int ReadReflectedEnumInt(object target, string propertyName, int fallback)
    {
        object value = ReadReflectedProperty(target, propertyName);
        if (value == null) return fallback;
        try { return Convert.ToInt32(value, CultureInfo.InvariantCulture); }
        catch { return fallback; }
    }

    private static Vector2 ReadReflectedVector2(object target, string propertyName, Vector2 fallback)
    {
        object value = ReadReflectedProperty(target, propertyName);
        return value is Vector2 ? (Vector2)value : fallback;
    }

    private static Color ReadReflectedColor(object target, string propertyName, Color fallback)
    {
        object value = ReadReflectedProperty(target, propertyName);
        return value is Color ? (Color)value : fallback;
    }

    private static float[] Floats(params float[] values)
    {
        return values;
    }

    // nodeId 用「结构索引路径」：从 root 到当前节点逐层记录 sibling 序号，如 "si:0/3/1"。
    // 树结构天然唯一，且不依赖节点名字 —— 同名兄弟、空名节点都能区分；
    // 步骤2 已让 NGUI 不再重排 working root 子节点，故该索引在编辑期间稳定。
    private static string BuildNodeId(Transform root, Transform current)
    {
        return "si:" + GetStructuralIndexPath(root, current);
    }

    private static string GetStructuralIndexPath(Transform root, Transform target)
    {
        if (root == null || target == null) return null;
        if (target == root) return "";
        List<int> indices = new List<int>();
        Transform current = target;
        while (current != null && current != root)
        {
            indices.Add(current.GetSiblingIndex());
            current = current.parent;
        }
        // 若 target 不在 root 子树内，current 会走到 null —— 此时返回 null，调用方按未命中处理。
        if (current != root) return null;
        indices.Reverse();
        return string.Join("/", indices.ConvertAll(i => i.ToString(CultureInfo.InvariantCulture)).ToArray());
    }

    private static string GetSourceFileId(UnityEngine.Object obj)
    {
        if (obj == null) return null;
        UnityEngine.Object source = PrefabUtility.GetCorrespondingObjectFromSource(obj);
        if (source == null) source = obj;
        return GetPersistentFileId(source);
    }

    private static string GetPersistentFileId(UnityEngine.Object source)
    {
        if (source == null) return null;
        if (!EditorUtility.IsPersistent(source)) return null;
        var fileId = Unsupported.GetLocalIdentifierInFileForPersistentObject(source);
        if (fileId == 0) return null;
        return fileId.ToString(CultureInfo.InvariantCulture);
    }

    private static string GetTransformPath(Transform root, Transform target)
    {
        if (root == null || target == null) return null;
        List<string> names = new List<string>();
        Transform current = target;
        while (current != null)
        {
            names.Add(current.name);
            if (current == root) break;
            current = current.parent;
        }
        names.Reverse();
        return string.Join("/", names.ToArray());
    }

    private static string NormalizePrefabPath(string sourcePrefabPath)
    {
        string prefabPath = sourcePrefabPath.Replace("\\", "/").Trim();
        if (!prefabPath.StartsWith("Assets/", StringComparison.Ordinal))
            prefabPath = PrefabRoot + "/" + prefabPath.TrimStart('/');
        if (!prefabPath.EndsWith(".prefab", StringComparison.OrdinalIgnoreCase))
            prefabPath += ".prefab";
        return prefabPath;
    }

    private static string NormalizeAssetPath(string assetPath)
    {
        return (assetPath ?? "").Replace("\\", "/").Trim();
    }

    private static string SanitizeAssetName(string name)
    {
        string value = string.IsNullOrEmpty(name) ? "NewUI" : name.Trim();
        char[] invalid = Path.GetInvalidFileNameChars();
        for (int i = 0; i < invalid.Length; i++)
            value = value.Replace(invalid[i], '_');
        return string.IsNullOrEmpty(value) ? "NewUI" : value;
    }

    private static string UniqueChildName(Transform parent, string desiredName, Transform ignore = null)
    {
        string baseName = string.IsNullOrEmpty(desiredName) ? "Node_copy" : desiredName;
        string candidate = baseName;
        int suffix = 2;
        while (ChildNameExists(parent, candidate, ignore))
        {
            candidate = baseName + "_" + suffix.ToString(CultureInfo.InvariantCulture);
            suffix++;
        }
        return candidate;
    }

    private static bool ChildNameExists(Transform parent, string name, Transform ignore = null)
    {
        if (parent == null) return false;
        foreach (Transform child in parent)
            if (child != ignore && child.name == name)
                return true;
        return false;
    }

    private static void EnsureAssetFolder(string folder)
    {
        string normalized = folder.Replace("\\", "/").Trim('/');
        string[] parts = normalized.Split('/');
        if (parts.Length == 0 || parts[0] != "Assets") return;
        string current = "Assets";
        for (int i = 1; i < parts.Length; i++)
        {
            string next = current + "/" + parts[i];
            if (!AssetDatabase.IsValidFolder(next))
                AssetDatabase.CreateFolder(current, parts[i]);
            current = next;
        }
    }

    private static bool TryGetSession(string sessionId, out SessionState session)
    {
        session = null;
        if (string.IsNullOrEmpty(sessionId)) return false;
        return Sessions.TryGetValue(sessionId, out session);
    }

    private static string RevisionText(SessionState session)
    {
        return "r" + session.revision.ToString(CultureInfo.InvariantCulture);
    }

    private static SessionInfo ToSessionInfo(SessionState session)
    {
        return new SessionInfo
        {
            sessionId = session.sessionId,
            sourcePrefabPath = session.sourcePrefabPath,
            workingPrefabPath = session.workingPrefabPath,
            mode = session.mode,
            framework = string.IsNullOrEmpty(session.framework) ? FrameworkUnknown : session.framework,
            revision = RevisionText(session)
        };
    }

    private static string ReadAssetText(string assetPath)
    {
        string absolute = Path.Combine(ProjectRoot(), assetPath).Replace("\\", "/");
        return File.Exists(absolute) ? File.ReadAllText(absolute) : "";
    }

    private static void WriteAssetText(string assetPath, string content)
    {
        string absolute = Path.Combine(ProjectRoot(), assetPath).Replace("\\", "/");
        File.WriteAllText(absolute, content ?? "");
    }

    private static string ProjectRoot()
    {
        return Path.GetFullPath(Path.Combine(Application.dataPath, ".."));
    }

    private static T GetOrAddComponent<T>(GameObject go) where T : Component
    {
        T component = go.GetComponent<T>();
        return component != null ? component : go.AddComponent<T>();
    }

    private static bool ReadOptionalBoolProperty(object target, string propertyName)
    {
        if (target == null) return false;
        System.Reflection.PropertyInfo property = target.GetType().GetProperty(propertyName);
        if (property == null || property.PropertyType != typeof(bool)) return false;
        return (bool)property.GetValue(target, null);
    }

    private static void SetOptionalBoolProperty(object target, string propertyName, bool value)
    {
        if (target == null) return;
        System.Reflection.PropertyInfo property = target.GetType().GetProperty(propertyName);
        if (property == null || property.PropertyType != typeof(bool) || !property.CanWrite) return;
        property.SetValue(target, value, null);
    }

    private static void ApplyMaskType(GameObject go, string maskType)
    {
        Mask mask = go.GetComponent<Mask>();
        RectMask2D rectMask = go.GetComponent<RectMask2D>();
        if (string.Equals(maskType, "None", StringComparison.OrdinalIgnoreCase) || string.IsNullOrEmpty(maskType))
        {
            if (mask != null) mask.enabled = false;
            if (rectMask != null) rectMask.enabled = false;
            return;
        }
        if (string.Equals(maskType, "RectMask2D", StringComparison.OrdinalIgnoreCase))
        {
            if (mask != null) mask.enabled = false;
            GetOrAddComponent<RectMask2D>(go).enabled = true;
            return;
        }
        if (rectMask != null) rectMask.enabled = false;
        GetOrAddComponent<Mask>(go).enabled = true;
    }

    private static void ApplyLayoutGroupType(GameObject go, string layoutType)
    {
        HorizontalLayoutGroup horizontal = go.GetComponent<HorizontalLayoutGroup>();
        VerticalLayoutGroup vertical = go.GetComponent<VerticalLayoutGroup>();
        GridLayoutGroup grid = go.GetComponent<GridLayoutGroup>();
        if (horizontal != null) horizontal.enabled = false;
        if (vertical != null) vertical.enabled = false;
        if (grid != null) grid.enabled = false;

        if (string.Equals(layoutType, "Vertical", StringComparison.OrdinalIgnoreCase))
            GetOrAddComponent<VerticalLayoutGroup>(go).enabled = true;
        else if (string.Equals(layoutType, "Grid", StringComparison.OrdinalIgnoreCase))
            GetOrAddComponent<GridLayoutGroup>(go).enabled = true;
        else if (!string.Equals(layoutType, "None", StringComparison.OrdinalIgnoreCase) && !string.IsNullOrEmpty(layoutType))
            GetOrAddComponent<HorizontalLayoutGroup>(go).enabled = true;
    }

    private static bool ApplyHorizontalOrVerticalLayoutField(HorizontalOrVerticalLayoutGroup layout, VisualPatchOperation op)
    {
        if (layout == null) return false;
        if (op.field == "LayoutGroup.spacing") layout.spacing = ReadNumber(op, layout.spacing);
        else if (op.field == "LayoutGroup.childControlWidth") layout.childControlWidth = op.boolValue;
        else if (op.field == "LayoutGroup.childControlHeight") layout.childControlHeight = op.boolValue;
        else if (op.field == "LayoutGroup.childForceExpandWidth") layout.childForceExpandWidth = op.boolValue;
        else if (op.field == "LayoutGroup.childForceExpandHeight") layout.childForceExpandHeight = op.boolValue;
        else if (op.field == "LayoutGroup.reverseArrangement") SetOptionalBoolProperty(layout, "reverseArrangement", op.boolValue);
        else return false;
        return true;
    }

    private static bool ApplyGridLayoutField(GridLayoutGroup grid, VisualPatchOperation op)
    {
        if (grid == null) return false;
        if (op.field == "LayoutGroup.spacing") grid.spacing = new Vector2(ReadNumber(op, grid.spacing.x), grid.spacing.y);
        else if (op.field == "LayoutGroup.spacingY") grid.spacing = new Vector2(grid.spacing.x, ReadNumber(op, grid.spacing.y));
        else if (op.field == "GridLayoutGroup.cellSize") grid.cellSize = ReadVector2(op, grid.cellSize);
        else if (op.field == "GridLayoutGroup.startCorner") grid.startCorner = (GridLayoutGroup.Corner)Mathf.RoundToInt(ReadNumber(op, (int)grid.startCorner));
        else if (op.field == "GridLayoutGroup.startAxis") grid.startAxis = (GridLayoutGroup.Axis)Mathf.RoundToInt(ReadNumber(op, (int)grid.startAxis));
        else if (op.field == "GridLayoutGroup.constraint") grid.constraint = (GridLayoutGroup.Constraint)Mathf.RoundToInt(ReadNumber(op, (int)grid.constraint));
        else if (op.field == "GridLayoutGroup.constraintCount") grid.constraintCount = Mathf.RoundToInt(ReadNumber(op, grid.constraintCount));
        else return false;
        return true;
    }

    private static string ReadFieldAsString(Transform target, string field)
    {
        RectTransform rect = target as RectTransform;
        if (field == "GameObject.name") return target.gameObject.name;
        if (field == "activeSelf") return target.gameObject.activeSelf.ToString();
        if (field == "rectTransform.anchorMin" && rect != null) return Vector2Text(rect.anchorMin);
        if (field == "rectTransform.anchorMax" && rect != null) return Vector2Text(rect.anchorMax);
        if (field == "rectTransform.pivot" && rect != null) return Vector2Text(rect.pivot);
        if (field == "rectTransform.anchoredPosition" && rect != null) return Vector2Text(rect.anchoredPosition);
        if (field == "rectTransform.sizeDelta" && rect != null) return Vector2Text(rect.sizeDelta);
        if (field == "rectTransform.localScale" && rect != null) return Vector3Text(rect.localScale);
        if (field == "rectTransform.localEulerAngles.z" && rect != null) return rect.localEulerAngles.z.ToString(CultureInfo.InvariantCulture);
        if (rect == null && field.StartsWith("rectTransform.", StringComparison.Ordinal)) return ReadNguiTransformFieldAsString(target, field);
        Text text = target.GetComponent<Text>();
        if (field == "Text.text" && text != null) return text.text;
        if (field == "Text.fontSize" && text != null) return text.fontSize.ToString(CultureInfo.InvariantCulture);
        if (field == "Text.color" && text != null) return ColorToHex(text.color);
        if (field == "Text.font" && text != null) return text.font != null ? AssetDatabase.GetAssetPath(text.font) : "";
        if (field == "Text.fontStyle" && text != null) return ((int)text.fontStyle).ToString(CultureInfo.InvariantCulture);
        if (field == "Text.alignment" && text != null) return ((int)text.alignment).ToString(CultureInfo.InvariantCulture);
        if (field == "Text.richText" && text != null) return text.supportRichText.ToString();
        if (field == "Text.horizontalOverflow" && text != null) return ((int)text.horizontalOverflow).ToString(CultureInfo.InvariantCulture);
        if (field == "Text.verticalOverflow" && text != null) return ((int)text.verticalOverflow).ToString(CultureInfo.InvariantCulture);
        if (field == "Text.lineSpacing" && text != null) return text.lineSpacing.ToString(CultureInfo.InvariantCulture);
        if (field == "Text.bestFit" && text != null) return text.resizeTextForBestFit.ToString();
        if (field == "Text.bestFitMinSize" && text != null) return text.resizeTextMinSize.ToString(CultureInfo.InvariantCulture);
        if (field == "Text.bestFitMaxSize" && text != null) return text.resizeTextMaxSize.ToString(CultureInfo.InvariantCulture);
        if (field == "Text.raycastTarget" && text != null) return text.raycastTarget.ToString();
        Component nguiLabel = GetFirstComponentByTypeName(target.gameObject, "UILabel");
        if (nguiLabel != null && field.StartsWith("Text.", StringComparison.Ordinal)) return ReadNguiLabelFieldAsString(nguiLabel, field);
        Image image = target.GetComponent<Image>();
        if (field == "Image.enabled" && image != null) return image.enabled.ToString();
        if (field == "Image.color" && image != null) return ColorToHex(image.color);
        if (field == "Image.sprite" && image != null) return image.sprite != null ? AssetDatabase.GetAssetPath(image.sprite) : "";
        if (field == "Image.type" && image != null) return image.type.ToString();
        if (field == "Image.raycastTarget" && image != null) return image.raycastTarget.ToString();
        if (field == "Image.fillCenter" && image != null) return image.fillCenter.ToString();
        if (field == "Image.fillMethod" && image != null) return ((int)image.fillMethod).ToString(CultureInfo.InvariantCulture);
        if (field == "Image.fillOrigin" && image != null) return image.fillOrigin.ToString(CultureInfo.InvariantCulture);
        if (field == "Image.fillAmount" && image != null) return image.fillAmount.ToString(CultureInfo.InvariantCulture);
        if (field == "Image.fillClockwise" && image != null) return image.fillClockwise.ToString();
        if (field == "Image.useSpriteMesh" && image != null) return image.useSpriteMesh.ToString();
        if (field == "Image.preserveAspect" && image != null) return image.preserveAspect.ToString();
        Component nguiSprite = GetNguiSpriteComponent(target.gameObject);
        if (nguiSprite != null && field.StartsWith("Image.", StringComparison.Ordinal)) return ReadNguiSpriteFieldAsString(nguiSprite, field);
        Graphic graphic = target.GetComponent<Graphic>();
        if (field == "Graphic.alpha" && graphic != null) return graphic.color.a.ToString(CultureInfo.InvariantCulture);
        Component nguiWidget = GetNguiWidgetComponent(target.gameObject);
        if (field == "Graphic.alpha" && nguiWidget != null) return ReadReflectedFloat(nguiWidget, "alpha", 1f).ToString(CultureInfo.InvariantCulture);
        CanvasGroup canvasGroup = target.GetComponent<CanvasGroup>();
        if (field == "Graphic.alpha" && canvasGroup != null) return canvasGroup.alpha.ToString(CultureInfo.InvariantCulture);
        if (field == "Graphic.alpha") return "1";
        Button button = target.GetComponent<Button>();
        if (field == "Button.interactable" && button != null) return button.interactable.ToString();
        if (field == "Button.transition" && button != null) return ((int)button.transition).ToString(CultureInfo.InvariantCulture);
        if (field == "Button.colors.normalColor" && button != null) return ColorToHex(button.colors.normalColor);
        if (field == "Button.colors.highlightedColor" && button != null) return ColorToHex(button.colors.highlightedColor);
        if (field == "Button.colors.pressedColor" && button != null) return ColorToHex(button.colors.pressedColor);
        if (field == "Button.colors.disabledColor" && button != null) return ColorToHex(button.colors.disabledColor);
        if (field == "Button.colors.colorMultiplier" && button != null) return button.colors.colorMultiplier.ToString(CultureInfo.InvariantCulture);
        if (field == "Button.colors.fadeDuration" && button != null) return button.colors.fadeDuration.ToString(CultureInfo.InvariantCulture);
        Component nguiButton = GetFirstComponentByTypeName(target.gameObject, "UIButton");
        if (nguiButton != null && field.StartsWith("Button.", StringComparison.Ordinal)) return ReadNguiButtonFieldAsString(nguiButton, field);
        Outline outline = target.GetComponent<Outline>();
        if (field == "Outline.enabled" && outline != null) return outline.enabled.ToString();
        if (field == "Outline.color" && outline != null) return ColorToHex(outline.effectColor);
        if (field == "Outline.distance" && outline != null) return Vector2Text(outline.effectDistance);
        if (field == "Outline.useGraphicAlpha" && outline != null) return outline.useGraphicAlpha.ToString();
        Shadow shadow = target.GetComponent<Shadow>();
        if (field == "Shadow.enabled" && shadow != null) return shadow.enabled.ToString();
        if (field == "Shadow.color" && shadow != null) return ColorToHex(shadow.effectColor);
        if (field == "Shadow.distance" && shadow != null) return Vector2Text(shadow.effectDistance);
        if (field == "Shadow.useGraphicAlpha" && shadow != null) return shadow.useGraphicAlpha.ToString();
        Mask mask = target.GetComponent<Mask>();
        RectMask2D rectMask = target.GetComponent<RectMask2D>();
        if (field == "Mask.type") return rectMask != null && rectMask.enabled ? "RectMask2D" : (mask != null && mask.enabled ? "Mask" : "None");
        if (field == "Mask.showGraphic" && mask != null) return mask.showMaskGraphic.ToString();
        ScrollRect scrollRect = target.GetComponent<ScrollRect>();
        if (field == "ScrollRect.horizontal" && scrollRect != null) return scrollRect.horizontal.ToString();
        if (field == "ScrollRect.vertical" && scrollRect != null) return scrollRect.vertical.ToString();
        Toggle toggle = target.GetComponent<Toggle>();
        if (field == "Toggle.isOn" && toggle != null) return toggle.isOn.ToString();
        LayoutElement layoutElement = target.GetComponent<LayoutElement>();
        if (field == "LayoutElement.ignoreLayout" && layoutElement != null) return layoutElement.ignoreLayout.ToString();
        if (field == "LayoutElement.minWidth" && layoutElement != null) return layoutElement.minWidth.ToString(CultureInfo.InvariantCulture);
        if (field == "LayoutElement.minHeight" && layoutElement != null) return layoutElement.minHeight.ToString(CultureInfo.InvariantCulture);
        if (field == "LayoutElement.preferredWidth" && layoutElement != null) return layoutElement.preferredWidth.ToString(CultureInfo.InvariantCulture);
        if (field == "LayoutElement.preferredHeight" && layoutElement != null) return layoutElement.preferredHeight.ToString(CultureInfo.InvariantCulture);
        if (field == "LayoutElement.flexibleWidth" && layoutElement != null) return layoutElement.flexibleWidth.ToString(CultureInfo.InvariantCulture);
        if (field == "LayoutElement.flexibleHeight" && layoutElement != null) return layoutElement.flexibleHeight.ToString(CultureInfo.InvariantCulture);
        ContentSizeFitter fitter = target.GetComponent<ContentSizeFitter>();
        if (field == "ContentSizeFitter.enabled" && fitter != null) return fitter.enabled.ToString();
        if (field == "ContentSizeFitter.horizontalFit" && fitter != null) return ((int)fitter.horizontalFit).ToString(CultureInfo.InvariantCulture);
        if (field == "ContentSizeFitter.verticalFit" && fitter != null) return ((int)fitter.verticalFit).ToString(CultureInfo.InvariantCulture);
        return "";
    }

    private static Vector2 ReadVector2(VisualPatchOperation op, Vector2 fallback)
    {
        if (op.value != null && op.value.Length >= 2) return new Vector2(op.value[0], op.value[1]);
        return fallback;
    }

    private static Vector2 ApplyVector2(Vector2 current, VisualPatchOperation op)
    {
        Vector2 value = ReadVector2(op, Vector2.zero);
        return op.op == "delta" ? current + value : value;
    }

    private static Vector3 ApplyVector3(Vector3 current, VisualPatchOperation op)
    {
        if (op.value == null || op.value.Length == 0) return current;
        Vector3 value = new Vector3(op.value[0], op.value.Length > 1 ? op.value[1] : current.y, op.value.Length > 2 ? op.value[2] : current.z);
        return op.op == "delta" ? current + value : value;
    }

    private static float ReadNumber(VisualPatchOperation op, float fallback)
    {
        if (op.value != null && op.value.Length > 0) return op.value[0];
        return op != null ? op.numberValue : fallback;
    }

    private static Sprite LoadSprite(string assetPath)
    {
        if (string.IsNullOrEmpty(assetPath)) return null;
        Sprite sprite = AssetDatabase.LoadAssetAtPath<Sprite>(assetPath);
        if (sprite != null) return sprite;
        UnityEngine.Object[] objects = AssetDatabase.LoadAllAssetsAtPath(assetPath);
        for (int i = 0; i < objects.Length; i++)
        {
            sprite = objects[i] as Sprite;
            if (sprite != null) return sprite;
        }
        return null;
    }

    private static void NormalizeCollapsedRoot(GameObject instance, int width, int height)
    {
        RectTransform rect = instance != null ? instance.GetComponent<RectTransform>() : null;
        if (rect == null) return;

        bool scaleCollapsed = Mathf.Abs(rect.localScale.x) < 0.0001f || Mathf.Abs(rect.localScale.y) < 0.0001f;
        bool rectCollapsed =
            Mathf.Abs(rect.rect.width) < 0.0001f &&
            Mathf.Abs(rect.rect.height) < 0.0001f &&
            Mathf.Abs(rect.sizeDelta.x) < 0.0001f &&
            Mathf.Abs(rect.sizeDelta.y) < 0.0001f &&
            rect.childCount > 0;
        if (!scaleCollapsed && !rectCollapsed) return;

        rect.localScale = Vector3.one;
        rect.anchorMin = Vector2.zero;
        rect.anchorMax = Vector2.one;
        rect.pivot = new Vector2(0.5f, 0.5f);
        rect.anchoredPosition = Vector2.zero;
        rect.sizeDelta = Vector2.zero;
        rect.localRotation = Quaternion.identity;
    }

    private static void PrepareGraphicsForCapture(GameObject instance)
    {
        if (instance == null) return;
        Graphic[] graphics = instance.GetComponentsInChildren<Graphic>(true);
        for (int i = 0; i < graphics.Length; i++)
            if (graphics[i] != null) graphics[i].SetAllDirty();
    }

    private static void SetLayerRecursive(GameObject go, int layer)
    {
        if (go == null) return;
        go.layer = layer;
        foreach (Transform child in go.transform)
            SetLayerRecursive(child.gameObject, layer);
    }

    private static void DisableTransparentMeshCulling(GameObject go)
    {
        if (go == null) return;
        CanvasRenderer[] renderers = go.GetComponentsInChildren<CanvasRenderer>(true);
        for (int i = 0; i < renderers.Length; i++)
            renderers[i].cullTransparentMesh = false;
    }

    private static string Vector2Text(Vector2 value)
    {
        return value.x.ToString(CultureInfo.InvariantCulture) + "," + value.y.ToString(CultureInfo.InvariantCulture);
    }

    private static string Vector3Text(Vector3 value)
    {
        return value.x.ToString(CultureInfo.InvariantCulture) + "," + value.y.ToString(CultureInfo.InvariantCulture) + "," + value.z.ToString(CultureInfo.InvariantCulture);
    }

    private static string ColorToHex(Color color)
    {
        return string.Format(CultureInfo.InvariantCulture,
            "#{0:X2}{1:X2}{2:X2}{3:X2}",
            Mathf.Clamp(Mathf.RoundToInt(color.r * 255f), 0, 255),
            Mathf.Clamp(Mathf.RoundToInt(color.g * 255f), 0, 255),
            Mathf.Clamp(Mathf.RoundToInt(color.b * 255f), 0, 255),
            Mathf.Clamp(Mathf.RoundToInt(color.a * 255f), 0, 255));
    }

    private static Color ParseColor(string hex, Color fallback)
    {
        if (string.IsNullOrEmpty(hex)) return fallback;
        if (hex.StartsWith("#")) hex = hex.Substring(1);
        if (hex.Length < 6) return fallback;
        try
        {
            float r = int.Parse(hex.Substring(0, 2), NumberStyles.HexNumber) / 255f;
            float g = int.Parse(hex.Substring(2, 2), NumberStyles.HexNumber) / 255f;
            float b = int.Parse(hex.Substring(4, 2), NumberStyles.HexNumber) / 255f;
            float a = hex.Length >= 8 ? int.Parse(hex.Substring(6, 2), NumberStyles.HexNumber) / 255f : 1f;
            return new Color(r, g, b, a);
        }
        catch
        {
            return fallback;
        }
    }

    private static void ForceTextureAlphaOpaque(Texture2D texture)
    {
        if (texture == null) return;
        Color32[] pixels = texture.GetPixels32();
        for (int i = 0; i < pixels.Length; i++)
            pixels[i].a = 255;
        texture.SetPixels32(pixels);
        texture.Apply(false);
    }

    private class SessionState
    {
        public string sessionId;
        public string sourcePrefabPath;
        public string workingPrefabPath;
        public string mode;
        public string framework;
        public int revision;
        public int snapshotWidth;
        public int snapshotHeight;
        public float snapshotPixelsPerWorld;
        public string snapshotBackgroundColor;
        public string baselineYaml;
        public string lastValidationId;
        public bool lastValidationOk;
        public List<PatchChange> appliedChanges;
        public bool dirty;
        public GameObject workingRoot;
        public bool workingRootLoadedFromPrefabContents;
        public Scene previewScene;
        public bool hasPreviewScene;
        public bool memoryDirty;
        public bool isFlushing;
        public double lastEditTime;
        public double lastFlushTime;
        public List<GameObject> undoStack;
        public List<GameObject> redoStack;
        // NGUI 常驻隔离渲染：working root 在 session 私有 previewScene 内常开运行（NGUI [ExecuteInEditMode]
        // 实时构建 drawcall，drawcall 因 UIDrawCall 源码改动跟随 previewScene，不溢出主工程）。
        // nguiCamera 是挂在 previewScene 内的常驻离屏相机，截图与 bbox 投影共用它，保证同源对齐。
        public Camera nguiCamera;
        public readonly Dictionary<Transform, string> fileIdByTransform = new Dictionary<Transform, string>();
        public int fileIdMapRevision = -1;
        public int runtimeIdSeq;
    }

    private class BridgeTiming
    {
        private readonly bool _enabled;
        private readonly System.Diagnostics.Stopwatch _total;
        private readonly List<ProfileEntry> _entries;

        public BridgeTiming(bool enabled)
        {
            _enabled = enabled;
            _total = enabled ? System.Diagnostics.Stopwatch.StartNew() : null;
            _entries = enabled ? new List<ProfileEntry>() : null;
        }

        public void Measure(string name, Action action)
        {
            if (!_enabled)
            {
                action();
                return;
            }

            System.Diagnostics.Stopwatch stopwatch = System.Diagnostics.Stopwatch.StartNew();
            try
            {
                action();
            }
            finally
            {
                stopwatch.Stop();
                _entries.Add(new ProfileEntry { name = name, ms = (float)stopwatch.Elapsed.TotalMilliseconds });
            }
        }

        public T Measure<T>(string name, Func<T> action)
        {
            if (!_enabled) return action();

            System.Diagnostics.Stopwatch stopwatch = System.Diagnostics.Stopwatch.StartNew();
            try
            {
                return action();
            }
            finally
            {
                stopwatch.Stop();
                _entries.Add(new ProfileEntry { name = name, ms = (float)stopwatch.Elapsed.TotalMilliseconds });
            }
        }

        public OperationProfile Finish()
        {
            if (!_enabled) return null;
            _total.Stop();
            return new OperationProfile
            {
                totalMs = (float)_total.Elapsed.TotalMilliseconds,
                entries = _entries.ToArray()
            };
        }
    }

    [Serializable] private class BaseResponse { public bool ok; public ErrorInfo error; }
    [Serializable] public class ErrorInfo { public string code; public string message; }
    [Serializable] private class RuntimeCleanupResponse { public bool ok; public int sessionsBefore; public int sessionsAfter; public ErrorInfo error; }
    [Serializable] private class HealthResponse { public bool ok; public string name; public string version; public string loadId; public string loadedAtUtc; public string unityVersion; public string projectPath; public EditorStatus editor; public string[] capabilities; }
    [Serializable] public class EditorStatus { public bool isCompiling; public bool isUpdating; public bool isPlaying; public bool isPlayingOrWillChangePlaymode; public double timeSinceStartup; }
    [Serializable] private class CreateBlankRequest { public string name; public int width; public int height; public bool skipSnapshot; public bool profile; }
    [Serializable] private class ResumeSessionRequest { public string workingPrefabPath; public string sourcePrefabPath; public string selectedNodeId; }
    [Serializable] private class OpenPrefabRequest { public string prefabPath; public string mode; public string tempRoot; public int width; public int height; public string backgroundColor; }
    [Serializable] private class OpenPrefabResponse { public bool ok; public SessionInfo session; }
    [Serializable] public class SessionInfo { public string sessionId; public string sourcePrefabPath; public string workingPrefabPath; public string mode; public string framework; public string revision; }
    [Serializable] private class SessionRequest { public string sessionId; public bool skipSnapshot; public bool profile; }
    [Serializable] private class ArtboardStateResponse
    {
        public bool ok;
        public SessionInfo session;
        public string revision;
        public string rootNodeId;
        public NodeRecord[] nodes;
        public SnapshotRecord snapshot;
        public string selectedNodeId;
        public bool dirty;
        public bool undoAvailable;
        public bool redoAvailable;
        public ErrorInfo error;
        public OperationProfile profile;
    }
    [Serializable] public class OperationProfile { public float totalMs; public ProfileEntry[] entries; }
    [Serializable] public class ProfileEntry { public string name; public float ms; }
    [Serializable] private class ExportNodeTreeResponse { public bool ok; public string revision; public string rootNodeId; public NodeRecord[] nodes; }
    [Serializable] public class NodeRecord
    {
        public string nodeId;
        public string unityFileId;
        public string path;
        public string name;
        public string framework;
        public string parentId;
        public int siblingIndex;
        public string[] children;
        public bool activeSelf;
        public bool activeInHierarchy;
        public RectTransformRecord rectTransform;
        public ComponentRecord[] components;
        public string[] editableFields;
        public string[] protectedFields;
        public BboxRecord bbox;
    }
    [Serializable] public class RectTransformRecord { public float[] anchorMin; public float[] anchorMax; public float[] pivot; public float[] anchoredPosition; public float[] sizeDelta; public float[] localScale; public float[] localEulerAngles; }
    [Serializable] public class ComponentRecord { public string type; public bool enabled; public ComponentSummary summary; }
    [Serializable] public class ComponentSummary
    {
        public string text;
        public int fontSize;
        public string color;
        public string fontPath;
        public int fontStyle;
        public string alignment;
        public int alignmentValue;
        public bool richText;
        public int horizontalOverflow;
        public int verticalOverflow;
        public float lineSpacing;
        public bool bestFit;
        public int bestFitMinSize;
        public int bestFitMaxSize;
        public string sprite;
        public string spritePath;
        public string imageType;
        public bool enabled;
        public bool raycastTarget;
        public bool fillCenter;
        public int fillMethod;
        public int fillOrigin;
        public float fillAmount;
        public bool fillClockwise;
        public bool useSpriteMesh;
        public bool preserveAspect;
        public bool interactable;
        public int transition;
        public string normalColor;
        public string highlightedColor;
        public string pressedColor;
        public string disabledColor;
        public float colorMultiplier;
        public float fadeDuration;
        public float distanceX;
        public float distanceY;
        public bool useGraphicAlpha;
        public bool showMaskGraphic;
        public bool horizontal;
        public bool vertical;
        public bool isOn;
        public float alpha;
        public bool blocksRaycasts;
        public bool ignoreParentGroups;
        public bool ignoreLayout;
        public float minWidth;
        public float minHeight;
        public float preferredWidth;
        public float preferredHeight;
        public float flexibleWidth;
        public float flexibleHeight;
        public int horizontalFit;
        public int verticalFit;
        public string layoutType;
        public float spacing;
        public float spacingY;
        public float padLeft;
        public float padRight;
        public float padTop;
        public float padBottom;
        public int childAlignment;
        public bool childControlWidth;
        public bool childControlHeight;
        public bool childForceExpandWidth;
        public bool childForceExpandHeight;
        public bool reverseArrangement;
        public float cellSizeX;
        public float cellSizeY;
        public int startCorner;
        public int startAxis;
        public int constraint;
        public int constraintCount;
        public int widgetWidth;
        public int widgetHeight;
        public int depth;
        public float pivotX;
        public float pivotY;
        public string atlasPath;
        public string materialPath;
        public string texturePath;
        public string normalSprite;
        public string hoverSprite;
        public string pressedSprite;
        public string disabledSprite;
    }
    [Serializable] private class RenderSnapshotRequest { public string sessionId; public int width; public int height; public string backgroundColor; public string[] targetNodeIds; public bool includeBboxes; public string imageMode; public bool profile; }
    [Serializable] private class RenderSnapshotResponse { public bool ok; public string revision; public SnapshotRecord snapshot; public OperationProfile profile; }
    [Serializable] private class CaptureSceneGameViewResponse { public bool ok; public string cameraName; public bool cameraOrthographic; public float cameraOrthographicSize; public int width; public int height; public string url; public string path; }
    [Serializable] public class SnapshotRecord { public string snapshotId; public int width; public int height; public string coordinateSpace; public SnapshotImage image; public BboxRecord[] bboxes; public SnapshotViewport viewport; }
    [Serializable] public class SnapshotImage { public string format; public string mode; public string path; public string url; public string dataUrl; }
    [Serializable] public class SnapshotViewport { public float x; public float y; public float width; public float height; }
    [Serializable] public class BboxRecord { public string nodeId; public string path; public float x; public float y; public float width; public float height; public bool activeInHierarchy; public string space; public bool contributesToBounds; }
    [Serializable] private class ApplyPatchRequest { public string sessionId; public VisualPatch patch; public bool dryRun; public bool renderAfter; public int width; public int height; public string backgroundColor; public string imageMode; }
    [Serializable] public class VisualPatch { public string patchId; public string baseRevision; public VisualPatchOperation[] operations; }
    [Serializable] public class VisualPatchOperation { public string op; public string nodeId; public string field; public float[] value; public string stringValue; public bool boolValue; public float numberValue; public PatchSource source; }
    [Serializable] public class PatchSource { public string kind; public float[] screenDelta; }
    [Serializable] private class NodeRequest { public string sessionId; public string nodeId; public bool skipSnapshot; public bool profile; }
    [Serializable] private class MoveNodeRequest { public string sessionId; public string nodeId; public float x; public float y; public bool skipSnapshot; public bool profile; }
    [Serializable] private class ResizeNodeRequest { public string sessionId; public string nodeId; public float width; public float height; public bool skipSnapshot; public bool profile; }
    [Serializable] private class SetTextRequest { public string sessionId; public string nodeId; public string text; public bool skipSnapshot; public bool profile; }
    [Serializable] private class SetTextStyleRequest { public string sessionId; public string nodeId; public int fontSize; public string color; public string fontPath; public bool skipSnapshot; public bool profile; }
    [Serializable] private class SetImageRequest { public string sessionId; public string nodeId; public string spritePath; public bool skipSnapshot; public bool profile; }
    [Serializable] private class SetVisibleRequest { public string sessionId; public string nodeId; public bool visible; public bool skipSnapshot; public bool profile; }
    [Serializable] private class ReparentNodeRequest { public string sessionId; public string nodeId; public string parentId; public int index; public bool skipSnapshot; public bool profile; }
    [Serializable] private class InsertPrefabRequest { public string sessionId; public string prefabPath; public string parentId; public float x; public float y; public float width; public float height; public int index; public bool skipSnapshot; public bool profile; }
    [Serializable] private class CreateFrameNodeRequest { public string sessionId; public string parentId; public string name; public float x; public float y; public float width; public float height; public bool skipSnapshot; public bool profile; }
    [Serializable] private class CreateTextNodeRequest { public string sessionId; public string parentId; public string name; public string text; public float x; public float y; public float width; public float height; public int fontSize; public string color; public bool skipSnapshot; public bool profile; }
    [Serializable] private class CreateImageNodeRequest { public string sessionId; public string parentId; public string name; public string spritePath; public float x; public float y; public float width; public float height; public string color; public bool skipSnapshot; public bool profile; }
    [Serializable] private class CreateWidgetNodeRequest { public string sessionId; public string parentId; public string widgetType; public string name; public float x; public float y; public float width; public float height; public bool skipSnapshot; public bool profile; }
    [Serializable] private class DuplicateNodesRequest { public string sessionId; public string[] nodeIds; public float offsetX; public float offsetY; public bool skipSnapshot; public bool profile; }
    [Serializable] private class CopyNodesToSessionRequest { public string sourceSessionId; public string targetSessionId; public string[] nodeIds; public string targetParentId; public float offsetX; public float offsetY; public bool skipSnapshot; public bool profile; }
    [Serializable] private class GroupNodesRequest { public string sessionId; public string[] nodeIds; public string name; public bool skipSnapshot; public bool profile; }
    [Serializable] private class ApplyPatchResponse { public bool ok; public string revision; public PatchChange[] applied; public PatchReject[] rejected; public ProtectedDiffResult protectedDiff; public SnapshotRecord snapshot; }
    [Serializable] public class PatchChange { public string nodeId; public string field; public string before; public string after; }
    [Serializable] public class PatchReject { public string nodeId; public string field; public string reason; }
    [Serializable] private class ValidateDiffRequest { public string sessionId; public string baseRevision; public string currentRevision; public bool includeTextDiff; }
    [Serializable] private class ValidateDiffResponse { public bool ok; public string validationId; public DiffChange[] allowedChanges; public DiffChange[] protectedChanges; public DiffSummary summary; public ErrorInfo error; }
    [Serializable] public class ProtectedDiffResult { public bool ok; public string validationId; public DiffChange[] allowedChanges; public DiffChange[] protectedChanges; public DiffSummary summary; }
    [Serializable] public class DiffChange { public string nodeId; public string field; public string before; public string after; public int line; }
    [Serializable] public class DiffSummary { public int allowedCount; public int protectedCount; }
    [Serializable] private class SavePrefabRequest { public string sessionId; public string mode; public string validationId; public string note; }
    [Serializable] private class SavePrefabResponse { public bool ok; public string savedPath; public string sourcePrefabPath; public string revision; }
    [Serializable] private class SaveArtboardRequest { public string sessionId; public string targetPrefabPath; public string note; }
    [Serializable] private class SaveArtboardResponse { public bool ok; public string savedPath; public string sourcePrefabPath; public string workingPrefabPath; public string revision; public ProtectedDiffResult protectedDiff; public ErrorInfo error; }
    [Serializable] private class ClosePrefabRequest { public string sessionId; public bool deleteTempObjects; }
    private class CaptureRect { public float x; public float y; public float width; public float height; }

    private class BridgeRequestException : Exception
    {
        public readonly string Code;
        public BridgeRequestException(string code, string message) : base(message)
        {
            Code = code;
        }
    }
}

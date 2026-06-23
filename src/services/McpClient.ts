/**
 * 浏览器端 MCP 客户端
 * 直接连接用户本地的 Unity MCP 服务器，不经过 Vite 服务端
 */

const STORAGE_KEY = 'uieditor_new_mcp_url';
const DEFAULT_MCP_URL = 'https://127.0.0.1:8082/mcp';
const DIRECT_MCP_URL = 'http://127.0.0.1:8080/mcp';
const PROTOCOL_VERSION = '2025-03-26';

let sessionId: string | null = null;
let callId = 10;
/** 是否已降级到 HTTP（HTTPS 证书未信任时自动降级） */
let _fallbackToHttp = false;
/** 是否已降级到直连 MCP（CORS 代理完全不可用时绕过代理） */
let _directMcp = false;
/** 最近一次连接失败是否疑似证书问题 */
export let certIssueDetected = false;

type CertListener = (v: boolean) => void;
const _certListeners = new Set<CertListener>();
export function onCertIssueChange(fn: CertListener): () => void {
  _certListeners.add(fn);
  return () => _certListeners.delete(fn);
}
function setCertIssue(v: boolean) {
  if (certIssueDetected === v) return;
  certIssueDetected = v;
  _certListeners.forEach((fn) => fn(v));
}

/** 获取用户配置的 MCP 地址（含 HTTPS→HTTP→直连 自动降级） */
export function getMcpUrl(): string {
  if (_directMcp) return DIRECT_MCP_URL;
  const url = localStorage.getItem(STORAGE_KEY) || DEFAULT_MCP_URL;
  if (_fallbackToHttp && url.startsWith('https://')) {
    return url.replace('https://', 'http://');
  }
  return url;
}

/**
 * 从 SSE 流中读取第一个 data: 行，然后关闭流
 * MCP 返回 text/event-stream + chunked，res.text() 会卡住等流关闭
 */
async function readFirstDataLine(res: Response): Promise<string | null> {
  const reader = res.body?.getReader();
  if (!reader) {
    // fallback: 非流式响应
    const text = await res.text();
    const line = text.split('\n').find(l => l.startsWith('data: '));
    return line ? line.slice(6) : null;
  }

  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // 检查是否已收到完整的 data: 行
      const lines = buffer.split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          return line.slice(6);
        }
      }
    }
  } finally {
    reader.cancel();
  }

  return null;
}

/** 带超时的 fetch (避免 Unity 编译时请求 hang 住数十秒) */
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 底层 JSON-RPC 调用 */
async function rawCall(method: string, params: Record<string, any>): Promise<any> {
  const url = getMcpUrl();
  const id = ++callId;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;

  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  }, 1500);

  const data = await readFirstDataLine(res);
  if (!data) throw new Error(`MCP ${method}: 无响应数据`);

  const parsed = JSON.parse(data);
  if (parsed.error) throw new Error(`MCP ${method}: ${parsed.error.message}`);
  return parsed.result;
}

/** MCP 握手，获取 sessionId */
export async function initialize(): Promise<string> {
  // 已有 session 先 ping 验证
  if (sessionId) {
    try {
      await rawCall('ping', {});
      return sessionId;
    } catch {
      sessionId = null;
    }
  }

  // 每次重新握手都从 HTTPS 重试 (Unity 重启后 8082 可能恢复，避免锁死在降级路径)
  _fallbackToHttp = false;
  _directMcp = false;

  try {
    const sid = await doInitialize();
    setCertIssue(false);
    console.log('[McpClient] HTTPS 连接成功');
    return sid;
  } catch (err) {
    const url = localStorage.getItem(STORAGE_KEY) || DEFAULT_MCP_URL;
    if (!_fallbackToHttp && url.startsWith('https://')) {
      console.warn('[McpClient] HTTPS 连接失败，尝试 HTTP 降级...', (err as Error).message);
      _fallbackToHttp = true;
      setCertIssue(true);
      try {
        const sid = await doInitialize();
        console.log('[McpClient] HTTP 降级成功');
        return sid;
      } catch {
        _fallbackToHttp = false;
        _directMcp = true;
        console.warn('[McpClient] HTTP 降级失败，尝试直连 MCP (8080)...');
        try {
          const sid = await doInitialize();
          console.log('[McpClient] 已直连 MCP 服务器 (绕过 CORS 代理)');
          return sid;
        } catch {
          _directMcp = false;
          // 不清除 certIssue — HTTPS 失败可能是证书未信任，保留提示让用户操作
          console.warn('[McpClient] 所有连接方式均失败。请确认: 1) Unity Editor 已打开 2) MCP 插件已运行 3) 已信任 HTTPS 证书');
          throw err;
        }
      }
    }
    console.warn('[McpClient] 连接失败:', (err as Error).message);
    throw err;
  }
}

async function doInitialize(): Promise<string> {
  const url = getMcpUrl();
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'UIEditorNewBridge', version: '3.0' },
      },
    }),
  }, 1500);

  const sid = res.headers.get('mcp-session-id');
  if (!sid) throw new Error('MCP initialize 未返回 session-id');
  sessionId = sid;

  // HTTP 降级成功，说明本机开发可直连，清除证书告警
  if (_fallbackToHttp) setCertIssue(false);

  const data = await readFirstDataLine(res);
  if (data) {
    const result = JSON.parse(data);
    if (result.error) throw new Error(`MCP init error: ${result.error.message}`);
  }

  return sessionId;
}

/** 调用 MCP 工具 */
export async function callTool(toolName: string, args: Record<string, any>): Promise<any> {
  await initialize();
  return rawCall('tools/call', { name: toolName, arguments: args });
}

/** 心跳检测 — 已有 session 时只发轻量探测 (绕过完整握手回退链) */
export async function ping(): Promise<boolean> {
  // 快路径：已有 session，单次探测当前线路是否还活着
  if (sessionId) {
    try {
      const url = getMcpUrl();
      const res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          'Mcp-Session-Id': sessionId,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++callId, method: 'ping', params: {} }),
      }, 1500);
      // 服务端返回 4xx/5xx (含 session 失效 404) 视为断线，不触发回退链
      if (!res.ok) {
        sessionId = null;
        return false;
      }
      return true;
    } catch {
      sessionId = null;
      return false;
    }
  }
  // 慢路径：无 session，走完整握手 (含 HTTPS→HTTP→直连回退)
  try {
    await initialize();
    return true;
  } catch {
    return false;
  }
}

/** 重置 session（MCP 地址变更时调用） */
export function resetSession(): void {
  sessionId = null;
  callId = 10;
  _fallbackToHttp = false;
  _directMcp = false;
  setCertIssue(false);
}

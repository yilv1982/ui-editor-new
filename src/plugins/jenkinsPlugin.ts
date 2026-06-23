import type { Plugin } from 'vite';
import https from 'https';
import http from 'http';
import { URL } from 'url';

// ============ Jenkins 配置 ============
// Job 页面: http://192.160.28.22:8080/view/LOA-Dev-Tools/job/LOA-UIEditor/
const JENKINS_BASE = 'http://192.160.28.22:8080';
const JENKINS_JOB = 'LOA-UIEditor';
const JENKINS_USER = 'root';
const JENKINS_TOKEN = '11dd5806bf0d90892bd8461e67da5c4a85';
// 默认构建参数（可在前端 body 里覆盖）
const DEFAULT_PARAMS: Record<string, string> = {
  // branch: 'dev',
};
// =====================================

interface TriggerResult {
  ok: boolean;
  status?: number;
  queueUrl?: string;
  message?: string;
}

interface JenkinsResponse {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}

function jenkinsRequest(method: string, fullUrl: string, body?: string): Promise<JenkinsResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(fullUrl);
    const auth = 'Basic ' + Buffer.from(`${JENKINS_USER}:${JENKINS_TOKEN}`).toString('base64');
    const reqMod = u.protocol === 'https:' ? https : http;
    const headers: Record<string, string | number> = {
      'Authorization': auth,
    };
    if (body) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = reqMod.request({
      method,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers,
      rejectUnauthorized: false,
    }, (resp) => {
      let chunks = '';
      resp.on('data', (c) => { chunks += c.toString(); });
      resp.on('end', () => resolve({ status: resp.statusCode || 0, body: chunks, headers: resp.headers }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** 触发构建。无参数 → /build；有参数 → /buildWithParameters */
async function triggerJob(params: Record<string, string>): Promise<TriggerResult> {
  if (!JENKINS_BASE || !JENKINS_JOB) return { ok: false, message: 'Jenkins 未配置（JENKINS_BASE / JENKINS_JOB 为空）' };
  if (!JENKINS_USER || !JENKINS_TOKEN) return { ok: false, message: 'Jenkins 未配置（JENKINS_USER / JENKINS_TOKEN 为空）' };

  const allParams = { ...DEFAULT_PARAMS, ...params };
  const hasParams = Object.keys(allParams).length > 0;
  const endpoint = hasParams ? 'buildWithParameters' : 'build';
  const body = hasParams ? new URLSearchParams(allParams).toString() : '';
  const fullUrl = `${JENKINS_BASE.replace(/\/$/, '')}/job/${encodeURIComponent(JENKINS_JOB)}/${endpoint}`;
  try {
    const r = await jenkinsRequest('POST', fullUrl, body);
    if (r.status === 201 || r.status === 200) {
      return { ok: true, status: r.status, queueUrl: r.headers['location'] as string };
    }
    return { ok: false, status: r.status, message: r.body.slice(0, 500) || `Jenkins 返回 ${r.status}` };
  } catch (err: any) {
    return { ok: false, message: err.message || String(err) };
  }
}

type Phase = 'queued' | 'building' | 'success' | 'failure' | 'aborted' | 'unstable' | 'unknown';

interface BuildStatus {
  ok: boolean;
  phase: Phase;
  /** 队列阶段：Jenkins 队列项排队原因（"等待执行器"等） */
  queueWhy?: string;
  /** 队列分配到 build 之后的 build URL */
  buildUrl?: string;
  /** building 阶段：进度百分比 0-100 */
  progress?: number;
  /** 完成后：构建编号 + 结果 + 控制台 URL */
  number?: number;
  result?: string;
  message?: string;
}

/**
 * 查询 build 进度：
 *   - 给 queueUrl  → 看队列项是否分配 build，没分配返回 queued；分配了返回 building/...
 *   - 给 buildUrl  → 直接看 build 状态
 */
async function fetchBuildStatus(queueUrl?: string, buildUrl?: string): Promise<BuildStatus> {
  try {
    // Step 1: 用 queueUrl 拿 buildUrl
    if (!buildUrl && queueUrl) {
      const apiUrl = queueUrl.replace(/\/$/, '') + '/api/json';
      const r = await jenkinsRequest('GET', apiUrl);
      if (r.status === 404) {
        // 队列项已过期（Jenkins 默认 5 分钟），但 build 可能已经在跑或结束
        return { ok: false, phase: 'unknown', message: '队列项已过期，请直接刷新列表' };
      }
      if (r.status !== 200) return { ok: false, phase: 'unknown', message: `队列查询失败 ${r.status}` };
      const data = JSON.parse(r.body);
      if (data.executable && data.executable.url) {
        buildUrl = data.executable.url as string;
      } else {
        return { ok: true, phase: 'queued', queueWhy: data.why || '排队中' };
      }
    }

    if (!buildUrl) return { ok: false, phase: 'unknown', message: '缺少 queueUrl 或 buildUrl' };

    // Step 2: 看 build 状态
    const apiUrl = buildUrl.replace(/\/$/, '') + '/api/json';
    const r = await jenkinsRequest('GET', apiUrl);
    if (r.status !== 200) return { ok: false, phase: 'unknown', message: `build 查询失败 ${r.status}`, buildUrl };
    const data = JSON.parse(r.body);
    const number = data.number;

    if (data.building) {
      // 进度估算：Jenkins 给 timestamp + estimatedDuration
      const elapsed = Date.now() - (data.timestamp || Date.now());
      const est = data.estimatedDuration || 0;
      const progress = est > 0 ? Math.min(99, Math.round((elapsed / est) * 100)) : undefined;
      return { ok: true, phase: 'building', buildUrl, number, progress };
    }

    // 完成
    const result = (data.result || 'UNKNOWN') as string;
    const phase: Phase =
      result === 'SUCCESS' ? 'success'
      : result === 'ABORTED' ? 'aborted'
      : result === 'UNSTABLE' ? 'unstable'
      : 'failure';
    return { ok: true, phase, buildUrl, number, result };
  } catch (err: any) {
    return { ok: false, phase: 'unknown', message: err?.message || String(err) };
  }
}

export function jenkinsPlugin(): Plugin {
  return {
    name: 'uieditor-jenkins',
    configureServer(server) {
      // POST /api/jenkins/trigger  body: { params?: Record<string,string> }
      server.middlewares.use('/api/jenkins/trigger', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end(JSON.stringify({ error: 'POST only' }));
          return;
        }
        let raw = '';
        req.on('data', (c: Buffer) => { raw += c.toString(); });
        req.on('end', async () => {
          let params: Record<string, string> = {};
          try {
            const parsed = raw ? JSON.parse(raw) : {};
            if (parsed && typeof parsed.params === 'object' && parsed.params) {
              params = parsed.params;
            }
          } catch { /* 忽略 */ }
          const result = await triggerJob(params);
          res.setHeader('Content-Type', 'application/json');
          res.statusCode = result.ok ? 200 : 500;
          res.end(JSON.stringify(result));
        });
      });

      // GET /api/jenkins/build-status?queueUrl=... 或 ?buildUrl=...
      server.middlewares.use('/api/jenkins/build-status', async (req, res, next) => {
        if (req.method !== 'GET') return next();
        const u = new URL(req.url || '', 'http://x');
        const queueUrl = u.searchParams.get('queueUrl') || undefined;
        const buildUrl = u.searchParams.get('buildUrl') || undefined;
        if (!queueUrl && !buildUrl) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'queueUrl 或 buildUrl 必填' }));
          return;
        }
        const status = await fetchBuildStatus(queueUrl, buildUrl);
        res.setHeader('Content-Type', 'application/json');
        res.statusCode = status.ok ? 200 : 500;
        res.end(JSON.stringify(status));
      });

      // GET /api/jenkins/config-status — 给前端看是否已配置
      server.middlewares.use('/api/jenkins/config-status', (req, res, next) => {
        if (req.method !== 'GET') return next();
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          configured: !!(JENKINS_BASE && JENKINS_JOB && JENKINS_USER && JENKINS_TOKEN),
          base: JENKINS_BASE,
          job: JENKINS_JOB,
        }));
      });
    },
  };
}

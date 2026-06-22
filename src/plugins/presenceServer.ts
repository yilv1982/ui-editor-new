import type { Plugin } from 'vite';

// sessionId → 最后心跳时间戳
const sessions = new Map<string, number>();

// 心跳超时：超过 30s 未收到心跳视为离线
const TIMEOUT_MS = 30_000;

function pruneExpired(now: number) {
  for (const [id, last] of sessions) {
    if (now - last > TIMEOUT_MS) sessions.delete(id);
  }
}

export function presenceServerPlugin(): Plugin {
  return {
    name: 'uieditor-presence-server',
    configureServer(server) {
      // POST /api/presence/heartbeat  body: {"sessionId":"xxx"}
      server.middlewares.use('/api/presence/heartbeat', (req, res, next) => {
        if (req.method !== 'POST') return next();
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', () => {
          try {
            const { sessionId } = JSON.parse(body || '{}');
            if (typeof sessionId !== 'string' || !sessionId) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: 'invalid sessionId' }));
              return;
            }
            const now = Date.now();
            sessions.set(sessionId, now);
            pruneExpired(now);
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true, count: sessions.size }));
          } catch (e: any) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: e.message }));
          }
        });
      });

      // GET /api/presence/count
      server.middlewares.use('/api/presence/count', (req, res, next) => {
        if (req.method !== 'GET') return next();
        const now = Date.now();
        pruneExpired(now);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ count: sessions.size }));
      });

      // POST /api/presence/leave  body: {"sessionId":"xxx"}  —— 关闭页面时主动离线
      server.middlewares.use('/api/presence/leave', (req, res, next) => {
        if (req.method !== 'POST') return next();
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', () => {
          try {
            const { sessionId } = JSON.parse(body || '{}');
            if (typeof sessionId === 'string' && sessionId) sessions.delete(sessionId);
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true, count: sessions.size }));
          } catch {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: 'bad body' }));
          }
        });
      });
    },
  };
}

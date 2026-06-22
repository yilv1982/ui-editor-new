import type { Plugin } from 'vite';
import fs from 'fs';
import path from 'path';
import os from 'os';

const SAVES_DIR = path.join(os.homedir(), '.uieditor', 'saves');

function ensureDir() {
  if (!fs.existsSync(SAVES_DIR)) fs.mkdirSync(SAVES_DIR, { recursive: true });
}

// 仅允许字母数字、中文、下划线、连字符、点、括号、空格
function isValidSlotName(name: string): boolean {
  return /^[\w一-龥\-. ()　]{1,128}$/.test(name);
}

function slotPath(slot: string): string {
  return path.join(SAVES_DIR, `${slot}.json`);
}

export function saveServerPlugin(): Plugin {
  return {
    name: 'uieditor-save-server',
    configureServer(server) {
      ensureDir();

      // GET /api/saves — 列出所有存档名
      server.middlewares.use('/api/saves', (req, res, next) => {
        if (req.method !== 'GET' || req.url !== '/') return next();
        try {
          ensureDir();
          const files = fs.readdirSync(SAVES_DIR)
            .filter((f) => f.endsWith('.json'))
            .map((f) => f.replace(/\.json$/, ''));
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ slots: files, dir: SAVES_DIR }));
        } catch (e: any) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: e.message }));
        }
      });

      // /api/save/:slot — GET 读、POST 写、DELETE 删
      server.middlewares.use('/api/save/', (req, res) => {
        const slot = decodeURIComponent((req.url || '').replace(/^\/+/, '').split('?')[0]);
        if (!slot || !isValidSlotName(slot)) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'invalid slot name' }));
          return;
        }
        ensureDir();
        const fp = slotPath(slot);

        if (req.method === 'GET') {
          if (!fs.existsSync(fp)) {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: 'not found' }));
            return;
          }
          res.setHeader('Content-Type', 'application/json');
          fs.createReadStream(fp).pipe(res);
          return;
        }

        if (req.method === 'POST' || req.method === 'PUT') {
          let body = '';
          req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
          req.on('end', () => {
            try {
              // 验证 JSON 合法
              JSON.parse(body);
              fs.writeFileSync(fp, body);
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ ok: true, path: fp }));
            } catch (e: any) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: 'invalid json: ' + e.message }));
            }
          });
          return;
        }

        if (req.method === 'DELETE') {
          if (fs.existsSync(fp)) fs.unlinkSync(fp);
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        res.statusCode = 405;
        res.end(JSON.stringify({ error: 'method not allowed' }));
      });
    },
  };
}

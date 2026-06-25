import type { Plugin } from 'vite';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

const WORKSPACES_DIR = path.join(os.homedir(), '.uieditor', 'workspaces');
const DEFAULT_WORKSPACE_FILE = path.join(WORKSPACES_DIR, 'machine-default.json');

function ensureDir() {
  if (!fs.existsSync(WORKSPACES_DIR)) fs.mkdirSync(WORKSPACES_DIR, { recursive: true });
}

function isValidWorkspaceId(value: string): boolean {
  return /^[A-Za-z0-9_-]{6,80}$/.test(value);
}

function createWorkspaceId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}

function workspacePath(workspaceId: string): string {
  return path.join(WORKSPACES_DIR, `${workspaceId}.json`);
}

function readMachineDefaultWorkspaceId(): string {
  ensureDir();
  try {
    const data = JSON.parse(fs.readFileSync(DEFAULT_WORKSPACE_FILE, 'utf8'));
    if (typeof data?.workspaceId === 'string' && isValidWorkspaceId(data.workspaceId)) {
      return data.workspaceId;
    }
  } catch {
    // Missing or invalid default is repaired below.
  }

  const workspaceId = createWorkspaceId();
  fs.writeFileSync(DEFAULT_WORKSPACE_FILE, JSON.stringify({
    workspaceId,
    createdAt: new Date().toISOString(),
  }, null, 2));
  return workspaceId;
}

function sendJson(res: any, statusCode: number, body: unknown) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function workspaceIdFromUrl(url: string | undefined): string | null {
  const value = decodeURIComponent((url || '').replace(/^\/+/, '').split('?')[0]);
  return isValidWorkspaceId(value) ? value : null;
}

export function workspaceServerPlugin(): Plugin {
  return {
    name: 'uieditor-workspace-server',
    apply: 'serve',
    transformIndexHtml(html) {
      const workspaceId = readMachineDefaultWorkspaceId();
      return html.replace(
        '</head>',
        `<script>window.__UIEDITOR_DEFAULT_WORKSPACE_ID__=${JSON.stringify(workspaceId)};</script></head>`,
      );
    },
    configureServer(server) {
      ensureDir();

      server.middlewares.use('/api/workspace/default', (req, res, next) => {
        if (req.method !== 'GET') return next();
        sendJson(res, 200, { ok: true, workspaceId: readMachineDefaultWorkspaceId(), dir: WORKSPACES_DIR });
      });

      server.middlewares.use('/api/workspaces/', (req, res) => {
        const workspaceId = workspaceIdFromUrl(req.url);
        if (!workspaceId) {
          sendJson(res, 400, { ok: false, error: 'invalid workspace id' });
          return;
        }

        ensureDir();
        const filePath = workspacePath(workspaceId);

        if (req.method === 'GET') {
          if (!fs.existsSync(filePath)) {
            sendJson(res, 404, { ok: false, error: 'not found' });
            return;
          }
          res.setHeader('Content-Type', 'application/json');
          fs.createReadStream(filePath).pipe(res);
          return;
        }

        if (req.method === 'POST' || req.method === 'PUT') {
          let body = '';
          req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
          req.on('end', () => {
            try {
              const data = JSON.parse(body);
              fs.writeFileSync(filePath, JSON.stringify({ ...data, workspaceId }, null, 2));
              sendJson(res, 200, { ok: true, workspaceId, path: filePath });
            } catch (e: any) {
              sendJson(res, 400, { ok: false, error: `invalid json: ${e.message}` });
            }
          });
          return;
        }

        if (req.method === 'DELETE') {
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
          sendJson(res, 200, { ok: true, workspaceId });
          return;
        }

        sendJson(res, 405, { ok: false, error: 'method not allowed' });
      });
    },
  };
}

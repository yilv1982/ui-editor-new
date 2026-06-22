import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin, ViteDevServer } from 'vite';

interface DebugCommand {
  id: number;
  command: string;
  args?: unknown;
  targetClientId?: string;
  createdAt: string;
  deliveredAt?: string;
  deliveredTo?: string;
}

interface DebugResult {
  id?: number;
  command?: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  clientId?: string;
  createdAt: string;
}

interface DebugReport {
  id: number;
  kind: string;
  payload: unknown;
  clientId?: string;
  createdAt: string;
}

const commands: DebugCommand[] = [];
const results: DebugResult[] = [];
const reports: DebugReport[] = [];
let nextCommandId = 1;
let nextReportId = 1;
const MAX_ITEMS = 50;

function trim<T>(list: T[]) {
  while (list.length > MAX_ITEMS) list.shift();
}

function sendJson(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache',
  });
  res.end(JSON.stringify(data));
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
      if (body.length > 5 * 1024 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

export function debugServerPlugin(): Plugin {
  return {
    name: 'uieditor-debug-server',
    configureServer(server: ViteDevServer) {
      server.middlewares.use('/api/uieditor-debug/status', (req, res) => {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'Method not allowed' });
          return;
        }
        sendJson(res, 200, {
          queued: commands.filter((cmd) => !cmd.deliveredAt).length,
          commands,
          lastReport: reports[reports.length - 1] ?? null,
          lastResult: results[results.length - 1] ?? null,
          reports,
          results,
        });
      });

      server.middlewares.use('/api/uieditor-debug/command', async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'Method not allowed' });
          return;
        }
        try {
          const body = asRecord(await readJson(req));
          const command = typeof body.command === 'string' ? body.command : '';
          if (!command) {
            sendJson(res, 400, { error: 'Missing command' });
            return;
          }
          const item: DebugCommand = {
            id: nextCommandId++,
            command,
            args: body.args,
            targetClientId: typeof body.targetClientId === 'string'
              ? body.targetClientId
              : typeof body.clientId === 'string'
                ? body.clientId
                : undefined,
            createdAt: new Date().toISOString(),
          };
          commands.push(item);
          trim(commands);
          sendJson(res, 200, item);
        } catch (err: unknown) {
          sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
      });

      server.middlewares.use('/api/uieditor-debug/commands', (req, res) => {
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: 'Method not allowed' });
          return;
        }
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const clientId = url.searchParams.get('clientId') ?? '';
        const now = new Date().toISOString();
        const pending = commands.filter((cmd) =>
          !cmd.deliveredAt && (!cmd.targetClientId || cmd.targetClientId === clientId)
        );
        for (const cmd of pending) {
          cmd.deliveredAt = now;
          cmd.deliveredTo = clientId || undefined;
        }
        sendJson(res, 200, { commands: pending });
      });

      server.middlewares.use('/api/uieditor-debug/result', async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'Method not allowed' });
          return;
        }
        try {
          const body = asRecord(await readJson(req));
          const item: DebugResult = {
            id: typeof body.id === 'number' ? body.id : undefined,
            command: typeof body.command === 'string' ? body.command : undefined,
            ok: body.ok === true,
            result: body.result,
            error: typeof body.error === 'string' ? body.error : undefined,
            clientId: typeof body.clientId === 'string' ? body.clientId : undefined,
            createdAt: new Date().toISOString(),
          };
          results.push(item);
          trim(results);
          sendJson(res, 200, { ok: true });
        } catch (err: unknown) {
          sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
      });

      server.middlewares.use('/api/uieditor-debug/report', async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'Method not allowed' });
          return;
        }
        try {
          const body = asRecord(await readJson(req));
          const item: DebugReport = {
            id: nextReportId++,
            kind: typeof body.kind === 'string' ? body.kind : 'runtime',
            payload: body.payload,
            clientId: typeof body.clientId === 'string' ? body.clientId : undefined,
            createdAt: new Date().toISOString(),
          };
          reports.push(item);
          trim(reports);
          sendJson(res, 200, { ok: true, id: item.id });
        } catch (err: unknown) {
          sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
      });

      server.middlewares.use('/api/uieditor-debug/reset', (_req, res) => {
        commands.length = 0;
        results.length = 0;
        reports.length = 0;
        sendJson(res, 200, { ok: true });
      });

      console.log('[uieditor-debug] Runtime debug command bridge loaded');
    },
  };
}

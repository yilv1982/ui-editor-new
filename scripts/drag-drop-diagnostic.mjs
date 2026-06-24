import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm, mkdir } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const URL = 'http://127.0.0.1:4105/';
const BRIDGE_URL = 'http://127.0.0.1:18082';
const DRAG_SEARCH = process.env.DRAG_SEARCH || 'UIBlueBtn';
const PANEL_NAME = process.env.DRAG_PANEL || '项目UI';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    path.join(process.env.ProgramFiles ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['ProgramFiles(x86)'] ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.ProgramFiles ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env['ProgramFiles(x86)'] ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].filter(Boolean);
  const found = candidates.find((item) => existsSync(item));
  if (!found) throw new Error('Cannot find Chrome/Edge. Set CHROME_PATH.');
  return found;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

async function waitForJson(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
      lastError = new Error(`${res.status} ${res.statusText}`);
    } catch (err) {
      lastError = err;
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError?.message ?? 'no response'}`);
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', (event) => reject(new Error(`CDP websocket error: ${event.message ?? 'unknown'}`)));
      this.ws.addEventListener('message', (event) => {
        const msg = JSON.parse(event.data);
        if (!msg.id) return;
        const item = this.pending.get(msg.id);
        if (!item) return;
        this.pending.delete(msg.id);
        clearTimeout(item.timer);
        if (msg.error) item.reject(new Error(`${msg.error.message}: ${msg.error.data ?? ''}`));
        else item.resolve(msg.result);
      });
    });
  }

  send(method, params = {}, timeoutMs = 30000) {
    const id = this.nextId;
    this.nextId += 1;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  close() {
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error('CDP client closed'));
    }
    this.pending.clear();
    try { this.ws?.close(); } catch {}
  }
}

async function evaluate(cdp, expression, timeoutMs = 30000) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    timeout: timeoutMs,
  }, Math.max(5000, timeoutMs + 5000));
  if (result.exceptionDetails) {
    const text = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
    throw new Error(text);
  }
  return result.result?.value;
}

async function waitForExpression(cdp, expression, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await evaluate(cdp, expression, 2500).catch(() => false);
    if (ok) return true;
    await sleep(200);
  }
  throw new Error(`Timed out waiting for expression: ${expression}`);
}

async function createPageTarget(port, url = 'about:blank') {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!res.ok) throw new Error(`Failed to create CDP target: ${res.status} ${res.statusText}`);
  return await res.json();
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try { child.kill(); } catch {}
  await sleep(500);
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.once('close', resolve);
      killer.once('error', resolve);
    });
  }
}

async function main() {
  const bridgeHealth = await (await fetch(`${BRIDGE_URL}/health`)).json();
  if (bridgeHealth.name !== 'UIEditorNewBridge') throw new Error('Bridge is not healthy.');
  const chrome = findChrome();
  const port = await getFreePort();
  const profile = path.join(os.tmpdir(), `uieditor-drag-diagnostic-${process.pid}-${Date.now()}`);
  await rm(profile, { recursive: true, force: true });
  await mkdir(profile, { recursive: true });

  const chromeProc = spawn(chrome, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--window-size=1600,950',
    '--force-device-scale-factor=1',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--no-first-run',
    '--no-default-browser-check',
    '--headless=new',
  ], { stdio: 'ignore', windowsHide: true });

  let cdp;
  try {
    await waitForJson(`http://127.0.0.1:${port}/json/version`);
    const target = await createPageTarget(port, URL);
    cdp = new CdpClient(target.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        window.__dragDiag = { fetches: [], alerts: [], errors: [] };
        const oldFetch = window.fetch;
        window.fetch = async (...args) => {
          const url = String(args[0]);
          const started = performance.now();
          try {
            const res = await oldFetch(...args);
            if (url.includes('18082')) window.__dragDiag.fetches.push({ url, status: res.status, ms: Math.round(performance.now() - started) });
            return res;
          } catch (err) {
            if (url.includes('18082')) window.__dragDiag.fetches.push({ url, error: String(err), ms: Math.round(performance.now() - started) });
            throw err;
          }
        };
        window.alert = (message) => { window.__dragDiag.alerts.push(String(message)); };
        window.onerror = (...args) => { window.__dragDiag.errors.push(args.map(String).join(' | ')); };
        try {
          localStorage.removeItem('uieditor_new_remote_artboards_v1');
          localStorage.removeItem('uieditor_new_bridge_workspace_v1');
          localStorage.removeItem('uieditor_save__autosave');
        } catch {}
      `,
    });
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1600,
      height: 950,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.send('Page.navigate', { url: URL });
    await waitForExpression(cdp, 'document.readyState === "complete" || document.readyState === "interactive"', 20000);
    await waitForExpression(cdp, '!!document.querySelector("[data-testid=\\"layer-artboard-row\\"]")', 30000);
    await waitForExpression(cdp, `(() => {
      const row = document.querySelector('[data-testid="layer-artboard-row"][data-active="true"]');
      return !!row?.dataset.bridgeSessionId && !!row?.dataset.workingPrefabPath;
    })()`, 120000);

    const result = await evaluate(cdp, `(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const setInput = (input, value) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const waitUntil = async (predicate, timeoutMs = 30000) => {
        const deadline = Date.now() + timeoutMs;
        let value;
        while (Date.now() < deadline) {
          value = predicate();
          if (value) return value;
          await sleep(150);
        }
        return null;
      };
      const rows = () => [...document.querySelectorAll('[data-testid="layer-artboard-row"]')].map((row) => ({
        id: row.dataset.artboardId || '',
        active: row.dataset.active === 'true',
        count: Number((row.textContent || '').match(/(\\d+)\\s*$/)?.[1] || 0),
        text: row.textContent || '',
        session: row.dataset.bridgeSessionId || '',
        working: row.dataset.workingPrefabPath || '',
      }));
      const dragSources = () => [...document.querySelectorAll('div')]
        .filter((el) => (el.textContent || '').includes(${JSON.stringify(DRAG_SEARCH)}) && el.querySelector('img'))
        .map((el) => ({ el, rect: el.getBoundingClientRect(), text: el.textContent || '' }))
        .filter((item) => item.rect.width > 10 && item.rect.height > 10)
        .sort((a, b) => (a.rect.width * a.rect.height) - (b.rect.width * b.rect.height));
      const dropAt = async (sourceEl, x, y) => {
        const sr = sourceEl.getBoundingClientRect();
        const sx = sr.left + Math.min(20, Math.max(4, sr.width / 2));
        const sy = sr.top + Math.min(10, Math.max(4, sr.height / 2));
        sourceEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: sx, clientY: sy, button: 0, buttons: 1 }));
        await sleep(30);
        document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: sx + 20, clientY: sy + 20, button: 0, buttons: 1 }));
        await sleep(30);
        document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1 }));
        await sleep(30);
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 0 }));
      };
      const projectUiButton = [...document.querySelectorAll('button')].find((button) => (button.textContent || '').trim() === ${JSON.stringify(PANEL_NAME)});
      projectUiButton?.click();
      const input = await waitUntil(() => document.querySelector('input[placeholder="搜索预制体..."], input[placeholder="搜索组件..."]'));
      if (!input) throw new Error('missing search input');
      setInput(input, ${JSON.stringify(DRAG_SEARCH)});
      await sleep(1000);
      const sourceInfo = dragSources()[0];
      if (!sourceInfo) throw new Error('missing drag source: ' + ${JSON.stringify(DRAG_SEARCH)});
      const canvas = document.querySelector('[data-canvas-container]');
      const artboardRow = document.querySelector('[data-testid="layer-artboard-row"][data-active="true"]');
      if (!canvas || !artboardRow) throw new Error('missing canvas or artboard row');
      const canvasRect = canvas.getBoundingClientRect();
      const rowRect = artboardRow.getBoundingClientRect();
      const canvasDrops = [
        { name: 'canvas-center', x: canvasRect.left + canvasRect.width / 2, y: canvasRect.top + canvasRect.height / 2 },
        { name: 'canvas-offset', x: canvasRect.left + canvasRect.width / 2 + 120, y: canvasRect.top + canvasRect.height / 2 + 60 },
        { name: 'artboard-row', x: rowRect.left + rowRect.width / 2, y: rowRect.top + rowRect.height / 2 },
      ];
      const attempts = [];
      for (const drop of canvasDrops) {
        const before = rows();
        const fetchStart = window.__dragDiag.fetches.length;
        await dropAt(sourceInfo.el, drop.x, drop.y);
        await sleep(6000);
        attempts.push({
          drop,
          before,
          after: rows(),
          fetches: window.__dragDiag.fetches.slice(fetchStart),
          elementAtDrop: document.elementFromPoint(drop.x, drop.y)?.outerHTML?.slice(0, 300) || '',
        });
      }
      const sessionId = rows()[0]?.session;
      if (sessionId) {
        await fetch('http://127.0.0.1:18082/close-prefab', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, deleteTempObjects: true }),
        }).catch(() => undefined);
      }
      return {
        source: {
          text: sourceInfo.text,
          rect: { left: sourceInfo.rect.left, top: sourceInfo.rect.top, width: sourceInfo.rect.width, height: sourceInfo.rect.height },
        },
        canvasRect: { left: canvasRect.left, top: canvasRect.top, width: canvasRect.width, height: canvasRect.height },
        rowRect: { left: rowRect.left, top: rowRect.top, width: rowRect.width, height: rowRect.height },
        attempts,
        diag: window.__dragDiag,
      };
    })()`, 90000);

    console.log(JSON.stringify(result, null, 2));
  } finally {
    cdp?.close();
    await stopProcess(chromeProc);
    await rm(profile, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

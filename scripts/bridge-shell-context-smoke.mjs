import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const args = {
    url: 'http://127.0.0.1:4105/',
    bridgeUrl: 'http://127.0.0.1:8082',
    out: path.join(ROOT, '.cache', 'bridge-shell-context-smoke', 'latest'),
    viewportWidth: 1400,
    viewportHeight: 900,
    headed: false,
    keepOpen: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const next = argv[i + 1];
    if (key === '--headed') args.headed = true;
    else if (key === '--keep-open') args.keepOpen = true;
    else if (key === '--url') { args.url = next; i += 1; }
    else if (key === '--bridge-url') { args.bridgeUrl = next; i += 1; }
    else if (key === '--out') { args.out = path.resolve(next); i += 1; }
    else if (key === '--viewport-width') { args.viewportWidth = Number(next); i += 1; }
    else if (key === '--viewport-height') { args.viewportHeight = Number(next); i += 1; }
  }
  return args;
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
  if (!found) throw new Error('Cannot find Chrome/Edge. Set CHROME_PATH to a Chromium executable.');
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBaseUrl(value) {
  return value.replace(/\/+$/, '');
}

async function assertHttpOk(url, label) {
  let res;
  try {
    res = await fetch(url, { cache: 'no-store' });
  } catch (err) {
    throw new Error(`${label} is not reachable at ${url}: ${err.message}`);
  }
  if (!res.ok) throw new Error(`${label} returned ${res.status} ${res.statusText}: ${url}`);
  return res;
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
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError?.message ?? 'no response'}`);
}

async function stopProcess(child, timeoutMs = 2500) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  let closed = false;
  const closePromise = new Promise((resolve) => {
    child.once('close', () => {
      closed = true;
      resolve();
    });
  });
  try { child.kill(); } catch {}
  await Promise.race([closePromise, sleep(timeoutMs)]);
  if (closed || !child.pid) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.once('close', resolve);
      killer.once('error', resolve);
    });
  } else {
    try { child.kill('SIGKILL'); } catch {}
  }
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
      this.ws.addEventListener('close', () => {
        for (const item of this.pending.values()) {
          clearTimeout(item.timer);
          item.reject(new Error('CDP websocket closed'));
        }
        this.pending.clear();
      });
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
        if (!this.pending.has(id)) return;
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

async function waitForExpression(cdp, expression, timeoutMs = 30000, evalTimeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    const remaining = Math.max(500, deadline - Date.now());
    const ok = await evaluate(cdp, expression, Math.min(evalTimeoutMs, remaining)).catch((err) => {
      lastError = err;
      return false;
    });
    if (ok) return true;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for expression: ${expression}${lastError ? ` (${lastError.message})` : ''}`);
}

async function createPageTarget(port, url = 'about:blank') {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!res.ok) throw new Error(`Cannot create CDP target: ${res.status} ${await res.text()}`);
  return await res.json();
}

async function screenshot(cdp, filePath) {
  const image = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    fromSurface: true,
  });
  await writeFile(filePath, Buffer.from(image.data, 'base64'));
  return filePath;
}

function projectAssetExists(projectPath, assetPath) {
  if (!projectPath || !assetPath) return false;
  return existsSync(path.join(projectPath, assetPath));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await mkdir(args.out, { recursive: true });

  const bridgeHealth = await (await assertHttpOk(`${normalizeBaseUrl(args.bridgeUrl)}/health`, 'UIEditorNewBridge')).json();
  if (bridgeHealth.name !== 'UIEditorNewBridge') {
    throw new Error(`Unexpected bridge health response: ${JSON.stringify(bridgeHealth)}`);
  }
  await assertHttpOk(args.url, 'UIEditor_new web app');

  const chrome = findChrome();
  const port = await getFreePort();
  const profile = path.join(os.tmpdir(), `uieditor-shell-context-smoke-${process.pid}-${Date.now()}`);
  await rm(profile, { recursive: true, force: true });
  await mkdir(profile, { recursive: true });

  const chromeArgs = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--window-size=${args.viewportWidth},${args.viewportHeight}`,
    '--force-device-scale-factor=1',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-features=CalculateNativeWinOcclusion',
    '--no-first-run',
    '--no-default-browser-check',
    '--ignore-certificate-errors',
    '--allow-insecure-localhost',
  ];
  if (!args.headed) chromeArgs.push('--headless=new');

  const chromeProc = spawn(chrome, chromeArgs, {
    cwd: ROOT,
    stdio: 'ignore',
    windowsHide: true,
  });

  let cdp;
  const report = {
    args,
    bridgeHealth,
    startedAt: new Date().toISOString(),
    ok: false,
  };

  try {
    await waitForJson(`http://127.0.0.1:${port}/json/version`);
    const target = await createPageTarget(port, 'about:blank');
    cdp = new CdpClient(target.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        try {
          window.__uieditorShellSmoke = true;
          window.confirm = () => true;
          window.alert = (message) => { window.__uieditorShellSmokeAlert = String(message); };
          localStorage.removeItem('uieditor_new_remote_artboards_v1');
          localStorage.removeItem('uieditor_save__autosave');
        } catch {}
      `,
    });
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: args.viewportWidth,
      height: args.viewportHeight,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.send('Page.navigate', { url: args.url });
    await waitForExpression(cdp, 'document.readyState === "complete" || document.readyState === "interactive"', 20000);
    await waitForExpression(cdp, '!!document.querySelector("[data-testid=\\"layer-artboard-row\\"]")', 20000);
    await waitForExpression(cdp, `(() => {
      const row = document.querySelector('[data-testid="layer-artboard-row"][data-active="true"]');
      return !!row?.dataset.bridgeSessionId && !!row?.dataset.workingPrefabPath;
    })()`, 120000);

    const result = await evaluate(cdp, `(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const rows = () => [...document.querySelectorAll('[data-testid="layer-artboard-row"]')].map((row) => ({
        id: row.dataset.artboardId || '',
        active: row.dataset.active === 'true',
        sessionId: row.dataset.bridgeSessionId || '',
        workingPath: row.dataset.workingPrefabPath || '',
        sourcePath: row.dataset.sourcePrefabPath || '',
        text: row.textContent || '',
      }));
      const pages = () => [...document.querySelectorAll('[data-testid="layer-page-tab"]')].map((tab) => ({
        id: tab.dataset.pageId || '',
        active: tab.dataset.active === 'true',
        text: tab.textContent || '',
      }));
      const activeRow = () => rows().find((row) => row.active) || rows()[0] || null;
      const activePage = () => pages().find((page) => page.active) || pages()[0] || null;
      const openContext = async (element) => {
        const rect = element.getBoundingClientRect();
        element.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + Math.min(20, Math.max(1, rect.width / 2)),
          clientY: rect.top + Math.min(12, Math.max(1, rect.height / 2)),
          button: 2,
          buttons: 2,
        }));
        await sleep(100);
      };
      const waitUntil = async (predicate, timeoutMs = 90000) => {
        const deadline = Date.now() + timeoutMs;
        let value;
        while (Date.now() < deadline) {
          value = predicate();
          if (value) return value;
          const alertText = window.__uieditorShellSmokeAlert;
          if (alertText) throw new Error(alertText);
          await sleep(250);
        }
        throw new Error('wait timed out');
      };
      const clickTestId = (testId) => {
        const el = document.querySelector('[data-testid="' + testId + '"]');
        if (!el) throw new Error('missing test id: ' + testId);
        el.click();
        return el;
      };
      const pointer = (el, type, x, y, buttons = 1) => {
        el.dispatchEvent(new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: 9302,
          pointerType: 'mouse',
          isPrimary: true,
          clientX: x,
          clientY: y,
          button: 0,
          buttons,
        }));
      };
      const centerOf = (el) => {
        const rect = el.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, rect };
      };
      const dragElement = async (handle, dx, dy, startPoint) => {
        const container = document.querySelector('[data-canvas-container]');
        if (!container) throw new Error('missing canvas container');
        const start = startPoint || centerOf(handle);
        pointer(handle, 'pointerdown', start.x, start.y, 1);
        await sleep(50);
        pointer(container, 'pointermove', start.x + dx, start.y + dy, 1);
        await sleep(80);
        pointer(container, 'pointerup', start.x + dx, start.y + dy, 0);
        await sleep(900);
      };
      const createFrameByCanvasClick = async () => {
        const debug = window.__UIEDITOR_DEBUG__;
        if (!debug) throw new Error('__UIEDITOR_DEBUG__ is missing');
        if (typeof debug.createBridgeFrame !== 'function') throw new Error('debug.createBridgeFrame is missing');
        const created = await debug.createBridgeFrame({
          name: 'SmokeToolbarFrame',
          x: 0,
          y: 0,
          width: 180,
          height: 120,
        });
        const selected = debug.select(created.selectedId || 'SmokeToolbarFrame');
        if (!selected.selectedId) throw new Error('created SmokeToolbarFrame was not selectable');
        await sleep(250);
        return selected.selectedId;
      };
      const requireHandle = async (testId) => {
        const el = await waitUntil(() => document.querySelector('[data-testid="' + testId + '"]'), 30000);
        return el;
      };
      const flattenTree = (items, out = []) => {
        for (const item of items || []) {
          if (!item) continue;
          out.push(item);
          flattenTree(item.children || [], out);
        }
        return out;
      };
      const debugNode = (nodeId) => {
        const direct = window.__UIEDITOR_DEBUG__?.node?.(nodeId)?.node;
        if (direct) return direct;
        const tree = window.__UIEDITOR_DEBUG__?.tree?.() || [];
        const roots = Array.isArray(tree) ? tree : (Array.isArray(tree.tree) ? tree.tree : [tree]);
        return flattenTree(roots).find((item) => item.id === nodeId) || null;
      };
      const bridgeBboxes = () => {
        const debug = window.__UIEDITOR_DEBUG__;
        if (!debug || typeof debug.bridgeBboxes !== 'function') throw new Error('debug.bridgeBboxes is missing');
        return debug.bridgeBboxes();
      };
      const requireDebugNodeId = (idOrName) => {
        const found = window.__UIEDITOR_DEBUG__?.node?.(idOrName);
        const id = found?.id || found?.node?.id || idOrName;
        if (!id || !debugNode(id)) throw new Error('missing debug node: ' + idOrName);
        return id;
      };
      const requireBbox = (idOrName) => {
        const id = requireDebugNodeId(idOrName);
        const box = (bridgeBboxes().bboxes || []).find((item) => item.nodeId === id);
        if (!box) throw new Error('missing Bridge bbox for ' + idOrName + ' (' + id + ')');
        return box;
      };
      const activeLocalToClient = (x, y) => {
        const container = document.querySelector('[data-canvas-container]');
        if (!container) throw new Error('missing canvas container');
        const containerRect = container.getBoundingClientRect();
        const snap = window.__UIEDITOR_DEBUG__?.snapshot?.();
        const artboardRect = snap?.artboard?.screenRect;
        const scale = snap?.canvas?.scale || 1;
        if (!artboardRect) throw new Error('missing active artboard screen rect');
        return {
          x: containerRect.left + artboardRect.x + x * scale,
          y: containerRect.top + artboardRect.y + y * scale,
        };
      };
      const dragMarquee = async (left, top, right, bottom, shiftKey = false) => {
        const container = document.querySelector('[data-canvas-container]');
        if (!container) throw new Error('missing canvas container');
        const start = activeLocalToClient(left, top);
        const end = activeLocalToClient(right, bottom);
        const pointerId = 9404;
        const eventInit = (type, point, buttons) => ({
          bubbles: true,
          cancelable: true,
          pointerId,
          pointerType: 'mouse',
          isPrimary: true,
          clientX: point.x,
          clientY: point.y,
          button: 0,
          buttons,
          shiftKey,
        });
        container.dispatchEvent(new PointerEvent('pointerdown', eventInit('pointerdown', start, 1)));
        await sleep(50);
        container.dispatchEvent(new PointerEvent('pointermove', eventInit('pointermove', end, 1)));
        await sleep(80);
        container.dispatchEvent(new PointerEvent('pointerup', eventInit('pointerup', end, 0)));
        await sleep(350);
      };
      const runMarqueeSmoke = async () => {
        const debug = window.__UIEDITOR_DEBUG__;
        if (!debug) throw new Error('__UIEDITOR_DEBUG__ is missing');
        if (typeof debug.createBridgeFrame !== 'function') throw new Error('debug.createBridgeFrame is missing');
        const parent = await debug.createBridgeFrame({
          name: 'SmokeMarqueeParent',
          x: -170,
          y: 210,
          width: 300,
          height: 220,
        });
        const parentId = parent.selectedId;
        if (!parentId) throw new Error('SmokeMarqueeParent was not created');
        const childA = await debug.createBridgeFrame({
          name: 'SmokeMarqueeChildA',
          parentId,
          x: -82,
          y: 54,
          width: 82,
          height: 52,
        });
        const childB = await debug.createBridgeFrame({
          name: 'SmokeMarqueeChildB',
          parentId,
          x: 62,
          y: 26,
          width: 96,
          height: 64,
        });
        const childC = await debug.createBridgeFrame({
          name: 'SmokeMarqueeChildC',
          parentId,
          x: 10,
          y: -70,
          width: 118,
          height: 58,
        });
        const outside = await debug.createBridgeFrame({
          name: 'SmokeMarqueeOutside',
          x: 260,
          y: 215,
          width: 120,
          height: 90,
        });
        await waitUntil(() => {
          const boxes = bridgeBboxes().bboxes || [];
          const ids = [parentId, childA.selectedId, childB.selectedId, childC.selectedId, outside.selectedId].filter(Boolean);
          return ids.every((id) => boxes.some((box) => box.nodeId === id));
        }, 30000);
        const targetIds = [parentId, childA.selectedId, childB.selectedId, childC.selectedId].filter(Boolean);
        const outsideId = outside.selectedId;
        const boxes = targetIds.map((id) => requireBbox(id));
        const union = boxes.reduce((acc, box) => ({
          left: Math.min(acc.left, box.x),
          top: Math.min(acc.top, box.y),
          right: Math.max(acc.right, box.x + box.width),
          bottom: Math.max(acc.bottom, box.y + box.height),
        }), { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
        debug.select(outsideId);
        await sleep(120);
        await dragMarquee(union.left - 18, union.top - 18, union.right + 18, union.bottom + 18);
        const selectedIds = bridgeBboxes().selectedIds || [];
        const missing = targetIds.filter((id) => !selectedIds.includes(id));
        if (missing.length > 0) throw new Error('marquee selection missed nested target ids: ' + missing.join(', '));
        if (outsideId && selectedIds.includes(outsideId)) throw new Error('marquee selection included outside node');
        const rootNodeId = bridgeBboxes().rootNodeId;
        if (rootNodeId && selectedIds.includes(rootNodeId)) throw new Error('marquee selection included artboard root');
        return {
          parentId,
          targetIds,
          outsideId,
          rootNodeId,
          selectedIds,
          union,
          targetBboxes: boxes,
          outsideBbox: outsideId ? requireBbox(outsideId) : null,
        };
      };
      const parsePolylinePoints = (value) => String(value || '').trim().split(/\\s+/)
        .map((pair) => {
          const [x, y] = pair.split(',').map(Number);
          return { x, y };
        })
        .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
      const assertNearPoint = (actual, expected, label, tolerance = 3) => {
        if (Math.abs(actual.x - expected.x) > tolerance || Math.abs(actual.y - expected.y) > tolerance) {
          throw new Error(label + ' differs from expected Bridge bbox center: ' + JSON.stringify({ actual, expected, tolerance }));
        }
      };
      const runAnnotationExportSmoke = async (marqueeSelection) => {
        const debug = window.__UIEDITOR_DEBUG__;
        if (!debug) throw new Error('__UIEDITOR_DEBUG__ is missing');
        if (typeof debug.addFlowLineAnnotation !== 'function') throw new Error('debug.addFlowLineAnnotation is missing');
        if (typeof debug.addOutsideRectAnnotation !== 'function') throw new Error('debug.addOutsideRectAnnotation is missing');
        if (typeof debug.captureLayerWholeShotSummary !== 'function') throw new Error('debug.captureLayerWholeShotSummary is missing');
        const flow = debug.addFlowLineAnnotation(marqueeSelection.parentId, marqueeSelection.outsideId);
        const outsideAnnotation = debug.addOutsideRectAnnotation();
        const glyph = await waitUntil(() => document.querySelector('[data-annotation-glyph="' + flow.id + '"]'), 30000);
        const visibleLine = glyph.querySelector('polyline[marker-end], polyline[markerEnd]') || glyph.querySelectorAll('polyline')[1] || glyph.querySelector('polyline');
        if (!visibleLine) throw new Error('flow-line glyph has no polyline');
        const points = parsePolylinePoints(visibleLine.getAttribute('points'));
        if (points.length < 2) throw new Error('flow-line polyline has too few points: ' + visibleLine.getAttribute('points'));
        const snap = debug.snapshot();
        const scale = snap?.canvas?.scale || 1;
        const expectedStart = {
          x: (snap?.canvas?.x || 0) + flow.src.page.x * scale,
          y: (snap?.canvas?.y || 0) + flow.src.page.y * scale,
        };
        const expectedEnd = {
          x: (snap?.canvas?.x || 0) + flow.dst.page.x * scale,
          y: (snap?.canvas?.y || 0) + flow.dst.page.y * scale,
        };
        assertNearPoint(points[0], expectedStart, 'flow-line start');
        assertNearPoint(points[points.length - 1], expectedEnd, 'flow-line end');
        const exportSummary = await debug.captureLayerWholeShotSummary();
        if (!exportSummary?.diff || exportSummary.diff.changedPixels < 40) {
          throw new Error('review export did not change after drawing flow-line: ' + JSON.stringify(exportSummary));
        }
        if (exportSummary.diff.flowColorishPixels < 20) {
          throw new Error('review export does not contain enough flow-line colored pixels: ' + JSON.stringify(exportSummary.diff));
        }
        const baseW = exportSummary.withoutAnnotations?.bboxW || 0;
        const annotatedW = exportSummary.withAnnotations?.bboxW || 0;
        if (annotatedW <= baseW + 80) {
          throw new Error('review export bbox did not expand to include out-of-artboard annotation: ' + JSON.stringify({ baseW, annotatedW, outsideAnnotation }));
        }
        return {
          flow,
          outsideAnnotation,
          points,
          expectedStart,
          expectedEnd,
          exportSummary,
        };
      };
      const runTransformGestureSmoke = async () => {
        const debug = window.__UIEDITOR_DEBUG__;
        if (!debug) throw new Error('__UIEDITOR_DEBUG__ is missing');
        const nodeId = await createFrameByCanvasClick();
        debug.focusTargetInViewport(nodeId, { fitPaddingCss: 160 });
        await sleep(250);
        debug.select(nodeId);
        const before = debug.select(nodeId).snapshot;
        const beforeTarget = debugNode(nodeId);
        if (!beforeTarget) throw new Error('missing before transform target');

        clickTestId('scene-tool-move');
        await dragElement(await requireHandle('transform-handle-move'), 54, 28);
        const afterMove = debug.select(nodeId).snapshot;
        const moved = debugNode(nodeId);
        if (!moved || (moved.x === beforeTarget.x && moved.y === beforeTarget.y)) throw new Error('move handle did not change position');

        clickTestId('scene-tool-rect');
        const rectHandle = await requireHandle('transform-handle-rect-se');
        await dragElement(rectHandle, 46, 34);
        const afterRect = debugNode(nodeId);
        if (!afterRect || afterRect.width <= moved.width || afterRect.height <= moved.height) {
          throw new Error('rect handle did not increase size');
        }

        clickTestId('scene-tool-scale');
        await dragElement(await requireHandle('transform-handle-scale-se'), 30, 30);
        const afterScale = debugNode(nodeId);
        if (!afterScale || afterScale.width <= afterRect.width || afterScale.height <= afterRect.height) {
          throw new Error('scale handle did not increase size');
        }

        clickTestId('scene-tool-rotate');
        const rotateHandle = await requireHandle('transform-handle-rotate');
        const rotateRect = rotateHandle.getBoundingClientRect();
        await dragElement(rotateHandle, -40, -75, {
          x: rotateRect.right - 2,
          y: rotateRect.top + rotateRect.height / 2,
        });
        const afterRotate = debugNode(nodeId);
        if (!afterRotate || Math.abs((afterRotate.rotation || 0) - (afterScale.rotation || 0)) < 1) {
          throw new Error('rotate handle did not change rotation');
        }

        const active = activeRow();
        const bridgeRes = await fetch(${JSON.stringify(`${normalizeBaseUrl(args.bridgeUrl)}/export-node-tree`)}, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            sessionId: active.sessionId,
            includeInactive: true,
            includeComponents: true,
            includeProtectedFields: false,
          }),
        });
        const bridgeState = await bridgeRes.json();
        if (!bridgeRes.ok || !bridgeState.ok) throw new Error('export-node-tree after toolbar gesture failed: ' + JSON.stringify(bridgeState));
        const bridgeNode = bridgeState.nodes.find((node) => node.nodeId === nodeId);
        if (!bridgeNode) throw new Error('Bridge export did not include transformed node');
        const size = bridgeNode.rectTransform?.sizeDelta || [];
        const pos = bridgeNode.rectTransform?.anchoredPosition || [];
        const rot = bridgeNode.rectTransform?.localEulerAngles || [];
        if (Math.abs((size[0] || 0) - afterRotate.width) > 2 || Math.abs((size[1] || 0) - afterRotate.height) > 2) {
          throw new Error('Bridge size does not match toolbar gesture result: ' + JSON.stringify({ size, afterRotate }));
        }
        if (Math.abs((pos[0] || 0) - afterRotate.x) > 2 || Math.abs((pos[1] || 0) - afterRotate.y) > 2) {
          throw new Error('Bridge position does not match toolbar gesture result: ' + JSON.stringify({ pos, afterRotate }));
        }
        if (Math.abs((((rot[2] || 0) + 360) % 360) - (((afterRotate.rotation || 0) + 360) % 360)) > 2) {
          throw new Error('Bridge rotation does not match toolbar gesture result: ' + JSON.stringify({ rot, afterRotate }));
        }
        return {
          nodeId,
          sessionId: active.sessionId,
          before,
          afterMove,
          afterRect,
          afterScale,
          afterRotate,
          bridgeRectTransform: bridgeNode.rectTransform,
        };
      };

      const initialRows = rows();
      const initialPages = pages();
      if (initialRows.length === 0) throw new Error('no artboard row');
      const sourceRow = activeRow();
      if (!sourceRow?.workingPath) throw new Error('active artboard has no working prefab path');

      const sourceEl = document.querySelector('[data-testid="layer-artboard-row"][data-active="true"]');
      await openContext(sourceEl);
      const duplicateArtboardButton = document.querySelector('[data-testid="layer-artboard-duplicate"]');
      if (!duplicateArtboardButton) throw new Error('duplicate artboard button is missing');
      duplicateArtboardButton.click();
      const duplicatedArtboard = await waitUntil(() => {
        const nextRows = rows();
        if (nextRows.length <= initialRows.length) return null;
        const next = nextRows.find((row) => row.active && row.workingPath && row.workingPath !== sourceRow.workingPath);
        return next || null;
      });
      const marqueeSelection = await runMarqueeSmoke();
      const annotationExport = await runAnnotationExportSmoke(marqueeSelection);
      const transformGesture = await runTransformGestureSmoke();

      const rowsAfterArtboardDuplicate = rows();
      const pageBeforeDuplicate = activePage();
      const pagesBeforeDuplicate = pages();
      const pageEl = document.querySelector('[data-testid="layer-page-tab"][data-active="true"] button')
        || document.querySelector('[data-testid="layer-page-tab"][data-active="true"]');
      await openContext(pageEl);
      const duplicatePageButton = document.querySelector('[data-testid="layer-page-duplicate"]');
      if (!duplicatePageButton) throw new Error('duplicate page button is missing');
      duplicatePageButton.click();
      const duplicatedPage = await waitUntil(() => {
        const nextPages = pages();
        if (nextPages.length <= pagesBeforeDuplicate.length) return null;
        const page = nextPages.find((item) => item.active);
        const nextRows = rows();
        const rowPaths = nextRows.map((row) => row.workingPath).filter(Boolean);
        if (!page || rowPaths.length === 0) return null;
        const hasFreshTemp = rowPaths.some((item) => item !== sourceRow.workingPath && item !== duplicatedArtboard.workingPath);
        return hasFreshTemp ? { ...page, rowPaths } : null;
      });

      const duplicatePagePaths = duplicatedPage.rowPaths;
      const pageCountAfterDuplicate = pages().length;
      const activePageEl = document.querySelector('[data-testid="layer-page-tab"][data-active="true"] button')
        || document.querySelector('[data-testid="layer-page-tab"][data-active="true"]');
      await openContext(activePageEl);
      const deletePageButton = document.querySelector('[data-testid="layer-page-delete"]');
      if (!deletePageButton) throw new Error('delete page button is missing after duplicate page');
      deletePageButton.click();
      await waitUntil(() => pages().length < pageCountAfterDuplicate);

      const duplicatedRowEl = [...document.querySelectorAll('[data-testid="layer-artboard-row"]')]
        .find((row) => row.dataset.workingPrefabPath === duplicatedArtboard.workingPath);
      if (duplicatedRowEl) {
        const countBeforeDelete = rows().length;
        await openContext(duplicatedRowEl);
        const deleteArtboardButton = document.querySelector('[data-testid="layer-artboard-delete"]');
        if (!deleteArtboardButton) throw new Error('delete artboard button is missing after duplicate artboard');
        deleteArtboardButton.click();
        await waitUntil(() => rows().length < countBeforeDelete);
      }

      return {
        initialRows,
        initialPages,
        sourceRow,
        duplicatedArtboard,
        rowsAfterArtboardDuplicate,
        pageBeforeDuplicate,
        duplicatedPage,
        duplicatePagePaths,
        marqueeSelection,
        annotationExport,
        transformGesture,
        finalRows: rows(),
        finalPages: pages(),
      };
    })()`, 180000);

    report.result = result;
    const tempPaths = [
      result.duplicatedArtboard?.workingPath,
      ...(result.duplicatePagePaths || []),
    ].filter(Boolean);
    report.tempCleanup = tempPaths.map((assetPath) => ({
      assetPath,
      exists: projectAssetExists(bridgeHealth.projectPath, assetPath),
    }));
    const remaining = report.tempCleanup.filter((item) => item.exists);
    if (remaining.length > 0) {
      throw new Error(`duplicated temp prefabs still exist after cleanup: ${remaining.map((item) => item.assetPath).join(', ')}`);
    }

    report.screenshotPath = await screenshot(cdp, path.join(args.out, 'success.png'));
    report.ok = true;
    report.finishedAt = new Date().toISOString();
    await writeFile(path.join(args.out, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
    console.log(JSON.stringify({
      ok: true,
      duplicatedArtboardPath: result.duplicatedArtboard.workingPath,
      duplicatedPagePathCount: result.duplicatePagePaths.length,
      cleanupChecked: report.tempCleanup.length,
      reportPath: path.join(args.out, 'report.json'),
      screenshotPath: report.screenshotPath,
    }, null, 2));
  } catch (err) {
    report.ok = false;
    report.error = err instanceof Error ? err.stack || err.message : String(err);
    report.finishedAt = new Date().toISOString();
    if (cdp) {
      try {
        report.screenshotPath = await screenshot(cdp, path.join(args.out, 'failure.png'));
      } catch {}
    }
    await writeFile(path.join(args.out, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
    console.error(JSON.stringify({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      reportPath: path.join(args.out, 'report.json'),
      screenshotPath: report.screenshotPath,
    }, null, 2));
    process.exitCode = 1;
  } finally {
    cdp?.close();
    if (!args.keepOpen) {
      await stopProcess(chromeProc);
      await rm(profile, { recursive: true, force: true }).catch(() => {});
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const args = {
    url: 'http://127.0.0.1:3001/',
    prefab: 'UICommons/dl2_UISimplePropList.prefab',
    name: 'dl2_UISimplePropList',
    targetPath: '',
    targetUnityFileId: '',
    width: 1080,
    height: 1920,
    threshold: 28,
    viewportWidth: 1200,
    viewportHeight: 900,
    out: path.join(ROOT, '.cache', 'visual-probes', 'latest'),
    headed: false,
    keepOpen: false,
    failOnWarnings: false,
    cleanScreenshot: false,
    drag: true,
    dragX: 96,
    dragY: 48,
    cropPadDesign: 24,
    fitTarget: true,
    fitPaddingCss: 56,
    immersive: true,
  };

  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const next = argv[i + 1];
    if (key === '--headed') args.headed = true;
    else if (key === '--keep-open') args.keepOpen = true;
    else if (key === '--fail-on-warnings') {
      if (next === 'false' || next === '0') { args.failOnWarnings = false; i++; }
      else args.failOnWarnings = true;
    }
    else if (key === '--clean-screenshot') args.cleanScreenshot = true;
    else if (key === '--no-immersive') args.immersive = false;
    else if (key === '--no-fit-target') args.fitTarget = false;
    else if (key === '--no-drag') args.drag = false;
    else if (key === '--url') { args.url = next; i++; }
    else if (key === '--prefab') { args.prefab = next; i++; }
    else if (key === '--name') { args.name = next; i++; }
    else if (key === '--target-path') { args.targetPath = next; i++; }
    else if (key === '--target-unity-file-id') { args.targetUnityFileId = next; i++; }
    else if (key === '--width') { args.width = Number(next); i++; }
    else if (key === '--height') { args.height = Number(next); i++; }
    else if (key === '--threshold') { args.threshold = Number(next); i++; }
    else if (key === '--viewport-width') { args.viewportWidth = Number(next); i++; }
    else if (key === '--viewport-height') { args.viewportHeight = Number(next); i++; }
    else if (key === '--drag-x') { args.dragX = Number(next); i++; }
    else if (key === '--drag-y') { args.dragY = Number(next); i++; }
    else if (key === '--crop-pad-design') { args.cropPadDesign = Number(next); i++; }
    else if (key === '--fit-padding-css') { args.fitPaddingCss = Number(next); i++; }
    else if (key === '--out') { args.out = path.resolve(next); i++; }
  }
  return args;
}

function collectWarnings(...items) {
  const out = [];
  for (const item of items) {
    if (Array.isArray(item?.warnings)) out.push(...item.warnings);
  }
  return out;
}

function buildPreviewContract(args, probe) {
  const snapshot = probe?.snapshot ?? {};
  const preview = snapshot.preview ?? {};
  const artboard = snapshot.artboard ?? {};
  const requested = { width: args.width, height: args.height };
  const snapshotPreview = { width: preview.width, height: preview.height };
  const snapshotArtboardEffective = { width: artboard.width, height: artboard.height };
  const snapshotArtboardStored = { width: artboard.storedWidth, height: artboard.storedHeight };
  const runtimeContract = snapshot.previewContract ?? null;
  const ok = snapshotPreview.width === requested.width
    && snapshotPreview.height === requested.height
    && snapshotArtboardEffective.width === requested.width
    && snapshotArtboardEffective.height === requested.height;
  return {
    requested,
    snapshotPreview,
    snapshotArtboardEffective,
    snapshotArtboardStored,
    runtimeContract,
    storedSizeIsMetadata: true,
    ok,
  };
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

async function waitForJson(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch (err) {
      lastError = err;
    }
    await sleep(200);
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError?.message ?? 'no response'}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withVisualProbeFlag(rawUrl) {
  try {
    const url = new URL(rawUrl);
    url.searchParams.set('uieditorVisualProbe', '1');
    return url.toString();
  } catch {
    return rawUrl;
  }
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
  await Promise.race([closePromise, sleep(timeoutMs)]).catch(() => {});
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
    const id = this.nextId++;
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

  fire(method, params = {}) {
    this.ws.send(JSON.stringify({ id: this.nextId++, method, params }));
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
    await sleep(300);
  }
  throw new Error(`Timed out waiting for expression: ${expression}${lastError ? ` (${lastError.message})` : ''}`);
}

async function createPageTarget(port, url = 'about:blank') {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!res.ok) throw new Error(`Cannot create CDP target: ${res.status} ${await res.text()}`);
  return await res.json();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const chrome = findChrome();
  const port = await getFreePort();
  const profile = path.join(os.tmpdir(), `uieditor-visual-probe-chrome-${process.pid}-${Date.now()}`);
  await rm(profile, { recursive: true, force: true });
  await mkdir(profile, { recursive: true });
  await mkdir(args.out, { recursive: true });

  const chromeArgs = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--window-size=${args.viewportWidth},${args.viewportHeight}`,
    '--force-device-scale-factor=1',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-features=CalculateNativeWinOcclusion',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required',
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
  try {
    await waitForJson(`http://127.0.0.1:${port}/json/version`);
    const target = await createPageTarget(port, withVisualProbeFlag(args.url));
    cdp = new CdpClient(target.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: args.viewportWidth,
      height: args.viewportHeight,
      deviceScaleFactor: 1,
      mobile: false,
    });
    try {
      await waitForExpression(cdp, 'document.readyState === "complete" || document.readyState === "interactive"', 20000);
    } catch {
      await cdp.send('Page.navigate', { url: args.url }, 10000).catch(() => {});
      await waitForExpression(cdp, 'document.readyState === "complete" || document.readyState === "interactive"', 30000);
    }
    await waitForExpression(cdp, '!!window.__UIEDITOR_DEBUG__ && !!document.getElementById("unity-canvas")', 30000);
    await waitForExpression(cdp, `(() => {
      const api = window.__UIEDITOR_DEBUG__;
      if (!api) return false;
      const msgs = api.unityMessages ? api.unityMessages() : [];
      return msgs.some((m) => !m.skipped && (m.method === 'SetBaseUrl' || m.method === 'SyncFullTree'));
    })()`, 45000);

    if (args.immersive) {
      await evaluate(cdp, `(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Tab',
          code: 'Tab',
          bubbles: true,
          cancelable: true
        }));
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        await new Promise((resolve) => setTimeout(resolve, 250));
        return true;
      })()`);
    }

    const probeResult = await evaluate(cdp, `(async () => {
      const api = window.__UIEDITOR_DEBUG__;
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      api.setPreviewResolution(${Number(args.width)}, ${Number(args.height)});
      await sleep(400);
      await api.importPrefab(${JSON.stringify(args.prefab)}, { clear: true });
      await sleep(700);
      api.setPreviewResolution(${Number(args.width)}, ${Number(args.height)});
      await sleep(800);
      const targetArgs = {
        threshold: ${Number(args.threshold)},
        fullSync: true,
        cropPadDesign: ${Number(args.cropPadDesign)},
        targetPath: ${JSON.stringify(args.targetPath || '')},
        targetUnityFileId: ${JSON.stringify(args.targetUnityFileId || '')}
      };
      let initial = null;
      let before = null;
      if (${args.fitTarget ? 'true' : 'false'} && api.focusTargetInViewport) {
        initial = await api.visualProbe(${JSON.stringify(args.name)}, targetArgs);
        await sleep(250);
        before = await api.visualProbe(${JSON.stringify(args.name)}, {
          ...targetArgs,
          fitTarget: true,
          fitPaddingCss: ${Number(args.fitPaddingCss)}
        });
      } else {
        before = await api.visualProbe(${JSON.stringify(args.name)}, targetArgs);
      }
      let drag = null;
      let after = null;
      if (${args.drag ? 'true' : 'false'}) {
        const targetId = before && before.target ? before.target.id : ${JSON.stringify(args.name)};
        drag = await api.dragSelectedByScreenDelta(${Number(args.dragX)}, ${Number(args.dragY)}, targetId);
        await sleep(400);
        after = await api.visualProbe(targetId, { threshold: ${Number(args.threshold)}, fullSync: true });
      }
      return { initial, before, drag, after };
    })()`, 60000);

    if (args.cleanScreenshot) {
      await evaluate(cdp, `(async () => {
        const api = window.__UIEDITOR_DEBUG__;
        if (api?.select) api.select('__visual_probe_no_selection__');
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        await new Promise((resolve) => setTimeout(resolve, 320));
        const existing = document.getElementById('visual-probe-clean-screenshot-style');
        if (existing) existing.remove();
        const style = document.createElement('style');
        style.id = 'visual-probe-clean-screenshot-style';
        style.textContent = [
          '[data-overlay-root]{display:none!important;}',
          '[data-drag-handle]{display:none!important;}',
          '.konvajs-content + *{display:none!important;}'
        ].join('\\n');
        document.head.appendChild(style);
        return true;
      })()`);
      await sleep(120);
    }

    const screenshot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
      fromSurface: true,
    });

    const previewContract = buildPreviewContract(args, probeResult.before);
    if (!previewContract.ok) {
      throw new Error(`Preview resolution contract failed: ${JSON.stringify(previewContract)}`);
    }

    const reportPath = path.join(args.out, 'report.json');
    const screenshotPath = path.join(args.out, 'viewport.png');
    await writeFile(reportPath, JSON.stringify({
      args,
      capturedAt: new Date().toISOString(),
      previewContract,
      initialProbe: probeResult.initial,
      focus: probeResult.before?.focus ?? null,
      probe: probeResult.before,
      drag: probeResult.drag,
      postDragProbe: probeResult.after,
    }, null, 2), 'utf8');
    await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'));

    const warnings = collectWarnings(probeResult.before, probeResult.after);
    if (probeResult.drag) {
      const expectedDx = probeResult.drag.expectedDesignDelta?.x;
      const expectedDy = probeResult.drag.expectedDesignDelta?.y;
      const actualDx = probeResult.drag.actualDesignDelta?.x;
      const actualDy = probeResult.drag.actualDesignDelta?.y;
      if (Number.isFinite(expectedDx) && Number.isFinite(actualDx) && Math.abs(expectedDx - actualDx) > 1) {
        warnings.push(`Drag X delta mismatch: expected ${expectedDx}, got ${actualDx}`);
      }
      if (Number.isFinite(expectedDy) && Number.isFinite(actualDy) && Math.abs(expectedDy - actualDy) > 1) {
        warnings.push(`Drag Y delta mismatch: expected ${expectedDy}, got ${actualDy}`);
      }
    }

    const summary = {
      reportPath,
      screenshotPath,
      warnings,
      diagnostics: probeResult.before.diagnostics,
      postDragDiagnostics: probeResult.after?.diagnostics,
      drag: probeResult.drag ? {
        screenDelta: probeResult.drag.screenDelta,
        expectedDesignDelta: probeResult.drag.expectedDesignDelta,
        actualDesignDelta: probeResult.drag.actualDesignDelta,
      } : null,
      expected: probeResult.before.expected,
      matchingUnityBound: probeResult.before.matchingUnityBound,
      postDragUnityBound: probeResult.after?.matchingUnityBound,
      camera: probeResult.before.camera,
      pixelCoverage: probeResult.before.pixelScan?.coverage,
      postDragPixelCoverage: probeResult.after?.pixelScan?.coverage,
      pixelBoundsCss: probeResult.before.pixelScan?.bounds?.css,
      canvas: probeResult.before.canvas,
    };
    console.log(JSON.stringify(summary, null, 2));
    if (args.failOnWarnings && warnings.length > 0) {
      process.exitCode = 2;
    }
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
  process.exit(1);
});

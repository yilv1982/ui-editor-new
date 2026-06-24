import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
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
    bridgeUrl: 'http://127.0.0.1:18082',
    prefab: 'UICommons/UIAlert2.prefab',
    targetPath: 'dl2_ui_p_btns_002/okBtn/okText',
    text: 'Pilot OK',
    textColor: '#e64553',
    viewportWidth: 1280,
    viewportHeight: 760,
    out: path.join(ROOT, '.cache', 'editor-bridge-web-smoke', 'latest'),
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
    else if (key === '--prefab') { args.prefab = next; i += 1; }
    else if (key === '--target-path') { args.targetPath = next; i += 1; }
    else if (key === '--text') { args.text = next; i += 1; }
    else if (key === '--text-color') { args.textColor = next; i += 1; }
    else if (key === '--viewport-width') { args.viewportWidth = Number(next); i += 1; }
    else if (key === '--viewport-height') { args.viewportHeight = Number(next); i += 1; }
    else if (key === '--out') { args.out = path.resolve(next); i += 1; }
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

function normalizeBaseUrl(value) {
  return value.replace(/\/+$/, '');
}

function hashBuffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function bridgePost(bridgeUrl, endpoint, body, timeoutMs = 120000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${normalizeBaseUrl(bridgeUrl)}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) {
      throw new Error(`${endpoint} failed: ${res.status} ${JSON.stringify(data)}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function snapshotImageBuffer(bridgeUrl, snapshot) {
  if (snapshot?.image?.dataUrl) {
    const comma = snapshot.image.dataUrl.indexOf(',');
    return Buffer.from(snapshot.image.dataUrl.slice(comma + 1), 'base64');
  }
  const rawUrl = snapshot?.image?.url || (snapshot?.image?.path ? `/snapshots/${path.basename(snapshot.image.path)}` : '');
  if (!rawUrl) throw new Error('snapshot image URL is missing');
  const res = await fetch(`${normalizeBaseUrl(bridgeUrl)}${rawUrl.startsWith('/') ? rawUrl : `/${rawUrl}`}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`snapshot image fetch failed: ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

async function renderSnapshotImage(bridgeUrl, sessionId) {
  const response = await bridgePost(bridgeUrl, '/render-snapshot', {
    sessionId,
    width: 1080,
    height: 1920,
    backgroundColor: '#162D3FFF',
    includeBboxes: true,
    imageMode: 'file',
  });
  const buffer = await snapshotImageBuffer(bridgeUrl, response.snapshot);
  return {
    snapshotId: response.snapshot.snapshotId,
    width: response.snapshot.width,
    height: response.snapshot.height,
    bboxCount: response.snapshot.bboxes?.length ?? 0,
    byteLength: buffer.length,
    sha256: hashBuffer(buffer),
  };
}

async function verifySavedPrefabVisualConsistency(bridgeUrl, sourceSessionId, savedPrefabPath) {
  const before = await renderSnapshotImage(bridgeUrl, sourceSessionId);
  const opened = await bridgePost(bridgeUrl, '/open-prefab', {
    prefabPath: savedPrefabPath,
    mode: 'temp-copy',
    width: 1080,
    height: 1920,
    backgroundColor: '#162D3FFF',
  });
  let after;
  try {
    after = await renderSnapshotImage(bridgeUrl, opened.session.sessionId);
  } finally {
    await bridgePost(bridgeUrl, '/close-prefab', {
      sessionId: opened.session.sessionId,
      deleteTempObjects: true,
    }).catch(() => {});
  }
  return {
    ok: before.sha256 === after.sha256,
    savedPrefabPath,
    before,
    after,
  };
}

function summarizeDurations(groups) {
  const flat = [];
  for (const [group, durations] of Object.entries(groups)) {
    if (!durations || typeof durations !== 'object') continue;
    for (const [name, durationMs] of Object.entries(durations)) {
      if (typeof durationMs === 'number' && Number.isFinite(durationMs)) {
        flat.push({ group, name, durationMs });
      }
    }
  }
  const max = flat.reduce((cur, item) => (item.durationMs > cur.durationMs ? item : cur), { group: '', name: '', durationMs: 0 });
  return {
    maxOperation: max,
    operationCount: flat.length,
    operations: flat,
  };
}

function assertLatency(summary, limitMs, label = 'operation') {
  if (summary.maxOperation.durationMs > limitMs) {
    throw new Error(`${label} latency exceeded ${limitMs}ms: ${summary.maxOperation.group}.${summary.maxOperation.name}=${summary.maxOperation.durationMs}ms`);
  }
}

function roundMs(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
}

function summarizePerfLogs(logs) {
  const byId = new Map();
  for (const log of logs || []) {
    if (!log || typeof log.id !== 'number') continue;
    if (!byId.has(log.id)) byId.set(log.id, []);
    byId.get(log.id).push(log);
  }

  const operations = [...byId.entries()].map(([id, operationLogs]) => {
    const sorted = operationLogs.slice().sort((a, b) => (a.totalMs ?? 0) - (b.totalMs ?? 0));
    const first = sorted[0] ?? {};
    const stage = (name) => sorted.filter((item) => item.stage === name).at(-1);
    const between = (from, to) => {
      const start = stage(from);
      const end = stage(to);
      if (!start || !end) return null;
      return roundMs((end.totalMs ?? 0) - (start.totalMs ?? 0));
    };
    const bridgeResponse = stage('bridgeResponse') ?? stage('snapshotRefreshResponse');
    const bridgeProfile = bridgeResponse?.bridgeProfile ?? null;
    const serverProfile = bridgeResponse?.serverProfile ?? null;
    const visualComplete = stage('visualComplete');
    const imageLoaded = stage('imageLoaded');
    const operationSettled = stage('operationSettled');
    const totalVisualMs = roundMs(visualComplete?.totalMs ?? imageLoaded?.totalMs ?? operationSettled?.totalMs ?? sorted.at(-1)?.totalMs ?? 0);

    return {
      id,
      label: first.label ?? '',
      totalVisualMs,
      queueWaitMs: between('queueEnqueued', 'queueStarted'),
      bridgeMs: between('bridgeRequestStart', 'bridgeResponse'),
      stateApplyMs: between('stateApplyStart', 'stateUpdated'),
      snapshotUrlMs: between('snapshotUrlStart', 'snapshotUrlReady'),
      imageLoadWaitMs: imageLoaded ? roundMs(imageLoaded.deltaMs) : null,
      operationSettledMs: roundMs(operationSettled?.totalMs),
      serverProfile,
      bridgeProfile,
      topBridgeProfileEntries: bridgeProfile?.entries
        ? bridgeProfile.entries.slice().sort((a, b) => b.ms - a.ms).slice(0, 8)
        : [],
      stages: Object.fromEntries(sorted.map((item) => [item.stage, roundMs(item.totalMs)])),
    };
  });

  const maxBy = (key) => operations.reduce((cur, item) => ((item[key] ?? -1) > (cur[key] ?? -1) ? item : cur), {});
  const average = (key) => {
    const values = operations.map((item) => item[key]).filter((value) => typeof value === 'number');
    if (values.length === 0) return null;
    return roundMs(values.reduce((sum, value) => sum + value, 0) / values.length);
  };

  return {
    operationCount: operations.length,
    maxVisual: maxBy('totalVisualMs'),
    maxBridge: maxBy('bridgeMs'),
    averageVisualMs: average('totalVisualMs'),
    averageBridgeMs: average('bridgeMs'),
    operations,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sampleName = args.prefab.replace(/^.*[\\/]/, '').replace(/\.prefab$/i, '');
  await mkdir(args.out, { recursive: true });

  const bridgeHealth = await (await assertHttpOk(`${normalizeBaseUrl(args.bridgeUrl)}/health`, 'UIEditorNewBridge')).json();
  if (bridgeHealth.name !== 'UIEditorNewBridge') {
    throw new Error(`Unexpected bridge health response: ${JSON.stringify(bridgeHealth)}`);
  }
  await assertHttpOk(args.url, 'UIEditor_new web app');

  const chrome = findChrome();
  const port = await getFreePort();
  const profile = path.join(os.tmpdir(), `uieditor-bridge-web-smoke-${process.pid}-${Date.now()}`);
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
          if (!sessionStorage.getItem('uieditor_new_smoke_boot_cleaned')) {
            localStorage.removeItem('uieditor_new_remote_artboards_v1');
            sessionStorage.removeItem('uieditor_new_perf_logs');
            sessionStorage.setItem('uieditor_new_smoke_boot_cleaned', '1');
          }
          if (!window.__uieditorNewPerfPatched) {
            window.__uieditorNewPerfPatched = true;
            const originalInfo = console.info.bind(console);
            console.info = (...args) => {
              try {
                if (args[0] === '[UIEditorNewPerf]' && !window.__uieditorNewPerfStoresLogs) {
                  const logs = JSON.parse(sessionStorage.getItem('uieditor_new_perf_logs') || '[]');
                  logs.push(args[1]);
                  sessionStorage.setItem('uieditor_new_perf_logs', JSON.stringify(logs.slice(-300)));
                }
              } catch {}
              originalInfo(...args);
            };
          }
        } catch {}
      `,
    });
    await cdp.send('Input.setIgnoreInputEvents', { ignore: false });
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: args.viewportWidth,
      height: args.viewportHeight,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.send('Page.navigate', { url: args.url });
    await waitForExpression(cdp, 'document.readyState === "complete" || document.readyState === "interactive"', 20000);
    await waitForExpression(cdp, '!!document.querySelector("[data-testid=\\"remote-new-artboard\\"]")', 20000);
    await waitForExpression(cdp, '!!document.querySelector("[data-testid=\\"remote-snapshot-frame\\"]")', 90000);

    const created = await evaluate(cdp, `(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const interactionDurations = {};
      const durations = {};
      const setValue = (element, value) => {
        const setter = Object.getOwnPropertyDescriptor(element.constructor.prototype, 'value')?.set;
        if (setter) setter.call(element, value);
        else element.value = value;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const waitStatus = async (needle, timeoutMs = 90000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const text = document.querySelector('[data-testid="remote-status"]')?.textContent || '';
          if (text.includes(needle)) return text;
          if (text.includes('失败') || text.includes('Failed to fetch')) throw new Error('operation failed while waiting for ' + needle + ': ' + text);
          await sleep(16);
        }
        throw new Error('timed out waiting for status: ' + needle);
      };
      const clickAndWait = async (name, element, ackNeedle, syncNeedle, timeoutMs = 90000) => {
        const startedAt = performance.now();
        element.click();
        const ackStatus = await waitStatus(ackNeedle, 2000);
        interactionDurations[name] = Math.round(performance.now() - startedAt);
        const syncStatus = await waitStatus(syncNeedle, timeoutMs);
        durations[name] = Math.round(performance.now() - startedAt);
        return { ackStatus, syncStatus };
      };

      const createText = [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === '文字');
      if (!createText) throw new Error('create text button is missing');
      const createTextStatus = await clickAndWait('createText', createText, '新增文字已提交', '新增文字已同步');

      const textInput = document.querySelector('[data-testid="remote-text-input"]');
      const textButton = document.querySelector('[data-testid="remote-apply-text"]');
      if (!textInput || !textButton) throw new Error('remote text controls are missing');
      setValue(textInput, ${JSON.stringify(args.text)});
      const textStatus = await clickAndWait('setText', textButton, '文本已提交', '文本已同步');

      const colorInput = document.querySelector('[data-testid="remote-text-color"]');
      const styleButton = document.querySelector('[data-testid="remote-apply-text-style"]');
      if (!colorInput || !styleButton) throw new Error('remote text style controls are missing');
      setValue(colorInput, ${JSON.stringify(args.textColor)});
      const fontSizeInput = document.querySelector('[data-testid="remote-font-size-input"]');
      if (fontSizeInput) setValue(fontSizeInput, '38');
      const styleStatus = await clickAndWait('setTextStyle', styleButton, '文字样式已提交', '文字样式已同步');

      const xInput = document.querySelector('[data-testid="remote-x-input"]');
      const yInput = document.querySelector('[data-testid="remote-y-input"]');
      const positionButton = document.querySelector('[data-testid="remote-apply-position"]');
      if (!xInput || !yInput || !positionButton) throw new Error('position controls are missing');
      setValue(xInput, '180');
      setValue(yInput, '-220');
      const positionStatus = await clickAndWait('moveNode', positionButton, '位置已提交', '位置已同步');

      const widthInput = document.querySelector('[data-testid="remote-width-input"]');
      const heightInput = document.querySelector('[data-testid="remote-height-input"]');
      const sizeButton = document.querySelector('[data-testid="remote-apply-size"]');
      if (!widthInput || !heightInput || !sizeButton) throw new Error('size controls are missing');
      setValue(widthInput, '360');
      setValue(heightInput, '96');
      const sizeStatus = await clickAndWait('resizeNode', sizeButton, '尺寸已提交', '尺寸已同步');

      const createImage = [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === '图片');
      if (!createImage) throw new Error('create image button is missing');
      const imageStatus = await clickAndWait('createImage', createImage, '新增图片已提交', '新增图片已同步');
      const deleteButton = document.querySelector('[data-testid="remote-delete-node"]');
      if (!deleteButton) throw new Error('delete button is missing after creating image');
      const deleteStatus = await clickAndWait('deleteNode', deleteButton, '删除节点已提交', '删除节点已同步');
      const undoButton = [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === '撤销');
      const redoButton = [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === '重做');
      if (!undoButton || !redoButton) throw new Error('undo/redo buttons are missing');
      const undoStatus = await clickAndWait('undo', undoButton, '撤销已提交', '撤销已同步');
      const redoStatus = await clickAndWait('redo', redoButton, '重做已提交', '重做已同步');

      const saveTarget = document.querySelector('[data-testid="remote-save-target"]');
      const saveButton = document.querySelector('[data-testid="remote-save-artboard"]');
      if (!saveTarget || !saveButton) throw new Error('save controls are missing');
      const target = 'Assets/Temp/UIEditorNew/CodexRemoteSmoke_' + Date.now() + '.prefab';
      setValue(saveTarget, target);
      const saveStartedAt = performance.now();
      saveButton.click();
      await waitStatus('保存 UI...', 2000);
      interactionDurations.saveNewArtboard = Math.round(performance.now() - saveStartedAt);
      const saveStatus = await waitStatus('已保存 UI');
      durations.saveNewArtboard = Math.round(performance.now() - saveStartedAt);

      const boxes = [...document.querySelectorAll('[data-testid="remote-bbox"]')];
      await sleep(250);
      const storage = JSON.parse(localStorage.getItem('uieditor_new_remote_artboards_v1') || '{"artboards":[]}');
      const activeArtboard = storage.artboards?.find((item) => item.id === storage.activeId) || storage.artboards?.[0] || null;
      return {
        bboxCount: boxes.length,
        interactionDurationsMs: interactionDurations,
        operationDurationsMs: durations,
        createTextStatus,
        textStatus,
        styleStatus,
        positionStatus,
        sizeStatus,
        imageStatus,
        deleteStatus,
        undoStatus,
        redoStatus,
        saveStatus,
        sessionId: activeArtboard?.sessionId || '',
        workingPrefabPath: activeArtboard?.workingPrefabPath || '',
        target
      };
    })()`, 160000);
    report.created = created;
    if (!created.sessionId) {
      throw new Error('saved new artboard sessionId was not found in persisted artboard state');
    }
    report.visualConsistency = await verifySavedPrefabVisualConsistency(args.bridgeUrl, created.sessionId, created.target);
    if (!report.visualConsistency.ok) {
      throw new Error(`saved prefab visual mismatch: ${created.target}`);
    }

    const reloadStartedAt = Date.now();
    await evaluate(cdp, `location.reload();`);
    await waitForExpression(cdp, 'document.readyState === "complete" || document.readyState === "interactive"', 20000);
    const restored = await evaluate(cdp, `(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const deadline = Date.now() + 90000;
      while (Date.now() < deadline) {
        const frame = document.querySelector('[data-testid="remote-snapshot-frame"]');
        const boxes = [...document.querySelectorAll('[data-testid="remote-bbox"]')];
        const status = document.querySelector('[data-testid="remote-status"]')?.textContent || '';
        if (frame && boxes.length > 0) return { bboxCount: boxes.length, status };
        await sleep(300);
      }
      throw new Error('restored artboard did not appear');
    })()`, 100000);
    report.restored = restored;
    report.restored.durationMs = Date.now() - reloadStartedAt;

    const openedExisting = await evaluate(cdp, `(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const interactionDurations = {};
      const durations = {};
      const setValue = (element, value) => {
        const setter = Object.getOwnPropertyDescriptor(element.constructor.prototype, 'value')?.set;
        if (setter) setter.call(element, value);
        else element.value = value;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      };
      const waitStatus = async (needle, timeoutMs = 90000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const text = document.querySelector('[data-testid="remote-status"]')?.textContent || '';
          if (text.includes(needle)) return text;
          if (text.includes('失败') || text.includes('Failed to fetch')) throw new Error('operation failed while waiting for ' + needle + ': ' + text);
          await sleep(16);
        }
        throw new Error('timed out waiting for status: ' + needle);
      };
      const clickAndWaitOperation = async (name, element, ackNeedle, syncNeedle, timeoutMs = 90000) => {
        const startedAt = performance.now();
        element.click();
        const ackStatus = await waitStatus(ackNeedle, 2000);
        interactionDurations[name] = Math.round(performance.now() - startedAt);
        const syncStatus = await waitStatus(syncNeedle, timeoutMs);
        durations[name] = Math.round(performance.now() - startedAt);
        return { ackStatus, syncStatus };
      };
      const search = document.querySelector('[data-testid="remote-prefab-search"]');
      if (!search) throw new Error('prefab search is missing');
      setValue(search, ${JSON.stringify(sampleName)});
      await sleep(800);
      const openButton = [...document.querySelectorAll('button')].find((button) => button.dataset.testid === 'remote-open-' + ${JSON.stringify(sampleName)});
      if (!openButton) throw new Error('open prefab button is missing');
      const status = await clickAndWaitOperation('openExistingArtboard', openButton, '打开 UI...', '已打开 UI');
      const deadline = Date.now() + 90000;
      while (Date.now() < deadline) {
        const boxes = [...document.querySelectorAll('[data-testid="remote-bbox"]')];
        if (boxes.length > 0) return { status, bboxCount: boxes.length, interactionDurationsMs: interactionDurations, operationDurationsMs: durations };
        await sleep(300);
      }
      throw new Error('opened prefab bboxes did not appear');
    })()`, 140000);
    report.openedExisting = openedExisting;

    const insertedAndClosed = await evaluate(cdp, `(async () => {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const interactionDurations = {};
      const durations = {};
      const waitStatus = async (needle, timeoutMs = 90000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const text = document.querySelector('[data-testid="remote-status"]')?.textContent || '';
          if (text.includes(needle)) return text;
          if (text.includes('失败') || text.includes('Failed to fetch')) throw new Error('operation failed while waiting for ' + needle + ': ' + text);
          await sleep(16);
        }
        throw new Error('timed out waiting for status: ' + needle);
      };
      const currentArtboards = () => JSON.parse(localStorage.getItem('uieditor_new_remote_artboards_v1') || '{"artboards":[]}').artboards || [];
      const beforeClosePaths = currentArtboards().map((item) => item.workingPrefabPath).filter(Boolean);
      const frame = document.querySelector('[data-testid="remote-snapshot-frame"]');
      if (!frame) throw new Error('snapshot frame is missing for insert test');
      const beforeBoxes = document.querySelectorAll('[data-testid="remote-bbox"]').length;
      const rect = frame.getBoundingClientRect();
      const transfer = new DataTransfer();
      transfer.setData('application/x-uieditor-prefab', 'UICommons/UIBlueBtn.prefab');
      transfer.setData('text/plain', 'UICommons/UIBlueBtn.prefab');
      const insertStartedAt = performance.now();
      frame.dispatchEvent(new DragEvent('dragover', {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        dataTransfer: transfer
      }));
      frame.dispatchEvent(new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        dataTransfer: transfer
      }));
      const insertAckStatus = await waitStatus('插入 UI已提交', 2000);
      interactionDurations.insertPrefab = Math.round(performance.now() - insertStartedAt);
      const insertStatus = await waitStatus('插入 UI已同步');
      durations.insertPrefab = Math.round(performance.now() - insertStartedAt);
      const insertDeadline = Date.now() + 90000;
      let afterBoxes = beforeBoxes;
      while (Date.now() < insertDeadline) {
        afterBoxes = document.querySelectorAll('[data-testid="remote-bbox"]').length;
        if (afterBoxes > beforeBoxes) break;
        await sleep(250);
      }
      if (afterBoxes <= beforeBoxes) throw new Error('inserted prefab did not add visible bboxes');

      window.confirm = () => true;
      const closeButton = document.querySelector('[data-testid="remote-close-artboard"]');
      if (!closeButton) throw new Error('close button is missing');
      const countBeforeFirstClose = currentArtboards().length;
      const firstCloseStartedAt = performance.now();
      closeButton.click();
      await waitStatus('关闭画板...', 2000);
      interactionDurations.closeExistingArtboard = Math.round(performance.now() - firstCloseStartedAt);
      const firstCloseStatus = await waitStatus('已关闭画板');
      const firstCloseDeadline = Date.now() + 90000;
      while (Date.now() < firstCloseDeadline && currentArtboards().length >= countBeforeFirstClose) {
        await sleep(250);
      }
      durations.closeExistingArtboard = Math.round(performance.now() - firstCloseStartedAt);
      await sleep(400);
      const secondCloseButton = document.querySelector('[data-testid="remote-close-artboard"]');
      let secondCloseStatus = '';
      if (secondCloseButton && !secondCloseButton.disabled) {
        const countBeforeSecondClose = currentArtboards().length;
        const secondCloseStartedAt = performance.now();
        secondCloseButton.click();
        await waitStatus('关闭画板...', 2000);
        interactionDurations.closeNewArtboard = Math.round(performance.now() - secondCloseStartedAt);
        secondCloseStatus = await waitStatus('已关闭画板');
        const secondCloseDeadline = Date.now() + 90000;
        while (Date.now() < secondCloseDeadline && currentArtboards().length >= countBeforeSecondClose) {
          await sleep(250);
        }
        durations.closeNewArtboard = Math.round(performance.now() - secondCloseStartedAt);
      }
      return {
        beforeBoxes,
        afterBoxes,
        interactionDurationsMs: interactionDurations,
        operationDurationsMs: durations,
        insertAckStatus,
        insertStatus,
        firstCloseStatus,
        secondCloseStatus,
        beforeClosePaths,
        remainingArtboards: currentArtboards().length
      };
    })()`, 160000);
    report.insertedAndClosed = insertedAndClosed;

    report.interactionLatency = summarizeDurations({
      created: created.interactionDurationsMs,
      openedExisting: openedExisting.interactionDurationsMs,
      insertedAndClosed: insertedAndClosed.interactionDurationsMs,
    });
    assertLatency(report.interactionLatency, 200, 'interaction');

    report.unityRoundtripLatency = summarizeDurations({
      created: created.operationDurationsMs,
      restored: { reloadRestore: restored.durationMs },
      openedExisting: openedExisting.operationDurationsMs,
      insertedAndClosed: insertedAndClosed.operationDurationsMs,
    });
    assertLatency(report.unityRoundtripLatency, 8000, 'Unity roundtrip');

    report.savedExists = existsSync(path.join(bridgeHealth.projectPath, created.target));
    report.closedTempExistence = insertedAndClosed.beforeClosePaths.map((assetPath) => ({
      assetPath,
      exists: existsSync(path.join(bridgeHealth.projectPath, assetPath)),
    }));
    if (!report.savedExists) {
      throw new Error(`saved prefab was not found after save: ${created.target}`);
    }
    const remainingTemp = report.closedTempExistence.filter((item) => item.exists);
    if (remainingTemp.length > 0) {
      throw new Error(`closed artboard temp prefabs still exist: ${remainingTemp.map((item) => item.assetPath).join(', ')}`);
    }

    report.perfLogs = await evaluate(cdp, `JSON.parse(sessionStorage.getItem('uieditor_new_perf_logs') || '[]')`, 5000).catch(() => []);
    report.perfSummary = summarizePerfLogs(report.perfLogs);
    report.screenshotPath = await screenshot(cdp, path.join(args.out, 'success.png'));
    report.ok = true;
    report.finishedAt = new Date().toISOString();
    await writeFile(path.join(args.out, 'report.json'), JSON.stringify(report, null, 2), 'utf8');

    console.log(JSON.stringify({
      ok: true,
      created: created.target,
      restoredBboxCount: restored.bboxCount,
      openedPrefab: args.prefab,
      openedBboxCount: openedExisting.bboxCount,
      insertedBboxCount: insertedAndClosed.afterBoxes,
      closedTempCount: insertedAndClosed.beforeClosePaths.length,
      maxInteractionMs: report.interactionLatency.maxOperation.durationMs,
      maxUnityRoundtripMs: report.unityRoundtripLatency.maxOperation.durationMs,
      visualSha256Match: report.visualConsistency.ok,
      reportPath: path.join(args.out, 'report.json'),
      screenshotPath: report.screenshotPath,
    }, null, 2));
  } catch (err) {
    report.ok = false;
    report.error = err instanceof Error ? err.stack || err.message : String(err);
    report.finishedAt = new Date().toISOString();
    if (cdp) {
      try {
        report.perfLogs = await evaluate(cdp, `JSON.parse(sessionStorage.getItem('uieditor_new_perf_logs') || '[]')`, 5000).catch(() => []);
        report.perfSummary = summarizePerfLogs(report.perfLogs);
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

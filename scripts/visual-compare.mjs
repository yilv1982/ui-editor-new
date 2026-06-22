import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
let cachedUnityDataAscii = null;

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
    out: path.join(ROOT, '.cache', 'visual-compares', 'latest'),
    reference: '',
    referenceCrop: null,
    editorCrop: 'expected',
    editorCropRect: null,
    pad: 24,
    panelWidth: 560,
    compareHeight: 760,
    diffPad: 0,
    diffWidth: 256,
    diffHeight: 384,
    diffPixelThreshold: 35,
    diffWarnRatio: 0.08,
    aspectWarnThreshold: 0.08,
    drag: false,
    failOnWarnings: false,
    skipProbe: false,
    probeDir: '',
    probeRetries: 1,
    captureReference: false,
    unityProxy: 'http://127.0.0.1:8081/',
    referenceOut: '',
    backgroundColor: '#162d3f',
  };

  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const next = argv[i + 1];
    if (key === '--reference' || key === '--unity' || key === '--unity-shot') { args.reference = path.resolve(next); i++; }
    else if (key === '--reference-crop' || key === '--unity-crop') { args.referenceCrop = parseRect(next, key); i++; }
    else if (key === '--editor-crop') { args.editorCrop = next; i++; }
    else if (key === '--editor-crop-rect') { args.editorCropRect = parseRect(next, key); i++; }
    else if (key === '--pad') { args.pad = Number(next); i++; }
    else if (key === '--panel-width') { args.panelWidth = Number(next); i++; }
    else if (key === '--compare-height') { args.compareHeight = Number(next); i++; }
    else if (key === '--diff-pad') { args.diffPad = Number(next); i++; }
    else if (key === '--diff-width') { args.diffWidth = Number(next); i++; }
    else if (key === '--diff-height') { args.diffHeight = Number(next); i++; }
    else if (key === '--diff-pixel-threshold') { args.diffPixelThreshold = Number(next); i++; }
    else if (key === '--diff-warn-ratio') { args.diffWarnRatio = Number(next); i++; }
    else if (key === '--aspect-warn-threshold') { args.aspectWarnThreshold = Number(next); i++; }
    else if (key === '--drag') args.drag = true;
    else if (key === '--fail-on-warnings') {
      if (next === 'false' || next === '0') { args.failOnWarnings = false; i++; }
      else args.failOnWarnings = true;
    }
    else if (key === '--skip-probe') args.skipProbe = true;
    else if (key === '--probe-retries') { args.probeRetries = Number(next); i++; }
    else if (key === '--capture-reference') args.captureReference = true;
    else if (key === '--unity-proxy') { args.unityProxy = next; i++; }
    else if (key === '--reference-out') { args.referenceOut = path.resolve(next); i++; }
    else if (key === '--background-color') { args.backgroundColor = next; i++; }
    else if (key === '--probe-dir') { args.probeDir = path.resolve(next); i++; }
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
    else if (key === '--out') { args.out = path.resolve(next); i++; }
  }

  if (!args.reference && !args.captureReference) {
    throw new Error('visual-compare requires --reference <unity screenshot png> or --capture-reference');
  }
  if (args.reference && !existsSync(args.reference)) throw new Error(`Reference screenshot not found: ${args.reference}`);
  if (!Number.isFinite(args.pad) || args.pad < 0) args.pad = 24;
  if (!Number.isFinite(args.panelWidth) || args.panelWidth <= 0) args.panelWidth = 560;
  if (!Number.isFinite(args.compareHeight) || args.compareHeight <= 0) args.compareHeight = 760;
  if (!Number.isFinite(args.diffPad) || args.diffPad < 0) args.diffPad = 0;
  if (!Number.isFinite(args.diffWidth) || args.diffWidth <= 0) args.diffWidth = 256;
  if (!Number.isFinite(args.diffHeight) || args.diffHeight <= 0) args.diffHeight = 384;
  if (!Number.isFinite(args.diffPixelThreshold) || args.diffPixelThreshold < 0) args.diffPixelThreshold = 35;
  if (!Number.isFinite(args.diffWarnRatio) || args.diffWarnRatio < 0) args.diffWarnRatio = 0.08;
  if (!Number.isFinite(args.aspectWarnThreshold) || args.aspectWarnThreshold < 0) args.aspectWarnThreshold = 0.08;
  return args;
}

function unionRects(rects) {
  const valid = rects.filter((rect) =>
    rect &&
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width > 0 &&
    rect.height > 0
  );
  if (valid.length === 0) return null;
  const x = Math.min(...valid.map((rect) => rect.x));
  const y = Math.min(...valid.map((rect) => rect.y));
  const right = Math.max(...valid.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...valid.map((rect) => rect.y + rect.height));
  return { x, y, width: right - x, height: bottom - y };
}

function targetGraphicsUnionRect(data) {
  const graphics = Array.isArray(data?.targetGraphics) ? data.targetGraphics : [];
  return unionRects(graphics
    .filter((graphic) => graphic?.activeInHierarchy !== false && graphic?.graphicEnabled !== false)
    .map((graphic) => ({
      x: Number(graphic.rectX),
      y: Number(graphic.rectY),
      width: Number(graphic.rectWidth),
      height: Number(graphic.rectHeight),
    })));
}

function resolveCapturedTargetRect(data) {
  if (data?.rect && Number(data.rect.width) > 0 && Number(data.rect.height) > 0) return data.rect;

  const rawWidth = Number(data?.rectWidth);
  const rawHeight = Number(data?.rectHeight);
  const rawX = Number(data?.rectX);
  const rawY = Number(data?.rectY);
  if (Number.isFinite(rawWidth) && Number.isFinite(rawHeight) && rawWidth > 0 && rawHeight > 0) {
    return {
      x: Number.isFinite(rawX) ? rawX : 0,
      y: Number.isFinite(rawY) ? rawY : 0,
      width: rawWidth,
      height: rawHeight,
    };
  }

  const graphicsRect = targetGraphicsUnionRect(data);
  if (!graphicsRect) return null;
  const hasRawWidth = Number.isFinite(rawWidth) && rawWidth > 0;
  const hasRawHeight = Number.isFinite(rawHeight) && rawHeight > 0;
  return {
    x: hasRawWidth && Number.isFinite(rawX) ? rawX : graphicsRect.x,
    y: hasRawHeight && Number.isFinite(rawY) ? rawY : graphicsRect.y,
    width: hasRawWidth ? rawWidth : graphicsRect.width,
    height: hasRawHeight ? rawHeight : graphicsRect.height,
  };
}

async function captureReference(args) {
  const outputPath = args.referenceOut || path.join(args.out, 'unity-reference.png');
  const url = new URL('/capture-reference', args.unityProxy).toString();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prefabPath: args.prefab,
      width: args.width,
      height: args.height,
      outputPath,
      backgroundColor: args.backgroundColor,
      targetName: args.name,
      targetPath: args.targetPath,
      targetUnityFileId: args.targetUnityFileId,
    }),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Unity capture returned non-JSON response (${res.status}): ${text.slice(0, 300)}`);
  }
  if (!res.ok || !data?.ok) {
    throw new Error(`Unity capture failed (${res.status}): ${data?.error ?? text}`);
  }
  if (data.targetFound === false) {
    throw new Error(`Unity capture could not find target node: ${args.targetPath || args.name}`);
  }
  const capturedPath = path.resolve(data.outputPath || outputPath);
  if (!existsSync(capturedPath)) throw new Error(`Unity capture did not create PNG: ${capturedPath}`);
  const rect = resolveCapturedTargetRect(data);
  return {
    ...data,
    outputPath: capturedPath,
    rect,
    rectSource: data.rect && Number(data.rect.width) > 0 && Number(data.rect.height) > 0
      ? 'target-rect'
      : rect
        ? 'target-graphics-union'
        : 'none',
  };
}

function parseRect(value, flagName) {
  const items = String(value ?? '').split(',').map((item) => Number(item.trim()));
  if (items.length !== 4 || items.some((item) => !Number.isFinite(item))) {
    throw new Error(`${flagName} expects x,y,width,height`);
  }
  return { x: items[0], y: items[1], width: items[2], height: items[3] };
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function finite(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

async function readPngInfo(filePath) {
  const buffer = await readFile(filePath);
  const isPng = buffer.length >= 24
    && buffer[0] === 0x89
    && buffer[1] === 0x50
    && buffer[2] === 0x4e
    && buffer[3] === 0x47;
  if (!isPng) throw new Error(`Only PNG screenshots are supported for now: ${filePath}`);
  return {
    path: filePath,
    mime: 'image/png',
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    dataUri: `data:image/png;base64,${buffer.toString('base64')}`,
  };
}

function clampRect(rect, image, pad = 0) {
  const x = finite(rect.x) - pad;
  const y = finite(rect.y) - pad;
  const right = finite(rect.x) + finite(rect.width) + pad;
  const bottom = finite(rect.y) + finite(rect.height) + pad;
  const clampedX = Math.max(0, Math.min(image.width, x));
  const clampedY = Math.max(0, Math.min(image.height, y));
  const clampedRight = Math.max(clampedX, Math.min(image.width, right));
  const clampedBottom = Math.max(clampedY, Math.min(image.height, bottom));
  return {
    x: round(clampedX),
    y: round(clampedY),
    width: round(clampedRight - clampedX),
    height: round(clampedBottom - clampedY),
  };
}

function normalizeRect(rect) {
  return {
    x: round(finite(rect?.x)),
    y: round(finite(rect?.y)),
    width: round(Math.max(0, finite(rect?.width))),
    height: round(Math.max(0, finite(rect?.height))),
  };
}

function fullImageRect(image) {
  return { x: 0, y: 0, width: image.width, height: image.height };
}

function aspectOfRect(rect) {
  return finite(rect?.width) / Math.max(1, finite(rect?.height));
}

function aspectDelta(editorRect, referenceRect) {
  return round(aspectOfRect(editorRect) - aspectOfRect(referenceRect));
}

function rectFromReport(report, mode, screenshot) {
  if (report?.probe?.expected?.css && mode === 'expected') return canvasRectToPageRect(report, report.probe.expected.css);
  if (report?.probe?.matchingUnityBound && mode === 'unity') return canvasRectToPageRect(report, report.probe.matchingUnityBound);
  if (report?.probe?.pixelScan?.bounds?.css && mode === 'pixel') return canvasRectToPageRect(report, report.probe.pixelScan.bounds.css);
  if (report?.probe?.canvas?.css && mode === 'canvas') return report.probe.canvas.css;
  if (mode === 'viewport') return fullImageRect(screenshot);

  const fallback = report?.probe?.expected?.css
    ?? report?.probe?.matchingUnityBound
    ?? report?.probe?.pixelScan?.bounds?.css
    ?? report?.probe?.canvas?.css;
  if (!fallback) return fullImageRect(screenshot);
  return fallback === report?.probe?.canvas?.css ? fallback : canvasRectToPageRect(report, fallback);
}

function canvasRectToPageRect(report, rect) {
  const canvas = report?.probe?.canvas?.css;
  return {
    x: round(finite(rect?.x) + finite(canvas?.x)),
    y: round(finite(rect?.y) + finite(canvas?.y)),
    width: round(finite(rect?.width)),
    height: round(finite(rect?.height)),
  };
}

function runCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr, code });
      else reject(new Error(`${command} ${args.join(' ')} exited with ${code}\n${stdout}\n${stderr}`));
    });
  });
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

async function waitForStableFile(filePath, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastSize = -1;
  let stableReads = 0;
  while (Date.now() < deadline) {
    try {
      const info = await stat(filePath);
      if (info.size > 0 && info.size === lastSize) {
        stableReads++;
        if (stableReads >= 2) return info;
      } else {
        stableReads = 0;
        lastSize = info.size;
      }
    } catch {}
    await sleep(150);
  }
  throw new Error(`Timed out waiting for file: ${filePath}`);
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

async function createPageTarget(port, url) {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  if (!res.ok) throw new Error(`Cannot create CDP target: ${res.status} ${await res.text()}`);
  return await res.json();
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
  }, Math.max(30000, timeoutMs + 5000));
  if (result.exceptionDetails) {
    const text = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
    throw new Error(text);
  }
  return result.result?.value;
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

async function ensureProbe(args, probeOut) {
  if (args.skipProbe) return;
  await mkdir(probeOut, { recursive: true });
  const probeArgs = [
    path.join(ROOT, 'scripts', 'visual-probe.mjs'),
    '--url', args.url,
    '--prefab', args.prefab,
    '--name', args.name,
    '--width', String(args.width),
    '--height', String(args.height),
    '--threshold', String(args.threshold),
    '--viewport-width', String(args.viewportWidth),
    '--viewport-height', String(args.viewportHeight),
    '--out', probeOut,
    '--clean-screenshot',
  ];
  if (args.pad !== undefined) probeArgs.push('--crop-pad-design', String(args.pad));
  if (args.targetPath) probeArgs.push('--target-path', args.targetPath);
  if (args.targetUnityFileId) probeArgs.push('--target-unity-file-id', args.targetUnityFileId);
  if (!args.drag) probeArgs.push('--no-drag');
  if (args.failOnWarnings) probeArgs.push('--fail-on-warnings');

  const maxAttempts = Math.max(1, 1 + (Number.isFinite(args.probeRetries) ? Math.max(0, Math.floor(args.probeRetries)) : 1));
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await runCommand(process.execPath, probeArgs, { cwd: ROOT });
      return;
    } catch (err) {
      lastError = err;
      if (attempt >= maxAttempts) break;
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
  }
  throw lastError;
}

function fitRect(rect, maxWidth, maxHeight) {
  const width = Math.max(1, finite(rect.width, 1));
  const height = Math.max(1, finite(rect.height, 1));
  const scale = Math.min(maxWidth / width, maxHeight / height);
  return {
    scale,
    width: round(width * scale),
    height: round(height * scale),
  };
}

function escapeXml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function normalizeTargetPath(value) {
  return String(value ?? '')
    .replaceAll('\\', '/')
    .split('/')
    .map((item) => item.trim().replace(/^@/, ''))
    .filter(Boolean)
    .join('/');
}

function fmtNum(value, digits = 2) {
  return Number.isFinite(value) ? String(round(value, digits)) : '?';
}

function fmtRect(rect) {
  if (!rect) return 'n/a';
  return `${fmtNum(rect.width)}x${fmtNum(rect.height)} @ ${fmtNum(rect.x)},${fmtNum(rect.y)}`;
}

function fmtRatioPair(ratio) {
  if (!ratio) return 'n/a';
  return `${fmtNum(ratio.width, 3)}x${fmtNum(ratio.height, 3)}`;
}

function maxRectDelta(a, b) {
  if (!a || !b) return null;
  const deltas = {
    x: Math.abs((a.x ?? 0) - (b.x ?? 0)),
    y: Math.abs((a.y ?? 0) - (b.y ?? 0)),
    width: Math.abs((a.width ?? 0) - (b.width ?? 0)),
    height: Math.abs((a.height ?? 0) - (b.height ?? 0)),
  };
  return {
    ...deltas,
    max: Math.max(deltas.x, deltas.y, deltas.width, deltas.height),
  };
}

function ratioAligned(ratio, tolerance = 0.02) {
  if (!ratio || !Number.isFinite(ratio.width) || !Number.isFinite(ratio.height)) return null;
  return Math.abs(ratio.width - 1) <= tolerance && Math.abs(ratio.height - 1) <= tolerance;
}

function ratioNear(a, b, tolerance = 0.08) {
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance;
}

function validatePreviewContract(report, args) {
  const requested = report?.previewContract?.requested ?? report?.args ?? {};
  const snapshot = report?.probe?.snapshot ?? {};
  const preview = snapshot.preview ?? {};
  const artboard = snapshot.artboard ?? {};
  const errors = [];
  const expected = { width: args.width, height: args.height };
  const checks = [
    ['compare args', { width: args.width, height: args.height }],
    ['probe args', { width: report?.args?.width, height: report?.args?.height }],
    ['previewContract requested', { width: requested.width, height: requested.height }],
    ['snapshot preview', { width: preview.width, height: preview.height }],
    ['snapshot artboard effective', { width: artboard.width, height: artboard.height }],
  ];
  for (const [label, size] of checks) {
    if (Number(size.width) !== expected.width || Number(size.height) !== expected.height) {
      errors.push(`${label}=${size.width}x${size.height}`);
    }
  }
  if (errors.length > 0) {
    throw new Error(`Preview resolution must be ${expected.width}x${expected.height}; mismatched ${errors.join(', ')}`);
  }
}

function targetNotesWithCode(report, code) {
  const notes = Array.isArray(report?.probe?.targetSubtree?.notes)
    ? report.probe.targetSubtree.notes
    : [];
  return notes.filter((note) => note?.code === code);
}

function targetHasNoteCode(report, code) {
  return targetNotesWithCode(report, code).length > 0;
}

function targetNodeHasNoteCode(report, code) {
  const targetId = report?.probe?.target?.id ?? report?.probe?.targetSubtree?.id ?? null;
  const targetPath = normalizeTargetPath(report?.probe?.targetSubtree?.path);
  return targetNotesWithCode(report, code).some((note) => {
    if (targetId && note?.id === targetId) return true;
    if (targetPath && normalizeTargetPath(note?.path) === targetPath) return true;
    return false;
  });
}

function unityGraphicsByPath(capturedReference) {
  const graphics = Array.isArray(capturedReference?.targetGraphics)
    ? capturedReference.targetGraphics
    : [];
  const byPath = new Map();
  for (const graphic of graphics) {
    const key = normalizeTargetPath(graphic?.path);
    if (key) byPath.set(key, graphic);
  }
  return byPath;
}

function resolveUnitySpriteMatches(unresolvedSpriteNotes, capturedReference) {
  if (!Array.isArray(unresolvedSpriteNotes) || unresolvedSpriteNotes.length === 0) {
    return { resolved: [], missing: [], unknown: [] };
  }

  const byPath = unityGraphicsByPath(capturedReference);
  const resolved = [];
  const missing = [];
  const unknown = [];
  for (const note of unresolvedSpriteNotes) {
    const graphic = byPath.get(normalizeTargetPath(note?.path));
    const item = { note, graphic };
    if (!graphic) unknown.push(item);
    else if (graphic.hasSprite === true) resolved.push(item);
    else missing.push(item);
  }
  return { resolved, missing, unknown };
}

function describeSpriteMatches(items, limit = 3) {
  return items.slice(0, limit).map(({ note, graphic }) => {
    const base = note?.path || note?.name || note?.id || graphic?.path || graphic?.name || 'unknown';
    const editorGuid = note?.spriteGuid ? ` prefabGuid=${note.spriteGuid}` : '';
    const unityAsset = graphic?.spriteAssetPath ? ` unityAsset=${graphic.spriteAssetPath}` : '';
    const unityGuid = graphic?.spriteGuid ? ` unityGuid=${graphic.spriteGuid}` : '';
    return `${base}${editorGuid}${unityAsset}${unityGuid}`;
  }).join('; ');
}

function getTargetSubtreeNode(report) {
  const nodes = Array.isArray(report?.probe?.targetSubtree?.nodes)
    ? report.probe.targetSubtree.nodes
    : [];
  const targetId = report?.probe?.target?.id;
  return nodes.find((node) => node?.id && node.id === targetId) ?? nodes[0] ?? null;
}

function describeTextRenderingTarget(report, diagnostics) {
  const nodes = Array.isArray(report?.probe?.targetSubtree?.nodes)
    ? report.probe.targetSubtree.nodes
    : [];
  const targetNode = getTargetSubtreeNode(report);
  const textNodes = targetNode?.type === 'text'
    ? [targetNode]
    : nodes.filter((node) => node?.type === 'text');
  if (textNodes.length === 0) return null;

  const node = textNodes[0];
  const effects = node.textEffects ?? {};
  const style = node.textStyle ?? {};
  const effectParts = [];
  for (const [label, effect] of [
    ['outline', effects.textOutline],
    ['shadow', effects.textShadow],
    ['syncOutline', effects.syncTextOutline],
    ['syncShadow', effects.syncTextShadow],
  ]) {
    if (!effect) continue;
    const source = effect.source || label;
    const styleText = effect.style !== undefined ? ` style=${effect.style}` : '';
    const distance = Array.isArray(effect.distance) ? ` dist=${effect.distance.join(',')}` : '';
    effectParts.push(`${label}:${source}${styleText}${distance}`);
  }
  const font = style.fontPath || style.syncFontPath || 'default font';
  const fontSize = style.fontSize ?? style.syncFontSize ?? '?';
  const effectSummary = effectParts.length > 0 ? effectParts.join('; ') : 'no explicit text effect';
  const nodeSummary = textNodes.length > 1
    ? `${textNodes.length} text nodes, first=${node.path || node.name || node.id || 'text'}`
    : `${node.path || node.name || node.id || 'text'}`;
  const footprint = diagnostics?.pixelToExpectedRatio
    ? ` pixel footprint=${fmtRatioPair(diagnostics.pixelToExpectedRatio)}`
    : '';
  return {
    node,
    summary: `${nodeSummary}; font=${font} size=${fontSize}; ${effectSummary}${footprint}`,
  };
}

function getUnityDataAscii() {
  if (cachedUnityDataAscii !== null) return cachedUnityDataAscii;
  const dataPath = path.join(ROOT, 'public', 'unity', 'Build', 'unity.data');
  if (!existsSync(dataPath)) {
    cachedUnityDataAscii = '';
    return cachedUnityDataAscii;
  }
  cachedUnityDataAscii = readFileSync(dataPath).toString('latin1');
  return cachedUnityDataAscii;
}

function collectTargetTextFonts(report) {
  const nodes = Array.isArray(report?.probe?.targetSubtree?.nodes)
    ? report.probe.targetSubtree.nodes
    : [];
  const fonts = new Map();
  for (const node of nodes) {
    if (node?.type !== 'text') continue;
    const fontPath = node.textStyle?.fontPath || node.textStyle?.syncFontPath;
    if (!fontPath) continue;
    const normalized = String(fontPath).replaceAll('\\', '/');
    fonts.set(normalized, normalized);
  }
  return [...fonts.values()];
}

function inspectWebglFontAvailability(report) {
  const fontPaths = collectTargetTextFonts(report);
  const dataPath = path.join(ROOT, 'public', 'unity', 'Build', 'unity.data');
  const dataExists = existsSync(dataPath);
  const dataText = dataExists ? getUnityDataAscii() : '';
  const fonts = fontPaths.map((fontPath) => {
    const fileName = path.basename(fontPath);
    const stem = fileName.replace(/\.[^.]+$/, '');
    const present = !!dataText && (dataText.includes(fileName) || dataText.includes(stem));
    return { fontPath, fileName, stem, present };
  });
  return {
    dataPath,
    dataExists,
    fonts,
    missing: fonts.filter((font) => font.present === false),
  };
}

function intersectRects(a, b) {
  if (!a || !b) return null;
  const x = Math.max(finite(a.x), finite(b.x));
  const y = Math.max(finite(a.y), finite(b.y));
  const right = Math.min(finite(a.x) + finite(a.width), finite(b.x) + finite(b.width));
  const bottom = Math.min(finite(a.y) + finite(a.height), finite(b.y) + finite(b.height));
  if (right <= x || bottom <= y) return null;
  return { x: round(x), y: round(y), width: round(right - x), height: round(bottom - y) };
}

function rectExtendsOutside(rect, width, height) {
  if (!rect) return false;
  return finite(rect.x) < 0
    || finite(rect.y) < 0
    || finite(rect.x) + finite(rect.width) > width
    || finite(rect.y) + finite(rect.height) > height;
}

function buildClipParity(expectedDesignRect, diagnostics, canvasWidth, canvasHeight) {
  if (!expectedDesignRect || !rectExtendsOutside(expectedDesignRect, canvasWidth, canvasHeight)) return null;
  const visibleDesignRect = intersectRects(expectedDesignRect, { x: 0, y: 0, width: canvasWidth, height: canvasHeight });
  if (!visibleDesignRect) return null;
  const expectedVisibleRatio = {
    width: round(visibleDesignRect.width / Math.max(1, finite(expectedDesignRect.width)), 4),
    height: round(visibleDesignRect.height / Math.max(1, finite(expectedDesignRect.height)), 4),
  };
  const pixelRatio = diagnostics?.pixelToExpectedRatio ?? null;
  return {
    visibleDesignRect,
    expectedVisibleRatio,
    pixelToExpectedRatio: pixelRatio,
    pixelMatchesReferenceClip: ratioNear(pixelRatio?.width, expectedVisibleRatio.width)
      && ratioNear(pixelRatio?.height, expectedVisibleRatio.height),
  };
}

function alphaFromHex(color) {
  if (typeof color !== 'string') return null;
  const match = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(color.trim());
  if (!match) return null;
  return match[2] ? parseInt(match[2], 16) / 255 : 1;
}

function targetLikelyFillsOwnRect(report) {
  const target = report?.probe?.target ?? {};
  const node = report?.probe?.targetSubtree?.nodes?.[0] ?? {};
  const type = String(node.type || target.type || '');
  if (type === 'text') return Boolean(node.text || target.text);
  if (!['image', 'button', 'scrollview', 'rawimage', 'toggle', 'inputfield'].includes(type)) return false;

  const image = node.image && typeof node.image === 'object' ? node.image : {};
  const hasImage = node.hasImage ?? target.hasImage ?? image.hasImage ?? image.syncHasImage;
  if (hasImage === false) return false;
  if (node.imageEnabled === false || target.imageEnabled === false || image.imageEnabled === false || image.syncImageEnabled === false) return false;

  const alpha = alphaFromHex(node.imageColor ?? target.imageColor ?? image.imageColor ?? image.syncImageColor);
  if (alpha === 0) return false;

  return Boolean(
    node.imageData ||
    target.imageData ||
    image.imageData ||
    image.syncImagePath ||
    image.imageHasSprite === true ||
    image.syncImageHasSprite === true ||
    node.imageHasSprite === true ||
    target.imageHasSprite === true ||
    type === 'rawimage',
  );
}

function referenceDiffLooksLayoutDriven(report, analysis) {
  const expected = analysis?.geometry?.expectedDesignRect;
  const unity = analysis?.geometry?.unityReferenceRect;
  if (!expected || !unity) return false;
  if (report?.probe?.target?.type === 'text') return false;
  const expectedCollapsed =
    finite(expected.width) <= 1.5 ||
    finite(expected.height) <= 1.5;
  const unityExpanded =
    finite(unity.width) - finite(expected.width) > 2 ||
    finite(unity.height) - finite(expected.height) > 2;
  return expectedCollapsed && unityExpanded;
}

function geometryIsExpectedReferenceClip(geometry) {
  return geometry?.targetExtendsOutsideReference === true
    && geometry.clipParity?.pixelMatchesReferenceClip === true
    && (!geometry.referenceDesignDelta || geometry.referenceDesignDelta.max <= 2)
    && (!geometry.cssDelta || geometry.cssDelta.max <= 2)
    && ratioAligned(geometry.unityToExpectedRatio) !== false;
}

function cropEditorToVisibleDesign(editorTargetCrop, designTargetRect, canvasWidth, canvasHeight) {
  if (!editorTargetCrop || !designTargetRect || !rectExtendsOutside(designTargetRect, canvasWidth, canvasHeight)) {
    return editorTargetCrop;
  }
  const visibleDesign = intersectRects(designTargetRect, { x: 0, y: 0, width: canvasWidth, height: canvasHeight });
  if (!visibleDesign) return editorTargetCrop;
  const scaleX = finite(editorTargetCrop.width) / Math.max(1, finite(designTargetRect.width));
  const scaleY = finite(editorTargetCrop.height) / Math.max(1, finite(designTargetRect.height));
  return {
    x: round(finite(editorTargetCrop.x) + (visibleDesign.x - finite(designTargetRect.x)) * scaleX),
    y: round(finite(editorTargetCrop.y) + (visibleDesign.y - finite(designTargetRect.y)) * scaleY),
    width: round(visibleDesign.width * scaleX),
    height: round(visibleDesign.height * scaleY),
  };
}

function overlayRectSvg(id, baseCrop, display, rect, color, label) {
  if (!rect || !Number.isFinite(rect.width) || !Number.isFinite(rect.height)) return '';
  const x = (rect.x - baseCrop.x) * display.scale;
  const y = (rect.y - baseCrop.y) * display.scale;
  const width = rect.width * display.scale;
  const height = rect.height * display.scale;
  const outside = x + width < 0 || y + height < 0 || x > display.width || y > display.height;
  if (outside) return '';
  return `
      <rect x="${round(x)}" y="${round(y)}" width="${round(width)}" height="${round(height)}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke"/>
      <text x="${round(Math.max(6, x + 6))}" y="${round(Math.max(18, y + 18))}" fill="${color}" font-size="13" font-family="Consolas, monospace">${escapeXml(label)}</text>`;
}

function imagePanelSvg({ id, title, subtitle, detail, image, crop, display, x, y, overlays = '' }) {
  return `
    <g transform="translate(${x}, ${y})">
      <text x="0" y="-52" fill="#e5e7eb" font-size="18" font-family="Segoe UI, Arial, sans-serif" font-weight="700">${escapeXml(title)}</text>
      <text x="0" y="-31" fill="#cbd5e1" font-size="12" font-family="Consolas, monospace">${escapeXml(subtitle || `${Math.round(crop.width)}x${Math.round(crop.height)} crop @ ${Math.round(crop.x)},${Math.round(crop.y)}`)}</text>
      ${detail ? `<text x="0" y="-12" fill="#94a3b8" font-size="11" font-family="Consolas, monospace">${escapeXml(detail)}</text>` : ''}
      <rect x="-1" y="-1" width="${display.width + 2}" height="${display.height + 2}" rx="4" fill="#111827" stroke="#374151"/>
      <clipPath id="clip-${id}">
        <rect x="0" y="0" width="${display.width}" height="${display.height}" rx="3"/>
      </clipPath>
      <g clip-path="url(#clip-${id})">
        <image href="${image.dataUri}" x="${round(-crop.x * display.scale)}" y="${round(-crop.y * display.scale)}" width="${round(image.width * display.scale)}" height="${round(image.height * display.scale)}"/>
        ${overlays}
      </g>
      <rect x="-1" y="-1" width="${display.width + 2}" height="${display.height + 2}" rx="4" fill="none" stroke="#64748b"/>
    </g>`;
}

function buildAnalysis(report, referenceCrop, editorCrop, visualDiff, args, capturedReference, referenceTargetCrop = referenceCrop, editorTargetCrop = editorCrop) {
  const diagnostics = report?.probe?.diagnostics ?? null;
  const expectedDesignRect = report?.probe?.expected?.design ?? null;
  const unityReferenceRect = capturedReference?.rect ?? null;
  const expectedCssRect = report?.probe?.expected?.css ?? null;
  const expectedPageCssRect = expectedCssRect ? canvasRectToPageRect(report, expectedCssRect) : null;
  const webglBoundCssRect = report?.probe?.matchingUnityBound ?? null;
  const webglBoundPageCssRect = webglBoundCssRect ? canvasRectToPageRect(report, webglBoundCssRect) : null;
  const pixelScanCssRect = report?.probe?.pixelScan?.bounds?.css ?? null;
  const pixelScanPageCssRect = pixelScanCssRect ? canvasRectToPageRect(report, pixelScanCssRect) : null;
  const targetIssues = Array.isArray(report?.probe?.targetSubtree?.issues)
    ? report.probe.targetSubtree.issues
    : [];
  const overlapContext = report?.probe?.targetSubtree?.overlapContext ?? null;
  const aspectDeltaValue = aspectDelta(editorTargetCrop, referenceTargetCrop);
  const paddedAspectDeltaValue = aspectDelta(editorCrop, referenceCrop);
  const referenceDesignDelta = maxRectDelta(expectedDesignRect, unityReferenceRect);
  const cssDelta = maxRectDelta(expectedCssRect, webglBoundCssRect);
  const pageCssDelta = maxRectDelta(expectedPageCssRect, webglBoundPageCssRect);
  const unityRatioAligned = ratioAligned(diagnostics?.unityToExpectedRatio);
  const pixelRatioAligned = ratioAligned(diagnostics?.pixelToExpectedRatio, 0.08);
  const targetExtendsOutsideReference = rectExtendsOutside(expectedDesignRect, args.width, args.height);
  const clipParity = buildClipParity(expectedDesignRect, diagnostics, args.width, args.height);
  const expectedReferenceClip = geometryIsExpectedReferenceClip({
    targetExtendsOutsideReference,
    clipParity,
    referenceDesignDelta,
    cssDelta,
    unityToExpectedRatio: diagnostics?.unityToExpectedRatio ?? null,
  });
  const transparentMaskBoundIncludesContent = targetHasNoteCode(report, 'transparent-mask-bound-includes-content');
  const layoutDrivenTargetBoundDiff = targetNodeHasNoteCode(report, 'layout-driven-bound-diff');
  const targetIsText = report?.probe?.target?.type === 'text'
    || report?.probe?.targetSubtree?.nodes?.[0]?.type === 'text';
  const targetShouldFillRect = targetLikelyFillsOwnRect(report);
  const geometryProblems = [];

  if (targetIssues.length > 0) geometryProblems.push(`targetSubtree issues=${targetIssues.length}`);
  if (referenceDesignDelta && referenceDesignDelta.max > 2 && !layoutDrivenTargetBoundDiff) geometryProblems.push(`unity/design rect delta=${fmtNum(referenceDesignDelta.max)}`);
  if (Math.abs(aspectDeltaValue) > args.aspectWarnThreshold && !layoutDrivenTargetBoundDiff && !targetExtendsOutsideReference) geometryProblems.push(`crop aspect delta=${aspectDeltaValue}`);
  if (diagnostics?.likelyExtraPreviewScale && !expectedReferenceClip) geometryProblems.push(`extra preview scale=${diagnostics.previewScaleFactor}`);
  if (cssDelta && cssDelta.max > 2 && !transparentMaskBoundIncludesContent && !layoutDrivenTargetBoundDiff) geometryProblems.push(`webgl/store css delta=${fmtNum(cssDelta.max)}`);
  if (unityRatioAligned === false && !transparentMaskBoundIncludesContent && !layoutDrivenTargetBoundDiff) geometryProblems.push(`unity/store ratio=${fmtRatioPair(diagnostics?.unityToExpectedRatio)}`);
  if (pixelRatioAligned === false && targetShouldFillRect && !targetIsText && !targetExtendsOutsideReference) geometryProblems.push(`pixel/store ratio=${fmtRatioPair(diagnostics?.pixelToExpectedRatio)}`);

  const geometryStatus = geometryProblems.length
    ? 'mismatch'
    : expectedCssRect && webglBoundCssRect
      ? 'aligned'
      : 'unknown';
  const visualChanged = !!(visualDiff && Number.isFinite(visualDiff.changedRatio) && visualDiff.changedRatio > args.diffWarnRatio);
  const visualStatus = visualChanged
    ? geometryStatus === 'aligned'
      ? 'pixels-differ-geometry-aligned'
      : 'pixels-differ'
    : visualDiff
      ? 'similar'
      : 'not-computed';
  const fontAvailability = inspectWebglFontAvailability(report);

  return {
    coordinateSpaces: {
      referenceCrop: 'Unity reference screenshot pixels. When --capture-reference is used, raw target rect comes from the Unity RectTransform corners.',
      editorCrop: args.editorCrop === 'viewport' || args.editorCrop === 'canvas'
        ? 'Browser page CSS pixels.'
        : 'Browser page CSS pixels converted from canvas-local probe coordinates.',
      design: 'Unity canvas design pixels before browser preview scaling.',
      canvasCss: 'CSS pixels inside the UIEditor canvas element.',
    },
    geometry: {
      status: geometryStatus,
      problems: geometryProblems,
      expectedDesignRect,
      unityReferenceRect,
      referenceDesignDelta,
      expectedCssRect,
      expectedPageCssRect,
      webglBoundCssRect,
      webglBoundPageCssRect,
      pixelScanCssRect,
      pixelScanPageCssRect,
      cssDelta,
      pageCssDelta,
      aspectDelta: aspectDeltaValue,
      paddedAspectDelta: paddedAspectDeltaValue,
      targetExtendsOutsideReference,
      clipParity,
      unityToExpectedRatio: diagnostics?.unityToExpectedRatio ?? null,
      pixelToExpectedRatio: diagnostics?.pixelToExpectedRatio ?? null,
      summary: geometryStatus === 'aligned'
        ? `aligned: design ${fmtRect(expectedDesignRect)}, unity/design delta ${fmtNum(referenceDesignDelta?.max ?? 0)}, webgl/store ratio ${fmtRatioPair(diagnostics?.unityToExpectedRatio)}${clipParity?.pixelMatchesReferenceClip ? ', clipped to visible reference area' : ''}`
        : geometryStatus === 'mismatch'
          ? `mismatch: ${geometryProblems.join('; ')}`
          : 'unknown: missing expected or WebGL runtime bounds',
    },
    visual: {
      status: visualStatus,
      changedRatio: visualDiff?.changedRatio ?? null,
      warnRatio: args.diffWarnRatio,
      summary: visualDiff
        ? `${visualStatus}: changed ${fmtNum(visualDiff.changedRatio * 100, 2)}% of sampled pixels${visualDiff.ignoreBackground ? `, ignored ${fmtNum((visualDiff.ignoredBackgroundRatio ?? 0) * 100, 2)}% transparent-background pixels` : ''}`
        : 'not-computed',
    },
    fontAvailability,
    cropContext: overlapContext,
  };
}

function warningIsExpectedReferenceClip(warning, analysis) {
  const value = String(warning ?? '');
  const geometry = analysis?.geometry;
  if (geometry?.status !== 'aligned' || !geometryIsExpectedReferenceClip(geometry)) return false;
  return /active root node\(s\) extend outside the current artboard and may be clipped/i.test(value)
    || /extra preview scale factor/i.test(value);
}

function buildFindings(report, referenceCrop, editorCrop, visualDiff, args, analysis, capturedReference, referenceTargetCrop = referenceCrop, editorTargetCrop = editorCrop) {
  const transparentMaskBoundIncludesContent = targetHasNoteCode(report, 'transparent-mask-bound-includes-content');
  const layoutDrivenTargetBoundDiff = targetNodeHasNoteCode(report, 'layout-driven-bound-diff');
  const warnings = [
    ...(Array.isArray(report?.probe?.warnings) ? report.probe.warnings : []),
    ...(Array.isArray(report?.probe?.analysis?.warnings) ? report.probe.analysis.warnings : []),
    ...(Array.isArray(report?.postDragProbe?.warnings) ? report.postDragProbe.warnings : []),
  ].filter((warning) => !(
    transparentMaskBoundIncludesContent &&
    /Unity selection bounds differ from expected store bounds/i.test(String(warning ?? ''))
  )).filter((warning) => !(
    layoutDrivenTargetBoundDiff &&
    /Unity selection bounds differ from expected store bounds/i.test(String(warning ?? ''))
  )).filter((warning) => !warningIsExpectedReferenceClip(warning, analysis));
  const targetIssues = Array.isArray(report?.probe?.targetSubtree?.issues)
    ? report.probe.targetSubtree.issues
    : [];
  const expected = report?.probe?.expected?.css;
  const unity = report?.probe?.matchingUnityBound;
  const diagnostics = report?.probe?.diagnostics;
  const overlapNodes = Array.isArray(report?.probe?.targetSubtree?.overlapContext?.nonTargetNodes)
    ? report.probe.targetSubtree.overlapContext.nonTargetNodes
    : [];
  const targetHiddenSkipped = targetNodeHasNoteCode(report, 'hidden-node-skipped');
  const unresolvedSpriteNotes = targetNotesWithCode(report, 'unresolved-sprite-reference');
  const unitySpriteMatches = resolveUnitySpriteMatches(unresolvedSpriteNotes, capturedReference);
  const textRenderingTarget = describeTextRenderingTarget(report, diagnostics);
  const missingFonts = Array.isArray(analysis?.fontAvailability?.missing)
    ? analysis.fontAvailability.missing
    : [];
  const aspectDeltaValue = aspectDelta(editorTargetCrop, referenceTargetCrop);
  const visualChanged = !!(visualDiff && Number.isFinite(visualDiff.changedRatio) && visualDiff.changedRatio > args.diffWarnRatio);
  const findings = [];
  const referenceDiffCanBeSkipped =
    layoutDrivenTargetBoundDiff ||
    targetHasNoteCode(report, 'layout-driven-bound-diff') ||
    analysis?.geometry?.targetExtendsOutsideReference === true ||
    referenceDiffLooksLayoutDriven(report, analysis);
  const requestedPath = normalizeTargetPath(args.targetPath);
  const resolvedReferencePath = normalizeTargetPath(capturedReference?.targetPath);
  if (requestedPath && resolvedReferencePath && requestedPath !== resolvedReferencePath) {
    findings.push(`Unity reference target path resolved to ${resolvedReferencePath}, requested ${requestedPath}`);
  }
  if (warnings.length) findings.push(...warnings);
  if (targetHiddenSkipped) {
    findings.push('Target subtree is hidden or under an inactive ancestor, so the WebGL preview sync skips it. Compare an active parent or skip this inactive target.');
    return [...new Set(findings)];
  }
  if (layoutDrivenTargetBoundDiff) {
    findings.push('Target WebGL bound is layout-driven by ContentSizeFitter/LayoutGroup, so its runtime text bounds can differ from the static store RectTransform. Compare the active parent or keep this single-node case in skipped layout-driven cases.');
  }
  if (targetIssues.length > 0) {
    const preview = targetIssues
      .slice(0, 3)
      .map((item) => `${item.path || item.name || item.id}: ${item.code || item.message}`)
      .join('; ');
    findings.push(`Target subtree has ${targetIssues.length} visual sync issue(s): ${preview}`);
  }
  if (visualChanged && overlapNodes.length > 0) {
    const preview = overlapNodes
      .slice(0, 3)
      .map((item) => `${item.path || item.name || item.id} (${item.type || 'node'})`)
      .join('; ');
    findings.push(`Visual diff changed ${Math.round(visualDiff.changedRatio * 10000) / 100}% and target crop overlaps ${overlapNodes.length} renderable node(s) outside the selected subtree: ${preview}`);
  }
  if (overlapNodes.length === 0 && Math.abs(aspectDeltaValue) > args.aspectWarnThreshold && !analysis?.geometry?.targetExtendsOutsideReference && !referenceDiffCanBeSkipped) findings.push(`Reference/editor crop aspect differs by ${aspectDeltaValue}`);
  if (overlapNodes.length === 0 && analysis?.geometry?.referenceDesignDelta?.max > 2) {
    if (referenceDiffCanBeSkipped) {
      findings.push(`Unity reference rect differs from UIEditor design by ${fmtNum(analysis.geometry.referenceDesignDelta.max)} design px on a layout-driven or clipped target. Keep this case in skipped capability-gap reports until UIEditor implements full Unity LayoutGroup/ContentSizeFitter preferred-size simulation.`);
    } else {
      findings.push(`Unity reference rect differs from UIEditor design by ${fmtNum(analysis.geometry.referenceDesignDelta.max)} design px`);
    }
  }
  if (visualChanged && overlapNodes.length === 0) {
    const percent = Math.round(visualDiff.changedRatio * 10000) / 100;
    if (analysis?.geometry?.status === 'aligned' && textRenderingTarget && missingFonts.length > 0) {
      const fonts = missingFonts.map((font) => `${font.fontPath} (${font.fileName})`).join('; ');
      findings.push(`Visual diff changed ${percent}% with geometry aligned on text rendering; WebGL build is missing font(s): ${fonts}. ${textRenderingTarget.summary}. Rebuild or replace the WebGL preview font bundle before changing RectTransform math.`);
    } else if (analysis?.geometry?.status === 'aligned' && textRenderingTarget) {
      findings.push(`Visual diff changed ${percent}% with geometry aligned on text rendering: ${textRenderingTarget.summary}. Check font loading, UIShadow/outline preview, and text effect order before changing RectTransform math.`);
    } else if (analysis?.geometry?.status === 'aligned' && unresolvedSpriteNotes.length > 0) {
      if (unitySpriteMatches.resolved.length > 0) {
        findings.push(`Visual diff changed ${percent}% with geometry aligned; Unity resolves ${unitySpriteMatches.resolved.length} sprite(s) that UIEditor did not map to imagePath: ${describeSpriteMatches(unitySpriteMatches.resolved)}`);
      }
      if (unitySpriteMatches.missing.length > 0 || unitySpriteMatches.unknown.length > 0 || unitySpriteMatches.resolved.length === 0) {
        const pending = [...unitySpriteMatches.missing, ...unitySpriteMatches.unknown];
        const preview = pending.length > 0
          ? describeSpriteMatches(pending)
          : unresolvedSpriteNotes
            .slice(0, 3)
            .map((note) => `${note.path || note.name || note.id}${note.spriteGuid ? ` guid=${note.spriteGuid}` : ''}`)
            .join('; ');
        findings.push(`Visual diff changed ${percent}% with geometry aligned and ${unresolvedSpriteNotes.length} unresolved sprite reference(s): ${preview}`);
      }
    } else if (
      analysis?.geometry?.status === 'aligned'
      && analysis?.geometry?.targetExtendsOutsideReference === true
      && (!analysis?.geometry?.referenceDesignDelta || analysis.geometry.referenceDesignDelta.max <= 2)
    ) {
      const ratio = analysis?.geometry?.clipParity?.expectedVisibleRatio;
      const ratioText = ratio ? ` visible ratio ${fmtRatioPair(ratio)}` : '';
      findings.push(`Visual diff changed ${percent}% on a clipped artboard edge with geometry aligned; target extends outside the ${args.width}x${args.height} preview${ratioText}. Compare the active parent or skip this edge-clipped target before changing RectTransform math.`);
    } else if (referenceDiffCanBeSkipped) {
      findings.push(`Visual diff changed ${percent}% on a layout-driven reference crop. Keep this case skipped until UIEditor can reproduce Unity runtime layout preferred sizes.`);
    } else {
      const suffix = analysis?.geometry?.status === 'aligned'
        ? '; geometry aligned, inspect content/assets/text/runtime state'
        : '';
      findings.push(`Visual diff changed ${percent}% of sampled pixels (threshold ${args.diffPixelThreshold})${suffix}`);
    }
  }
  if (diagnostics?.likelyExtraPreviewScale && !geometryIsExpectedReferenceClip(analysis?.geometry)) {
    findings.push(`Likely extra preview scale: ${diagnostics.previewScaleFactor}`);
  }
  if (expected && unity && !transparentMaskBoundIncludesContent && !layoutDrivenTargetBoundDiff) {
    const dw = Math.abs(unity.width - expected.width);
    const dh = Math.abs(unity.height - expected.height);
    if (dw > 2 || dh > 2) findings.push(`Unity bound differs from store expected by ${round(dw)}x${round(dh)} css px`);
  }
  return [...new Set(findings)];
}

function buildComparisonSvg(args, reference, editor, referenceCrop, editorCrop, report, findings, visualDiff, analysis) {
  const left = fitRect(referenceCrop, args.panelWidth, args.compareHeight);
  const right = fitRect(editorCrop, args.panelWidth, args.compareHeight);
  const gap = 32;
  const margin = 28;
  const header = 150;
  const footer = 124;
  const width = Math.ceil(margin * 2 + left.width + gap + right.width);
  const imageHeight = Math.ceil(Math.max(left.height, right.height));
  const height = Math.ceil(header + imageHeight + footer);
  const rightX = margin + left.width + gap;
  const imageY = header;

  const editorOverlays = [
    overlayRectSvg('expected', editorCrop, right, report?.probe?.expected?.css ? canvasRectToPageRect(report, report.probe.expected.css) : null, '#22c55e', 'expected'),
    overlayRectSvg('unity', editorCrop, right, report?.probe?.matchingUnityBound ? canvasRectToPageRect(report, report.probe.matchingUnityBound) : null, '#38bdf8', 'webgl bound'),
    overlayRectSvg('pixel', editorCrop, right, report?.probe?.pixelScan?.bounds?.css ? canvasRectToPageRect(report, report.probe.pixelScan.bounds.css) : null, '#f59e0b', 'pixel scan'),
  ].join('');
  const findingText = findings.length ? findings.slice(0, 4).join(' | ') : 'No runtime warnings from current probe';
  const target = report?.probe?.target;
  const diag = report?.probe?.diagnostics;
  const designRect = analysis?.geometry?.expectedDesignRect;
  const geometrySummary = analysis?.geometry?.summary ?? 'geometry=n/a';
  const visualSummary = analysis?.visual?.summary ?? 'visual=n/a';

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#0f172a"/>
  <text x="${margin}" y="34" fill="#f8fafc" font-size="22" font-family="Segoe UI, Arial, sans-serif" font-weight="700">${escapeXml(args.prefab)} / ${escapeXml(args.name)}</text>
  <text x="${margin}" y="60" fill="#cbd5e1" font-size="13" font-family="Consolas, monospace">${escapeXml(`target=${target?.name ?? args.name}, design rect=${fmtRect(designRect)}, preview=${args.width}x${args.height}`)}</text>
  <text x="${margin}" y="82" fill="#94a3b8" font-size="12" font-family="Consolas, monospace">${escapeXml(`${geometrySummary}; ${visualSummary}`)}</text>
  ${imagePanelSvg({
    id: 'reference',
    title: 'Unity reference',
    subtitle: `Unity screenshot crop: ${fmtRect(referenceCrop)} px`,
    detail: 'left numbers are screenshot/design pixels',
    image: reference,
    crop: referenceCrop,
    display: left,
    x: margin,
    y: imageY,
  })}
  ${imagePanelSvg({
    id: 'editor',
    title: 'UIEditor WebGL',
    subtitle: `Browser page crop: ${fmtRect(editorCrop)} CSS px`,
    detail: 'right numbers are browser CSS pixels after preview scaling',
    image: editor,
    crop: editorCrop,
    display: right,
    x: rightX,
    y: imageY,
    overlays: editorOverlays,
  })}
  <g transform="translate(${margin}, ${height - footer + 26})">
    <text x="0" y="0" fill="#e5e7eb" font-size="14" font-family="Segoe UI, Arial, sans-serif" font-weight="700">Probe summary</text>
    <text x="0" y="24" fill="#cbd5e1" font-size="12" font-family="Consolas, monospace">${escapeXml(findingText)}</text>
    <text x="0" y="48" fill="#94a3b8" font-size="12" font-family="Consolas, monospace">${escapeXml(`unity/store ratio=${JSON.stringify(diag?.unityToExpectedRatio ?? null)} pixel/store ratio=${JSON.stringify(diag?.pixelToExpectedRatio ?? null)} visualDiff=${visualDiff ? `${Math.round(visualDiff.changedRatio * 10000) / 100}%` : 'n/a'}`)}</text>
    <text x="0" y="70" fill="#64748b" font-size="11" font-family="Consolas, monospace">${escapeXml('overlay: green=store expected, blue=WebGL runtime bound, orange=visible pixel scan')}</text>
  </g>
</svg>
`;
  return { svg, width, height };
}

async function renderHtmlToPng(htmlPath, pngPath, width, height, outDir) {
  const chrome = findChrome();
  const profile = path.join(os.tmpdir(), `uieditor-visual-compare-chrome-${process.pid}-${Date.now()}`);
  await mkdir(profile, { recursive: true });
  const fileUrl = `file:///${htmlPath.replaceAll('\\', '/')}`;
  let chromeProc = null;
  try {
    chromeProc = spawn(chrome, [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${profile}`,
      `--window-size=${Math.ceil(width)},${Math.ceil(height)}`,
      `--screenshot=${pngPath}`,
      fileUrl,
    ], {
      cwd: outDir,
      stdio: 'ignore',
      windowsHide: true,
    });
    const closePromise = new Promise((resolve) => {
      chromeProc.once('close', (code) => resolve({ type: 'close', code }));
      chromeProc.once('error', (error) => resolve({ type: 'error', error }));
    });
    const result = await Promise.race([
      closePromise,
      waitForStableFile(pngPath, 25000).then(() => ({ type: 'file', code: 0 })),
    ]);
    if (result.type === 'error') throw result.error;
    if (result.type === 'close' && result.code !== 0 && !existsSync(pngPath)) {
      throw new Error(`Chrome screenshot exited with ${result.code}`);
    }
    await waitForStableFile(pngPath, 5000);
  } finally {
    await stopProcess(chromeProc);
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

function shouldIgnoreBackgroundForVisualDiff(report) {
  const nodes = Array.isArray(report?.probe?.targetSubtree?.nodes)
    ? report.probe.targetSubtree.nodes
    : [];
  if (nodes.length !== 1) return false;
  const root = nodes[0];
  return root?.type === 'text' && !root?.image?.imageData;
}

async function computeVisualDiff(args, reference, editor, referenceCrop, editorCrop, outDir, options = {}) {
  const chrome = findChrome();
  const port = await getFreePort();
  const profile = path.join(os.tmpdir(), `uieditor-visual-diff-chrome-${process.pid}-${Date.now()}`);
  await mkdir(profile, { recursive: true });
  const width = Math.max(1, Math.round(args.diffWidth));
  const height = Math.max(1, Math.round(args.diffHeight));
  const chromeProc = spawn(chrome, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    '--force-device-scale-factor=1',
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
  ], {
    cwd: outDir,
    stdio: 'ignore',
    windowsHide: true,
  });

  let cdp;
  try {
    await waitForJson(`http://127.0.0.1:${port}/json/version`, 15000);
    const target = await createPageTarget(port, 'about:blank');
    cdp = new CdpClient(target.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Runtime.enable');

    const expression = `(${async function diffImages(input) {
      const loadImage = (src) => new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('image load failed'));
        img.src = src;
      });
      const [ref, ed] = await Promise.all([loadImage(input.referenceDataUri), loadImage(input.editorDataUri)]);
      const makeCanvas = () => {
        const canvas = document.createElement('canvas');
        canvas.width = input.width;
        canvas.height = input.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        return { canvas, ctx };
      };
      const refCanvas = makeCanvas();
      const edCanvas = makeCanvas();
      refCanvas.ctx.drawImage(ref, input.referenceCrop.x, input.referenceCrop.y, input.referenceCrop.width, input.referenceCrop.height, 0, 0, input.width, input.height);
      edCanvas.ctx.drawImage(ed, input.editorCrop.x, input.editorCrop.y, input.editorCrop.width, input.editorCrop.height, 0, 0, input.width, input.height);
      const refData = refCanvas.ctx.getImageData(0, 0, input.width, input.height).data;
      const edData = edCanvas.ctx.getImageData(0, 0, input.width, input.height).data;
      const sampleBackground = (data) => {
        const points = [
          [1, 1],
          [input.width - 2, 1],
          [1, input.height - 2],
          [input.width - 2, input.height - 2],
          [Math.floor(input.width / 2), 1],
          [Math.floor(input.width / 2), input.height - 2],
          [1, Math.floor(input.height / 2)],
          [input.width - 2, Math.floor(input.height / 2)],
        ];
        const colors = points.map(([x, y]) => {
          const safeX = Math.max(0, Math.min(input.width - 1, x));
          const safeY = Math.max(0, Math.min(input.height - 1, y));
          const idx = (safeY * input.width + safeX) * 4;
          return [data[idx], data[idx + 1], data[idx + 2], data[idx + 3]];
        });
        const median = (channel) => colors
          .map((color) => color[channel])
          .sort((a, b) => a - b)[Math.floor(colors.length / 2)];
        return [median(0), median(1), median(2), median(3)];
      };
      const colorDistance = (data, i, bg) => Math.max(
        Math.abs(data[i] - bg[0]),
        Math.abs(data[i + 1] - bg[1]),
        Math.abs(data[i + 2] - bg[2]),
        Math.abs(data[i + 3] - bg[3]),
      );
      const ignoreBackground = !!input.ignoreBackground;
      const backgroundTolerance = Number.isFinite(input.backgroundTolerance) ? input.backgroundTolerance : 18;
      const refBg = ignoreBackground ? sampleBackground(refData) : null;
      const edBg = ignoreBackground ? sampleBackground(edData) : null;
      const diffCanvas = document.createElement('canvas');
      diffCanvas.width = input.width;
      diffCanvas.height = input.height;
      const diffCtx = diffCanvas.getContext('2d', { willReadFrequently: true });
      const diffImage = diffCtx.createImageData(input.width, input.height);
      let changed = 0;
      let sumAbs = 0;
      let sumSq = 0;
      let maxDelta = 0;
      let ignoredBackgroundPixels = 0;
      const threshold = input.pixelThreshold;
      const total = input.width * input.height;
      for (let i = 0; i < refData.length; i += 4) {
        if (
          ignoreBackground &&
          colorDistance(refData, i, refBg) <= backgroundTolerance &&
          colorDistance(edData, i, edBg) <= backgroundTolerance
        ) {
          ignoredBackgroundPixels++;
          diffImage.data[i] = 0;
          diffImage.data[i + 1] = 0;
          diffImage.data[i + 2] = 0;
          diffImage.data[i + 3] = 0;
          continue;
        }
        const dr = Math.abs(refData[i] - edData[i]);
        const dg = Math.abs(refData[i + 1] - edData[i + 1]);
        const db = Math.abs(refData[i + 2] - edData[i + 2]);
        const da = Math.abs(refData[i + 3] - edData[i + 3]);
        const delta = Math.max(dr, dg, db, da);
        const rgbMean = (dr + dg + db) / 3;
        if (delta > threshold) changed++;
        sumAbs += rgbMean;
        sumSq += dr * dr + dg * dg + db * db;
        if (delta > maxDelta) maxDelta = delta;
        const heat = Math.min(255, Math.round(delta * 1.6));
        diffImage.data[i] = heat;
        diffImage.data[i + 1] = delta > threshold ? Math.max(0, 80 - heat / 4) : 0;
        diffImage.data[i + 2] = delta > threshold ? 0 : heat;
        diffImage.data[i + 3] = delta > threshold ? 255 : Math.min(130, heat);
      }
      diffCtx.putImageData(diffImage, 0, 0);
      return {
        width: input.width,
        height: input.height,
        pixelThreshold: threshold,
        changedPixels: changed,
        totalPixels: total,
        comparedPixels: total - ignoredBackgroundPixels,
        ignoredBackgroundPixels,
        ignoredBackgroundRatio: Math.round((ignoredBackgroundPixels / total) * 10000) / 10000,
        ignoreBackground,
        referenceBackground: refBg,
        editorBackground: edBg,
        changedRatio: Math.round((changed / total) * 10000) / 10000,
        meanAbsRgb: Math.round((sumAbs / total) * 100) / 100,
        rmseRgb: Math.round(Math.sqrt(sumSq / (total * 3)) * 100) / 100,
        maxChannelDelta: maxDelta,
        heatmapDataUri: diffCanvas.toDataURL('image/png'),
      };
    }})(${JSON.stringify({
      referenceDataUri: reference.dataUri,
      editorDataUri: editor.dataUri,
      referenceCrop,
      editorCrop,
      width,
      height,
      pixelThreshold: args.diffPixelThreshold,
      ignoreBackground: !!options.ignoreBackground,
      backgroundTolerance: options.backgroundTolerance ?? 18,
    })})`;
    return await evaluate(cdp, expression, 60000);
  } finally {
    cdp?.close();
    await stopProcess(chromeProc);
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

async function writeDataUriPng(dataUri, filePath) {
  const match = /^data:image\/png;base64,(.+)$/.exec(String(dataUri ?? ''));
  if (!match) return false;
  await writeFile(filePath, Buffer.from(match[1], 'base64'));
  return true;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await mkdir(args.out, { recursive: true });
  let capturedReference = null;
  if (args.captureReference) {
    capturedReference = await captureReference(args);
    args.reference = capturedReference.outputPath;
  }
  const probeOut = args.probeDir || path.join(args.out, 'uieditor');
  await ensureProbe(args, probeOut);

  const reportPath = path.join(probeOut, 'report.json');
  const editorShotPath = path.join(probeOut, 'viewport.png');
  if (!existsSync(reportPath)) throw new Error(`Missing probe report: ${reportPath}`);
  if (!existsSync(editorShotPath)) throw new Error(`Missing probe screenshot: ${editorShotPath}`);

  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  const reference = await readPngInfo(args.reference);
  const editor = await readPngInfo(editorShotPath);
  validatePreviewContract(report, args);

  const referenceTargetCrop = args.referenceCrop
    ? normalizeRect(args.referenceCrop)
    : capturedReference?.rect
      ? normalizeRect(capturedReference.rect)
      : fullImageRect(reference);
  const rawEditorCrop = args.editorCropRect ?? rectFromReport(report, args.editorCrop, editor);
  const editorVisibleTargetCrop = cropEditorToVisibleDesign(rawEditorCrop, report?.probe?.expected?.design, args.width, args.height);
  const rawReferenceCrop = clampRect(referenceTargetCrop, reference, 0);
  const referenceCrop = clampRect(referenceTargetCrop, reference, args.pad);
  const editorCrop = clampRect(editorVisibleTargetCrop, editor, args.pad);
  const referenceDiffCrop = clampRect(referenceTargetCrop, reference, args.diffPad);
  const editorDiffCrop = clampRect(editorVisibleTargetCrop, editor, args.diffPad);
  const ignoreBackground = shouldIgnoreBackgroundForVisualDiff(report);
  const visualDiff = await computeVisualDiff(args, reference, editor, referenceDiffCrop, editorDiffCrop, args.out, { ignoreBackground });
  if (visualDiff) {
    visualDiff.referenceCrop = referenceDiffCrop;
    visualDiff.editorCrop = editorDiffCrop;
  }
  const visualDiffHeatmapPath = path.join(args.out, 'visual-diff.png');
  if (visualDiff?.heatmapDataUri) {
    await writeDataUriPng(visualDiff.heatmapDataUri, visualDiffHeatmapPath);
    delete visualDiff.heatmapDataUri;
    visualDiff.heatmapPath = visualDiffHeatmapPath;
  }
  const analysis = buildAnalysis(report, referenceCrop, editorCrop, visualDiff, args, capturedReference, referenceTargetCrop, rawEditorCrop);
  const findings = buildFindings(report, referenceCrop, editorCrop, visualDiff, args, analysis, capturedReference, referenceTargetCrop, rawEditorCrop);

  const { svg, width: svgWidth, height: svgHeight } = buildComparisonSvg(args, reference, editor, referenceCrop, editorCrop, report, findings, visualDiff, analysis);
  const comparisonPath = path.join(args.out, 'comparison.svg');
  const comparisonPngPath = path.join(args.out, 'comparison.png');
  const htmlPath = path.join(args.out, 'comparison.html');
  const compareReportPath = path.join(args.out, 'compare-report.json');
  let pngError = null;

  await writeFile(comparisonPath, svg, 'utf8');
  await writeFile(htmlPath, `<!doctype html>
<meta charset="utf-8">
<title>UIEditor visual compare</title>
<style>body{margin:0;background:#0f172a}img{display:block;max-width:100vw;height:auto}</style>
<img src="comparison.svg" alt="UIEditor visual comparison">
`, 'utf8');
  try {
    await renderHtmlToPng(htmlPath, comparisonPngPath, svgWidth, svgHeight, args.out);
  } catch (err) {
    pngError = err instanceof Error ? err.message : String(err);
  }
  await writeFile(compareReportPath, JSON.stringify({
    args,
    capturedAt: new Date().toISOString(),
    paths: {
      comparison: comparisonPath,
      comparisonPng: pngError ? null : comparisonPngPath,
      html: htmlPath,
      report: compareReportPath,
      probeReport: reportPath,
      editorScreenshot: editorShotPath,
      referenceScreenshot: args.reference,
      visualDiffHeatmap: visualDiff?.heatmapPath ?? null,
    },
    render: {
      svgWidth,
      svgHeight,
      pngError,
    },
    reference: {
      image: { width: reference.width, height: reference.height },
      targetCrop: referenceTargetCrop,
      visibleTargetCrop: rawReferenceCrop,
      crop: referenceCrop,
      captured: capturedReference,
    },
    editor: {
      image: { width: editor.width, height: editor.height },
      cropMode: args.editorCrop,
      targetCrop: rawEditorCrop,
      visibleTargetCrop: editorVisibleTargetCrop,
      crop: editorCrop,
      coordinateSpace: args.editorCrop === 'viewport' || args.editorCrop === 'canvas'
        ? 'page'
        : 'page, converted from canvas-local probe coordinates',
    },
    analysis,
    visualDiff,
    findings,
    probe: {
      warnings: report?.probe?.warnings ?? [],
      analysisWarnings: report?.probe?.analysis?.warnings ?? [],
      diagnostics: report?.probe?.diagnostics ?? null,
      expected: report?.probe?.expected ?? null,
      expectedPageCss: report?.probe?.expected?.css ? canvasRectToPageRect(report, report.probe.expected.css) : null,
      matchingUnityBound: report?.probe?.matchingUnityBound ?? null,
      matchingUnityBoundPageCss: report?.probe?.matchingUnityBound ? canvasRectToPageRect(report, report.probe.matchingUnityBound) : null,
      pixelScan: report?.probe?.pixelScan ?? null,
      pixelScanPageCss: report?.probe?.pixelScan?.bounds?.css ? canvasRectToPageRect(report, report.probe.pixelScan.bounds.css) : null,
      targetSubtree: report?.probe?.targetSubtree ?? null,
    },
  }, null, 2), 'utf8');

  const summary = {
    comparisonPath,
    comparisonPngPath: pngError ? null : comparisonPngPath,
    htmlPath,
    compareReportPath,
    probeReportPath: reportPath,
    editorScreenshotPath: editorShotPath,
    findings,
    visualDiff,
    visualDiffHeatmapPath: visualDiff?.heatmapPath ?? null,
    pngError,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (args.failOnWarnings && findings.length > 0) process.exitCode = 2;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

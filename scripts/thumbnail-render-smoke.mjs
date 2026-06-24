import { inflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const THUMBNAIL_SIZE = 256;

function parseArgs(argv) {
  const args = {
    bridgeUrl: 'http://127.0.0.1:18082',
    out: path.join(ROOT, '.cache', 'thumbnail-render-smoke', 'latest'),
    samples: ['UICommons/UIBlueBtn.prefab', 'UICommons/UIAlert2.prefab'],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const next = argv[i + 1];
    if (key === '--bridge-url') { args.bridgeUrl = next; i += 1; }
    else if (key === '--out') { args.out = path.resolve(next); i += 1; }
    else if (key === '--sample') { args.samples.push(next); i += 1; }
  }
  return args;
}

function normalizeBaseUrl(value) {
  return value.replace(/\/+$/, '');
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

async function bridgeGetJson(bridgeUrl, endpoint) {
  const res = await fetch(`${normalizeBaseUrl(bridgeUrl)}${endpoint}`, { cache: 'no-store' });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok) throw new Error(`${endpoint} failed: ${res.status} ${JSON.stringify(data)}`);
  return data;
}

function readUInt32(buffer, offset) {
  return buffer.readUInt32BE(offset);
}

function decodePng(buffer) {
  const signature = '89504e470d0a1a0a';
  if (buffer.subarray(0, 8).toString('hex') !== signature) throw new Error('not a PNG');
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (offset < buffer.length) {
    const length = readUInt32(buffer, offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === 'IHDR') {
      width = readUInt32(data, 0);
      height = readUInt32(data, 4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }
  if (bitDepth !== 8 || ![2, 6].includes(colorType)) {
    throw new Error(`unsupported PNG format bitDepth=${bitDepth} colorType=${colorType}`);
  }
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(width * height * 4);
  let rawOffset = 0;
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[rawOffset++];
    const scan = Buffer.from(raw.subarray(rawOffset, rawOffset + stride));
    rawOffset += stride;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? scan[x - channels] : 0;
      const up = prev[x] ?? 0;
      const upLeft = x >= channels ? prev[x - channels] : 0;
      if (filter === 1) scan[x] = (scan[x] + left) & 255;
      else if (filter === 2) scan[x] = (scan[x] + up) & 255;
      else if (filter === 3) scan[x] = (scan[x] + Math.floor((left + up) / 2)) & 255;
      else if (filter === 4) scan[x] = (scan[x] + paeth(left, up, upLeft)) & 255;
      else if (filter !== 0) throw new Error(`unsupported PNG filter ${filter}`);
    }
    for (let x = 0; x < width; x += 1) {
      const src = x * channels;
      const dst = (y * width + x) * 4;
      pixels[dst] = scan[src];
      pixels[dst + 1] = scan[src + 1];
      pixels[dst + 2] = scan[src + 2];
      pixels[dst + 3] = channels === 4 ? scan[src + 3] : 255;
    }
    prev = scan;
  }
  return { width, height, pixels };
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function colorAlpha(summary) {
  const color = typeof summary?.color === 'string' ? summary.color.trim() : '';
  if (/^#[0-9a-fA-F]{8}$/.test(color)) return parseInt(color.slice(7, 9), 16) / 255;
  return 1;
}

function nonEmptyText(summary) {
  const text = typeof summary?.text === 'string' ? summary.text : '';
  return text.trim().length > 0;
}

function hasVisualComponent(node) {
  if (!node) return false;
  return (node.components ?? []).some((component) => {
    if (!component.enabled) return false;
    const type = String(component.type ?? '').toLowerCase();
    if (colorAlpha(component.summary) <= 0.01) return false;
    return type === 'image' ||
      type === 'rawimage' ||
      ((type === 'text' || type.includes('textmeshpro')) && nonEmptyText(component.summary)) ||
      type === 'outline' ||
      type === 'shadow';
  });
}

function usableBboxes(snapshot) {
  const boxes = (snapshot.bboxes ?? []).filter((box) => (
    box.activeInHierarchy &&
    box.width > 1 &&
    box.height > 1 &&
    Number.isFinite(box.x) &&
    Number.isFinite(box.y) &&
    Number.isFinite(box.width) &&
    Number.isFinite(box.height)
  ));
  if (boxes.length <= 1) return boxes;
  return boxes.filter((box) => !(box.width >= snapshot.width * 0.96 && box.height >= snapshot.height * 0.96));
}

function visualBboxes(snapshot, nodes) {
  const boxes = usableBboxes(snapshot);
  if (!nodes?.length) return boxes;
  const nodeById = new Map(nodes.map((node) => [node.nodeId, node]));
  const visual = boxes.filter((box) => hasVisualComponent(nodeById.get(box.nodeId)));
  return visual.length > 0 ? visual : boxes;
}

function expandCropToSquare(crop, maxWidth, maxHeight) {
  const side = Math.min(Math.max(crop.width, crop.height), Math.max(maxWidth, maxHeight));
  const centerX = crop.x + crop.width / 2;
  const centerY = crop.y + crop.height / 2;
  let x = Math.round(centerX - side / 2);
  let y = Math.round(centerY - side / 2);
  let width = side;
  let height = side;
  if (width > maxWidth) {
    width = maxWidth;
    x = 0;
  } else {
    x = Math.max(0, Math.min(maxWidth - width, x));
  }
  if (height > maxHeight) {
    height = maxHeight;
    y = 0;
  } else {
    y = Math.max(0, Math.min(maxHeight - height, y));
  }
  return { x, y, width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
}

function cropForSnapshot(snapshot, nodes) {
  const boxes = visualBboxes(snapshot, nodes);
  if (boxes.length === 0) return { x: 0, y: 0, width: snapshot.width, height: snapshot.height };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const box of boxes) {
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.width);
    maxY = Math.max(maxY, box.y + box.height);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return { x: 0, y: 0, width: snapshot.width, height: snapshot.height };
  }
  const contentW = Math.max(1, maxX - minX);
  const contentH = Math.max(1, maxY - minY);
  const padding = Math.max(8, Math.min(32, Math.max(contentW, contentH) * 0.08));
  const x = Math.max(0, Math.floor(minX - padding));
  const y = Math.max(0, Math.floor(minY - padding));
  const right = Math.min(snapshot.width, Math.ceil(maxX + padding));
  const bottom = Math.min(snapshot.height, Math.ceil(maxY + padding));
  return expandCropToSquare({ x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) }, snapshot.width, snapshot.height);
}

function cropContainsBoxes(crop, boxes) {
  return boxes.every((box) => (
    box.x >= crop.x - 1 &&
    box.y >= crop.y - 1 &&
    box.x + box.width <= crop.x + crop.width + 1 &&
    box.y + box.height <= crop.y + crop.height + 1
  ));
}

function pixelStats(image, crop) {
  const x0 = Math.max(0, Math.floor(crop.x));
  const y0 = Math.max(0, Math.floor(crop.y));
  const x1 = Math.min(image.width, Math.ceil(crop.x + crop.width));
  const y1 = Math.min(image.height, Math.ceil(crop.y + crop.height));
  const bg = [image.pixels[0], image.pixels[1], image.pixels[2], image.pixels[3]];
  let changed = 0;
  let total = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const offset = (y * image.width + x) * 4;
      const diff = Math.abs(image.pixels[offset] - bg[0]) +
        Math.abs(image.pixels[offset + 1] - bg[1]) +
        Math.abs(image.pixels[offset + 2] - bg[2]) +
        Math.abs(image.pixels[offset + 3] - bg[3]);
      total += 1;
      if (diff > 24) {
        changed += 1;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  const changedRatio = total > 0 ? changed / total : 0;
  const changedBounds = Number.isFinite(minX)
    ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
    : null;
  return { changedRatio, changedBounds };
}

async function inspectPrefab(bridgeUrl, prefabPath) {
  const open = await bridgePost(bridgeUrl, '/open-prefab', { prefabPath, mode: 'readonly' });
  const sessionId = open.session.sessionId;
  try {
    const [tree, rendered] = await Promise.all([
      bridgePost(bridgeUrl, '/export-node-tree', {
        sessionId,
        includeInactive: true,
        includeComponents: true,
        includeProtectedFields: false,
      }),
      bridgePost(bridgeUrl, '/render-snapshot', {
        sessionId,
        includeBboxes: true,
        imageMode: 'file',
      }),
    ]);
    const snapshot = rendered.snapshot;
    const boxes = visualBboxes(snapshot, tree.nodes);
    const crop = cropForSnapshot(snapshot, tree.nodes);
    const snapshotUrl = snapshot.image.url.startsWith('http')
      ? snapshot.image.url
      : `${normalizeBaseUrl(bridgeUrl)}${snapshot.image.url}`;
    const imageResponse = await fetch(snapshotUrl, { cache: 'no-store' });
    if (!imageResponse.ok) throw new Error(`snapshot image fetch failed: ${imageResponse.status}`);
    const image = decodePng(Buffer.from(await imageResponse.arrayBuffer()));
    const stats = pixelStats(image, crop);
    const scale = Math.min(THUMBNAIL_SIZE / crop.width, THUMBNAIL_SIZE / crop.height);
    const drawW = Math.max(1, Math.round(crop.width * scale));
    const drawH = Math.max(1, Math.round(crop.height * scale));
    const visualExtent = boxes.reduce((acc, box) => ({
      minX: Math.min(acc.minX, box.x),
      minY: Math.min(acc.minY, box.y),
      maxX: Math.max(acc.maxX, box.x + box.width),
      maxY: Math.max(acc.maxY, box.y + box.height),
    }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
    const visualWidth = Math.max(0, visualExtent.maxX - visualExtent.minX);
    const visualHeight = Math.max(0, visualExtent.maxY - visualExtent.minY);
    const mainAxisFill = Math.max(visualWidth / crop.width, visualHeight / crop.height);
    const allBoxesContained = cropContainsBoxes(crop, boxes);
    if (boxes.length === 0) throw new Error(`${prefabPath} has no visual bboxes`);
    if (!allBoxesContained) throw new Error(`${prefabPath} crop does not contain every visual bbox`);
    if (mainAxisFill < 0.55) throw new Error(`${prefabPath} thumbnail main-axis fill too low: ${mainAxisFill}`);
    if (stats.changedRatio < 0.015) throw new Error(`${prefabPath} thumbnail crop looks blank: changedRatio=${stats.changedRatio}`);
    return {
      prefabPath,
      sessionId,
      snapshot: { width: snapshot.width, height: snapshot.height, bboxCount: snapshot.bboxes?.length ?? 0, visualBoxCount: boxes.length },
      crop,
      draw: { width: drawW, height: drawH },
      mainAxisFill: Math.round(mainAxisFill * 1000) / 1000,
      changedRatio: Math.round(stats.changedRatio * 1000) / 1000,
      changedBounds: stats.changedBounds,
      allBoxesContained,
    };
  } finally {
    await bridgePost(bridgeUrl, '/close-prefab', { sessionId, deleteTempObjects: false }).catch(() => undefined);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await mkdir(args.out, { recursive: true });
  const report = { args, startedAt: new Date().toISOString(), ok: false, samples: [] };
  try {
    report.bridgeHealth = await bridgeGetJson(args.bridgeUrl, '/health');
    for (const sample of args.samples) {
      report.samples.push(await inspectPrefab(args.bridgeUrl, sample));
    }
    report.ok = true;
    report.finishedAt = new Date().toISOString();
    await writeFile(path.join(args.out, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
    console.log(JSON.stringify({
      ok: true,
      samples: report.samples.map((sample) => ({
        prefabPath: sample.prefabPath,
        visualBoxCount: sample.snapshot.visualBoxCount,
        crop: sample.crop,
        mainAxisFill: sample.mainAxisFill,
        changedRatio: sample.changedRatio,
      })),
      reportPath: path.join(args.out, 'report.json'),
    }, null, 2));
  } catch (err) {
    report.ok = false;
    report.error = err instanceof Error ? err.stack || err.message : String(err);
    report.finishedAt = new Date().toISOString();
    await writeFile(path.join(args.out, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
    console.error(JSON.stringify({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      reportPath: path.join(args.out, 'report.json'),
    }, null, 2));
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

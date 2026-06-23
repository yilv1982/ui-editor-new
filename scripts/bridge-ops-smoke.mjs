import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const args = {
    bridgeUrl: 'http://127.0.0.1:8082',
    out: path.join(ROOT, '.cache', 'bridge-ops-smoke', 'latest'),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const next = argv[i + 1];
    if (key === '--bridge-url') { args.bridgeUrl = next; i += 1; }
    else if (key === '--out') { args.out = path.resolve(next); i += 1; }
  }
  return args;
}

function normalizeBaseUrl(value) {
  return value.replace(/\/+$/, '');
}

function readUInt32(buffer, offset) {
  return buffer.readUInt32BE(offset);
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

async function fetchSnapshotImage(bridgeUrl, snapshot) {
  if (snapshot?.image?.dataUrl) {
    const res = await fetch(snapshot.image.dataUrl);
    if (!res.ok) throw new Error(`snapshot dataUrl fetch failed: ${res.status}`);
    return decodePng(Buffer.from(await res.arrayBuffer()));
  }
  const rawUrl = snapshot?.image?.url;
  if (!rawUrl) throw new Error(`snapshot image URL is missing: ${JSON.stringify(snapshot?.image ?? null)}`);
  const url = rawUrl.startsWith('http') ? rawUrl : `${normalizeBaseUrl(bridgeUrl)}${rawUrl}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`snapshot image fetch failed: ${res.status}`);
  return decodePng(Buffer.from(await res.arrayBuffer()));
}

async function renderSnapshotWithImage(bridgeUrl, sessionId, targetNodeIds) {
  const response = await bridgePost(bridgeUrl, '/render-snapshot', {
    sessionId,
    width: 1080,
    height: 1920,
    backgroundColor: '#162D3FFF',
    targetNodeIds,
    includeBboxes: true,
    imageMode: 'file',
  });
  return {
    response,
    image: await fetchSnapshotImage(bridgeUrl, response.snapshot),
  };
}

function cropForBboxes(snapshot, nodeIds, padding = 16) {
  const nodeIdSet = new Set(nodeIds);
  const boxes = (snapshot?.bboxes ?? []).filter((box) => (
    nodeIdSet.has(box.nodeId) &&
    box.activeInHierarchy &&
    box.width > 1 &&
    box.height > 1 &&
    Number.isFinite(box.x) &&
    Number.isFinite(box.y) &&
    Number.isFinite(box.width) &&
    Number.isFinite(box.height)
  ));
  if (boxes.length === 0) throw new Error(`no bboxes found for visual crop: ${nodeIds.join(', ')}`);
  const minX = Math.min(...boxes.map((box) => box.x));
  const minY = Math.min(...boxes.map((box) => box.y));
  const maxX = Math.max(...boxes.map((box) => box.x + box.width));
  const maxY = Math.max(...boxes.map((box) => box.y + box.height));
  const x = Math.max(0, Math.floor(minX - padding));
  const y = Math.max(0, Math.floor(minY - padding));
  const right = Math.min(snapshot.width, Math.ceil(maxX + padding));
  const bottom = Math.min(snapshot.height, Math.ceil(maxY + padding));
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
}

function pixelDiffStats(before, after, crop) {
  if (before.width !== after.width || before.height !== after.height) {
    throw new Error(`snapshot dimensions differ: ${before.width}x${before.height} vs ${after.width}x${after.height}`);
  }
  const x0 = Math.max(0, Math.floor(crop.x));
  const y0 = Math.max(0, Math.floor(crop.y));
  const x1 = Math.min(before.width, Math.ceil(crop.x + crop.width));
  const y1 = Math.min(before.height, Math.ceil(crop.y + crop.height));
  let changed = 0;
  let total = 0;
  let diffSum = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const offset = (y * before.width + x) * 4;
      const diff = Math.abs(before.pixels[offset] - after.pixels[offset]) +
        Math.abs(before.pixels[offset + 1] - after.pixels[offset + 1]) +
        Math.abs(before.pixels[offset + 2] - after.pixels[offset + 2]) +
        Math.abs(before.pixels[offset + 3] - after.pixels[offset + 3]);
      total += 1;
      diffSum += diff;
      if (diff > 24) {
        changed += 1;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  return {
    changedRatio: total > 0 ? changed / total : 0,
    averageDiff: total > 0 ? diffSum / total : 0,
    changedBounds: Number.isFinite(minX)
      ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
      : null,
  };
}

function findNodeByName(response, name) {
  return response.nodes?.find((node) => node.name === name) ?? null;
}

function nodeComponentTypes(node) {
  return new Set((node?.components ?? []).map((component) => component.type));
}

function findComponent(node, componentType) {
  return node?.components?.find((component) => component.type === componentType) ?? null;
}

function colorAlpha(color) {
  if (typeof color !== 'string') return null;
  const match = /^#?([0-9a-f]{6})([0-9a-f]{2})$/i.exec(color.trim());
  if (!match) return null;
  return parseInt(match[2], 16) / 255;
}

function componentAlpha(node, componentType) {
  return colorAlpha(findComponent(node, componentType)?.summary?.color);
}

function componentSummaryNumber(node, componentType, key) {
  const value = findComponent(node, componentType)?.summary?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function componentSummaryString(node, componentType, key) {
  const value = findComponent(node, componentType)?.summary?.[key];
  return typeof value === 'string' ? value : null;
}

function componentSummaryBool(node, componentType, key) {
  const value = findComponent(node, componentType)?.summary?.[key];
  return typeof value === 'boolean' ? value : null;
}

function assertApprox(value, expected, label, tolerance = 0.015) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} alpha is not numeric: ${value}`);
  }
  if (Math.abs(value - expected) > tolerance) {
    throw new Error(`${label} alpha expected ${expected}, got ${value}`);
  }
}

function assertPatchClean(response, label, expectedApplied = null) {
  if (response.rejected?.length) {
    throw new Error(`${label} patch rejected: ${JSON.stringify(response.rejected)}`);
  }
  if (expectedApplied !== null && (response.applied?.length ?? 0) !== expectedApplied) {
    throw new Error(`${label} patch applied ${response.applied?.length ?? 0}/${expectedApplied}`);
  }
  if ((response.protectedDiff?.summary?.protectedCount ?? 0) !== 0) {
    throw new Error(`${label} protected diff has blocked changes: ${JSON.stringify(response.protectedDiff?.protectedChanges ?? [])}`);
  }
}

function assertSummaryValue(node, componentType, key, expected) {
  const actual = findComponent(node, componentType)?.summary?.[key];
  if (actual !== expected) {
    throw new Error(`${node?.name ?? 'node'}.${componentType}.${key} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}; summary=${JSON.stringify(findComponent(node, componentType)?.summary ?? {})}`);
  }
}

function assertSummaryApprox(node, componentType, key, expected, tolerance = 0.001) {
  const actual = findComponent(node, componentType)?.summary?.[key];
  if (typeof actual !== 'number' || Math.abs(actual - expected) > tolerance) {
    throw new Error(`${node?.name ?? 'node'}.${componentType}.${key} expected ${expected}, got ${actual}; summary=${JSON.stringify(findComponent(node, componentType)?.summary ?? {})}`);
  }
}

function assertArrayApprox(value, expected, label, tolerance = 0.001) {
  if (!Array.isArray(value) || value.length < expected.length) {
    throw new Error(`${label} expected array ${JSON.stringify(expected)}, got ${JSON.stringify(value)}`);
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (typeof value[index] !== 'number' || Math.abs(value[index] - expected[index]) > tolerance) {
      throw new Error(`${label}[${index}] expected ${expected[index]}, got ${value[index]}; actual=${JSON.stringify(value)}`);
    }
  }
}

function requireBbox(response, nodeId) {
  const bbox = response.snapshot?.bboxes?.find((candidate) => candidate.nodeId === nodeId);
  if (!bbox) throw new Error(`bbox not found for nodeId: ${nodeId}`);
  if (!(bbox.width > 0) || !(bbox.height > 0)) {
    throw new Error(`bbox has invalid size for ${nodeId}: ${JSON.stringify(bbox)}`);
  }
  return bbox;
}

function requireNode(response, name) {
  const node = findNodeByName(response, name);
  if (!node) throw new Error(`node not found: ${name}`);
  return node;
}

function requireComponent(response, name, componentType) {
  const node = requireNode(response, name);
  if (!nodeComponentTypes(node).has(componentType)) {
    throw new Error(`${name} does not have component ${componentType}`);
  }
  return node;
}

function requireNodeComponents(response, name, componentTypes) {
  const node = requireNode(response, name);
  const types = nodeComponentTypes(node);
  const missing = componentTypes.filter((componentType) => !types.has(componentType));
  if (missing.length > 0) {
    throw new Error(`${name} is missing components: ${missing.join(', ')}`);
  }
  return node;
}

function countDescendants(nodes, parentId) {
  const childrenByParent = new Map();
  for (const node of nodes ?? []) {
    if (!node.parentId) continue;
    const list = childrenByParent.get(node.parentId) ?? [];
    list.push(node);
    childrenByParent.set(node.parentId, list);
  }
  let count = 0;
  const stack = [...(childrenByParent.get(parentId) ?? [])];
  while (stack.length > 0) {
    const node = stack.pop();
    count += 1;
    stack.push(...(childrenByParent.get(node.nodeId) ?? []));
  }
  return count;
}

function requireChildByName(response, parentId, name) {
  const node = response.nodes?.find((candidate) => candidate.parentId === parentId && candidate.name === name);
  if (!node) throw new Error(`child not found under ${parentId}: ${name}`);
  return node;
}

function projectAssetExists(projectPath, assetPath) {
  if (!projectPath || !assetPath) return false;
  return existsSync(path.join(projectPath, assetPath));
}

async function createSmokeImageNode(bridgeUrl, sessionId, parentId, spec) {
  const state = await bridgePost(bridgeUrl, '/create-image-node', {
    sessionId,
    parentId,
    name: spec.name,
    x: spec.x,
    y: spec.y,
    width: spec.width,
    height: spec.height,
    color: spec.color ?? '#FFFFFFFF',
    skipSnapshot: true,
  });
  return {
    state,
    node: requireComponent(state, spec.name, 'Image'),
  };
}

function requireRectPosition(response, name, expected) {
  const node = requireNode(response, name);
  assertArrayApprox(node.rectTransform?.anchoredPosition, expected, `${name}.anchoredPosition`);
  return node;
}

function bboxesByNodeId(response, nodeIds) {
  const wanted = new Set(nodeIds);
  const result = new Map();
  for (const box of response.snapshot?.bboxes ?? []) {
    if (!wanted.has(box.nodeId)) continue;
    if (!(box.width > 0) || !(box.height > 0)) {
      throw new Error(`invalid bbox for ${box.nodeId}: ${JSON.stringify(box)}`);
    }
    result.set(box.nodeId, box);
  }
  const missing = nodeIds.filter((nodeId) => !result.has(nodeId));
  if (missing.length > 0) throw new Error(`layout visual bboxes missing: ${missing.join(', ')}`);
  return result;
}

function assertHorizontalLayoutBoxes(boxes, nodeIds, label) {
  const ordered = nodeIds.map((nodeId) => boxes.get(nodeId));
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    const gap = current.x - (previous.x + previous.width);
    if (gap < 6) {
      throw new Error(`${label} expected visible horizontal gap, got ${gap}; boxes=${JSON.stringify(ordered)}`);
    }
    const centerDelta = Math.abs((current.y + current.height / 2) - (previous.y + previous.height / 2));
    if (centerDelta > 3) {
      throw new Error(`${label} expected aligned y centers, got delta=${centerDelta}; boxes=${JSON.stringify(ordered)}`);
    }
  }
}

function assertVerticalLayoutBoxes(boxes, nodeIds, label) {
  const ordered = nodeIds.map((nodeId) => boxes.get(nodeId));
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    const gap = current.y - (previous.y + previous.height);
    if (gap < 6) {
      throw new Error(`${label} expected visible vertical gap, got ${gap}; boxes=${JSON.stringify(ordered)}`);
    }
    const centerDelta = Math.abs((current.x + current.width / 2) - (previous.x + previous.width / 2));
    if (centerDelta > 3) {
      throw new Error(`${label} expected aligned x centers, got delta=${centerDelta}; boxes=${JSON.stringify(ordered)}`);
    }
  }
}

function assertGridLayoutBoxes(boxes, nodeIds, label) {
  const ordered = nodeIds.map((nodeId) => boxes.get(nodeId));
  if (Math.abs((ordered[1].x + ordered[1].width / 2) - (ordered[0].x + ordered[0].width / 2)) > 3) {
    throw new Error(`${label} expected first two children in the same first column; boxes=${JSON.stringify(ordered)}`);
  }
  if (!(ordered[1].y > ordered[0].y + ordered[0].height * 0.7)) {
    throw new Error(`${label} expected second child below first child for vertical startAxis; boxes=${JSON.stringify(ordered)}`);
  }
  const topRowY = [ordered[0], ordered[2], ordered[3]].map((box) => box.y + box.height / 2);
  if (Math.max(...topRowY) - Math.min(...topRowY) > 3) {
    throw new Error(`${label} expected first, third and fourth children on the same top row; boxes=${JSON.stringify(ordered)}`);
  }
  if (!(ordered[2].x < ordered[0].x && ordered[3].x < ordered[2].x)) {
    throw new Error(`${label} expected columns to progress right-to-left for startCorner=1; boxes=${JSON.stringify(ordered)}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await mkdir(args.out, { recursive: true });

  const report = {
    args,
    startedAt: new Date().toISOString(),
    ok: false,
  };

  let sessionId = '';
  let workingPrefabPath = '';
  let targetSessionId = '';
  let targetWorkingPrefabPath = '';
  let complexSourceSessionId = '';
  let complexSourceWorkingPrefabPath = '';
  let complexTargetSessionId = '';
  let complexTargetWorkingPrefabPath = '';
  try {
    const health = await bridgeGetJson(args.bridgeUrl, '/health');
    report.bridgeHealth = health;
    const requiredCaps = ['createWidgetNodes', 'duplicateNodes', 'copyNodesToSession', 'groupNodes', 'ungroupNodes'];
    const missingCaps = requiredCaps.filter((cap) => !health.capabilities?.includes(cap));
    if (missingCaps.length > 0) throw new Error(`Bridge lacks capabilities: ${missingCaps.join(', ')}`);
    const smokeFontPath = 'Assets/CamelHybrid/Resources/Font/CustomArial.ttf';
    if (!projectAssetExists(health.projectPath, smokeFontPath)) {
      throw new Error(`smoke font asset not found: ${smokeFontPath}`);
    }
    const smokeSpritePath = 'Assets/HotRes2/UIs/Textures/Common/Atlas/dl2_ui_a_img_com_missing.png';
    if (!projectAssetExists(health.projectPath, smokeSpritePath)) {
      throw new Error(`smoke sprite asset not found: ${smokeSpritePath}`);
    }

    let state = await bridgePost(args.bridgeUrl, '/create-blank-artboard', {
      name: `BridgeOpsSmoke_${Date.now()}`,
      width: 1080,
      height: 1920,
      skipSnapshot: true,
      profile: true,
    });
    sessionId = state.session.sessionId;
    workingPrefabPath = state.session.workingPrefabPath;
    const rootNodeId = state.rootNodeId;
    if (!sessionId || !workingPrefabPath || !rootNodeId) throw new Error('blank artboard did not return session/root state');

    const widgetSpecs = [
      ['button', 'SmokeButton', 'Button'],
      ['toggle', 'SmokeToggle', 'Toggle'],
      ['scrollview', 'SmokeScrollView', 'ScrollRect'],
      ['inputfield', 'SmokeInputField', 'InputField'],
      ['rawimage', 'SmokeRawImage', 'RawImage'],
    ];
    const createdWidgets = [];
    for (let index = 0; index < widgetSpecs.length; index += 1) {
      const [widgetType, name, componentType] = widgetSpecs[index];
      state = await bridgePost(args.bridgeUrl, '/create-widget-node', {
        sessionId,
        parentId: rootNodeId,
        widgetType,
        name,
        x: -360 + index * 180,
        y: 360 - index * 120,
        width: 160,
        height: 72,
        skipSnapshot: true,
      });
      const node = requireComponent(state, name, componentType);
      createdWidgets.push({ widgetType, name, componentType, nodeId: node.nodeId });
    }

    state = await bridgePost(args.bridgeUrl, '/create-text-node', {
      sessionId,
      parentId: rootNodeId,
      name: 'SmokeText',
      text: 'Smoke Text',
      x: -140,
      y: -260,
      width: 220,
      height: 72,
      fontSize: 28,
      color: '#FFFFFFFF',
      skipSnapshot: true,
    });
    const textNode = requireComponent(state, 'SmokeText', 'Text');

    state = await bridgePost(args.bridgeUrl, '/create-image-node', {
      sessionId,
      parentId: rootNodeId,
      name: 'SmokeImage',
      x: 140,
      y: -260,
      width: 120,
      height: 120,
      color: '#FFFFFFFF',
      skipSnapshot: true,
    });
    const imageNode = requireComponent(state, 'SmokeImage', 'Image');

    state = await bridgePost(args.bridgeUrl, '/create-image-node', {
      sessionId,
      parentId: rootNodeId,
      name: 'SmokeGeometry',
      x: -260,
      y: -640,
      width: 140,
      height: 80,
      color: '#FFCC66FF',
      skipSnapshot: true,
    });
    const geometryNode = requireComponent(state, 'SmokeGeometry', 'Image');

    state = await bridgePost(args.bridgeUrl, '/create-frame-node', {
      sessionId,
      parentId: rootNodeId,
      name: 'SmokeFrame',
      x: 360,
      y: -260,
      width: 220,
      height: 120,
      skipSnapshot: true,
    });
    const frameNode = requireNode(state, 'SmokeFrame');

    state = await bridgePost(args.bridgeUrl, '/create-frame-node', {
      sessionId,
      parentId: rootNodeId,
      name: 'SmokeRectMaskFrame',
      x: -360,
      y: -440,
      width: 180,
      height: 120,
      skipSnapshot: true,
    });
    const rectMaskFrameNode = requireNode(state, 'SmokeRectMaskFrame');

    state = await bridgePost(args.bridgeUrl, '/create-frame-node', {
      sessionId,
      parentId: rootNodeId,
      name: 'SmokeHorizontalLayout',
      x: -120,
      y: -440,
      width: 180,
      height: 120,
      skipSnapshot: true,
    });
    const horizontalLayoutNode = requireNode(state, 'SmokeHorizontalLayout');

    state = await bridgePost(args.bridgeUrl, '/create-frame-node', {
      sessionId,
      parentId: rootNodeId,
      name: 'SmokeVerticalLayout',
      x: 120,
      y: -440,
      width: 180,
      height: 120,
      skipSnapshot: true,
    });
    const verticalLayoutNode = requireNode(state, 'SmokeVerticalLayout');

    const horizontalLayoutChildren = [];
    for (const spec of [
      { name: 'SmokeHLayoutChildA', x: -70, y: -42, width: 34, height: 28, color: '#FF5577FF' },
      { name: 'SmokeHLayoutChildB', x: 10, y: 34, width: 42, height: 28, color: '#55FF77FF' },
      { name: 'SmokeHLayoutChildC', x: 74, y: -8, width: 50, height: 28, color: '#5577FFFF' },
    ]) {
      const created = await createSmokeImageNode(args.bridgeUrl, sessionId, horizontalLayoutNode.nodeId, spec);
      state = created.state;
      horizontalLayoutChildren.push(created.node);
    }

    const verticalLayoutChildren = [];
    for (const spec of [
      { name: 'SmokeVLayoutChildA', x: -54, y: -34, width: 44, height: 26, color: '#FFAA55FF' },
      { name: 'SmokeVLayoutChildB', x: 48, y: 18, width: 44, height: 34, color: '#AAFF55FF' },
      { name: 'SmokeVLayoutChildC', x: -10, y: 52, width: 44, height: 42, color: '#55AAFFFF' },
    ]) {
      const created = await createSmokeImageNode(args.bridgeUrl, sessionId, verticalLayoutNode.nodeId, spec);
      state = created.state;
      verticalLayoutChildren.push(created.node);
    }

    const gridLayoutChildren = [];
    for (const spec of [
      { name: 'SmokeGridChildA', x: -74, y: 48, width: 28, height: 24, color: '#CC5555FF' },
      { name: 'SmokeGridChildB', x: -8, y: -32, width: 28, height: 24, color: '#55CC55FF' },
      { name: 'SmokeGridChildC', x: 64, y: 24, width: 28, height: 24, color: '#5555CCFF' },
      { name: 'SmokeGridChildD', x: 86, y: -46, width: 28, height: 24, color: '#CCCC55FF' },
    ]) {
      const created = await createSmokeImageNode(args.bridgeUrl, sessionId, frameNode.nodeId, spec);
      state = created.state;
      gridLayoutChildren.push(created.node);
    }

    const alignSpecs = [
      { name: 'SmokeAlignA', x: -460, y: -720, width: 80, height: 40, color: '#AA3333FF' },
      { name: 'SmokeAlignB', x: -300, y: -700, width: 120, height: 50, color: '#33AA33FF' },
      { name: 'SmokeAlignC', x: -120, y: -680, width: 60, height: 60, color: '#3333AAFF' },
      { name: 'SmokeDistHA', x: 0, y: -720, width: 50, height: 42, color: '#AA6633FF' },
      { name: 'SmokeDistHB', x: 300, y: -720, width: 100, height: 42, color: '#AA9933FF' },
      { name: 'SmokeDistHC', x: 700, y: -720, width: 70, height: 42, color: '#AACC33FF' },
      { name: 'SmokeDistVA', x: 420, y: -760, width: 44, height: 40, color: '#33AACCFF' },
      { name: 'SmokeDistVB', x: 420, y: -520, width: 44, height: 100, color: '#3366CCFF' },
      { name: 'SmokeDistVC', x: 420, y: -160, width: 44, height: 70, color: '#6633CCFF' },
    ];
    const alignNodes = {};
    for (const spec of alignSpecs) {
      const created = await createSmokeImageNode(args.bridgeUrl, sessionId, rootNodeId, spec);
      state = created.state;
      alignNodes[spec.name] = created.node;
    }
    const countBeforeDuplicate = state.nodes.length;

    const opacityTargets = [
      { name: 'SmokeButton', nodeId: requireComponent(state, 'SmokeButton', 'Image').nodeId, componentType: 'Image' },
      { name: 'SmokeRawImage', nodeId: requireComponent(state, 'SmokeRawImage', 'RawImage').nodeId, componentType: 'RawImage' },
      { name: 'SmokeText', nodeId: textNode.nodeId, componentType: 'Text' },
      { name: 'SmokeImage', nodeId: imageNode.nodeId, componentType: 'Image' },
      { name: 'SmokeFrame', nodeId: frameNode.nodeId, componentType: 'CanvasGroup' },
    ];
    const targetAlpha = 0.4;
    const opacityPatch = await bridgePost(args.bridgeUrl, '/apply-visual-patch', {
      sessionId,
      patch: {
        patchId: `opacity-${Date.now()}`,
        baseRevision: state.revision ?? '',
        operations: opacityTargets.map((target) => ({
          op: 'set',
          nodeId: target.nodeId,
          field: 'Graphic.alpha',
          numberValue: targetAlpha,
        })),
      },
      dryRun: false,
      renderAfter: false,
      width: 1080,
      height: 1920,
      backgroundColor: '#162D3FFF',
      imageMode: 'file',
    });
    if (opacityPatch.rejected?.length) {
      throw new Error(`Graphic.alpha patch rejected: ${JSON.stringify(opacityPatch.rejected)}`);
    }
    if ((opacityPatch.applied?.length ?? 0) !== opacityTargets.length) {
      throw new Error(`Graphic.alpha applied ${opacityPatch.applied?.length ?? 0}/${opacityTargets.length}`);
    }
    if ((opacityPatch.protectedDiff?.summary?.protectedCount ?? 0) !== 0) {
      throw new Error(`Graphic.alpha protected diff has blocked changes: ${JSON.stringify(opacityPatch.protectedDiff?.protectedChanges ?? [])}`);
    }
    state = await bridgePost(args.bridgeUrl, '/export-node-tree', {
      sessionId,
      includeInactive: true,
      includeComponents: true,
      includeProtectedFields: true,
    });
    const opacityResults = [];
    for (const target of opacityTargets) {
      const node = requireNode(state, target.name);
      const alpha = target.componentType === 'CanvasGroup'
        ? componentSummaryNumber(node, 'CanvasGroup', 'alpha')
        : componentAlpha(node, target.componentType);
      assertApprox(alpha, targetAlpha, `${target.name}.${target.componentType}`);
      opacityResults.push({ name: target.name, componentType: target.componentType, alpha });
    }

    const textStylePatch = await bridgePost(args.bridgeUrl, '/apply-visual-patch', {
      sessionId,
      patch: {
        patchId: `text-style-${Date.now()}`,
        baseRevision: state.revision ?? '',
        operations: [
          { op: 'set', nodeId: textNode.nodeId, field: 'Text.text', stringValue: 'Bridge <b>Text</b>' },
          { op: 'set', nodeId: textNode.nodeId, field: 'Text.fontSize', numberValue: 36 },
          { op: 'set', nodeId: textNode.nodeId, field: 'Text.color', stringValue: '#66CCFFFF' },
          { op: 'set', nodeId: textNode.nodeId, field: 'Text.font', stringValue: smokeFontPath },
          { op: 'set', nodeId: textNode.nodeId, field: 'Text.fontStyle', numberValue: 3 },
          { op: 'set', nodeId: textNode.nodeId, field: 'Text.alignment', numberValue: 5 },
          { op: 'set', nodeId: textNode.nodeId, field: 'Text.richText', boolValue: true },
          { op: 'set', nodeId: textNode.nodeId, field: 'Text.horizontalOverflow', numberValue: 1 },
          { op: 'set', nodeId: textNode.nodeId, field: 'Text.verticalOverflow', numberValue: 1 },
          { op: 'set', nodeId: textNode.nodeId, field: 'Text.lineSpacing', numberValue: 1.25 },
          { op: 'set', nodeId: textNode.nodeId, field: 'Text.bestFit', boolValue: true },
          { op: 'set', nodeId: textNode.nodeId, field: 'Text.bestFitMinSize', numberValue: 18 },
          { op: 'set', nodeId: textNode.nodeId, field: 'Text.bestFitMaxSize', numberValue: 42 },
          { op: 'set', nodeId: textNode.nodeId, field: 'Text.raycastTarget', boolValue: false },
        ],
      },
      dryRun: false,
      renderAfter: false,
      width: 1080,
      height: 1920,
      backgroundColor: '#162D3FFF',
      imageMode: 'file',
    });
    if (textStylePatch.rejected?.length) {
      throw new Error(`Text style patch rejected: ${JSON.stringify(textStylePatch.rejected)}`);
    }
    if ((textStylePatch.protectedDiff?.summary?.protectedCount ?? 0) !== 0) {
      throw new Error(`Text style protected diff has blocked changes: ${JSON.stringify(textStylePatch.protectedDiff?.protectedChanges ?? [])}`);
    }
    state = await bridgePost(args.bridgeUrl, '/export-node-tree', {
      sessionId,
      includeInactive: true,
      includeComponents: true,
      includeProtectedFields: true,
    });
    const styledText = requireComponent(state, 'SmokeText', 'Text');
    const textSummary = findComponent(styledText, 'Text')?.summary ?? {};
    if (componentSummaryString(styledText, 'Text', 'text') !== 'Bridge <b>Text</b>') {
      throw new Error(`Text.text was not exported after patch: ${JSON.stringify(textSummary)}`);
    }
    if (componentSummaryNumber(styledText, 'Text', 'fontSize') !== 36) throw new Error(`Text.fontSize was not 36: ${JSON.stringify(textSummary)}`);
    if (componentSummaryString(styledText, 'Text', 'color') !== '#66CCFFFF') throw new Error(`Text.color was not #66CCFFFF: ${JSON.stringify(textSummary)}`);
    if (componentSummaryString(styledText, 'Text', 'fontPath') !== smokeFontPath) throw new Error(`Text.fontPath was not ${smokeFontPath}: ${JSON.stringify(textSummary)}`);
    if (componentSummaryNumber(styledText, 'Text', 'fontStyle') !== 3) throw new Error(`Text.fontStyle was not 3: ${JSON.stringify(textSummary)}`);
    if (componentSummaryNumber(styledText, 'Text', 'alignmentValue') !== 5) throw new Error(`Text.alignmentValue was not 5: ${JSON.stringify(textSummary)}`);
    if (componentSummaryBool(styledText, 'Text', 'richText') !== true) throw new Error(`Text.richText was not true: ${JSON.stringify(textSummary)}`);
    if (componentSummaryNumber(styledText, 'Text', 'horizontalOverflow') !== 1) throw new Error(`Text.horizontalOverflow was not 1: ${JSON.stringify(textSummary)}`);
    if (componentSummaryNumber(styledText, 'Text', 'verticalOverflow') !== 1) throw new Error(`Text.verticalOverflow was not 1: ${JSON.stringify(textSummary)}`);
    assertApprox(componentSummaryNumber(styledText, 'Text', 'lineSpacing'), 1.25, 'Text.lineSpacing', 0.001);
    if (componentSummaryBool(styledText, 'Text', 'bestFit') !== true) throw new Error(`Text.bestFit was not true: ${JSON.stringify(textSummary)}`);
    if (componentSummaryNumber(styledText, 'Text', 'bestFitMinSize') !== 18) throw new Error(`Text.bestFitMinSize was not 18: ${JSON.stringify(textSummary)}`);
    if (componentSummaryNumber(styledText, 'Text', 'bestFitMaxSize') !== 42) throw new Error(`Text.bestFitMaxSize was not 42: ${JSON.stringify(textSummary)}`);
    if (componentSummaryBool(styledText, 'Text', 'raycastTarget') !== false) throw new Error(`Text.raycastTarget was not false: ${JSON.stringify(textSummary)}`);
    const textStyleResult = {
      text: componentSummaryString(styledText, 'Text', 'text'),
      fontSize: componentSummaryNumber(styledText, 'Text', 'fontSize'),
      color: componentSummaryString(styledText, 'Text', 'color'),
      fontPath: componentSummaryString(styledText, 'Text', 'fontPath'),
      fontStyle: componentSummaryNumber(styledText, 'Text', 'fontStyle'),
      alignmentValue: componentSummaryNumber(styledText, 'Text', 'alignmentValue'),
      richText: componentSummaryBool(styledText, 'Text', 'richText'),
      protectedCount: textStylePatch.protectedDiff?.summary?.protectedCount ?? null,
    };

    const buttonNode = requireComponent(state, 'SmokeButton', 'Button');
    const toggleNode = requireComponent(state, 'SmokeToggle', 'Toggle');
    const scrollNode = requireComponent(state, 'SmokeScrollView', 'ScrollRect');
    const visualEffectNodeIds = [frameNode.nodeId, textNode.nodeId];
    const visualEffectBefore = await renderSnapshotWithImage(args.bridgeUrl, sessionId, visualEffectNodeIds);
    const visualComponentsOps = [
      { op: 'set', nodeId: imageNode.nodeId, field: 'Image.enabled', boolValue: false },
      { op: 'set', nodeId: imageNode.nodeId, field: 'Image.color', stringValue: '#336699AA' },
      { op: 'set', nodeId: imageNode.nodeId, field: 'Image.sprite', stringValue: smokeSpritePath },
      { op: 'set', nodeId: imageNode.nodeId, field: 'Image.type', stringValue: 'Filled' },
      { op: 'set', nodeId: imageNode.nodeId, field: 'Image.raycastTarget', boolValue: false },
      { op: 'set', nodeId: imageNode.nodeId, field: 'Image.fillCenter', boolValue: false },
      { op: 'set', nodeId: imageNode.nodeId, field: 'Image.fillMethod', numberValue: 0 },
      { op: 'set', nodeId: imageNode.nodeId, field: 'Image.fillOrigin', numberValue: 1 },
      { op: 'set', nodeId: imageNode.nodeId, field: 'Image.fillAmount', numberValue: 0.33 },
      { op: 'set', nodeId: imageNode.nodeId, field: 'Image.fillClockwise', boolValue: false },
      { op: 'set', nodeId: imageNode.nodeId, field: 'Image.useSpriteMesh', boolValue: true },
      { op: 'set', nodeId: imageNode.nodeId, field: 'Image.preserveAspect', boolValue: true },
      { op: 'set', nodeId: buttonNode.nodeId, field: 'Button.interactable', boolValue: false },
      { op: 'set', nodeId: buttonNode.nodeId, field: 'Button.transition', numberValue: 1 },
      { op: 'set', nodeId: buttonNode.nodeId, field: 'Button.colors.normalColor', stringValue: '#112233FF' },
      { op: 'set', nodeId: buttonNode.nodeId, field: 'Button.colors.highlightedColor', stringValue: '#223344FF' },
      { op: 'set', nodeId: buttonNode.nodeId, field: 'Button.colors.pressedColor', stringValue: '#334455FF' },
      { op: 'set', nodeId: buttonNode.nodeId, field: 'Button.colors.disabledColor', stringValue: '#44556680' },
      { op: 'set', nodeId: buttonNode.nodeId, field: 'Button.colors.colorMultiplier', numberValue: 1.75 },
      { op: 'set', nodeId: buttonNode.nodeId, field: 'Button.colors.fadeDuration', numberValue: 0.12 },
      { op: 'set', nodeId: frameNode.nodeId, field: 'Mask.type', stringValue: 'Mask' },
      { op: 'set', nodeId: frameNode.nodeId, field: 'Mask.showGraphic', boolValue: false },
      { op: 'set', nodeId: rectMaskFrameNode.nodeId, field: 'Mask.type', stringValue: 'RectMask2D' },
      { op: 'set', nodeId: scrollNode.nodeId, field: 'ScrollRect.horizontal', boolValue: false },
      { op: 'set', nodeId: scrollNode.nodeId, field: 'ScrollRect.vertical', boolValue: true },
      { op: 'set', nodeId: toggleNode.nodeId, field: 'Toggle.isOn', boolValue: true },
      { op: 'set', nodeId: frameNode.nodeId, field: 'LayoutElement.ignoreLayout', boolValue: true },
      { op: 'set', nodeId: frameNode.nodeId, field: 'LayoutElement.minWidth', numberValue: 44 },
      { op: 'set', nodeId: frameNode.nodeId, field: 'LayoutElement.minHeight', numberValue: 55 },
      { op: 'set', nodeId: frameNode.nodeId, field: 'LayoutElement.preferredWidth', numberValue: 166 },
      { op: 'set', nodeId: frameNode.nodeId, field: 'LayoutElement.preferredHeight', numberValue: 77 },
      { op: 'set', nodeId: frameNode.nodeId, field: 'LayoutElement.flexibleWidth', numberValue: 2 },
      { op: 'set', nodeId: frameNode.nodeId, field: 'LayoutElement.flexibleHeight', numberValue: 3 },
      { op: 'set', nodeId: frameNode.nodeId, field: 'LayoutGroup.type', stringValue: 'Grid' },
      { op: 'set', nodeId: frameNode.nodeId, field: 'LayoutGroup.enabled', boolValue: true },
      { op: 'set', nodeId: frameNode.nodeId, field: 'LayoutGroup.spacing', numberValue: 8 },
      { op: 'set', nodeId: frameNode.nodeId, field: 'LayoutGroup.spacingY', numberValue: 12 },
      { op: 'set', nodeId: frameNode.nodeId, field: 'LayoutGroup.padding.left', numberValue: 4 },
      { op: 'set', nodeId: frameNode.nodeId, field: 'LayoutGroup.padding.right', numberValue: 5 },
      { op: 'set', nodeId: frameNode.nodeId, field: 'LayoutGroup.padding.top', numberValue: 6 },
      { op: 'set', nodeId: frameNode.nodeId, field: 'LayoutGroup.padding.bottom', numberValue: 7 },
      { op: 'set', nodeId: frameNode.nodeId, field: 'LayoutGroup.childAlignment', numberValue: 4 },
      { op: 'set', nodeId: frameNode.nodeId, field: 'GridLayoutGroup.cellSize', value: [64, 32] },
      { op: 'set', nodeId: frameNode.nodeId, field: 'GridLayoutGroup.startCorner', numberValue: 1 },
      { op: 'set', nodeId: frameNode.nodeId, field: 'GridLayoutGroup.startAxis', numberValue: 1 },
      { op: 'set', nodeId: frameNode.nodeId, field: 'GridLayoutGroup.constraint', numberValue: 1 },
      { op: 'set', nodeId: frameNode.nodeId, field: 'GridLayoutGroup.constraintCount', numberValue: 3 },
      { op: 'set', nodeId: horizontalLayoutNode.nodeId, field: 'LayoutGroup.type', stringValue: 'Horizontal' },
      { op: 'set', nodeId: horizontalLayoutNode.nodeId, field: 'LayoutGroup.enabled', boolValue: true },
      { op: 'set', nodeId: horizontalLayoutNode.nodeId, field: 'LayoutGroup.spacing', numberValue: 14 },
      { op: 'set', nodeId: horizontalLayoutNode.nodeId, field: 'LayoutGroup.padding.left', numberValue: 11 },
      { op: 'set', nodeId: horizontalLayoutNode.nodeId, field: 'LayoutGroup.padding.right', numberValue: 12 },
      { op: 'set', nodeId: horizontalLayoutNode.nodeId, field: 'LayoutGroup.padding.top', numberValue: 13 },
      { op: 'set', nodeId: horizontalLayoutNode.nodeId, field: 'LayoutGroup.padding.bottom', numberValue: 15 },
      { op: 'set', nodeId: horizontalLayoutNode.nodeId, field: 'LayoutGroup.childAlignment', numberValue: 7 },
      { op: 'set', nodeId: horizontalLayoutNode.nodeId, field: 'LayoutGroup.childControlWidth', boolValue: false },
      { op: 'set', nodeId: horizontalLayoutNode.nodeId, field: 'LayoutGroup.childControlHeight', boolValue: false },
      { op: 'set', nodeId: horizontalLayoutNode.nodeId, field: 'LayoutGroup.childForceExpandWidth', boolValue: false },
      { op: 'set', nodeId: horizontalLayoutNode.nodeId, field: 'LayoutGroup.childForceExpandHeight', boolValue: false },
      { op: 'set', nodeId: verticalLayoutNode.nodeId, field: 'LayoutGroup.type', stringValue: 'Vertical' },
      { op: 'set', nodeId: verticalLayoutNode.nodeId, field: 'LayoutGroup.enabled', boolValue: true },
      { op: 'set', nodeId: verticalLayoutNode.nodeId, field: 'LayoutGroup.spacing', numberValue: 16 },
      { op: 'set', nodeId: verticalLayoutNode.nodeId, field: 'LayoutGroup.padding.left', numberValue: 21 },
      { op: 'set', nodeId: verticalLayoutNode.nodeId, field: 'LayoutGroup.padding.right', numberValue: 22 },
      { op: 'set', nodeId: verticalLayoutNode.nodeId, field: 'LayoutGroup.padding.top', numberValue: 23 },
      { op: 'set', nodeId: verticalLayoutNode.nodeId, field: 'LayoutGroup.padding.bottom', numberValue: 24 },
      { op: 'set', nodeId: verticalLayoutNode.nodeId, field: 'LayoutGroup.childAlignment', numberValue: 3 },
      { op: 'set', nodeId: verticalLayoutNode.nodeId, field: 'LayoutGroup.childControlWidth', boolValue: false },
      { op: 'set', nodeId: verticalLayoutNode.nodeId, field: 'LayoutGroup.childControlHeight', boolValue: false },
      { op: 'set', nodeId: verticalLayoutNode.nodeId, field: 'LayoutGroup.childForceExpandWidth', boolValue: false },
      { op: 'set', nodeId: verticalLayoutNode.nodeId, field: 'LayoutGroup.childForceExpandHeight', boolValue: false },
      { op: 'set', nodeId: frameNode.nodeId, field: 'ContentSizeFitter.enabled', boolValue: true },
      { op: 'set', nodeId: frameNode.nodeId, field: 'ContentSizeFitter.horizontalFit', numberValue: 2 },
      { op: 'set', nodeId: frameNode.nodeId, field: 'ContentSizeFitter.verticalFit', numberValue: 1 },
      { op: 'set', nodeId: frameNode.nodeId, field: 'Outline.enabled', boolValue: true },
      { op: 'set', nodeId: frameNode.nodeId, field: 'Outline.color', stringValue: '#00FF88CC' },
      { op: 'set', nodeId: frameNode.nodeId, field: 'Outline.distance', value: [2.5, -3.5] },
      { op: 'set', nodeId: frameNode.nodeId, field: 'Outline.useGraphicAlpha', boolValue: false },
      { op: 'set', nodeId: textNode.nodeId, field: 'Shadow.enabled', boolValue: true },
      { op: 'set', nodeId: textNode.nodeId, field: 'Shadow.color', stringValue: '#000000AA' },
      { op: 'set', nodeId: textNode.nodeId, field: 'Shadow.distance', value: [3, -4] },
      { op: 'set', nodeId: textNode.nodeId, field: 'Shadow.useGraphicAlpha', boolValue: true },
    ];
    const visualComponentsPatch = await bridgePost(args.bridgeUrl, '/apply-visual-patch', {
      sessionId,
      patch: {
        patchId: `visual-components-${Date.now()}`,
        baseRevision: state.revision ?? '',
        operations: visualComponentsOps,
      },
      dryRun: false,
      renderAfter: false,
      width: 1080,
      height: 1920,
      backgroundColor: '#162D3FFF',
      imageMode: 'file',
    });
    assertPatchClean(visualComponentsPatch, 'Visual component fields', visualComponentsOps.length);
    const visualEffectAfter = await renderSnapshotWithImage(args.bridgeUrl, sessionId, visualEffectNodeIds);
    const visualEffectCrop = cropForBboxes(visualEffectBefore.response.snapshot, visualEffectNodeIds, 20);
    const visualEffectDiff = pixelDiffStats(visualEffectBefore.image, visualEffectAfter.image, visualEffectCrop);
    if (visualEffectDiff.changedRatio < 0.001) {
      throw new Error(`Outline/Shadow visual render did not change enough pixels: ${JSON.stringify({ crop: visualEffectCrop, diff: visualEffectDiff })}`);
    }
    const horizontalLayoutChildIds = horizontalLayoutChildren.map((node) => node.nodeId);
    const verticalLayoutChildIds = verticalLayoutChildren.map((node) => node.nodeId);
    const gridLayoutChildIds = gridLayoutChildren.map((node) => node.nodeId);
    const layoutVisualNodeIds = [...horizontalLayoutChildIds, ...verticalLayoutChildIds, ...gridLayoutChildIds];
    const layoutVisualSnapshot = await bridgePost(args.bridgeUrl, '/render-snapshot', {
      sessionId,
      width: 1080,
      height: 1920,
      backgroundColor: '#162D3FFF',
      targetNodeIds: layoutVisualNodeIds,
      includeBboxes: true,
      imageMode: 'file',
    });
    const layoutVisualBoxes = bboxesByNodeId(layoutVisualSnapshot, layoutVisualNodeIds);
    assertHorizontalLayoutBoxes(layoutVisualBoxes, horizontalLayoutChildIds, 'HorizontalLayoutGroup visual layout');
    assertVerticalLayoutBoxes(layoutVisualBoxes, verticalLayoutChildIds, 'VerticalLayoutGroup visual layout');
    assertGridLayoutBoxes(layoutVisualBoxes, gridLayoutChildIds, 'GridLayoutGroup visual layout');
    state = await bridgePost(args.bridgeUrl, '/export-node-tree', {
      sessionId,
      includeInactive: true,
      includeComponents: true,
      includeProtectedFields: true,
    });
    const patchedImage = requireComponent(state, 'SmokeImage', 'Image');
    assertSummaryValue(patchedImage, 'Image', 'enabled', false);
    assertSummaryValue(patchedImage, 'Image', 'color', '#336699AA');
    assertSummaryValue(patchedImage, 'Image', 'spritePath', smokeSpritePath);
    assertSummaryValue(patchedImage, 'Image', 'imageType', 'Filled');
    assertSummaryValue(patchedImage, 'Image', 'raycastTarget', false);
    assertSummaryValue(patchedImage, 'Image', 'fillCenter', false);
    assertSummaryValue(patchedImage, 'Image', 'fillMethod', 0);
    assertSummaryValue(patchedImage, 'Image', 'fillOrigin', 1);
    assertSummaryApprox(patchedImage, 'Image', 'fillAmount', 0.33, 0.001);
    assertSummaryValue(patchedImage, 'Image', 'fillClockwise', false);
    assertSummaryValue(patchedImage, 'Image', 'useSpriteMesh', true);
    assertSummaryValue(patchedImage, 'Image', 'preserveAspect', true);

    const patchedButton = requireComponent(state, 'SmokeButton', 'Button');
    assertSummaryValue(patchedButton, 'Button', 'interactable', false);
    assertSummaryValue(patchedButton, 'Button', 'transition', 1);
    assertSummaryValue(patchedButton, 'Button', 'normalColor', '#112233FF');
    assertSummaryValue(patchedButton, 'Button', 'highlightedColor', '#223344FF');
    assertSummaryValue(patchedButton, 'Button', 'pressedColor', '#334455FF');
    assertSummaryValue(patchedButton, 'Button', 'disabledColor', '#44556680');
    assertSummaryApprox(patchedButton, 'Button', 'colorMultiplier', 1.75, 0.001);
    assertSummaryApprox(patchedButton, 'Button', 'fadeDuration', 0.12, 0.001);

    const patchedFrame = requireNodeComponents(state, 'SmokeFrame', ['Mask', 'LayoutElement', 'GridLayoutGroup', 'ContentSizeFitter', 'Outline']);
    assertSummaryValue(patchedFrame, 'Mask', 'enabled', true);
    assertSummaryValue(patchedFrame, 'Mask', 'showMaskGraphic', false);
    const patchedRectMaskFrame = requireNodeComponents(state, 'SmokeRectMaskFrame', ['RectMask2D']);
    assertSummaryValue(patchedRectMaskFrame, 'RectMask2D', 'enabled', true);
    assertSummaryValue(patchedFrame, 'LayoutElement', 'ignoreLayout', true);
    assertSummaryApprox(patchedFrame, 'LayoutElement', 'minWidth', 44);
    assertSummaryApprox(patchedFrame, 'LayoutElement', 'minHeight', 55);
    assertSummaryApprox(patchedFrame, 'LayoutElement', 'preferredWidth', 166);
    assertSummaryApprox(patchedFrame, 'LayoutElement', 'preferredHeight', 77);
    assertSummaryApprox(patchedFrame, 'LayoutElement', 'flexibleWidth', 2);
    assertSummaryApprox(patchedFrame, 'LayoutElement', 'flexibleHeight', 3);
    assertSummaryValue(patchedFrame, 'GridLayoutGroup', 'enabled', true);
    assertSummaryValue(patchedFrame, 'GridLayoutGroup', 'layoutType', 'Grid');
    assertSummaryApprox(patchedFrame, 'GridLayoutGroup', 'spacing', 8);
    assertSummaryApprox(patchedFrame, 'GridLayoutGroup', 'spacingY', 12);
    assertSummaryApprox(patchedFrame, 'GridLayoutGroup', 'padLeft', 4);
    assertSummaryApprox(patchedFrame, 'GridLayoutGroup', 'padRight', 5);
    assertSummaryApprox(patchedFrame, 'GridLayoutGroup', 'padTop', 6);
    assertSummaryApprox(patchedFrame, 'GridLayoutGroup', 'padBottom', 7);
    assertSummaryValue(patchedFrame, 'GridLayoutGroup', 'childAlignment', 4);
    assertSummaryApprox(patchedFrame, 'GridLayoutGroup', 'cellSizeX', 64);
    assertSummaryApprox(patchedFrame, 'GridLayoutGroup', 'cellSizeY', 32);
    assertSummaryValue(patchedFrame, 'GridLayoutGroup', 'startCorner', 1);
    assertSummaryValue(patchedFrame, 'GridLayoutGroup', 'startAxis', 1);
    assertSummaryValue(patchedFrame, 'GridLayoutGroup', 'constraint', 1);
    assertSummaryValue(patchedFrame, 'GridLayoutGroup', 'constraintCount', 3);
    const patchedHorizontalLayout = requireNodeComponents(state, 'SmokeHorizontalLayout', ['HorizontalLayoutGroup']);
    assertSummaryValue(patchedHorizontalLayout, 'HorizontalLayoutGroup', 'enabled', true);
    assertSummaryValue(patchedHorizontalLayout, 'HorizontalLayoutGroup', 'layoutType', 'Horizontal');
    assertSummaryApprox(patchedHorizontalLayout, 'HorizontalLayoutGroup', 'spacing', 14);
    assertSummaryApprox(patchedHorizontalLayout, 'HorizontalLayoutGroup', 'padLeft', 11);
    assertSummaryApprox(patchedHorizontalLayout, 'HorizontalLayoutGroup', 'padRight', 12);
    assertSummaryApprox(patchedHorizontalLayout, 'HorizontalLayoutGroup', 'padTop', 13);
    assertSummaryApprox(patchedHorizontalLayout, 'HorizontalLayoutGroup', 'padBottom', 15);
    assertSummaryValue(patchedHorizontalLayout, 'HorizontalLayoutGroup', 'childAlignment', 7);
    assertSummaryValue(patchedHorizontalLayout, 'HorizontalLayoutGroup', 'childControlWidth', false);
    assertSummaryValue(patchedHorizontalLayout, 'HorizontalLayoutGroup', 'childControlHeight', false);
    assertSummaryValue(patchedHorizontalLayout, 'HorizontalLayoutGroup', 'childForceExpandWidth', false);
    assertSummaryValue(patchedHorizontalLayout, 'HorizontalLayoutGroup', 'childForceExpandHeight', false);
    const patchedVerticalLayout = requireNodeComponents(state, 'SmokeVerticalLayout', ['VerticalLayoutGroup']);
    assertSummaryValue(patchedVerticalLayout, 'VerticalLayoutGroup', 'enabled', true);
    assertSummaryValue(patchedVerticalLayout, 'VerticalLayoutGroup', 'layoutType', 'Vertical');
    assertSummaryApprox(patchedVerticalLayout, 'VerticalLayoutGroup', 'spacing', 16);
    assertSummaryApprox(patchedVerticalLayout, 'VerticalLayoutGroup', 'padLeft', 21);
    assertSummaryApprox(patchedVerticalLayout, 'VerticalLayoutGroup', 'padRight', 22);
    assertSummaryApprox(patchedVerticalLayout, 'VerticalLayoutGroup', 'padTop', 23);
    assertSummaryApprox(patchedVerticalLayout, 'VerticalLayoutGroup', 'padBottom', 24);
    assertSummaryValue(patchedVerticalLayout, 'VerticalLayoutGroup', 'childAlignment', 3);
    assertSummaryValue(patchedVerticalLayout, 'VerticalLayoutGroup', 'childControlWidth', false);
    assertSummaryValue(patchedVerticalLayout, 'VerticalLayoutGroup', 'childControlHeight', false);
    assertSummaryValue(patchedVerticalLayout, 'VerticalLayoutGroup', 'childForceExpandWidth', false);
    assertSummaryValue(patchedVerticalLayout, 'VerticalLayoutGroup', 'childForceExpandHeight', false);
    assertSummaryValue(patchedFrame, 'ContentSizeFitter', 'enabled', true);
    assertSummaryValue(patchedFrame, 'ContentSizeFitter', 'horizontalFit', 2);
    assertSummaryValue(patchedFrame, 'ContentSizeFitter', 'verticalFit', 1);
    assertSummaryValue(patchedFrame, 'Outline', 'enabled', true);
    assertSummaryValue(patchedFrame, 'Outline', 'color', '#00FF88CC');
    assertSummaryApprox(patchedFrame, 'Outline', 'distanceX', 2.5);
    assertSummaryApprox(patchedFrame, 'Outline', 'distanceY', -3.5);
    assertSummaryValue(patchedFrame, 'Outline', 'useGraphicAlpha', false);

    const patchedTextShadow = requireNodeComponents(state, 'SmokeText', ['Text', 'Shadow']);
    assertSummaryValue(patchedTextShadow, 'Shadow', 'enabled', true);
    assertSummaryValue(patchedTextShadow, 'Shadow', 'color', '#000000AA');
    assertSummaryApprox(patchedTextShadow, 'Shadow', 'distanceX', 3);
    assertSummaryApprox(patchedTextShadow, 'Shadow', 'distanceY', -4);
    assertSummaryValue(patchedTextShadow, 'Shadow', 'useGraphicAlpha', true);

    const patchedScroll = requireComponent(state, 'SmokeScrollView', 'ScrollRect');
    assertSummaryValue(patchedScroll, 'ScrollRect', 'horizontal', false);
    assertSummaryValue(patchedScroll, 'ScrollRect', 'vertical', true);
    const patchedToggle = requireComponent(state, 'SmokeToggle', 'Toggle');
    assertSummaryValue(patchedToggle, 'Toggle', 'isOn', true);

    const visualComponentResult = {
      image: findComponent(patchedImage, 'Image')?.summary ?? {},
      button: findComponent(patchedButton, 'Button')?.summary ?? {},
      mask: findComponent(patchedFrame, 'Mask')?.summary ?? {},
      rectMask: findComponent(patchedRectMaskFrame, 'RectMask2D')?.summary ?? {},
      layoutElement: findComponent(patchedFrame, 'LayoutElement')?.summary ?? {},
      gridLayout: findComponent(patchedFrame, 'GridLayoutGroup')?.summary ?? {},
      horizontalLayout: findComponent(patchedHorizontalLayout, 'HorizontalLayoutGroup')?.summary ?? {},
      verticalLayout: findComponent(patchedVerticalLayout, 'VerticalLayoutGroup')?.summary ?? {},
      contentSizeFitter: findComponent(patchedFrame, 'ContentSizeFitter')?.summary ?? {},
      layoutVisualBboxes: {
        horizontal: horizontalLayoutChildIds.map((nodeId) => layoutVisualBoxes.get(nodeId)),
        vertical: verticalLayoutChildIds.map((nodeId) => layoutVisualBoxes.get(nodeId)),
        grid: gridLayoutChildIds.map((nodeId) => layoutVisualBoxes.get(nodeId)),
      },
      outline: findComponent(patchedFrame, 'Outline')?.summary ?? {},
      shadow: findComponent(patchedTextShadow, 'Shadow')?.summary ?? {},
      scrollRect: findComponent(patchedScroll, 'ScrollRect')?.summary ?? {},
      toggle: findComponent(patchedToggle, 'Toggle')?.summary ?? {},
      outlineShadowVisualDiff: {
        crop: visualEffectCrop,
        changedRatio: Math.round(visualEffectDiff.changedRatio * 100000) / 100000,
        averageDiff: Math.round(visualEffectDiff.averageDiff * 1000) / 1000,
        changedBounds: visualEffectDiff.changedBounds,
      },
      protectedCount: visualComponentsPatch.protectedDiff?.summary?.protectedCount ?? null,
    };

    const geometryPatchOps = [
      { op: 'set', nodeId: geometryNode.nodeId, field: 'rectTransform.anchorMin', value: [0.25, 0.25] },
      { op: 'set', nodeId: geometryNode.nodeId, field: 'rectTransform.anchorMax', value: [0.25, 0.25] },
      { op: 'set', nodeId: geometryNode.nodeId, field: 'rectTransform.pivot', value: [0.1, 0.9] },
      { op: 'set', nodeId: geometryNode.nodeId, field: 'rectTransform.localScale', value: [1.25, 0.75, 1] },
      { op: 'set', nodeId: geometryNode.nodeId, field: 'rectTransform.localEulerAngles.z', numberValue: 17 },
    ];
    const geometryPatch = await bridgePost(args.bridgeUrl, '/apply-visual-patch', {
      sessionId,
      patch: {
        patchId: `geometry-${Date.now()}`,
        baseRevision: state.revision ?? '',
        operations: geometryPatchOps,
      },
      dryRun: false,
      renderAfter: false,
      width: 1080,
      height: 1920,
      backgroundColor: '#162D3FFF',
      imageMode: 'file',
    });
    assertPatchClean(geometryPatch, 'Geometry transform fields', geometryPatchOps.length);

    state = await bridgePost(args.bridgeUrl, '/move-node', {
      sessionId,
      nodeId: geometryNode.nodeId,
      x: -222,
      y: -333,
      skipSnapshot: true,
    });
    state = await bridgePost(args.bridgeUrl, '/resize-node', {
      sessionId,
      nodeId: geometryNode.nodeId,
      width: 210,
      height: 96,
      skipSnapshot: true,
    });
    const geometryDiff = await bridgePost(args.bridgeUrl, '/validate-protected-diff', {
      sessionId,
      baseRevision: '',
      currentRevision: state.revision ?? '',
      includeTextDiff: false,
    });
    if ((geometryDiff.summary?.protectedCount ?? 0) !== 0) {
      throw new Error(`Geometry protected diff has blocked changes: ${JSON.stringify(geometryDiff.protectedChanges ?? [])}`);
    }
    state = await bridgePost(args.bridgeUrl, '/export-node-tree', {
      sessionId,
      includeInactive: true,
      includeComponents: true,
      includeProtectedFields: true,
    });
    const patchedGeometry = requireComponent(state, 'SmokeGeometry', 'Image');
    const geometryRect = patchedGeometry.rectTransform;
    assertArrayApprox(geometryRect?.anchorMin, [0.25, 0.25], 'SmokeGeometry.anchorMin');
    assertArrayApprox(geometryRect?.anchorMax, [0.25, 0.25], 'SmokeGeometry.anchorMax');
    assertArrayApprox(geometryRect?.pivot, [0.1, 0.9], 'SmokeGeometry.pivot');
    assertArrayApprox(geometryRect?.anchoredPosition, [-222, -333], 'SmokeGeometry.anchoredPosition');
    assertArrayApprox(geometryRect?.sizeDelta, [210, 96], 'SmokeGeometry.sizeDelta');
    assertArrayApprox(geometryRect?.localScale, [1.25, 0.75, 1], 'SmokeGeometry.localScale');
    assertArrayApprox(geometryRect?.localEulerAngles, [0, 0, 17], 'SmokeGeometry.localEulerAngles', 0.01);
    const geometrySnapshot = await bridgePost(args.bridgeUrl, '/render-snapshot', {
      sessionId,
      width: 1080,
      height: 1920,
      backgroundColor: '#162D3FFF',
      targetNodeIds: [geometryNode.nodeId],
      includeBboxes: true,
      imageMode: 'file',
    });
    const geometryBbox = requireBbox(geometrySnapshot, geometryNode.nodeId);
    const geometryResult = {
      rectTransform: geometryRect,
      bbox: {
        x: geometryBbox.x,
        y: geometryBbox.y,
        width: geometryBbox.width,
        height: geometryBbox.height,
      },
      protectedCount: geometryDiff.summary?.protectedCount ?? null,
    };

    const alignStartedAt = Date.now();
    const alignMoves = [
      { nodeId: alignNodes.SmokeAlignB.nodeId, x: -460, y: -700 },
      { nodeId: alignNodes.SmokeAlignC.nodeId, x: -460, y: -680 },
      { nodeId: alignNodes.SmokeDistHB.nodeId, x: 325, y: -720 },
      { nodeId: alignNodes.SmokeDistVB.nodeId, x: 420, y: -490 },
    ];
    for (let index = 0; index < alignMoves.length; index += 1) {
      const move = alignMoves[index];
      state = await bridgePost(args.bridgeUrl, '/move-node', {
        sessionId,
        nodeId: move.nodeId,
        x: move.x,
        y: move.y,
        skipSnapshot: true,
      });
    }
    const alignDiff = await bridgePost(args.bridgeUrl, '/validate-protected-diff', {
      sessionId,
      baseRevision: '',
      currentRevision: state.revision ?? '',
      includeTextDiff: false,
    });
    if ((alignDiff.summary?.protectedCount ?? 0) !== 0) {
      throw new Error(`Align/distribute protected diff has blocked changes: ${JSON.stringify(alignDiff.protectedChanges ?? [])}`);
    }
    state = await bridgePost(args.bridgeUrl, '/export-node-tree', {
      sessionId,
      includeInactive: true,
      includeComponents: true,
      includeProtectedFields: true,
    });
    requireRectPosition(state, 'SmokeAlignA', [-460, -720]);
    requireRectPosition(state, 'SmokeAlignB', [-460, -700]);
    requireRectPosition(state, 'SmokeAlignC', [-460, -680]);
    requireRectPosition(state, 'SmokeDistHA', [0, -720]);
    requireRectPosition(state, 'SmokeDistHB', [325, -720]);
    requireRectPosition(state, 'SmokeDistHC', [700, -720]);
    requireRectPosition(state, 'SmokeDistVA', [420, -760]);
    requireRectPosition(state, 'SmokeDistVB', [420, -490]);
    requireRectPosition(state, 'SmokeDistVC', [420, -160]);
    const alignDistributeResult = {
      moveCount: alignMoves.length,
      elapsedMs: Date.now() - alignStartedAt,
      leftAlignedX: -460,
      horizontalPositions: [0, 325, 700],
      verticalPositions: [-760, -490, -160],
      protectedCount: alignDiff.summary?.protectedCount ?? null,
    };

    state = await bridgePost(args.bridgeUrl, '/duplicate-nodes', {
      sessionId,
      nodeIds: [textNode.nodeId],
      offsetX: 30,
      offsetY: -30,
      skipSnapshot: true,
    });
    const duplicateNode = state.nodes.find((node) => node.name === 'SmokeText_copy');
    if (!duplicateNode) throw new Error('duplicate-nodes did not create SmokeText_copy');
    if (state.nodes.length <= countBeforeDuplicate) throw new Error('duplicate-nodes did not increase node count');

    state = await bridgePost(args.bridgeUrl, '/group-nodes', {
      sessionId,
      nodeIds: [textNode.nodeId, imageNode.nodeId],
      name: 'SmokeGroup',
      skipSnapshot: true,
    });
    const groupNode = requireNode(state, 'SmokeGroup');
    const groupedChildren = state.nodes.filter((node) => node.parentId === groupNode.nodeId);
    if (groupedChildren.length < 2) throw new Error('group-nodes did not reparent both selected children');

    state = await bridgePost(args.bridgeUrl, '/ungroup-nodes', {
      sessionId,
      nodeIds: [groupNode.nodeId],
      skipSnapshot: true,
    });
    if (findNodeByName(state, 'SmokeGroup')) throw new Error('ungroup-nodes did not remove SmokeGroup');
    const restoredText = requireNode(state, 'SmokeText');
    const restoredImage = requireNode(state, 'SmokeImage');
    if (restoredText.parentId !== rootNodeId || restoredImage.parentId !== rootNodeId) {
      throw new Error('ungroup-nodes did not restore children under root');
    }

    const targetState = await bridgePost(args.bridgeUrl, '/create-blank-artboard', {
      name: `BridgeOpsPasteTarget_${Date.now()}`,
      width: 1080,
      height: 1920,
      skipSnapshot: true,
      profile: true,
    });
    targetSessionId = targetState.session.sessionId;
    targetWorkingPrefabPath = targetState.session.workingPrefabPath;
    if (!targetSessionId || !targetWorkingPrefabPath || !targetState.rootNodeId) {
      throw new Error('target blank artboard did not return session/root state');
    }

    const crossPasteState = await bridgePost(args.bridgeUrl, '/copy-nodes-to-session', {
      sourceSessionId: sessionId,
      targetSessionId,
      nodeIds: [restoredText.nodeId, restoredImage.nodeId],
      targetParentId: targetState.rootNodeId,
      offsetX: 40,
      offsetY: -40,
      skipSnapshot: true,
    });
    const pastedText = requireComponent(crossPasteState, 'SmokeText_copy', 'Text');
    const pastedImage = requireComponent(crossPasteState, 'SmokeImage_copy', 'Image');
    if (pastedText.parentId !== targetState.rootNodeId || pastedImage.parentId !== targetState.rootNodeId) {
      throw new Error('copy-nodes-to-session did not paste nodes under target root');
    }

    const complexSource = await bridgePost(args.bridgeUrl, '/open-prefab', {
      prefabPath: 'UICommons/UIAlert2.prefab',
      mode: 'temp-copy',
      skipSnapshot: true,
      profile: true,
    });
    complexSourceSessionId = complexSource.session.sessionId;
    complexSourceWorkingPrefabPath = complexSource.session.workingPrefabPath;
    if (!complexSourceSessionId || !complexSourceWorkingPrefabPath) {
      throw new Error('complex source prefab did not return session state');
    }
    const complexSourceTree = await bridgePost(args.bridgeUrl, '/export-node-tree', {
      sessionId: complexSourceSessionId,
      includeInactive: true,
      includeComponents: true,
      includeProtectedFields: true,
    });
    const okButtonSource = requireNodeComponents(complexSourceTree, 'okBtn', [
      'RectTransform',
      'Image',
      'Button',
      'HorizontalLayoutGroup',
      'LuaBehaviour',
      'UIButtonPressScaleEffect',
    ]);
    const sourceDescendantCount = countDescendants(complexSourceTree.nodes, okButtonSource.nodeId);
    if (sourceDescendantCount < 2) {
      throw new Error(`complex source okBtn descendant count too small: ${sourceDescendantCount}`);
    }

    const complexTarget = await bridgePost(args.bridgeUrl, '/create-blank-artboard', {
      name: `BridgeOpsComplexPasteTarget_${Date.now()}`,
      width: 1080,
      height: 1920,
      skipSnapshot: true,
      profile: true,
    });
    complexTargetSessionId = complexTarget.session.sessionId;
    complexTargetWorkingPrefabPath = complexTarget.session.workingPrefabPath;
    if (!complexTargetSessionId || !complexTargetWorkingPrefabPath || !complexTarget.rootNodeId) {
      throw new Error('complex target blank artboard did not return session/root state');
    }
    const complexPasteState = await bridgePost(args.bridgeUrl, '/copy-nodes-to-session', {
      sourceSessionId: complexSourceSessionId,
      targetSessionId: complexTargetSessionId,
      nodeIds: [okButtonSource.nodeId],
      targetParentId: complexTarget.rootNodeId,
      offsetX: 80,
      offsetY: -80,
      skipSnapshot: true,
    });
    const pastedOkButton = requireNodeComponents(complexPasteState, 'okBtn_copy', [
      'RectTransform',
      'Image',
      'Button',
      'HorizontalLayoutGroup',
      'LuaBehaviour',
      'UIButtonPressScaleEffect',
    ]);
    const pastedNeedIcon = requireChildByName(complexPasteState, pastedOkButton.nodeId, 'needIcon');
    const pastedOkText = requireChildByName(complexPasteState, pastedOkButton.nodeId, 'okText');
    if (!nodeComponentTypes(pastedNeedIcon).has('Image')) throw new Error('pasted needIcon did not preserve Image');
    if (!nodeComponentTypes(pastedOkText).has('Text')) throw new Error('pasted okText did not preserve Text');
    const pastedDescendantCount = countDescendants(complexPasteState.nodes, pastedOkButton.nodeId);
    if (pastedDescendantCount !== sourceDescendantCount) {
      throw new Error(`complex paste descendant count mismatch: source ${sourceDescendantCount}, pasted ${pastedDescendantCount}`);
    }
    const supportsControlledStructureBaseline = typeof health.version === 'string' && !health.version.includes('mvp-2');
    let complexProtectedDiff = null;
    if (supportsControlledStructureBaseline) {
      complexProtectedDiff = await bridgePost(args.bridgeUrl, '/validate-protected-diff', {
        sessionId: complexTargetSessionId,
        baseRevision: '',
        currentRevision: complexPasteState.revision ?? '',
        includeTextDiff: false,
      });
      if ((complexProtectedDiff.summary?.protectedCount ?? 0) !== 0) {
        throw new Error(`complex paste protected diff has blocked changes: ${JSON.stringify(complexProtectedDiff.protectedChanges ?? [])}`);
      }
    } else {
      complexProtectedDiff = {
        skipped: true,
        reason: `Bridge ${health.version ?? 'unknown'} does not include controlled structure protected-baseline refresh`,
      };
    }

    report.createdWidgets = createdWidgets;
    report.opacityResults = opacityResults;
    report.textStyleResult = textStyleResult;
    report.visualComponentResult = visualComponentResult;
    report.geometryResult = geometryResult;
    report.alignDistributeResult = alignDistributeResult;
    report.duplicateNodeId = duplicateNode.nodeId;
    report.ungroupedNodeIds = [restoredText.nodeId, restoredImage.nodeId];
    report.crossSessionPaste = {
      targetSessionId,
      pastedNodeIds: [pastedText.nodeId, pastedImage.nodeId],
    };
    report.complexCrossSessionPaste = {
      sourcePrefabPath: complexSource.session.sourcePrefabPath,
      targetSessionId: complexTargetSessionId,
      pastedNodeId: pastedOkButton.nodeId,
      sourceDescendantCount,
      pastedDescendantCount,
      protectedDiffSummary: complexProtectedDiff.summary ?? null,
      protectedDiffSkipped: complexProtectedDiff.skipped === true ? complexProtectedDiff.reason : null,
      preservedComponents: (pastedOkButton.components ?? []).map((component) => component.type),
      preservedChildren: [pastedNeedIcon.name, pastedOkText.name],
    };
    report.finalNodeCount = state.nodes.length;

    await bridgePost(args.bridgeUrl, '/close-prefab', {
      sessionId: complexTargetSessionId,
      deleteTempObjects: true,
    });
    report.complexTargetClosed = true;
    report.complexTargetTempCleanup = {
      assetPath: complexTargetWorkingPrefabPath,
      exists: projectAssetExists(health.projectPath, complexTargetWorkingPrefabPath),
    };
    if (report.complexTargetTempCleanup.exists) throw new Error(`complex target temp prefab still exists after close: ${complexTargetWorkingPrefabPath}`);
    complexTargetSessionId = '';

    await bridgePost(args.bridgeUrl, '/close-prefab', {
      sessionId: complexSourceSessionId,
      deleteTempObjects: true,
    });
    report.complexSourceClosed = true;
    report.complexSourceTempCleanup = {
      assetPath: complexSourceWorkingPrefabPath,
      exists: projectAssetExists(health.projectPath, complexSourceWorkingPrefabPath),
    };
    if (report.complexSourceTempCleanup.exists) throw new Error(`complex source temp prefab still exists after close: ${complexSourceWorkingPrefabPath}`);
    complexSourceSessionId = '';

    await bridgePost(args.bridgeUrl, '/close-prefab', {
      sessionId: targetSessionId,
      deleteTempObjects: true,
    });
    report.targetClosed = true;
    report.targetTempCleanup = {
      assetPath: targetWorkingPrefabPath,
      exists: projectAssetExists(health.projectPath, targetWorkingPrefabPath),
    };
    if (report.targetTempCleanup.exists) throw new Error(`target temp prefab still exists after close: ${targetWorkingPrefabPath}`);
    targetSessionId = '';

    await bridgePost(args.bridgeUrl, '/close-prefab', {
      sessionId,
      deleteTempObjects: true,
    });
    report.closed = true;
    report.tempCleanup = {
      assetPath: workingPrefabPath,
      exists: projectAssetExists(health.projectPath, workingPrefabPath),
    };
    if (report.tempCleanup.exists) throw new Error(`temp prefab still exists after close: ${workingPrefabPath}`);

    report.ok = true;
    report.finishedAt = new Date().toISOString();
    await writeFile(path.join(args.out, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
    console.log(JSON.stringify({
      ok: true,
      widgetCount: createdWidgets.length,
      opacityResults,
      visualComponentProtectedCount: report.visualComponentResult?.protectedCount ?? null,
      outlineShadowVisualDiff: report.visualComponentResult?.outlineShadowVisualDiff ?? null,
      geometryProtectedCount: report.geometryResult?.protectedCount ?? null,
      geometryBbox: report.geometryResult?.bbox ?? null,
      alignDistribute: report.alignDistributeResult ?? null,
      crossSessionPaste: report.crossSessionPaste,
      complexCrossSessionPaste: report.complexCrossSessionPaste,
      duplicateNodeId: report.duplicateNodeId,
      finalNodeCount: report.finalNodeCount,
      tempCleaned: !report.tempCleanup.exists &&
        !report.targetTempCleanup.exists &&
        !report.complexSourceTempCleanup.exists &&
        !report.complexTargetTempCleanup.exists,
      reportPath: path.join(args.out, 'report.json'),
    }, null, 2));
  } catch (err) {
    report.ok = false;
    report.error = err instanceof Error ? err.stack || err.message : String(err);
    if (complexTargetSessionId) {
      await bridgePost(args.bridgeUrl, '/close-prefab', { sessionId: complexTargetSessionId, deleteTempObjects: true }).catch(() => undefined);
      report.complexTargetClosedAfterFailure = true;
    }
    if (complexSourceSessionId) {
      await bridgePost(args.bridgeUrl, '/close-prefab', { sessionId: complexSourceSessionId, deleteTempObjects: true }).catch(() => undefined);
      report.complexSourceClosedAfterFailure = true;
    }
    if (targetSessionId) {
      await bridgePost(args.bridgeUrl, '/close-prefab', { sessionId: targetSessionId, deleteTempObjects: true }).catch(() => undefined);
      report.targetClosedAfterFailure = true;
    }
    if (sessionId) {
      await bridgePost(args.bridgeUrl, '/close-prefab', { sessionId, deleteTempObjects: true }).catch(() => undefined);
      report.closedAfterFailure = true;
    }
    report.targetTempCleanup = targetWorkingPrefabPath && report.bridgeHealth
      ? { assetPath: targetWorkingPrefabPath, exists: projectAssetExists(report.bridgeHealth.projectPath, targetWorkingPrefabPath) }
      : null;
    report.complexTargetTempCleanup = complexTargetWorkingPrefabPath && report.bridgeHealth
      ? { assetPath: complexTargetWorkingPrefabPath, exists: projectAssetExists(report.bridgeHealth.projectPath, complexTargetWorkingPrefabPath) }
      : null;
    report.complexSourceTempCleanup = complexSourceWorkingPrefabPath && report.bridgeHealth
      ? { assetPath: complexSourceWorkingPrefabPath, exists: projectAssetExists(report.bridgeHealth.projectPath, complexSourceWorkingPrefabPath) }
      : null;
    report.tempCleanup = workingPrefabPath && report.bridgeHealth
      ? { assetPath: workingPrefabPath, exists: projectAssetExists(report.bridgeHealth.projectPath, workingPrefabPath) }
      : null;
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

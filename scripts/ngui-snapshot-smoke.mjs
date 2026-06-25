import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const args = {
    bridgeUrl: 'http://127.0.0.1:18082',
    prefab: 'Assets/HotRes/Parts/HeroDisplay/DD_FP_HeroDisplay.prefab',
    width: 1080,
    height: 1920,
    repeats: 3,
    minImageBytes: 20000,
    minActiveBoxes: 8,
    minDrawableBoxes: 3,
    maxBboxDrift: 1.5,
    out: path.join(ROOT, '.cache', 'ngui-snapshot-smoke', 'latest'),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const next = argv[i + 1];
    if (key === '--bridge-url') { args.bridgeUrl = next; i += 1; }
    else if (key === '--prefab') { args.prefab = next; i += 1; }
    else if (key === '--width') { args.width = Number(next); i += 1; }
    else if (key === '--height') { args.height = Number(next); i += 1; }
    else if (key === '--repeats') { args.repeats = Number(next); i += 1; }
    else if (key === '--min-image-bytes') { args.minImageBytes = Number(next); i += 1; }
    else if (key === '--min-active-boxes') { args.minActiveBoxes = Number(next); i += 1; }
    else if (key === '--min-drawable-boxes') { args.minDrawableBoxes = Number(next); i += 1; }
    else if (key === '--max-bbox-drift') { args.maxBboxDrift = Number(next); i += 1; }
    else if (key === '--out') { args.out = path.resolve(next); i += 1; }
  }
  return args;
}

function normalizeBaseUrl(value) {
  return value.replace(/\/+$/, '');
}

async function bridgeGetJson(bridgeUrl, endpoint, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${normalizeBaseUrl(bridgeUrl)}${endpoint}`, {
      cache: 'no-store',
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) throw new Error(`${endpoint} failed: ${res.status} ${JSON.stringify(data)}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
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
    if (!res.ok || !data?.ok) throw new Error(`${endpoint} failed: ${res.status} ${JSON.stringify(data)}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchSnapshotBytes(bridgeUrl, snapshot) {
  const rawUrl = snapshot?.image?.url;
  if (!rawUrl) throw new Error(`snapshot image URL is missing: ${JSON.stringify(snapshot?.image ?? null)}`);
  const url = rawUrl.startsWith('http') ? rawUrl : `${normalizeBaseUrl(bridgeUrl)}${rawUrl}`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`snapshot image fetch failed: ${res.status} ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

function isJpeg(buffer) {
  return buffer.length >= 4 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[buffer.length - 2] === 0xff &&
    buffer[buffer.length - 1] === 0xd9;
}

function assertProfileEntries(profile, required, forbidden = []) {
  const names = new Set((profile?.entries ?? []).map((entry) => entry.name));
  const missing = required.filter((name) => !names.has(name));
  if (missing.length > 0) throw new Error(`missing profile entries: ${missing.join(', ')}`);
  const presentForbidden = forbidden.filter((name) => names.has(name));
  if (presentForbidden.length > 0) throw new Error(`unexpected profile entries: ${presentForbidden.join(', ')}`);
}

function bboxStats(snapshot) {
  const boxes = Array.isArray(snapshot?.bboxes) ? snapshot.bboxes : [];
  const finiteBoxes = boxes.filter((box) => (
    Number.isFinite(box.x) &&
    Number.isFinite(box.y) &&
    Number.isFinite(box.width) &&
    Number.isFinite(box.height)
  ));
  const activeBoxes = finiteBoxes.filter((box) => box.activeInHierarchy && box.width > 1 && box.height > 1);
  const drawableBoxes = activeBoxes.filter((box) => box.contributesToBounds);
  const unionSource = drawableBoxes.length > 0 ? drawableBoxes : activeBoxes;
  const union = unionSource.length > 0
    ? {
        x: Math.min(...unionSource.map((box) => box.x)),
        y: Math.min(...unionSource.map((box) => box.y)),
        right: Math.max(...unionSource.map((box) => box.x + box.width)),
        bottom: Math.max(...unionSource.map((box) => box.y + box.height)),
      }
    : null;
  const unionRect = union
    ? { x: union.x, y: union.y, width: union.right - union.x, height: union.bottom - union.y }
    : null;
  return {
    total: boxes.length,
    finite: finiteBoxes.length,
    active: activeBoxes.length,
    drawable: drawableBoxes.length,
    invalid: boxes.length - finiteBoxes.length,
    union: unionRect,
  };
}

function assertSnapshotShape(snapshot, args, label) {
  if (!snapshot) throw new Error(`${label}: snapshot is missing`);
  if (snapshot.width !== args.width || snapshot.height !== args.height) {
    throw new Error(`${label}: unexpected snapshot size ${snapshot.width}x${snapshot.height}`);
  }
  if (snapshot.coordinateSpace !== 'top-left-pixel') {
    throw new Error(`${label}: unexpected coordinate space ${snapshot.coordinateSpace}`);
  }
  if (snapshot.image?.format !== 'jpg') {
    throw new Error(`${label}: expected jpg snapshot, got ${snapshot.image?.format}`);
  }
  const stats = bboxStats(snapshot);
  if (stats.invalid > 0) throw new Error(`${label}: snapshot has ${stats.invalid} invalid bboxes`);
  if (stats.active < args.minActiveBoxes) throw new Error(`${label}: too few active bboxes (${stats.active})`);
  if (stats.drawable < args.minDrawableBoxes) throw new Error(`${label}: too few drawable bboxes (${stats.drawable})`);
  if (!stats.union || stats.union.width < 16 || stats.union.height < 16) {
    throw new Error(`${label}: drawable bbox union is empty or tiny`);
  }
  return stats;
}

async function validateSnapshotImage(bridgeUrl, snapshot, args, label) {
  const bytes = await fetchSnapshotBytes(bridgeUrl, snapshot);
  if (bytes.length < args.minImageBytes) {
    throw new Error(`${label}: snapshot image is suspiciously small (${bytes.length} bytes)`);
  }
  if (!isJpeg(bytes)) throw new Error(`${label}: snapshot image is not a valid JPEG`);
  return { bytes: bytes.length, url: snapshot.image.url, snapshotId: snapshot.snapshotId };
}

function bboxMap(snapshot) {
  const result = new Map();
  for (const box of snapshot?.bboxes ?? []) {
    if (!box.activeInHierarchy || box.width <= 1 || box.height <= 1) continue;
    result.set(box.nodeId, box);
  }
  return result;
}

function compareBboxes(a, b) {
  const left = bboxMap(a);
  const right = bboxMap(b);
  let common = 0;
  let maxDelta = 0;
  for (const [nodeId, box] of left) {
    const next = right.get(nodeId);
    if (!next) continue;
    common += 1;
    maxDelta = Math.max(
      maxDelta,
      Math.abs(box.x - next.x),
      Math.abs(box.y - next.y),
      Math.abs(box.width - next.width),
      Math.abs(box.height - next.height),
    );
  }
  return { left: left.size, right: right.size, common, maxDelta };
}

function countNguiComponents(nodes) {
  const names = new Set(['UIRoot', 'UIPanel', 'UIWidget', 'UILabel', 'UISprite', 'UITexture', 'UI2DSprite']);
  let count = 0;
  for (const node of nodes ?? []) {
    for (const component of node.components ?? []) {
      if (names.has(component.type)) count += 1;
    }
  }
  return count;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await mkdir(args.out, { recursive: true });
  const report = {
    ok: false,
    args,
    startedAt: new Date().toISOString(),
  };
  let sessionId = null;

  try {
    report.health = await bridgeGetJson(args.bridgeUrl, '/health');
    const open = await bridgePost(args.bridgeUrl, '/open-prefab', {
      prefabPath: args.prefab,
      mode: 'temp-copy',
      width: args.width,
      height: args.height,
    });
    sessionId = open.session?.sessionId;
    if (!sessionId) throw new Error('open-prefab did not return a sessionId');
    if (open.session?.framework !== 'ngui') throw new Error(`expected ngui session, got ${open.session?.framework}`);

    const tree = await bridgePost(args.bridgeUrl, '/export-node-tree', {
      sessionId,
      includeInactive: true,
      includeComponents: true,
      includeProtectedFields: false,
    });
    const nguiComponentCount = countNguiComponents(tree.nodes);
    if (nguiComponentCount <= 0) throw new Error('export-node-tree did not expose NGUI components');

    const snapshots = [];
    for (let i = 0; i < args.repeats; i += 1) {
      const render = await bridgePost(args.bridgeUrl, '/render-snapshot', {
        sessionId,
        width: args.width,
        height: args.height,
        backgroundColor: '#162D3FFF',
        includeBboxes: true,
        imageMode: 'file',
        profile: true,
      });
      assertProfileEntries(
        render.profile,
        [
          'snapshot.ngui.prime',
          'snapshot.ngui.collectBboxes',
          'snapshot.ngui.render',
          'snapshot.ngui.encodeJpg',
          'snapshot.ngui.writeJpg',
        ],
        ['snapshot.setupScene', 'snapshot.instantiatePrefab'],
      );
      const stats = assertSnapshotShape(render.snapshot, args, `render ${i + 1}`);
      const image = await validateSnapshotImage(args.bridgeUrl, render.snapshot, args, `render ${i + 1}`);
      snapshots.push({ snapshot: render.snapshot, profile: render.profile, stats, image });
    }

    const comparisons = [];
    for (let i = 1; i < snapshots.length; i += 1) {
      const comparison = compareBboxes(snapshots[0].snapshot, snapshots[i].snapshot);
      if (comparison.common < Math.min(snapshots[0].stats.active, snapshots[i].stats.active) * 0.8) {
        throw new Error(`render ${i + 1}: too few common bboxes (${comparison.common})`);
      }
      if (comparison.maxDelta > args.maxBboxDrift) {
        throw new Error(`render ${i + 1}: bbox drift ${comparison.maxDelta}px exceeds ${args.maxBboxDrift}px`);
      }
      comparisons.push(comparison);
    }

    const resumed = await bridgePost(args.bridgeUrl, '/resume-session', {
      workingPrefabPath: open.session.workingPrefabPath,
      sourcePrefabPath: open.session.sourcePrefabPath,
    });
    if (resumed.session?.framework !== 'ngui') throw new Error(`resume-session returned ${resumed.session?.framework}`);
    const resumeStats = assertSnapshotShape(resumed.snapshot, args, 'resume-session');
    const resumeImage = await validateSnapshotImage(args.bridgeUrl, resumed.snapshot, args, 'resume-session');

    report.ok = true;
    report.finishedAt = new Date().toISOString();
    report.session = {
      sourcePrefabPath: open.session.sourcePrefabPath,
      workingPrefabPath: open.session.workingPrefabPath,
      framework: open.session.framework,
    };
    report.tree = {
      nodeCount: tree.nodes?.length ?? 0,
      nguiComponentCount,
      rootNodeId: tree.rootNodeId,
    };
    report.snapshots = snapshots.map((item) => ({
      snapshotId: item.image.snapshotId,
      url: item.image.url,
      bytes: item.image.bytes,
      bbox: item.stats,
      profileTotalMs: item.profile?.totalMs ?? null,
    }));
    report.comparisons = comparisons;
    report.resume = {
      snapshotId: resumeImage.snapshotId,
      url: resumeImage.url,
      bytes: resumeImage.bytes,
      bbox: resumeStats,
    };
  } catch (err) {
    report.ok = false;
    report.error = err instanceof Error ? err.stack || err.message : String(err);
    report.finishedAt = new Date().toISOString();
    process.exitCode = 1;
  } finally {
    if (sessionId) {
      await bridgePost(args.bridgeUrl, '/close-prefab', { sessionId, deleteTempObjects: true }, 30000)
        .catch((err) => {
          report.closeError = err instanceof Error ? err.message : String(err);
        });
    }
    await writeFile(path.join(args.out, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  }

  const summary = report.ok
    ? {
        ok: true,
        nodeCount: report.tree.nodeCount,
        nguiComponentCount: report.tree.nguiComponentCount,
        snapshotCount: report.snapshots.length,
        firstSnapshotBytes: report.snapshots[0]?.bytes,
        activeBboxes: report.snapshots[0]?.bbox?.active,
        drawableBboxes: report.snapshots[0]?.bbox?.drawable,
        maxBboxDrift: Math.max(0, ...report.comparisons.map((item) => item.maxDelta)),
        reportPath: path.join(args.out, 'report.json'),
      }
    : {
        ok: false,
        error: report.error,
        closeError: report.closeError,
        reportPath: path.join(args.out, 'report.json'),
      };
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

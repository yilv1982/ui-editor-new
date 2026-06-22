import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent, setGlobalDispatcher } from 'undici';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const args = {
    url: 'http://127.0.0.1:3001/',
    out: path.join(ROOT, '.cache', 'visual-samples', 'generated-cases.json'),
    width: 1080,
    height: 1920,
    viewportWidth: 1200,
    viewportHeight: 900,
    captureReference: true,
    probeRetries: 2,
    editorCrop: 'expected',
    maxCasesPerPrefab: 10,
    maxImportantPerPrefab: 4,
    minLargeAreaRatio: 0.08,
    maxLargeAreaRatio: 1.15,
    includeDuplicates: false,
    components: false,
    componentLimit: 0,
    componentOffset: 0,
    componentFilter: '',
    prefabs: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const next = argv[i + 1];
    if (key === '--url') { args.url = next; i++; }
    else if (key === '--out') { args.out = path.resolve(next); i++; }
    else if (key === '--prefab') { args.prefabs.push(next); i++; }
    else if (key === '--prefabs') {
      args.prefabs.push(...String(next).split(',').map((item) => item.trim()).filter(Boolean));
      i++;
    }
    else if (key === '--prefab-list') {
      args.prefabList = path.resolve(next);
      i++;
    }
    else if (key === '--width') { args.width = Number(next); i++; }
    else if (key === '--height') { args.height = Number(next); i++; }
    else if (key === '--viewport-width') { args.viewportWidth = Number(next); i++; }
    else if (key === '--viewport-height') { args.viewportHeight = Number(next); i++; }
    else if (key === '--capture-reference') args.captureReference = true;
    else if (key === '--no-capture-reference') args.captureReference = false;
    else if (key === '--probe-retries') { args.probeRetries = Number(next); i++; }
    else if (key === '--editor-crop') { args.editorCrop = next; i++; }
    else if (key === '--max-cases-per-prefab') { args.maxCasesPerPrefab = Number(next); i++; }
    else if (key === '--max-important-per-prefab') { args.maxImportantPerPrefab = Number(next); i++; }
    else if (key === '--min-large-area-ratio') { args.minLargeAreaRatio = Number(next); i++; }
    else if (key === '--max-large-area-ratio') { args.maxLargeAreaRatio = Number(next); i++; }
    else if (key === '--include-duplicates') args.includeDuplicates = true;
    else if (key === '--components') args.components = true;
    else if (key === '--component-limit') { args.componentLimit = Number(next); i++; }
    else if (key === '--component-offset') { args.componentOffset = Number(next); i++; }
    else if (key === '--component-filter') { args.componentFilter = next; i++; }
    else if (!key.startsWith('-')) args.prefabs.push(key);
  }

  if (!Number.isFinite(args.width) || args.width <= 0) args.width = 1080;
  if (!Number.isFinite(args.height) || args.height <= 0) args.height = 1920;
  if (!Number.isFinite(args.viewportWidth) || args.viewportWidth <= 0) args.viewportWidth = 1200;
  if (!Number.isFinite(args.viewportHeight) || args.viewportHeight <= 0) args.viewportHeight = 900;
  if (!Number.isFinite(args.probeRetries) || args.probeRetries < 0) args.probeRetries = 2;
  if (!Number.isFinite(args.maxCasesPerPrefab) || args.maxCasesPerPrefab <= 0) args.maxCasesPerPrefab = 10;
  if (!Number.isFinite(args.maxImportantPerPrefab) || args.maxImportantPerPrefab < 0) args.maxImportantPerPrefab = 4;
  if (!Number.isFinite(args.minLargeAreaRatio) || args.minLargeAreaRatio < 0) args.minLargeAreaRatio = 0.08;
  if (!Number.isFinite(args.maxLargeAreaRatio) || args.maxLargeAreaRatio <= 0) args.maxLargeAreaRatio = 1.15;
  if (!Number.isFinite(args.componentLimit) || args.componentLimit < 0) args.componentLimit = 0;
  if (!Number.isFinite(args.componentOffset) || args.componentOffset < 0) args.componentOffset = 0;
  return args;
}

function slug(value) {
  return String(value ?? 'case')
    .trim()
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'case';
}

function normalizeUrl(value) {
  const url = new URL(value);
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.toString();
}

function allowLocalSelfSignedCertificates(baseUrl) {
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:') return;
  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) return;
  setGlobalDispatcher(new Agent({ connect: { rejectUnauthorized: false } }));
}

async function readPrefabList(filePath) {
  const text = (await readFile(filePath, 'utf8')).replace(/^\uFEFF/, '');
  if (filePath.toLowerCase().endsWith('.json')) {
    const data = JSON.parse(text);
    if (Array.isArray(data)) return data.map(String);
    if (Array.isArray(data.prefabs)) return data.prefabs.map(String);
    throw new Error(`JSON prefab list must be an array or { "prefabs": [] }: ${filePath}`);
  }
  return text
    .split(/\r?\n/g)
    .map((line) => line.replace(/#.*/, '').trim())
    .filter(Boolean);
}

async function fetchPrefabTree(baseUrl, prefab) {
  const url = new URL('/api/prefabs/parse', baseUrl);
  url.searchParams.set('path', prefab);
  const res = await fetch(url);
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Prefab parse returned non-JSON (${res.status}) for ${prefab}: ${text.slice(0, 300)}`);
  }
  if (!res.ok || !data.root) {
    throw new Error(`Prefab parse failed for ${prefab} (${res.status}): ${data.error ?? 'empty root'}`);
  }
  return data;
}

async function fetchComponents(baseUrl, args) {
  const url = new URL('/api/components/list', baseUrl);
  const res = await fetch(url);
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Component list returned non-JSON (${res.status}): ${text.slice(0, 300)}`);
  }
  if (!res.ok || !Array.isArray(data.components)) {
    throw new Error(`Component list failed (${res.status}): ${data.error ?? 'empty components'}`);
  }

  const filter = String(args.componentFilter || '').toLowerCase();
  let components = data.components
    .filter((item) => item?.relPath)
    .filter((item) => !filter || String(item.name || item.relPath).toLowerCase().includes(filter))
    .sort((a, b) => String(a.relPath).localeCompare(String(b.relPath)));
  if (args.componentOffset > 0) components = components.slice(args.componentOffset);
  if (args.componentLimit > 0) components = components.slice(0, args.componentLimit);
  return {
    commonPart: data.commonPart ?? null,
    components,
    prefabs: components.map((item) => String(item.relPath)),
  };
}

function collectNodes(root) {
  const rows = [];
  function isInactive(node) {
    return node?.active === false || node?.visible === false;
  }
  function visit(node, parentPath, depth, index, hiddenByAncestor = false) {
    if (!node || typeof node !== 'object') return;
    const name = String(node.name || `node-${index}`);
    const pathName = parentPath ? `${parentPath}/${name}` : name;
    const selfInactive = isInactive(node);
    const effectivelyActive = !hiddenByAncestor && !selfInactive;
    rows.push({
      node,
      path: pathName,
      depth,
      index: rows.length,
      hiddenByAncestor,
      effectivelyActive,
      inactiveReason: selfInactive
        ? (node.active === false ? 'inactive' : 'hidden')
        : hiddenByAncestor
          ? 'inactive-ancestor'
          : null,
    });
    for (let i = 0; i < (node.children?.length ?? 0); i++) {
      visit(node.children[i], pathName, depth + 1, i, hiddenByAncestor || selfInactive);
    }
  }
  visit(root, '', 0, 0);
  return rows;
}

function countNames(rows) {
  const counts = new Map();
  for (const row of rows) {
    const name = String(row.node.name || '');
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

function isRenderable(node) {
  return ['image', 'button', 'rawimage', 'scrollview', 'toggle', 'inputfield', 'component'].includes(node.type)
    || !!node.imagePath
    || !!node.imageColor;
}

function area(node) {
  const w = typeof node.width === 'number' ? Math.max(0, node.width) : 0;
  const h = typeof node.height === 'number' ? Math.max(0, node.height) : 0;
  return w * h;
}

function hasUsableVisualSize(node, depth) {
  if (depth === 0) return true;
  const w = typeof node.width === 'number' ? Math.max(0, node.width) : 0;
  const h = typeof node.height === 'number' ? Math.max(0, node.height) : 0;
  return w >= 8 && h >= 8 && w * h >= 64;
}

function isEligibleRow(row) {
  return row?.effectivelyActive !== false;
}

function addCandidate(candidates, row, score, reason, detail) {
  if (!isEligibleRow(row)) return;
  const key = row.path;
  const existing = candidates.get(key);
  if (!existing || score > existing.score) {
    candidates.set(key, { ...row, score, reason, detail });
  }
}

function scoreNodes(rows, rootArea, args) {
  const candidates = new Map();
  const root = rows[0];
  if (root) addCandidate(candidates, root, 1000, 'root', 'Prefab root bounds and child layout anchor.');

  for (const row of rows) {
    if (!isEligibleRow(row)) continue;
    const node = row.node;
    const type = node.type || 'frame';
    const nodeArea = area(node);
    const areaRatio = rootArea > 0 ? nodeArea / rootArea : 0;
    const usableVisualSize = hasUsableVisualSize(node, row.depth);

    if (!usableVisualSize) continue;

    if (type === 'scrollview' || node.scrollDirection) {
      addCandidate(candidates, row, node.imagePath ? 940 : 900, 'scrollview', node.imagePath
        ? 'ScrollView has its own background image and clipping/viewport behavior.'
        : 'ScrollView clipping, content, and viewport sizing behavior.');
    }
    if (node.isMask || node.maskType) {
      addCandidate(candidates, row, 880, 'mask', `Mask type: ${node.maskType || 'unknown'}.`);
    }
    if (node.layoutGroup?.enabled !== false || node.contentSizeFitter?.enabled !== false) {
      if (node.layoutGroup || node.contentSizeFitter) {
        addCandidate(candidates, row, 820, 'layout', 'LayoutGroup or ContentSizeFitter can change runtime bounds.');
      }
    }
    if (isRenderable(node) && areaRatio >= args.minLargeAreaRatio && areaRatio <= args.maxLargeAreaRatio) {
      addCandidate(candidates, row, 760 + Math.min(120, Math.round(areaRatio * 100)), 'large-renderable', `Area ratio ${areaRatio.toFixed(3)}.`);
    }
    if (type === 'component' || node.componentRef) {
      addCandidate(candidates, row, 690, 'component', `Nested prefab/component ${node.componentRef || node.name}.`);
    }
    if (type === 'button' || type === 'toggle' || type === 'inputfield') {
      addCandidate(candidates, row, 620, 'interactive', `${type} visual state and image/text composition.`);
    }
    if (node.imagePath && ['image', 'button', 'rawimage'].includes(type)) {
      addCandidate(candidates, row, 560, 'image', 'Image path, color, nine-slice, or fill settings.');
    }
    if (type === 'text') {
      addCandidate(candidates, row, 360, 'text', 'Text font, color, overflow, best-fit, or effect settings.');
    }
  }

  const sorted = [...candidates.values()].sort((a, b) =>
    b.score - a.score
    || a.depth - b.depth
    || b.node.width * b.node.height - a.node.width * a.node.height
    || a.path.localeCompare(b.path)
  );

  const forced = sorted.filter((item) => item.score >= 700);
  const important = sorted.filter((item) => item.score < 700).slice(0, args.maxImportantPerPrefab);
  return [...forced, ...important];
}

function selectComponentCoverage(rows, rootArea) {
  const selected = new Map();
  const add = (row, score, reason, detail) => {
    if (!isEligibleRow(row)) return;
    if (!row || !hasUsableVisualSize(row.node, row.depth)) return;
    const existing = selected.get(row.path);
    if (!existing || score > existing.score) {
      selected.set(row.path, { ...row, score, reason, detail });
    }
  };
  const topByArea = (filter, limit) => rows
    .filter(isEligibleRow)
    .filter((row) => filter(row.node, row))
    .filter((row) => hasUsableVisualSize(row.node, row.depth))
    .sort((a, b) => area(b.node) - area(a.node) || a.depth - b.depth || a.path.localeCompare(b.path))
    .slice(0, limit);

  add(rows[0], 1000, 'root', 'Prefab root bounds and child layout anchor.');
  for (const row of topByArea((node) => node.type === 'scrollview' || node.scrollDirection, 2)) {
    add(row, 940, 'scrollview', 'ScrollView clipping, content, and viewport sizing behavior.');
  }
  for (const row of topByArea((node) => node.isMask || node.maskType, 2)) {
    add(row, 900, 'mask', `Mask type: ${row.node.maskType || 'unknown'}.`);
  }
  for (const row of topByArea((node) => node.layoutGroup || node.contentSizeFitter, 2)) {
    add(row, 860, 'layout', 'LayoutGroup or ContentSizeFitter can change runtime bounds.');
  }
  for (const row of topByArea((node) => isRenderable(node) && rootArea > 0 && area(node) / rootArea >= 0.08, 2)) {
    add(row, 800, 'large-renderable', `Area ratio ${(area(row.node) / rootArea).toFixed(3)}.`);
  }
  for (const row of topByArea((node) => node.type === 'component' || node.componentRef, 2)) {
    add(row, 720, 'component', `Nested prefab/component ${row.node.componentRef || row.node.name}.`);
  }
  for (const row of topByArea((node) => ['button', 'toggle', 'inputfield'].includes(node.type), 2)) {
    add(row, 680, 'interactive', `${row.node.type} visual state and image/text composition.`);
  }
  for (const row of topByArea((node) => !!node.imagePath && ['image', 'button', 'rawimage'].includes(node.type), 2)) {
    add(row, 640, 'image', 'Image path, color, nine-slice, or fill settings.');
  }
  for (const row of topByArea((node) => node.type === 'text', 2)) {
    add(row, 600, 'text', 'Text font, color, overflow, best-fit, or effect settings.');
  }

  return [...selected.values()].sort((a, b) =>
    b.score - a.score
    || a.depth - b.depth
    || area(b.node) - area(a.node)
    || a.path.localeCompare(b.path)
  );
}

function makeCaseId(prefab, row, seenIds) {
  const base = `${slug(path.basename(prefab, '.prefab'))}-${slug(row.node.name)}-${slug(row.reason)}`;
  let id = base;
  let n = 2;
  while (seenIds.has(id)) {
    id = `${base}-${n}`;
    n++;
  }
  seenIds.add(id);
  return id;
}

function makeCases(prefab, parsed, args) {
  const rows = collectNodes(parsed.root);
  const nameCounts = countNames(rows);
  const rootArea = area(parsed.root);
  const selected = args.components
    ? selectComponentCoverage(rows, rootArea)
    : scoreNodes(rows, rootArea, args);
  const seenIds = new Set();
  const cases = [];
  const skipped = [];

  for (const row of selected) {
    const name = String(row.node.name || '');
    const duplicateName = (nameCounts.get(name) ?? 0) > 1;
    if (!args.includeDuplicates && duplicateName && !row.path) {
      skipped.push({
        path: row.path,
        name,
        type: row.node.type,
        reason: row.reason,
        why: 'duplicate-name',
      });
      continue;
    }

    cases.push({
      id: makeCaseId(prefab, row, seenIds),
      title: `${row.node.name} (${row.reason})`,
      prefab,
      name,
      targetPath: row.path,
      targetUnityFileId: row.node.unityFileId,
      editorCrop: args.editorCrop,
      metadata: {
        path: row.path,
        type: row.node.type || 'frame',
        depth: row.depth,
        reason: row.reason,
        score: row.score,
        detail: row.detail,
        width: row.node.width,
        height: row.node.height,
      },
    });

    if (cases.length >= args.maxCasesPerPrefab) break;
  }

  return {
    cases,
    skipped,
    stats: {
      nodeCount: rows.length,
      candidateCount: selected.length,
      hiddenNodeCount: rows.filter((row) => !isEligibleRow(row)).length,
      duplicateNameCount: [...nameCounts.values()].filter((count) => count > 1).length,
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = normalizeUrl(args.url);
  allowLocalSelfSignedCertificates(baseUrl);
  if (args.prefabList) {
    args.prefabs.push(...await readPrefabList(args.prefabList));
  }
  let componentSource = null;
  if (args.components) {
    componentSource = await fetchComponents(baseUrl, args);
    args.prefabs.push(...componentSource.prefabs);
  }
  args.prefabs = [...new Set(args.prefabs.map((item) => String(item).trim()).filter(Boolean))];
  if (args.prefabs.length === 0 && !args.components) {
    throw new Error('visual-manifest requires --prefab <path>, --prefab-list <file>, or --components');
  }

  const allCases = [];
  const parseResults = [];
  const skipped = [];

  for (const prefab of args.prefabs) {
    let parsed;
    try {
      parsed = await fetchPrefabTree(baseUrl, prefab);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      skipped.push({
        prefab,
        reason: 'parse-error',
        code: 'prefab-parse-skipped',
        message,
      });
      parseResults.push({
        prefab,
        parsedName: prefab.replace(/^.*[\\/]/, '').replace(/\.prefab$/i, ''),
        sourcePath: '',
        generatedCases: 0,
        parseError: message,
      });
      continue;
    }
    const generated = makeCases(prefab, parsed, args);
    allCases.push(...generated.cases);
    skipped.push(...generated.skipped.map((item) => ({ prefab, ...item })));
    parseResults.push({
      prefab,
      parsedName: parsed.name,
      sourcePath: parsed.sourcePath,
      generatedCases: generated.cases.length,
      ...generated.stats,
    });
  }

  const manifest = {
    url: baseUrl,
    width: args.width,
    height: args.height,
    viewportWidth: args.viewportWidth,
    viewportHeight: args.viewportHeight,
    captureReference: args.captureReference,
    probeRetries: args.probeRetries,
    editorCrop: args.editorCrop,
    generatedAt: new Date().toISOString(),
    generator: {
      script: 'scripts/visual-manifest.mjs',
      maxCasesPerPrefab: args.maxCasesPerPrefab,
      maxImportantPerPrefab: args.maxImportantPerPrefab,
      minLargeAreaRatio: args.minLargeAreaRatio,
      maxLargeAreaRatio: args.maxLargeAreaRatio,
      includeDuplicates: args.includeDuplicates,
      components: args.components,
      componentLimit: args.componentLimit,
      componentOffset: args.componentOffset,
      componentFilter: args.componentFilter,
      rules: [
        'root',
        'scrollview',
        'mask',
        'layoutGroup/contentSizeFitter',
        'large renderable images/components',
        'first important component/button/image/text nodes',
      ],
    },
    componentSource,
    prefabs: parseResults,
    skipped,
    cases: allCases,
  };

  await mkdir(path.dirname(args.out), { recursive: true });
  await writeFile(args.out, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  console.log(JSON.stringify({
    manifestPath: args.out,
    prefabCount: args.prefabs.length,
    caseCount: allCases.length,
    skippedCount: skipped.length,
    prefabs: parseResults,
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

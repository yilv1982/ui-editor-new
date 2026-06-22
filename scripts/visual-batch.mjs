import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const args = {
    manifest: '',
    out: path.join(ROOT, '.cache', 'visual-samples', 'latest'),
    failOnFindings: false,
    continueOnError: false,
    caseTimeoutMs: 300000,
    overrides: {},
  };

  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const next = argv[i + 1];
    if (key === '--manifest') { args.manifest = path.resolve(next); i++; }
    else if (key === '--out') { args.out = path.resolve(next); i++; }
    else if (key === '--case-timeout-ms') { args.caseTimeoutMs = Number(next); i++; }
    else if (key === '--fail-on-findings') args.failOnFindings = true;
    else if (key === '--continue-on-error') args.continueOnError = true;
    else if (key === '--url') { args.overrides.url = next; i++; }
    else if (key === '--unity-proxy') { args.overrides.unityProxy = next; i++; }
    else if (key === '--background-color') { args.overrides.backgroundColor = next; i++; }
    else if (key === '--width') { args.overrides.width = Number(next); i++; }
    else if (key === '--height') { args.overrides.height = Number(next); i++; }
    else if (key === '--viewport-width') { args.overrides.viewportWidth = Number(next); i++; }
    else if (key === '--viewport-height') { args.overrides.viewportHeight = Number(next); i++; }
    else if (key === '--capture-reference') args.overrides.captureReference = true;
  }

  if (!args.manifest) throw new Error('visual-batch requires --manifest <cases.json>');
  if (!existsSync(args.manifest)) throw new Error(`Manifest not found: ${args.manifest}`);
  if (!Number.isFinite(args.caseTimeoutMs) || args.caseTimeoutMs <= 0) args.caseTimeoutMs = 300000;
  return args;
}

function slug(value) {
  return String(value ?? 'case')
    .trim()
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'case';
}

function asRectArg(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.length === 4) return value.join(',');
  if (typeof value === 'object') {
    const { x, y, width, height } = value;
    if ([x, y, width, height].every((item) => typeof item === 'number' && Number.isFinite(item))) {
      return `${x},${y},${width},${height}`;
    }
  }
  throw new Error(`Invalid crop value: ${JSON.stringify(value)}`);
}

function resolveMaybeRelative(baseDir, value) {
  if (!value) return value;
  return path.isAbsolute(value) ? value : path.resolve(baseDir, value);
}

function rel(from, to) {
  return path.relative(from, to).replaceAll('\\', '/');
}

function parentPathOf(value) {
  const parts = String(value ?? '').split('/').filter(Boolean);
  if (parts.length <= 1) return '';
  parts.pop();
  return parts.join('/');
}

function pathParts(value) {
  return String(value ?? '').split('/').filter(Boolean);
}

function commonPrefixLength(a, b) {
  const length = Math.min(a.length, b.length);
  let i = 0;
  while (i < length && a[i] === b[i]) i++;
  return i;
}

function commonPrefixPath(paths) {
  const partsList = paths.map(pathParts).filter((parts) => parts.length > 0);
  if (partsList.length === 0) return '';
  let prefix = [...partsList[0]];
  for (const parts of partsList.slice(1)) {
    prefix = prefix.slice(0, commonPrefixLength(prefix, parts));
    if (prefix.length === 0) break;
  }
  return prefix.join('/');
}

function nameFromPath(value) {
  const parts = String(value ?? '').split('/').filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

function quoteCli(value) {
  return `"${String(value ?? '').replaceAll('"', '\\"')}"`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function usefulOverlapContextPath(item, targetPath) {
  const targetParts = pathParts(targetPath);
  if (targetParts.length <= 1) return '';
  const overlapNodes = Array.isArray(item.targetSubtree?.overlapContext?.nonTargetNodes)
    ? item.targetSubtree.overlapContext.nonTargetNodes
    : [];
  const overlapCandidates = overlapNodes
    .map((node) => {
      const parts = pathParts(node.path);
      const shared = commonPrefixLength(targetParts, parts);
      const cropRatio = Number(node.overlapDesign?.cropRatio ?? 0);
      const nodeRatio = Number(node.overlapDesign?.nodeRatio ?? 0);
      return { path: node.path, parts, shared, cropRatio, nodeRatio };
    })
    .filter((node) => node.path && node.parts.length > 1);
  const dominantRootOverlap = overlapCandidates.some((node) =>
    node.shared === 1 &&
    node.cropRatio >= 0.5
  );
  if (dominantRootOverlap) return targetParts[0] ?? '';

  const localOverlapPaths = overlapCandidates
    .filter((node) => node.path && node.parts.length > 1)
    .filter((node) => node.shared >= 2 && node.shared < targetParts.length)
    .filter((node) => node.cropRatio >= 0.05 && node.nodeRatio >= 0.03)
    .map((node) => node.path);
  if (localOverlapPaths.length === 0) return '';
  const contextPath = commonPrefixPath([targetPath, ...localOverlapPaths]);
  const contextParts = pathParts(contextPath);
  if (contextParts.length <= 1 || contextParts.length >= targetParts.length) return '';
  return contextPath;
}

function buildSuggestedParentCheck(item) {
  const targetPath = item.targetSubtree?.path || item.targetPath || item.args?.targetPath;
  const suggestedPath = usefulOverlapContextPath(item, targetPath) || parentPathOf(targetPath);
  if (!suggestedPath) return null;
  const suggestedName = nameFromPath(suggestedPath);
  if (!suggestedName) return null;
  const args = item.args ?? {};
  const out = path.join('.cache', 'visual-compares', `${slug(item.id)}-context-${slug(suggestedName)}`);
  const commandParts = [
    'npm run compare:visual --',
    '--capture-reference',
    '--prefab', quoteCli(item.prefab),
    '--name', quoteCli(suggestedName),
    '--target-path', quoteCli(suggestedPath),
    '--out', quoteCli(out),
  ];
  for (const [flag, value] of [
    ['--width', args.width],
    ['--height', args.height],
    ['--viewport-width', args.viewportWidth],
    ['--viewport-height', args.viewportHeight],
    ['--unity-proxy', args.unityProxy],
  ]) {
    if (value !== undefined && value !== null && value !== '') commandParts.push(flag, quoteCli(value));
  }
  commandParts.push('--fail-on-warnings', 'false');
  return {
    targetPath: suggestedPath,
    targetName: suggestedName,
    reason: 'Target crop overlaps sibling/nearby nodes; compare the nearest shared visual context to include the relevant surrounding UI.',
    command: commandParts.join(' '),
  };
}

function classifyFinding(text) {
  const value = String(text ?? '');
  if (/hidden or under an inactive ancestor|inactive target/i.test(value)) return 'target-hidden-or-inactive';
  if (/active root node\(s\) extend outside the current artboard/i.test(value)) return 'target-outside-artboard';
  if (/clipped artboard edge/i.test(value)) return 'visual-diff-clipped-edge';
  if (/layout-driven reference (?:crop|rect)|layout-driven or clipped target|runtime layout preferred sizes|preferred-size simulation/i.test(value)) return 'layout-driven-reference-diff';
  if (/layout-driven by ContentSizeFitter\/LayoutGroup/i.test(value)) return 'layout-driven-bound-diff';
  if (/target crop overlaps/i.test(value)) return 'crop-overlap-context';
  if (/Unity resolves \d+ sprite\(s\) that UIEditor did not map to imagePath/i.test(value)) return 'visual-diff-editor-missing-sprite-assets';
  if (/unresolved sprite reference/i.test(value)) return 'visual-diff-unresolved-sprites';
  if (/WebGL build is missing font/i.test(value)) return 'visual-diff-font-missing';
  if (/with geometry aligned on text rendering/i.test(value) && /(outline|shadow|syncOutline|syncShadow):(UIShadow|UnityOutline|UnityShadow)/i.test(value)) return 'visual-diff-text-effect';
  if (/with geometry aligned on text rendering/i.test(value)) return 'visual-diff-text-rendering';
  if (/visual diff changed/i.test(value) && /geometry aligned/i.test(value)) return 'visual-diff-geometry-aligned';
  if (/visual diff changed/i.test(value)) return 'visual-diff';
  if (/unity reference rect differs from uieditor design/i.test(value)) return 'unity-reference-design-diff';
  if (/crop aspect differs/i.test(value)) return 'crop-aspect-diff';
  if (/visible pixels cover only/i.test(value)) return 'pixel-coverage';
  if (/extra preview scale/i.test(value)) return 'extra-preview-scale';
  if (/unity bound differs from store expected/i.test(value)) return 'unity-bound-size-diff';
  if (/target subtree has/i.test(value)) return 'target-subtree-issues';
  return 'finding';
}

function targetNotes(item) {
  const notes = [];
  if (Array.isArray(item?.targetNotes)) notes.push(...item.targetNotes);
  if (Array.isArray(item?.targetSubtree?.notes)) notes.push(...item.targetSubtree.notes);
  return notes;
}

function hasLayoutDrivenBoundNotes(item) {
  return targetNotes(item).some((note) =>
    note?.code === 'layout-driven-bound-diff' ||
    /layout-driven|ContentSizeFitter|LayoutGroup/i.test(String(note?.message ?? ''))
  );
}

function hasLayoutDrivenContext(item) {
  if (hasLayoutDrivenBoundNotes(item)) return true;
  return (item?.findings ?? []).some((finding) =>
    /layout-driven reference (?:crop|rect)|layout-driven or clipped target|runtime layout preferred sizes|preferred-size simulation|ContentSizeFitter\/LayoutGroup/i.test(String(finding ?? ''))
  );
}

function isClippedToVisibleReference(item) {
  const summary = String(item?.analysis?.geometry?.summary ?? '');
  if (/clipped to visible reference area/i.test(summary)) return true;
  const expected = item?.analysis?.geometry?.expectedDesignRect;
  const crop = item?.visualDiff?.referenceCrop;
  if (!expected || !crop) return false;
  const widthClipped = Number(crop.width) + 0.5 < Number(expected.width);
  const heightClipped = Number(crop.height) + 0.5 < Number(expected.height);
  return widthClipped || heightClipped;
}

function visualChangedRatio(item) {
  const value = Number(item?.visualDiff?.changedRatio ?? item?.analysis?.visual?.changedRatio);
  return Number.isFinite(value) ? value : null;
}

function hasMissingFonts(item) {
  return Array.isArray(item?.analysis?.fontAvailability?.missing) &&
    item.analysis.fontAvailability.missing.length > 0;
}

function classifyFindingForItem(text, item) {
  const code = classifyFinding(text);
  const ratio = visualChangedRatio(item);

  if (code === 'visual-diff-geometry-aligned' && hasLayoutDrivenBoundNotes(item)) {
    return 'layout-driven-subtree-diff';
  }

  if ((code === 'visual-diff' || code === 'crop-aspect-diff') && hasLayoutDrivenContext(item)) {
    return 'layout-driven-subtree-diff';
  }

  if (code === 'visual-diff-text-rendering') {
    if (isClippedToVisibleReference(item)) return 'visual-diff-clipped-text';
    if (hasLayoutDrivenContext(item)) return 'layout-driven-subtree-diff';
    if (!hasMissingFonts(item) && ratio !== null && ratio <= 0.15) return 'visual-diff-font-rasterization';
  }

  return code;
}

function isSkippableFinding(text) {
  return [
    'visual-diff-font-missing',
    'crop-overlap-context',
    'target-hidden-or-inactive',
    'target-outside-artboard',
    'visual-diff-clipped-edge',
    'layout-driven-reference-diff',
    'layout-driven-bound-diff',
  ].includes(classifyFinding(text));
}

function isSkippableFindingForItem(text, item) {
  return [
    'visual-diff-font-missing',
    'visual-diff-font-rasterization',
    'visual-diff-clipped-text',
    'crop-overlap-context',
    'target-hidden-or-inactive',
    'target-outside-artboard',
    'visual-diff-clipped-edge',
    'layout-driven-reference-diff',
    'layout-driven-bound-diff',
    'layout-driven-subtree-diff',
  ].includes(classifyFindingForItem(text, item));
}

function recommendAction(code) {
  switch (code) {
    case 'target-hidden-or-inactive':
      return 'The selected target is hidden or under an inactive ancestor. Skip this target and compare an active parent or active variant.';
    case 'target-outside-artboard':
      return 'The target/root intentionally extends outside the artboard. Keep it reported, but do not treat the edge clip as a RectTransform repair unless parent-level comparison also fails.';
    case 'visual-diff-clipped-edge':
      return 'Geometry is aligned but the target is clipped by the artboard edge, so tiny sprite/filtering differences dominate the crop. Compare the active parent before changing RectTransform math.';
    case 'layout-driven-reference-diff':
      return 'Unity runtime layout changes the reference crop or bounds. Keep this case in skipped capability-gap reports until UIEditor implements full LayoutGroup/ContentSizeFitter preferred-size simulation.';
    case 'layout-driven-bound-diff':
      return 'The selected target has runtime bounds driven by ContentSizeFitter/LayoutGroup. Compare the active parent or keep this single-node case as skipped context.';
    case 'layout-driven-subtree-diff':
      return 'The target bounds are aligned, but child content is layout-driven by ContentSizeFitter/LayoutGroup. Keep this in skipped capability-gap reports until full Unity layout preferred-size simulation is implemented.';
    case 'webgl-bound-differs-from-store':
    case 'unity-bound-size-diff':
      return 'Check RectTransform import/export, preview resolution adaptation, and WebGL sync payload bounds.';
    case 'unity-reference-design-diff':
      return 'Check parent scale, CanvasScaler/world-corner capture, and whether UIEditor applies inherited RectTransform localScale.';
    case 'image-data-not-exported':
      return 'Check prefab parser imageData, asset path resolution, and preview imagePath export.';
    case 'mask-not-converted':
      return 'Check preview Mask to RectMask2D conversion and text/image clipping behavior.';
    case 'large-image-without-asset':
      return 'Check whether the node is a real tinted rectangle or a missing sprite/material reference.';
    case 'video-player-placeholder-without-asset':
      return 'RawImage content is supplied by Unity VideoPlayer at runtime. Keep this as a skipped capability gap unless the WebGL preview starts loading the same video texture.';
    case 'pixel-coverage':
      return 'Check clipping, masks, missing images, or target crop alignment.';
    case 'crop-overlap-context':
      return 'The target crop includes sibling or nearby renderable nodes. Compare a parent node, reduce pad, or treat pixel diff as contextual noise before changing layout math.';
    case 'visual-diff':
      return 'Inspect the comparison image and heatmap, then map the difference to targetSubtree nodes.';
    case 'visual-diff-geometry-aligned':
      return 'Geometry is already aligned. Inspect runtime text/data state, sprite/material differences, and child rendering order before changing RectTransform math.';
    case 'visual-diff-editor-missing-sprite-assets':
      return 'Geometry is already aligned and Unity resolves the sprite. Fix UIEditor prefab asset resolution or atlas/texture mapping so imageData exports to imagePath.';
    case 'visual-diff-unresolved-sprites':
      return 'Geometry is already aligned. Resolve the missing sprite metadata/assets or confirm the Unity project also has missing references before changing layout math.';
    case 'visual-diff-font-missing':
      return 'Geometry is already aligned. Rebuild the WebGL preview with the referenced Unity font included, or add a deterministic font substitution map before judging RectTransform changes.';
    case 'visual-diff-font-rasterization':
      return 'Geometry is aligned and fonts are present; this is a Unity Editor vs WebGL text rasterization parity gap. Keep it tracked as skipped unless text content or bounds also diverge.';
    case 'visual-diff-clipped-text':
      return 'The target is clipped by the 1080x1920 artboard, so partial text pixels dominate the crop. Keep it skipped and compare an unclipped parent/variant before changing layout math.';
    case 'visual-diff-text-effect':
      return 'Geometry is already aligned. Check font loading, UIShadow/outline style emulation, and text effect render order before changing RectTransform math.';
    case 'visual-diff-text-rendering':
      return 'Geometry is already aligned. Check font loading, text alignment/overflow, and WebGL text renderer parity before changing RectTransform math.';
    case 'crop-aspect-diff':
      return 'Check whether Unity reference bounds and UIEditor expected bounds describe the same target.';
    case 'extra-preview-scale':
      return 'Check camera scale and preview resolution compensation.';
    case 'runtime-error':
      return 'Open the case stderr and probe report, then fix the first failing runtime step.';
    case 'case-timeout':
      return 'Open runtime-error.txt, check the last probe/compare step, then reduce case scope or inspect stuck Unity/Chrome processes.';
    default:
      return 'Inspect compare-report.json and targetSubtree diagnostics for the affected node.';
  }
}

function issueSeverity(code, source) {
  if (source === 'error') return 'error';
  if (['visual-diff-font-missing', 'visual-diff-font-rasterization', 'visual-diff-clipped-text', 'crop-overlap-context', 'target-hidden-or-inactive', 'target-outside-artboard', 'visual-diff-clipped-edge', 'layout-driven-reference-diff', 'layout-driven-bound-diff', 'layout-driven-subtree-diff', 'video-player-placeholder-without-asset'].includes(code)) {
    return 'skip';
  }
  if (['webgl-bound-differs-from-store', 'unity-reference-design-diff', 'image-data-not-exported', 'mask-not-converted', 'large-image-without-asset', 'extra-preview-scale'].includes(code)) {
    return 'error';
  }
  if (['visual-diff', 'visual-diff-geometry-aligned', 'visual-diff-editor-missing-sprite-assets', 'visual-diff-unresolved-sprites', 'visual-diff-font-missing', 'visual-diff-text-effect', 'visual-diff-text-rendering', 'crop-aspect-diff', 'pixel-coverage', 'crop-overlap-context', 'target-subtree-issues'].includes(code)) {
    return 'warning';
  }
  return 'info';
}

function caseStatusClass(item) {
  if (item.status !== 'ok') return 'fail';
  const findings = Array.isArray(item.findings) ? item.findings : [];
  if (findings.length === 0) return 'pass';
  if (findings.every((finding) => isSkippableFindingForItem(finding, item))) return 'skip';
  return 'warn';
}

function buildIssueQueue(results) {
  const queue = [];
  const reportableSkipNotes = new Set([
    'video-player-placeholder-without-asset',
  ]);
  for (const item of results) {
    const parentCheck = buildSuggestedParentCheck(item);
    const base = {
      caseId: item.id,
      title: item.title,
      prefab: item.prefab,
      name: item.name,
      targetPath: item.targetPath,
      targetUnityFileId: item.targetUnityFileId,
      paths: item.paths,
    };

    if (item.status === 'error') {
      const code = item.timedOut ? 'case-timeout' : 'runtime-error';
      queue.push({
        ...base,
        source: 'error',
        severity: issueSeverity(code, 'error'),
        code,
        message: item.error || item.findings?.[0] || 'Case failed',
        recommendation: recommendAction(code),
      });
      continue;
    }

    for (const issue of item.targetIssues ?? []) {
      const code = String(issue.code || 'target-subtree-issue');
      queue.push({
        ...base,
        source: 'targetSubtree',
        severity: issueSeverity(code, 'targetSubtree'),
        code,
        nodePath: issue.path || issue.name || issue.id || null,
        nodeId: issue.id || null,
        message: issue.message || code,
        recommendation: recommendAction(code),
      });
    }

    for (const note of item.targetNotes ?? []) {
      const code = String(note.code || '');
      if (!reportableSkipNotes.has(code)) continue;
      queue.push({
        ...base,
        source: 'targetNote',
        severity: issueSeverity(code, 'targetNote'),
        code,
        nodePath: note.path || note.name || note.id || null,
        nodeId: note.id || null,
        message: note.message || code,
        recommendation: recommendAction(code),
      });
    }

    for (const finding of item.findings ?? []) {
      const code = classifyFindingForItem(finding, item);
      if (code === 'target-subtree-issues' && (item.targetIssues?.length ?? 0) > 0) continue;
      const suggestion = code === 'crop-overlap-context' ? parentCheck : null;
      queue.push({
        ...base,
        source: 'finding',
        severity: issueSeverity(code, 'finding'),
        code,
        message: finding,
        recommendation: suggestion
          ? `${recommendAction(code)} Suggested context target: ${suggestion.targetPath}.`
          : recommendAction(code),
        suggestedTargetPath: suggestion?.targetPath ?? null,
        suggestedTargetName: suggestion?.targetName ?? null,
        suggestedCommand: suggestion?.command ?? null,
      });
    }
  }

  const order = { error: 0, warning: 1, info: 2 };
  return queue.sort((a, b) =>
    (order[a.severity] ?? 9) - (order[b.severity] ?? 9)
    || String(a.code).localeCompare(String(b.code))
    || String(a.caseId).localeCompare(String(b.caseId))
  );
}

function buildManifestSkipIssues(manifestRaw) {
  const skipped = Array.isArray(manifestRaw?.skipped) ? manifestRaw.skipped : [];
  return skipped.map((item, index) => ({
    caseId: `manifest-skip-${index + 1}`,
    title: item.title || item.name || item.prefab || `manifest skip ${index + 1}`,
    prefab: item.prefab || '',
    name: item.name || null,
    targetPath: item.path || null,
    targetUnityFileId: item.unityFileId || null,
    paths: {},
    source: 'manifest',
    severity: 'skip',
    code: item.code || item.reason || 'manifest-skipped',
    message: item.message || item.reason || 'Manifest skipped this prefab/case.',
    recommendation: item.reason === 'parse-error'
      ? 'Prefab parser returned no root or failed before case generation. Track this as a parser/source-prefab capability gap and continue sampling other components.'
      : 'Manifest did not generate a visual case for this entry; inspect cases.json for the skip reason.',
  }));
}

function countBy(items, keyFn) {
  const counts = {};
  for (const item of items) {
    const key = keyFn(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function issueCounts(items) {
  return {
    bySeverity: countBy(items, (item) => item.severity),
    byCode: countBy(items, (item) => item.code),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stopProcessTree(child, timeoutMs = 2500) {
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

function makeCommandError(message, details = {}) {
  const err = new Error(message);
  Object.assign(err, details);
  return err;
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
    let settled = false;
    let timedOut = false;
    const timeoutMs = Number(options.timeoutMs);
    const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(async () => {
        timedOut = true;
        await stopProcessTree(child);
      }, timeoutMs)
      : null;
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (timedOut) {
        reject(makeCommandError(`${command} ${args.join(' ')} timed out after ${timeoutMs}ms`, {
          code,
          timedOut: true,
          stdout,
          stderr,
        }));
        return;
      }
      if (code === 0) resolve({ stdout, stderr, code });
      else reject(makeCommandError(`${command} ${args.join(' ')} exited with ${code}\n${stdout}\n${stderr}`, {
        code,
        stdout,
        stderr,
      }));
    });
  });
}

function firstDefined(...items) {
  return items.find((item) => item !== undefined && item !== null);
}

function buildCompareArgs(manifest, manifestDir, item, outDir) {
  const reference = resolveMaybeRelative(manifestDir, firstDefined(item.reference, item.unity, item.unityShot));
  const shouldCaptureReference = firstDefined(item.captureReference, manifest.captureReference) === true || !reference;
  if (!reference && !shouldCaptureReference) throw new Error('Case requires reference/unity/unityShot or captureReference=true');

  const compareArgs = [
    path.join(ROOT, 'scripts', 'visual-compare.mjs'),
    '--prefab', item.prefab,
    '--name', item.name,
    '--out', outDir,
  ];
  if (item.targetPath) compareArgs.push('--target-path', String(item.targetPath));
  if (item.targetUnityFileId) compareArgs.push('--target-unity-file-id', String(item.targetUnityFileId));
  if (reference) compareArgs.push('--reference', reference);
  if (shouldCaptureReference) compareArgs.push('--capture-reference');

  const passthrough = {
    url: firstDefined(item.url, manifest.url),
    unityProxy: firstDefined(item.unityProxy, manifest.unityProxy),
    backgroundColor: firstDefined(item.backgroundColor, manifest.backgroundColor),
    referenceOut: firstDefined(item.referenceOut, manifest.referenceOut),
    width: firstDefined(item.width, manifest.width),
    height: firstDefined(item.height, manifest.height),
    threshold: firstDefined(item.threshold, manifest.threshold),
    viewportWidth: firstDefined(item.viewportWidth, manifest.viewportWidth),
    viewportHeight: firstDefined(item.viewportHeight, manifest.viewportHeight),
    editorCrop: firstDefined(item.editorCrop, manifest.editorCrop),
    probeRetries: firstDefined(item.probeRetries, manifest.probeRetries),
    pad: firstDefined(item.pad, manifest.pad),
    panelWidth: firstDefined(item.panelWidth, manifest.panelWidth),
    compareHeight: firstDefined(item.compareHeight, manifest.compareHeight),
    diffPad: firstDefined(item.diffPad, manifest.diffPad),
    diffWidth: firstDefined(item.diffWidth, manifest.diffWidth),
    diffHeight: firstDefined(item.diffHeight, manifest.diffHeight),
    diffPixelThreshold: firstDefined(item.diffPixelThreshold, manifest.diffPixelThreshold),
    diffWarnRatio: firstDefined(item.diffWarnRatio, manifest.diffWarnRatio),
    aspectWarnThreshold: firstDefined(item.aspectWarnThreshold, manifest.aspectWarnThreshold),
  };

  if (passthrough.url) compareArgs.push('--url', String(passthrough.url));
  if (passthrough.unityProxy) compareArgs.push('--unity-proxy', String(passthrough.unityProxy));
  if (passthrough.backgroundColor) compareArgs.push('--background-color', String(passthrough.backgroundColor));
  if (passthrough.referenceOut) compareArgs.push('--reference-out', resolveMaybeRelative(manifestDir, String(passthrough.referenceOut)));
  if (passthrough.width) compareArgs.push('--width', String(passthrough.width));
  if (passthrough.height) compareArgs.push('--height', String(passthrough.height));
  if (passthrough.threshold) compareArgs.push('--threshold', String(passthrough.threshold));
  if (passthrough.viewportWidth) compareArgs.push('--viewport-width', String(passthrough.viewportWidth));
  if (passthrough.viewportHeight) compareArgs.push('--viewport-height', String(passthrough.viewportHeight));
  if (passthrough.editorCrop) compareArgs.push('--editor-crop', String(passthrough.editorCrop));
  if (passthrough.probeRetries !== undefined) compareArgs.push('--probe-retries', String(passthrough.probeRetries));
  if (passthrough.pad !== undefined) compareArgs.push('--pad', String(passthrough.pad));
  if (passthrough.panelWidth) compareArgs.push('--panel-width', String(passthrough.panelWidth));
  if (passthrough.compareHeight) compareArgs.push('--compare-height', String(passthrough.compareHeight));
  if (passthrough.diffPad !== undefined) compareArgs.push('--diff-pad', String(passthrough.diffPad));
  if (passthrough.diffWidth) compareArgs.push('--diff-width', String(passthrough.diffWidth));
  if (passthrough.diffHeight) compareArgs.push('--diff-height', String(passthrough.diffHeight));
  if (passthrough.diffPixelThreshold !== undefined) compareArgs.push('--diff-pixel-threshold', String(passthrough.diffPixelThreshold));
  if (passthrough.diffWarnRatio !== undefined) compareArgs.push('--diff-warn-ratio', String(passthrough.diffWarnRatio));
  if (passthrough.aspectWarnThreshold !== undefined) compareArgs.push('--aspect-warn-threshold', String(passthrough.aspectWarnThreshold));

  const referenceCrop = asRectArg(firstDefined(item.referenceCrop, item.unityCrop));
  if (referenceCrop) compareArgs.push('--reference-crop', referenceCrop);

  const editorCropRect = asRectArg(item.editorCropRect);
  if (editorCropRect) compareArgs.push('--editor-crop-rect', editorCropRect);

  if (item.drag === true) compareArgs.push('--drag');
  if (item.skipProbe === true) compareArgs.push('--skip-probe');
  if (item.probeDir) compareArgs.push('--probe-dir', resolveMaybeRelative(manifestDir, item.probeDir));
  if (item.failOnWarnings === true) compareArgs.push('--fail-on-warnings');

  return compareArgs;
}

async function runCase(manifest, manifestDir, item, index, rootOut, options = {}) {
  if (!item || typeof item !== 'object') throw new Error(`Invalid case at index ${index}`);
  if (!item.prefab) throw new Error(`Case ${index + 1} requires prefab`);
  if (!item.name) throw new Error(`Case ${index + 1} requires name`);

  const id = slug(item.id || `${index + 1}-${item.prefab}-${item.name}`);
  const outDir = path.join(rootOut, id);
  await mkdir(outDir, { recursive: true });
  const compareArgs = buildCompareArgs(manifest, manifestDir, item, outDir);
  const startedAt = new Date().toISOString();
  const timeoutMs = firstDefined(item.caseTimeoutMs, manifest.caseTimeoutMs, options.caseTimeoutMs);
  console.log(`[visual-batch] ${index + 1}/${options.total ?? '?'} start ${id} (${item.prefab} / ${item.name})`);
  const commandStartedAt = Date.now();
  await runCommand(process.execPath, compareArgs, { cwd: ROOT, timeoutMs });
  console.log(`[visual-batch] ${index + 1}/${options.total ?? '?'} done ${id} in ${Math.round((Date.now() - commandStartedAt) / 1000)}s`);

  const reportPath = path.join(outDir, 'compare-report.json');
  if (!existsSync(reportPath)) throw new Error(`Case ${id} did not produce compare-report.json`);
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  return {
    id,
    title: item.title || id,
    prefab: item.prefab,
    name: item.name,
    startedAt,
    finishedAt: new Date().toISOString(),
    status: 'ok',
    durationMs: Date.now() - commandStartedAt,
    findings: Array.isArray(report.findings) ? report.findings : [],
    args: report.args ?? null,
    targetPath: item.targetPath ?? report.args?.targetPath ?? report.probe?.targetSubtree?.path ?? null,
    targetUnityFileId: item.targetUnityFileId ?? report.args?.targetUnityFileId ?? null,
    paths: {
      outDir,
      comparisonPng: report.paths?.comparisonPng ?? path.join(outDir, 'comparison.png'),
      comparisonHtml: report.paths?.html ?? path.join(outDir, 'comparison.html'),
      compareReport: reportPath,
      probeReport: report.paths?.probeReport ?? null,
      visualDiffHeatmap: report.paths?.visualDiffHeatmap ?? null,
    },
    analysis: report.analysis ?? null,
    diagnostics: report.probe?.diagnostics ?? null,
    visualDiff: report.visualDiff ?? null,
    targetSubtree: report.probe?.targetSubtree ?? null,
    targetIssues: report.probe?.targetSubtree?.issues ?? [],
    targetNotes: report.probe?.targetSubtree?.notes ?? [],
  };
}

function summarizeError(err) {
  const value = err instanceof Error ? err.message : String(err);
  return value.length > 1200 ? `${value.slice(0, 1200)}\n...` : value;
}

async function writeFailureLog(outDir, err) {
  await mkdir(outDir, { recursive: true });
  const text = [
    `message: ${err instanceof Error ? err.message : String(err)}`,
    '',
    err?.timedOut ? 'timedOut: true' : '',
    err?.stdout ? `stdout:\n${err.stdout}` : '',
    err?.stderr ? `stderr:\n${err.stderr}` : '',
  ].filter(Boolean).join('\n');
  const logPath = path.join(outDir, 'runtime-error.txt');
  await writeFile(logPath, text, 'utf8');
  return logPath;
}

function buildIndexHtml(summary, rootOut) {
  const renderIssueRows = (issues, emptyText) => issues.length
    ? issues.map((issue) => {
      const reportLink = issue.paths?.compareReport
        ? `<a href="${escapeHtml(rel(rootOut, issue.paths.compareReport))}">report</a>`
        : '';
      const htmlLink = issue.paths?.comparisonHtml
        ? `<a href="${escapeHtml(rel(rootOut, issue.paths.comparisonHtml))}">compare</a>`
        : '';
      const errorLink = issue.paths?.errorLog
        ? `<a href="${escapeHtml(rel(rootOut, issue.paths.errorLog))}">error</a>`
        : '';
      const recommendation = issue.suggestedCommand
        ? `${escapeHtml(issue.recommendation)}<br><code>${escapeHtml(issue.suggestedCommand)}</code>`
        : escapeHtml(issue.recommendation);
      return `<tr class="${escapeHtml(issue.severity)}">
        <td>${escapeHtml(issue.severity)}</td>
        <td>${escapeHtml(issue.code)}</td>
        <td>${escapeHtml(issue.caseId)}</td>
        <td>${escapeHtml(issue.nodePath || issue.name || '')}</td>
        <td>${escapeHtml(issue.message)}</td>
        <td>${recommendation}</td>
        <td>${[htmlLink, reportLink, errorLink].filter(Boolean).join(' ')}</td>
      </tr>`;
    }).join('\n')
    : `<tr><td colspan="7" class="muted">${escapeHtml(emptyText)}</td></tr>`;

  const repairQueueRows = renderIssueRows(summary.repairQueue ?? [], 'No repair issues');
  const skippedQueueRows = renderIssueRows(summary.skipQueue ?? [], 'No skipped issues');

  const rows = summary.cases.map((item) => {
    const statusClass = caseStatusClass(item);
    const comparison = item.paths?.comparisonPng && existsSync(item.paths.comparisonPng)
      ? `<a href="${escapeHtml(rel(rootOut, item.paths.comparisonHtml || item.paths.comparisonPng))}"><img src="${escapeHtml(rel(rootOut, item.paths.comparisonPng))}" alt="${escapeHtml(item.id)}"></a>`
      : '<div class="missing">no comparison image</div>';
    const findings = item.findings?.length
      ? `<ul>${item.findings.map((finding) => `<li>${escapeHtml(finding)}</li>`).join('')}</ul>`
      : '<span class="muted">No findings</span>';
    const diffText = item.visualDiff
      ? `visual diff ${(Math.round(item.visualDiff.changedRatio * 10000) / 100)}%, meanAbs ${item.visualDiff.meanAbsRgb}`
      : 'visual diff n/a';
    const geometryText = item.analysis?.geometry
      ? `geometry ${item.analysis.geometry.status}: ${item.analysis.geometry.summary}`
      : 'geometry n/a';
    const heatmap = item.paths?.visualDiffHeatmap && existsSync(item.paths.visualDiffHeatmap)
      ? `<a href="${escapeHtml(rel(rootOut, item.paths.visualDiffHeatmap))}"><img class="heatmap" src="${escapeHtml(rel(rootOut, item.paths.visualDiffHeatmap))}" alt="${escapeHtml(item.id)} diff heatmap"></a>`
      : '';
    const targetIssues = item.targetIssues?.length
      ? `<p class="subhead">Target subtree issues</p><ul>${item.targetIssues.map((issue) => `<li>${escapeHtml(issue.path || issue.name || issue.id)}: ${escapeHtml(issue.code || issue.message)}</li>`).join('')}</ul>`
      : '';
    const targetNotes = item.targetNotes?.length
      ? `<p class="subhead">Target subtree notes</p><ul>${item.targetNotes.slice(0, 6).map((note) => `<li>${escapeHtml(note.path || note.name || note.id)}: ${escapeHtml(note.code || note.message)}</li>`).join('')}</ul>`
      : '';
    const links = [
      item.paths?.compareReport ? `<a href="${escapeHtml(rel(rootOut, item.paths.compareReport))}">compare-report.json</a>` : '',
      item.paths?.probeReport ? `<a href="${escapeHtml(rel(rootOut, item.paths.probeReport))}">probe report</a>` : '',
    ].filter(Boolean).join('');
    return `<section class="case ${statusClass}">
      <div class="case-head">
        <div>
          <h2>${escapeHtml(item.title || item.id)}</h2>
          <p>${escapeHtml(item.prefab)} / ${escapeHtml(item.name)}</p>
        </div>
        <strong>${escapeHtml(statusClass.toUpperCase())}</strong>
      </div>
      ${comparison}
      <p class="diff">${escapeHtml(diffText)}</p>
      <p class="geometry">${escapeHtml(geometryText)}</p>
      ${heatmap}
      <div class="findings">${findings}</div>
      ${targetIssues ? `<div class="target-inspection issues">${targetIssues}</div>` : ''}
      ${targetNotes ? `<div class="target-inspection notes">${targetNotes}</div>` : ''}
      ${links ? `<p class="links">${links}</p>` : ''}
    </section>`;
  }).join('\n');

  return `<!doctype html>
<meta charset="utf-8">
<title>UIEditor visual sample summary</title>
<style>
  :root{color-scheme:dark;font-family:Segoe UI,Arial,sans-serif;background:#0f172a;color:#e5e7eb}
  body{margin:0;padding:28px;background:#0f172a}
  h1{font-size:24px;margin:0 0 8px}
  .meta{color:#94a3b8;margin:0 0 22px;font-family:Consolas,monospace;font-size:13px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(460px,1fr));gap:20px}
  .case{border:1px solid #334155;background:#111827;border-radius:8px;padding:14px}
  .case-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:12px}
  h2{font-size:17px;margin:0 0 4px}
  p{margin:0;color:#cbd5e1}
  strong{font-size:12px;border-radius:999px;padding:4px 8px;background:#334155}
  .pass strong{background:#14532d;color:#bbf7d0}
  .warn strong{background:#713f12;color:#fde68a}
  .skip strong{background:#1e3a8a;color:#bfdbfe}
  .fail strong{background:#7f1d1d;color:#fecaca}
  img{display:block;width:100%;height:auto;border:1px solid #334155;border-radius:6px;background:#020617}
  img.heatmap{margin-top:10px;image-rendering:auto}
  .findings{margin-top:12px;font-size:13px;color:#d1d5db}
  .target-inspection{margin-top:12px;font-size:12px;color:#cbd5e1;border-top:1px solid #334155;padding-top:10px}
  .target-inspection.notes{color:#94a3b8}
  .subhead{font-weight:600;color:#e5e7eb;margin:0 0 6px}
  .diff,.geometry{margin-top:10px;font-size:12px;color:#94a3b8;font-family:Consolas,monospace}
  .geometry{margin-top:4px;color:#a7f3d0}
  ul{margin:0;padding-left:20px}
  .muted{color:#94a3b8}
  .missing{height:240px;display:grid;place-items:center;background:#020617;border:1px dashed #475569;border-radius:6px;color:#94a3b8}
  .links{display:flex;gap:12px;margin-top:12px;font-size:13px}
  .queue{width:100%;border-collapse:collapse;margin:0 0 24px;background:#111827;border:1px solid #334155;border-radius:8px;overflow:hidden;font-size:12px}
  .queue th,.queue td{border-bottom:1px solid #334155;padding:8px;text-align:left;vertical-align:top}
  .queue th{color:#e5e7eb;background:#1f2937}
  code{display:block;margin-top:6px;white-space:pre-wrap;color:#bfdbfe;font-family:Consolas,monospace;font-size:11px}
  .queue tr.error td:first-child{color:#fecaca}
  .queue tr.warning td:first-child{color:#fde68a}
  .queue tr.skip td:first-child{color:#bfdbfe}
  .queue tr.info td:first-child{color:#bfdbfe}
  a{color:#93c5fd}
</style>
<h1>UIEditor Visual Sample Summary</h1>
<p class="meta">cases=${summary.total} pass=${summary.passCount} skip=${summary.skippedCount} warn=${summary.warningCount} fail=${summary.errorCount} repairIssues=${summary.repairQueue.length} skippedIssues=${summary.skipQueue.length} captured=${escapeHtml(summary.capturedAt)}</p>
<h2>Repair Queue</h2>
<table class="queue">
  <thead>
    <tr><th>Severity</th><th>Code</th><th>Case</th><th>Node</th><th>Message</th><th>Suggested next check</th><th>Links</th></tr>
  </thead>
  <tbody>
${repairQueueRows}
  </tbody>
</table>
<h2>Skipped Issues</h2>
<table class="queue">
  <thead>
    <tr><th>Severity</th><th>Code</th><th>Case</th><th>Node</th><th>Message</th><th>Reason / follow-up</th><th>Links</th></tr>
  </thead>
  <tbody>
${skippedQueueRows}
  </tbody>
</table>
<div class="grid">
${rows}
</div>
`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifestDir = path.dirname(args.manifest);
  const manifestText = (await readFile(args.manifest, 'utf8')).replace(/^\uFEFF/, '');
  const manifestRaw = JSON.parse(manifestText);
  const manifest = { ...manifestRaw, ...args.overrides };
  const cases = Array.isArray(manifestRaw.cases)
    ? manifestRaw.cases.map((item) => ({ ...item, ...args.overrides }))
    : [];

  await mkdir(args.out, { recursive: true });
  const results = [];
  for (let i = 0; i < cases.length; i++) {
    try {
      results.push(await runCase(manifest, manifestDir, cases[i], i, args.out, {
        caseTimeoutMs: args.caseTimeoutMs,
        total: cases.length,
      }));
    } catch (err) {
      const id = slug(cases[i]?.id || `${i + 1}`);
      const item = cases[i] ?? {};
      console.error(`[visual-batch] ${i + 1}/${cases.length} error ${id}: ${err instanceof Error ? err.message : String(err)}`);
      const outDir = path.join(args.out, id);
      const errorLog = await writeFailureLog(outDir, err);
      const failure = {
        id,
        title: item.title || id,
        prefab: item.prefab ?? '',
        name: item.name ?? '',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        status: 'error',
        error: summarizeError(err),
        timedOut: !!err?.timedOut,
        findings: [summarizeError(err)],
        paths: {
          outDir,
          comparisonPng: null,
          comparisonHtml: null,
          compareReport: null,
          probeReport: null,
          errorLog,
        },
        diagnostics: null,
      };
      results.push(failure);
      if (!args.continueOnError) break;
    }
  }

  const passCount = results.filter((item) => item.status === 'ok' && item.findings.length === 0).length;
  const skippedCount = results.filter((item) =>
    item.status === 'ok' &&
    item.findings.length > 0 &&
    item.findings.every((finding) => isSkippableFindingForItem(finding, item))
  ).length;
  const warningCount = results.filter((item) =>
    item.status === 'ok' &&
    item.findings.length > 0 &&
    !item.findings.every((finding) => isSkippableFindingForItem(finding, item))
  ).length;
  const errorCount = results.filter((item) => item.status === 'error').length;

  const summary = {
    manifest: args.manifest,
    out: args.out,
    capturedAt: new Date().toISOString(),
    caseTimeoutMs: args.caseTimeoutMs,
    total: results.length,
    passCount,
    skippedCount,
    warningCount,
    errorCount,
    cases: results,
  };
  summary.manifestSkipped = Array.isArray(manifestRaw.skipped) ? manifestRaw.skipped : [];
  summary.manifestSkippedCount = summary.manifestSkipped.length;
  summary.issueQueue = [
    ...buildIssueQueue(results),
    ...buildManifestSkipIssues(manifestRaw),
  ];
  summary.repairQueue = summary.issueQueue.filter((item) => item.severity !== 'skip');
  summary.skipQueue = summary.issueQueue.filter((item) => item.severity === 'skip');
  summary.issueCounts = issueCounts(summary.issueQueue);
  summary.repairCounts = issueCounts(summary.repairQueue);
  summary.skipCounts = issueCounts(summary.skipQueue);

  const summaryPath = path.join(args.out, 'summary.json');
  const issueQueuePath = path.join(args.out, 'issue-queue.json');
  const indexPath = path.join(args.out, 'index.html');
  await writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
  await writeFile(issueQueuePath, JSON.stringify({
    manifest: summary.manifest,
    out: summary.out,
    capturedAt: summary.capturedAt,
    issueCounts: summary.issueCounts,
    repairCounts: summary.repairCounts,
    skipCounts: summary.skipCounts,
    repairIssues: summary.repairQueue,
    skippedIssues: summary.skipQueue,
    issues: summary.issueQueue,
  }, null, 2), 'utf8');
  await writeFile(indexPath, buildIndexHtml(summary, args.out), 'utf8');

  console.log(JSON.stringify({
    summaryPath,
    issueQueuePath,
    indexPath,
    passCount: summary.passCount,
    skippedCount: summary.skippedCount,
    warningCount: summary.warningCount,
    errorCount: summary.errorCount,
    manifestSkippedCount: summary.manifestSkippedCount,
    queuedIssues: summary.issueQueue.length,
    repairIssues: summary.repairQueue.length,
    skippedIssues: summary.skipQueue.length,
  }, null, 2));

  if (summary.errorCount > 0 || (args.failOnFindings && summary.warningCount > 0)) {
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent, setGlobalDispatcher } from 'undici';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const args = {
    url: process.env.UIEDITOR_URL || 'auto',
    unityProxy: process.env.UIEDITOR_UNITY_PROXY || 'http://127.0.0.1:8081/',
    out: path.join(ROOT, '.cache', 'visual-samples', 'components-latest'),
    componentLimit: 6,
    componentOffset: 0,
    componentFilter: '',
    maxCasesPerPrefab: 3,
    maxImportantPerPrefab: 2,
    width: 1080,
    height: 1920,
    viewportWidth: 1600,
    viewportHeight: 2200,
    probeRetries: 2,
    caseTimeoutMs: 240000,
    backgroundColor: '#162d3f',
    continueOnError: true,
    failOnFindings: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const next = argv[i + 1];
    if (key === '--url') { args.url = next; i++; }
    else if (key === '--unity-proxy') { args.unityProxy = next; i++; }
    else if (key === '--out') { args.out = path.resolve(next); i++; }
    else if (key === '--component-limit') { args.componentLimit = Number(next); i++; }
    else if (key === '--component-offset') { args.componentOffset = Number(next); i++; }
    else if (key === '--component-filter') { args.componentFilter = next; i++; }
    else if (key === '--max-cases-per-prefab') { args.maxCasesPerPrefab = Number(next); i++; }
    else if (key === '--max-important-per-prefab') { args.maxImportantPerPrefab = Number(next); i++; }
    else if (key === '--width') { args.width = Number(next); i++; }
    else if (key === '--height') { args.height = Number(next); i++; }
    else if (key === '--viewport-width') { args.viewportWidth = Number(next); i++; }
    else if (key === '--viewport-height') { args.viewportHeight = Number(next); i++; }
    else if (key === '--probe-retries') { args.probeRetries = Number(next); i++; }
    else if (key === '--case-timeout-ms') { args.caseTimeoutMs = Number(next); i++; }
    else if (key === '--background-color') { args.backgroundColor = next; i++; }
    else if (key === '--stop-on-error') args.continueOnError = false;
    else if (key === '--continue-on-error') args.continueOnError = true;
    else if (key === '--fail-on-findings') args.failOnFindings = true;
    else throw new Error(`Unknown argument: ${key}`);
  }

  for (const key of ['componentLimit', 'componentOffset', 'maxCasesPerPrefab', 'maxImportantPerPrefab', 'width', 'height', 'viewportWidth', 'viewportHeight', 'probeRetries', 'caseTimeoutMs']) {
    if (!Number.isFinite(args[key])) throw new Error(`${key} must be a number`);
  }
  if (args.width <= 0 || args.height <= 0) throw new Error('width/height must be positive');
  return args;
}

function normalizeUrl(value) {
  const url = new URL(value);
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.toString();
}

async function urlResponds(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function resolveUrl(value) {
  setGlobalDispatcher(new Agent({ connect: { rejectUnauthorized: false } }));
  if (value && value !== 'auto') return normalizeUrl(value);
  const candidates = [
    process.env.UIEDITOR_URL,
    'https://127.0.0.1:3022/',
    'https://127.0.0.1:3001/',
    'http://127.0.0.1:3001/',
    'https://127.0.0.1:3000/',
    'http://127.0.0.1:3000/',
  ].filter(Boolean);
  for (const candidate of candidates) {
    const normalized = normalizeUrl(candidate);
    if (await urlResponds(normalized)) return normalized;
  }
  throw new Error(`Cannot find a running UIEditor page. Pass --url explicitly or set UIEDITOR_URL.`);
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? ROOT,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.on('error', reject);
    child.on('close', (code) => {
      const allowed = options.allowedExitCodes ?? [0];
      if (allowed.includes(code)) resolve(code);
      else reject(new Error(`${command} ${args.join(' ')} exited with ${code}`));
    });
  });
}

async function readJson(filePath) {
  return JSON.parse((await readFile(filePath, 'utf8')).replace(/^\uFEFF/, ''));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = await resolveUrl(args.url);
  await mkdir(args.out, { recursive: true });
  const manifestPath = path.join(args.out, 'cases.json');

  console.log(`[component-sample] url=${url} unityProxy=${args.unityProxy} canvas=${args.width}x${args.height}`);
  await runCommand(process.execPath, [
    path.join(ROOT, 'scripts', 'visual-manifest.mjs'),
    '--url', url,
    '--components',
    '--component-limit', String(args.componentLimit),
    '--component-offset', String(args.componentOffset),
    '--component-filter', args.componentFilter,
    '--max-cases-per-prefab', String(args.maxCasesPerPrefab),
    '--max-important-per-prefab', String(args.maxImportantPerPrefab),
    '--out', manifestPath,
    '--width', String(args.width),
    '--height', String(args.height),
    '--viewport-width', String(args.viewportWidth),
    '--viewport-height', String(args.viewportHeight),
    '--probe-retries', String(args.probeRetries),
  ], { cwd: ROOT });

  const batchArgs = [
    path.join(ROOT, 'scripts', 'visual-batch.mjs'),
    '--manifest', manifestPath,
    '--out', args.out,
    '--url', url,
    '--unity-proxy', args.unityProxy,
    '--background-color', args.backgroundColor,
    '--width', String(args.width),
    '--height', String(args.height),
    '--viewport-width', String(args.viewportWidth),
    '--viewport-height', String(args.viewportHeight),
    '--case-timeout-ms', String(args.caseTimeoutMs),
  ];
  if (args.continueOnError) batchArgs.push('--continue-on-error');
  if (args.failOnFindings) batchArgs.push('--fail-on-findings');

  await runCommand(process.execPath, batchArgs, {
    cwd: ROOT,
    allowedExitCodes: args.failOnFindings ? [0, 2] : [0],
  });

  const summaryPath = path.join(args.out, 'summary.json');
  const issueQueuePath = path.join(args.out, 'issue-queue.json');
  const indexPath = path.join(args.out, 'index.html');
  const summary = await readJson(summaryPath);
  const issueQueue = await readJson(issueQueuePath);
  const manifest = await readJson(manifestPath);
  console.log(JSON.stringify({
    manifestPath,
    summaryPath,
    issueQueuePath,
    indexPath,
    total: summary.total,
    passCount: summary.passCount,
    skippedCount: summary.skippedCount ?? 0,
    warningCount: summary.warningCount,
    errorCount: summary.errorCount,
    manifestSkippedCount: summary.manifestSkippedCount ?? manifest.skippedCount ?? 0,
    issueCounts: issueQueue.issueCounts,
    repairCounts: issueQueue.repairCounts ?? {},
    skipCounts: issueQueue.skipCounts ?? {},
    repairIssues: issueQueue.repairIssues?.length ?? 0,
    skippedIssues: issueQueue.skippedIssues?.length ?? 0,
  }, null, 2));

  if (args.failOnFindings && (summary.errorCount > 0 || summary.warningCount > 0)) {
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const args = {
    webUrl: 'http://localhost:4105',
    out: path.join(ROOT, '.cache', 'thumbnail-cache-smoke', 'latest'),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const next = argv[i + 1];
    if (key === '--web-url') { args.webUrl = next; i += 1; }
    else if (key === '--out') { args.out = path.resolve(next); i += 1; }
  }
  return args;
}

function normalizeBaseUrl(value) {
  return value.replace(/\/+$/, '');
}

async function request(webUrl, method, prefabPath, variant = 'content', body = '') {
  const url = new URL('/api/prefabs/thumbnail', normalizeBaseUrl(webUrl));
  url.searchParams.set('path', prefabPath);
  url.searchParams.set('variant', variant);
  const init = { method };
  if (method !== 'GET' && method !== 'HEAD') init.body = body;
  return fetch(url, init);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await mkdir(args.out, { recursive: true });
  const report = {
    args,
    startedAt: new Date().toISOString(),
    ok: false,
    checks: [],
  };

  try {
    const home = await fetch(`${normalizeBaseUrl(args.webUrl)}/`, { cache: 'no-store' });
    report.webStatus = home.status;
    if (!home.ok) throw new Error(`web server is not ready: ${home.status}`);

    const tempPaths = [
      'Assets/Temp/UIEditorNew/LiveWorking.prefab',
      'Temp/UIEditorNew/LiveWorking.prefab',
      'E:/Projects/Dreamland/fact-source/DreamlandProject/Assets/Temp/UIEditorNew/LiveWorking.prefab',
    ];
    const tinyJpeg = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2w==';

    for (const tempPath of tempPaths) {
      for (const method of ['GET', 'POST']) {
        const response = await request(args.webUrl, method, tempPath, 'content', method === 'POST' ? tinyJpeg : '');
        const text = await response.text();
        const check = { method, path: tempPath, status: response.status, body: text };
        report.checks.push(check);
        if (response.status !== 403 || !/temporary prefab thumbnails are not cacheable/i.test(text)) {
          throw new Error(`temporary thumbnail cache was not rejected: ${JSON.stringify(check)}`);
        }
      }
    }

    report.ok = true;
    report.finishedAt = new Date().toISOString();
    await writeFile(path.join(args.out, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
    console.log(JSON.stringify({
      ok: true,
      checked: report.checks.length,
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

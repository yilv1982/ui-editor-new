import type { Plugin } from 'vite';
import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT, ASSET_PATHS } from '../config/unityPaths';

const ATLAS_ROOT = path.join(PROJECT_ROOT, ASSET_PATHS.atlas);
const TEXTURE_ROOT = path.join(PROJECT_ROOT, ASSET_PATHS.texture);

interface SliceBorder {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface ImageInfo {
  name: string;
  path: string;
  category?: string;
  sliceBorder?: SliceBorder;
}

// 从 .meta 文件读取 spriteBorder
// Unity meta: spriteBorder: {x: left, y: bottom, z: right, w: top}
function readSpriteBorder(imageFilePath: string): SliceBorder | undefined {
  const metaPath = imageFilePath + '.meta';
  if (!fs.existsSync(metaPath)) return undefined;

  try {
    const content = fs.readFileSync(metaPath, 'utf-8');
    const match = content.match(/spriteBorder:\s*\{x:\s*(\d+),\s*y:\s*(\d+),\s*z:\s*(\d+),\s*w:\s*(\d+)\}/);
    if (!match) return undefined;

    const x = parseInt(match[1]); // left
    const y = parseInt(match[2]); // bottom
    const z = parseInt(match[3]); // right
    const w = parseInt(match[4]); // top

    // 全零 = 没设置九宫格
    if (x === 0 && y === 0 && z === 0 && w === 0) return undefined;

    return { left: x, right: z, top: w, bottom: y };
  } catch {
    return undefined;
  }
}

function findImageDir(categoryPath: string): { dir: string; relPrefix: string }[] {
  const results: { dir: string; relPrefix: string }[] = [];
  const TEX_NAME_RE = /^(atlas|textures?)(\d+|_\d+)?$/i;

  // 1) 优先匹配 Atlas / Texture(s) 及其常见后缀变体（textures2、textures_01）
  try {
    const entries = fs.readdirSync(categoryPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && TEX_NAME_RE.test(entry.name)) {
        results.push({ dir: path.join(categoryPath, entry.name), relPrefix: entry.name });
      }
    }
  } catch {}

  if (results.length > 0) return results;

  // 2) 分类根目录直接含图片
  const rootImages = scanImages(categoryPath);
  if (rootImages.length > 0) {
    results.push({ dir: categoryPath, relPrefix: '' });
    return results;
  }

  // 3) 二级目录结构（如 icon_items/Icon_Item/*.png）：递归一层查找
  try {
    const subEntries = fs.readdirSync(categoryPath, { withFileTypes: true });
    for (const sub of subEntries) {
      if (!sub.isDirectory()) continue;
      const subPath = path.join(categoryPath, sub.name);
      // 子目录里再找 textures 形态
      try {
        const inner = fs.readdirSync(subPath, { withFileTypes: true });
        for (const innerEntry of inner) {
          if (innerEntry.isDirectory() && TEX_NAME_RE.test(innerEntry.name)) {
            results.push({
              dir: path.join(subPath, innerEntry.name),
              relPrefix: `${sub.name}/${innerEntry.name}`,
            });
          }
        }
      } catch {}
      // 子目录直接含图片
      if (scanImages(subPath).length > 0) {
        results.push({ dir: subPath, relPrefix: sub.name });
      }
    }
  } catch {}

  return results;
}

function scanImages(dir: string): string[] {
  try {
    return fs.readdirSync(dir)
      .filter((f) => /\.(png|jpg|jpeg)$/i.test(f));
  } catch {
    return [];
  }
}

function scanImagesRecursive(dir: string, relDir = ''): string[] {
  const results: string[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...scanImagesRecursive(full, rel));
      } else if (/\.(png|jpg|jpeg)$/i.test(entry.name)) {
        results.push(rel.replace(/\\/g, '/'));
      }
    }
  } catch {}
  return results;
}

function buildImageInfo(dir: string, relPrefix: string, category: string, file: string): ImageInfo {
  const rel = relPrefix ? `${category}/${relPrefix}/${file}` : `${category}/${file}`;
  const fullPath = path.join(dir, file);
  const sliceBorder = readSpriteBorder(fullPath);

  const info: ImageInfo = {
    name: path.basename(file, path.extname(file)),
    path: `/atlas-file/${rel}`,
  };
  if (sliceBorder) info.sliceBorder = sliceBorder;
  return info;
}

export function atlasServerPlugin(): Plugin {
  return {
    name: 'atlas-server',
    configureServer(server) {
      // GET /api/atlas/categories
      server.middlewares.use('/api/atlas/categories', (_req, res) => {
        try {
          const dirs = fs.readdirSync(ATLAS_ROOT, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => d.name)
            .sort();
          // 加上 Texture 目录作为特殊分类
          dirs.unshift('_Texture');
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(dirs));
        } catch (e: any) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: e.message }));
        }
      });

      // GET /api/atlas/images?category=xxx
      server.middlewares.use('/api/atlas/images', (req, res) => {
        try {
          const url = new URL(req.url!, `http://${req.headers.host}`);
          const category = url.searchParams.get('category') || '';

          // _Texture 特殊分类
          if (category === '_Texture') {
            const files = scanImagesRecursive(TEXTURE_ROOT);
            const allImages: ImageInfo[] = files.map((f) => {
              const fullPath = path.join(TEXTURE_ROOT, f);
              const sliceBorder = readSpriteBorder(fullPath);
              const info: ImageInfo = {
                name: path.basename(f, path.extname(f)),
                path: `/texture-file/${f}`,
              };
              if (sliceBorder) info.sliceBorder = sliceBorder;
              return info;
            });
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(allImages));
            return;
          }

          const categoryPath = path.join(ATLAS_ROOT, category);

          if (!fs.existsSync(categoryPath)) {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify([]));
            return;
          }

          const imageDirs = findImageDir(categoryPath);
          const allImages: ImageInfo[] = [];

          for (const { dir, relPrefix } of imageDirs) {
            const files = scanImages(dir);
            for (const f of files) {
              allImages.push(buildImageInfo(dir, relPrefix, category, f));
            }
          }

          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(allImages));
        } catch (e: any) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: e.message }));
        }
      });

      // GET /api/atlas/search?q=xxx
      server.middlewares.use('/api/atlas/search', (req, res) => {
        try {
          const url = new URL(req.url!, `http://${req.headers.host}`);
          const query = (url.searchParams.get('q') || '').toLowerCase();
          if (!query || query.length < 2) {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify([]));
            return;
          }

          const results: ImageInfo[] = [];
          const dirs = fs.readdirSync(ATLAS_ROOT, { withFileTypes: true })
            .filter((d) => d.isDirectory());

          for (const dir of dirs) {
            const categoryPath = path.join(ATLAS_ROOT, dir.name);
            const imageDirs = findImageDir(categoryPath);

            for (const { dir: imgDir, relPrefix } of imageDirs) {
              const files = scanImages(imgDir);
              for (const f of files) {
                const name = path.basename(f, path.extname(f));
                if (name.toLowerCase().includes(query)) {
                  const info = buildImageInfo(imgDir, relPrefix, dir.name, f);
                  info.category = dir.name;
                  results.push(info);
                }
              }
              if (results.length >= 200) break;
            }
            if (results.length >= 200) break;
          }

          // 也搜索 Texture 目录
          if (results.length < 200) {
            const texFiles = scanImagesRecursive(TEXTURE_ROOT);
            for (const f of texFiles) {
              const name = path.basename(f, path.extname(f));
              if (name.toLowerCase().includes(query)) {
                const fullPath = path.join(TEXTURE_ROOT, f);
                const sliceBorder = readSpriteBorder(fullPath);
                const info: ImageInfo = {
                  name,
                  category: '_Texture',
                  path: `/texture-file/${f}`,
                };
                if (sliceBorder) info.sliceBorder = sliceBorder;
                results.push(info);
              }
              if (results.length >= 200) break;
            }
          }

          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(results));
        } catch (e: any) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: e.message }));
        }
      });

      // GET /api/atlas/slice?path=/atlas-file/xxx 或 /texture-file/xxx — 查询九宫格数据
      server.middlewares.use('/api/atlas/slice', (req, res) => {
        try {
          const url = new URL(req.url!, `http://${req.headers.host}`);
          const imgPath = url.searchParams.get('path') || '';

          let filePath = '';
          if (imgPath.startsWith('/atlas-file/')) {
            filePath = path.join(ATLAS_ROOT, imgPath.replace('/atlas-file/', ''));
          } else if (imgPath.startsWith('/texture-file/')) {
            filePath = path.join(TEXTURE_ROOT, imgPath.replace('/texture-file/', ''));
          }

          res.setHeader('Content-Type', 'application/json');
          if (filePath && fs.existsSync(filePath)) {
            const border = readSpriteBorder(filePath);
            res.end(JSON.stringify({ path: imgPath, sliceBorder: border || null }));
          } else {
            res.end(JSON.stringify({ path: imgPath, sliceBorder: null }));
          }
        } catch (e: any) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: e.message }));
        }
      });

      // GET /api/atlas/slice-batch — 批量查询九宫格（POST body 传 paths 数组）
      server.middlewares.use('/api/atlas/slice-batch', (req, res) => {
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', () => {
          try {
            const { paths } = JSON.parse(body) as { paths: string[] };
            const result: Record<string, { left: number; right: number; top: number; bottom: number } | null> = {};
            for (const imgPath of paths) {
              let filePath = '';
              if (imgPath.startsWith('/atlas-file/')) {
                filePath = path.join(ATLAS_ROOT, imgPath.replace('/atlas-file/', ''));
              } else if (imgPath.startsWith('/texture-file/')) {
                filePath = path.join(TEXTURE_ROOT, imgPath.replace('/texture-file/', ''));
              }
              result[imgPath] = (filePath && fs.existsSync(filePath)) ? readSpriteBorder(filePath) || null : null;
            }
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(result));
          } catch (e: any) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: e.message }));
          }
        });
      });

      // 静态文件服务：/texture-file/...
      server.middlewares.use('/texture-file', (req, res) => {
        try {
          const filePath = path.join(TEXTURE_ROOT, decodeURIComponent(req.url || ''));
          if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
            const ext = path.extname(filePath).toLowerCase();
            const mimeTypes: Record<string, string> = {
              '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
            };
            res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
            res.setHeader('Cache-Control', 'public, max-age=86400');
            fs.createReadStream(filePath).pipe(res);
          } else {
            res.statusCode = 404;
            res.end('Not found');
          }
        } catch (e: any) {
          res.statusCode = 500;
          res.end(e.message);
        }
      });

      // 静态文件服务：/atlas-file/...
      server.middlewares.use('/atlas-file', (req, res) => {
        try {
          const filePath = path.join(ATLAS_ROOT, decodeURIComponent(req.url || ''));
          if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
            const ext = path.extname(filePath).toLowerCase();
            const mimeTypes: Record<string, string> = {
              '.png': 'image/png',
              '.jpg': 'image/jpeg',
              '.jpeg': 'image/jpeg',
            };
            res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
            res.setHeader('Cache-Control', 'public, max-age=86400');
            fs.createReadStream(filePath).pipe(res);
          } else {
            res.statusCode = 404;
            res.end('Not found');
          }
        } catch (e: any) {
          res.statusCode = 500;
          res.end(e.message);
        }
      });
    },
  };
}

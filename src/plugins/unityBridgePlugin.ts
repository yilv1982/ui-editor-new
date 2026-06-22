import type { Plugin, ViteDevServer } from 'vite';
import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT, ASSET_PATHS, getConfig, writeConfig } from '../config/unityPaths';

const SCREENSHOT_PATH = path.join(PROJECT_ROOT, ASSET_PATHS.screenshot);

// ===== Vite Plugin =====

export function unityBridgePlugin(): Plugin {
  return {
    name: 'unity-bridge',
    configureServer(server: ViteDevServer) {
      // Unity 配置读写（给新用户提供默认值）
      server.middlewares.use('/api/unity/config', async (req, res) => {
        if (req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(getConfig()));
          return;
        }
        if (req.method === 'POST') {
          let body = '';
          req.on('data', (chunk: Buffer) => { body += chunk; });
          req.on('end', () => {
            try {
              const data = JSON.parse(body);
              writeConfig(data);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true }));
            } catch (err: any) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: err.message }));
            }
          });
          return;
        }
        res.writeHead(405); res.end();
      });

      // 截图文件服务（GET 返回截图文件）
      server.middlewares.use('/api/unity/screenshot', async (req, res) => {
        if (req.method !== 'GET') {
          res.writeHead(405); res.end();
          return;
        }
        if (!fs.existsSync(SCREENSHOT_PATH)) {
          res.writeHead(404);
          res.end('No screenshot');
          return;
        }
        const stat = fs.statSync(SCREENSHOT_PATH);
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Content-Length': stat.size,
          'Cache-Control': 'no-cache',
        });
        fs.createReadStream(SCREENSHOT_PATH).pipe(res);
      });

      // 颜色预设保存
      server.middlewares.use('/api/color-presets', async (req, res) => {
        if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
        let body = '';
        req.on('data', (chunk: any) => body += chunk);
        req.on('end', () => {
          try {
            const presets = JSON.parse(body);
            const filePath = path.join(process.cwd(), 'public/colorPresets.json');
            fs.writeFileSync(filePath, JSON.stringify(presets, null, 2) + '\n', 'utf-8');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
          } catch (err: any) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
        });
      });

      console.log('[unityBridge] Unity Bridge Plugin v3 已加载（MCP 通信已移至前端）');
    },
  };
}

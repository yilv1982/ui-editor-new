/**
 * Unity 项目运行时配置（仅 Node / Vite 插件侧使用）
 * PROJECT_ROOT 从编辑器位置自动推算
 */
import fs from 'fs';
import path from 'path';

// 重新导出资源常量，让现有 import 不用改
export {
  ASSET_PATHS,
  FONT_LIST,
  DEFAULT_FONT,
  DESIGN_WIDTH,
  DESIGN_HEIGHT,
  DEFAULT_PREVIEW_WIDTH,
  DEFAULT_PREVIEW_HEIGHT,
} from './assetPaths';

// ===== PROJECT_ROOT 自动推算 =====
// 编辑器位置: .../fact-source/UIEditor_new → 同级 DreamlandProject
export const PROJECT_ROOT = path.resolve(process.cwd(), '../DreamlandProject').replace(/\\/g, '/');

// ===== 配置文件读写（给 /api/unity/config 端点使用）=====
const CONFIG_PATH = path.join(process.cwd(), 'unity-config.json');

interface UnityConfig {
  mcpUrl: string;
  editorBridgeUrl: string;
}

const DEFAULTS: UnityConfig = {
  mcpUrl: 'https://127.0.0.1:8082/mcp',
  editorBridgeUrl: 'http://127.0.0.1:8082',
};

let _config: UnityConfig = { ...DEFAULTS };

function readConfig(): UnityConfig {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      return { ...DEFAULTS, ...raw };
    }
  } catch {}
  // 配置文件不存在，写入默认值
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2), 'utf-8');
  return { ...DEFAULTS };
}

export function writeConfig(config: Partial<UnityConfig>): void {
  const merged = { ..._config, ...config };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf-8');
  _config = merged;
}

_config = readConfig();

/** 获取当前配置（供 API 返回） */
export function getConfig(): UnityConfig & { projectRoot: string } {
  return { ..._config, projectRoot: PROJECT_ROOT };
}

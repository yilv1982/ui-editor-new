import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT, ASSET_PATHS } from '../config/unityPaths';
import {
  parsePrefabYaml,
  buildNodeTree,
  resetPrefabParserState,
  type TemplateNode,
} from './prefabServer';

/**
 * 编辑器画布消化的 StructNode 格式（与 src/utils/importStructure.ts 的 StructNode 对齐）
 */
export interface FullStructNode {
  name: string;
  type?: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  componentRef?: string;
  text?: string;
  imagePath?: string;
  imageColor?: string;
  visible?: boolean;
  children?: FullStructNode[];
}

/**
 * 把 prefabServer 的 TemplateNode 树转成前端 importStructNode 能消化的 StructNode 树。
 * 只保留 importStructNode 已知的字段；imageType/sliceBorder 等会被 applySliceBorders 重新查询。
 */
export function templateNodeToStructNode(tpl: TemplateNode): FullStructNode {
  const result: FullStructNode = {
    name: tpl.name,
    type: tpl.type,
    x: tpl.x,
    y: tpl.y,
    width: tpl.width,
    height: tpl.height,
  };
  if (tpl.componentRef) result.componentRef = tpl.componentRef;
  if (tpl.text) result.text = tpl.text;
  if (tpl.imagePath) result.imagePath = tpl.imagePath;
  if (tpl.active === false) result.visible = false;

  if (tpl.children && tpl.children.length > 0) {
    result.children = tpl.children.map(templateNodeToStructNode);
  }
  return result;
}

let _frameCache: FullStructNode | null | undefined;

/**
 * 加载活动框架 UI_Activity_Main 的完整 StructNode 树。
 * 进程内缓存。失败返回 null。
 */
export function loadActivityFrameTree(): FullStructNode | null {
  if (_frameCache !== undefined) return _frameCache;

  try {
    const prefabPath = path.join(
      PROJECT_ROOT,
      ASSET_PATHS.prefab,
      'Activity/UI_Activity_Main.prefab',
    );
    if (!fs.existsSync(prefabPath)) {
      console.warn(`[activityFrameLoader] Prefab not found: ${prefabPath}`);
      _frameCache = null;
      return null;
    }

    resetPrefabParserState();
    const content = fs.readFileSync(prefabPath, 'utf-8');
    const objects = parsePrefabYaml(content);
    const root = buildNodeTree(objects, content);
    if (!root) {
      console.warn(`[activityFrameLoader] buildNodeTree returned null for UI_Activity_Main`);
      _frameCache = null;
      return null;
    }

    _frameCache = templateNodeToStructNode(root);
    return _frameCache;
  } catch (e) {
    console.error(`[activityFrameLoader] Failed to load UI_Activity_Main:`, e);
    _frameCache = null;
    return null;
  }
}

/**
 * 在 StructNode 树中查找 name === "act_content" 的节点，返回引用（可直接 push children）。
 */
export function findActContent(root: FullStructNode): FullStructNode | null {
  if (root.name === 'act_content') return root;
  if (root.children) {
    for (const c of root.children) {
      const found = findActContent(c);
      if (found) return found;
    }
  }
  return null;
}

/**
 * 把 AI 返回的内容子树合并进框架树的 act_content 下。
 * - 如果 AI 输出根节点名是 act_content_payload（或类似），把它的 children 塞到 act_content
 * - 如果 AI 输出是其他形态，把整个节点作为 act_content 的唯一子节点
 * 返回深拷贝后的合并结果（不污染缓存）。
 */
export function mergeContentIntoFrame(
  frame: FullStructNode,
  aiContent: FullStructNode,
): FullStructNode {
  const cloned: FullStructNode = JSON.parse(JSON.stringify(frame));
  const target = findActContent(cloned);
  if (!target) {
    console.warn(`[activityFrameLoader] act_content not found in frame tree, returning AI content as-is`);
    return aiContent;
  }
  if (aiContent.name === 'act_content_payload' && aiContent.children) {
    target.children = aiContent.children;
  } else {
    target.children = [aiContent];
  }
  return cloned;
}

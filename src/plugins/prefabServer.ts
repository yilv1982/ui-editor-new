import type { Plugin } from 'vite';
import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT, ASSET_PATHS, DESIGN_WIDTH, DESIGN_HEIGHT } from '../config/unityPaths';

const UI_PREFAB_ROOT = PROJECT_ROOT + '/' + ASSET_PATHS.prefab;
const ATLAS_ROOT = PROJECT_ROOT + '/' + ASSET_PATHS.atlas;
const TEXTURE_ROOT = PROJECT_ROOT + '/' + ASSET_PATHS.texture;
const COMMON_PART_DIR = PROJECT_ROOT + '/' + ASSET_PATHS.commonPart;
const FONT_DIR = PROJECT_ROOT + '/' + ASSET_PATHS.font;
const EXCLUDE_DIRS = new Set(['CommonPart']); // 排除通用组件目录

// guid → 可访问的 URL 路径 (如 /atlas-file/common/textures/xxx.png)
let guidToUrlCache: Map<string, string> | null = null;
// guid → spriteBorder [left, right, top, bottom]
let guidToSliceBorder: Map<string, number[]> | null = null;
// guid → { name: prefab 名称, path: prefab 文件完整路径 }
let guidToPrefabName: Map<string, { name: string; path: string }> | null = null;
// sprite guid → CommonPart prefab 名称列表（一个 sprite 可能被多个 Part 共用）
let spriteGuidToPartNames: Map<string, string[]> | null = null;
// font guid → 字体资源路径 (如 Assets/HotRes/Font/Bold.ttf)
let guidToFontPath: Map<string, string> | null = null;
// sprite guid → 图片原始尺寸 {w, h}
let guidToImageSize: Map<string, { w: number; h: number }> | null = null;

// 读取 PNG/JPG 文件的像素尺寸（只读头几十字节）
function readImageSize(filePath: string): { w: number; h: number } | null {
  try {
    const buf = Buffer.alloc(30);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buf, 0, 30, 0);
    fs.closeSync(fd);
    // PNG: bytes 16-23 contain width and height as 4-byte big-endian
    if (buf[0] === 0x89 && buf[1] === 0x50) {
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    }
    // JPG: need to scan for SOF marker
    const full = fs.readFileSync(filePath);
    for (let i = 0; i < full.length - 9; i++) {
      if (full[i] === 0xFF && (full[i + 1] === 0xC0 || full[i + 1] === 0xC2)) {
        return { w: full.readUInt16BE(i + 7), h: full.readUInt16BE(i + 5) };
      }
    }
  } catch {}
  return null;
}

function buildCaches() {
  if (guidToUrlCache) return;
  guidToUrlCache = new Map();
  guidToSliceBorder = new Map();
  guidToImageSize = new Map();
  guidToPrefabName = new Map();

  const normalizedRoot = PROJECT_ROOT.replace(/\\/g, '/');

  // 收集所有需要读取尺寸的图片路径，延迟到后台读取
  const pendingImageSizes: { guid: string; filePath: string }[] = [];

  function scanImages(dir: string) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scanImages(full);
        } else if (entry.name.endsWith('.meta') && !entry.name.endsWith('.prefab.meta')) {
          const imgFile = full.replace('.meta', '');
          if (/\.(png|jpg|jpeg)$/i.test(imgFile) && fs.existsSync(imgFile)) {
            try {
              const metaContent = fs.readFileSync(full, 'utf-8');
              const guidMatch = metaContent.match(/^guid:\s*(\w+)/m);
              if (guidMatch) {
                const guid = guidMatch[1];
                const normalizedPath = imgFile.replace(/\\/g, '/');
                const rel = normalizedPath.replace(normalizedRoot + '/', '');

                if (rel.startsWith(ASSET_PATHS.atlas + '/')) {
                  guidToUrlCache!.set(guid, `/atlas-file/${rel.replace(ASSET_PATHS.atlas + '/', '')}`);
                } else if (rel.startsWith(ASSET_PATHS.texture + '/')) {
                  guidToUrlCache!.set(guid, `/texture-file/${rel.replace(ASSET_PATHS.texture + '/', '')}`);
                } else if (rel.startsWith(ASSET_PATHS.prefab + '/')) {
                  guidToUrlCache!.set(guid, `/prefab-texture/${rel.replace(ASSET_PATHS.prefab + '/', '')}`);
                }

                // 读取 spriteBorder
                const borderMatch = metaContent.match(/spriteBorder:\s*\{x:\s*(\d+),\s*y:\s*(\d+),\s*z:\s*(\d+),\s*w:\s*(\d+)\}/);
                if (borderMatch) {
                  const l = parseInt(borderMatch[1]);
                  const b = parseInt(borderMatch[2]);
                  const r = parseInt(borderMatch[3]);
                  const t = parseInt(borderMatch[4]);
                  if (l > 0 || b > 0 || r > 0 || t > 0) {
                    guidToSliceBorder!.set(guid, [l, r, t, b]); // left, right, top, bottom
                  }
                }

                // 延迟读取图片尺寸，不阻塞缓存构建
                pendingImageSizes.push({ guid, filePath: imgFile });
              }
            } catch {}
          }
        }
      }
    } catch {}
  }

  function scanPrefabs() {
    spriteGuidToPartNames = new Map();

    // 扫描单个目录下的 Part prefab
    function scanPartDir(dir: string, filter?: (prefabName: string) => boolean) {
      try {
        const files = fs.readdirSync(dir);
        for (const f of files) {
          if (!f.endsWith('.prefab.meta')) continue;
          try {
            const metaContent = fs.readFileSync(path.join(dir, f), 'utf-8');
            const guidMatch = metaContent.match(/^guid:\s*(\w+)/m);
            if (guidMatch) {
              const prefabName = f.replace('.prefab.meta', '');
              if (filter && !filter(prefabName)) continue;
              const prefabPath = path.join(dir, f.replace('.meta', ''));
              guidToPrefabName!.set(guidMatch[1], { name: prefabName, path: prefabPath });
            }
          } catch {}
        }

        // 扫描 sprite guid → Part 名称（仅 CommonPart 目录）
        if (dir === COMMON_PART_DIR) {
          for (const f of files) {
            if (!f.endsWith('.prefab') || f.endsWith('.meta')) continue;
            try {
              const prefabContent = fs.readFileSync(path.join(dir, f), 'utf-8');
              const prefabName = f.replace('.prefab', '');
              const spriteMatch = prefabContent.match(/m_Sprite:\s*\{fileID:\s*\d+,\s*guid:\s*(\w+)/);
              if (spriteMatch && spriteMatch[1] !== '0') {
                const guid = spriteMatch[1];
                if (!spriteGuidToPartNames!.has(guid)) {
                  spriteGuidToPartNames!.set(guid, []);
                }
                spriteGuidToPartNames!.get(guid)!.push(prefabName);
              }
            } catch {}
          }
        }
      } catch {}
    }

    function scanAllPrefabMetas(dir: string) {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            scanAllPrefabMetas(full);
            continue;
          }
          if (!entry.name.endsWith('.prefab.meta')) continue;
          try {
            const metaContent = fs.readFileSync(full, 'utf-8');
            const guidMatch = metaContent.match(/^guid:\s*(\w+)/m);
            if (!guidMatch || guidToPrefabName!.has(guidMatch[1])) continue;
            const prefabName = entry.name.replace('.prefab.meta', '');
            guidToPrefabName!.set(guidMatch[1], { name: prefabName, path: full.replace(/\.meta$/i, '') });
          } catch {}
        }
      } catch {}
    }

    // 扫描 CommonPart 目录
    scanPartDir(COMMON_PART_DIR);

    // 扫描各功能模块下的 Part 子目录（如 Building/Part/）
    // 同时扫描模块顶层的 Part_*.prefab(部分模块没有 Part/ 子目录,Part_xxx 直接放在模块根)
    try {
      const topDirs = fs.readdirSync(UI_PREFAB_ROOT, { withFileTypes: true });
      for (const d of topDirs) {
        if (!d.isDirectory() || d.name === 'CommonPart') continue;
        const moduleDir = path.join(UI_PREFAB_ROOT, d.name);
        const partDir = path.join(moduleDir, 'Part');
        if (fs.existsSync(partDir)) {
          scanPartDir(partDir);
        }
        // 模块顶层只扫 Part_*.prefab,避免把 UI_xxx 等面板 prefab 错注册成 Part
        scanPartDir(moduleDir, (name) => name.startsWith('Part_'));
      }
    } catch {}

    // UI prefab variants often inherit UITemplates roots. Register every prefab guid
    // so root-level PrefabInstance sources can be resolved, while keeping
    // spriteGuidToPartNames limited to real CommonPart entries above.
    scanAllPrefabMetas(UI_PREFAB_ROOT);
  }

  scanImages(ATLAS_ROOT);
  scanImages(TEXTURE_ROOT);
  scanImages(UI_PREFAB_ROOT);
  scanPrefabs();

  // 扫描字体文件
  guidToFontPath = new Map();
  try {
    const fontFiles = fs.readdirSync(FONT_DIR);
    for (const f of fontFiles) {
      if (!f.endsWith('.meta') || !f.match(/\.(ttf|otf|ttc)\.meta$/i)) continue;
      try {
        const metaContent = fs.readFileSync(path.join(FONT_DIR, f), 'utf-8');
        const guidMatch = metaContent.match(/^guid:\s*(\w+)/m);
        if (guidMatch) {
          const fontFile = f.replace('.meta', '');
          guidToFontPath.set(guidMatch[1], `${ASSET_PATHS.font}/${fontFile}`);
        }
      } catch {}
    }
  } catch {}

  const ambiguousCount = [...spriteGuidToPartNames!.values()].filter(v => v.length > 1).length;
  console.log(`[prefabServer] 缓存: ${guidToUrlCache.size} 图片, ${guidToPrefabName!.size} 预制体, ${guidToFontPath.size} 字体, ${spriteGuidToPartNames!.size} sprite特征 (${ambiguousCount} 个有歧义)`);

  // 后台批量读取图片尺寸，不阻塞主流程
  console.log(`[prefabServer] 后台读取 ${pendingImageSizes.length} 个图片尺寸...`);
  const startTime = Date.now();
  for (const { guid, filePath } of pendingImageSizes) {
    const imgSize = readImageSize(filePath);
    if (imgSize) guidToImageSize!.set(guid, imgSize);
  }
  console.log(`[prefabServer] 图片尺寸读取完成: ${guidToImageSize!.size} 个, 耗时 ${Date.now() - startTime}ms`);
}

function decodeUnityTextScalar(value: string): string {
  const raw = String(value ?? '');
  const trimmed = raw.trim();
  const quote = trimmed[0];
  let text = raw;
  if ((quote === '"' || quote === "'") && trimmed.endsWith(quote)) {
    text = trimmed.slice(1, -1);
    if (quote === "'") text = text.replace(/''/g, "'");
  }
  return text
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

function normalizeUnityTextForPreview(value: string): string {
  return decodeUnityTextScalar(value).replace(/[\r\n]+$/g, '');
}

// Unity YAML prefab 简易解析器
interface PrefabObject {
  fileID: string;
  classID: string;
  data: Record<string, any>;
}

// 安全数字转换：超过 JS 安全整数范围的保持字符串
function safeNumber(v: string): string | number {
  if (isNaN(Number(v))) return v;
  const n = Number(v);
  if (Number.isSafeInteger(n) || (v.includes('.') && isFinite(n))) return n;
  return v; // 大整数保持字符串
}

function getRefFileID(ref: unknown): string | undefined {
  if (ref && typeof ref === 'object' && 'fileID' in ref) {
    const fileID = (ref as { fileID?: unknown }).fileID;
    return fileID !== undefined ? String(fileID) : undefined;
  }
  if (typeof ref === 'string') {
    const match = ref.match(/fileID:\s*(\d+)/);
    return match ? match[1] : undefined;
  }
  return undefined;
}

export function parsePrefabYaml(content: string): PrefabObject[] {
  const objects: PrefabObject[] = [];
  const blocks = content.split(/^--- !u!(\d+) &(\d+)[^\n]*/gm);

  for (let i = 1; i < blocks.length; i += 3) {
    const classID = blocks[i];
    const fileID = blocks[i + 1];
    const body = blocks[i + 2] || '';

    const data: Record<string, any> = {};
    const lines = body.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    let lastKey = '';

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
      if (line.trim() === '' || line.startsWith('%')) continue;

      // 数组项 "  - {fileID: xxx}" 或 "  - component: {fileID: xxx}"
      if (line.trim().startsWith('- ')) {
        if (lastKey && data[lastKey] !== undefined) {
          if (!Array.isArray(data[lastKey])) data[lastKey] = [];
          const itemStr = line.trim().slice(2).trim();
          // {fileID: xxx} or {fileID: xxx, type: 3}
          if (itemStr.startsWith('{') && itemStr.endsWith('}')) {
            const obj: Record<string, any> = {};
            itemStr.slice(1, -1).split(',').forEach((pair) => {
              const colonIdx = pair.indexOf(':');
              if (colonIdx < 0) return;
              const k = pair.slice(0, colonIdx).trim();
              const v = pair.slice(colonIdx + 1).trim();
              obj[k] = safeNumber(v);
            });
            data[lastKey].push(obj);
          } else if (itemStr.includes(': {')) {
            // "component: {fileID: xxx}"
            const colonIdx = itemStr.indexOf(':');
            const inner = itemStr.slice(colonIdx + 1).trim();
            if (inner.startsWith('{') && inner.endsWith('}')) {
              const obj: Record<string, any> = {};
              inner.slice(1, -1).split(',').forEach((pair) => {
                const ci = pair.indexOf(':');
                if (ci < 0) return;
                const k = pair.slice(0, ci).trim();
                const v = pair.slice(ci + 1).trim();
                obj[k] = safeNumber(v);
              });
              data[lastKey].push({ [itemStr.slice(0, colonIdx).trim()]: obj });
            }
          } else {
            data[lastKey].push(itemStr);
          }
        }
        continue;
      }

      // key: value 行
      const match = line.match(/^(\s*)([\w]+):\s*(.*)/);
      if (!match) continue;

      const indent = match[1].length;
      const key = match[2].trim();
      let value = match[3].trim();

      if (key === 'm_Text' && (value.startsWith("'") || value.startsWith('"')) && !value.endsWith(value[0])) {
        const quote = value[0];
        let collected = value.slice(1);
        while (lineIndex + 1 < lines.length) {
          const nextLine = lines[++lineIndex];
          const closeIndex = nextLine.indexOf(quote);
          if (closeIndex >= 0) {
            collected += nextLine.slice(0, closeIndex);
            break;
          }
          collected += `\n${nextLine}`;
        }
        value = `${quote}${collected}${quote}`;
      }

      // 顶级类型名（GameObject:, RectTransform:）
      if (indent === 0 && !value) continue;

      // {x: 0, y: 0, z: 0} 格式
      if (value.startsWith('{') && value.endsWith('}')) {
        const obj: Record<string, any> = {};
        value.slice(1, -1).split(',').forEach((pair) => {
          const colonIdx = pair.indexOf(':');
          if (colonIdx < 0) return;
          const k = pair.slice(0, colonIdx).trim();
          const v = pair.slice(colonIdx + 1).trim();
          obj[k] = safeNumber(v);
        });
        data[key] = obj;
        lastKey = key;
      } else if (value === '' || value === '[]') {
        // 空值 — 可能后面跟数组项
        data[key] = [];
        lastKey = key;
      } else {
        data[key] = key === 'm_Text' ? normalizeUnityTextForPreview(value) : safeNumber(value);
        lastKey = key;
      }
    }

    objects.push({ fileID, classID, data });
  }

  return objects;
}

export interface TemplateNode {
  name: string;
  type: string;
  active: boolean;
  x: number; y: number; width: number; height: number;
  rotation?: number;
  unityFileId?: string;
  text?: string;
  fontSize?: number;
  fontColor?: string;
  textAlign?: string;
  imagePath?: string;
  imageType?: string;
  sliceBorder?: number[];
  componentRef?: string;
  // RectTransform
  anchorMin?: { x: number; y: number };
  anchorMax?: { x: number; y: number };
  pivot?: { x: number; y: number };
  originalSizeDelta?: { x: number; y: number };
  originalAnchoredPosition?: { x: number; y: number };
  localScale?: { x: number; y: number; z?: number };
  originalLocalScale?: { x: number; y: number; z?: number };
  // Text 完整属性
  fontPath?: string;
  fontStyle?: number;
  alignment?: number;
  richText?: boolean;
  horizontalOverflow?: number;
  verticalOverflow?: number;
  lineSpacing?: number;
  bestFit?: boolean;
  bestFitMinSize?: number;
  bestFitMaxSize?: number;
  raycastTarget?: boolean;
  textOutline?: TextEffectData;
  textShadow?: TextEffectData;
  textGradient?: { direction: string; color1: string; color2: string };
  // Image 完整属性
  imageEnabled?: boolean;
  imageHasSprite?: boolean;
  imageSpriteGuid?: string;
  imageSpriteFileId?: number;
  imageColor?: string;
  fillCenter?: boolean;
  fillMethod?: number;
  fillAmount?: number;
  fillClockwise?: boolean;
  fillOrigin?: number;
  preserveAspect?: boolean;
  useSpriteMesh?: boolean;
  imageRaycastTarget?: boolean;
  mirrorType?: 'Horizontal' | 'Vertical' | 'Quarter';
  nativeVideoPlayer?: boolean;
  // Button
  interactable?: boolean;
  buttonTransition?: number;
  buttonColors?: {
    normalColor: string;
    highlightedColor: string;
    pressedColor: string;
    disabledColor: string;
    colorMultiplier: number;
    fadeDuration: number;
  };
  // Mask / ScrollView / Toggle
  isMask?: boolean;
  maskType?: 'Mask' | 'RectMask2D';
  maskShowGraphic?: boolean;
  scrollDirection?: 'horizontal' | 'vertical' | 'both';
  isOn?: boolean;
  layoutElement?: {
    ignoreLayout: boolean;
    minWidth: number;
    minHeight: number;
    preferredWidth: number;
    preferredHeight: number;
    flexibleWidth: number;
    flexibleHeight: number;
  };
  // LayoutGroup / ContentSizeFitter
  layoutGroup?: {
    enabled?: boolean;
    isHorizontal: boolean;
    isGrid?: boolean;
    layoutType?: 'Horizontal' | 'Vertical' | 'Grid';
    spacing: number;
    padLeft: number; padRight: number; padTop: number; padBottom: number;
    childAlignment: number;
    childControlWidth: boolean; childControlHeight: boolean;
    childForceExpandWidth: boolean; childForceExpandHeight: boolean;
    reverseArrangement?: boolean;
    // Grid 专属
    cellSizeX?: number;
    cellSizeY?: number;
    spacingY?: number;
    startCorner?: number;
    startAxis?: number;
    constraint?: number;
    constraintCount?: number;
  };
  contentSizeFitter?: { enabled?: boolean; horizontalFit: number; verticalFit: number };
  _unityTransformFileId?: string;
  _localTransformFileId?: string;
  _imageComponentFileId?: string;
  _textComponentFileId?: string;
  children: TemplateNode[];
}

interface TextEffectData {
  color: string;
  distance: [number, number];
  source?: 'UnityOutline' | 'UnityShadow' | 'UIShadow';
  style?: number;
  useGraphicAlpha?: boolean;
}

// 模块级 CommonPart 解析缓存和递归深度计数（跨 buildNodeTree 调用共享，防止无限递归）
interface CommonPartCacheEntry {
  children: TemplateNode[];
  rootUnityFileId?: string;
  rootUnityTransformFileId?: string;
  rootIsPrefabInstance?: boolean;
  rootImagePath?: string;
  rootImageEnabled?: boolean;
  rootImageColor?: string;
  rootSliceBorder?: number[];
  rootImageType?: string;
  rootWidth?: number;
  rootHeight?: number;
  rootAnchorMin?: { x: number; y: number };
  rootAnchorMax?: { x: number; y: number };
  rootPivot?: { x: number; y: number };
  rootOriginalSizeDelta?: { x: number; y: number };
  rootOriginalAnchoredPosition?: { x: number; y: number };
  rootOriginalLocalScale?: { x: number; y: number; z?: number };
}
const _globalPartCache = new Map<string, CommonPartCacheEntry | null>();
let _globalNestDepth = 0;
const MAX_NEST_DEPTH = 3; // 最多解析 3 层嵌套 CommonPart
// 当前正在解析的 Part 名称集合（防止循环引用）
const _parsingParts = new Set<string>();

export function resetPrefabParserState(): void {
  _globalPartCache.clear();
  _globalNestDepth = 0;
  _parsingParts.clear();
}

export function buildNodeTree(objects: PrefabObject[], rawContent: string): TemplateNode | null {
  // 父节点尺寸缓存
  const parentSizeCache = new Map<string, { w: number; h: number }>();

  // 从原始 YAML 提取 PrefabInstance 信息
  const prefabInstanceToGuid = new Map<string, string>();
  // PrefabInstance fileID → m_TransformParent fileID（在宿主 prefab 中的父 transform）
  const piTransformParent = new Map<string, string>();
  // PrefabInstance fileID → locally added GameObject transform IDs.
  const piAddedGameObjects = new Map<string, { targetSourceFileId: string; addedTransformId: string }[]>();
  // PrefabInstance fileID → locally added component IDs.
  const piAddedComponents = new Map<string, { targetSourceFileId: string; addedComponentId: string }[]>();
  const piRegex = /--- !u!1001 &(\d+)[^\n]*\n([\s\S]*?)(?=\n--- |$)/g;
  let piMatch;
  while ((piMatch = piRegex.exec(rawContent)) !== null) {
    const piId = piMatch[1];
    const piBlock = piMatch[2];
    // SourcePrefab guid
    const srcMatch = piBlock.match(/m_SourcePrefab:\s*\{fileID:\s*\d+,\s*guid:\s*(\w+)/);
    if (srcMatch) prefabInstanceToGuid.set(piId, srcMatch[1]);
    // TransformParent
    const tpMatch = piBlock.match(/m_TransformParent:\s*\{fileID:\s*(\d+)/);
    if (tpMatch && tpMatch[1] !== '0') piTransformParent.set(piId, tpMatch[1]);

    const addedGoSection = piBlock.match(/m_AddedGameObjects:\s*\n([\s\S]*?)\n\s*m_AddedComponents:/);
    if (addedGoSection) {
      const additions: { targetSourceFileId: string; addedTransformId: string }[] = [];
      const addGoRegex = /targetCorrespondingSourceObject:\s*\{fileID:\s*(\d+)[^}]*\}[\s\S]*?addedObject:\s*\{fileID:\s*(\d+)\}/g;
      let addGoMatch;
      while ((addGoMatch = addGoRegex.exec(addedGoSection[1])) !== null) {
        additions.push({ targetSourceFileId: addGoMatch[1], addedTransformId: addGoMatch[2] });
      }
      if (additions.length) piAddedGameObjects.set(piId, additions);
    }

    const addedCompSection = piBlock.match(/m_AddedComponents:\s*\n([\s\S]*?)(?=\n\s*m_SourcePrefab:|$)/);
    if (addedCompSection) {
      const additions: { targetSourceFileId: string; addedComponentId: string }[] = [];
      const addCompRegex = /targetCorrespondingSourceObject:\s*\{fileID:\s*(\d+)[^}]*\}[\s\S]*?addedObject:\s*\{fileID:\s*(\d+)\}/g;
      let addCompMatch;
      while ((addCompMatch = addCompRegex.exec(addedCompSection[1])) !== null) {
        additions.push({ targetSourceFileId: addCompMatch[1], addedComponentId: addCompMatch[2] });
      }
      if (additions.length) piAddedComponents.set(piId, additions);
    }
  }

  // 从 PrefabInstance modifications 中提取 stripped 组件的位置/大小/名称覆盖
  // 按 (piId, targetFileID) 分组，避免不同内部 transform 的属性互相覆盖
  interface StrippedOverride {
    apX?: number; apY?: number;
    sdX?: number; sdY?: number;
    aMinX?: number; aMinY?: number;
    aMaxX?: number; aMaxY?: number;
    pivotX?: number; pivotY?: number;
    rotZ?: number; rotW?: number;
    scaleX?: number; scaleY?: number; scaleZ?: number;
    name?: string;
    isActive?: number;
    enabled?: number;
    text?: string;
    spriteGuid?: string;
    spriteFileId?: number;
    colorR?: number; colorG?: number; colorB?: number; colorA?: number;
  }
  // PrefabInstance fileID → Map<targetFileID, StrippedOverride>
  const piOverridesByTarget = new Map<string, Map<string, StrippedOverride>>();

  const piBlockRegex = /--- !u!1001 &(\d+)[^\n]*\n([\s\S]*?)(?=\n--- |$)/g;
  let piBlockMatch;
  while ((piBlockMatch = piBlockRegex.exec(rawContent)) !== null) {
    const piId = piBlockMatch[1];
    const block = piBlockMatch[2];
    const targetMap = new Map<string, StrippedOverride>();

    // 提取 target + propertyPath + value 组合
    const modRegex = /target:\s*\{fileID:\s*(\d+)[^}]*\}\s*\n\s*propertyPath:\s*([\w.]+)\s*\n\s*value:\s*([^\n]*)\n\s*objectReference:\s*\{([^}]*)\}/g;
    let modMatch;
    while ((modMatch = modRegex.exec(block)) !== null) {
      const targetId = modMatch[1];
      const prop = modMatch[2];
      const val = modMatch[3].trim();
      const objectRef = modMatch[4] || '';

      if (!targetMap.has(targetId)) targetMap.set(targetId, {});
      const overrides = targetMap.get(targetId)!;

      switch (prop) {
        case 'm_AnchoredPosition.x': overrides.apX = parseFloat(val); break;
        case 'm_AnchoredPosition.y': overrides.apY = parseFloat(val); break;
        case 'm_SizeDelta.x': overrides.sdX = parseFloat(val); break;
        case 'm_SizeDelta.y': overrides.sdY = parseFloat(val); break;
        case 'm_AnchorMin.x': overrides.aMinX = parseFloat(val); break;
        case 'm_AnchorMin.y': overrides.aMinY = parseFloat(val); break;
        case 'm_AnchorMax.x': overrides.aMaxX = parseFloat(val); break;
        case 'm_AnchorMax.y': overrides.aMaxY = parseFloat(val); break;
        case 'm_Pivot.x': overrides.pivotX = parseFloat(val); break;
        case 'm_Pivot.y': overrides.pivotY = parseFloat(val); break;
        case 'm_LocalRotation.z': overrides.rotZ = parseFloat(val); break;
        case 'm_LocalRotation.w': overrides.rotW = parseFloat(val); break;
        case 'm_LocalScale.x': overrides.scaleX = parseFloat(val); break;
        case 'm_LocalScale.y': overrides.scaleY = parseFloat(val); break;
        case 'm_LocalScale.z': overrides.scaleZ = parseFloat(val); break;
        case 'm_Name': overrides.name = val; break;
        case 'm_IsActive': overrides.isActive = parseInt(val); break;
        case 'm_Enabled': overrides.enabled = parseInt(val); break;
        case 'm_Text': overrides.text = normalizeUnityTextForPreview(val); break;
        case 'm_Sprite': {
          const guidMatch = objectRef.match(/guid:\s*(\w+)/);
          const fileIdMatch = objectRef.match(/fileID:\s*(-?\d+)/);
          overrides.spriteGuid = guidMatch ? guidMatch[1] : '';
          overrides.spriteFileId = fileIdMatch ? parseInt(fileIdMatch[1]) : 0;
          break;
        }
        case 'm_Color.r': overrides.colorR = parseFloat(val); break;
        case 'm_Color.g': overrides.colorG = parseFloat(val); break;
        case 'm_Color.b': overrides.colorB = parseFloat(val); break;
        case 'm_Color.a': overrides.colorA = parseFloat(val); break;
      }
    }

  if (targetMap.size > 0) {
      piOverridesByTarget.set(piId, targetMap);
    }
  }

  function findBestRootTransformOverride(targetMap?: Map<string, StrippedOverride>): StrippedOverride | undefined {
    if (!targetMap) return undefined;
    let best: { ov: StrippedOverride; score: number } | undefined;
    for (const ov of targetMap.values()) {
      if (ov.sdX === undefined && ov.sdY === undefined) continue;
      const hasBothSizeAxes = ov.sdX !== undefined && ov.sdY !== undefined;
      const hasAnchorOrPosition =
        ov.aMinX !== undefined || ov.aMinY !== undefined ||
        ov.aMaxX !== undefined || ov.aMaxY !== undefined ||
        ov.apX !== undefined || ov.apY !== undefined ||
        ov.pivotX !== undefined || ov.pivotY !== undefined;
      // Fallback is only for variants where the root source fileID is unavailable.
      // A lone one-axis size override often belongs to a child of the source prefab;
      // treating it as the root collapses stretched descendants to 1px.
      if (!hasBothSizeAxes && !hasAnchorOrPosition) continue;
      const area = Math.abs(ov.sdX ?? 0) * Math.abs(ov.sdY ?? 0);
      let score = area;
      if (hasBothSizeAxes) score += 1000000;
      if (ov.aMinX !== undefined || ov.aMaxX !== undefined) score += 10000;
      if (ov.aMinY !== undefined || ov.aMaxY !== undefined) score += 10000;
      if (ov.apX !== undefined || ov.apY !== undefined) score += 5000;
      if (ov.pivotX !== undefined || ov.pivotY !== undefined) score += 2000;
      if (!best || score > best.score) best = { ov, score };
    }
    return best?.ov;
  }

  function findVerifiedRootOverride(
    targetMap: Map<string, StrippedOverride> | undefined,
    sourceTransformFileId?: string,
    sourceGameObjectFileId?: string,
    allowHeuristicFallback = false,
  ): StrippedOverride | undefined {
    if (!targetMap) return undefined;
    if (sourceTransformFileId) {
      const transformOverride = targetMap.get(sourceTransformFileId);
      if (transformOverride) return transformOverride;
    }
    if (sourceGameObjectFileId) {
      const gameObjectOverride = targetMap.get(sourceGameObjectFileId);
      if (gameObjectOverride) return gameObjectOverride;
    }
    // If the source prefab root is known, do not guess. Some old stripped
    // overrides can survive in the host prefab after the nested prefab root was
    // replaced, and applying them collapses the current source root.
    if (sourceTransformFileId || sourceGameObjectFileId) return undefined;
    return allowHeuristicFallback ? findBestRootTransformOverride(targetMap) : undefined;
  }

  // 索引 objects by fileID
  const byId = new Map<string, PrefabObject>();
  objects.forEach((o) => byId.set(o.fileID, o));

  // 找所有 GameObject (classID=1)
  const gameObjects = objects.filter((o) => o.classID === '1');
  // 找所有 RectTransform (classID=224) 或 Transform (classID=4)
  const transforms = objects.filter((o) => o.classID === '224' || o.classID === '4');

  // GO fileID → transform
  const goToTransform = new Map<string, PrefabObject>();
  for (const t of transforms) {
    const goRef = t.data.m_GameObject;
    if (goRef && goRef.fileID) {
      goToTransform.set(String(goRef.fileID), t);
    }
  }

  // transform fileID → GO fileID
  const transformToGo = new Map<string, string>();
  for (const [goId, t] of goToTransform.entries()) {
    transformToGo.set(String(t.fileID), goId);
  }

  // 找根节点（m_Father.fileID === 0 或 "0"）
  let rootTransform: PrefabObject | null = null;
  for (const t of transforms) {
    const father = t.data.m_Father;
    if (father && String(father.fileID) === '0') {
      rootTransform = t;
      break;
    }
  }

  // Prefab Variant 的根经常是 stripped RectTransform，没有 m_Father；
  // 根级 PrefabInstance 的 m_TransformParent 为 0，此时从它对应的 stripped RectTransform 入手。
  if (!rootTransform) {
    const hasRootPrefabInstance = [...prefabInstanceToGuid.keys()].some((piId) => !piTransformParent.has(piId));
    if (!hasRootPrefabInstance) {
      for (const t of transforms) {
        const piRef = t.data.m_PrefabInstance;
        if (!piRef?.fileID || String(piRef.fileID) === '0') continue;
        const piId = String(piRef.fileID);
        if (!piTransformParent.has(piId)) {
          rootTransform = t;
          break;
        }
      }
    }
  }

  const rootPrefabInstanceId = [...prefabInstanceToGuid.keys()].find((piId) => !piTransformParent.has(piId));
  if (!rootTransform && !rootPrefabInstanceId) return null;

  // ===== 预扫描 CSF + LayoutGroup 节点 =====
  // Unity script GUIDs
  const HLG_GUID = '30649d3a9faa99c48a7b1166b86bf2a0';
  const VLG_GUID = '59f8146938fff824cb5fd77236b75775';
  const GLG_GUID = '8a8695521f0d02e499659fee002a26c2';
  const UNITY_OUTLINE_GUID = 'e19747de3f5aca642ab2be37e372fb86';
  const UNITY_SHADOW_GUID = 'cfabb0440166ab443bba8876756fdfa9';
  const UI_SHADOW_GUID = '14c6aee5663bbfd49b41c7163318eef2';

  interface LayoutInfo {
    isHorizontal: boolean;
    isGrid: boolean;
    reverseArrangement: boolean;
    spacing: number;
    spacingY: number;  // GridLayoutGroup 的 y 间距
    padLeft: number; padRight: number; padTop: number; padBottom: number;
    childAlignment: number;
    childControlWidth: number; childControlHeight: number;
    cellWidth: number; cellHeight: number; // GridLayoutGroup cellSize
  }
  interface CSFInfo { enabled?: boolean; horizontalFit: number; verticalFit: number; }
  // AspectRatioFitter: mode 0=None 1=WidthControlsHeight 2=HeightControlsWidth 3=FitInParent 4=EnvelopeParent
  interface ARFInfo { aspectMode: number; aspectRatio: number; }

  // transformFID → { csf, lg, arf }
  const csfLayoutMap = new Map<string, { csf?: CSFInfo; lg?: LayoutInfo; arf?: ARFInfo }>();
  // ScrollRect Viewport → ScrollView transform FID 映射（Viewport 运行时被拉伸到 ScrollView 尺寸）
  const scrollViewportToParent = new Map<string, string>();

  function readLayoutInfo(comp: PrefabObject): LayoutInfo | undefined {
    if (comp.data.m_Spacing === undefined || comp.data.m_ChildAlignment === undefined) return undefined;
    const scriptGuid = comp.data.m_Script?.guid ? String(comp.data.m_Script.guid) : '';
    const isGrid = scriptGuid === GLG_GUID || comp.data.m_CellSize !== undefined;
    const pad = comp.data.m_Padding;
    return {
      isHorizontal: !isGrid && (scriptGuid === HLG_GUID || (scriptGuid !== VLG_GUID && comp.data.m_ChildControlWidth !== undefined)),
      isGrid,
      reverseArrangement: comp.data.m_ReverseArrangement === 1,
      spacing: typeof comp.data.m_Spacing === 'number' ? comp.data.m_Spacing : (comp.data.m_Spacing?.x ?? 0),
      spacingY: typeof comp.data.m_Spacing === 'object' ? (comp.data.m_Spacing?.y ?? 0) : 0,
      padLeft: pad?.m_Left ?? comp.data.m_Left ?? 0,
      padRight: pad?.m_Right ?? comp.data.m_Right ?? 0,
      padTop: pad?.m_Top ?? comp.data.m_Top ?? 0,
      padBottom: pad?.m_Bottom ?? comp.data.m_Bottom ?? 0,
      childAlignment: comp.data.m_ChildAlignment ?? 0,
      childControlWidth: comp.data.m_ChildControlWidth ?? 0,
      childControlHeight: comp.data.m_ChildControlHeight ?? 0,
      cellWidth: comp.data.m_CellSize?.x ?? 0,
      cellHeight: comp.data.m_CellSize?.y ?? 0,
    };
  }

  function persistLayoutGroup(node: TemplateNode, lg: LayoutInfo, comp: PrefabObject) {
    const enabled = comp.data.m_Enabled !== 0;
    const lgData = {
      enabled,
      spacing: lg.spacing,
      isHorizontal: lg.isHorizontal,
      isGrid: lg.isGrid,
      reverseArrangement: lg.reverseArrangement,
      spacingY: lg.spacingY,
      padLeft: lg.padLeft,
      padRight: lg.padRight,
      padTop: lg.padTop,
      padBottom: lg.padBottom,
      childAlignment: lg.childAlignment,
      childControlWidth: lg.childControlWidth,
      childControlHeight: lg.childControlHeight,
      cellWidth: lg.cellWidth,
      cellHeight: lg.cellHeight,
    };
    (node as any)._layoutGroup = lgData;
    node.layoutGroup = {
      ...lgData,
      enabled,
      layoutType: lg.isGrid ? 'Grid' : (lg.isHorizontal ? 'Horizontal' : 'Vertical'),
      childControlWidth: !!lg.childControlWidth,
      childControlHeight: !!lg.childControlHeight,
      childForceExpandWidth: !!(comp.data.m_ChildForceExpandWidth),
      childForceExpandHeight: !!(comp.data.m_ChildForceExpandHeight),
      reverseArrangement: lg.reverseArrangement,
      cellSizeX: comp.data.m_CellSize?.x,
      cellSizeY: comp.data.m_CellSize?.y,
      spacingY: lg.spacingY,
      startCorner: comp.data.m_StartCorner,
      startAxis: comp.data.m_StartAxis,
      constraint: comp.data.m_Constraint,
      constraintCount: comp.data.m_ConstraintCount,
    };
  }

  for (const go of gameObjects) {
    const comps = getComponents(String(go.fileID));
    let csf: CSFInfo | undefined;
    let lg: LayoutInfo | undefined;
    let arf: ARFInfo | undefined;
    for (const comp of comps) {
      // 跳过禁用的组件
      if (comp.data.m_Enabled === 0) continue;
      if (comp.data.m_HorizontalFit !== undefined || comp.data.m_VerticalFit !== undefined) {
        csf = { horizontalFit: comp.data.m_HorizontalFit ?? 0, verticalFit: comp.data.m_VerticalFit ?? 0 };
      }
      if (comp.data.m_Spacing !== undefined && comp.data.m_ChildAlignment !== undefined) {
        lg = readLayoutInfo(comp);
      }
      // AspectRatioFitter
      if (comp.data.m_AspectMode !== undefined && comp.data.m_AspectRatio !== undefined) {
        arf = { aspectMode: comp.data.m_AspectMode ?? 0, aspectRatio: comp.data.m_AspectRatio ?? 1 };
      }
    }
    if (csf || lg || arf) {
      const t = goToTransform.get(String(go.fileID));
      if (t) csfLayoutMap.set(String(t.fileID), { csf, lg, arf });
    }
    // ScrollRect: Viewport 运行时被拉伸到 ScrollView 全尺寸
    for (const comp of comps) {
      if (comp.data.m_Viewport && comp.data.m_Viewport.fileID) {
        const viewportGo = byId.get(String(comp.data.m_Viewport.fileID));
        const viewportT = viewportGo ? goToTransform.get(String(viewportGo.fileID)) : null;
        const scrollT = goToTransform.get(String(go.fileID));
        if (viewportT && scrollT) {
          scrollViewportToParent.set(String(viewportT.fileID), String(scrollT.fileID));
        }
      }
    }
  }

  // 获取 transform 对应的子节点尺寸列表（直接从 SizeDelta 读取）
  function getChildSizes(tObj: PrefabObject): { w: number; h: number }[] {
    const refs = tObj.data.m_Children;
    if (!Array.isArray(refs)) return [];
    const sizes: { w: number; h: number }[] = [];
    for (const ref of refs) {
      const cid = ref.fileID ? String(ref.fileID) : String(ref);
      const childT = byId.get(cid);
      if (!childT) continue;
      // 检查子节点对应的 GO 是否 active
      const childGoFid = transformToGo.get(cid);
      if (childGoFid) {
        const childGo = byId.get(childGoFid);
        if (childGo && childGo.data.m_IsActive === 0) continue; // 跳过非活跃节点
      }
      const csd = childT.data.m_SizeDelta;
      sizes.push({ w: Math.abs(csd?.x ?? 0), h: Math.abs(csd?.y ?? 0) });
    }
    return sizes;
  }

  // 计算 CSF 节点的首选尺寸
  function computeCSFSize(tObj: PrefabObject, info: { csf?: CSFInfo; lg?: LayoutInfo }, baseW: number, baseH: number): { w: number; h: number } {
    let w = baseW, h = baseH;
    if (!info.csf) return { w, h };

    const childSizes = getChildSizes(tObj);
    const n = childSizes.length;
    const lg = info.lg;

    if (info.csf.horizontalFit === 2) {
      if (lg && lg.isHorizontal && n > 0) {
        w = lg.padLeft + lg.padRight;
        for (const cs of childSizes) w += cs.w;
        w += Math.max(0, n - 1) * lg.spacing;
      } else if (lg && !lg.isHorizontal && n > 0) {
        // VLG: 宽度取最大子节点宽度 + padding
        let maxW = 0;
        for (const cs of childSizes) maxW = Math.max(maxW, cs.w);
        w = lg.padLeft + maxW + lg.padRight;
      } else if (n > 0) {
        let maxRight = 0;
        for (const cs of childSizes) maxRight = Math.max(maxRight, cs.w);
        w = maxRight;
      }
    }
    if (info.csf.verticalFit === 2) {
      if (lg && !lg.isHorizontal && n > 0) {
        h = lg.padTop + lg.padBottom;
        for (const cs of childSizes) h += cs.h;
        h += Math.max(0, n - 1) * lg.spacing;
      } else if (lg && lg.isHorizontal && n > 0) {
        let maxH = 0;
        for (const cs of childSizes) maxH = Math.max(maxH, cs.h);
        h = lg.padTop + maxH + lg.padBottom;
      } else if (n > 0) {
        let maxBottom = 0;
        for (const cs of childSizes) maxBottom = Math.max(maxBottom, cs.h);
        h = maxBottom;
      }
    }
    return { w: Math.max(1, w), h: Math.max(1, h) };
  }

  // 预计算所有 transform 的实际大小（从根往下递归）
  function precomputeSize(tObj: PrefabObject, pW: number, pH: number) {
    const sd = tObj.data.m_SizeDelta;
    const aMin = tObj.data.m_AnchorMin;
    const aMax = tObj.data.m_AnchorMax;

    const aMinX = aMin?.x ?? 0.5;
    const aMinY = aMin?.y ?? 0.5;
    const aMaxX = aMax?.x ?? 0.5;
    const aMaxY = aMax?.y ?? 0.5;
    const sdX = sd?.x ?? 0;
    const sdY = sd?.y ?? 0;

    let w: number, h: number;
    if (Math.abs(aMaxX - aMinX) > 0.001) {
      w = pW * (aMaxX - aMinX) + sdX;
    } else {
      w = Math.abs(sdX);
    }
    if (Math.abs(aMaxY - aMinY) > 0.001) {
      h = pH * (aMaxY - aMinY) + sdY;
    } else {
      h = Math.abs(sdY);
    }

    // 运行时布局组件：CSF / AspectRatioFitter
    const csfInfo = csfLayoutMap.get(String(tObj.fileID));
    if (csfInfo?.csf) {
      const adjusted = computeCSFSize(tObj, csfInfo, w, h);
      w = adjusted.w;
      h = adjusted.h;
    }
    if (csfInfo?.arf && csfInfo.arf.aspectMode > 0) {
      const { aspectMode, aspectRatio } = csfInfo.arf;
      if (aspectMode === 1) {
        h = w / aspectRatio;
      } else if (aspectMode === 2) {
        w = h * aspectRatio;
      } else if (aspectMode === 3) {
        if (pW / pH > aspectRatio) {
          h = pH; w = pH * aspectRatio;
        } else {
          w = pW; h = pW / aspectRatio;
        }
      } else if (aspectMode === 4) {
        if (pW / pH > aspectRatio) {
          w = pW; h = pW / aspectRatio;
        } else {
          h = pH; w = pH * aspectRatio;
        }
      }
    }

    // LayoutGroup 父节点已预算过子尺寸，如果当前算出来是 0 则用预算值
    const lgPreset = parentSizeCache.get(String(tObj.fileID));
    if (lgPreset) {
      if (w < 1) w = lgPreset.w;
      if (h < 1) h = lgPreset.h;
    }

    // ScrollRect Viewport: 运行时被拉伸到 ScrollView 全尺寸，序列化值(如100x100)不准
    const scrollParentFID = scrollViewportToParent.get(String(tObj.fileID));
    if (scrollParentFID) {
      const scrollSize = parentSizeCache.get(scrollParentFID);
      if (scrollSize) {
        w = scrollSize.w;
        h = scrollSize.h;
      }
    }

    // 缓存至少为1，供子节点计算用
    w = Math.max(1, Math.round(w * 100) / 100);
    h = Math.max(1, Math.round(h * 100) / 100);
    parentSizeCache.set(String(tObj.fileID), { w, h });

    // 递归子节点（LayoutGroup 父节点预先给子节点估算尺寸）
    const childRefs = tObj.data.m_Children;
    if (Array.isArray(childRefs)) {
      const lgInfo = csfLayoutMap.get(String(tObj.fileID))?.lg;
      if (lgInfo && childRefs.length > 0) {
        const padH = (lgInfo.padLeft || 0) + (lgInfo.padRight || 0);
        const padV = (lgInfo.padTop || 0) + (lgInfo.padBottom || 0);
        const spacing = lgInfo.spacing || 0;
        const n = childRefs.length;

        for (const ref of childRefs) {
          const cid = ref.fileID ? String(ref.fileID) : String(ref);
          const childT = byId.get(cid);
          if (!childT) continue;

          let cw: number, ch: number;

          if (lgInfo.isGrid && lgInfo.cellWidth > 0 && lgInfo.cellHeight > 0) {
            // GridLayoutGroup: 直接用 cellSize
            cw = lgInfo.cellWidth;
            ch = lgInfo.cellHeight;
          } else {
            // HLG / VLG
            const csd = childT.data.m_SizeDelta;
            const caMin = childT.data.m_AnchorMin;
            const caMax = childT.data.m_AnchorMax;
            cw = Math.abs(csd?.x ?? 0);
            ch = Math.abs(csd?.y ?? 0);
            if (caMin && caMax && Math.abs((caMax.x ?? 0.5) - (caMin.x ?? 0.5)) > 0.001)
              cw = w * ((caMax.x ?? 0.5) - (caMin.x ?? 0.5)) + (csd?.x ?? 0);
            if (caMin && caMax && Math.abs((caMax.y ?? 0.5) - (caMin.y ?? 0.5)) > 0.001)
              ch = h * ((caMax.y ?? 0.5) - (caMin.y ?? 0.5)) + (csd?.y ?? 0);

            if (lgInfo.childControlWidth) {
              if (lgInfo.isHorizontal) {
                cw = cw > 0 ? cw : Math.max(1, (w - padH - spacing * (n - 1)) / n);
              } else {
                cw = Math.max(1, w - padH);
              }
            }
            if (lgInfo.childControlHeight) {
              if (lgInfo.isHorizontal) {
                ch = Math.max(1, h - padV);
              } else {
                ch = ch > 0 ? ch : Math.max(1, (h - padV - spacing * (n - 1)) / n);
              }
            }
          }

          if (cw > 0 || ch > 0) {
            parentSizeCache.set(cid, { w: Math.round(cw * 100) / 100, h: Math.round(ch * 100) / 100 });
          }
        }
      }

      for (const ref of childRefs) {
        const cid = ref.fileID ? String(ref.fileID) : String(ref);
        const childT = byId.get(cid);
        if (childT) precomputeSize(childT, w, h);
      }

      // 回算：如果自身尺寸仍然为 0 且有子节点，从子节点包围盒估算
      const cached = parentSizeCache.get(String(tObj.fileID));
      if (cached && (cached.w <= 1 || cached.h <= 1) && childRefs.length > 0) {
        let maxR = 0, maxB = 0;
        for (const ref of childRefs) {
          const cid = ref.fileID ? String(ref.fileID) : String(ref);
          const cs = parentSizeCache.get(cid);
          if (cs) {
            maxR = Math.max(maxR, cs.w);
            maxB = Math.max(maxB, cs.h);
          }
        }
        if (cached.w <= 1 && maxR > 1) cached.w = Math.round(maxR * 100) / 100;
        if (cached.h <= 1 && maxB > 1) cached.h = Math.round(maxB * 100) / 100;
        parentSizeCache.set(String(tObj.fileID), cached);
      }
    }
  }
  if (rootTransform) precomputeSize(rootTransform, DESIGN_WIDTH, DESIGN_HEIGHT);

  // Text 组件 (Unity UGUI Text 的 classID=708)... 但实际上 Text 在 prefab 中也是 MonoBehaviour
  // 简化：通过字段名判断

  function getComponents(goFileID: string): PrefabObject[] {
    const go = byId.get(goFileID);
    if (!go || !go.data.m_Component) return [];
    const comps: PrefabObject[] = [];
    const compList = Array.isArray(go.data.m_Component) ? go.data.m_Component : [];
    for (const c of compList) {
      const ref = c.component || c;
      if (ref && ref.fileID) {
        const comp = byId.get(String(ref.fileID));
        if (comp) comps.push(comp);
      }
    }
    return comps;
  }

  // ===== 解析 CommonPart 嵌套 prefab 子节点（使用模块级缓存和深度限制） =====
  // 深拷贝 TemplateNode 树，避免缓存的共享引用被后续 buildNode push 子节点时污染
  function cloneTemplateNodes(nodes: TemplateNode[]): TemplateNode[] {
    return nodes.map(n => ({
      ...n,
      children: n.children ? cloneTemplateNodes(n.children) : [],
    }));
  }

  function round2(value: number): number {
    return Math.round(value * 100) / 100;
  }

  function isDefaultScale(scale?: { x: number; y: number; z?: number }): boolean {
    if (!scale) return true;
    return Math.abs(scale.x - 1) < 0.0001 && Math.abs(scale.y - 1) < 0.0001 && Math.abs((scale.z ?? 1) - 1) < 0.0001;
  }

  function assignScale(node: TemplateNode, scale?: { x: number; y: number; z?: number }) {
    if (!scale) return;
    const rounded = { x: round2(scale.x), y: round2(scale.y), z: round2(scale.z ?? 1) };
    (node as any).originalLocalScale = rounded;
    if (!isDefaultScale(rounded)) (node as any).localScale = rounded;
  }

  function getPrefabInstanceNodeType(isReusablePart: boolean, partData?: CommonPartCacheEntry | null): TemplateNode['type'] {
    if (isReusablePart) return 'component';
    return partData?.rootImagePath && partData.rootImageEnabled !== false ? 'image' : 'frame';
  }

  function applyPrefabRootVisualData(node: TemplateNode, partData?: CommonPartCacheEntry | null) {
    if (!partData) return;
    if (partData.rootImagePath) {
      if (node.type !== 'component') node.type = 'image';
      node.imagePath = partData.rootImagePath;
    }
    if (partData.rootImageEnabled === false) node.imageEnabled = false;
    if (partData.rootImageColor) (node as any).imageColor = partData.rootImageColor;
    if (partData.rootSliceBorder) node.sliceBorder = partData.rootSliceBorder;
    if (partData.rootImageType) node.imageType = partData.rootImageType;
  }

  function scaleFromOverride(ov?: StrippedOverride, fallback?: { x: number; y: number; z?: number }) {
    return {
      x: ov?.scaleX ?? fallback?.x ?? 1,
      y: ov?.scaleY ?? fallback?.y ?? 1,
      z: ov?.scaleZ ?? fallback?.z ?? 1,
    };
  }

  function colorOverrideToHex(ov: StrippedOverride): string | undefined {
    if (ov.colorR === undefined && ov.colorG === undefined && ov.colorB === undefined && ov.colorA === undefined) return undefined;
    const r = Math.round((ov.colorR ?? 1) * 255);
    const g = Math.round((ov.colorG ?? 1) * 255);
    const b = Math.round((ov.colorB ?? 1) * 255);
    const a = Math.round((ov.colorA ?? 1) * 255);
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}${a < 255 ? a.toString(16).padStart(2, '0') : ''}`;
  }

  function applyGraphicOverride(node: TemplateNode, ov?: StrippedOverride) {
    if (!ov) return;
    if (ov.enabled !== undefined) {
      if (node.type === 'text') {
        if (ov.enabled === 0) node.text = '';
      } else {
        node.imageEnabled = ov.enabled !== 0;
      }
    }
    if (ov.text !== undefined) node.text = ov.text;

    if (ov.spriteGuid !== undefined || ov.spriteFileId !== undefined) {
      const spriteGuid = ov.spriteGuid || '';
      const spriteFileId = ov.spriteFileId ?? 0;
      node.imageHasSprite = !!spriteGuid || spriteFileId !== 0;
      node.imageSpriteGuid = spriteGuid || undefined;
      node.imageSpriteFileId = spriteFileId || undefined;
      if (spriteGuid) {
        const imgUrl = guidToUrlCache?.get(spriteGuid);
        if (imgUrl) node.imagePath = imgUrl;
        const border = guidToSliceBorder?.get(spriteGuid);
        if (border) node.sliceBorder = border;
      } else if (spriteFileId === 0) {
        delete node.imagePath;
        delete node.sliceBorder;
      }
    }

    const color = colorOverrideToHex(ov);
    if (color) {
      if (node.type === 'text') node.fontColor = color;
      else node.imageColor = color;
    }
  }

  function applyOverridesToClones(nodes: TemplateNode[], targetMap?: Map<string, StrippedOverride>) {
    if (!targetMap) return;
    for (const node of nodes) {
      const localTransformId = (node as any)._localTransformFileId ? String((node as any)._localTransformFileId) : '';
      const unityTransformId = (node as any)._unityTransformFileId ? String((node as any)._unityTransformFileId) : '';
      const unityGameObjectId = node.unityFileId ? String(node.unityFileId) : '';
      const transformOv = (localTransformId ? targetMap.get(localTransformId) : undefined)
        ?? (unityTransformId ? targetMap.get(unityTransformId) : undefined);
      const gameObjectOv = unityGameObjectId ? targetMap.get(unityGameObjectId) : undefined;
      const imageOv = node._imageComponentFileId ? targetMap.get(String(node._imageComponentFileId)) : undefined;
      const textOv = node._textComponentFileId ? targetMap.get(String(node._textComponentFileId)) : undefined;

      if (gameObjectOv) {
        if (gameObjectOv.name) node.name = gameObjectOv.name;
        if (gameObjectOv.isActive !== undefined) node.active = gameObjectOv.isActive !== 0;
      }
      applyGraphicOverride(node, imageOv);
      applyGraphicOverride(node, textOv);

      const ov = transformOv;
      if (ov) {
        if (!gameObjectOv?.name && ov.name) node.name = ov.name;
        if (gameObjectOv?.isActive === undefined && ov.isActive !== undefined) node.active = ov.isActive !== 0;
        if (ov.aMinX !== undefined || ov.aMinY !== undefined) {
          node.anchorMin = {
            x: ov.aMinX ?? node.anchorMin?.x ?? 0.5,
            y: ov.aMinY ?? node.anchorMin?.y ?? 0.5,
          };
        }
        if (ov.aMaxX !== undefined || ov.aMaxY !== undefined) {
          node.anchorMax = {
            x: ov.aMaxX ?? node.anchorMax?.x ?? node.anchorMin?.x ?? 0.5,
            y: ov.aMaxY ?? node.anchorMax?.y ?? node.anchorMin?.y ?? 0.5,
          };
        }
        if (ov.pivotX !== undefined || ov.pivotY !== undefined) {
          node.pivot = {
            x: ov.pivotX ?? node.pivot?.x ?? 0.5,
            y: ov.pivotY ?? node.pivot?.y ?? 0.5,
          };
        }
        if (ov.apX !== undefined || ov.apY !== undefined) {
          const base = (node as any).originalAnchoredPosition || { x: 0, y: 0 };
          (node as any).originalAnchoredPosition = {
            x: round2(ov.apX ?? base.x ?? 0),
            y: round2(ov.apY ?? base.y ?? 0),
          };
        }
        if (ov.sdX !== undefined || ov.sdY !== undefined) {
          const base = (node as any).originalSizeDelta || { x: node.width, y: node.height };
          (node as any).originalSizeDelta = {
            x: round2(ov.sdX ?? base.x ?? node.width),
            y: round2(ov.sdY ?? base.y ?? node.height),
          };
        }
        if (ov.rotZ !== undefined && ov.rotW !== undefined) {
          const angleDeg = 2 * Math.atan2(ov.rotZ, ov.rotW) * (180 / Math.PI);
          const rounded = round2(angleDeg);
          if (Math.abs(rounded) > 0.01) node.rotation = rounded;
        }
        if (ov.scaleX !== undefined || ov.scaleY !== undefined || ov.scaleZ !== undefined) {
          assignScale(node, scaleFromOverride(ov, (node as any).originalLocalScale));
        }
      }
      if (node.children?.length) applyOverridesToClones(node.children, targetMap);
    }
  }

  function resolveClonedChildRects(nodes: TemplateNode[], parentW: number, parentH: number) {
    for (const node of nodes) {
      const aMinX = node.anchorMin?.x ?? 0.5;
      const aMinY = node.anchorMin?.y ?? 0.5;
      const aMaxX = node.anchorMax?.x ?? aMinX;
      const aMaxY = node.anchorMax?.y ?? aMinY;
      const px = node.pivot?.x ?? 0.5;
      const py = node.pivot?.y ?? 0.5;
      const apX = node.originalAnchoredPosition?.x;
      const apY = node.originalAnchoredPosition?.y;
      const sdX = node.originalSizeDelta?.x;
      const sdY = node.originalSizeDelta?.y;
      const isStretchX = Math.abs(aMaxX - aMinX) > 0.001;
      const isStretchY = Math.abs(aMaxY - aMinY) > 0.001;

      let w = node.width;
      let h = node.height;
      if (isStretchX && sdX !== undefined) w = parentW * (aMaxX - aMinX) + sdX;
      else if (sdX !== undefined) w = Math.abs(sdX);
      if (isStretchY && sdY !== undefined) h = parentH * (aMaxY - aMinY) + sdY;
      else if (sdY !== undefined) h = Math.abs(sdY);

      if (apX !== undefined) {
        if (isStretchX && sdX !== undefined) {
          const offsetMinX = apX - sdX * px;
          node.x = round2(parentW * aMinX + offsetMinX);
        } else {
          node.x = round2(aMinX * parentW + apX - px * w);
        }
      }
      if (apY !== undefined) {
        if (isStretchY && sdY !== undefined) {
          const offsetMinY = apY - sdY * py;
          const bottom = parentH * aMinY + offsetMinY;
          node.y = round2(parentH - bottom - h);
        } else {
          const centerY = aMinY * parentH + apY;
          node.y = round2(parentH - centerY - (1 - py) * h);
        }
      }

      node.width = round2(Math.max(1, w));
      node.height = round2(Math.max(1, h));
      if (node.children?.length) resolveClonedChildRects(node.children, node.width, node.height);
    }
  }

  function parseCommonPartChildren(prefabName: string, _containerW: number, _containerH: number): CommonPartCacheEntry | null {
    if (_globalNestDepth >= MAX_NEST_DEPTH) return null;
    // 循环引用检测
    if (_parsingParts.has(prefabName)) return null;

    if (_globalPartCache.has(prefabName)) {
      const cached = _globalPartCache.get(prefabName);
      return cached ? { ...cached, children: cloneTemplateNodes(cached.children) } : null;
    }

    // 通过 guidToPrefabName 查找完整路径，兼容 CommonPart 和模块专属 Part
    let prefabPath = '';
    for (const [, info] of guidToPrefabName!) {
      if (info.name === prefabName) { prefabPath = info.path; break; }
    }
    if (!prefabPath) prefabPath = path.join(COMMON_PART_DIR, prefabName + '.prefab');
    if (!fs.existsSync(prefabPath)) {
      _globalPartCache.set(prefabName, null);
      return null;
    }

    try {
      _globalNestDepth++;
      _parsingParts.add(prefabName);
      const partContent = fs.readFileSync(prefabPath, 'utf-8');
      const partObjects = parsePrefabYaml(partContent);
      const partRoot = buildNodeTree(partObjects, partContent);
      _globalNestDepth--;
      _parsingParts.delete(prefabName);
      if (partRoot) {
        const result = {
          children: partRoot.children || [],
          rootUnityFileId: partRoot.unityFileId,
          rootUnityTransformFileId: partRoot._unityTransformFileId,
          rootIsPrefabInstance: partObjects.some((obj) => obj.classID === '1001' && obj.fileID === partRoot.unityFileId),
          rootImagePath: (partRoot as any).imagePath as string | undefined,
          rootImageEnabled: (partRoot as any).imageEnabled as boolean | undefined,
          rootImageColor: (partRoot as any).imageColor as string | undefined,
          rootSliceBorder: (partRoot as any).sliceBorder as number[] | undefined,
          rootImageType: (partRoot as any).imageType as string | undefined,
          rootWidth: partRoot.width,
          rootHeight: partRoot.height,
          rootAnchorMin: partRoot.anchorMin,
          rootAnchorMax: partRoot.anchorMax,
          rootPivot: partRoot.pivot,
          rootOriginalSizeDelta: (partRoot as any).originalSizeDelta as { x: number; y: number } | undefined,
          rootOriginalAnchoredPosition: (partRoot as any).originalAnchoredPosition as { x: number; y: number } | undefined,
          rootOriginalLocalScale: (partRoot as any).originalLocalScale as { x: number; y: number; z?: number } | undefined,
        };
        _globalPartCache.set(prefabName, result);
        return { ...result, children: cloneTemplateNodes(result.children) };
      }
    } catch (e) {
      _globalNestDepth--;
      _parsingParts.delete(prefabName);
    }
    _globalPartCache.set(prefabName, null);
    return null;
  }

  function findNodeByNameDeep(node: TemplateNode, name: string): TemplateNode | null {
    if (node.name === name) return node;
    for (const child of node.children || []) {
      const found = findNodeByNameDeep(child, name);
      if (found) return found;
    }
    return null;
  }

  function findNodeByUnityFileIdDeep(node: TemplateNode, unityFileId: string): TemplateNode | null {
    if (node.unityFileId === unityFileId || node._unityTransformFileId === unityFileId) return node;
    for (const child of node.children || []) {
      const found = findNodeByUnityFileIdDeep(child, unityFileId);
      if (found) return found;
    }
    return null;
  }

  function mergeOrAppendChild(parent: TemplateNode, childNode: TemplateNode) {
    const sameIdx = parent.children.findIndex((child) =>
      (!!childNode.unityFileId && child.unityFileId === childNode.unityFileId) ||
      child.name === childNode.name
    );
    if (sameIdx >= 0) parent.children[sameIdx] = childNode;
    else parent.children.push(childNode);
  }

  const appliedAddedLayoutComponentIds = new Set<string>();

  function applyAddedLayoutGroupsToAttachment(piId: string, rootNode: TemplateNode, node: TemplateNode, targetSourceFileId?: string) {
    const addedComponents = piAddedComponents.get(piId) || [];
    const unresolvedInheritedLayoutGroups: { id: string; comp: PrefabObject; lg: LayoutInfo }[] = [];
    for (const added of addedComponents) {
      if (appliedAddedLayoutComponentIds.has(added.addedComponentId)) continue;
      const comp = byId.get(added.addedComponentId);
      if (!comp) continue;
      const lg = readLayoutInfo(comp);
      if (!lg) continue;
      const goId = getRefFileID(comp.data.m_GameObject);
      const go = goId ? byId.get(goId) : null;
      const goPi = go?.data.m_PrefabInstance?.fileID ? String(go.data.m_PrefabInstance.fileID) : '';
      // Added components targeting inherited GameObjects do not have a local
      // RectTransform link. Attach their layout data to the same inherited
      // parent that received the locally added children.
      if (!(go && goPi === piId && !goToTransform.has(String(go.fileID)))) continue;

      if (!targetSourceFileId || added.targetSourceFileId === targetSourceFileId) {
        persistLayoutGroup(node, lg, comp);
        appliedAddedLayoutComponentIds.add(added.addedComponentId);
        continue;
      }

      const resolvedTargetNode = findNodeByUnityFileIdDeep(rootNode, added.targetSourceFileId);
      if (resolvedTargetNode === node) {
        persistLayoutGroup(node, lg, comp);
        appliedAddedLayoutComponentIds.add(added.addedComponentId);
      } else if (!resolvedTargetNode) {
        unresolvedInheritedLayoutGroups.push({ id: added.addedComponentId, comp, lg });
      }
    }

    if (!node.layoutGroup && unresolvedInheritedLayoutGroups.length === 1) {
      const { id, comp, lg } = unresolvedInheritedLayoutGroups[0];
      persistLayoutGroup(node, lg, comp);
      appliedAddedLayoutComponentIds.add(id);
    }
  }

  function findVariantAttachmentNode(rootNode: TemplateNode, targetSourceFileId?: string, rootSourceFileId?: string, rootSourceTransformFileId?: string): TemplateNode {
    if (targetSourceFileId && (
      (rootSourceFileId && targetSourceFileId === rootSourceFileId) ||
      (rootSourceTransformFileId && targetSourceFileId === rootSourceTransformFileId)
    )) return rootNode;
    if (targetSourceFileId) {
      const byUnityFileId = findNodeByUnityFileIdDeep(rootNode, targetSourceFileId);
      if (byUnityFileId) return byUnityFileId;
    }
    return findNodeByNameDeep(rootNode, 'functionObjs') || rootNode;
  }

  function findPrefabInstanceSourceTransformId(piId: string): string | undefined {
    for (const t of transforms) {
      const piRef = t.data.m_PrefabInstance;
      if (!piRef?.fileID || String(piRef.fileID) !== piId) continue;
      if (goToTransform.has(String(t.fileID))) continue;
      const sourceId = getRefFileID(t.data.m_CorrespondingSourceObject);
      if (sourceId) return sourceId;
    }
    return undefined;
  }

  function findPrefabInstanceSourceGameObjectId(piId: string, targetMap?: Map<string, StrippedOverride>): string | undefined {
    let fallback: string | undefined;
    for (const obj of objects) {
      if (obj.classID !== '1') continue;
      const piRef = obj.data.m_PrefabInstance;
      if (!piRef?.fileID || String(piRef.fileID) !== piId) continue;
      const sourceId = getRefFileID(obj.data.m_CorrespondingSourceObject);
      if (!sourceId) continue;
      if (targetMap?.get(sourceId)?.name) return sourceId;
      fallback ??= sourceId;
    }
    return fallback;
  }

  function mergeAddedGameObjectsIntoVariantRoot(rootNode: TemplateNode, piId: string, rootSourceFileId?: string, rootSourceTransformFileId?: string) {
    const additions = piAddedGameObjects.get(piId) || [];
    if (additions.length === 0) return;

    const byLocalParent = new Map<string, { targetSourceFileId: string; addedTransformIds: string[] }>();
    for (const addition of additions) {
      const childTransform = byId.get(addition.addedTransformId);
      if (!childTransform) continue;
      const childPrefabInstanceId = childTransform.data.m_PrefabInstance?.fileID ? String(childTransform.data.m_PrefabInstance.fileID) : '';
      const fatherId = getRefFileID(childTransform.data.m_Father) || (childPrefabInstanceId ? piTransformParent.get(childPrefabInstanceId) : undefined);
      if (!fatherId) continue;
      const key = `${fatherId}:${addition.targetSourceFileId}`;
      if (!byLocalParent.has(key)) {
        byLocalParent.set(key, { targetSourceFileId: addition.targetSourceFileId, addedTransformIds: [] });
      }
      byLocalParent.get(key)!.addedTransformIds.push(addition.addedTransformId);
    }

    for (const [key, group] of byLocalParent) {
      const localParentId = key.split(':')[0];
      const targetNode = findVariantAttachmentNode(rootNode, group.targetSourceFileId, rootSourceFileId, rootSourceTransformFileId);
      parentSizeCache.set(localParentId, { w: targetNode.width, h: targetNode.height });
      applyAddedLayoutGroupsToAttachment(piId, rootNode, targetNode, group.targetSourceFileId);

      for (const childTransformId of group.addedTransformIds) {
        const childTransform = byId.get(childTransformId);
        if (!childTransform) continue;
        const childNode = buildNode(childTransform);
        if (childNode) mergeOrAppendChild(targetNode, childNode);
      }
    }
  }

  function buildRootPrefabInstanceNode(piId: string): TemplateNode | null {
    const sourceGuid = prefabInstanceToGuid.get(piId);
    if (!sourceGuid) return null;
    const prefabInfo = guidToPrefabName?.get(sourceGuid);
    if (!prefabInfo) return null;

    const targetMap = piOverridesByTarget.get(piId);
    const partData = parseCommonPartChildren(prefabInfo.name, 0, 0);
    const strippedSourceTransformFileId = findPrefabInstanceSourceTransformId(piId);
    const rootSourceFileId = partData?.rootUnityFileId ?? findPrefabInstanceSourceGameObjectId(piId, targetMap);
    const rootSourceTransformFileId = partData?.rootIsPrefabInstance
      ? (strippedSourceTransformFileId ?? partData?.rootUnityTransformFileId)
      : (partData?.rootUnityTransformFileId ?? strippedSourceTransformFileId);
    const ov = findVerifiedRootOverride(
      targetMap,
      rootSourceTransformFileId,
      rootSourceFileId,
      !rootSourceTransformFileId && !rootSourceFileId,
    );
    let overrideName: string | undefined;
    if (targetMap) {
      for (const [, targetOv] of targetMap) {
        if (targetOv.name) { overrideName = targetOv.name; break; }
      }
    }

    let w = partData?.rootWidth ?? 100;
    let h = partData?.rootHeight ?? 100;
    let aMinX = partData?.rootAnchorMin?.x ?? 0.5;
    let aMinY = partData?.rootAnchorMin?.y ?? 0.5;
    let aMaxX = partData?.rootAnchorMax?.x ?? 0.5;
    let aMaxY = partData?.rootAnchorMax?.y ?? 0.5;
    let px = partData?.rootPivot?.x ?? 0.5;
    let py = partData?.rootPivot?.y ?? 0.5;
    const baseSizeDelta = partData?.rootOriginalSizeDelta;
    const baseAnchoredPosition = partData?.rootOriginalAnchoredPosition;
    let scale = scaleFromOverride(ov, partData?.rootOriginalLocalScale);
    let apX = ov?.apX ?? baseAnchoredPosition?.x ?? 0;
    let apY = ov?.apY ?? baseAnchoredPosition?.y ?? 0;
    let sdX = ov?.sdX ?? baseSizeDelta?.x ?? w;
    let sdY = ov?.sdY ?? baseSizeDelta?.y ?? h;
    px = ov?.pivotX ?? px;
    py = ov?.pivotY ?? py;
    aMinX = ov?.aMinX ?? aMinX;
    aMinY = ov?.aMinY ?? aMinY;
    aMaxX = ov?.aMaxX ?? aMaxX;
    aMaxY = ov?.aMaxY ?? aMaxY;

    const hasChildren = !!partData?.children?.length;
    const scaleCollapsed =
      Math.abs(scale.x) < 0.0001 ||
      Math.abs(scale.y) < 0.0001 ||
      Math.abs(scale.z ?? 1) < 0.0001;
    const rectCollapsed =
      Math.abs(sdX) < 0.0001 &&
      Math.abs(sdY) < 0.0001 &&
      hasChildren;
    if (scaleCollapsed || rectCollapsed) {
      scale = { x: 1, y: 1, z: 1 };
      aMinX = partData?.rootAnchorMin?.x ?? 0.5;
      aMinY = partData?.rootAnchorMin?.y ?? 0.5;
      aMaxX = partData?.rootAnchorMax?.x ?? aMinX;
      aMaxY = partData?.rootAnchorMax?.y ?? aMinY;
      px = partData?.rootPivot?.x ?? 0.5;
      py = partData?.rootPivot?.y ?? 0.5;
      apX = baseAnchoredPosition?.x ?? 0;
      apY = baseAnchoredPosition?.y ?? 0;
      sdX = baseSizeDelta?.x ?? partData?.rootWidth ?? DESIGN_WIDTH;
      sdY = baseSizeDelta?.y ?? partData?.rootHeight ?? DESIGN_HEIGHT;
    }

    const isStretchX = Math.abs(aMaxX - aMinX) > 0.001;
    const isStretchY = Math.abs(aMaxY - aMinY) > 0.001;
    let x: number, y: number;
    if (isStretchX) {
      w = DESIGN_WIDTH * (aMaxX - aMinX) + sdX;
      x = DESIGN_WIDTH * aMinX + (apX - sdX * px);
    } else {
      w = Math.abs(sdX);
      x = aMinX * DESIGN_WIDTH + apX - px * w;
    }
    if (isStretchY) {
      h = DESIGN_HEIGHT * (aMaxY - aMinY) + sdY;
      const bottom = DESIGN_HEIGHT * aMinY + (apY - sdY * py);
      y = DESIGN_HEIGHT - bottom - h;
    } else {
      h = Math.abs(sdY);
      const centerY = aMinY * DESIGN_HEIGHT + apY;
      y = DESIGN_HEIGHT - centerY - (1 - py) * h;
    }

    w = round2(w);
    h = round2(h);
    x = round2(x);
    y = round2(y);
    parentSizeCache.set(piId, { w, h });

    const children = partData?.children ? cloneTemplateNodes(partData.children) : [];
    applyOverridesToClones(children, targetMap);
    if (children.length) resolveClonedChildRects(children, w, h);

    const normalizedPrefabPath = prefabInfo.path.replace(/\\/g, '/');
    const isReusablePart = normalizedPrefabPath.includes('/CommonPart/') ||
      normalizedPrefabPath.includes('/Part/') ||
      prefabInfo.name.startsWith('Part_');

    const node: TemplateNode = {
      name: overrideName || ov?.name || (isReusablePart ? `@${prefabInfo.name}` : prefabInfo.name),
      type: getPrefabInstanceNodeType(isReusablePart, partData),
      active: true,
      x, y, width: w, height: h,
      componentRef: isReusablePart ? prefabInfo.name : undefined,
      unityFileId: piId,
      _unityTransformFileId: rootSourceTransformFileId,
      _localTransformFileId: rootSourceTransformFileId,
      anchorMin: { x: aMinX, y: aMinY },
      anchorMax: { x: aMaxX, y: aMaxY },
      pivot: { x: px, y: py },
      originalSizeDelta: { x: round2(sdX), y: round2(sdY) },
      originalAnchoredPosition: { x: round2(apX), y: round2(apY) },
      children,
    } as TemplateNode;
    assignScale(node, scale);
    applyPrefabRootVisualData(node, partData);

    mergeAddedGameObjectsIntoVariantRoot(node, piId, rootSourceFileId, rootSourceTransformFileId);
    return node;
  }

  function buildNode(transformObj: PrefabObject): TemplateNode | null {
    const goFileID = transformToGo.get(String(transformObj.fileID));

    // stripped RectTransform 没有 m_GameObject，检查 m_PrefabInstance
    if (!goFileID) {
      const piRef = transformObj.data.m_PrefabInstance;
      if (piRef && piRef.fileID && String(piRef.fileID) !== '0') {
        const piId = String(piRef.fileID);
        const sourceGuid = prefabInstanceToGuid.get(piId);
        if (sourceGuid) {
          const prefabInfo = guidToPrefabName?.get(sourceGuid);
          if (prefabInfo) {
            // 从 stripped RectTransform 的 m_CorrespondingSourceObject 获取内部根 transform 的 fileID
            const corrSource = transformObj.data.m_CorrespondingSourceObject;
            const rootTransformInternalId = getRefFileID(corrSource) || '';

            const partData = parseCommonPartChildren(prefabInfo.name, 0, 0);
            const verifiedRootTransformFileId = partData?.rootUnityTransformFileId ?? rootTransformInternalId;
            const verifiedRootGameObjectFileId = partData?.rootUnityFileId;

            // 从 PrefabInstance modifications 中只取目标为当前 source root 的属性。
            // 旧的 stripped target 可能仍留在宿主 prefab 中，但不属于当前 nested
            // prefab root，不能用启发式兜底套到新根节点。
            const targetMap = piOverridesByTarget.get(piId);
            const ov = findVerifiedRootOverride(
              targetMap,
              verifiedRootTransformFileId,
              verifiedRootGameObjectFileId,
              !verifiedRootTransformFileId && !verifiedRootGameObjectFileId,
            );
            // 也查找名称覆盖（可能在 GameObject 的 target 上）
            let overrideName: string | undefined;
            if (targetMap) {
              for (const [, targetOv] of targetMap) {
                if (targetOv.name) { overrideName = targetOv.name; break; }
              }
            }

            let w = partData?.rootWidth ?? 100;
            let h = partData?.rootHeight ?? 100;
            let aMinX = partData?.rootAnchorMin?.x ?? 0.5;
            let aMinY = partData?.rootAnchorMin?.y ?? 0.5;
            let aMaxX = partData?.rootAnchorMax?.x ?? 0.5;
            let aMaxY = partData?.rootAnchorMax?.y ?? 0.5;
            let px = partData?.rootPivot?.x ?? 0.5;
            let py = partData?.rootPivot?.y ?? 0.5;
            const baseSizeDelta = partData?.rootOriginalSizeDelta;
            const baseAnchoredPosition = partData?.rootOriginalAnchoredPosition;
            let scale = scaleFromOverride(ov, partData?.rootOriginalLocalScale);
            let apX = ov?.apX ?? baseAnchoredPosition?.x ?? 0;
            let apY = ov?.apY ?? baseAnchoredPosition?.y ?? 0;
            let sdX = ov?.sdX ?? baseSizeDelta?.x ?? w;
            let sdY = ov?.sdY ?? baseSizeDelta?.y ?? h;
            px = ov?.pivotX ?? px;
            py = ov?.pivotY ?? py;
            aMinX = ov?.aMinX ?? aMinX;
            aMinY = ov?.aMinY ?? aMinY;
            aMaxX = ov?.aMaxX ?? aMaxX;
            aMaxY = ov?.aMaxY ?? aMaxY;

            const hasChildren = !!partData?.children?.length;
            const scaleCollapsed =
              Math.abs(scale.x) < 0.0001 ||
              Math.abs(scale.y) < 0.0001 ||
              Math.abs(scale.z ?? 1) < 0.0001;
            const rectCollapsed =
              Math.abs(sdX) < 0.0001 &&
              Math.abs(sdY) < 0.0001 &&
              hasChildren;
            if (scaleCollapsed || rectCollapsed) {
              scale = { x: 1, y: 1, z: 1 };
              aMinX = partData?.rootAnchorMin?.x ?? 0.5;
              aMinY = partData?.rootAnchorMin?.y ?? 0.5;
              aMaxX = partData?.rootAnchorMax?.x ?? aMinX;
              aMaxY = partData?.rootAnchorMax?.y ?? aMinY;
              px = partData?.rootPivot?.x ?? 0.5;
              py = partData?.rootPivot?.y ?? 0.5;
              apX = baseAnchoredPosition?.x ?? 0;
              apY = baseAnchoredPosition?.y ?? 0;
              sdX = baseSizeDelta?.x ?? partData?.rootWidth ?? DESIGN_WIDTH;
              sdY = baseSizeDelta?.y ?? partData?.rootHeight ?? DESIGN_HEIGHT;
            }

            // 获取父节点大小 — 优先使用 m_TransformParent，stripped 节点没有 m_Father
            const parentTid = piTransformParent.get(piId) || (transformObj.data.m_Father?.fileID ? String(transformObj.data.m_Father.fileID) : undefined);
            let pW = DESIGN_WIDTH, pH = DESIGN_HEIGHT;
            if (parentTid && parentTid !== '0') {
              const ps = parentSizeCache.get(parentTid);
              if (ps) { pW = ps.w; pH = ps.h; }
            }

            const isStretchX = Math.abs(aMaxX - aMinX) > 0.001;
            const isStretchY = Math.abs(aMaxY - aMinY) > 0.001;
            let x: number, y: number;

            if (isStretchX) {
              w = pW * (aMaxX - aMinX) + sdX;
              const offsetMinX = apX - sdX * px;
              x = pW * aMinX + offsetMinX;
            } else {
              w = Math.abs(sdX);
              x = aMinX * pW + apX - px * w;
            }

            if (isStretchY) {
              h = pH * (aMaxY - aMinY) + sdY;
              const offsetMinY = apY - sdY * py;
              const bottom = pH * aMinY + offsetMinY;
              y = pH - bottom - h;
            } else {
              h = Math.abs(sdY);
              const centerY = aMinY * pH + apY;
              y = pH - centerY - (1 - py) * h;
            }

            w = Math.round(w * 100) / 100;
            h = Math.round(h * 100) / 100;
            x = Math.round(x * 100) / 100;
            y = Math.round(y * 100) / 100;
            parentSizeCache.set(String(transformObj.fileID), { w, h });

            // 从 PrefabInstance modifications 中查找根节点的 m_IsActive 覆盖
            // 根 GameObject 的 target 同时拥有 m_Name 和 m_IsActive 修改
            let nodeActive = true;
            if (targetMap) {
              // 优先：找同时有 name 的 target（即根 GameObject）的 isActive
              let rootIsActive: number | undefined;
              let fallbackIsActive: number | undefined;
              for (const [, targetOv] of targetMap) {
                if (targetOv.name && targetOv.isActive !== undefined) {
                  // 有 name 的 target 是根 GameObject
                  rootIsActive = targetOv.isActive;
                } else if (targetOv.isActive !== undefined && fallbackIsActive === undefined) {
                  fallbackIsActive = targetOv.isActive;
                }
              }
              if (rootIsActive !== undefined) {
                nodeActive = rootIsActive !== 0;
              }
              // 不使用 fallback —— 那可能是子节点的 isActive
            }

            // 从覆盖中提取旋转
            let strippedRotation: number | undefined;
            if (ov && ov.rotZ !== undefined && ov.rotW !== undefined) {
              const angleDeg = 2 * Math.atan2(ov.rotZ, ov.rotW) * (180 / Math.PI);
              const rounded = Math.round(angleDeg * 100) / 100;
              if (Math.abs(rounded) > 0.01) strippedRotation = rounded;
            }

            const children = partData?.children ? cloneTemplateNodes(partData.children) : [];
            applyOverridesToClones(children, targetMap);
            if (children.length) resolveClonedChildRects(children, w, h);
            for (const t of transforms) {
              if (String(t.fileID) === String(transformObj.fileID)) continue;
              const father = t.data.m_Father;
              if (!father || String(father.fileID) !== String(transformObj.fileID)) continue;
              const childNode = buildNode(t);
              if (!childNode) continue;
              const sameIdx = children.findIndex((child) =>
                (!!childNode.unityFileId && child.unityFileId === childNode.unityFileId) ||
                child.name === childNode.name
              );
              if (sameIdx >= 0) children[sameIdx] = childNode;
              else children.push(childNode);
            }

            const normalizedPrefabPath = prefabInfo.path.replace(/\\/g, '/');
            const isReusablePart = normalizedPrefabPath.includes('/CommonPart/') ||
              normalizedPrefabPath.includes('/Part/') ||
              prefabInfo.name.startsWith('Part_');
            const strippedType = getPrefabInstanceNodeType(isReusablePart, partData);
            const node: TemplateNode = {
              name: overrideName || ov?.name || (isReusablePart ? `@${prefabInfo.name}` : prefabInfo.name),
              type: strippedType,
              active: nodeActive,
              x, y, width: w, height: h,
              rotation: strippedRotation,
              componentRef: isReusablePart ? prefabInfo.name : undefined,
              unityFileId: piId,
              _unityTransformFileId: verifiedRootTransformFileId,
              _localTransformFileId: String(transformObj.fileID),
              anchorMin: { x: aMinX, y: aMinY },
              anchorMax: { x: aMaxX, y: aMaxY },
              pivot: { x: px, y: py },
              originalSizeDelta: { x: round2(sdX), y: round2(sdY) },
              originalAnchoredPosition: { x: round2(apX), y: round2(apY) },
              children,
            } as TemplateNode;
            assignScale(node, scale);
            applyPrefabRootVisualData(node, partData);
            mergeAddedGameObjectsIntoVariantRoot(node, piId, partData?.rootUnityFileId, partData?.rootUnityTransformFileId);
            return node;
          }
        }
      }
      return null;
    }

    const go = byId.get(goFileID);
    if (!go) return null;

    const node: TemplateNode = {
      name: String(go.data.m_Name || 'Node'),
      type: 'frame',
      active: go.data.m_IsActive !== 0,
      x: 0, y: 0, width: 100, height: 100,
      unityFileId: goFileID,
      _unityTransformFileId: String(transformObj.fileID),
      _localTransformFileId: String(transformObj.fileID),
      children: [],
    };

    // RectTransform 数据
    if (transformObj.classID === '224') {
      const pos = transformObj.data.m_AnchoredPosition;
      const size = transformObj.data.m_SizeDelta;
      const pivot = transformObj.data.m_Pivot;
      const anchorMin = transformObj.data.m_AnchorMin;
      const anchorMax = transformObj.data.m_AnchorMax;

      const px = pivot?.x ?? 0.5;
      const py = pivot?.y ?? 0.5;
      const aMinX = anchorMin?.x ?? 0.5;
      const aMinY = anchorMin?.y ?? 0.5;
      const aMaxX = anchorMax?.x ?? 0.5;
      const aMaxY = anchorMax?.y ?? 0.5;
      const sdX = size?.x ?? 0;
      const sdY = size?.y ?? 0;
      const apX = pos?.x ?? 0;
      const apY = pos?.y ?? 0;

      // 获取父节点实际大小（递归计算）
      const parentTransformId = transformObj.data.m_Father?.fileID;
      let parentW = DESIGN_WIDTH, parentH = DESIGN_HEIGHT;
      if (parentTransformId && String(parentTransformId) !== '0') {
        // 简化：用 parentSizeCache
        const pSize = parentSizeCache.get(String(parentTransformId));
        if (pSize) { parentW = pSize.w; parentH = pSize.h; }
      }

      let w: number, h: number, leftEdge: number, topEdge: number;

      const isStretchX = Math.abs(aMaxX - aMinX) > 0.001;
      const isStretchY = Math.abs(aMaxY - aMinY) > 0.001;

      if (isStretchX) {
        w = parentW * (aMaxX - aMinX) + sdX;
        const offsetMinX = apX - sdX * px;
        leftEdge = parentW * aMinX + offsetMinX;
      } else {
        w = Math.abs(sdX);
        // 用实际 SizeDelta 计算位置，不用父尺寸兜底
        const anchorX = aMinX * parentW;
        leftEdge = anchorX + apX - px * w;
      }

      if (isStretchY) {
        h = parentH * (aMaxY - aMinY) + sdY;
        const offsetMinY = apY - sdY * py;
        const bottomEdge = parentH * aMinY + offsetMinY;
        topEdge = parentH - bottomEdge - h;
      } else {
        h = Math.abs(sdY);
        const anchorY = aMinY * parentH;
        const centerY = anchorY + apY;
        topEdge = parentH - centerY - (1 - py) * h;
      }

      // 运行时布局组件（CSF / AspectRatioFitter）：用 precomputeSize 已计算的尺寸替换，并重算位置
      const _csfInfo = csfLayoutMap.get(String(transformObj.fileID));
      if (_csfInfo?.csf || _csfInfo?.arf) {
        const cachedSize = parentSizeCache.get(String(transformObj.fileID));
        if (cachedSize && (cachedSize.w > w + 0.5 || cachedSize.h > h + 0.5)) {
          const newW = cachedSize.w;
          const newH = cachedSize.h;
          // 用调整后的尺寸重算位置
          if (Math.abs(newW - w) > 0.5) {
            if (isStretchX) {
              leftEdge = parentW * aMinX + (apX - (newW - parentW * (aMaxX - aMinX)) * px);
            } else {
              leftEdge = aMinX * parentW + apX - px * newW;
            }
            w = newW;
          }
          if (Math.abs(newH - h) > 0.5) {
            if (isStretchY) {
              const bottomEdge = parentH * aMinY + (apY - (newH - parentH * (aMaxY - aMinY)) * py);
              topEdge = parentH - bottomEdge - newH;
            } else {
              const centerY = aMinY * parentH + apY;
              topEdge = parentH - centerY - (1 - py) * newH;
            }
            h = newH;
          }
        }
      }

      // LayoutGroup 父节点给子节点预算过尺寸 —— 如果算出来是 0 则用预算值
      const lgCached = parentSizeCache.get(String(transformObj.fileID));
      if (lgCached) {
        if (w < 1) w = lgCached.w;
        if (h < 1) h = lgCached.h;
      }

      // ScrollRect Viewport: 运行时被拉伸到 ScrollView 全尺寸
      const svParentFID = scrollViewportToParent.get(String(transformObj.fileID));
      if (svParentFID) {
        const svSize = parentSizeCache.get(svParentFID);
        if (svSize) { w = svSize.w; h = svSize.h; }
      }

      node.width = Math.round(w * 100) / 100;
      node.height = Math.round(h * 100) / 100;
      node.x = Math.round(leftEdge * 100) / 100;
      node.y = Math.round(topEdge * 100) / 100;

      // 保存原始 Unity anchoredPosition 和 sizeDelta，导出时优先使用
      (node as any).originalSizeDelta = { x: Math.round(sdX * 100) / 100, y: Math.round(sdY * 100) / 100 };
      (node as any).originalAnchoredPosition = { x: Math.round(apX * 100) / 100, y: Math.round(apY * 100) / 100 };
      const localScale = transformObj.data.m_LocalScale;
      assignScale(node, {
        x: localScale?.x ?? 1,
        y: localScale?.y ?? 1,
        z: localScale?.z ?? 1,
      });

      // 存储锚点数据
      node.anchorMin = { x: aMinX, y: aMinY };
      node.anchorMax = { x: aMaxX, y: aMaxY };
      node.pivot = { x: px, y: py };

      // 从四元数提取 Z 轴旋转角度（2D UI 只绕 Z 轴旋转）
      const localRot = transformObj.data.m_LocalRotation;
      if (localRot) {
        const rz = localRot.z ?? 0;
        const rw = localRot.w ?? 1;
        const angleDeg = 2 * Math.atan2(rz, rw) * (180 / Math.PI);
        const rounded = Math.round(angleDeg * 100) / 100;
        if (Math.abs(rounded) > 0.01) node.rotation = rounded;
      }

      // 缓存自己的大小供子节点使用
      parentSizeCache.set(String(transformObj.fileID), { w: node.width, h: node.height });
    }

    // 检测组件类型
    const comps = getComponents(goFileID);
    buildCaches();

    // 检测是否是嵌套的 CommonPart 预制体
    // 方式1: stripped 对象的 m_CorrespondingSourceObject 有 guid
    const correspondingSource = go.data.m_CorrespondingSourceObject;
    if (correspondingSource && correspondingSource.guid && String(correspondingSource.guid) !== '0') {
      const prefabInfo = guidToPrefabName?.get(String(correspondingSource.guid));
      if (prefabInfo) {
        const normalizedPrefabPath = prefabInfo.path.replace(/\\/g, '/');
        const isReusablePart = normalizedPrefabPath.includes('/CommonPart/') ||
          normalizedPrefabPath.includes('/Part/') ||
          prefabInfo.name.startsWith('Part_');
        const partData = parseCommonPartChildren(prefabInfo.name, node.width, node.height);
        node.type = getPrefabInstanceNodeType(isReusablePart, partData);
        node.componentRef = isReusablePart ? prefabInfo.name : undefined;
        node.children = partData?.children || [];
        applyPrefabRootVisualData(node, partData);
        return node;
      }
    }
    // 方式2: 通过 m_PrefabInstance → 正则提取的 SourcePrefab guid
    const prefabInstRef = go.data.m_PrefabInstance;
    if (prefabInstRef && prefabInstRef.fileID && String(prefabInstRef.fileID) !== '0') {
      const sourceGuid = prefabInstanceToGuid.get(String(prefabInstRef.fileID));
      if (sourceGuid) {
        const prefabInfo = guidToPrefabName?.get(sourceGuid);
        if (prefabInfo) {
          const normalizedPrefabPath = prefabInfo.path.replace(/\\/g, '/');
          const isReusablePart = normalizedPrefabPath.includes('/CommonPart/') ||
            normalizedPrefabPath.includes('/Part/') ||
            prefabInfo.name.startsWith('Part_');
          const partData = parseCommonPartChildren(prefabInfo.name, node.width, node.height);
          node.type = getPrefabInstanceNodeType(isReusablePart, partData);
          node.componentRef = isReusablePart ? prefabInfo.name : undefined;
          node.children = partData?.children || [];
          applyPrefabRootVisualData(node, partData);
          return node;
        }
      }
    }

    // 从原始 YAML 中提取 Text 组件的嵌套字段（m_FontData 子对象）
    function getTextDataFromRaw(compFileID: string) {
      const blockRegex = new RegExp(`--- !u!114 &${compFileID}[^\\n]*\\n([\\s\\S]*?)(?=\\n--- |$)`);
      const blockMatch = blockRegex.exec(rawContent);
      if (!blockMatch) return null;
      const block = blockMatch[1];

      const getInt = (key: string) => { const m = block.match(new RegExp(`${key}:\\s*(\\d+)`)); return m ? parseInt(m[1]) : undefined; };
      const getFloat = (key: string) => { const m = block.match(new RegExp(`${key}:\\s*([\\d.]+)`)); return m ? parseFloat(m[1]) : undefined; };
      const getGuid = (key: string) => { const m = block.match(new RegExp(`${key}:\\s*\\{[^}]*guid:\\s*(\\w+)`)); return m ? m[1] : undefined; };

      return {
        fontSize: getInt('m_FontSize') ?? 24,
        fontStyle: getInt('m_FontStyle') ?? 0,
        alignment: getInt('m_Alignment') ?? 0,
        richText: getInt('m_RichText') ?? 1,
        horizontalOverflow: getInt('m_HorizontalOverflow') ?? 0,
        verticalOverflow: getInt('m_VerticalOverflow') ?? 0,
        lineSpacing: getFloat('m_LineSpacing') ?? 1,
        bestFit: getInt('m_BestFit') ?? 0,
        minSize: getInt('m_MinSize') ?? 2,
        maxSize: getInt('m_MaxSize') ?? 300,
        fontGuid: getGuid('m_Font'),
        raycastTarget: getInt('m_RaycastTarget') ?? 1,
      };
    }

    // Unity TextAnchor: 0=UL 1=UC 2=UR 3=ML 4=MC 5=MR 6=LL 7=LC 8=LR
    const alignmentMap: Record<number, string> = {
      0: 'left', 1: 'center', 2: 'right',
      3: 'left', 4: 'center', 5: 'right',
      6: 'left', 7: 'center', 8: 'right',
    };

    for (const comp of comps) {
      if (comp.classID === '328') {
        node.nativeVideoPlayer = true;
      }

      // Text 组件（有 m_Text 字段）
      if (comp.data.m_Text !== undefined) {
        node.type = 'text';
        node._textComponentFileId = comp.fileID;
        const rawText = String(comp.data.m_Text || '');
        node.text = normalizeUnityTextForPreview(rawText);

        // 从原始 YAML 提取嵌套的 m_FontData 字段
        const textData = getTextDataFromRaw(comp.fileID);
        node.fontSize = textData?.fontSize || comp.data.m_FontSize || 24;
        node.textAlign = alignmentMap[textData?.alignment ?? 0] || 'left';
        node.alignment = textData?.alignment ?? 0;
        node.fontStyle = textData?.fontStyle ?? 0;
        node.richText = (textData?.richText ?? 1) === 1;
        node.horizontalOverflow = textData?.horizontalOverflow ?? 0;
        node.verticalOverflow = textData?.verticalOverflow ?? 0;
        node.lineSpacing = textData?.lineSpacing ?? 1;
        node.bestFit = (textData?.bestFit ?? 0) === 1;
        node.bestFitMinSize = textData?.minSize ?? 2;
        node.bestFitMaxSize = textData?.maxSize ?? 300;
        node.raycastTarget = (textData?.raycastTarget ?? 1) === 1;

        // 字体路径
        if (textData?.fontGuid) {
          buildCaches();
          const fp = guidToFontPath?.get(textData.fontGuid);
          if (fp) node.fontPath = fp;
        }

        const color = comp.data.m_Color;
        if (color) {
          const r = Math.round((color.r ?? 1) * 255);
          const g = Math.round((color.g ?? 1) * 255);
          const b = Math.round((color.b ?? 1) * 255);
          const a = Math.round((color.a ?? 1) * 255);
          node.fontColor = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}${a < 255 ? a.toString(16).padStart(2, '0') : ''}`;
        }
      }

      // Image 组件（有 m_Sprite 字段）
      if (comp.data.m_Sprite !== undefined && node.type !== 'text') {
        node._imageComponentFileId = comp.fileID;
        const spriteRef = comp.data.m_Sprite;
        const spriteGuid = spriteRef?.guid ? String(spriteRef.guid) : '';
        const spriteFileId = Number(spriteRef?.fileID ?? 0);
        node.imageHasSprite = !!spriteGuid || spriteFileId !== 0;
        node.imageSpriteGuid = spriteGuid || undefined;
        node.imageSpriteFileId = spriteFileId || undefined;

        // 不再通过 sprite 匹配 CommonPart 组件 —— 所有真正的 CommonPart 实例
        // 都已通过 PrefabInstance/stripped transform 正确识别，sprite 匹配只会产生误判
        {
          node.type = 'image';
          // Image 组件 m_Enabled=0 → 节点保留但 imageEnabled=false（不渲染图像）
          if (comp.data.m_Enabled === 0) node.imageEnabled = false;
          const imgType = comp.data.m_Type;
          if (imgType === 1) node.imageType = 'Sliced';
          else if (imgType === 2) node.imageType = 'Tiled';
          else if (imgType === 3) node.imageType = 'Filled';
          else node.imageType = 'Simple';

          if (spriteGuid) {
            const imgUrl = guidToUrlCache?.get(spriteGuid);
            if (imgUrl) node.imagePath = imgUrl;
            const border = guidToSliceBorder?.get(spriteGuid);
            if (border) node.sliceBorder = border;
          }

          // Image 完整属性
          const imgColor = comp.data.m_Color;
          if (imgColor) {
            const r = Math.round((imgColor.r ?? 1) * 255);
            const g = Math.round((imgColor.g ?? 1) * 255);
            const b = Math.round((imgColor.b ?? 1) * 255);
            const a = Math.round((imgColor.a ?? 1) * 255);
            node.imageColor = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}${a < 255 ? a.toString(16).padStart(2, '0') : ''}`;
          }
          node.imageRaycastTarget = comp.data.m_RaycastTarget !== 0;
          node.preserveAspect = comp.data.m_PreserveAspect === 1;
          node.useSpriteMesh = comp.data.m_UseSpriteMesh === 1;
          node.fillCenter = comp.data.m_FillCenter !== 0;
          if (imgType === 3) {
            node.fillMethod = comp.data.m_FillMethod ?? 0;
            node.fillAmount = comp.data.m_FillAmount ?? 1;
            node.fillClockwise = comp.data.m_FillClockwise !== 0;
            node.fillOrigin = comp.data.m_FillOrigin ?? 0;
          }
        }
      }

      // RawImage 组件（有 m_Texture 字段但无 m_Sprite）
      if (comp.data.m_Texture !== undefined && comp.data.m_Sprite === undefined && node.type === 'frame') {
        node.type = 'rawimage';
      }

      // Button 组件（有 m_OnClick 字段）
      if (comp.data.m_OnClick !== undefined) {
        if (node.type === 'image' || node.type === 'frame') {
          node.type = 'button';
        }
        node.interactable = comp.data.m_Interactable !== 0;
        node.buttonTransition = comp.data.m_Transition ?? 1;

        // 从原始 YAML 提取 Button 颜色状态
        const btnBlockRegex = new RegExp(`--- !u!114 &${comp.fileID}[^\\n]*\\n([\\s\\S]*?)(?=\\n--- |$)`);
        const btnBlockMatch = btnBlockRegex.exec(rawContent);
        if (btnBlockMatch) {
          const bb = btnBlockMatch[1];
          const parseColor = (prefix: string) => {
            const m = bb.match(new RegExp(`${prefix}:\\s*\\{r:\\s*([\\d.]+),\\s*g:\\s*([\\d.]+),\\s*b:\\s*([\\d.]+),\\s*a:\\s*([\\d.]+)\\}`));
            if (!m) return '#ffffffff';
            const r = Math.round(parseFloat(m[1]) * 255);
            const g = Math.round(parseFloat(m[2]) * 255);
            const b = Math.round(parseFloat(m[3]) * 255);
            const a = Math.round(parseFloat(m[4]) * 255);
            return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}${a.toString(16).padStart(2,'0')}`;
          };
          const multiplierMatch = bb.match(/m_ColorMultiplier:\s*([\d.]+)/);
          const fadeMatch = bb.match(/m_FadeDuration:\s*([\d.]+)/);
          node.buttonColors = {
            normalColor: parseColor('m_NormalColor'),
            highlightedColor: parseColor('m_HighlightedColor'),
            pressedColor: parseColor('m_PressedColor'),
            disabledColor: parseColor('m_DisabledColor'),
            colorMultiplier: multiplierMatch ? parseFloat(multiplierMatch[1]) : 1,
            fadeDuration: fadeMatch ? parseFloat(fadeMatch[1]) : 0.1,
          };
        }
      }

      // ScrollRect 组件（有 m_Content 字段）
      if (comp.data.m_Content !== undefined && comp.data.m_Horizontal !== undefined) {
        node.type = 'scrollview';
        const isH = comp.data.m_Horizontal === 1;
        const isV = comp.data.m_Vertical === 1;
        node.scrollDirection = (isH && isV) ? 'both' : isH ? 'horizontal' : 'vertical';
      }

      // Toggle 组件（有 m_IsOn 字段）
      if (comp.data.m_IsOn !== undefined && comp.data.m_Group !== undefined) {
        node.type = 'toggle';
        node.isOn = comp.data.m_IsOn === 1;
      }

      // InputField 组件（有 m_TextComponent 字段）
      if (comp.data.m_TextComponent !== undefined && comp.data.m_CaretBlinkRate !== undefined) {
        node.type = 'inputfield';
      }

      // Mask 组件（有 m_ShowMaskGraphic 字段）
      if (comp.data.m_ShowMaskGraphic !== undefined) {
        node.isMask = true;
        node.maskType = 'Mask';
        node.maskShowGraphic = comp.data.m_ShowMaskGraphic !== 0;
      }

      // LayoutElement（有 m_IgnoreLayout 与 flexible/preferred 字段）
      if (comp.data.m_IgnoreLayout !== undefined && comp.data.m_FlexibleHeight !== undefined) {
        node.layoutElement = {
          ignoreLayout: comp.data.m_IgnoreLayout !== 0,
          minWidth: comp.data.m_MinWidth ?? -1,
          minHeight: comp.data.m_MinHeight ?? -1,
          preferredWidth: comp.data.m_PreferredWidth ?? -1,
          preferredHeight: comp.data.m_PreferredHeight ?? -1,
          flexibleWidth: comp.data.m_FlexibleWidth ?? -1,
          flexibleHeight: comp.data.m_FlexibleHeight ?? -1,
        };
      }

      // LayoutGroup 检测（有 m_Spacing 和 m_ChildAlignment）
      if (comp.data.m_Spacing !== undefined && comp.data.m_ChildAlignment !== undefined) {
        const lg = readLayoutInfo(comp);
        if (lg) persistLayoutGroup(node, lg, comp);
      }

      // ContentSizeFitter 检测（有 m_HorizontalFit 或 m_VerticalFit）
      if (comp.data.m_HorizontalFit !== undefined || comp.data.m_VerticalFit !== undefined) {
        (node as any)._contentSizeFitter = {
          enabled: comp.data.m_Enabled !== 0,
          horizontalFit: comp.data.m_HorizontalFit ?? 0,
          verticalFit: comp.data.m_VerticalFit ?? 0,
        };
        // 持久化到节点属性
        node.contentSizeFitter = {
          enabled: comp.data.m_Enabled !== 0,
          horizontalFit: comp.data.m_HorizontalFit ?? 0,
          verticalFit: comp.data.m_VerticalFit ?? 0,
        };
      }
    }

    // RectMask2D 检测：通过 m_Script guid 精确匹配
    // RectMask2D guid: 3312d7739989d2b4e91e6319e9a96d76
    for (const comp of comps) {
      const scriptGuid = comp.data.m_Script?.guid ? String(comp.data.m_Script.guid) : '';
      if (scriptGuid === '3312d7739989d2b4e91e6319e9a96d76') {
        node.isMask = true;
        node.maskType = 'RectMask2D';
        break;
      }
    }

    // Outline/Shadow/Gradient 效果检测（针对 text 节点）
    if (node.type === 'text') {
      for (const comp of comps) {
        // Outline / Shadow / Camel.UIEffects.UIShadow — 通过 m_Script guid 区分
        if (comp.data.m_EffectColor !== undefined && comp.data.m_EffectDistance !== undefined) {
          const ec = comp.data.m_EffectColor;
          const r = Math.round((ec.r ?? 0) * 255);
          const g = Math.round((ec.g ?? 0) * 255);
          const b = Math.round((ec.b ?? 0) * 255);
          const a = Math.round((ec.a ?? 1) * 255);
          const color = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}${a < 255 ? a.toString(16).padStart(2, '0') : ''}`;
          const dist = comp.data.m_EffectDistance;
          const dx = dist?.x ?? 1;
          const dy = dist?.y ?? -1;
          const scriptGuid = comp.data.m_Script?.guid ? String(comp.data.m_Script.guid) : '';
          const useGraphicAlpha = comp.data.m_UseGraphicAlpha !== undefined ? comp.data.m_UseGraphicAlpha !== 0 : undefined;
          const baseEffect: TextEffectData = { color, distance: [dx, dy] };
          if (useGraphicAlpha !== undefined) baseEffect.useGraphicAlpha = useGraphicAlpha;

          if (scriptGuid === UI_SHADOW_GUID) {
            const style = typeof comp.data.m_Style === 'number' ? comp.data.m_Style : 1;
            if (style !== 0) {
              const effect: TextEffectData = {
                ...baseEffect,
                source: 'UIShadow',
                style,
                useGraphicAlpha: useGraphicAlpha ?? true,
              };
              if (style === 1 || style === 4) node.textShadow = effect;
              else node.textOutline = effect;
            }
          } else if (scriptGuid === UNITY_SHADOW_GUID) {
            node.textShadow = { ...baseEffect, source: 'UnityShadow' };
          } else {
            const outlineEffect: TextEffectData = { ...baseEffect };
            if (scriptGuid === UNITY_OUTLINE_GUID) outlineEffect.source = 'UnityOutline';
            node.textOutline = outlineEffect;
          }
        }

        // UIGradient (Coffee.UIEffects) — 有 m_Direction + m_Color1 + m_Color2
        if (comp.data.m_Direction !== undefined && comp.data.m_Color1 !== undefined && comp.data.m_Color2 !== undefined) {
          const dirMap: Record<number, 'Horizontal' | 'Vertical' | 'Angle' | 'Diagonal'> = {
            0: 'Horizontal', 1: 'Vertical', 2: 'Angle', 3: 'Diagonal',
          };
          const toHex = (c: any) => {
            const r = Math.round((c?.r ?? 1) * 255);
            const g = Math.round((c?.g ?? 1) * 255);
            const b = Math.round((c?.b ?? 1) * 255);
            return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
          };
          node.textGradient = {
            direction: dirMap[comp.data.m_Direction] || 'Vertical',
            color1: toHex(comp.data.m_Color1),
            color2: toHex(comp.data.m_Color2),
          };
        }
      }
    }

    // MirrorImage 组件检测（guid: 4766b9a4b916df14c8abf0dc5e6fafb7）
    for (const comp of comps) {
      const scriptGuid = comp.data.m_Script?.guid ? String(comp.data.m_Script.guid) : '';
      if (scriptGuid === '4766b9a4b916df14c8abf0dc5e6fafb7') {
        const mt = comp.data.m_MirrorType ?? 0;
        const mirrorMap: Record<number, 'Horizontal' | 'Vertical' | 'Quarter'> = {
          0: 'Horizontal', 1: 'Vertical', 2: 'Quarter',
        };
        node.mirrorType = mirrorMap[mt] || 'Horizontal';
        break;
      }
    }

    // 递归子节点
    const childRefs = transformObj.data.m_Children;
    if (Array.isArray(childRefs)) {
      for (const ref of childRefs) {
        const childFileID = ref.fileID ? String(ref.fileID) : String(ref);
        const childTransform = byId.get(childFileID);
        if (childTransform) {
          const childNode = buildNode(childTransform);
          if (childNode) node.children.push(childNode);
        }
      }
    }

    // GridLayoutGroup / HLG / VLG：重算子节点位置
    const parentLgInfo = csfLayoutMap.get(String(transformObj.fileID))?.lg;
    if (parentLgInfo && node.children.length > 0) {
      const padL = parentLgInfo.padLeft || 0;
      const padT = parentLgInfo.padTop || 0;
      const spX = parentLgInfo.spacing || 0;
      const spY = parentLgInfo.spacingY || parentLgInfo.spacing || 0;

      if (parentLgInfo.isGrid && parentLgInfo.cellWidth > 0) {
        // GridLayoutGroup 网格布局
        const cw = parentLgInfo.cellWidth;
        const ch = parentLgInfo.cellHeight;
        const contentW = node.width;
        // startAxis=0 → 先水平填，再换行
        const cols = Math.max(1, Math.floor((contentW - padL - (parentLgInfo.padRight || 0) + spX) / (cw + spX)));
        node.children.forEach((child, i) => {
          const col = i % cols;
          const row = Math.floor(i / cols);
          child.x = padL + col * (cw + spX);
          child.y = padT + row * (ch + spY);
          child.width = cw;
          child.height = ch;
        });
      } else if (parentLgInfo.isHorizontal) {
        // HorizontalLayoutGroup
        let curX = padL;
        node.children.forEach((child) => {
          child.x = curX;
          child.y = padT;
          curX += child.width + spX;
        });
      } else {
        // VerticalLayoutGroup
        let curY = padT;
        node.children.forEach((child) => {
          child.x = padL;
          child.y = curY;
          curY += child.height + spY;
        });
      }
    }

    return node;
  }

  const root = rootTransform
    ? buildNode(rootTransform)
    : (rootPrefabInstanceId ? buildRootPrefabInstanceNode(rootPrefabInstanceId) : null);

  // ===== 后处理：估算 ContentSizeFitter/LayoutGroup 节点的显示尺寸 =====
  // 原始 sizeDelta/anchoredPosition 已保存在 originalSizeDelta/originalAnchoredPosition，不会丢失
  function estimateTextPreferredWidth(node: TemplateNode): number {
    const fontSize = Math.max(1, node.fontSize || 24);
    const text = node.text || '';
    if (!text) return 1;
    let units = 0;
    for (const ch of text) {
      if (ch === '\r') continue;
      if (ch === '\n') {
        units = Math.max(units, 1);
      } else if (/\s/.test(ch)) {
        units += 0.3;
      } else if (/[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/.test(ch)) {
        units += 1;
      } else if (/[A-Z0-9]/.test(ch)) {
        units += 0.5;
      } else {
        units += 0.5;
      }
    }
    return Math.max(1, Math.ceil(units * fontSize));
  }

  function estimateTextPreferredHeight(node: TemplateNode, widthOverride?: number): number {
    const fontSize = Math.max(1, node.fontSize || 24);
    const lineSpacing = Math.max(1, node.lineSpacing ?? 1);
    const lineHeight = fontSize * lineSpacing * 1.44;
    const text = node.text || '';
    if (!text) return round2(lineHeight);
    const width = Math.max(1, widthOverride && widthOverride > 1 ? widthOverride : node.width || estimateTextPreferredWidth(node));
    let lines = 0;
    for (const segment of text.split(/\r?\n/)) {
      if (!segment) {
        lines += 1;
        continue;
      }
      const charsPerLine = Math.max(1, Math.floor(width / Math.max(1, fontSize * 0.55)));
      lines += Math.max(1, Math.ceil(segment.length / charsPerLine));
    }
    return round2(Math.max(1, lines) * lineHeight);
  }

  function estimatePreferredSize(node: TemplateNode): { w: number; h: number } {
    if (node.imagePath && (node.type === 'image' || node.type === 'button' || node.type === 'rawimage')) {
      const url = node.imagePath;
      if (guidToImageSize) {
        for (const [guid, size] of guidToImageSize) {
          if (guidToUrlCache?.get(guid) === url) return size;
        }
      }
    }
    if (node.type === 'text' && node.fontSize) {
      return { w: estimateTextPreferredWidth(node), h: estimateTextPreferredHeight(node) };
    }
    return { w: node.width, h: node.height };
  }

  function postProcessLayout(node: TemplateNode) {
    // 先递归处理子节点（底层优先）
    for (const child of node.children) postProcessLayout(child);

    const rawCsf = (node as any)._contentSizeFitter ?? node.contentSizeFitter;
    const rawLg = (node as any)._layoutGroup ?? node.layoutGroup;
    const csf = rawCsf?.enabled !== false ? rawCsf : undefined;
    const lg = rawLg?.enabled !== false ? rawLg : undefined;

    if (!lg && !csf) {
      delete (node as any)._contentSizeFitter;
      delete (node as any)._layoutGroup;
      return;
    }

    const activeChildren = node.children.filter(c => c.active !== false && c.layoutElement?.ignoreLayout !== true);
    const containerW = node.width;
    const containerH = node.height;

    const preferredNodeWidth = (child: TemplateNode) => {
      const le = child.layoutElement;
      if (le?.preferredWidth !== undefined && le.preferredWidth > 0) return le.preferredWidth;
      if (le?.minWidth !== undefined && le.minWidth > 0) return le.minWidth;
      if (child.width > 1) return child.width;
      let maxRight = 0;
      for (const grandChild of child.children || []) maxRight = Math.max(maxRight, grandChild.x + grandChild.width);
      return Math.max(1, maxRight || child.width);
    };
    const preferredNodeHeight = (child: TemplateNode, widthOverride?: number) => {
      const le = child.layoutElement;
      if (le?.preferredHeight !== undefined && le.preferredHeight > 0) return le.preferredHeight;
      if (le?.minHeight !== undefined && le.minHeight > 0) return le.minHeight;
      const childLg = child.layoutGroup;
      const childActiveChildren = child.children?.filter(c => c.active !== false && c.layoutElement?.ignoreLayout !== true) || [];
      if (childLg?.enabled && childActiveChildren.length > 0 && !childLg.isGrid) {
        const sp = childLg.spacing || 0;
        if (childLg.isHorizontal) {
          let maxH = 0;
          const innerW = Math.max(1, (widthOverride ?? child.width) - (childLg.padLeft || 0) - (childLg.padRight || 0));
          for (const grandChild of childActiveChildren) maxH = Math.max(maxH, preferredNodeHeight(grandChild, innerW));
          return round2((childLg.padTop || 0) + maxH + (childLg.padBottom || 0));
        }
        const innerW = Math.max(1, (widthOverride ?? child.width) - (childLg.padLeft || 0) - (childLg.padRight || 0));
        let totalH = (childLg.padTop || 0) + (childLg.padBottom || 0) + sp * Math.max(0, childActiveChildren.length - 1);
        for (const grandChild of childActiveChildren) {
          totalH += preferredNodeHeight(grandChild, childLg.childControlWidth ? innerW : undefined);
        }
        return round2(totalH);
      }
      const textHasLayoutSize = Math.abs(child.originalSizeDelta?.y ?? child.height) <= 1;
      if (child.type === 'text' && child.fontSize && (child.height <= 1 || textHasLayoutSize)) {
        return estimateTextPreferredHeight(child, widthOverride);
      }
      if (child.height > 1) return child.height;
      let maxBottom = 0;
      for (const grandChild of child.children || []) {
        if (grandChild.active === false || grandChild.layoutElement?.ignoreLayout === true) continue;
        maxBottom = Math.max(maxBottom, grandChild.y + grandChild.height);
      }
      return Math.max(1, maxBottom || child.height);
    };
    const flexibleWidth = (child: TemplateNode) => Math.max(0, child.layoutElement?.flexibleWidth ?? 0);
    const flexibleHeight = (child: TemplateNode) => Math.max(0, child.layoutElement?.flexibleHeight ?? 0);

    // ===== Unity LayoutGroup 子节点排列 =====
    // childAlignment: 0=UL 1=UC 2=UR 3=ML 4=MC 5=MR 6=LL 7=LC 8=LR
    if (lg && activeChildren.length > 0) {
      const { isHorizontal, isGrid, reverseArrangement, spacing, spacingY: lgSpacingY, padLeft, padRight, padTop, padBottom, childAlignment, cellWidth, cellHeight, childControlWidth, childControlHeight } = lg;
      const layoutChildren = reverseArrangement ? [...activeChildren].reverse() : activeChildren;
      const alignRow = Math.floor(childAlignment / 3); // 0=Upper 1=Middle 2=Lower
      const alignCol = childAlignment % 3;              // 0=Left 1=Center 2=Right

      if (isGrid && cellWidth > 0 && cellHeight > 0) {
        // === GridLayoutGroup ===
        const spX = spacing;
        const spY = lgSpacingY || spacing;
        const contentW = containerW - padLeft - padRight;
        const cols = Math.max(1, Math.floor((contentW + spX) / (cellWidth + spX)));
        for (let i = 0; i < layoutChildren.length; i++) {
          const child = layoutChildren[i];
          const col = i % cols;
          const row = Math.floor(i / cols);
          child.x = Math.round((padLeft + col * (cellWidth + spX)) * 100) / 100;
          child.y = Math.round((padTop + row * (cellHeight + spY)) * 100) / 100;
          child.width = cellWidth;
          child.height = cellHeight;
        }
      } else if (isHorizontal) {
        // === HorizontalLayoutGroup ===
        // 主轴（X）：从左到右排列
        const availW = Math.max(1, containerW - padLeft - padRight - spacing * Math.max(0, activeChildren.length - 1));
        const availH = Math.max(1, containerH - padTop - padBottom);
        let fixedW = 0;
        let totalFlexW = 0;
        for (const child of layoutChildren) {
          const fw = flexibleWidth(child);
          totalFlexW += fw;
          if (fw <= 0) fixedW += preferredNodeWidth(child);
        }
        const flexSpaceW = Math.max(1, availW - fixedW);
        let xOffset = padLeft;
        for (const child of layoutChildren) {
          if (childControlWidth) {
            const fw = flexibleWidth(child);
            child.width = round2(fw > 0 && totalFlexW > 0 ? flexSpaceW * fw / totalFlexW : preferredNodeWidth(child));
          }
          if (childControlHeight) child.height = round2(availH);
          child.x = Math.round(xOffset * 100) / 100;
          xOffset += child.width + spacing;

          // 交叉轴（Y）：根据 alignRow 对齐（屏幕坐标，Y 朝下）
          if (alignRow === 0) {
            // Upper → 子节点贴顶
            child.y = padTop;
          } else if (alignRow === 1) {
            // Middle → 子节点居中
            child.y = Math.round((padTop + (availH - child.height) / 2) * 100) / 100;
          } else {
            // Lower → 子节点贴底
            child.y = Math.round((containerH - padBottom - child.height) * 100) / 100;
          }
          if (child.children?.length) {
            resolveClonedChildRects(child.children, child.width, child.height);
            postProcessLayout(child);
          }
        }
      } else {
        // === VerticalLayoutGroup ===
        // 主轴（Y）：从上到下排列
        const availW = Math.max(1, containerW - padLeft - padRight);
        const availH = Math.max(1, containerH - padTop - padBottom - spacing * Math.max(0, activeChildren.length - 1));
        let fixedH = 0;
        let totalFlexH = 0;
        for (const child of layoutChildren) {
          const fh = flexibleHeight(child);
          totalFlexH += fh;
          if (fh <= 0) fixedH += preferredNodeHeight(child, childControlWidth ? availW : undefined);
        }
        const flexSpaceH = Math.max(1, availH - fixedH);
        let yOffset = padTop;
        for (const child of layoutChildren) {
          if (childControlWidth) child.width = round2(availW);
          if (childControlHeight) {
            const fh = flexibleHeight(child);
            child.height = round2(fh > 0 && totalFlexH > 0 ? flexSpaceH * fh / totalFlexH : preferredNodeHeight(child, childControlWidth ? availW : undefined));
          }
          child.y = Math.round(yOffset * 100) / 100;
          yOffset += child.height + spacing;

          // 交叉轴（X）：根据 alignCol 对齐
          if (alignCol === 0) {
            child.x = padLeft;
          } else if (alignCol === 1) {
            child.x = Math.round((padLeft + (availW - child.width) / 2) * 100) / 100;
          } else {
            child.x = Math.round((containerW - padRight - child.width) * 100) / 100;
          }
          if (child.children?.length) {
            resolveClonedChildRects(child.children, child.width, child.height);
            postProcessLayout(child);
          }
        }
      }
    }

    // ===== ContentSizeFitter：Text 自身的 preferred size 来自 Graphic，而不是子节点包围盒 =====
    // 此处仅处理非 LayoutGroup 场景的 CSF（少见情况）
    if (csf && !lg) {
      const oldW = node.width;
      const oldH = node.height;

      if (csf.horizontalFit === 2) {
        if (node.type === 'text') {
          node.width = round2(estimatePreferredSize(node).w);
        } else if (node.width <= 1) {
          let maxRight = 0;
          for (const child of activeChildren) maxRight = Math.max(maxRight, child.x + child.width);
          node.width = Math.round(Math.max(1, maxRight) * 100) / 100;
        }
      }
      if (csf.verticalFit === 2) {
        if (node.type === 'text') {
          node.height = round2(estimatePreferredSize(node).h);
        } else if (node.height <= 1) {
          let maxBottom = 0;
          for (const child of activeChildren) maxBottom = Math.max(maxBottom, child.y + child.height);
          node.height = Math.round(Math.max(1, maxBottom) * 100) / 100;
        }
      }
      // 仅当 CSF 实际改变了宽高时，才修正位置（pivot 偏移）
      const pivot = node.pivot || { x: 0.5, y: 0.5 };
      if (node.width !== oldW && node.width > 0) {
        node.x = round2(node.x + (oldW - node.width) * pivot.x);
      }
      if (node.height !== oldH && node.height > 0) {
        node.y = round2(node.y + (oldH - node.height) * (1 - pivot.y));
      }
      if ((node.width !== oldW || node.height !== oldH) && node.children?.length) {
        resolveClonedChildRects(node.children, node.width, node.height);
      }
    }

    delete (node as any)._contentSizeFitter;
    delete (node as any)._layoutGroup;
  }

  // ===== 后处理：preserveAspect 且 size=0 的 Image 用 sprite 原始尺寸 =====
  function fixZeroSizeImages(node: TemplateNode) {
    if ((node.width < 1 || node.height < 1) && node.preserveAspect && node.imagePath) {
      const size = estimatePreferredSize(node);
      if (size.w > 0 && size.h > 0) {
        node.width = size.w;
        node.height = size.h;
      }
    }
    for (const child of node.children) fixZeroSizeImages(child);
  }
  if (root) fixZeroSizeImages(root);

  if (root) postProcessLayout(root);

  return root;
}

export function prefabServerPlugin(): Plugin {
  return {
    name: 'prefab-server',
    configureServer(server) {

      // 组件截图：禁用缓存，Unity 更新后立即生效
      server.middlewares.use('/components', (_req, res, next) => {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        next();
      });

      // 服务器启动时预构建缓存，避免首次请求阻塞
      console.log('[prefabServer] 预构建资源缓存...');
      const cacheStart = Date.now();
      buildCaches();
      console.log(`[prefabServer] 缓存构建完成，耗时 ${Date.now() - cacheStart}ms`);

      // 递归扫描目录下所有 .prefab 文件（排除 CommonPart）
      function scanPrefabFiles(dir: string, relDir: string = ''): { name: string; file: string; category: string; relPath: string }[] {
        const results: { name: string; file: string; category: string; relPath: string }[] = [];
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory()) {
              if (EXCLUDE_DIRS.has(entry.name)) continue;
              const subRel = relDir ? `${relDir}/${entry.name}` : entry.name;
              results.push(...scanPrefabFiles(path.join(dir, entry.name), subRel));
            } else if (entry.name.endsWith('.prefab')) {
              const prefabName = entry.name.replace('.prefab', '');
              const category = relDir.split('/')[0] || 'Root';
              results.push({
                name: prefabName,
                file: entry.name,
                category,
                relPath: relDir ? `${relDir}/${entry.name}` : entry.name,
              });
            }
          }
        } catch {}
        return results;
      }

      // 扫描每个 category 下的 textures 目录
      function scanCategoryTextures(): Record<string, { name: string; url: string }[]> {
        const result: Record<string, { name: string; url: string }[]> = {};
        try {
          const entries = fs.readdirSync(UI_PREFAB_ROOT, { withFileTypes: true });
          for (const entry of entries) {
            if (!entry.isDirectory() || EXCLUDE_DIRS.has(entry.name)) continue;
            const texDir = path.join(UI_PREFAB_ROOT, entry.name, 'textures');
            if (!fs.existsSync(texDir)) continue;
            const imgs: { name: string; url: string }[] = [];
            for (const f of fs.readdirSync(texDir)) {
              if (/\.(png|jpg|jpeg)$/i.test(f)) {
                imgs.push({ name: f, url: `/prefab-texture/${entry.name}/textures/${f}` });
              }
            }
            if (imgs.length > 0) result[entry.name] = imgs;
          }
        } catch {}
        return result;
      }

      function classifyComponent(name: string): string {
        const lower = name.toLowerCase();
        if (lower.includes('btn') || lower.includes('button')) return '按钮';
        if (lower.includes('tab')) return '页签';
        if (lower.includes('item') || lower.includes('prop') || lower.includes('reward')) return '物品';
        if (lower.includes('alert') || lower.includes('panel') || lower.includes('pop')) return '弹窗';
        if (lower.includes('list') || lower.includes('scroll')) return '列表';
        if (lower.includes('text') || lower.includes('title')) return '文本';
        return '通用';
      }

      function commonPartRelPath(fileName: string): string {
        const normalizedPrefabRoot = ASSET_PATHS.prefab.replace(/\\/g, '/');
        const normalizedCommonPart = ASSET_PATHS.commonPart.replace(/\\/g, '/');
        const commonRel = normalizedCommonPart.startsWith(normalizedPrefabRoot + '/')
          ? normalizedCommonPart.slice(normalizedPrefabRoot.length + 1)
          : path.basename(COMMON_PART_DIR);
        return `${commonRel}/${fileName}`.replace(/\\/g, '/');
      }

      function scanCommonComponents(): { name: string; displayName: string; category: string; thumbnail: string; defaultWidth: number; defaultHeight: number; relPath: string }[] {
        const result: { name: string; displayName: string; category: string; thumbnail: string; defaultWidth: number; defaultHeight: number; relPath: string }[] = [];
        try {
          const files = fs.readdirSync(COMMON_PART_DIR)
            .filter((f) => f.endsWith('.prefab'))
            .sort((a, b) => a.localeCompare(b));

          for (const file of files) {
            const name = file.replace(/\.prefab$/i, '');
            const relPath = commonPartRelPath(file);
            let defaultWidth = 120;
            let defaultHeight = 60;

            try {
              resetPrefabParserState();
              const content = fs.readFileSync(path.join(COMMON_PART_DIR, file), 'utf-8');
              const root = buildNodeTree(parsePrefabYaml(content), content);
              if (root?.width && root.width > 0) defaultWidth = Math.round(root.width);
              if (root?.height && root.height > 0) defaultHeight = Math.round(root.height);
            } catch {}

            result.push({
              name,
              displayName: name,
              category: classifyComponent(name),
              thumbnail: `/api/prefabs/thumbnail?path=${encodeURIComponent(relPath)}`,
              defaultWidth,
              defaultHeight,
              relPath,
            });
          }
        } catch {}
        return result;
      }

      // GET /api/prefabs/list — 返回所有 UI 预制体列表（按目录分类，排除 CommonPart）
      server.middlewares.use('/api/prefabs/list', (_req, res) => {
        try {
          const files = scanPrefabFiles(UI_PREFAB_ROOT);
          const textures = scanCategoryTextures();
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ prefabs: files, textures }));
        } catch (e: any) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: e.message }));
        }
      });

      // GET /api/components/list — 当前项目公共组件候选（Dreamland: UICommons）
      server.middlewares.use('/api/components/list', (_req, res) => {
        try {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ components: scanCommonComponents(), commonPart: ASSET_PATHS.commonPart }));
        } catch (e: any) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: e.message }));
        }
      });

      // GET /api/prefabs/parse?name=xxx&path=Category/xxx.prefab — 实时解析 prefab 返回节点树
      server.middlewares.use('/api/prefabs/parse', (req, res) => {
        try {
          const url = new URL(req.url!, `http://${req.headers.host}`);
          const relPath = url.searchParams.get('path') || '';
          const name = url.searchParams.get('name') || '';

          // 优先用 relPath（含子目录），fallback 按 name 搜索
          let prefabPath = '';
          if (relPath) {
            prefabPath = path.join(UI_PREFAB_ROOT, relPath);
          } else if (name) {
            // 向下兼容：在所有子目录中查找
            const allFiles = scanPrefabFiles(UI_PREFAB_ROOT);
            const found = allFiles.find((f) => f.name === name);
            if (found) prefabPath = path.join(UI_PREFAB_ROOT, found.relPath);
          }

          if (!prefabPath || !fs.existsSync(prefabPath)) {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: 'Prefab not found' }));
            return;
          }

          // 每次解析前清除 CommonPart 递归状态
          _globalPartCache.clear();
          _globalNestDepth = 0;
          _parsingParts.clear();

          const content = fs.readFileSync(prefabPath, 'utf-8');
          const objects = parsePrefabYaml(content);
          const root = buildNodeTree(objects, content);

          // 计算相对 Assets 路径
          const assetsRel = prefabPath.replace(/\\/g, '/').replace(PROJECT_ROOT.replace(/\\/g, '/') + '/', '');

          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            name: name || path.basename(prefabPath, '.prefab'),
            sourcePath: assetsRel,
            root,
          }));
        } catch (e: any) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: e.message }));
        }
      });

      // 静态文件服务：/prefab-texture/... → UI_PREFAB_ROOT/...
      server.middlewares.use('/prefab-texture', (req, res) => {
        try {
          const filePath = path.join(UI_PREFAB_ROOT, decodeURIComponent(req.url || ''));
          if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
            const ext = path.extname(filePath).toLowerCase();
            const mimeTypes: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
            res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
            res.setHeader('Cache-Control', 'public, max-age=86400');
            fs.createReadStream(filePath).pipe(res);
          } else { res.statusCode = 404; res.end('Not found'); }
        } catch (e: any) { res.statusCode = 500; res.end(e.message); }
      });

      // GET /api/prefabs/thumbnail?path=xxx — 读取磁盘缓存的缩略图
      // POST /api/prefabs/thumbnail?path=xxx — 前端 Unity 截图后上传保存
      const THUMB_DIR = path.join(process.cwd(), '.cache', 'thumbnails');
      if (!fs.existsSync(THUMB_DIR)) fs.mkdirSync(THUMB_DIR, { recursive: true });

      function thumbFilePath(relPath: string, variant: string): string {
        const safeVariant = variant && variant !== 'canvas' ? `${variant.replace(/[^\w-]/g, '_')}__` : '';
        return path.join(THUMB_DIR, safeVariant + relPath.replace(/[\\/]/g, '__').replace('.prefab', '') + '.jpg');
      }
      function isPrefabNewer(relPath: string, thumbPath: string): boolean {
        try {
          const prefabMtime = fs.statSync(path.join(UI_PREFAB_ROOT, relPath)).mtimeMs;
          const thumbMtime = fs.statSync(thumbPath).mtimeMs;
          return prefabMtime > thumbMtime;
        } catch { return true; }
      }

      server.middlewares.use('/api/prefabs/thumbnail', async (req, res) => {
        if (req.method === 'DELETE') {
          try {
            const files = fs.readdirSync(THUMB_DIR);
            let count = 0;
            for (const f of files) {
              if (f.endsWith('.jpg')) {
                fs.unlinkSync(path.join(THUMB_DIR, f));
                count++;
              }
            }
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ deleted: count }));
          } catch (e: any) {
            res.statusCode = 500;
            res.end(e.message);
          }
          return;
        }

        const url = new URL(req.url!, `http://${req.headers.host}`);
        const relPath = url.searchParams.get('path') || '';
        const variant = url.searchParams.get('variant') || 'canvas';
        if (!relPath) { res.statusCode = 400; res.end(); return; }

        const file = thumbFilePath(relPath, variant);

        if (req.method === 'GET') {
          if (fs.existsSync(file) && !isPrefabNewer(relPath, file)) {
            res.setHeader('Content-Type', 'image/jpeg');
            res.setHeader('Cache-Control', 'public, max-age=86400');
            res.end(fs.readFileSync(file));
          } else {
            res.statusCode = 404;
            res.end();
          }
          return;
        }

        if (req.method === 'POST') {
          const chunks: Buffer[] = [];
          req.on('data', (c: Buffer) => chunks.push(c));
          req.on('end', () => {
            try {
              const body = Buffer.concat(chunks).toString();
              const base64 = body.replace(/^data:image\/\w+;base64,/, '');
              fs.writeFileSync(file, Buffer.from(base64, 'base64'));
              res.statusCode = 200;
              res.end('ok');
            } catch (e: any) {
              res.statusCode = 500;
              res.end(e.message);
            }
          });
          return;
        }

        res.statusCode = 405;
        res.end();
      });
    },
  };
}

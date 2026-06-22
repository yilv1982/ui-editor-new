import type { UINode, ExportNode, ExportDocument } from '../types';
import { ASSET_PATHS, DESIGN_WIDTH, DESIGN_HEIGHT } from '../config/assetPaths';

interface BuildExportOptions {
  skipInactive?: boolean;
  previewMode?: boolean;
  canvasWidth?: number;
  canvasHeight?: number;
}

interface PageExportOptions {
  canvasWidth?: number;
  canvasHeight?: number;
}

function resolveImagePath(imageData: string, previewMode = false): string | undefined {
  if (previewMode) {
    if (
      imageData.startsWith('/atlas-file/') ||
      imageData.startsWith('/texture-file/') ||
      imageData.startsWith('/_temp_images/') ||
      imageData.startsWith('/components/') ||
      imageData.startsWith('/prefab-texture/')
    ) {
      return imageData;
    }
    if (imageData.startsWith(ASSET_PATHS.atlas + '/')) {
      return `/atlas-file/${imageData.replace(ASSET_PATHS.atlas + '/', '')}`;
    }
    if (imageData.startsWith(ASSET_PATHS.texture + '/')) {
      return `/texture-file/${imageData.replace(ASSET_PATHS.texture + '/', '')}`;
    }
    if (imageData.startsWith(ASSET_PATHS.prefab + '/')) {
      return `/prefab-texture/${imageData.replace(ASSET_PATHS.prefab + '/', '')}`;
    }
  }

  if (imageData.startsWith('/atlas-file/')) {
    return ASSET_PATHS.atlas + '/' + imageData.replace('/atlas-file/', '');
  }
  if (imageData.startsWith('/texture-file/')) {
    return ASSET_PATHS.texture + '/' + imageData.replace('/texture-file/', '');
  }
  if (imageData.startsWith('Assets/')) {
    return imageData;
  }
  if (imageData.startsWith('/_temp_images/') || imageData.startsWith('/components/') || imageData.startsWith('/prefab-texture/')) {
    return imageData;
  }
  return undefined;
}

// 将编辑器坐标（左上角原点，Y朝下）转换为 Unity anchoredPosition + sizeDelta
function computeUnityTransform(
  node: UINode,
  parentW: number,
  parentH: number
): { anchoredPosition: { x: number; y: number }; sizeDelta: { x: number; y: number } } {
  const aMin = node.anchorMin || { x: 0.5, y: 0.5 };
  const aMax = node.anchorMax || { x: 0.5, y: 0.5 };
  const pivot = node.pivot || { x: 0.5, y: 0.5 };
  const w = node.width;
  const h = node.height;

  let apX: number, apY: number, sdX: number, sdY: number;

  const stretchX = Math.abs(aMax.x - aMin.x) > 0.001;
  const stretchY = Math.abs(aMax.y - aMin.y) > 0.001;

  if (stretchX) {
    sdX = w - parentW * (aMax.x - aMin.x);
    const offsetMinX = node.x - parentW * aMin.x;
    apX = offsetMinX + sdX * pivot.x;
  } else {
    sdX = w;
    apX = node.x - aMin.x * parentW + pivot.x * w;
  }

  if (stretchY) {
    sdY = h - parentH * (aMax.y - aMin.y);
    const bottomEdge = parentH - node.y - h;
    const offsetMinY = bottomEdge - parentH * aMin.y;
    apY = offsetMinY + sdY * pivot.y;
  } else {
    sdY = h;
    apY = parentH - node.y - (1 - pivot.y) * h - aMin.y * parentH;
  }

  return {
    anchoredPosition: { x: Math.round(apX * 100) / 100, y: Math.round(apY * 100) / 100 },
    sizeDelta: { x: Math.round(sdX * 100) / 100, y: Math.round(sdY * 100) / 100 },
  };
}

function uiShadowOffsets(effect: UINode['textOutline'] | UINode['textShadow']): Array<[number, number]> {
  if (!effect || effect.source !== 'UIShadow') return [];
  const [x = 1, y = -1] = effect.distance || [1, -1];
  switch (effect.style) {
    case 1:
      return [[x, y]];
    case 2:
      return [[x, y], [x, -y], [-x, y], [-x, -y]];
    case 3:
      return [[x, y], [x, -y], [-x, y], [-x, -y], [-x, 0], [0, -y], [x, 0], [0, y]];
    case 4:
      return [[x, y], [x, 0], [0, y]];
    default:
      return [];
  }
}

function buildPreviewTextEffectCopies(node: Record<string, unknown>, parentId: string, childIndex: number): Record<string, unknown>[] {
  if (node.type !== 'text') return [];

  const specs = [
    { effect: node.textShadow as UINode['textShadow'], offsets: uiShadowOffsets(node.textShadow as UINode['textShadow']) },
    { effect: node.textOutline as UINode['textOutline'], offsets: uiShadowOffsets(node.textOutline as UINode['textOutline']) },
  ].filter((spec) => spec.effect && spec.offsets.length > 0);
  if (specs.length === 0) return [];

  const baseStyle = (node.style && typeof node.style === 'object') ? node.style as Record<string, unknown> : {};
  const anchored = (node.anchoredPosition && typeof node.anchoredPosition === 'object')
    ? node.anchoredPosition as { x?: number; y?: number }
    : null;
  const x = Number(node.x ?? 0);
  const y = Number(node.y ?? 0);
  const id = String(node.id ?? node.editorId ?? node.name ?? 'text');

  const copies: Record<string, unknown>[] = [];
  for (const spec of specs) {
    const effect = spec.effect!;
    for (const [dx, dy] of spec.offsets) {
      const copy: Record<string, unknown> = {
        ...node,
        id: `${id}__uishadow_${copies.length}`,
        editorId: `${id}__uishadow_${copies.length}`,
        name: `${String(node.name ?? 'Text')}__uishadow_${copies.length}`,
        unityFileId: undefined,
        x: Math.round((x + dx) * 100) / 100,
        y: Math.round((y - dy) * 100) / 100,
        style: { ...baseStyle, fontColor: effect.color },
        textOutline: undefined,
        textShadow: undefined,
        textGradient: undefined,
        raycastTarget: false,
        parentId,
        childIndex: childIndex + copies.length,
      };
      if (anchored) {
        copy.anchoredPosition = {
          x: Math.round(((anchored.x ?? 0) + dx) * 100) / 100,
          y: Math.round(((anchored.y ?? 0) + dy) * 100) / 100,
        };
      }
      copies.push(copy);
    }
  }
  // UIShadow inserts each generated shadow batch before the original vertices.
  // Multiple batches therefore render in reverse call order, with the real text on top.
  return copies.reverse().map((copy, index) => ({
    ...copy,
    childIndex: childIndex + index,
  }));
}

export function buildExportTree(
  nodeId: string,
  nodes: Record<string, UINode>,
  parentW: number,
  parentH: number,
  parentHasLayoutGroup = false,
  parentUsesThumbnail = false,
  parentLayoutBaked = false,
  options: BuildExportOptions = {},
  previewParentScaleX = 1,
  previewParentScaleY = 1,
): ExportNode | null {
  const node = nodes[nodeId];
  if (!node) return null;
  if (options.skipInactive && node.visible === false) return null;

  // 父级 component 走了缩略图 fallback (整体效果图已包含内部) — 跳过 prefab 自动解析出的子节点,避免叠加。
  // 用户手动添加的子节点(无 unityFileId)正常导出。
  // 父 component 用的是 prefab root image(局部图,非整体)时不在此跳过,子节点照常渲染。
  if (parentUsesThumbnail && node.unityFileId) return null;

  // 当前节点是否会走缩略图 fallback (没设 imageData 且不在另一个 component 内)
  const willUseThumbnail = node.type === 'component' && !!node.componentRef && !node.imageData && !parentUsesThumbnail;

  const hasDirectLayoutElementChild = node.children.some((childId) => !!nodes[childId]?.layoutElement);
  const suppressPreviewLayoutGroup = !!(options.previewMode && node.layoutGroup?.enabled && hasDirectLayoutElementChild);
  const thisHasLayoutGroup = !!(node.layoutGroup?.enabled && !suppressPreviewLayoutGroup);

  const pivot = node.pivot || { x: 0.5, y: 0.5 };
  const previewScale = options.previewMode ? (node.localScale || { x: 1, y: 1, z: 1 }) : { x: 1, y: 1, z: 1 };
  const scaledX = options.previewMode ? node.x * previewParentScaleX : node.x;
  const scaledY = options.previewMode ? node.y * previewParentScaleY : node.y;
  const scaledW = options.previewMode ? node.width * previewParentScaleX : node.width;
  const scaledH = options.previewMode ? node.height * previewParentScaleY : node.height;
  const effectiveX = options.previewMode
    ? scaledX + pivot.x * scaledW * (1 - (previewScale.x ?? 1))
    : node.x;
  const effectiveY = options.previewMode
    ? scaledY + (1 - pivot.y) * scaledH * (1 - (previewScale.y ?? 1))
    : node.y;
  const effectiveW = options.previewMode ? scaledW * (previewScale.x ?? 1) : node.width;
  const effectiveH = options.previewMode ? scaledH * (previewScale.y ?? 1) : node.height;

  const children: ExportNode[] = [];
  for (const childId of node.children) {
    const child = buildExportTree(
      childId,
      nodes,
      effectiveW,
      effectiveH,
      thisHasLayoutGroup,
      willUseThumbnail,
      suppressPreviewLayoutGroup,
      options,
      options.previewMode ? previewParentScaleX * (previewScale.x ?? 1) : 1,
      options.previewMode ? previewParentScaleY * (previewScale.y ?? 1) : 1,
    );
    if (child) children.push(child);
  }

  const layoutNode = options.previewMode
    ? {
        ...node,
        x: effectiveX,
        y: effectiveY,
        width: effectiveW,
        height: effectiveH,
      }
    : node;
  const unity = computeUnityTransform(layoutNode, parentW, parentH);
  const exportType = options.previewMode && node.type === 'scrollview' && !!node.imageData
    ? 'image'
    : node.type;

  const exportNode: ExportNode = {
    id: nodeId,
    name: node.name.replace(/^@/, ''),
    type: exportType,
    x: Math.round(effectiveX * 100) / 100,
    y: Math.round(effectiveY * 100) / 100,
    width: Math.round(effectiveW * 100) / 100,
    height: Math.round(effectiveH * 100) / 100,
    rotation: node.rotation,
    style: { ...node.style },
    children,
  };

  if (node.visible === false) exportNode.active = false;
  if (!options.previewMode && node.localScale && (
    Math.abs(node.localScale.x - 1) > 0.0001 ||
    Math.abs(node.localScale.y - 1) > 0.0001 ||
    Math.abs((node.localScale.z ?? 1) - 1) > 0.0001
  )) {
    exportNode.localScale = {
      x: Math.round(node.localScale.x * 10000) / 10000,
      y: Math.round(node.localScale.y * 10000) / 10000,
      z: Math.round((node.localScale.z ?? 1) * 10000) / 10000,
    };
  }

  if (node.componentRef) exportNode.componentRef = node.componentRef;
  if (node.text !== undefined) exportNode.text = node.text;
  if (node.sliceEnabled && node.sliceBorder) exportNode.sliceBorder = node.sliceBorder;
  if (node.unityFileId) exportNode.unityFileId = node.unityFileId;
  exportNode.editorId = node.id;

  // Button 是否有 Image 组件（显式标记优先，未标记时从 imageData 推断）
  const btnHasImg = node.type !== 'button' || node.hasImage === true || (node.hasImage === undefined && !!node.imageData);
  if (node.type === 'button' && !btnHasImg) exportNode.hasImage = false;

  // 图片资源路径（button无Image时跳过）
  if (node.imageData && btnHasImg) {
    exportNode.imagePath = resolveImagePath(node.imageData, options.previewMode);
  }
  // 组件类型：用缩略图作为图片路径
  // 父级 component 已经走了缩略图 fallback 时,子级 component 不再 fallback —
  // 父级整体缩略图已经包含了内部视觉,内层再贴一遍会叠加(如 Part_UserHead_CityLv 内嵌 Part_UserHead)
  if (node.type === 'component' && node.componentRef && !exportNode.imagePath && !parentUsesThumbnail) {
    exportNode.imagePath = `/components/@${node.componentRef}.png`;
  }

  // Unity RectTransform 锚点
  if (parentHasLayoutGroup) {
    // LayoutGroup 子节点：左上角锚点，让 LayoutGroup 接管定位
    exportNode.anchorMin = { x: 0, y: 1 };
    exportNode.anchorMax = { x: 0, y: 1 };
    exportNode.pivot = pivot;
    exportNode.sizeDelta = { x: Math.round(effectiveW * 100) / 100, y: Math.round(effectiveH * 100) / 100 };
    // 不导出 anchoredPosition，由 LayoutGroup 计算
  } else {
    exportNode.anchorMin = node.anchorMin || { x: 0.5, y: 0.5 };
    exportNode.anchorMax = node.anchorMax || { x: 0.5, y: 0.5 };
    exportNode.pivot = pivot;
    // LayoutGroup 被烘焙成静态坐标时，子节点必须使用解析后的 x/y/width/height，
    // 不能再回退到 prefab 里 LayoutGroup 接管前的原始 RectTransform。
    exportNode.anchoredPosition = options.previewMode || parentLayoutBaked ? unity.anchoredPosition : (node.originalAnchoredPosition || unity.anchoredPosition);
    exportNode.sizeDelta = options.previewMode || parentLayoutBaked ? unity.sizeDelta : (node.originalSizeDelta || unity.sizeDelta);
  }

  // Unity Text 完整属性
  if (node.fontPath) exportNode.fontPath = node.fontPath;
  if (node.fontStyle) exportNode.fontStyle = node.fontStyle;
  if (node.alignment !== undefined) exportNode.alignment = node.alignment;
  if (node.richText !== undefined) exportNode.richText = node.richText;
  if (node.horizontalOverflow !== undefined) exportNode.horizontalOverflow = node.horizontalOverflow;
  if (node.verticalOverflow !== undefined) exportNode.verticalOverflow = node.verticalOverflow;
  if (node.lineSpacing !== undefined && node.lineSpacing !== 1) exportNode.lineSpacing = node.lineSpacing;
  if (node.bestFit) { exportNode.bestFit = true; exportNode.bestFitMinSize = node.bestFitMinSize; exportNode.bestFitMaxSize = node.bestFitMaxSize; }
  if (node.raycastTarget === false) exportNode.raycastTarget = false;
  if (node.textOutline) exportNode.textOutline = node.textOutline;
  if (node.textShadow) exportNode.textShadow = node.textShadow;
  if (node.textGradient) exportNode.textGradient = node.textGradient;

  // Unity Image 完整属性（button无Image时跳过）
  if (btnHasImg) {
    // 始终导出 imageType，避免 Unity 侧因缺失字段产生歧义
    const effectiveImageType = node.imageType || (node.sliceEnabled ? 'Sliced' : 'Simple');
    exportNode.imageType = effectiveImageType;
    if (node.imageColor && node.imageColor !== '#ffffff') exportNode.imageColor = node.imageColor;
    if (options.previewMode && node.isMask && node.maskShowGraphic === false) {
      exportNode.imageColor = '#ffffff00';
    }
    if (node.fillCenter === false) exportNode.fillCenter = false;
    if (node.fillMethod !== undefined) exportNode.fillMethod = node.fillMethod;
    if (node.fillAmount !== undefined && node.fillAmount !== 1) exportNode.fillAmount = node.fillAmount;
    if (node.fillClockwise === false) exportNode.fillClockwise = false;
    if (node.fillOrigin) exportNode.fillOrigin = node.fillOrigin;
    if (node.preserveAspect) exportNode.preserveAspect = true;
    // 组件走缩略图 fallback 时自动保持比例,避免被 component 的 width/height 拉伸变形
    else if (willUseThumbnail) exportNode.preserveAspect = true;
    if (node.useSpriteMesh) exportNode.useSpriteMesh = true;
    if (node.imageRaycastTarget === false) exportNode.imageRaycastTarget = false;
    if (node.imageEnabled === false) exportNode.imageEnabled = false;
    if (node.mirrorType) exportNode.mirrorType = node.mirrorType;
  }

  // Outline 组件
  if (node.outline) exportNode.outline = node.outline;

  // Unity Button
  if (node.interactable !== undefined) exportNode.interactable = node.interactable;
  if (node.buttonTransition !== undefined) exportNode.buttonTransition = node.buttonTransition;
  if (node.buttonColors) exportNode.buttonColors = node.buttonColors;

  // Mask / ScrollView / Toggle
  if (node.isMask) {
    exportNode.isMask = true;
    exportNode.maskType = options.previewMode && node.maskType === 'Mask' ? 'RectMask2D' : node.maskType;
    if (node.maskShowGraphic === false) exportNode.maskShowGraphic = false;
  }
  if (node.scrollDirection) exportNode.scrollDirection = node.scrollDirection;
  else if (node.type === 'scrollview') exportNode.scrollDirection = 'vertical';
  if (node.isOn !== undefined) exportNode.isOn = node.isOn;

  // LayoutElement / LayoutGroup / ContentSizeFitter（添加 _exists 标记供 Unity JsonUtility 区分默认值）
  if (node.layoutElement) exportNode.layoutElement = { ...node.layoutElement, _exists: true } as any;
  if (node.layoutGroup && !suppressPreviewLayoutGroup) exportNode.layoutGroup = { ...node.layoutGroup, _exists: true } as any;
  if (node.contentSizeFitter) exportNode.contentSizeFitter = { ...node.contentSizeFitter, _exists: true } as any;

  return exportNode;
}

export function exportToJson(
  nodes: Record<string, UINode>,
  rootIds: string[],
  documentName: string = 'Untitled',
  sourcePrefabPath?: string,
  options: BuildExportOptions = {},
): string {
  const canvasWidth = options.canvasWidth ?? DESIGN_WIDTH;
  const canvasHeight = options.canvasHeight ?? DESIGN_HEIGHT;
  const rootChildren: ExportNode[] = [];
  for (const id of rootIds) {
    const child = buildExportTree(id, nodes, canvasWidth, canvasHeight, false, false, false, options);
    if (child) rootChildren.push(child);
  }

  const doc: ExportDocument = {
    version: '1.0.0',
    name: documentName,
    canvasWidth,
    canvasHeight,
    sourcePrefabPath,
    root: {
      name: documentName,
      type: 'frame',
      x: 0,
      y: 0,
      width: canvasWidth,
      height: canvasHeight,
      rotation: 0,
      style: {},
      children: rootChildren,
    },
  };

  return JSON.stringify(doc, null, 2);
}

/**
 * 将嵌套树形 JSON 扁平化，避免 Unity JsonUtility 序列化深度限制（10层）
 */
export function flattenForUnity(nestedJson: string): string {
  const doc = JSON.parse(nestedJson);
  const nodes: Record<string, unknown>[] = [];

  function walk(node: Record<string, unknown>, parentId: string, childIndex: number) {
    const { children, ...rest } = node;
    nodes.push({ ...rest, parentId, childIndex });
    if (Array.isArray(children)) {
      (children as Record<string, unknown>[]).forEach((child, i) =>
        walk(child, (node.id as string) || '', i)
      );
    }
  }

  const root = doc.root;
  if (root?.children) {
    (root.children as Record<string, unknown>[]).forEach((child: Record<string, unknown>, i: number) =>
      walk(child, '', i)
    );
  }

  return JSON.stringify({
    version: doc.version,
    name: doc.name,
    canvasWidth: doc.canvasWidth,
    canvasHeight: doc.canvasHeight,
    nodes,
  });
}

/**
 * 多画板导出（用于 StoreSync 把当前 page 的所有画板发给 Unity 渲染）
 *
 * 输出结构（Unity 端接收）：
 * {
 *   version: '1.1.0',
 *   name: <page name>,
 *   canvasWidth, canvasHeight,  // 兼容字段，沿用 DESIGN_WIDTH/HEIGHT
 *   artboards: [{ id, name, x, y, width, height }],
 *   nodes: [{ id, artboardId, parentId, childIndex, ... }]  // 已扁平化
 * }
 *
 * 节点的 x/y 仍然是相对于其所属画板左上角的本地坐标。
 * Unity 端按 artboard.x/y 创建容器并把节点挂在对应容器下。
 */
export function exportPageForUnity(page: import('../types').PageData, options: PageExportOptions = {}): string {
  const canvasWidth = options.canvasWidth ?? DESIGN_WIDTH;
  const canvasHeight = options.canvasHeight ?? DESIGN_HEIGHT;
  const artboards: Array<{ id: string; name: string; x: number; y: number; width: number; height: number }> = [];
  const allFlatNodes: Record<string, unknown>[] = [];

  for (const artboard of page.artboards) {
    artboards.push({
      id: artboard.id,
      name: artboard.name,
      x: artboard.x,
      y: artboard.y,
      width: canvasWidth,
      height: canvasHeight,
    });

    // 为每个画板，先用单 prefab 路径构建嵌套树，再扁平化
    const rootChildren: ExportNode[] = [];
    for (const id of artboard.rootIds) {
      const child = buildExportTree(id, artboard.nodes, canvasWidth, canvasHeight, false, false, false, {
        skipInactive: true,
        previewMode: true,
      });
      if (child) rootChildren.push(child);
    }

    // 扁平化 + 注入 artboardId
    function walk(node: Record<string, unknown>, parentId: string, childIndex: number) {
      const { children, ...rest } = node;
      const effectCopies = buildPreviewTextEffectCopies(rest, parentId, childIndex);
      for (const copy of effectCopies) {
        allFlatNodes.push({ ...copy, artboardId: artboard.id });
      }
      allFlatNodes.push({ ...rest, parentId, childIndex: childIndex + effectCopies.length, artboardId: artboard.id });
      if (Array.isArray(children)) {
        (children as Record<string, unknown>[]).forEach((child, i) =>
          walk(child, (node.id as string) || '', i * 32)
        );
      }
    }
    for (let i = 0; i < rootChildren.length; i++) {
      walk(rootChildren[i] as unknown as Record<string, unknown>, '', i * 32);
    }
  }

  return JSON.stringify({
    version: '1.1.0',
    name: page.name,
    canvasWidth,
    canvasHeight,
    artboards,
    nodes: allFlatNodes,
  });
}

export async function downloadJson(json: string, filename: string = 'ui-layout.json') {
  // 优先使用 File System Access API，弹出系统"另存为"对话框让用户选路径
  if ('showSaveFilePicker' in window) {
    try {
      const handle = await (window as any).showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(json);
      await writable.close();
      return;
    } catch (e: any) {
      // 用户取消选择
      if (e?.name === 'AbortError') return;
    }
  }
  // 降级：直接下载到浏览器默认目录
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * 增量同步用：导出单个节点为 Unity SyncNode JSON 字符串。
 *
 * Schema 与 exportPageForUnity 输出的 nodes[] 元素完全一致：
 *   - 顶层是单个 ExportNode（同时含 parentId / childIndex / artboardId 扁平化字段）
 *   - children 字段不输出（增量只更新此节点本身，子节点由 Unity 端保留原样）
 *
 * 注意：增量同步不改变父子关系，Unity 的 UpdateSingleNode 不会用 parentId/childIndex 重排，
 * 但保留这些字段是为了 schema 一致（Unity 端 SyncNode 反序列化时这些字段会被读取但不一定使用）。
 *
 * @returns JSON 字符串；如果节点不存在返回 null
 */
export function exportSingleNodeForUnity(
  nodeId: string,
  nodes: Record<string, UINode>,
  artboardId: string,
  artboardW: number,
  artboardH: number,
): string | null {
  const node = nodes[nodeId];
  if (!node) return null;

  // 父容器尺寸：根节点用 artboard，否则用 parent 的尺寸
  const parent = node.parentId ? nodes[node.parentId] : null;
  const parentW = parent ? parent.width : artboardW;
  const parentH = parent ? parent.height : artboardH;

  const parentUsesThumbnail = parent?.type === 'component' && !!parent.componentRef && !parent.imageData;
  const exportNode = buildExportTree(nodeId, nodes, parentW, parentH, false, parentUsesThumbnail, false);
  if (!exportNode) return null;

  // 计算 childIndex（在父 children 数组中的位置；根节点用 0 即可，Unity 不重排）
  let childIndex = 0;
  if (parent) {
    childIndex = parent.children.indexOf(nodeId);
    if (childIndex < 0) childIndex = 0;
  }

  // 去掉递归的 children 字段，只发自己 + 扁平化补充字段
  const cloned: Record<string, unknown> = { ...(exportNode as unknown as Record<string, unknown>) };
  delete cloned.children;

  return JSON.stringify({
    ...cloned,
    parentId: node.parentId || '',
    childIndex,
    artboardId,
  });
}

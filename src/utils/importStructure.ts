import { useEditorStore } from '../stores/editorStore';
import { defaultStyle } from '../types';
import type { UINode } from '../types';
import { ASSET_PATHS } from '../config/assetPaths';

/**
 * 根据节点在父容器中的位置和大小，推断合适的 Unity Anchor 预设。
 * 阈值 t 表示"接近边缘"的比例容差（默认 15%）。
 */
function inferAnchor(
  nodeX: number, nodeY: number, nodeW: number, nodeH: number,
  parentW: number, parentH: number, t = 0.15,
): { anchorMin: { x: number; y: number }; anchorMax: { x: number; y: number } } {
  // 节点中心占父容器的比例
  const cx = parentW > 0 ? (nodeX + nodeW / 2) / parentW : 0.5;
  const cy = parentH > 0 ? (nodeY + nodeH / 2) / parentH : 0.5;
  // 节点相对父容器的宽高占比
  const rw = parentW > 0 ? nodeW / parentW : 0;
  const rh = parentH > 0 ? nodeH / parentH : 0;

  // 水平方向锚点
  let ax: number;
  let stretchX = false;
  if (rw > 0.85) {
    stretchX = true; ax = 0;        // 几乎撑满 → 水平拉伸
  } else if (cx < t) {
    ax = 0;                          // 靠左
  } else if (cx > 1 - t) {
    ax = 1;                          // 靠右
  } else {
    ax = 0.5;                        // 居中
  }

  // 垂直方向锚点（Unity Y 轴向上，编辑器 Y 轴向下）
  let ay: number;
  let stretchY = false;
  if (rh > 0.85) {
    stretchY = true; ay = 0;        // 几乎撑满 → 垂直拉伸
  } else if (cy < t) {
    ay = 1;                          // 靠上（Unity Y=1 为顶部）
  } else if (cy > 1 - t) {
    ay = 0;                          // 靠下
  } else {
    ay = 0.5;                        // 居中
  }

  return {
    anchorMin: { x: stretchX ? 0 : ax, y: stretchY ? 0 : ay },
    anchorMax: { x: stretchX ? 1 : ax, y: stretchY ? 1 : ay },
  };
}

// 将 ExportNode 的 imagePath (Unity 资源路径) 转换为内部 imageData 路径
export function convertImagePath(imagePath?: string): string | undefined {
  if (!imagePath) return undefined;
  if (imagePath.startsWith('/atlas-file/') || imagePath.startsWith('/texture-file/')) return imagePath;
  if (imagePath.startsWith(ASSET_PATHS.atlas + '/')) return '/atlas-file/' + imagePath.replace(ASSET_PATHS.atlas + '/', '');
  if (imagePath.startsWith(ASSET_PATHS.texture + '/')) return '/texture-file/' + imagePath.replace(ASSET_PATHS.texture + '/', '');
  return imagePath;
}

// 结构 JSON 节点格式
export interface StructNode {
  name: string;
  type?: string;        // frame/text/image/button/scrollview/component 等
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  componentRef?: string; // @Part_XXX
  text?: string;
  imagePath?: string;    // /atlas-file/xxx 或 /texture-file/xxx
  imageColor?: string;   // 图片着色 #RRGGBB
  children?: StructNode[];
}

// 收集所有带 imagePath 的节点 ID，导入后批量查询九宫格
export const pendingSliceNodes: { nodeId: string; imagePath: string }[] = [];

export function importStructNode(
  sNode: StructNode,
  parentId: string | null,
  addNode: ReturnType<typeof useEditorStore.getState>['addNode'],
  offsetX = 0,
  offsetY = 0,
) {
  // 从前缀推断类型
  let type: UINode['type'] = (sNode.type as UINode['type']) || 'frame';
  const n = sNode.name.toLowerCase();
  if (!sNode.type) {
    if (n.startsWith('btn_')) type = 'button';
    else if (n.startsWith('txt_') || n.startsWith('text_') || n.startsWith('i#')) type = 'text';
    else if (n.startsWith('img_')) type = 'image';
    else if (n.startsWith('part_') || n.startsWith('@')) type = 'component';
    else if (n.startsWith('scroll') || n.startsWith('looplist')) type = 'scrollview';
  }

  const style = { ...defaultStyle, backgroundColor: 'transparent', backgroundOpacity: 0, opacity: 1 };

  const options: Partial<UINode> & Record<string, any> = {
    parentId: parentId || undefined,
    name: sNode.name,
    width: sNode.width || (type === 'text' ? 200 : type === 'button' ? 200 : 300),
    height: sNode.height || (type === 'text' ? 40 : type === 'button' ? 60 : 200),
    style,
    componentRef: sNode.componentRef || (type === 'component' ? sNode.name.replace(/^@?part_?/i, 'Part_') : undefined),
    text: sNode.text || (type === 'text' ? sNode.name : undefined),
    imageData: sNode.imagePath || undefined,
    imageColor: sNode.imageColor || undefined,
    hasImage: type === 'button' && !sNode.imagePath ? false : undefined,
    scrollDirection: type === 'scrollview' ? 'vertical' : undefined,
    interactable: type === 'button' ? true : undefined,
    anchorMin: { x: 0, y: 1 },
    anchorMax: { x: 0, y: 1 },
    pivot: { x: 0, y: 1 },
  };

  const nodeId = addNode(type, (sNode.x ?? 0) + offsetX, (sNode.y ?? 0) + offsetY, options);

  // 记录需要查询九宫格的节点
  if (sNode.imagePath) {
    pendingSliceNodes.push({ nodeId, imagePath: sNode.imagePath });
  }

  if (sNode.children) {
    for (const child of sNode.children) {
      importStructNode(child, nodeId, addNode);
    }
  }
  return nodeId;
}

// 批量查询九宫格并更新节点
export async function applySliceBorders() {
  if (pendingSliceNodes.length === 0) return;
  const paths = pendingSliceNodes.map((p) => p.imagePath);
  try {
    const res = await fetch('/api/atlas/slice-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths }),
    });
    const result = await res.json() as Record<string, { left: number; right: number; top: number; bottom: number } | null>;
    const store = useEditorStore.getState();
    for (const { nodeId, imagePath } of pendingSliceNodes) {
      const border = result[imagePath];
      if (border && (border.left > 0 || border.right > 0 || border.top > 0 || border.bottom > 0)) {
        store.updateNode(nodeId, {
          sliceEnabled: true,
          sliceBorder: border,
          imageType: 'Sliced',
        });
      }
    }
  } catch {}
  pendingSliceNodes.length = 0;
}

// ──────── AI 生成：自动排版 StructNode 树 ────────

const KNOWN_COMPONENT_SIZES: Record<string, { w: number; h: number }> = {
  Part_Header: { w: 0, h: 80 },
  Part_CloseBg: { w: 60, h: 60 },
  Part_BlackUI: { w: 0, h: 0 },
  Part_RedPoint: { w: 30, h: 30 },
  Part_RedPointGift: { w: 40, h: 40 },
  Part_Switch: { w: 80, h: 40 },
  Part_Item: { w: 100, h: 100 },
  Part_Equip: { w: 100, h: 100 },
  Part_EquipItem: { w: 100, h: 120 },
  Part_RewardBox: { w: 100, h: 100 },
  Part_UserHead: { w: 80, h: 80 },
  Part_UserHead_CityLv: { w: 100, h: 100 },
  Part_HeroCard: { w: 120, h: 160 },
  Part_Hero: { w: 120, h: 150 },
  Part_Soldier: { w: 100, h: 120 },
  Part_Titan: { w: 120, h: 150 },
  Part_TitanIcon: { w: 80, h: 80 },
  Part_Progress: { w: 300, h: 30 },
  Part_Progress2: { w: 300, h: 30 },
  Part_Progress3: { w: 300, h: 30 },
  Part_Slider: { w: 300, h: 40 },
  Part_Btn_Blue: { w: 200, h: 60 },
  Part_Btn_Blue2: { w: 200, h: 60 },
  Part_Btn_Blue3: { w: 200, h: 60 },
  Part_Btn_Yellow: { w: 200, h: 60 },
  Part_Btn_Yellow2: { w: 200, h: 60 },
  Part_Btn_Red: { w: 200, h: 60 },
  Part_Btn_Red2: { w: 200, h: 60 },
  Part_Btn_Payment: { w: 200, h: 60 },
  Part_RankBg: { w: 400, h: 80 },
  Part_RankItem: { w: 400, h: 80 },
  Part_RankReward: { w: 400, h: 100 },
  Part_AllianceFlag: { w: 60, h: 80 },
  Part_IconWithMask: { w: 80, h: 80 },
  Part_Gem: { w: 80, h: 80 },
  Part_Age: { w: 120, h: 40 },
  Part_ScrollRewards: { w: 400, h: 120 },
};

function _inferType(name: string, explicitType?: string): string {
  if (explicitType) return explicitType;
  const n = name.toLowerCase();
  if (n.startsWith('btn_')) return 'button';
  if (n.startsWith('txt_') || n.startsWith('text_') || n.startsWith('i#')) return 'text';
  if (n.startsWith('img_')) return 'image';
  if (n.startsWith('part_') || n.startsWith('@')) return 'component';
  if (n.startsWith('scroll') || n.startsWith('looplist')) return 'scrollview';
  return 'frame';
}

function _isBg(name: string): boolean {
  const n = name.toLowerCase();
  return n.startsWith('img_') && (n.includes('bg') || n === 'img_bg');
}

function _getRef(name: string, explicit?: string): string | undefined {
  if (explicit) return explicit;
  const m = name.match(/^@?(Part_\w+)/i);
  return m ? m[1] : undefined;
}

/** 判断容器应该用横向排列 */
function _shouldLayoutHorizontal(node: StructNode): boolean {
  if (!node.children || node.children.length < 2) return false;
  const n = node.name.toLowerCase();
  // Ctn_Tabs / Ctn_Items 等名称暗示横排
  if (n.includes('tab') || n.includes('item') || n.includes('reward') || n.includes('grid')) return true;
  // 所有子节点都是同类小元素（如 @Part_Item、btn_Tab）→ 横排
  const childTypes = node.children.filter(c => !_isBg(c.name)).map(c => _inferType(c.name, c.type));
  const allSame = childTypes.length >= 2 && childTypes.every(t => t === childTypes[0]);
  if (allSame && (childTypes[0] === 'component' || childTypes[0] === 'button')) return true;
  return false;
}

function _resolveSize(node: StructNode, parentW: number, parentH: number): { w: number; h: number } {
  const type = _inferType(node.name, node.type);
  const ref = _getRef(node.name, node.componentRef);

  if (ref && KNOWN_COMPONENT_SIZES[ref]) {
    const known = KNOWN_COMPONENT_SIZES[ref];
    return {
      w: node.width || (known.w === 0 ? parentW : known.w),
      h: node.height || (known.h === 0 ? parentH : known.h),
    };
  }

  if (_isBg(node.name)) {
    return { w: node.width || parentW, h: node.height || parentH };
  }

  if (node.width && node.height) return { w: node.width, h: node.height };

  switch (type) {
    case 'text': return { w: node.width || 200, h: node.height || 36 };
    case 'button': return { w: node.width || 200, h: node.height || 60 };
    case 'image': return { w: node.width || 100, h: node.height || 100 };
    case 'component': return { w: node.width || 100, h: node.height || 100 };
    case 'scrollview': return { w: node.width || parentW, h: node.height || Math.round(parentH * 0.6) };
    default: return { w: node.width || parentW, h: node.height || 200 };
  }
}

/**
 * 对 AI 生成的 StructNode 树做自动排版，填充 x/y/width/height。
 * 支持垂直堆叠、横向排列（tabs/items）、背景图撑满等模式。
 */
export function autoLayoutStructTree(root: StructNode, canvasW = 1920, canvasH = 1080): StructNode {
  const SPACING = 10;
  const MARGIN = 24;

  function layout(node: StructNode, parentW: number, parentH: number): StructNode {
    const size = _resolveSize(node, parentW, parentH);
    const result: StructNode = { ...node, width: size.w, height: size.h };
    delete result.x;
    delete result.y;

    if (!node.children || node.children.length === 0) return result;

    const horizontal = _shouldLayoutHorizontal(node);
    const children: StructNode[] = [];
    let cursor = 0;

    for (const child of node.children) {
      const laid = layout(child, size.w, size.h);

      if (_isBg(child.name)) {
        laid.x = 0;
        laid.y = 0;
        laid.width = size.w;
        laid.height = size.h;
      } else if (horizontal) {
        laid.x = cursor;
        laid.y = 0;
        cursor += (laid.width || 0) + SPACING;
      } else {
        laid.x = 0;
        laid.y = cursor;
        cursor += (laid.height || 0) + SPACING;
      }

      children.push(laid);
    }

    // 自适应容器尺寸
    if (cursor > 0) {
      const contentSize = cursor - SPACING;
      if (horizontal && !node.width) {
        result.width = Math.max(size.w, contentSize);
      }
      if (!horizontal && !node.height) {
        result.height = Math.max(size.h, contentSize);
      }
    }

    result.children = children;
    return result;
  }

  // 根节点使用 AI 指定的尺寸，否则用画布尺寸
  const rootW = root.width || canvasW;
  const rootH = root.height || canvasH;

  const root2 = layout(root, rootW, rootH);
  root2.width = rootW;
  root2.height = rootH;
  root2.x = 0;
  root2.y = 0;

  // 根面板的直接子节点做边距偏移（背景除外）
  if (root2.children) {
    let cursorY = 0;
    for (const child of root2.children) {
      if (_isBg(child.name)) {
        child.x = 0;
        child.y = 0;
        continue;
      }
      // 标题和关闭按钮特殊处理
      const n = child.name.toLowerCase();
      if (n === 'txt_title' || n === 'text_title') {
        child.x = Math.round((rootW - (child.width || 200)) / 2);
        child.y = 14;
        cursorY = Math.max(cursorY, 14 + (child.height || 36) + SPACING);
        continue;
      }
      if (n.includes('close') || n.includes('closebg')) {
        child.x = rootW - (child.width || 60) - 10;
        child.y = 10;
        continue;
      }
      // 其他子节点：左右留 MARGIN，垂直堆叠
      if (cursorY === 0) cursorY = 60; // 默认标题下方起始
      child.x = MARGIN;
      child.y = cursorY;
      // 容器宽度适应父容器减边距
      if ((child.width || 0) > rootW - MARGIN * 2) {
        child.width = rootW - MARGIN * 2;
      }
      cursorY += (child.height || 0) + SPACING;
    }
  }

  return root2;
}

// ──────── AI 重建：基于 origId 的重构导入 ────────

/**
 * 根据子节点的起始位置分散程度判断排列方向，并估算间距。
 * 比较各子项左上角坐标的变化量：Y 方向变化大 → 垂直，X 方向变化大 → 水平。
 */
function detectLayoutDirection(
  childBoundsXY: { x: number; y: number; w: number; h: number }[],
): { isHorizontal: boolean; spacing: number } {
  if (childBoundsXY.length < 2) return { isHorizontal: false, spacing: 0 };

  // 比较起始位置（左上角）的分散程度，而非总包围盒跨度
  const xVariation = Math.max(...childBoundsXY.map(b => b.x)) - Math.min(...childBoundsXY.map(b => b.x));
  const yVariation = Math.max(...childBoundsXY.map(b => b.y)) - Math.min(...childBoundsXY.map(b => b.y));
  const isHorizontal = xVariation > yVariation;

  let spacing = 0;
  if (isHorizontal) {
    const sorted = [...childBoundsXY].sort((a, b) => a.x - b.x);
    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      gaps.push(sorted[i].x - sorted[i - 1].x - sorted[i - 1].w);
    }
    spacing = Math.max(0, Math.round(gaps.reduce((s, g) => s + g, 0) / gaps.length));
  } else {
    const sorted = [...childBoundsXY].sort((a, b) => a.y - b.y);
    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      gaps.push(sorted[i].y - sorted[i - 1].y - sorted[i - 1].h);
    }
    spacing = Math.max(0, Math.round(gaps.reduce((s, g) => s + g, 0) / gaps.length));
  }

  return { isHorizontal, spacing };
}

/** AI 重构输出的节点格式 */
export interface RestructureNode {
  origId?: string;       // 引用原始节点 ID（叶节点必填）
  name: string;
  type?: string;
  componentRef?: string;
  localScale?: { x: number; y: number; z?: number };
  originalLocalScale?: { x: number; y: number; z?: number };
  children?: RestructureNode[];
}

/** 计算所有原始节点的绝对坐标（递归累加父节点偏移，考虑 LayoutGroup 动态排列） */
function computeAbsolutePositions(
  nodes: Record<string, UINode>,
  rootIds: string[],
): Record<string, { x: number; y: number; width: number; height: number }> {
  const abs: Record<string, { x: number; y: number; width: number; height: number }> = {};
  function walk(nodeId: string, parentAbsX: number, parentAbsY: number, posOverride?: { x: number; y: number }) {
    const n = nodes[nodeId];
    if (!n) return;
    const ax = parentAbsX + (posOverride ? posOverride.x : n.x);
    const ay = parentAbsY + (posOverride ? posOverride.y : n.y);
    abs[nodeId] = { x: ax, y: ay, width: n.width, height: n.height };

    // LayoutGroup: 按排列顺序计算子节点位置（与渲染器逻辑一致）
    const lg = n.layoutGroup;
    if (lg?.enabled && lg.layoutType === 'Grid' && n.children.length > 0) {
      const cellW = lg.cellSizeX || 100;
      const cellH = lg.cellSizeY || 100;
      const spX = lg.spacing;
      const spY = lg.spacingY || 0;
      const cols = lg.constraint === 1
        ? Math.max(1, lg.constraintCount || 2)
        : Math.max(1, Math.floor((n.width - lg.padLeft - lg.padRight + spX) / (cellW + spX)));
      let idx = 0;
      for (const childId of n.children) {
        const child = nodes[childId];
        if (!child || !child.visible) continue;
        const col = idx % cols;
        const row = Math.floor(idx / cols);
        walk(childId, ax, ay, {
          x: lg.padLeft + col * (cellW + spX),
          y: lg.padTop + row * (cellH + spY),
        });
        idx++;
      }
    } else if (lg?.enabled && n.children.length > 0) {
      let cursor = lg.isHorizontal ? lg.padLeft : lg.padTop;
      for (const childId of n.children) {
        const child = nodes[childId];
        if (!child || !child.visible) continue;
        const childPos = lg.isHorizontal
          ? { x: cursor, y: lg.padTop }
          : { x: lg.padLeft, y: cursor };
        walk(childId, ax, ay, childPos);
        cursor += (lg.isHorizontal ? child.width : child.height) + lg.spacing;
      }
    } else {
      for (const childId of n.children) {
        walk(childId, ax, ay);
      }
    }
  }
  for (const rid of rootIds) {
    walk(rid, 0, 0);
  }
  return abs;
}

/** 递归收集一棵重构子树中所有 origId 对应的绝对包围盒 */
function collectBounds(
  treeNode: RestructureNode,
  absPos: Record<string, { x: number; y: number; width: number; height: number }>,
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (treeNode.origId && absPos[treeNode.origId]) {
    const p = absPos[treeNode.origId];
    return { minX: p.x, minY: p.y, maxX: p.x + p.width, maxY: p.y + p.height };
  }
  if (!treeNode.children || treeNode.children.length === 0) return null;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let found = false;
  for (const child of treeNode.children) {
    const b = collectBounds(child, absPos);
    if (b) {
      found = true;
      minX = Math.min(minX, b.minX);
      minY = Math.min(minY, b.minY);
      maxX = Math.max(maxX, b.maxX);
      maxY = Math.max(maxY, b.maxY);
    }
  }
  return found ? { minX, minY, maxX, maxY } : null;
}

/**
 * 递归查找新容器节点在原始树中对应的节点 ID。
 * 逻辑：收集每个子节点在原始树中"代表"的节点 ID，然后找它们的共同父节点。
 * - 子节点有 origId → 它代表自己
 * - 子节点是新容器 → 递归找它代表的原始节点
 */
function findCommonOriginalParent(
  treeNode: RestructureNode,
  originalNodes: Record<string, UINode>,
): string | null {
  if (!treeNode.children || treeNode.children.length === 0) return null;

  const childOrigIds: string[] = [];
  for (const child of treeNode.children) {
    if (child.origId && originalNodes[child.origId]) {
      childOrigIds.push(child.origId);
    } else {
      // 新容器 → 递归找它代表的原始节点
      const rep = findCommonOriginalParent(child, originalNodes);
      if (rep) childOrigIds.push(rep);
    }
  }

  if (childOrigIds.length === 0) return null;

  // 找这些节点的共同父节点
  const parents = new Set<string>();
  for (const id of childOrigIds) {
    const pid = originalNodes[id]?.parentId;
    if (pid) parents.add(pid);
  }

  return parents.size === 1 ? [...parents][0] : null;
}

/**
 * 对于新容器节点，递归查找它在原始树中对应的节点，继承其布局属性。
 * 使用预计算的 absPos（已考虑 LayoutGroup 动态排列）来获取准确位置。
 */
function inferContainerProps(
  treeNode: RestructureNode,
  originalNodes: Record<string, UINode>,
  absPos: Record<string, { x: number; y: number; width: number; height: number }>,
): (Partial<UINode> & { absX?: number; absY?: number }) | null {
  const commonParentId = findCommonOriginalParent(treeNode, originalNodes);
  if (!commonParentId) return null;

  const cp = originalNodes[commonParentId];
  if (!cp) return null;

  // 使用预计算的绝对位置（已正确处理 LayoutGroup）
  const pos = absPos[commonParentId];
  const absX = pos ? pos.x : cp.x;
  const absY = pos ? pos.y : cp.y;

  return {
    width: cp.width,
    height: cp.height,
    style: { ...cp.style },
    layoutGroup: cp.layoutGroup,
    contentSizeFitter: cp.contentSizeFitter,
    isMask: cp.isMask,
    maskType: cp.maskType,
    scrollDirection: cp.scrollDirection,
    imageData: cp.imageData,
    imageColor: cp.imageColor,
    imageEnabled: cp.imageEnabled,
    imageType: cp.imageType,
    sliceEnabled: cp.sliceEnabled,
    sliceBorder: cp.sliceBorder,
    anchorMin: cp.anchorMin,
    anchorMax: cp.anchorMax,
    pivot: cp.pivot,
    rotation: cp.rotation,
    localScale: cp.localScale,
    originalLocalScale: cp.originalLocalScale,
    absX,
    absY,
  };
}

/**
 * 基于 AI 重构树 + 原始节点数据，重建画布。
 * AI 只决定层级和命名，坐标由代码从原始节点精确计算。
 */
export function restructureFromTree(
  tree: RestructureNode,
  originalNodes: Record<string, UINode>,
  originalRootIds: string[],
  addNode: ReturnType<typeof useEditorStore.getState>['addNode'],
  panelWidth: number,
  panelHeight: number,
) {
  const absPos = computeAbsolutePositions(originalNodes, originalRootIds);

  pendingSliceNodes.length = 0;

  function processNode(
    treeNode: RestructureNode,
    parentId: string | null,
    parentAbsX: number,
    parentAbsY: number,
    parentW: number,
    parentH: number,
  ): string | null {
    // 推断类型
    let type: UINode['type'] = (treeNode.type as UINode['type']) || 'frame';
    const n = treeNode.name.toLowerCase();
    if (!treeNode.type) {
      if (n.startsWith('btn_')) type = 'button';
      else if (n.startsWith('txt_') || n.startsWith('text_') || n.startsWith('i#')) type = 'text';
      else if (n.startsWith('img_')) type = 'image';
      else if (n.startsWith('part_') || n.startsWith('@')) type = 'component';
      else if (n.startsWith('scroll') || n.startsWith('looplist')) type = 'scrollview';
    }

    const transparentStyle = { ...defaultStyle, backgroundColor: 'transparent', backgroundOpacity: 0, opacity: 1 };

    if (treeNode.origId && absPos[treeNode.origId]) {
      // ── 引用原始节点：精确复制其所有属性 ──
      const orig = originalNodes[treeNode.origId];
      const ap = absPos[treeNode.origId];
      const relX = ap.x - parentAbsX;
      const relY = ap.y - parentAbsY;

      // 浅拷贝原始节点全部属性，只覆盖父子关系和名称等需要变化的字段
      const { id: _id, children: _children, parentId: _pid, x: _x, y: _y, visible: _v, locked: _l, ...restOrig } = orig;
      // 重建结构后节点的父容器可能已变化，根据新位置自动推断 anchor
      const autoAnchor = inferAnchor(relX, relY, orig.width, orig.height, parentW, parentH);
      // component 类型不允许 stretch anchor，否则 Unity 会跳过缩略图渲染
      if (type === 'component') {
        if (Math.abs(autoAnchor.anchorMax.x - autoAnchor.anchorMin.x) > 0.5) {
          autoAnchor.anchorMin.x = 0.5; autoAnchor.anchorMax.x = 0.5;
        }
        if (Math.abs(autoAnchor.anchorMax.y - autoAnchor.anchorMin.y) > 0.5) {
          autoAnchor.anchorMin.y = 0.5; autoAnchor.anchorMax.y = 0.5;
        }
      }
      const options: Partial<UINode> & Record<string, any> = {
        ...restOrig,
        parentId: parentId || undefined,
        name: treeNode.name,
        componentRef: treeNode.componentRef || orig.componentRef,
        anchorMin: autoAnchor.anchorMin,
        anchorMax: autoAnchor.anchorMax,
        pivot: orig.pivot || { x: 0.5, y: 0.5 },
      };

      const nodeId = addNode(type, relX, relY, options);

      // 如果有图片，记录待查九宫格
      if (orig.imageData && typeof orig.imageData === 'string' && !orig.imageData.startsWith('data:')) {
        pendingSliceNodes.push({ nodeId, imagePath: orig.imageData });
      }

      // 原始节点可能也有需要保留的子节点（如果 AI 树中未展开）
      if (treeNode.children) {
        for (const child of treeNode.children) {
          processNode(child, nodeId, ap.x, ap.y, orig.width, orig.height);
        }
      }

      return nodeId;
    } else {
      // ── 新容器节点：根据子节点包围盒计算位置和大小 ──
      const bounds = collectBounds(treeNode, absPos);
      let nodeAbsX: number, nodeAbsY: number, nodeW: number, nodeH: number;

      if (bounds) {
        // 容器边界留 0 边距，刚好包住子节点
        nodeAbsX = bounds.minX;
        nodeAbsY = bounds.minY;
        nodeW = bounds.maxX - bounds.minX;
        nodeH = bounds.maxY - bounds.minY;
      } else {
        // 没有有效子节点，给个默认大小
        nodeAbsX = parentAbsX;
        nodeAbsY = parentAbsY;
        nodeW = 300;
        nodeH = 200;
      }

      const relX = nodeAbsX - parentAbsX;
      const relY = nodeAbsY - parentAbsY;

      // 尝试从子节点的共同原始父节点继承布局属性（layoutGroup, contentSizeFitter, mask, style 等）
      const inherited = inferContainerProps(treeNode, originalNodes, absPos);

      // 检测是否为 scrollview 类型
      const isScrollView = type === 'scrollview'
        || treeNode.type === 'scrollview'
        || treeNode.name.toLowerCase().startsWith('scroll')
        || treeNode.name.toLowerCase().startsWith('looplist');

      // 检测子节点中是否有背景图（img_*Bg* / img_Bg）
      // 背景图不应参与 LayoutGroup 排列，Unity 里它们设了 ignoreLayout，编辑器没有此属性
      // 所以如果有背景图混在其中，就不给这个容器加 LayoutGroup
      const hasBgChild = treeNode.children?.some(c => {
        const n = c.name.toLowerCase();
        return n.startsWith('img_') && (n.includes('bg') || n === 'img_bg');
      }) ?? false;

      // 如果继承没有拿到 LayoutGroup，自动检测列表容器并补上
      // 注意：ScrollView 本身不加 LayoutGroup，后面会创建 Content 子节点并加上
      // 有背景图子节点的容器不加 LayoutGroup（避免背景参与布局）
      let autoLayoutGroup = (inherited?.layoutGroup && !hasBgChild) ? inherited.layoutGroup : undefined;
      let autoContentSizeFitter = (inherited?.contentSizeFitter && !hasBgChild) ? inherited.contentSizeFitter : undefined;
      if (!isScrollView && !hasBgChild && !autoLayoutGroup?.enabled && treeNode.children && treeNode.children.length >= 2) {
        // 检查子节点是否为列表项模式（名称前缀相同，如 Cell_*, Ctn_Challenge* 等）
        const childNames = treeNode.children.map(c => c.name);
        const prefixes = childNames.map(n => n.replace(/\d+$/, ''));
        const allSamePrefix = prefixes.every(p => p === prefixes[0]);
        const nameLC = treeNode.name.toLowerCase();
        const isListContainer = allSamePrefix
          || nameLC === 'content'
          || nameLC.startsWith('list_')
          || nameLC.startsWith('ctn_list');

        if (isListContainer) {
          // 收集子节点的绝对位置包围盒
          const childBoundsXY: { x: number; y: number; w: number; h: number }[] = [];
          for (const child of treeNode.children) {
            const cb = collectBounds(child, absPos);
            if (cb) childBoundsXY.push({ x: cb.minX, y: cb.minY, w: cb.maxX - cb.minX, h: cb.maxY - cb.minY });
          }

          if (childBoundsXY.length >= 2) {
            const { isHorizontal, spacing } = detectLayoutDirection(childBoundsXY);

            autoLayoutGroup = {
              enabled: true,
              isHorizontal,
              spacing,
              padLeft: 0, padRight: 0, padTop: 0, padBottom: 0,
              childAlignment: 0,
              childControlWidth: false,
              childControlHeight: false,
              childForceExpandWidth: false,
              childForceExpandHeight: false,
            };
            autoContentSizeFitter = autoContentSizeFitter || {
              enabled: true,
              horizontalFit: isHorizontal ? 2 : 0,
              verticalFit: isHorizontal ? 0 : 2,
            };
          }
        }
      }

      // ScrollView 本身不要 LayoutGroup，后面会给 Content 加
      const nodeLayoutGroup = isScrollView ? undefined : autoLayoutGroup;
      const nodeContentSizeFitter = isScrollView ? undefined : autoContentSizeFitter;

      // 新容器节点：优先继承锚点，否则根据位置推断
      const finalW = inherited?.width ?? nodeW;
      const finalH = inherited?.height ?? nodeH;
      const finalRelX = (inherited?.absX != null) ? (inherited.absX - parentAbsX) : relX;
      const finalRelY = (inherited?.absY != null) ? (inherited.absY - parentAbsY) : relY;
      const autoAnchor = !inherited?.anchorMin
        ? inferAnchor(finalRelX, finalRelY, finalW, finalH, parentW, parentH)
        : null;

      const options: Partial<UINode> & Record<string, any> = {
        parentId: parentId || undefined,
        name: treeNode.name,
        width: finalW,
        height: finalH,
        style: inherited?.style ?? transparentStyle,
        componentRef: treeNode.componentRef,
        anchorMin: inherited?.anchorMin ?? autoAnchor?.anchorMin ?? { x: 0, y: 1 },
        anchorMax: inherited?.anchorMax ?? autoAnchor?.anchorMax ?? { x: 0, y: 1 },
        pivot: inherited?.pivot ?? { x: 0, y: 1 },
        localScale: inherited?.localScale ?? treeNode.localScale,
        originalLocalScale: inherited?.originalLocalScale ?? treeNode.originalLocalScale,
        layoutGroup: nodeLayoutGroup,
        contentSizeFitter: nodeContentSizeFitter,
        isMask: inherited?.isMask,
        maskType: inherited?.maskType,
        scrollDirection: inherited?.scrollDirection || (type === 'scrollview' ? 'vertical' : undefined),
        imageData: inherited?.imageData,
        imageColor: inherited?.imageColor,
        imageEnabled: inherited?.imageEnabled,
        imageType: inherited?.imageType,
        sliceEnabled: inherited?.sliceEnabled,
        sliceBorder: inherited?.sliceBorder,
      };

      // 如果继承了图片，使用继承的位置
      if (inherited?.absX != null && inherited?.absY != null) {
        nodeAbsX = inherited.absX;
        nodeAbsY = inherited.absY;
      }

      const nodeId = addNode(
        type === 'scrollview' ? 'scrollview' : (inherited?.scrollDirection ? 'scrollview' as UINode['type'] : type),
        finalRelX,
        finalRelY,
        options,
      );

      if (inherited?.imageData && typeof inherited.imageData === 'string' && !inherited.imageData.startsWith('data:')) {
        pendingSliceNodes.push({ nodeId, imagePath: inherited.imageData });
      }

      // ScrollView：自动创建 Viewport > Content 结构，LayoutGroup 放在 Content 上
      if (isScrollView && treeNode.children && treeNode.children.length > 0) {
        const svAbsX = inherited?.absX ?? nodeAbsX;
        const svAbsY = inherited?.absY ?? nodeAbsY;
        const svW = options.width as number;
        const svH = options.height as number;

        // 估算 Content 的 LayoutGroup spacing
        let contentLayoutGroup = autoLayoutGroup || inherited?.layoutGroup;
        if (!contentLayoutGroup?.enabled) {
          // 从子项位置估算方向和 spacing
          const childBoundsXY: { x: number; y: number; w: number; h: number }[] = [];
          for (const child of treeNode.children) {
            const cb = collectBounds(child, absPos);
            if (cb) childBoundsXY.push({ x: cb.minX, y: cb.minY, w: cb.maxX - cb.minX, h: cb.maxY - cb.minY });
          }
          const detected = detectLayoutDirection(childBoundsXY);
          contentLayoutGroup = {
            enabled: true,
            isHorizontal: detected.isHorizontal,
            spacing: detected.spacing,
            padLeft: 0, padRight: 0, padTop: 0, padBottom: 0,
            childAlignment: 0,
            childControlWidth: false,
            childControlHeight: false,
            childForceExpandWidth: false,
            childForceExpandHeight: false,
          };
        }

        // 创建 Viewport（mask 容器）
        const viewportId = addNode('frame', 0, 0, {
          parentId: nodeId,
          name: 'Viewport',
          width: svW,
          height: svH,
          style: transparentStyle,
          isMask: true,
          maskType: 'RectMask2D',
          anchorMin: { x: 0, y: 1 },
          anchorMax: { x: 0, y: 1 },
          pivot: { x: 0, y: 1 },
        });

        // 创建 Content（布局容器）
        const contentId = addNode('frame', 0, 0, {
          parentId: viewportId,
          name: 'Content',
          width: svW,
          height: svH,
          style: transparentStyle,
          layoutGroup: contentLayoutGroup,
          contentSizeFitter: {
            enabled: true,
            horizontalFit: 0,
            verticalFit: 2, // PreferredSize
          },
          anchorMin: { x: 0, y: 1 },
          anchorMax: { x: 0, y: 1 },
          pivot: { x: 0, y: 1 },
        });

        // 把 AI 的子节点挂到 Content 下
        for (const child of treeNode.children) {
          processNode(child, contentId, svAbsX, svAbsY, svW, svH);
        }
      } else if (treeNode.children) {
        const nw = (options.width as number) || nodeW;
        const nh = (options.height as number) || nodeH;
        for (const child of treeNode.children) {
          processNode(child, nodeId, inherited?.absX ?? nodeAbsX, inherited?.absY ?? nodeAbsY, nw, nh);
        }
      }

      return nodeId;
    }
  }

  // 根节点：面板自身，使用拉伸锚点以适配分辨率切换
  const rootOptions: Partial<UINode> & Record<string, any> = {
    name: tree.name,
    width: panelWidth,
    height: panelHeight,
    style: { ...defaultStyle, backgroundColor: 'transparent', backgroundOpacity: 0, opacity: 1 },
    anchorMin: { x: 0, y: 0 },
    anchorMax: { x: 1, y: 1 },
    pivot: { x: 0.5, y: 0.5 },
  };
  const rootId = addNode('frame', 0, 0, rootOptions);

  if (tree.children) {
    for (const child of tree.children) {
      processNode(child, rootId, 0, 0, panelWidth, panelHeight);
    }
  }

  // 后处理 1：修正错位背景图 — 如果 img_*Bg 和某个兄弟容器视觉重叠度 >70%，移入该容器
  const store = useEditorStore.getState();
  let allNodes = store.nodes;
  for (const id of Object.keys(allNodes)) {
    const parent = allNodes[id];
    if (parent.children.length < 2) continue;
    const bgChildren: string[] = [];
    const containerChildren: string[] = [];
    for (const cid of parent.children) {
      const child = allNodes[cid];
      if (!child) continue;
      const n = child.name.toLowerCase();
      if (n.startsWith('img_') && n.includes('bg')) {
        bgChildren.push(cid);
      } else if (child.type === 'frame' && child.children.length > 0) {
        containerChildren.push(cid);
      }
    }
    for (const bgId of bgChildren) {
      const bg = allNodes[bgId];
      const bgArea = bg.width * bg.height;
      // 找与 bg 尺寸匹配且重叠度最高的兄弟容器
      let bestCtn = '';
      let bestOverlap = 0;
      for (const ctnId of containerChildren) {
        const ctn = allNodes[ctnId];
        const ctnArea = ctn.width * ctn.height;
        // 跳过：bg 面积远大于容器（>1.5倍），说明 bg 是上级背景，不该塞进子容器
        if (bgArea > ctnArea * 1.5) continue;
        const ox = Math.max(0, Math.min(bg.x + bg.width, ctn.x + ctn.width) - Math.max(bg.x, ctn.x));
        const oy = Math.max(0, Math.min(bg.y + bg.height, ctn.y + ctn.height) - Math.max(bg.y, ctn.y));
        const overlap = ox * oy;
        const ratio = bgArea > 0 ? overlap / bgArea : 0;
        if (ratio > bestOverlap) { bestOverlap = ratio; bestCtn = ctnId; }
      }
      if (bestCtn && bestOverlap > 0.7) {
        const ctn = allNodes[bestCtn];
        // 把 bg 从当前 parent 移到 ctn 内部第一位，坐标转为相对 ctn
        store.updateNode(bgId, {
          x: bg.x - ctn.x,
          y: bg.y - ctn.y,
          parentId: bestCtn,
        } as any);
        // 更新 parent 和 ctn 的 children 数组
        store.updateNode(id, { children: parent.children.filter(c => c !== bgId) } as any);
        store.updateNode(bestCtn, { children: [bgId, ...ctn.children] } as any);
        allNodes = useEditorStore.getState().nodes; // 刷新引用
      }
    }
  }

  // 后处理 1b：修正层级过深的背景图 — 如果 bg 超出父容器边界，循环向上提级直到找到能容纳它的容器
  allNodes = useEditorStore.getState().nodes;
  for (const bgId of Object.keys(allNodes)) {
    let bg = allNodes[bgId];
    if (!bg) continue;
    const n = bg.name.toLowerCase();
    if (!(n.startsWith('img_') && n.includes('bg'))) continue;

    // 循环：只要 bg 超出当前父容器的边界，就向上提一级
    let moved = true;
    while (moved) {
      moved = false;
      allNodes = useEditorStore.getState().nodes;
      bg = allNodes[bgId];
      if (!bg || !bg.parentId) break;
      const parent = allNodes[bg.parentId];
      if (!parent || !parent.parentId) break;

      const margin = 10; // 允许少量溢出
      const exceedsLeft = bg.x < -margin;
      const exceedsTop = bg.y < -margin;
      const exceedsRight = bg.x + bg.width > parent.width + margin;
      const exceedsBottom = bg.y + bg.height > parent.height + margin;

      if (exceedsLeft || exceedsTop || exceedsRight || exceedsBottom) {
        // 坐标转为相对祖父
        const newX = bg.x + parent.x;
        const newY = bg.y + parent.y;
        const gpId = parent.parentId;
        store.updateNode(bgId, { x: newX, y: newY, parentId: gpId } as any);
        // 从父节点移除，插入祖父节点首位
        const freshParent = useEditorStore.getState().nodes[parent.id];
        const freshGP = useEditorStore.getState().nodes[gpId];
        store.updateNode(parent.id, { children: freshParent.children.filter((c: string) => c !== bgId) } as any);
        store.updateNode(gpId, { children: [bgId, ...freshGP.children.filter((c: string) => c !== bgId)] } as any);
        moved = true; // 继续检查新的父容器
      }
    }
  }

  // 后处理 2：把背景图（img_*bg*、img_*round*、img_*mask* 等）移到兄弟列表首位，确保渲染在最底层
  allNodes = useEditorStore.getState().nodes;
  for (const id of Object.keys(allNodes)) {
    const node = allNodes[id];
    if (node.children.length < 2) continue;
    const bgIndices: number[] = [];
    node.children.forEach((cid, i) => {
      const child = allNodes[cid];
      if (!child) return;
      const n = child.name.toLowerCase();
      if (n.startsWith('img_') && (n.includes('bg') || n.includes('round') || n.includes('mask') || n.includes('base'))) {
        bgIndices.push(i);
      }
    });
    if (bgIndices.length > 0 && bgIndices[0] !== 0) {
      // 把背景图提到最前面，保持其他节点相对顺序
      const bgIds = bgIndices.map(i => node.children[i]);
      const rest = node.children.filter((_, i) => !bgIndices.includes(i));
      const newChildren = [...bgIds, ...rest];
      store.updateNode(id, { children: newChildren } as any);
    }
  }

  return rootId;
}

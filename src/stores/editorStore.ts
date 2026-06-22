import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import type { UINode, UIStyle, NodeType, PageData, Artboard, SceneTool } from '../types';
import { defaultStyle } from '../types';
import type { AnnotationNode, AnnotationType } from '../types';
import { createAnnotation } from '../types/annotation';
import type { SidebarBlock, SidebarBlockType } from '../types';
import {
  DEFAULT_FONT,
  DESIGN_WIDTH,
  DESIGN_HEIGHT,
  DEFAULT_PREVIEW_WIDTH,
  DEFAULT_PREVIEW_HEIGHT,
} from '../config/assetPaths';
import { measureTextHeight } from '../utils/measureText';
import { migratePages } from '../utils/migratePage';
import { adaptNodeCoords } from '../utils/anchorAdapt';

/** 若节点为 text 且开启了 verticalFit=PreferredSize，按文本/字号/宽度重算 height。 */
function autoFitTextHeight(node: UINode): UINode {
  if (node.type !== 'text') return node;
  const csf = node.contentSizeFitter;
  if (!csf?.enabled || csf.verticalFit !== 2) return node;
  const fontSize = node.style?.fontSize ?? 24;
  const newH = measureTextHeight({
    text: node.text || '',
    fontSize,
    width: node.width,
    lineSpacing: node.lineSpacing ?? 1,
    fontWeight: node.style?.fontWeight,
  });
  if (newH === node.height) return node;
  return { ...node, height: newH };
}

interface HistoryEntry {
  artboards: Artboard[];
  activeArtboardId: string;
  annotations: Record<string, AnnotationNode>;
  annotationRootIds: string[];
}

const PREVIEW_RESOLUTION_STORAGE_KEY = 'uieditor_preview_resolution';
const PREVIEW_RESOLUTION_STORAGE_VERSION = 3;

function readPreviewResolutionPreference(): { width: number; height: number } {
  const defaults = { width: DEFAULT_PREVIEW_WIDTH, height: DEFAULT_PREVIEW_HEIGHT };
  if (typeof window === 'undefined') return defaults;
  try {
    const raw = window.localStorage.getItem(PREVIEW_RESOLUTION_STORAGE_KEY);
    if (!raw) return defaults;
    const data = JSON.parse(raw);
    const width = Number(data?.width ?? data?.w);
    const height = Number(data?.height ?? data?.h);
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      const version = Number(data?.version ?? 1);
      if (version < PREVIEW_RESOLUTION_STORAGE_VERSION && width === DESIGN_WIDTH && height === DESIGN_HEIGHT) {
        persistPreviewResolutionPreference(defaults.width, defaults.height);
        return defaults;
      }
      return { width, height };
    }
  } catch {
    // localStorage can be unavailable in restricted browser modes.
  }
  return defaults;
}

function persistPreviewResolutionPreference(width: number, height: number) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(PREVIEW_RESOLUTION_STORAGE_KEY, JSON.stringify({
      version: PREVIEW_RESOLUTION_STORAGE_VERSION,
      width,
      height,
    }));
  } catch {
    // Keep editor state authoritative when persistence is unavailable.
  }
}

const initialPreviewResolution = readPreviewResolutionPreference();

function roundLayoutValue(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function adaptNodesForPreviewResolution(
  nodes: Record<string, UINode>,
  rootIds: string[],
  oldWidth: number,
  oldHeight: number,
  newWidth: number,
  newHeight: number,
): Record<string, UINode> {
  if (oldWidth === newWidth && oldHeight === newHeight) return nodes;

  const nextNodes: Record<string, UINode> = { ...nodes };

  function adaptSubtree(nodeId: string, oldParentW: number, oldParentH: number, newParentW: number, newParentH: number) {
    const node = nodes[nodeId];
    if (!node) return;

    const adapted = adaptNodeCoords(node, oldParentW, oldParentH, newParentW, newParentH);
    const nextNode: UINode = {
      ...node,
      x: roundLayoutValue(adapted.x),
      y: roundLayoutValue(adapted.y),
      width: Math.max(1, roundLayoutValue(adapted.width)),
      height: Math.max(1, roundLayoutValue(adapted.height)),
    };
    nextNodes[nodeId] = nextNode;

    for (const childId of node.children) {
      adaptSubtree(childId, node.width, node.height, nextNode.width, nextNode.height);
    }
  }

  for (const rootId of rootIds) {
    adaptSubtree(rootId, oldWidth, oldHeight, newWidth, newHeight);
  }

  return nextNodes;
}

interface EditorState {
  // 多图层
  pages: PageData[];
  activePageId: string;
  // 当前活动画板（属于 activePage）
  activeArtboardId: string;

  // 当前画板的镜像（顶层暴露便于现有代码直读）
  nodes: Record<string, UINode>;
  rootIds: string[];

  // 选中
  selectedIds: string[];
  selectedArtboardId: string | null;
  hoveredId: string | null;
  revealInLayerCounter: number;
  /** 递增计数器：图层面板监听后启动当前选中项的重命名输入框 */
  requestRenameCounter: number;
  /** 递增计数器：触发 TemplateLibrary 重新拉取预制体列表 */
  prefabListReloadCounter: number;
  editingTextId: string | null;
  locateImagePath: string | null;
  // 当前编辑的 prefab 路径（增量同步用） —— 镜像 activeArtboard.sourcePrefabPath
  sourcePrefabPath: string | null;

  // 画布
  canvasX: number;
  canvasY: number;
  canvasScale: number;
  canvasWidth: number;
  canvasHeight: number;
  // 预览分辨率（Unity 设计基准始终 1920x1080，编辑器默认画布为 1080x1920）
  previewWidth: number;
  previewHeight: number;

  // 历史
  history: HistoryEntry[];
  historyIndex: number;

  // 工具
  tool: 'select' | 'frame' | 'text';
  sceneTool: SceneTool;

  // 视图开关
  rulersVisible: boolean;

  // 批注
  annotations: Record<string, AnnotationNode>;
  annotationRootIds: string[];
  selectedAnnotationIds: string[];
  annotationLayerVisible: boolean;
  /** 画布灰度模式 — UE 稿对接通常需要灰度图,导出截图也跟着走 */
  grayscaleMode: boolean;
  annotationTool: AnnotationType | null;
  // 批注模式临时状态
  annotationHint: string | null;
  flowLineDraftSrcId: string | null;

  // 批注 CRUD
  addAnnotation: (
    type: AnnotationType,
    x: number,
    y: number,
    partial?: Partial<AnnotationNode>
  ) => string;
  updateAnnotation: (id: string, patch: Partial<AnnotationNode>) => void;
  deleteAnnotation: (id: string) => void;
  clearAllAnnotations: () => void;
  duplicateAnnotation: (id: string) => string;
  setSelectedAnnotationIds: (ids: string[]) => void;
  toggleAnnotationLayer: () => void;
  toggleGrayscaleMode: () => void;
  setAnnotationTool: (tool: AnnotationType | null) => void;
  setAnnotationHint: (msg: string | null, autoClearMs?: number) => void;
  setFlowLineDraftSrcId: (id: string | null) => void;

  // 状态分组
  setPageGroup: (pageId: string, group: string | undefined) => void;

  // 页面说明栏 (v2) —— 现在 sidebar 挂在 Artboard 上；不传 artboardId 默认作用 active
  addSidebarBlock: (pageId: string, type: SidebarBlockType, partial?: Partial<SidebarBlock>, artboardId?: string) => string;
  updateSidebarBlock: (pageId: string, blockId: string, patch: Partial<SidebarBlock>, artboardId?: string) => void;
  deleteSidebarBlock: (pageId: string, blockId: string, artboardId?: string) => void;
  reorderSidebarBlock: (pageId: string, blockId: string, direction: 'up' | 'down', artboardId?: string) => void;
  toggleSidebarEnabled: (pageId: string, artboardId?: string) => void;

  // 节点操作
  addNode: (type: NodeType, x: number, y: number, options?: Partial<UINode>) => string;
  deleteNode: (id: string) => void;
  updateNode: (id: string, updates: Partial<UINode>) => void;
  updateNodeStyle: (id: string, style: Partial<UIStyle>) => void;
  moveNode: (id: string, x: number, y: number) => void;
  resizeNode: (id: string, width: number, height: number) => void;
  reparentNode: (id: string, newParentId: string | null, index?: number) => void;
  reorderNode: (id: string, direction: 'up' | 'down' | 'top' | 'bottom') => void;
  /** 把选中的多个同级节点包入一个新 frame；返回新 frame id（无操作返回 null） */
  groupSelected: () => string | null;
  /** 选中一个 frame，把它的子节点摊到它的父级，并删除该 frame */
  ungroupSelected: () => void;

  setSelectedIds: (ids: string[]) => void;
  setSelectedArtboardId: (id: string | null) => void;
  setHoveredId: (id: string | null) => void;
  setEditingTextId: (id: string | null) => void;
  setLocateImagePath: (p: string | null) => void;
  setSourcePrefabPath: (p: string | null) => void;
  revealSelectedInLayer: () => void;
  /** 递增 requestRenameCounter，图层面板监听后启动当前选中项的重命名 */
  requestRenameSelected: () => void;
  /** 递增 prefabListReloadCounter，TemplateLibrary 监听后重新拉列表 */
  requestPrefabListReload: () => void;
  setTool: (tool: 'select' | 'frame' | 'text') => void;
  setSceneTool: (tool: SceneTool) => void;
  toggleRulers: () => void;
  setCanvasTransform: (x: number, y: number, scale: number) => void;
  setPreviewResolution: (w: number, h: number) => void;

  // 历史
  pushHistory: () => void;
  undo: () => void;
  redo: () => void;

  // 图层操作
  addPage: (name?: string) => string;
  deletePage: (pageId: string) => void;
  renamePage: (pageId: string, name: string) => void;
  switchPage: (pageId: string) => void;
  duplicatePage: (pageId: string) => string;
  reorderPages: (sourceId: string, targetId: string, position: 'before' | 'after') => void;

  // 画板操作
  addArtboard: (options?: { name?: string; x?: number; y?: number; pageId?: string }) => string;
  deleteArtboard: (artboardId: string, pageId?: string) => void;
  renameArtboard: (artboardId: string, name: string, pageId?: string) => void;
  setActiveArtboard: (artboardId: string) => void;
  duplicateArtboard: (artboardId: string, pageId?: string) => string;
  updateArtboard: (artboardId: string, patch: Partial<Artboard>, pageId?: string) => void;

  // 导入
  loadDocument: (nodes: Record<string, UINode>, rootIds: string[]) => void;
  clearAll: () => void;

  // 保存/加载
  saveToLocal: (slotName?: string) => void;
  loadFromLocal: (slotName?: string) => boolean;
  getSaveSlots: () => string[];
  deleteSaveSlot: (slotName: string) => void;
}

const defaultPageId = uuid();
const defaultArtboardId = uuid();

/** 工具：在 pages 数组里找到某 page 的索引 */
function findPageIndex(pages: PageData[], pageId: string): number {
  return pages.findIndex((p) => p.id === pageId);
}

/** 把 state 顶层镜像（nodes/rootIds/sourcePrefabPath）写回到 page.artboards 里对应的画板 */
function flushMirrorToArtboard(
  pages: PageData[],
  activePageId: string,
  activeArtboardId: string,
  mirror: { nodes: Record<string, UINode>; rootIds: string[]; sourcePrefabPath: string | null }
): PageData[] {
  const pi = findPageIndex(pages, activePageId);
  if (pi < 0) return pages;
  const page = pages[pi];
  const ai = page.artboards.findIndex((a) => a.id === activeArtboardId);
  if (ai < 0) return pages;
  const nextArtboards = [...page.artboards];
  nextArtboards[ai] = {
    ...nextArtboards[ai],
    nodes: mirror.nodes,
    rootIds: mirror.rootIds,
    sourcePrefabPath: mirror.sourcePrefabPath,
  };
  const nextPages = [...pages];
  nextPages[pi] = { ...page, artboards: nextArtboards };
  return nextPages;
}

/**
 * 计算 partial 更新里 nodes/rootIds/sourcePrefabPath 的最终值（用 partial > 旧值 的优先级），
 * 然后把它同步进 pages。返回完整的 partial（含 pages）。
 *
 * 用法：set(s => withMirror(s, { nodes: newNodes }))
 */
function withMirror(
  state: { nodes: Record<string, UINode>; rootIds: string[]; sourcePrefabPath: string | null; pages: PageData[]; activePageId: string; activeArtboardId: string },
  partial: Partial<{ nodes: Record<string, UINode>; rootIds: string[]; sourcePrefabPath: string | null }>
): Partial<{ nodes: Record<string, UINode>; rootIds: string[]; sourcePrefabPath: string | null; pages: PageData[] }> {
  const nextNodes = partial.nodes ?? state.nodes;
  const nextRootIds = partial.rootIds ?? state.rootIds;
  const nextSpp = partial.sourcePrefabPath !== undefined ? partial.sourcePrefabPath : state.sourcePrefabPath;
  const nextPages = flushMirrorToArtboard(state.pages, state.activePageId, state.activeArtboardId, {
    nodes: nextNodes,
    rootIds: nextRootIds,
    sourcePrefabPath: nextSpp,
  });
  return { ...partial, pages: nextPages };
}

/** 把 page.annotations 写回（用于 switchPage 等场景） */
function flushAnnotationsToPage(
  pages: PageData[],
  activePageId: string,
  annotations: Record<string, AnnotationNode>,
  annotationRootIds: string[]
): PageData[] {
  const pi = findPageIndex(pages, activePageId);
  if (pi < 0) return pages;
  const nextPages = [...pages];
  nextPages[pi] = { ...nextPages[pi], annotations, annotationRootIds };
  return nextPages;
}

/** 类似 withMirror，但同步 annotations 到 page 层 */
function withAnnotationMirror(
  state: { annotations: Record<string, AnnotationNode>; annotationRootIds: string[]; pages: PageData[]; activePageId: string },
  partial: Partial<{ annotations: Record<string, AnnotationNode>; annotationRootIds: string[] }>
): Partial<{ annotations: Record<string, AnnotationNode>; annotationRootIds: string[]; pages: PageData[] }> {
  const nextAnn = partial.annotations ?? state.annotations;
  const nextRoots = partial.annotationRootIds ?? state.annotationRootIds;
  const nextPages = flushAnnotationsToPage(state.pages, state.activePageId, nextAnn, nextRoots);
  return { ...partial, pages: nextPages };
}

export const useEditorStore = create<EditorState>((set, get) => {
  let hintTimer: number | null = null;
  const defaultArtboard: Artboard = {
    id: defaultArtboardId,
    name: '画板 1',
    x: 0,
    y: 0,
    width: initialPreviewResolution.width,
    height: initialPreviewResolution.height,
    nodes: {},
    rootIds: [],
    sourcePrefabPath: null,
  };
  const defaultPage: PageData = {
    id: defaultPageId,
    name: '图层 1',
    artboards: [defaultArtboard],
    activeArtboardId: defaultArtboardId,
  };
  return ({
  pages: [defaultPage],
  activePageId: defaultPageId,
  activeArtboardId: defaultArtboardId,
  nodes: {},
  rootIds: [],
  selectedIds: [],
  selectedArtboardId: null,
  hoveredId: null,
  revealInLayerCounter: 0,
  requestRenameCounter: 0,
  prefabListReloadCounter: 0,
  editingTextId: null,
  locateImagePath: null,
  sourcePrefabPath: null,
  canvasX: 0,
  canvasY: 0,
  canvasScale: 1,
  canvasWidth: DESIGN_WIDTH,
  canvasHeight: DESIGN_HEIGHT,
  previewWidth: initialPreviewResolution.width,
  previewHeight: initialPreviewResolution.height,
  history: [],
  historyIndex: -1,
  tool: 'select',
  sceneTool: 'rect',
  rulersVisible: true,
  annotations: {},
  annotationRootIds: [],
  selectedAnnotationIds: [],
  annotationLayerVisible: true,
  grayscaleMode: false,
  annotationTool: null,
  annotationHint: null,
  flowLineDraftSrcId: null,

  addNode: (type, x, y, options = {}) => {
    const state = get();
    state.pushHistory();

    const id = uuid();
    const node: UINode = {
      name: options.name || (type === 'component' ? `@${options.componentRef || 'Component'}` : `${type}_${id.slice(0, 4)}`),
      type,
      x,
      y,
      width: options.width || (type === 'text' ? 200 : type === 'scrollview' ? 400 : type === 'inputfield' ? 300 : 200),
      height: options.height || (type === 'text' ? 40 : type === 'scrollview' ? 300 : type === 'inputfield' ? 50 : type === 'toggle' ? 40 : type === 'button' ? 60 : 150),
      rotation: 0,
      visible: true,
      locked: false,
      children: [],
      parentId: options.parentId || null,
      style: { ...defaultStyle, ...(['frame', 'text', 'image', 'button', 'rawimage', 'toggle'].includes(type) ? { backgroundColor: 'transparent', backgroundOpacity: 0 } : {}), ...(type === 'text' ? { fontSize: 30 } : {}), ...options.style },
      componentRef: options.componentRef,
      text: options.text !== undefined ? options.text : (type === 'text' ? '文本' : undefined),
      fontPath: options.fontPath !== undefined ? options.fontPath : (type === 'text' ? DEFAULT_FONT : undefined),
      alignment: options.alignment !== undefined ? options.alignment : (type === 'text' ? 3 : undefined), // 3 = MiddleLeft
      scrollDirection: options.scrollDirection !== undefined ? options.scrollDirection : (type === 'scrollview' ? 'vertical' : undefined),
      // 新建 text 默认开启 ContentSizeFitter.verticalFit=PreferredSize，使高度跟随文本
      contentSizeFitter: options.contentSizeFitter !== undefined
        ? options.contentSizeFitter
        : (type === 'text' ? { enabled: true, horizontalFit: 0, verticalFit: 2 } : undefined),
      ...options,
      id,  // 确保 id 不被 options 覆盖
    };

    // text + verticalFit 时，初始化 height 为按文本/字号/宽度计算的值
    const fittedNode = autoFitTextHeight(node);

    set((s) => {
      const newNodes = { ...s.nodes, [id]: fittedNode };
      let newRootIds = [...s.rootIds];

      if (fittedNode.parentId && s.nodes[fittedNode.parentId]) {
        const parent = { ...s.nodes[fittedNode.parentId] };
        parent.children = [...parent.children, id];
        newNodes[parent.id] = parent;
      } else {
        fittedNode.parentId = null;
        newRootIds.push(id);
      }

      return withMirror(s, { nodes: newNodes, rootIds: newRootIds });
    });

    return id;
  },

  deleteNode: (id) => {
    const state = get();
    state.pushHistory();

    const collectIds = (nodeId: string): string[] => {
      const node = state.nodes[nodeId];
      if (!node) return [nodeId];
      return [nodeId, ...node.children.flatMap(collectIds)];
    };

    const idsToRemove = new Set(collectIds(id));

    set((s) => {
      const newNodes = { ...s.nodes };
      const node = newNodes[id];

      // 从父节点移除
      if (node?.parentId && newNodes[node.parentId]) {
        const parent = { ...newNodes[node.parentId] };
        parent.children = parent.children.filter((cid) => cid !== id);
        newNodes[parent.id] = parent;
      }

      // 删除所有相关节点
      idsToRemove.forEach((rid) => delete newNodes[rid]);

      return {
        ...withMirror(s, {
          nodes: newNodes,
          rootIds: s.rootIds.filter((rid) => !idsToRemove.has(rid)),
        }),
        selectedIds: s.selectedIds.filter((sid) => !idsToRemove.has(sid)),
      };
    });
  },

  updateNode: (id, updates) => {
    set((s) => {
      const node = s.nodes[id];
      if (!node) return s;
      const merged = autoFitTextHeight({ ...node, ...updates });
      return withMirror(s, { nodes: { ...s.nodes, [id]: merged } });
    });
  },

  updateNodeStyle: (id, style) => {
    set((s) => {
      const node = s.nodes[id];
      if (!node) return s;
      const merged = autoFitTextHeight({ ...node, style: { ...node.style, ...style } });
      return withMirror(s, { nodes: { ...s.nodes, [id]: merged } });
    });
  },

  moveNode: (id, x, y) => {
    set((s) => {
      const node = s.nodes[id];
      if (!node) return s;
      return withMirror(s, { nodes: { ...s.nodes, [id]: { ...node, x, y, originalAnchoredPosition: undefined } } });
    });
  },

  resizeNode: (id, width, height) => {
    set((s) => {
      const node = s.nodes[id];
      if (!node) return s;
      return withMirror(s, {
        nodes: { ...s.nodes, [id]: { ...node, width: Math.max(1, width), height: Math.max(1, height), originalSizeDelta: undefined } },
      });
    });
  },

  reparentNode: (id, newParentId, index) => {
    const state = get();
    state.pushHistory();

    set((s) => {
      const node = s.nodes[id];
      if (!node) return s;

      const newNodes = { ...s.nodes };
      let newRootIds = [...s.rootIds];

      // 计算节点的绝对坐标
      const getAbsolutePos = (nodeId: string): { x: number; y: number } => {
        let ax = 0, ay = 0;
        let current = newNodes[nodeId];
        while (current) {
          ax += current.x;
          ay += current.y;
          current = current.parentId ? newNodes[current.parentId] : undefined as any;
        }
        return { x: ax, y: ay };
      };

      const absPos = getAbsolutePos(id);

      // 从旧父节点移除
      if (node.parentId && newNodes[node.parentId]) {
        const oldParent = { ...newNodes[node.parentId] };
        oldParent.children = oldParent.children.filter((c) => c !== id);
        newNodes[oldParent.id] = oldParent;
      } else {
        newRootIds = newRootIds.filter((r) => r !== id);
      }

      // 添加到新父节点
      if (newParentId && newNodes[newParentId]) {
        const newParent = { ...newNodes[newParentId] };
        if (index !== undefined) {
          newParent.children = [...newParent.children];
          newParent.children.splice(index, 0, id);
        } else {
          newParent.children = [...newParent.children, id];
        }
        newNodes[newParent.id] = newParent;

        // 转换为相对于新父节点的坐标
        const parentAbs = getAbsolutePos(newParentId);
        newNodes[id] = { ...node, parentId: newParentId, x: absPos.x - parentAbs.x, y: absPos.y - parentAbs.y };
      } else {
        newParentId = null;
        if (index !== undefined) {
          newRootIds.splice(index, 0, id);
        } else {
          newRootIds.push(id);
        }
        // 回到根层，x/y 就是绝对坐标
        newNodes[id] = { ...node, parentId: newParentId, x: absPos.x, y: absPos.y };
      }

      return withMirror(s, { nodes: newNodes, rootIds: newRootIds });
    });
  },

  reorderNode: (id, direction) => {
    const state = get();
    state.pushHistory();

    set((s) => {
      const node = s.nodes[id];
      if (!node) return s;

      const newNodes = { ...s.nodes };

      if (node.parentId && newNodes[node.parentId]) {
        const parent = { ...newNodes[node.parentId] };
        const arr = [...parent.children];
        const idx = arr.indexOf(id);
        if (idx < 0) return s;
        let newIdx: number;
        if (direction === 'up') newIdx = idx - 1;
        else if (direction === 'down') newIdx = idx + 1;
        else if (direction === 'top') newIdx = 0;
        else newIdx = arr.length - 1;
        if (newIdx < 0 || newIdx >= arr.length || newIdx === idx) return s;
        arr.splice(idx, 1);
        arr.splice(newIdx, 0, id);
        parent.children = arr;
        newNodes[parent.id] = parent;
      } else {
        const arr = [...s.rootIds];
        const idx = arr.indexOf(id);
        if (idx < 0) return s;
        let newIdx: number;
        if (direction === 'up') newIdx = idx - 1;
        else if (direction === 'down') newIdx = idx + 1;
        else if (direction === 'top') newIdx = 0;
        else newIdx = arr.length - 1;
        if (newIdx < 0 || newIdx >= arr.length || newIdx === idx) return s;
        arr.splice(idx, 1);
        arr.splice(newIdx, 0, id);
        return withMirror(s, { nodes: newNodes, rootIds: arr });
      }

      return withMirror(s, { nodes: newNodes });
    });
  },

  groupSelected: () => {
    const state = get();
    const ids = state.selectedIds;
    if (ids.length === 0) return null;
    const nodes = ids.map((id) => state.nodes[id]).filter(Boolean) as UINode[];
    if (nodes.length === 0) return null;
    // 必须同父级，否则跨层级编组无意义
    const parentId = nodes[0].parentId;
    if (!nodes.every((n) => n.parentId === parentId)) return null;

    // 计算 bbox（父坐标系下）
    const minX = Math.min(...nodes.map((n) => n.x));
    const minY = Math.min(...nodes.map((n) => n.y));
    const maxX = Math.max(...nodes.map((n) => n.x + n.width));
    const maxY = Math.max(...nodes.map((n) => n.y + n.height));

    state.pushHistory();

    const groupId = uuid();
    const groupNode: UINode = {
      id: groupId,
      name: `Group_${groupId.slice(0, 4)}`,
      type: 'frame',
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
      rotation: 0,
      visible: true,
      locked: false,
      children: [],
      parentId: parentId,
      style: { ...defaultStyle, backgroundColor: 'transparent', backgroundOpacity: 0 },
    };

    set((s) => {
      const newNodes: Record<string, UINode> = { ...s.nodes, [groupId]: groupNode };
      let newRootIds = [...s.rootIds];

      // 保持原顺序：以父级 children/rootIds 里第一个被选中的位置作为插入点
      const sourceArr = parentId && newNodes[parentId] ? [...newNodes[parentId].children] : newRootIds;
      const idSet = new Set(ids);
      const insertIdx = sourceArr.findIndex((cid) => idSet.has(cid));
      // 从原位置移除选中项，再把 groupId 插进去
      const remaining = sourceArr.filter((cid) => !idSet.has(cid));
      const safeInsert = Math.max(0, Math.min(insertIdx, remaining.length));
      remaining.splice(safeInsert, 0, groupId);

      if (parentId && newNodes[parentId]) {
        newNodes[parentId] = { ...newNodes[parentId], children: remaining };
      } else {
        newRootIds = remaining;
      }

      // group 收纳选中节点，坐标转换为相对 group
      const orderedIds = ids
        .map((id) => ({ id, idx: sourceArr.indexOf(id) }))
        .filter((x) => x.idx >= 0)
        .sort((a, b) => a.idx - b.idx)
        .map((x) => x.id);
      orderedIds.forEach((cid) => {
        const c = newNodes[cid];
        if (!c) return;
        newNodes[cid] = { ...c, parentId: groupId, x: c.x - minX, y: c.y - minY };
      });
      newNodes[groupId] = { ...newNodes[groupId], children: orderedIds };

      return {
        ...withMirror(s, { nodes: newNodes, rootIds: newRootIds }),
        selectedIds: [groupId],
      };
    });

    return groupId;
  },

  ungroupSelected: () => {
    const state = get();
    const ids = state.selectedIds;
    if (ids.length === 0) return;
    // 仅对 frame 类型解组
    const targets = ids
      .map((id) => state.nodes[id])
      .filter((n) => n && n.type === 'frame' && n.children.length > 0) as UINode[];
    if (targets.length === 0) return;

    state.pushHistory();

    set((s) => {
      const newNodes = { ...s.nodes };
      let newRootIds = [...s.rootIds];
      const newSelected: string[] = [];

      targets.forEach((group) => {
        const g = newNodes[group.id];
        if (!g) return;
        const childIds = [...g.children];

        // 父级数组：把 group 的位置替换为它的子节点序列
        const parentId = g.parentId;
        const arr = parentId && newNodes[parentId] ? [...newNodes[parentId].children] : newRootIds;
        const idx = arr.indexOf(g.id);
        if (idx >= 0) {
          arr.splice(idx, 1, ...childIds);
        }
        if (parentId && newNodes[parentId]) {
          newNodes[parentId] = { ...newNodes[parentId], children: arr };
        } else {
          newRootIds = arr;
        }

        // 子节点坐标：从 group 局部转回父级局部（加上 group.x/y）
        childIds.forEach((cid) => {
          const c = newNodes[cid];
          if (!c) return;
          newNodes[cid] = { ...c, parentId: parentId, x: c.x + g.x, y: c.y + g.y };
          newSelected.push(cid);
        });

        delete newNodes[group.id];
      });

      return {
        ...withMirror(s, { nodes: newNodes, rootIds: newRootIds }),
        selectedIds: newSelected,
      };
    });
  },

  setSelectedIds: (ids) => set((s) => ({
    selectedIds: ids,
    selectedArtboardId: ids.length > 0 ? null : s.selectedArtboardId,
    selectedAnnotationIds: ids.length > 0 ? [] : s.selectedAnnotationIds,
  })),
  setSelectedArtboardId: (id) => set((s) => ({
    selectedArtboardId: id,
    selectedIds: id ? [] : s.selectedIds,
    selectedAnnotationIds: id ? [] : s.selectedAnnotationIds,
  })),
  setHoveredId: (id) => set({ hoveredId: id }),
  setEditingTextId: (id) => set({ editingTextId: id }),
  setLocateImagePath: (p: string | null) => set({ locateImagePath: p }),
  setSourcePrefabPath: (p: string | null) => set((s) => withMirror(s, { sourcePrefabPath: p })),
  revealSelectedInLayer: () => set((s) => ({ revealInLayerCounter: s.revealInLayerCounter + 1 })),
  requestRenameSelected: () => set((s) => ({ requestRenameCounter: s.requestRenameCounter + 1 })),
  requestPrefabListReload: () => set((s) => ({ prefabListReloadCounter: s.prefabListReloadCounter + 1 })),
  setTool: (tool) => set({ tool }),
  setSceneTool: (sceneTool) => set({ sceneTool, tool: 'select' }),
  toggleRulers: () => set((s) => ({ rulersVisible: !s.rulersVisible })),

  setCanvasTransform: (x, y, scale) =>
    set({ canvasX: x, canvasY: y, canvasScale: Math.max(0.1, Math.min(5, scale)) }),

  setPreviewResolution: (w, h) => {
    persistPreviewResolutionPreference(w, h);
    set((s) => {
      const oldW = s.previewWidth;
      const oldH = s.previewHeight;
      if (oldW === w && oldH === h) {
        const pagesNeedSizeSync = s.pages.some((page) =>
          page.artboards.some((artboard) => artboard.width !== w || artboard.height !== h)
        );
        if (!pagesNeedSizeSync) return { previewWidth: w, previewHeight: h };
        const syncedPages = s.pages.map((page) => ({
          ...page,
          artboards: page.artboards.map((artboard) => ({ ...artboard, width: w, height: h })),
        }));
        const activePage = syncedPages.find((page) => page.id === s.activePageId);
        const activeArtboard = activePage?.artboards.find((artboard) => artboard.id === s.activeArtboardId);
        return {
          pages: syncedPages,
          nodes: activeArtboard?.nodes ?? s.nodes,
          rootIds: activeArtboard?.rootIds ?? s.rootIds,
          sourcePrefabPath: activeArtboard?.sourcePrefabPath ?? s.sourcePrefabPath,
          previewWidth: w,
          previewHeight: h,
        };
      }

      const flushedPages = flushAnnotationsToPage(
        flushMirrorToArtboard(s.pages, s.activePageId, s.activeArtboardId, {
          nodes: s.nodes, rootIds: s.rootIds, sourcePrefabPath: s.sourcePrefabPath,
        }),
        s.activePageId, s.annotations, s.annotationRootIds
      );

      const nextPages = flushedPages.map((page) => ({
        ...page,
        artboards: page.artboards.map((artboard) => ({
          ...artboard,
          width: w,
          height: h,
          nodes: adaptNodesForPreviewResolution(artboard.nodes, artboard.rootIds, oldW, oldH, w, h),
        })),
      }));
      const activePage = nextPages.find((page) => page.id === s.activePageId);
      const activeArtboard = activePage?.artboards.find((artboard) => artboard.id === s.activeArtboardId);

      return {
        pages: nextPages,
        nodes: activeArtboard?.nodes ?? s.nodes,
        rootIds: activeArtboard?.rootIds ?? s.rootIds,
        sourcePrefabPath: activeArtboard?.sourcePrefabPath ?? s.sourcePrefabPath,
        previewWidth: w,
        previewHeight: h,
      };
    });
  },

  pushHistory: () => {
    set((s) => {
      // 先把当前镜像 flush 进 pages,保证快照是最新值
      const flushedPages = flushAnnotationsToPage(
        flushMirrorToArtboard(s.pages, s.activePageId, s.activeArtboardId, {
          nodes: s.nodes, rootIds: s.rootIds, sourcePrefabPath: s.sourcePrefabPath,
        }),
        s.activePageId, s.annotations, s.annotationRootIds
      );
      const activePage = flushedPages.find((p) => p.id === s.activePageId);
      const entry: HistoryEntry = {
        artboards: activePage ? structuredClone(activePage.artboards) : [],
        activeArtboardId: s.activeArtboardId,
        annotations: structuredClone(s.annotations),
        annotationRootIds: [...s.annotationRootIds],
      };
      const newHistory = s.history.slice(0, s.historyIndex + 1);
      newHistory.push(entry);
      if (newHistory.length > 50) newHistory.shift();
      return { history: newHistory, historyIndex: newHistory.length - 1, pages: flushedPages };
    });
  },

  undo: () => {
    set((s) => {
      if (s.historyIndex < 0) return s;
      const entry = s.history[s.historyIndex];
      const targetArtboard = entry.artboards.find((a) => a.id === entry.activeArtboardId) ?? entry.artboards[0];
      if (!targetArtboard) return s;
      const pi = findPageIndex(s.pages, s.activePageId);
      const nextPages = [...s.pages];
      if (pi >= 0) {
        nextPages[pi] = {
          ...nextPages[pi],
          artboards: structuredClone(entry.artboards),
          activeArtboardId: entry.activeArtboardId,
          annotations: entry.annotations,
          annotationRootIds: [...entry.annotationRootIds],
        };
      }
      return {
        pages: nextPages,
        activeArtboardId: entry.activeArtboardId,
        nodes: targetArtboard.nodes,
        rootIds: [...targetArtboard.rootIds],
        sourcePrefabPath: targetArtboard.sourcePrefabPath,
        annotations: entry.annotations ?? {},
        annotationRootIds: [...(entry.annotationRootIds ?? [])],
        historyIndex: s.historyIndex - 1,
        selectedIds: [],
        selectedArtboardId: null,
        selectedAnnotationIds: [],
      };
    });
  },

  redo: () => {
    set((s) => {
      if (s.historyIndex >= s.history.length - 1) return s;
      const entry = s.history[s.historyIndex + 1];
      const targetArtboard = entry.artboards.find((a) => a.id === entry.activeArtboardId) ?? entry.artboards[0];
      if (!targetArtboard) return s;
      const pi = findPageIndex(s.pages, s.activePageId);
      const nextPages = [...s.pages];
      if (pi >= 0) {
        nextPages[pi] = {
          ...nextPages[pi],
          artboards: structuredClone(entry.artboards),
          activeArtboardId: entry.activeArtboardId,
          annotations: entry.annotations,
          annotationRootIds: [...entry.annotationRootIds],
        };
      }
      return {
        pages: nextPages,
        activeArtboardId: entry.activeArtboardId,
        nodes: targetArtboard.nodes,
        rootIds: [...targetArtboard.rootIds],
        sourcePrefabPath: targetArtboard.sourcePrefabPath,
        annotations: entry.annotations ?? {},
        annotationRootIds: [...(entry.annotationRootIds ?? [])],
        historyIndex: s.historyIndex + 1,
        selectedIds: [],
        selectedArtboardId: null,
        selectedAnnotationIds: [],
      };
    });
  },

  loadDocument: (nodes, rootIds) => {
    set((s) => ({
      ...withMirror(s, { nodes, rootIds }),
      selectedIds: [],
      selectedArtboardId: null,
      history: [],
      historyIndex: -1,
    }));
  },

  clearAll: () => {
    const state = get();
    state.pushHistory();
    set((s) => ({
      ...withMirror(s, { nodes: {}, rootIds: [] }),
      selectedIds: [],
      selectedArtboardId: null,
    }));
  },

  // ===== 图层操作 =====

  addPage: (name) => {
    const state = get();
    // 先 flush 当前镜像到 pages
    const flushedPages = flushAnnotationsToPage(
      flushMirrorToArtboard(state.pages, state.activePageId, state.activeArtboardId, {
        nodes: state.nodes, rootIds: state.rootIds, sourcePrefabPath: state.sourcePrefabPath,
      }),
      state.activePageId, state.annotations, state.annotationRootIds
    );

    const newPageId = uuid();
    const newArtboardId = uuid();
    const newArtboard: Artboard = {
      id: newArtboardId,
      name: '画板 1',
      x: 0, y: 0, width: state.previewWidth, height: state.previewHeight,
      nodes: {}, rootIds: [], sourcePrefabPath: null,
    };
    const newPage: PageData = {
      id: newPageId,
      name: name || `图层 ${flushedPages.length + 1}`,
      artboards: [newArtboard],
      activeArtboardId: newArtboardId,
      annotations: {},
      annotationRootIds: [],
    };

    set({
      pages: [...flushedPages, newPage],
      activePageId: newPageId,
      activeArtboardId: newArtboardId,
      nodes: {},
      rootIds: [],
      sourcePrefabPath: null,
      annotations: {},
      annotationRootIds: [],
      selectedIds: [],
      selectedArtboardId: null,
      selectedAnnotationIds: [],
      history: [],
      historyIndex: -1,
    });
    return newPageId;
  },

  deletePage: (pageId) => {
    const state = get();
    if (state.pages.length <= 1) return; // 至少保留一个

    const newPages = state.pages.filter((p) => p.id !== pageId);
    if (state.activePageId === pageId) {
      // 切到第一个
      const first = newPages[0];
      const firstArtboard = first.artboards.find((a) => a.id === first.activeArtboardId) ?? first.artboards[0];
      set({
        pages: newPages,
        activePageId: first.id,
        activeArtboardId: firstArtboard.id,
        nodes: { ...firstArtboard.nodes },
        rootIds: [...firstArtboard.rootIds],
        sourcePrefabPath: firstArtboard.sourcePrefabPath,
        annotations: { ...(first.annotations ?? {}) },
        annotationRootIds: [...(first.annotationRootIds ?? [])],
        selectedIds: [],
        selectedArtboardId: null,
        selectedAnnotationIds: [],
        history: [],
        historyIndex: -1,
      });
    } else {
      set({ pages: newPages });
    }
  },

  renamePage: (pageId, name) => {
    set((s) => ({
      pages: s.pages.map((p) => (p.id === pageId ? { ...p, name } : p)),
    }));
  },

  switchPage: (pageId) => {
    const state = get();
    if (pageId === state.activePageId) return;

    // 先把当前镜像 flush 进 pages
    const flushedPages = flushAnnotationsToPage(
      flushMirrorToArtboard(state.pages, state.activePageId, state.activeArtboardId, {
        nodes: state.nodes, rootIds: state.rootIds, sourcePrefabPath: state.sourcePrefabPath,
      }),
      state.activePageId, state.annotations, state.annotationRootIds
    );

    const target = flushedPages.find((p) => p.id === pageId);
    if (!target) return;
    const targetArtboard = target.artboards.find((a) => a.id === target.activeArtboardId) ?? target.artboards[0];
    if (!targetArtboard) return;

    set({
      pages: flushedPages,
      activePageId: pageId,
      activeArtboardId: targetArtboard.id,
      nodes: { ...targetArtboard.nodes },
      rootIds: [...targetArtboard.rootIds],
      sourcePrefabPath: targetArtboard.sourcePrefabPath,
      annotations: { ...(target.annotations ?? {}) },
      annotationRootIds: [...(target.annotationRootIds ?? [])],
      selectedIds: [],
      selectedArtboardId: null,
      selectedAnnotationIds: [],
      history: [],
      historyIndex: -1,
    });
  },

  duplicatePage: (pageId) => {
    const state = get();
    // 先 flush 镜像
    const flushedPages = flushAnnotationsToPage(
      flushMirrorToArtboard(state.pages, state.activePageId, state.activeArtboardId, {
        nodes: state.nodes, rootIds: state.rootIds, sourcePrefabPath: state.sourcePrefabPath,
      }),
      state.activePageId, state.annotations, state.annotationRootIds
    );

    const source = flushedPages.find((p) => p.id === pageId);
    if (!source) return '';

    // 复制每个画板时重新分配 artboard id（避免冲突）
    const idMap = new Map<string, string>();
    const newArtboards: Artboard[] = source.artboards.map((a) => {
      const nid = uuid();
      idMap.set(a.id, nid);
      return {
        ...structuredClone(a),
        id: nid,
      };
    });

    const newPageId = uuid();
    const newPage: PageData = {
      id: newPageId,
      name: source.name + ' 副本',
      artboards: newArtboards,
      activeArtboardId: idMap.get(source.activeArtboardId) ?? newArtboards[0].id,
      annotations: structuredClone(source.annotations ?? {}),
      annotationRootIds: [...(source.annotationRootIds ?? [])],
      pageGroup: source.pageGroup,
    };

    const newActiveArtboard = newPage.artboards.find((a) => a.id === newPage.activeArtboardId) ?? newPage.artboards[0];

    set({
      pages: [...flushedPages, newPage],
      activePageId: newPageId,
      activeArtboardId: newActiveArtboard.id,
      nodes: structuredClone(newActiveArtboard.nodes),
      rootIds: [...newActiveArtboard.rootIds],
      sourcePrefabPath: newActiveArtboard.sourcePrefabPath,
      annotations: structuredClone(newPage.annotations ?? {}),
      annotationRootIds: [...(newPage.annotationRootIds ?? [])],
      selectedIds: [],
      selectedArtboardId: null,
      selectedAnnotationIds: [],
      history: [],
      historyIndex: -1,
    });
    return newPageId;
  },

  reorderPages: (sourceId, targetId, position) => {
    if (sourceId === targetId) return;
    set((s) => {
      const list = [...s.pages];
      const fromIdx = list.findIndex((p) => p.id === sourceId);
      if (fromIdx < 0) return {};
      const [moved] = list.splice(fromIdx, 1);
      let toIdx = list.findIndex((p) => p.id === targetId);
      if (toIdx < 0) return {};
      if (position === 'after') toIdx += 1;
      list.splice(toIdx, 0, moved);
      return { pages: list };
    });
  },

  // ===== 画板操作 =====

  addArtboard: (options) => {
    const state = get();
    const pageId = options?.pageId ?? state.activePageId;
    // flush 当前镜像
    const flushedPages = flushAnnotationsToPage(
      flushMirrorToArtboard(state.pages, state.activePageId, state.activeArtboardId, {
        nodes: state.nodes, rootIds: state.rootIds, sourcePrefabPath: state.sourcePrefabPath,
      }),
      state.activePageId, state.annotations, state.annotationRootIds
    );
    const pi = findPageIndex(flushedPages, pageId);
    if (pi < 0) return '';
    const page = flushedPages[pi];

    const newId = uuid();
    const existing = page.artboards;
    // 默认位置：放最后一个画板下方 200px 间距（纵向排布）
    const last = existing[existing.length - 1];
    const defaultX = last ? last.x : 0;
    const defaultY = last ? last.y + last.height + 200 : 0;

    const newArtboard: Artboard = {
      id: newId,
      name: options?.name ?? `画板 ${existing.length + 1}`,
      x: options?.x ?? defaultX,
      y: options?.y ?? defaultY,
      width: get().previewWidth,
      height: get().previewHeight,
      nodes: {},
      rootIds: [],
      sourcePrefabPath: null,
    };
    const nextPages = [...flushedPages];
    nextPages[pi] = { ...page, artboards: [...existing, newArtboard], activeArtboardId: newId };

    // 只有在添加到当前 active page 时才切镜像
    if (pageId === state.activePageId) {
      set({
        pages: nextPages,
        activeArtboardId: newId,
        nodes: {},
        rootIds: [],
        sourcePrefabPath: null,
        selectedIds: [],
        selectedArtboardId: newId,
        selectedAnnotationIds: [],
      });
    } else {
      set({ pages: nextPages });
    }
    return newId;
  },

  deleteArtboard: (artboardId, pageId) => {
    const state = get();
    const targetPageId = pageId ?? state.activePageId;
    const pi = findPageIndex(state.pages, targetPageId);
    if (pi < 0) return;
    const page = state.pages[pi];
    if (page.artboards.length <= 1) return; // 至少保留一个

    state.pushHistory();

    set((s) => {
      const pIdx = findPageIndex(s.pages, targetPageId);
      if (pIdx < 0) return {};
      const p = s.pages[pIdx];
      const newArtboards = p.artboards.filter((a) => a.id !== artboardId);
      // 如果删的是 active 画板，选新的 active
      let newActiveArtboardId = p.activeArtboardId;
      if (p.activeArtboardId === artboardId) {
        newActiveArtboardId = newArtboards[0].id;
      }
      // 同时清掉指向该画板内节点的 annotation —— 简单做法：annotation 暂不持有 artboard 引用,首期不清理
      const nextPages = [...s.pages];
      nextPages[pIdx] = { ...p, artboards: newArtboards, activeArtboardId: newActiveArtboardId };

      // 如果删的画板属于当前 active page,且影响到 active artboard,同步镜像
      if (targetPageId === s.activePageId && s.activeArtboardId === artboardId) {
        const newActive = newArtboards.find((a) => a.id === newActiveArtboardId)!;
        return {
          pages: nextPages,
          activeArtboardId: newActive.id,
          nodes: { ...newActive.nodes },
          rootIds: [...newActive.rootIds],
          sourcePrefabPath: newActive.sourcePrefabPath,
          selectedIds: [],
          selectedArtboardId: null,
        };
      }
      return { pages: nextPages, selectedArtboardId: s.selectedArtboardId === artboardId ? null : s.selectedArtboardId };
    });
  },

  renameArtboard: (artboardId, name, pageId) => {
    set((s) => {
      const targetPageId = pageId ?? s.activePageId;
      const pi = findPageIndex(s.pages, targetPageId);
      if (pi < 0) return {};
      const p = s.pages[pi];
      const nextArtboards = p.artboards.map((a) => a.id === artboardId ? { ...a, name } : a);
      const nextPages = [...s.pages];
      nextPages[pi] = { ...p, artboards: nextArtboards };
      return { pages: nextPages };
    });
  },

  setActiveArtboard: (artboardId) => {
    const state = get();
    if (state.activeArtboardId === artboardId) return;
    // flush 当前镜像
    const flushedPages = flushMirrorToArtboard(state.pages, state.activePageId, state.activeArtboardId, {
      nodes: state.nodes, rootIds: state.rootIds, sourcePrefabPath: state.sourcePrefabPath,
    });
    const page = flushedPages.find((p) => p.id === state.activePageId);
    if (!page) return;
    const target = page.artboards.find((a) => a.id === artboardId);
    if (!target) return;

    // 同时更新 page.activeArtboardId
    const pi = findPageIndex(flushedPages, state.activePageId);
    const nextPages = [...flushedPages];
    nextPages[pi] = { ...page, activeArtboardId: artboardId };

    set({
      pages: nextPages,
      activeArtboardId: artboardId,
      nodes: { ...target.nodes },
      rootIds: [...target.rootIds],
      sourcePrefabPath: target.sourcePrefabPath,
      selectedIds: [],
      selectedArtboardId: null,
    });
  },

  duplicateArtboard: (artboardId, pageId) => {
    const state = get();
    const targetPageId = pageId ?? state.activePageId;
    // flush 镜像
    const flushedPages = flushMirrorToArtboard(state.pages, state.activePageId, state.activeArtboardId, {
      nodes: state.nodes, rootIds: state.rootIds, sourcePrefabPath: state.sourcePrefabPath,
    });
    const pi = findPageIndex(flushedPages, targetPageId);
    if (pi < 0) return '';
    const p = flushedPages[pi];
    const src = p.artboards.find((a) => a.id === artboardId);
    if (!src) return '';

    const newId = uuid();
    const copy: Artboard = {
      ...structuredClone(src),
      id: newId,
      name: src.name + ' 副本',
      x: src.x,
      y: src.y + src.height + 200,
    };
    const nextPages = [...flushedPages];
    nextPages[pi] = { ...p, artboards: [...p.artboards, copy] };
    set({ pages: nextPages });
    return newId;
  },

  updateArtboard: (artboardId, patch, pageId) => {
    set((s) => {
      const targetPageId = pageId ?? s.activePageId;
      const pi = findPageIndex(s.pages, targetPageId);
      if (pi < 0) return {};
      const p = s.pages[pi];
      const nextArtboards = p.artboards.map((a) => a.id === artboardId ? { ...a, ...patch } : a);
      const nextPages = [...s.pages];
      nextPages[pi] = { ...p, artboards: nextArtboards };
      // 如果改的是 active 画板的 sourcePrefabPath，同步镜像
      if (targetPageId === s.activePageId && artboardId === s.activeArtboardId && patch.sourcePrefabPath !== undefined) {
        return { pages: nextPages, sourcePrefabPath: patch.sourcePrefabPath ?? null };
      }
      return { pages: nextPages };
    });
  },

  addAnnotation: (type, x, y, partial) => {
    const id = uuid();
    const ann = createAnnotation(type, id, x, y, partial);
    get().pushHistory();
    set((s) => {
      // number 自动递增 — 在 set 回调内读 s,避免并发重号
      if (type === 'number' && partial?.badgeNumber === undefined) {
        const maxN = Object.values(s.annotations)
          .filter((a) => a.type === 'number')
          .reduce((m, a) => Math.max(m, a.badgeNumber ?? 0), 0);
        ann.badgeNumber = maxN + 1;
      }
      return withAnnotationMirror(s, {
        annotations: { ...s.annotations, [id]: ann },
        annotationRootIds: [...s.annotationRootIds, id],
      });
    });
    return id;
  },

  updateAnnotation: (id, patch) => {
    set((s) => {
      const cur = s.annotations[id];
      if (!cur) return {};
      return withAnnotationMirror(s, { annotations: { ...s.annotations, [id]: { ...cur, ...patch } } });
    });
  },

  deleteAnnotation: (id) => {
    const s0 = get();
    if (!s0.annotations[id]) return;
    s0.pushHistory();
    set((s) => {
      const next = { ...s.annotations };
      delete next[id];
      return {
        ...withAnnotationMirror(s, {
          annotations: next,
          annotationRootIds: s.annotationRootIds.filter((x) => x !== id),
        }),
        selectedAnnotationIds: s.selectedAnnotationIds.filter((x) => x !== id),
      };
    });
  },

  clearAllAnnotations: () => {
    const s = get();
    if (s.annotationRootIds.length === 0) return;
    s.pushHistory();
    set((st) => ({
      ...withAnnotationMirror(st, { annotations: {}, annotationRootIds: [] }),
      selectedAnnotationIds: [],
    }));
  },

  duplicateAnnotation: (id) => {
    const state = get();
    const src = state.annotations[id];
    if (!src) return '';
    const newId = uuid();
    const copy: AnnotationNode = { ...src, id: newId, x: src.x + 16, y: src.y + 16 };
    set((s) => withAnnotationMirror(s, {
      annotations: { ...s.annotations, [newId]: copy },
      annotationRootIds: [...s.annotationRootIds, newId],
    }));
    return newId;
  },

  setSelectedAnnotationIds: (ids) => {
    set((s) => ({
      selectedAnnotationIds: ids,
      selectedIds: ids.length > 0 ? [] : s.selectedIds,
      selectedArtboardId: ids.length > 0 ? null : s.selectedArtboardId,
    }));
  },

  toggleAnnotationLayer: () => {
    set((s) => ({ annotationLayerVisible: !s.annotationLayerVisible }));
  },

  toggleGrayscaleMode: () => {
    set((s) => ({ grayscaleMode: !s.grayscaleMode }));
  },

  setAnnotationHint: (msg, autoClearMs) => {
    if (hintTimer != null) {
      clearTimeout(hintTimer);
      hintTimer = null;
    }
    set({ annotationHint: msg });
    if (msg && autoClearMs && autoClearMs > 0) {
      hintTimer = window.setTimeout(() => {
        set({ annotationHint: null });
        hintTimer = null;
      }, autoClearMs);
    }
  },

  setFlowLineDraftSrcId: (id) => {
    set({ flowLineDraftSrcId: id });
  },

  setAnnotationTool: (tool) => {
    if (hintTimer != null) {
      clearTimeout(hintTimer);
      hintTimer = null;
    }
    set({ annotationTool: tool, annotationHint: null, flowLineDraftSrcId: null });
  },

  setPageGroup: (pageId, group) => {
    set((s) => ({
      pages: s.pages.map((p) => (p.id === pageId ? { ...p, pageGroup: group } : p)),
    }));
  },

  addSidebarBlock: (pageId, type, partial, artboardId) => {
    const id = uuid();
    const block: SidebarBlock = {
      id,
      type,
      text: type === 'tag' ? '' : (type === 'inset-image' ? undefined : ''),
      role: type === 'tag' ? 'program' : undefined,
      ...partial,
    };
    set((s) => ({
      pages: s.pages.map((p) => {
        if (p.id !== pageId) return p;
        const targetAbId = artboardId ?? p.activeArtboardId;
        const nextArtboards = p.artboards.map((a) =>
          a.id === targetAbId ? { ...a, sidebar: [...(a.sidebar ?? []), block] } : a
        );
        return { ...p, artboards: nextArtboards };
      }),
    }));
    return id;
  },

  updateSidebarBlock: (pageId, blockId, patch, artboardId) => {
    set((s) => ({
      pages: s.pages.map((p) => {
        if (p.id !== pageId) return p;
        const targetAbId = artboardId ?? p.activeArtboardId;
        const nextArtboards = p.artboards.map((a) => {
          if (a.id !== targetAbId || !a.sidebar) return a;
          return {
            ...a,
            sidebar: a.sidebar.map((b) => (b.id === blockId ? { ...b, ...patch } : b)),
          };
        });
        return { ...p, artboards: nextArtboards };
      }),
    }));
  },

  deleteSidebarBlock: (pageId, blockId, artboardId) => {
    set((s) => ({
      pages: s.pages.map((p) => {
        if (p.id !== pageId) return p;
        const targetAbId = artboardId ?? p.activeArtboardId;
        const nextArtboards = p.artboards.map((a) => {
          if (a.id !== targetAbId || !a.sidebar) return a;
          return { ...a, sidebar: a.sidebar.filter((b) => b.id !== blockId) };
        });
        return { ...p, artboards: nextArtboards };
      }),
    }));
  },

  reorderSidebarBlock: (pageId, blockId, direction, artboardId) => {
    set((s) => ({
      pages: s.pages.map((p) => {
        if (p.id !== pageId) return p;
        const targetAbId = artboardId ?? p.activeArtboardId;
        const nextArtboards = p.artboards.map((a) => {
          if (a.id !== targetAbId || !a.sidebar) return a;
          const idx = a.sidebar.findIndex((b) => b.id === blockId);
          if (idx < 0) return a;
          const newIdx = direction === 'up' ? idx - 1 : idx + 1;
          if (newIdx < 0 || newIdx >= a.sidebar.length) return a;
          const list = [...a.sidebar];
          const [moved] = list.splice(idx, 1);
          list.splice(newIdx, 0, moved);
          return { ...a, sidebar: list };
        });
        return { ...p, artboards: nextArtboards };
      }),
    }));
  },

  toggleSidebarEnabled: (pageId, artboardId) => {
    set((s) => ({
      pages: s.pages.map((p) => {
        if (p.id !== pageId) return p;
        const targetAbId = artboardId ?? p.activeArtboardId;
        const nextArtboards = p.artboards.map((a) =>
          a.id === targetAbId ? { ...a, sidebarEnabled: !a.sidebarEnabled } : a
        );
        return { ...p, artboards: nextArtboards };
      }),
    }));
  },

  // ===== 保存/加载 =====

  saveToLocal: (slotName = 'default') => {
    const state = get();
    // flush 当前镜像到 pages
    const pages = flushAnnotationsToPage(
      flushMirrorToArtboard(state.pages, state.activePageId, state.activeArtboardId, {
        nodes: state.nodes, rootIds: state.rootIds, sourcePrefabPath: state.sourcePrefabPath,
      }),
      state.activePageId, state.annotations, state.annotationRootIds
    );
    const data = {
      pages,
      activePageId: state.activePageId,
      previewWidth: state.previewWidth,
      previewHeight: state.previewHeight,
      savedAt: new Date().toISOString(),
    };
    const serialized = JSON.stringify(data);
    localStorage.setItem(`uieditor_save_${slotName}`, serialized);

    const slots: string[] = JSON.parse(localStorage.getItem('uieditor_slots') || '[]');
    if (!slots.includes(slotName)) {
      slots.push(slotName);
      localStorage.setItem('uieditor_slots', JSON.stringify(slots));
    }

    // fire-and-forget 同步到本地文件（dev server）
    fetch(`/api/save/${encodeURIComponent(slotName)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: serialized,
    }).catch(() => { /* 离线/无 dev server 时静默 */ });
  },

  loadFromLocal: (slotName = 'default') => {
    const raw = localStorage.getItem(`uieditor_save_${slotName}`);
    if (!raw) return false;
    try {
      const data = JSON.parse(raw);
      const savedPreviewWidth = Number(data.previewWidth);
      const savedPreviewHeight = Number(data.previewHeight);
      const hasSavedPreviewResolution = Number.isFinite(savedPreviewWidth) && Number.isFinite(savedPreviewHeight) && savedPreviewWidth > 0 && savedPreviewHeight > 0;
      // 启动时自动恢复 _autosave 不能覆盖用户刚切换的预览方向；横竖屏偏好由独立 key 负责跨刷新保留。
      const shouldRestoreSavedPreview = slotName !== '_autosave' && hasSavedPreviewResolution;
      const previewPatch: Partial<Pick<EditorState, 'previewWidth' | 'previewHeight'>> = shouldRestoreSavedPreview
        ? { previewWidth: savedPreviewWidth, previewHeight: savedPreviewHeight }
        : {};
      if (shouldRestoreSavedPreview) {
        persistPreviewResolutionPreference(savedPreviewWidth, savedPreviewHeight);
      }

      // 兼容超旧格式（无 pages 字段，直接是单个 nodes/rootIds）
      if (!data.pages) {
        const pageId = uuid();
        const artboardId = uuid();
        const artboard: Artboard = {
          id: artboardId,
          name: '画板 1',
          x: 0,
          y: 0,
          width: previewPatch.previewWidth ?? get().previewWidth,
          height: previewPatch.previewHeight ?? get().previewHeight,
          nodes: data.nodes || {},
          rootIds: data.rootIds || [],
          sourcePrefabPath: null,
        };
        const page: PageData = {
          id: pageId,
          name: '图层 1',
          artboards: [artboard],
          activeArtboardId: artboardId,
        };
        set({
          pages: [page],
          activePageId: pageId,
          activeArtboardId: artboardId,
          nodes: data.nodes || {},
          rootIds: data.rootIds || [],
          sourcePrefabPath: null,
          annotations: {},
          annotationRootIds: [],
          selectedIds: [],
          selectedArtboardId: null,
          selectedAnnotationIds: [],
          history: [],
          historyIndex: -1,
          ...previewPatch,
        });
        return true;
      }

      // 老 PageData → 新 PageData（含 artboards）
      const migrationPreviewWidth = previewPatch.previewWidth ?? get().previewWidth;
      const migrationPreviewHeight = previewPatch.previewHeight ?? get().previewHeight;
      const migrated = migratePages(data.pages, migrationPreviewWidth, migrationPreviewHeight);
      const activePage = migrated.find((p: PageData) => p.id === data.activePageId) || migrated[0];
      const activeArtboard = activePage.artboards.find((a) => a.id === activePage.activeArtboardId) ?? activePage.artboards[0];
      set({
        pages: migrated,
        activePageId: activePage.id,
        activeArtboardId: activeArtboard.id,
        nodes: { ...activeArtboard.nodes },
        rootIds: [...activeArtboard.rootIds],
        sourcePrefabPath: activeArtboard.sourcePrefabPath,
        annotations: { ...(activePage.annotations ?? {}) },
        annotationRootIds: [...(activePage.annotationRootIds ?? [])],
        selectedIds: [],
        selectedArtboardId: null,
        selectedAnnotationIds: [],
        history: [],
        historyIndex: -1,
        ...previewPatch,
      });
      return true;
    } catch {
      return false;
    }
  },

  getSaveSlots: () => {
    return JSON.parse(localStorage.getItem('uieditor_slots') || '[]');
  },

  deleteSaveSlot: (slotName) => {
    localStorage.removeItem(`uieditor_save_${slotName}`);
    const slots: string[] = JSON.parse(localStorage.getItem('uieditor_slots') || '[]');
    localStorage.setItem('uieditor_slots', JSON.stringify(slots.filter((s) => s !== slotName)));

    // fire-and-forget 删除本地文件
    fetch(`/api/save/${encodeURIComponent(slotName)}`, { method: 'DELETE' }).catch(() => {});
  },
}); });

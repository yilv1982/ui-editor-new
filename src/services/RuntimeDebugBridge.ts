import { useEditorStore } from '../stores/editorStore';
import type { PageData, UINode } from '../types';
import { exportPageForUnity } from '../utils/exportJson';
import { fetchPrefabTemplate, importPrefabTemplateNode } from '../utils/importPrefabTemplate';
import { fullSync } from './StoreSync';
import unityBridge from './UnityBridge';
import { createWidgetNodeOnBridge, openPrefabInActiveArtboard } from './BridgeArtboardStore';
import type { NodeBounds } from './UnityBridge';
import { DESIGN_WIDTH, DESIGN_HEIGHT } from '../config/assetPaths';
import { captureLayerWholeShot } from '../utils/ueExport/common';
import type { BboxRecord } from './EditorBridgeClient';

interface RuntimeCommand {
  id: number;
  command: string;
  args?: unknown;
}

interface DebugNode {
  id: string;
  name: string;
  type: string;
  parentId: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  localScale?: { x: number; y: number; z?: number };
  originalLocalScale?: { x: number; y: number; z?: number };
  visible: boolean;
  childCount: number;
  componentRef?: string;
  unityFileId?: string;
  imageData?: string;
  imageEnabled?: boolean;
  imageHasSprite?: boolean;
  hasImage?: boolean;
  imageSpriteGuid?: string;
  imageSpriteFileId?: number;
  imageColor?: string;
  nativeVideoPlayer?: boolean;
  maskShowGraphic?: boolean;
  fontPath?: string;
  fontStyle?: number;
  alignment?: number;
  horizontalOverflow?: number;
  verticalOverflow?: number;
  bestFit?: boolean;
  text?: string;
  textOutline?: UINode['textOutline'];
  textShadow?: UINode['textShadow'];
}

interface DebugSyncNode {
  id?: string;
  name?: string;
  type?: string;
  active?: boolean;
  parentId?: string;
  artboardId?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  localScale?: { x: number; y: number; z?: number };
  style?: Partial<UINode['style']>;
  text?: string;
  fontPath?: string;
  fontStyle?: number;
  alignment?: number;
  horizontalOverflow?: number;
  verticalOverflow?: number;
  bestFit?: boolean;
  textOutline?: UINode['textOutline'];
  textShadow?: UINode['textShadow'];
  imagePath?: string;
  imageType?: string;
  imageEnabled?: boolean;
  imageHasSprite?: boolean;
  imageColor?: string;
  hasImage?: boolean;
  isMask?: boolean;
  maskType?: string;
  maskShowGraphic?: boolean;
  scrollDirection?: string;
  componentRef?: string;
  unityFileId?: string;
}

interface DebugArtboard {
  id?: string;
  width?: number;
  height?: number;
}

interface DebugBoundsNode {
  id?: string;
  name?: string;
  type?: string;
  active?: boolean;
  parentId?: string;
  artboardId?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  imagePath?: string;
  imageEnabled?: boolean;
  imageHasSprite?: boolean;
  imageColor?: string;
  hasImage?: boolean;
  maskShowGraphic?: boolean;
  componentRef?: string;
  unityFileId?: string;
  absX: number;
  absY: number;
  absRight: number;
  absBottom: number;
  overflow: {
    left: number;
    top: number;
    right: number;
    bottom: number;
  };
}

interface RuntimeDebugApi {
  snapshot: () => unknown;
  tree: () => unknown;
  syncPayload: () => unknown;
  analyze: () => unknown;
  visualProbe: (idOrName?: string, args?: Record<string, unknown>) => Promise<unknown>;
  focusTargetInViewport: (idOrName?: string, args?: Record<string, unknown>) => unknown;
  importPrefab: (relPath: string, args?: Record<string, unknown>) => Promise<unknown>;
  openBridgePrefab: (prefabPath: string) => Promise<unknown>;
  clear: () => unknown;
  select: (idOrName: string) => unknown;
  node: (idOrName: string) => unknown;
  setPreviewResolution: (width: number, height: number) => unknown;
  reload: () => unknown;
  hitTestDesign: (x: number, y: number) => unknown;
  dragSelectedByScreenDelta: (deltaX: number, deltaY: number, idOrName?: string) => Promise<unknown>;
  createBridgeFrame: (args?: Record<string, unknown>) => Promise<unknown>;
  addFlowLineAnnotation: (srcIdOrName: string, dstIdOrName: string) => unknown;
  addOutsideRectAnnotation: (args?: Record<string, unknown>) => unknown;
  captureLayerWholeShotSummary: () => Promise<unknown>;
  bridgeBboxes: () => unknown;
  fullSync: () => unknown;
  unityMessages: () => unknown;
}

declare global {
  interface Window {
    __UIEDITOR_DEBUG__?: RuntimeDebugApi;
  }
}

const DEBUG_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const enabled = typeof window !== 'undefined' && (import.meta.env.DEV || DEBUG_HOSTS.has(window.location.hostname));
const clientId = getClientId();
let polling = false;
let reportTimer: number | null = null;

function getClientId(): string {
  if (typeof window === 'undefined') return 'server';
  try {
    const key = 'uieditor-debug-client-id';
    const existing = window.sessionStorage.getItem(key);
    if (existing) return existing;
    const next = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `client-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    window.sessionStorage.setItem(key, next);
    return next;
  } catch {
    return `client-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

function summarizeImageData(imageData?: string): string | undefined {
  if (!imageData) return undefined;
  if (imageData.startsWith('data:')) return `${imageData.slice(0, 32)}...`;
  return imageData.length > 160 ? `${imageData.slice(0, 160)}...` : imageData;
}

function slimNode(node: UINode): DebugNode {
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    parentId: node.parentId,
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    rotation: node.rotation,
    localScale: node.localScale,
    originalLocalScale: node.originalLocalScale,
    visible: node.visible,
    childCount: node.children.length,
    componentRef: node.componentRef,
    unityFileId: node.unityFileId,
    imageData: summarizeImageData(node.imageData),
    imageEnabled: node.imageEnabled,
    imageHasSprite: node.imageHasSprite,
    hasImage: node.hasImage,
    imageSpriteGuid: node.imageSpriteGuid,
    imageSpriteFileId: node.imageSpriteFileId,
    imageColor: node.imageColor,
    nativeVideoPlayer: node.nativeVideoPlayer,
    maskShowGraphic: node.maskShowGraphic,
    fontPath: node.fontPath,
    fontStyle: node.fontStyle,
    alignment: node.alignment,
    horizontalOverflow: node.horizontalOverflow,
    verticalOverflow: node.verticalOverflow,
    bestFit: node.bestFit,
    text: node.text,
    textOutline: node.textOutline,
    textShadow: node.textShadow,
  };
}

function buildLayerTree() {
  const state = useEditorStore.getState();
  const visit = (nodeId: string): unknown => {
    const node = state.nodes[nodeId];
    if (!node) return null;
    return {
      ...slimNode(node),
      children: node.children.map(visit).filter(Boolean),
    };
  };
  return {
    clientId,
    at: new Date().toISOString(),
    rootIds: state.rootIds,
    tree: state.rootIds.map(visit).filter(Boolean),
  };
}

function buildActivePageForSync(): PageData | null {
  const state = useEditorStore.getState();
  const page = state.pages.find((item) => item.id === state.activePageId);
  if (!page) return null;
  return {
    ...page,
    artboards: page.artboards.map((artboard) => artboard.id === state.activeArtboardId
      ? {
        ...artboard,
        nodes: state.nodes,
        rootIds: state.rootIds,
        sourcePrefabPath: state.sourcePrefabPath,
      }
      : artboard),
  };
}

function getSyncPayload(): Record<string, unknown> | null {
  const state = useEditorStore.getState();
  const page = buildActivePageForSync();
  if (!page) return null;
  return JSON.parse(exportPageForUnity(page, {
    canvasWidth: state.previewWidth,
    canvasHeight: state.previewHeight,
  })) as Record<string, unknown>;
}

function getSnapshot() {
  const state = useEditorStore.getState();
  const nodes = Object.values(state.nodes);
  const byType: Record<string, number> = {};
  for (const node of nodes) byType[node.type] = (byType[node.type] ?? 0) + 1;
  const page = state.pages.find((item) => item.id === state.activePageId);
  const artboard = page?.artboards.find((item) => item.id === state.activeArtboardId);
  const scaleFactor = Math.min(state.previewWidth / DESIGN_WIDTH, state.previewHeight / DESIGN_HEIGHT);

  return {
    clientId,
    at: new Date().toISOString(),
    activePageId: state.activePageId,
    activeArtboardId: state.activeArtboardId,
    sourcePrefabPath: state.sourcePrefabPath,
    selectedIds: state.selectedIds,
    rootIds: state.rootIds,
    canvas: {
      x: state.canvasX,
      y: state.canvasY,
      scale: state.canvasScale,
    },
    preview: {
      width: state.previewWidth,
      height: state.previewHeight,
      scaleFactor,
      screenScale: state.canvasScale,
      contentScale: state.canvasScale * scaleFactor,
    },
    previewContract: {
      sizeSource: 'previewResolution',
      effectiveSize: { width: state.previewWidth, height: state.previewHeight },
      storedSize: artboard ? { width: artboard.width, height: artboard.height } : null,
      storedSizeIsMetadata: true,
      storedMatchesEffective: artboard
        ? artboard.width === state.previewWidth && artboard.height === state.previewHeight
        : null,
    },
    nodeCount: nodes.length,
    visibleCount: nodes.filter((node) => node.visible !== false).length,
    hiddenCount: nodes.filter((node) => node.visible === false).length,
    byType,
    artboard: artboard ? {
      id: artboard.id,
      name: artboard.name,
      x: artboard.x,
      y: artboard.y,
      width: state.previewWidth,
      height: state.previewHeight,
      storedWidth: artboard.width,
      storedHeight: artboard.height,
      screenRect: {
        x: state.canvasX + artboard.x * state.canvasScale,
        y: state.canvasY + artboard.y * state.canvasScale,
        width: state.previewWidth * state.canvasScale,
        height: state.previewHeight * state.canvasScale,
      },
      sourcePrefabPath: artboard.sourcePrefabPath,
    } : null,
    roots: state.rootIds.map((id) => state.nodes[id]).filter(Boolean).map(slimNode),
    hiddenLargeNodes: nodes
      .filter((node) => node.visible === false && (node.width >= 900 || node.height >= 900))
      .slice(0, 20)
      .map(slimNode),
  };
}

function alphaFromHex(color?: string): number | null {
  if (!color || !color.startsWith('#')) return null;
  if (color.length === 9) return parseInt(color.slice(7, 9), 16) / 255;
  if (color.length === 5) return parseInt(color.slice(4, 5).repeat(2), 16) / 255;
  return 1;
}

function slimSyncNode(node: DebugSyncNode) {
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    active: node.active,
    parentId: node.parentId,
    artboardId: node.artboardId,
    x: node.x,
    y: node.y,
    width: node.width,
    height: node.height,
    text: node.text,
    fontPath: node.fontPath,
    fontStyle: node.fontStyle,
    alignment: node.alignment,
    horizontalOverflow: node.horizontalOverflow,
    verticalOverflow: node.verticalOverflow,
    bestFit: node.bestFit,
    textOutline: node.textOutline,
    textShadow: node.textShadow,
    imagePath: node.imagePath,
    imageType: node.imageType,
    imageEnabled: node.imageEnabled,
    imageHasSprite: node.imageHasSprite,
    imageColor: node.imageColor,
    hasImage: node.hasImage,
    isMask: node.isMask,
    maskType: node.maskType,
    maskShowGraphic: node.maskShowGraphic,
    scrollDirection: node.scrollDirection,
    componentRef: node.componentRef,
    unityFileId: node.unityFileId,
  };
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function analyzeNodeBounds(payload: Record<string, unknown> | null, nodes: DebugSyncNode[]) {
  const canvasWidth = finiteNumber(payload?.canvasWidth, DESIGN_WIDTH);
  const canvasHeight = finiteNumber(payload?.canvasHeight, DESIGN_HEIGHT);
  const artboardList = Array.isArray(payload?.artboards) ? payload.artboards as DebugArtboard[] : [];
  const artboardById = new Map<string, DebugArtboard>();
  for (const artboard of artboardList) {
    if (typeof artboard.id === 'string') artboardById.set(artboard.id, artboard);
  }

  const nodeById = new Map<string, DebugSyncNode>();
  for (const node of nodes) {
    if (typeof node.id === 'string') nodeById.set(node.id, node);
  }

  const absCache = new Map<string, { x: number; y: number }>();
  const resolving = new Set<string>();

  function absolutePosition(node: DebugSyncNode): { x: number; y: number } {
    if (typeof node.id === 'string' && absCache.has(node.id)) return absCache.get(node.id)!;

    let x = finiteNumber(node.x);
    let y = finiteNumber(node.y);
    const parentId = typeof node.parentId === 'string' ? node.parentId : '';
    const parent = parentId ? nodeById.get(parentId) : null;

    if (parent && typeof node.id === 'string' && !resolving.has(node.id)) {
      resolving.add(node.id);
      const parentAbs = absolutePosition(parent);
      resolving.delete(node.id);
      x += parentAbs.x;
      y += parentAbs.y;
    }

    if (typeof node.id === 'string') absCache.set(node.id, { x, y });
    return { x, y };
  }

  function artboardSize(node: DebugSyncNode) {
    const artboard = typeof node.artboardId === 'string' ? artboardById.get(node.artboardId) : null;
    return {
      width: finiteNumber(artboard?.width, canvasWidth),
      height: finiteNumber(artboard?.height, canvasHeight),
    };
  }

  const bounds: DebugBoundsNode[] = nodes
    .filter((node) => node.active !== false)
    .map((node) => {
      const abs = absolutePosition(node);
      const width = finiteNumber(node.width);
      const height = finiteNumber(node.height);
      const size = artboardSize(node);
      const absRight = abs.x + width;
      const absBottom = abs.y + height;
      return {
        ...slimSyncNode(node),
        absX: Math.round(abs.x * 100) / 100,
        absY: Math.round(abs.y * 100) / 100,
        absRight: Math.round(absRight * 100) / 100,
        absBottom: Math.round(absBottom * 100) / 100,
        overflow: {
          left: Math.max(0, Math.round(-abs.x * 100) / 100),
          top: Math.max(0, Math.round(-abs.y * 100) / 100),
          right: Math.max(0, Math.round((absRight - size.width) * 100) / 100),
          bottom: Math.max(0, Math.round((absBottom - size.height) * 100) / 100),
        },
      };
    });

  const isOutOfBounds = (node: DebugBoundsNode) =>
    node.overflow.left > 0.5 ||
    node.overflow.top > 0.5 ||
    node.overflow.right > 0.5 ||
    node.overflow.bottom > 0.5;

  return {
    outOfBoundsRoots: bounds
      .filter((node) => !node.parentId && isOutOfBounds(node))
      .slice(0, 20),
    outOfBoundsNodes: bounds
      .filter(isOutOfBounds)
      .slice(0, 20),
  };
}

function analyzeRuntime() {
  const state = useEditorStore.getState();
  const payload = getSyncPayload();
  const nodes = Array.isArray(payload?.nodes) ? payload.nodes as DebugSyncNode[] : [];
  const inactiveInPayload = nodes.filter((node) => node.active === false);
  const renderableNoAsset = nodes.filter((node) => {
    const type = node.type ?? '';
    const alpha = alphaFromHex(node.imageColor);
    return (type === 'image' || type === 'button' || type === 'rawimage')
      && node.imageEnabled !== false
      && node.hasImage !== false
      && alpha !== 0
      && !node.imagePath;
  });
  const unresolvedSpriteNoAsset = renderableNoAsset.filter((node) => {
    const storeNode = typeof node.id === 'string' ? state.nodes[node.id] : null;
    return node.imageHasSprite === true || storeNode?.imageHasSprite === true;
  });
  const largeRenderableNoAsset = renderableNoAsset.filter((node) =>
    (node.width ?? 0) >= 900 || (node.height ?? 0) >= 900
  ).filter((node) => {
    const storeNode = typeof node.id === 'string' ? state.nodes[node.id] : null;
    return node.imageHasSprite !== true
      && storeNode?.imageHasSprite !== true
      && node.imageHasSprite !== false
      && storeNode?.imageHasSprite !== false;
  });
  const translucentLargeNoAsset = largeRenderableNoAsset.filter((node) => {
    const alpha = alphaFromHex(node.imageColor);
    return alpha !== null && alpha > 0 && alpha < 1;
  });
  const componentFallbacks = nodes.filter((node) => typeof node.imagePath === 'string' && node.imagePath.startsWith('/components/@'));
  const boundsAnalysis = analyzeNodeBounds(payload, nodes);
  const activeOutOfBoundsRoots = boundsAnalysis.outOfBoundsRoots.filter((node) => node.artboardId === state.activeArtboardId);
  const unityMessages = unityBridge.getDebugMessages();
  const lastSync = [...unityMessages].reverse().find((msg) => msg.method === 'SyncFullTree') ?? null;
  const warnings: string[] = [];

  if (inactiveInPayload.length > 0) warnings.push(`preview payload still contains ${inactiveInPayload.length} inactive nodes`);
  if (largeRenderableNoAsset.length > 0) warnings.push(`${largeRenderableNoAsset.length} large image/button nodes have no imagePath and may render as tinted rectangles`);
  if (componentFallbacks.length > 0) warnings.push(`${componentFallbacks.length} component fallback thumbnails are still in the Unity payload`);
  if (activeOutOfBoundsRoots.length > 0) warnings.push(`${activeOutOfBoundsRoots.length} active root node(s) extend outside the current artboard and may be clipped`);
  else if (boundsAnalysis.outOfBoundsRoots.length > 0) warnings.push(`${boundsAnalysis.outOfBoundsRoots.length} non-active root node(s) extend outside their artboard`);

  return {
    at: new Date().toISOString(),
    payloadVersion: payload?.version,
    payloadNodeCount: nodes.length,
    artboardCount: Array.isArray(payload?.artboards) ? payload.artboards.length : 0,
    warnings,
    inactiveInPayload: inactiveInPayload.slice(0, 20).map(slimSyncNode),
    largeRenderableNoAsset: largeRenderableNoAsset.slice(0, 20).map(slimSyncNode),
    unresolvedSpriteNoAsset: unresolvedSpriteNoAsset.slice(0, 20).map(slimSyncNode),
    translucentLargeNoAsset: translucentLargeNoAsset.slice(0, 20).map(slimSyncNode),
    componentFallbacks: componentFallbacks.slice(0, 20).map(slimSyncNode),
    activeOutOfBoundsRoots,
    outOfBoundsRoots: boundsAnalysis.outOfBoundsRoots,
    outOfBoundsNodes: boundsAnalysis.outOfBoundsNodes,
    lastSync,
  };
}

function rectRound(value: number): number {
  return Math.round(value * 100) / 100;
}

function safeRatio(value: number | undefined, base: number | undefined): number | null {
  if (typeof value !== 'number' || typeof base !== 'number' || !Number.isFinite(value) || !Number.isFinite(base) || Math.abs(base) < 0.0001) {
    return null;
  }
  return rectRound(value / base);
}

function isNear(value: number | null, expected: number, tolerance = 0.03): boolean {
  return value !== null && Math.abs(value - expected) <= tolerance;
}

function getActiveArtboard() {
  const state = useEditorStore.getState();
  const page = state.pages.find((item) => item.id === state.activePageId);
  return page?.artboards.find((item) => item.id === state.activeArtboardId) ?? null;
}

function getExpectedNodeScreenRect(id: string) {
  const state = useEditorStore.getState();
  const node = state.nodes[id];
  if (!node) return null;
  const artboard = getActiveArtboard();
  const chain: UINode[] = [];
  let currentId: string | null | undefined = id;
  const seen = new Set<string>();
  while (currentId && state.nodes[currentId] && !seen.has(currentId)) {
    seen.add(currentId);
    chain.unshift(state.nodes[currentId]);
    currentId = state.nodes[currentId].parentId;
  }
  let parentScaleX = 1;
  let parentScaleY = 1;
  let parentPivotGlobalX = 0;
  let parentPivotGlobalY = 0;
  let parentPivotLocalX = 0;
  let parentPivotLocalY = 0;
  let visual: { x: number; y: number; width: number; height: number; scaleX: number; scaleY: number } | null = null;
  for (const item of chain) {
    const pivot = item.pivot ?? { x: 0.5, y: 0.5 };
    const scale = item.localScale ?? { x: 1, y: 1 };
    const localPivotX = item.x + pivot.x * item.width;
    const localPivotY = item.y + (1 - pivot.y) * item.height;
    const pivotGlobalX = parentPivotGlobalX + (localPivotX - parentPivotLocalX) * parentScaleX;
    const pivotGlobalY = parentPivotGlobalY + (localPivotY - parentPivotLocalY) * parentScaleY;
    const scaleX = parentScaleX * (scale.x ?? 1);
    const scaleY = parentScaleY * (scale.y ?? 1);
    visual = {
      x: pivotGlobalX - pivot.x * item.width * scaleX,
      y: pivotGlobalY - (1 - pivot.y) * item.height * scaleY,
      width: item.width * scaleX,
      height: item.height * scaleY,
      scaleX,
      scaleY,
    };
    parentScaleX = scaleX;
    parentScaleY = scaleY;
    parentPivotGlobalX = pivotGlobalX;
    parentPivotGlobalY = pivotGlobalY;
    parentPivotLocalX = pivot.x * item.width;
    parentPivotLocalY = (1 - pivot.y) * item.height;
  }
  if (!visual) return null;
  const artboardX = artboard?.x ?? 0;
  const artboardY = artboard?.y ?? 0;
  return {
    id,
    name: node.name,
    design: {
      x: rectRound(visual.x),
      y: rectRound(visual.y),
      width: rectRound(visual.width),
      height: rectRound(visual.height),
    },
    css: {
      x: rectRound(state.canvasX + (artboardX + visual.x) * state.canvasScale),
      y: rectRound(state.canvasY + (artboardY + visual.y) * state.canvasScale),
      width: rectRound(visual.width * state.canvasScale),
      height: rectRound(visual.height * state.canvasScale),
    },
  };
}

function expectedRectExtendsOutsideArtboard(expected: { design: { x: number; y: number; width: number; height: number } } | null): boolean {
  if (!expected) return false;
  const state = useEditorStore.getState();
  const width = state.previewWidth;
  const height = state.previewHeight;
  const rect = expected.design;
  return rect.x < 0 || rect.y < 0 || rect.x + rect.width > width || rect.y + rect.height > height;
}

function inflateRect(rect: { x: number; y: number; width: number; height: number }, pad: number) {
  return {
    x: rect.x - pad,
    y: rect.y - pad,
    width: rect.width + pad * 2,
    height: rect.height + pad * 2,
  };
}

function intersectRect(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  const width = right - x;
  const height = bottom - y;
  if (width <= 0 || height <= 0) return null;
  return { x: rectRound(x), y: rectRound(y), width: rectRound(width), height: rectRound(height) };
}

function isRenderableForCropContext(node: UINode): boolean {
  if (node.visible === false) return false;
  if (node.type === 'text' && node.text) return true;
  if (['image', 'button', 'scrollview', 'rawimage', 'toggle', 'inputfield'].includes(node.type)) return node.imageEnabled !== false;
  return false;
}

function nodeLikelyFillsOwnRect(node?: UINode | null): boolean {
  if (!node || node.visible === false) return false;
  if (node.type === 'text') return !!node.text;
  if (!['image', 'button', 'scrollview', 'rawimage', 'toggle', 'inputfield'].includes(node.type)) return false;
  if (node.imageEnabled === false || node.hasImage === false) return false;
  if (node.isMask && node.maskShowGraphic === false) return false;
  const alpha = alphaFromHex(node.imageColor);
  if (alpha === 0) return false;
  const imageType = typeof node.imageType === 'string' ? node.imageType : '';
  if (node.type !== 'rawimage' && imageType && !['Sliced', 'Tiled', 'Filled'].includes(imageType)) return false;
  if (node.type !== 'rawimage' && !imageType && node.imageHasSprite === true) return false;
  return !!node.imageData || node.imageHasSprite === true || node.type === 'rawimage';
}

function collectSubtreeIds(id: string, maxNodes = 120): string[] {
  const state = useEditorStore.getState();
  const result: string[] = [];
  function visit(nodeId: string) {
    if (result.length >= maxNodes) return;
    const node = state.nodes[nodeId];
    if (!node) return;
    result.push(nodeId);
    for (const childId of node.children) visit(childId);
  }
  visit(id);
  return result;
}

function nodePath(id: string): string {
  const state = useEditorStore.getState();
  const names: string[] = [];
  let current: string | null | undefined = id;
  const seen = new Set<string>();
  while (current && state.nodes[current] && !seen.has(current)) {
    seen.add(current);
    const node: UINode = state.nodes[current];
    names.push(node.name);
    current = node.parentId;
  }
  return names.reverse().join('/');
}

function buildTargetSubtree(
  id: string,
  maxNodes = 120,
  unityBounds: NodeBounds[] = [],
  options: { cropPadDesign?: number } = {},
) {
  const state = useEditorStore.getState();
  const payload = getSyncPayload();
  const syncNodes = Array.isArray(payload?.nodes) ? payload.nodes as DebugSyncNode[] : [];
  const syncById = new Map<string, DebugSyncNode>();
  for (const node of syncNodes) {
    if (typeof node.id === 'string') syncById.set(node.id, node);
  }
  const boundById = new Map<string, NodeBounds>();
  for (const bound of unityBounds) {
    if (typeof bound.id === 'string') boundById.set(bound.id, bound);
  }

  const rows: Array<Record<string, unknown>> = [];
  const issues: Array<Record<string, unknown>> = [];
  const notes: Array<Record<string, unknown>> = [];
  const subtreeIdSet = new Set(collectSubtreeIds(id, 500));
  const ancestorIdSet = new Set<string>();
  let ancestorId = state.nodes[id]?.parentId;
  while (ancestorId && state.nodes[ancestorId] && !ancestorIdSet.has(ancestorId)) {
    ancestorIdSet.add(ancestorId);
    ancestorId = state.nodes[ancestorId].parentId;
  }

  function addIssue(node: UINode, code: string, message: string) {
    issues.push({ id: node.id, name: node.name, path: nodePath(node.id), code, message });
  }

  function addNote(node: UINode, code: string, message: string, extra?: Record<string, unknown>) {
    notes.push({ id: node.id, name: node.name, path: nodePath(node.id), code, message, ...extra });
  }

  function contentSizeFitterDrivesBounds(node: UINode): boolean {
    const csf = node.contentSizeFitter;
    return !!csf && csf.enabled !== false && (csf.horizontalFit === 2 || csf.verticalFit === 2);
  }

  function layoutGroupDrivesChildren(node: UINode): boolean {
    return !!node.layoutGroup && node.layoutGroup.enabled !== false;
  }

  function hasLayoutDrivenAncestor(node: UINode): boolean {
    let parentId = node.parentId;
    const seen = new Set<string>();
    while (parentId && state.nodes[parentId] && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = state.nodes[parentId];
      if (contentSizeFitterDrivesBounds(parent) || layoutGroupDrivesChildren(parent)) return true;
      parentId = parent.parentId;
    }
    return false;
  }

  function hasHiddenAncestor(node: UINode): boolean {
    let parentId = node.parentId;
    const seen = new Set<string>();
    while (parentId && state.nodes[parentId] && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = state.nodes[parentId];
      if (parent.visible === false) return true;
      parentId = parent.parentId;
    }
    return false;
  }

  function visit(nodeId: string, depth: number) {
    if (rows.length >= maxNodes) return;
    const node = state.nodes[nodeId];
    if (!node) return;
    const sync = syncById.get(nodeId);
    const unityBound = boundById.get(nodeId);
    const expected = getExpectedNodeScreenRect(nodeId);
    const imageLike = ['image', 'button', 'scrollview', 'rawimage', 'toggle', 'inputfield'].includes(node.type);
    const storeAlpha = alphaFromHex(node.imageColor);
    const syncAlpha = alphaFromHex(sync?.imageColor);
    const effectivelyVisible = node.visible !== false && !hasHiddenAncestor(node);

    if (!sync && effectivelyVisible) {
      addIssue(node, 'missing-sync-node', 'Node exists in UIEditor store but is absent from the Unity sync payload.');
    } else if (!sync && !effectivelyVisible) {
      addNote(node, 'hidden-node-skipped', 'Hidden node or hidden ancestor is skipped by the preview sync payload.');
    }
    if (effectivelyVisible && sync && !unityBound && nodeId === id) {
      addIssue(node, 'missing-webgl-bound', 'Node exists in the Unity sync payload but WebGL did not return a bound for it.');
    } else if (effectivelyVisible && sync && !unityBound) {
      addNote(node, 'descendant-missing-webgl-bound', 'Descendant node exists in the Unity sync payload but WebGL did not return a bound during this parent-level probe.');
    }
    if (expected && unityBound) {
      const delta = {
        x: Math.abs(unityBound.x - expected.css.x),
        y: Math.abs(unityBound.y - expected.css.y),
        width: Math.abs(unityBound.width - expected.css.width),
        height: Math.abs(unityBound.height - expected.css.height),
      };
      if (delta.x > 2 || delta.y > 2 || delta.width > 2 || delta.height > 2) {
        const isLayoutDriven = contentSizeFitterDrivesBounds(node) || hasLayoutDrivenAncestor(node);
        const isTransparentMask = node.isMask && node.maskShowGraphic === false;
        const isRectMaskViewport = node.isMask || sync?.maskType === 'RectMask2D' || sync?.maskType === 'Mask';
        const nonRenderableBound = !isRenderableForCropContext(node)
          || (imageLike && (
            storeAlpha === 0 ||
            syncAlpha === 0 ||
            node.hasImage === false ||
            sync?.hasImage === false
          ));
        const message = `WebGL bound differs from store expected by pos ${rectRound(delta.x)}x${rectRound(delta.y)}, size ${rectRound(delta.width)}x${rectRound(delta.height)} css px.`;
        if (isLayoutDriven) addNote(node, 'layout-driven-bound-diff', message);
        else if (isTransparentMask) addNote(node, 'transparent-mask-bound-includes-content', `${message} Transparent mask WebGL bounds may include clipped child content; use the store RectTransform for layout checks.`);
        else if (isRectMaskViewport) addNote(node, 'mask-bound-includes-content', `${message} Mask or RectMask2D WebGL bounds may include clipped child content; use the store RectTransform for layout checks.`);
        else if (nonRenderableBound) addNote(node, 'non-renderable-bound-diff', `${message} Node is a layout/transparent/non-renderable container, so this bound is not treated as a visual repair target.`);
        else addIssue(node, 'webgl-bound-differs-from-store', message);
      }
    }
    if (
      imageLike &&
      effectivelyVisible &&
      node.imageEnabled !== false &&
      node.imageData &&
      sync &&
      !sync.imagePath &&
      sync.hasImage !== false &&
      syncAlpha !== 0
    ) {
      addIssue(node, 'image-data-not-exported', 'Node has imageData in the store but no imagePath in the Unity sync payload.');
    }
    if (node.type === 'scrollview' && node.imageData && sync?.type === 'image') {
      addNote(node, 'scrollview-background-preview-image', 'ScrollView has a background sprite and is exported as image in WebGL preview so the background is visible.');
    }
    if (effectivelyVisible && node.isMask && sync?.maskType === 'Mask') {
      addIssue(node, 'mask-not-converted', 'Preview payload still uses UGUI Mask; RectMask2D is safer for WebGL text clipping.');
    }
    if (imageLike && effectivelyVisible && node.imageEnabled !== false && !node.imageData && !node.componentRef && storeAlpha !== 0 && (node.width >= 300 || node.height >= 300)) {
      const isTransparentMask = node.isMask && node.maskShowGraphic === false;
      const isThinPrimitive = Math.min(node.width || 0, node.height || 0) <= 8;
      if (isTransparentMask) {
        addNote(node, 'transparent-mask-graphic-skipped', 'Mask showGraphic=false is expected to export as a transparent clipping graphic.');
      } else if (node.imageHasSprite === true) {
        addNote(
          node,
          'unresolved-sprite-reference',
          `Prefab references sprite ${node.imageSpriteGuid || node.imageSpriteFileId || 'unknown'} that is not resolved in the local asset cache; preview falls back to a tinted Image. Visual diff determines whether this affects the screenshot.`,
          {
            spriteGuid: node.imageSpriteGuid,
            spriteFileId: node.imageSpriteFileId,
          },
        );
      } else if (node.type === 'scrollview') {
        addNote(node, 'scrollview-no-background-image', 'ScrollView has no background sprite; this is expected for transparent ScrollRect containers.');
      } else if (node.nativeVideoPlayer === true && node.type === 'rawimage') {
        addNote(node, 'video-player-placeholder-without-asset', 'RawImage is driven by a Unity VideoPlayer at runtime; static WebGL prefab preview has no video texture to export.');
      } else if (node.imageHasSprite === false || isThinPrimitive) {
        addNote(node, 'sprite-less-image-primitive', 'Sprite-less Image appears to be an intentional tinted rectangle or thin separator.');
      } else {
        addIssue(node, 'large-image-without-asset', 'Large renderable image-like node has no imageData and may appear as a tinted rectangle.');
      }
    }

    rows.push({
      id: node.id,
      name: node.name,
      path: nodePath(node.id),
      depth,
      type: node.type,
      syncType: sync?.type ?? null,
      visible: node.visible,
      childCount: node.children.length,
      unityFileId: node.unityFileId,
      localScale: node.localScale,
      originalLocalScale: node.originalLocalScale,
      design: expected?.design ?? { x: node.x, y: node.y, width: node.width, height: node.height },
      css: expected?.css ?? null,
      unityCssBound: unityBound ? {
        x: rectRound(unityBound.x),
        y: rectRound(unityBound.y),
        width: rectRound(unityBound.width),
        height: rectRound(unityBound.height),
      } : null,
      unityDelta: expected && unityBound ? {
        x: rectRound(unityBound.x - expected.css.x),
        y: rectRound(unityBound.y - expected.css.y),
        width: rectRound(unityBound.width - expected.css.width),
        height: rectRound(unityBound.height - expected.css.height),
      } : null,
      text: node.text,
      textStyle: node.type === 'text' || sync?.type === 'text' ? {
        fontSize: node.style?.fontSize,
        fontColor: node.style?.fontColor,
        fontWeight: node.style?.fontWeight,
        textAlign: node.style?.textAlign,
        fontPath: node.fontPath,
        fontStyle: node.fontStyle,
        alignment: node.alignment,
        horizontalOverflow: node.horizontalOverflow,
        verticalOverflow: node.verticalOverflow,
        bestFit: node.bestFit,
        syncFontSize: sync?.style?.fontSize,
        syncFontColor: sync?.style?.fontColor,
        syncFontWeight: sync?.style?.fontWeight,
        syncTextAlign: sync?.style?.textAlign,
        syncFontPath: sync?.fontPath,
        syncFontStyle: sync?.fontStyle,
        syncAlignment: sync?.alignment,
        syncHorizontalOverflow: sync?.horizontalOverflow,
        syncVerticalOverflow: sync?.verticalOverflow,
        syncBestFit: sync?.bestFit,
      } : null,
      textEffects: node.type === 'text' || sync?.type === 'text' ? {
        textOutline: node.textOutline ?? null,
        textShadow: node.textShadow ?? null,
        syncTextOutline: sync?.textOutline ?? null,
        syncTextShadow: sync?.textShadow ?? null,
      } : null,
      image: imageLike ? {
        imageData: summarizeImageData(node.imageData),
        syncImagePath: sync?.imagePath,
        imageType: node.imageType,
        syncImageType: sync?.imageType,
        imageColor: node.imageColor,
        syncImageColor: sync?.imageColor,
        imageEnabled: node.imageEnabled,
        syncImageEnabled: sync?.imageEnabled,
        imageHasSprite: node.imageHasSprite,
        imageSpriteGuid: node.imageSpriteGuid,
        imageSpriteFileId: node.imageSpriteFileId,
        nativeVideoPlayer: node.nativeVideoPlayer,
        syncImageHasSprite: sync?.imageHasSprite,
        hasImage: node.hasImage,
        syncHasImage: sync?.hasImage,
      } : null,
      transform: {
        localScale: node.localScale,
        originalLocalScale: node.originalLocalScale,
        syncLocalScale: sync?.localScale,
      },
      mask: node.isMask || sync?.isMask ? {
        isMask: node.isMask,
        syncIsMask: sync?.isMask,
        maskType: node.maskType,
        syncMaskType: sync?.maskType,
        maskShowGraphic: node.maskShowGraphic,
        syncMaskShowGraphic: sync?.maskShowGraphic,
      } : null,
      scroll: node.type === 'scrollview' || sync?.scrollDirection ? {
        scrollDirection: node.scrollDirection,
        syncScrollDirection: sync?.scrollDirection,
      } : null,
    });

    for (const childId of node.children) visit(childId, depth + 1);
  }

  visit(id, 0);

  const targetExpected = getExpectedNodeScreenRect(id);
  const cropPadDesignRaw = Number(options.cropPadDesign ?? 24);
  const cropPadDesign = Number.isFinite(cropPadDesignRaw) && cropPadDesignRaw >= 0 ? cropPadDesignRaw : 24;
  const cropDesignRect = targetExpected ? inflateRect(targetExpected.design, cropPadDesign) : null;
  const overlappingNonTargetNodes: Array<Record<string, unknown>> = [];
  if (cropDesignRect && targetExpected) {
    for (const node of Object.values(state.nodes)) {
      if (!node || subtreeIdSet.has(node.id) || ancestorIdSet.has(node.id)) continue;
      if (!isRenderableForCropContext(node) || hasHiddenAncestor(node)) continue;
      const expected = getExpectedNodeScreenRect(node.id);
      if (!expected) continue;
      const overlap = intersectRect(cropDesignRect, expected.design);
      if (!overlap) continue;
      const overlapArea = overlap.width * overlap.height;
      const nodeArea = Math.max(1, expected.design.width * expected.design.height);
      const cropArea = Math.max(1, cropDesignRect.width * cropDesignRect.height);
      overlappingNonTargetNodes.push({
        id: node.id,
        name: node.name,
        path: nodePath(node.id),
        type: node.type,
        design: expected.design,
        css: expected.css,
        overlapDesign: {
          ...overlap,
          area: rectRound(overlapArea),
          nodeRatio: rectRound(overlapArea / nodeArea),
          cropRatio: rectRound(overlapArea / cropArea),
        },
        text: node.type === 'text' ? String(node.text ?? '').slice(0, 80) : undefined,
        imageData: summarizeImageData(node.imageData),
      });
    }
    overlappingNonTargetNodes.sort((a, b) => {
      const aArea = typeof (a.overlapDesign as { area?: unknown })?.area === 'number' ? (a.overlapDesign as { area: number }).area : 0;
      const bArea = typeof (b.overlapDesign as { area?: unknown })?.area === 'number' ? (b.overlapDesign as { area: number }).area : 0;
      return bArea - aArea;
    });
    if (overlappingNonTargetNodes.length > 0) {
      notes.push({
        id,
        name: state.nodes[id]?.name ?? id,
        path: nodePath(id),
        code: 'target-crop-overlaps-non-target-nodes',
        message: `Target crop intersects ${overlappingNonTargetNodes.length} renderable node(s) outside the selected subtree; visual diff may include sibling or nearby content.`,
      });
    }
  }

  return {
    id,
    name: state.nodes[id]?.name ?? id,
    path: nodePath(id),
    nodeCount: rows.length,
    truncated: rows.length >= maxNodes,
    overlapContext: {
      cropPadDesign,
      targetDesignRect: targetExpected?.design ?? null,
      cropDesignRect,
      nonTargetNodes: overlappingNonTargetNodes.slice(0, 20),
      totalNonTargetNodes: overlappingNonTargetNodes.length,
    },
    issues,
    notes,
    nodes: rows,
  };
}

function buildVisualDiagnostics(
  expected: NonNullable<ReturnType<typeof getExpectedNodeScreenRect>>,
  matchingUnityBound: NodeBounds | null,
  pixelScan: unknown,
) {
  const state = useEditorStore.getState();
  const previewScaleFactor = Math.min(state.previewWidth / DESIGN_WIDTH, state.previewHeight / DESIGN_HEIGHT);
  const pixelBounds = (pixelScan && typeof pixelScan === 'object'
    ? (pixelScan as { bounds?: { css?: { x?: number; y?: number; width?: number; height?: number; right?: number; bottom?: number } } }).bounds?.css
    : null) ?? null;

  const unityWidthRatio = matchingUnityBound ? safeRatio(matchingUnityBound.width, expected.css.width) : null;
  const unityHeightRatio = matchingUnityBound ? safeRatio(matchingUnityBound.height, expected.css.height) : null;
  const pixelWidthRatio = pixelBounds ? safeRatio(pixelBounds.width, expected.css.width) : null;
  const pixelHeightRatio = pixelBounds ? safeRatio(pixelBounds.height, expected.css.height) : null;
  const unityDelta = matchingUnityBound ? {
    x: rectRound(matchingUnityBound.x - expected.css.x),
    y: rectRound(matchingUnityBound.y - expected.css.y),
    width: rectRound(matchingUnityBound.width - expected.css.width),
    height: rectRound(matchingUnityBound.height - expected.css.height),
    centerX: rectRound(matchingUnityBound.x + matchingUnityBound.width / 2 - expected.css.x - expected.css.width / 2),
    centerY: rectRound(matchingUnityBound.y + matchingUnityBound.height / 2 - expected.css.y - expected.css.height / 2),
  } : null;
  const pixelDelta = pixelBounds ? {
    x: rectRound((pixelBounds.x ?? 0) - expected.css.x),
    y: rectRound((pixelBounds.y ?? 0) - expected.css.y),
    width: rectRound((pixelBounds.width ?? 0) - expected.css.width),
    height: rectRound((pixelBounds.height ?? 0) - expected.css.height),
  } : null;
  const likelyExtraPreviewScale = (
    isNear(unityWidthRatio, previewScaleFactor) ||
    isNear(unityHeightRatio, previewScaleFactor)
  ) && !isNear(previewScaleFactor, 1, 0.001);

  return {
    previewScaleFactor: rectRound(previewScaleFactor),
    screenScale: rectRound(state.canvasScale),
    compensatedCameraScale: previewScaleFactor > 0 ? rectRound(state.canvasScale / previewScaleFactor) : null,
    unityToExpectedRatio: {
      width: unityWidthRatio,
      height: unityHeightRatio,
    },
    pixelToExpectedRatio: {
      width: pixelWidthRatio,
      height: pixelHeightRatio,
    },
    unityDelta,
    pixelDelta,
    likelyExtraPreviewScale,
  };
}

function getCanvasMetrics() {
  const canvas = document.getElementById('unity-canvas') as HTMLCanvasElement | null;
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  return {
    css: {
      x: rectRound(rect.x),
      y: rectRound(rect.y),
      width: rectRound(rect.width),
      height: rectRound(rect.height),
    },
    buffer: {
      width: canvas.width,
      height: canvas.height,
    },
    ratio: {
      x: rect.width > 0 ? canvas.width / rect.width : null,
      y: rect.height > 0 ? canvas.height / rect.height : null,
    },
    devicePixelRatio: window.devicePixelRatio,
    contextLost: unityBridge.isContextLost(),
  };
}

function focusTargetInViewport(idOrName?: string, args: Record<string, unknown> = {}) {
  const id = findNodeId(idOrName, args)
    ?? useEditorStore.getState().selectedIds[0]
    ?? useEditorStore.getState().rootIds[0]
    ?? null;
  if (!id || !useEditorStore.getState().nodes[id]) throw new Error('focusTargetInViewport cannot find target node');

  const expected = getExpectedNodeScreenRect(id);
  const canvas = getCanvasMetrics();
  if (!expected || !canvas) return { ok: false, reason: 'missing expected rect or canvas metrics', id };

  const state = useEditorStore.getState();
  const artboard = getActiveArtboard();
  const paddingCss = Math.max(12, Number(args.fitPaddingCss ?? 56));
  const maxWidth = Math.max(64, canvas.css.width - paddingCss * 2);
  const maxHeight = Math.max(64, canvas.css.height - paddingCss * 2);
  const scale = Math.max(0.1, Math.min(
    5,
    Number(args.maxFitScale ?? 1),
    maxWidth / Math.max(1, expected.design.width),
    maxHeight / Math.max(1, expected.design.height),
  ));
  const artboardX = artboard?.x ?? 0;
  const artboardY = artboard?.y ?? 0;
  const centerX = artboardX + expected.design.x + expected.design.width / 2;
  const centerY = artboardY + expected.design.y + expected.design.height / 2;
  const canvasX = rectRound(canvas.css.width / 2 - centerX * scale);
  const canvasY = rectRound(canvas.css.height / 2 - centerY * scale);

  (window as typeof window & { __UIEDITOR_DEBUG_FOCUS_UNTIL?: number }).__UIEDITOR_DEBUG_FOCUS_UNTIL = performance.now() + 3000;
  state.setSelectedIds([id]);
  state.setCanvasTransform(canvasX, canvasY, scale);
  return {
    ok: true,
    id,
    target: slimNode(useEditorStore.getState().nodes[id]),
    before: {
      canvas: state.canvasX !== undefined ? { x: state.canvasX, y: state.canvasY, scale: state.canvasScale } : null,
      expected,
    },
    after: {
      canvas: { x: canvasX, y: canvasY, scale: rectRound(scale) },
    },
    metrics: {
      canvas: canvas.css,
      paddingCss,
      maxWidth: rectRound(maxWidth),
      maxHeight: rectRound(maxHeight),
    },
  };
}

function colorDistanceSq(data: Uint8ClampedArray, offset: number, color: [number, number, number]) {
  const dr = data[offset] - color[0];
  const dg = data[offset + 1] - color[1];
  const db = data[offset + 2] - color[2];
  return dr * dr + dg * dg + db * db;
}

function estimateBackgroundColor(data: Uint8ClampedArray, width: number, height: number, exclude?: { x0: number; y0: number; x1: number; y1: number }): [number, number, number] {
  const counts = new Map<string, { count: number; r: number; g: number; b: number }>();
  const stepX = Math.max(1, Math.floor(width / 80));
  const stepY = Math.max(1, Math.floor(height / 80));
  for (let y = 0; y < height; y += stepY) {
    for (let x = 0; x < width; x += stepX) {
      if (exclude && x >= exclude.x0 && x <= exclude.x1 && y >= exclude.y0 && y <= exclude.y1) continue;
      const offset = (y * width + x) * 4;
      if (data[offset + 3] < 8) continue;
      const qr = Math.round(data[offset] / 8) * 8;
      const qg = Math.round(data[offset + 1] / 8) * 8;
      const qb = Math.round(data[offset + 2] / 8) * 8;
      const key = `${qr},${qg},${qb}`;
      const item = counts.get(key) ?? { count: 0, r: qr, g: qg, b: qb };
      item.count++;
      counts.set(key, item);
    }
  }
  const best = [...counts.values()].sort((a, b) => b.count - a.count)[0];
  return best ? [best.r, best.g, best.b] : [0, 0, 0];
}

function scanCanvasVisibleBounds(cssRect: { x: number; y: number; width: number; height: number }, threshold = 28) {
  const canvas = document.getElementById('unity-canvas') as HTMLCanvasElement | null;
  if (!canvas) return { ok: false, error: 'unity-canvas not found' };
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0 || canvas.width <= 0 || canvas.height <= 0) {
    return { ok: false, error: 'unity-canvas has empty dimensions' };
  }

  const sxRatio = canvas.width / rect.width;
  const syRatio = canvas.height / rect.height;
  const x0 = Math.max(0, Math.floor(cssRect.x * sxRatio));
  const y0 = Math.max(0, Math.floor(cssRect.y * syRatio));
  const x1 = Math.min(canvas.width - 1, Math.ceil((cssRect.x + cssRect.width) * sxRatio));
  const y1 = Math.min(canvas.height - 1, Math.ceil((cssRect.y + cssRect.height) * syRatio));
  if (x1 <= x0 || y1 <= y0) return { ok: false, error: 'scan rect is outside canvas buffer', bufferRect: { x0, y0, x1, y1 } };

  const copy = document.createElement('canvas');
  copy.width = canvas.width;
  copy.height = canvas.height;
  const ctx = copy.getContext('2d', { willReadFrequently: true });
  if (!ctx) return { ok: false, error: '2d context unavailable' };

  try {
    ctx.drawImage(canvas, 0, 0);
    const image = ctx.getImageData(0, 0, copy.width, copy.height);
    const bg = estimateBackgroundColor(image.data, copy.width, copy.height, { x0, y0, x1, y1 });
    const thresholdSq = threshold * threshold;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, count = 0;

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const offset = (y * copy.width + x) * 4;
        if (image.data[offset + 3] < 8) continue;
        if (colorDistanceSq(image.data, offset, bg) <= thresholdSq) continue;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
        count++;
      }
    }

    if (!Number.isFinite(minX)) {
      return {
        ok: true,
        background: bg,
        threshold,
        bufferRect: { x0, y0, x1, y1, width: x1 - x0 + 1, height: y1 - y0 + 1 },
        visiblePixelCount: 0,
        bounds: null,
        coverage: { widthRatio: 0, heightRatio: 0, areaRatio: 0 },
      };
    }

    const bounds = {
      buffer: {
        x: minX,
        y: minY,
        width: maxX - minX + 1,
        height: maxY - minY + 1,
        right: maxX,
        bottom: maxY,
      },
      css: {
        x: rectRound(minX / sxRatio),
        y: rectRound(minY / syRatio),
        width: rectRound((maxX - minX + 1) / sxRatio),
        height: rectRound((maxY - minY + 1) / syRatio),
        right: rectRound((maxX + 1) / sxRatio),
        bottom: rectRound((maxY + 1) / syRatio),
      },
    };

    return {
      ok: true,
      background: bg,
      threshold,
      bufferRect: { x0, y0, x1, y1, width: x1 - x0 + 1, height: y1 - y0 + 1 },
      visiblePixelCount: count,
      bounds,
      coverage: {
        widthRatio: rectRound(bounds.buffer.width / (x1 - x0 + 1)),
        heightRatio: rectRound(bounds.buffer.height / (y1 - y0 + 1)),
        areaRatio: rectRound(count / ((x1 - x0 + 1) * (y1 - y0 + 1))),
      },
    };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function visualProbe(idOrName?: string, args: Record<string, unknown> = {}) {
  const state = useEditorStore.getState();
  const id = findNodeId(idOrName, args)
    ?? state.selectedIds[0]
    ?? state.rootIds[0]
    ?? null;
  if (!id || !useEditorStore.getState().nodes[id]) throw new Error('visualProbe cannot find target node');

  const threshold = typeof args.threshold === 'number' ? args.threshold : Number(args.threshold ?? 28);
  const shouldSync = args.fullSync === true;
  if (shouldSync) fullSync();
  useEditorStore.getState().setSelectedIds([id]);
  const subtreeIds = args.subtreeBounds === false ? [id] : collectSubtreeIds(id);
  let focus: unknown = null;
  if (args.fitTarget === true) {
    focus = focusTargetInViewport(id, args);
    await waitFrames(3);
    await waitMs(250);
  }
  unityBridge.setSelection(subtreeIds);
  await waitFrames(3);
  await waitMs(250);

  const expected = getExpectedNodeScreenRect(id);
  const pixelScan = expected
    ? scanCanvasVisibleBounds(expected.css, Number.isFinite(threshold) ? threshold : 28)
    : null;
  const unityBounds = unityBridge.getLastNodeBounds();
  const matchingUnityBound = unityBounds.css.find((item) => item.id === id) ?? null;
  const targetSubtree = buildTargetSubtree(id, 120, unityBounds.css, {
    cropPadDesign: typeof args.cropPadDesign === 'number' ? args.cropPadDesign : Number(args.cropPadDesign ?? 24),
  });
  const diagnostics = expected ? buildVisualDiagnostics(expected, matchingUnityBound, pixelScan) : null;
  const targetTransparentMaskBoundIncludesContent = targetSubtree.notes.some((note) =>
    note.id === id && note.code === 'transparent-mask-bound-includes-content'
  );
  const targetLayoutDrivenBoundDiff = targetSubtree.notes.some((note) =>
    note.id === id && note.code === 'layout-driven-bound-diff'
  );
  const warnings: string[] = [];

  if (expected && matchingUnityBound) {
    const widthDelta = Math.abs(matchingUnityBound.width - expected.css.width);
    const heightDelta = Math.abs(matchingUnityBound.height - expected.css.height);
    if ((widthDelta > 2 || heightDelta > 2) && !targetTransparentMaskBoundIncludesContent) {
      warnings.push(`Unity selection bounds differ from expected store bounds by ${rectRound(widthDelta)}x${rectRound(heightDelta)} css px`);
    }
  }

  if (diagnostics?.likelyExtraPreviewScale) {
    warnings.push(`Unity/WebGL output appears to include an extra preview scale factor (${diagnostics.previewScaleFactor})`);
  }

  const scanAny = pixelScan as { ok?: boolean; coverage?: { widthRatio?: number; heightRatio?: number }; bounds?: { css?: { width: number; height: number } } | null } | null;
  if (scanAny?.ok && scanAny.coverage) {
    const targetNode = useEditorStore.getState().nodes[id];
    const targetIsText = targetNode?.type === 'text';
    const targetIsClippedByArtboard = expectedRectExtendsOutsideArtboard(expected);
    const targetShouldFillRect = nodeLikelyFillsOwnRect(targetNode);
    if (!targetIsText && targetShouldFillRect && !targetLayoutDrivenBoundDiff && !targetIsClippedByArtboard && (scanAny.coverage.widthRatio ?? 1) < 0.8) warnings.push(`Visible pixels cover only ${scanAny.coverage.widthRatio} of expected width`);
    if (!targetIsText && targetShouldFillRect && !targetLayoutDrivenBoundDiff && !targetIsClippedByArtboard && (scanAny.coverage.heightRatio ?? 1) < 0.8) warnings.push(`Visible pixels cover only ${scanAny.coverage.heightRatio} of expected height`);
  }

  return {
    at: new Date().toISOString(),
    focus,
    target: slimNode(useEditorStore.getState().nodes[id]),
    targetSubtree,
    expected,
    unityBounds,
    matchingUnityBound,
    camera: unityBridge.getLastCamera(),
    canvas: getCanvasMetrics(),
    pixelScan,
    diagnostics,
    warnings,
    snapshot: getSnapshot(),
    analysis: analyzeRuntime(),
  };
}

function hitTestDesign(x: number, y: number): string | null {
  const state = useEditorStore.getState();
  let result: string | null = null;

  function walk(nodeId: string, offsetX: number, offsetY: number) {
    const node = state.nodes[nodeId];
    if (!node || node.visible === false) return;
    const absX = offsetX + node.x;
    const absY = offsetY + node.y;
    const hit = x >= absX && x <= absX + node.width && y >= absY && y <= absY + node.height;
    if (hit) result = nodeId;
    for (const childId of node.children) walk(childId, absX, absY);
  }

  for (const rootId of state.rootIds) walk(rootId, 0, 0);
  return result;
}

function stripAt(value: string): string {
  return value.startsWith('@') ? value.slice(1) : value;
}

function normalizeTargetPath(value: string): string {
  return value
    .replace(/\\/g, '/')
    .split('/')
    .map((item) => stripAt(item.trim()))
    .filter(Boolean)
    .join('/');
}

function findNodeId(idOrName?: string, args: Record<string, unknown> = {}): string | null {
  const state = useEditorStore.getState();
  const targetId = typeof args.targetId === 'string' ? args.targetId : undefined;
  if (targetId && state.nodes[targetId]) return targetId;

  const targetPath = typeof args.targetPath === 'string'
    ? args.targetPath
    : typeof args.path === 'string'
      ? args.path
      : undefined;
  if (targetPath) {
    const normalized = normalizeTargetPath(targetPath);
    const byPath = Object.values(state.nodes).find((node) => normalizeTargetPath(nodePath(node.id)) === normalized);
    if (byPath) return byPath.id;
  }

  const unityFileId = typeof args.unityFileId === 'string'
    ? args.unityFileId
    : typeof args.targetUnityFileId === 'string'
      ? args.targetUnityFileId
      : undefined;
  if (unityFileId) {
    const byFileId = Object.values(state.nodes).find((node) => node.unityFileId === unityFileId);
    if (byFileId) return byFileId.id;
  }

  if (!idOrName) return null;
  if (state.nodes[idOrName]) return idOrName;
  const exact = Object.values(state.nodes).find((node) => node.name === idOrName);
  if (exact) return exact.id;
  const lower = idOrName.toLowerCase();
  return Object.values(state.nodes).find((node) => node.name.toLowerCase().includes(lower))?.id ?? null;
}

async function importPrefab(relPath: string, args: Record<string, unknown> = {}) {
  const name = typeof args.name === 'string' ? args.name : undefined;
  const parsed = await fetchPrefabTemplate(relPath, name);
  if (!parsed.root) throw new Error(`Prefab parse returned empty root: ${relPath}`);

  const initialStore = useEditorStore.getState();
  const targetPreviewWidth = initialStore.previewWidth;
  const targetPreviewHeight = initialStore.previewHeight;
  if (args.clear === true) initialStore.clearAll();
  useEditorStore.getState().setSourcePrefabPath(parsed.sourcePath || relPath);

  const rootW = parsed.root.width || 800;
  const rootH = parsed.root.height || 600;
  const rootHasUnityTransform = !!parsed.root.originalAnchoredPosition || !!parsed.root.originalSizeDelta;
  const hasPositionOverride = typeof args.x === 'number' || typeof args.y === 'number';
  const shouldAdaptFromDesignResolution = rootHasUnityTransform
    && !hasPositionOverride
    && (targetPreviewWidth !== DESIGN_WIDTH || targetPreviewHeight !== DESIGN_HEIGHT);
  if (shouldAdaptFromDesignResolution) {
    useEditorStore.getState().setPreviewResolution(DESIGN_WIDTH, DESIGN_HEIGHT);
  }
  const importStore = useEditorStore.getState();
  const x = typeof args.x === 'number'
    ? args.x
    : rootHasUnityTransform
      ? undefined
      : Math.max(0, (importStore.previewWidth - rootW) / 2);
  const y = typeof args.y === 'number'
    ? args.y
    : rootHasUnityTransform
      ? undefined
      : Math.max(0, (importStore.previewHeight - rootH) / 2);
  const importOverride: { x?: number; y?: number; name?: string } = {
    name: typeof args.rootName === 'string' ? args.rootName : parsed.name || name,
  };
  if (x !== undefined) importOverride.x = x;
  if (y !== undefined) importOverride.y = y;
  const rootId = importPrefabTemplateNode(parsed.root, null, useEditorStore.getState().addNode, importOverride);
  if (shouldAdaptFromDesignResolution) {
    useEditorStore.getState().setPreviewResolution(targetPreviewWidth, targetPreviewHeight);
  }
  useEditorStore.getState().setSelectedIds([rootId]);
  fullSync();

  return {
    rootId,
    parsedName: parsed.name,
    sourcePath: parsed.sourcePath,
    snapshot: getSnapshot(),
    analysis: analyzeRuntime(),
  };
}

async function openBridgePrefab(prefabPath: string) {
  await openPrefabInActiveArtboard(prefabPath);
  await waitFrames(3);
  await waitMs(250);
  return {
    bridge: getBridgeBboxes(),
    snapshot: getSnapshot(),
    analysis: analyzeRuntime(),
  };
}

function clearRuntime() {
  useEditorStore.getState().clearAll();
  fullSync();
  return getSnapshot();
}

function selectNode(idOrName: string) {
  const id = findNodeId(idOrName);
  const ids = id ? [id] : [];
  useEditorStore.getState().setSelectedIds(ids);
  unityBridge.setSelection(ids);
  return { selectedId: id, snapshot: getSnapshot() };
}

function getDebugNode(idOrName: string) {
  const id = findNodeId(idOrName);
  return { id, node: id ? slimNode(useEditorStore.getState().nodes[id]) : null };
}

function getBridgeBboxes() {
  const artboard = getActiveArtboard();
  return {
    rootNodeId: artboard?.bridgeRootNodeId ?? null,
    snapshot: artboard?.bridgeSnapshot ?? null,
    bboxes: artboard?.bridgeSnapshot?.bboxes ?? [],
    selectedIds: useEditorStore.getState().selectedIds,
  };
}

function getActivePage(): PageData | null {
  const state = useEditorStore.getState();
  return state.pages.find((item) => item.id === state.activePageId) ?? null;
}

function getBridgeBoxForNode(artboard: PageData['artboards'][number], nodeId: string): BboxRecord | null {
  const boxes = (artboard.bridgeSnapshot?.bboxes ?? []) as BboxRecord[];
  const box = boxes.find((item) => item.nodeId === nodeId) ?? null;
  if (!box || !box.activeInHierarchy || box.width <= 0 || box.height <= 0) return null;
  return box;
}

function findNodeArtboardForDebug(nodeId: string): { artboard: PageData['artboards'][number]; box: BboxRecord } | null {
  const state = useEditorStore.getState();
  const activePage = getActivePage();
  if (!activePage) return null;
  for (const artboard of activePage.artboards) {
    const nodes = artboard.id === state.activeArtboardId ? state.nodes : artboard.nodes;
    if (!nodes[nodeId]) continue;
    const box = getBridgeBoxForNode(artboard, nodeId);
    if (box) return { artboard, box };
  }
  return null;
}

function bridgeCenterForDebug(nodeId: string) {
  const located = findNodeArtboardForDebug(nodeId);
  if (!located) throw new Error(`Cannot find Bridge bbox for node ${nodeId}`);
  const { artboard, box } = located;
  return {
    artboardId: artboard.id,
    nodeId,
    local: {
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
    },
    page: {
      x: artboard.x + box.x + box.width / 2,
      y: artboard.y + box.y + box.height / 2,
    },
    bbox: box,
  };
}

function addFlowLineAnnotation(srcIdOrName: string, dstIdOrName: string) {
  const srcId = findNodeId(srcIdOrName);
  const dstId = findNodeId(dstIdOrName);
  if (!srcId) throw new Error(`Cannot find flow-line source node ${srcIdOrName}`);
  if (!dstId) throw new Error(`Cannot find flow-line target node ${dstIdOrName}`);
  const src = bridgeCenterForDebug(srcId);
  const dst = bridgeCenterForDebug(dstId);
  const id = useEditorStore.getState().addAnnotation('flow-line', src.page.x, src.page.y, {
    refNodeId: srcId,
    text: dstId,
    color: '#f9e2af',
    strokeWidth: 4,
    arrowEnd: 'end',
  });
  useEditorStore.getState().setSelectedAnnotationIds([id]);
  return {
    id,
    srcId,
    dstId,
    src,
    dst,
    annotation: useEditorStore.getState().annotations[id],
  };
}

function addOutsideRectAnnotation(args: Record<string, unknown> = {}) {
  const artboard = getActiveArtboard();
  if (!artboard) throw new Error('No active artboard');
  const page = getActivePage();
  const pageRight = page?.artboards.length
    ? Math.max(...page.artboards.map((item) => item.x + item.width))
    : artboard.x + artboard.width;
  const x = typeof args.x === 'number' ? args.x : pageRight + 110;
  const y = typeof args.y === 'number' ? args.y : artboard.y + 72;
  const width = typeof args.width === 'number' ? args.width : 130;
  const height = typeof args.height === 'number' ? args.height : 78;
  const id = useEditorStore.getState().addAnnotation('rect', x, y, {
    width,
    height,
    color: typeof args.color === 'string' ? args.color : '#94e2d5',
    strokeWidth: typeof args.strokeWidth === 'number' ? args.strokeWidth : 4,
  });
  useEditorStore.getState().setSelectedAnnotationIds([id]);
  return {
    id,
    annotation: useEditorStore.getState().annotations[id],
    artboard: {
      id: artboard.id,
      x: artboard.x,
      y: artboard.y,
      width: artboard.width,
      height: artboard.height,
    },
  };
}

function canvasDiffSummary(before: HTMLCanvasElement, after: HTMLCanvasElement) {
  const width = Math.min(before.width, after.width);
  const height = Math.min(before.height, after.height);
  const beforeCtx = before.getContext('2d');
  const afterCtx = after.getContext('2d');
  if (!beforeCtx || !afterCtx || width <= 0 || height <= 0) return null;
  const a = beforeCtx.getImageData(0, 0, width, height).data;
  const b = afterCtx.getImageData(0, 0, width, height).data;
  let changed = 0;
  let flowColorish = 0;
  let maxDiff = 0;
  for (let i = 0; i < a.length; i += 4) {
    const dr = Math.abs(a[i] - b[i]);
    const dg = Math.abs(a[i + 1] - b[i + 1]);
    const db = Math.abs(a[i + 2] - b[i + 2]);
    const da = Math.abs(a[i + 3] - b[i + 3]);
    const diff = dr + dg + db + da;
    if (diff > 24) changed += 1;
    if (diff > maxDiff) maxDiff = diff;
    if (
      Math.abs(b[i] - 249) < 36 &&
      Math.abs(b[i + 1] - 226) < 36 &&
      Math.abs(b[i + 2] - 175) < 42 &&
      b[i + 3] > 160
    ) {
      flowColorish += 1;
    }
  }
  return {
    width,
    height,
    changedPixels: changed,
    changedRatio: Math.round((changed / Math.max(1, width * height)) * 1_000_000) / 1_000_000,
    flowColorishPixels: flowColorish,
    maxDiff,
  };
}

async function captureLayerWholeShotSummary() {
  const page = getActivePage();
  if (!page) throw new Error('No active page');
  const withoutAnnotations = await captureLayerWholeShot(page, false);
  const withAnnotations = await captureLayerWholeShot(page, true);
  if (!withoutAnnotations || !withAnnotations) throw new Error('captureLayerWholeShot returned null');
  return {
    pageId: page.id,
    artboardCount: page.artboards.length,
    withoutAnnotations: {
      width: withoutAnnotations.canvas.width,
      height: withoutAnnotations.canvas.height,
      bboxW: withoutAnnotations.bboxW,
      bboxH: withoutAnnotations.bboxH,
      designToPixelRatio: withoutAnnotations.designToPixelRatio,
    },
    withAnnotations: {
      width: withAnnotations.canvas.width,
      height: withAnnotations.canvas.height,
      bboxW: withAnnotations.bboxW,
      bboxH: withAnnotations.bboxH,
      designToPixelRatio: withAnnotations.designToPixelRatio,
    },
    diff: canvasDiffSummary(withoutAnnotations.canvas, withAnnotations.canvas),
  };
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function waitFrames(count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  }
}

function makePointerEvent(type: string, init: PointerEventInit): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: 9301,
    pointerType: 'mouse',
    isPrimary: true,
    ...init,
  });
}

function findMoveDragHandle(): Element | null {
  return document.querySelector('[data-testid="transform-handle-move"]')
    ?? document.querySelector('[data-overlay-root] [data-drag-handle="move"]')
    ?? document.querySelector('[data-overlay-root] [data-drag-handle]');
}

async function waitForMoveDragHandle(): Promise<Element | null> {
  for (let i = 0; i < 30; i++) {
    const handle = findMoveDragHandle();
    if (handle) return handle;
    await waitMs(100);
  }
  return null;
}

async function dragSelectedByScreenDelta(deltaX: number, deltaY: number, idOrName?: string) {
  const state = useEditorStore.getState();
  const id = idOrName
    ? findNodeId(idOrName)
    : state.selectedIds[0] ?? state.rootIds[0] ?? null;
  if (!id || !state.nodes[id]) throw new Error('dragSelectedByScreenDelta cannot find target node');

  state.setSceneTool('move');
  state.setSelectedIds([id]);
  await waitFrames(2);

  const handle = await waitForMoveDragHandle();
  if (!handle) throw new Error('dragSelectedByScreenDelta cannot find move handle');

  const beforeNode = slimNode(useEditorStore.getState().nodes[id]);
  const beforeHandleRect = handle.getBoundingClientRect();
  const startX = beforeHandleRect.left + beforeHandleRect.width / 2;
  const startY = beforeHandleRect.top + beforeHandleRect.height / 2;

  handle.dispatchEvent(makePointerEvent('pointerdown', {
    clientX: startX,
    clientY: startY,
    button: 0,
    buttons: 1,
  }));
  await waitFrames(1);
  window.dispatchEvent(makePointerEvent('pointermove', {
    clientX: startX + deltaX,
    clientY: startY + deltaY,
    button: 0,
    buttons: 1,
  }));
  await waitFrames(2);
  window.dispatchEvent(makePointerEvent('pointerup', {
    clientX: startX + deltaX,
    clientY: startY + deltaY,
    button: 0,
    buttons: 0,
  }));
  await waitMs(300);

  const afterNode = slimNode(useEditorStore.getState().nodes[id]);
  const snapshot = getSnapshot() as {
    preview?: { screenScale?: number };
  };
  const screenScale = snapshot.preview?.screenScale ?? 1;
  return {
    id,
    screenDelta: { x: deltaX, y: deltaY },
    expectedDesignDelta: {
      x: screenScale > 0 ? deltaX / screenScale : null,
      y: screenScale > 0 ? deltaY / screenScale : null,
    },
    actualDesignDelta: {
      x: afterNode.x - beforeNode.x,
      y: afterNode.y - beforeNode.y,
    },
    beforeNode,
    afterNode,
    snapshot,
    unityMessages: unityBridge.getDebugMessages().slice(-10),
  };
}

async function createBridgeFrame(args: Record<string, unknown> = {}) {
  const name = typeof args.name === 'string' ? args.name : `DebugFrame_${Date.now()}`;
  await createWidgetNodeOnBridge({
    widgetType: 'frame',
    name,
    x: typeof args.x === 'number' ? args.x : 0,
    y: typeof args.y === 'number' ? args.y : 0,
    width: typeof args.width === 'number' ? args.width : 180,
    height: typeof args.height === 'number' ? args.height : 120,
    parentId: typeof args.parentId === 'string' ? args.parentId : undefined,
  });
  await waitFrames(2);
  const selected = selectNode(name);
  return {
    name,
    selectedId: selected.selectedId,
    node: selected.selectedId ? slimNode(useEditorStore.getState().nodes[selected.selectedId]) : null,
    snapshot: getSnapshot(),
  };
}

function postJson(path: string, body: unknown): Promise<void> {
  return fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(() => undefined);
}

function scheduleReport(kind = 'store-change') {
  if (!enabled) return;
  if (reportTimer !== null) window.clearTimeout(reportTimer);
  reportTimer = window.setTimeout(() => {
    reportTimer = null;
    void sendReport(kind);
  }, 400);
}

async function sendReport(kind: string) {
  try {
    await postJson('/api/uieditor-debug/report', {
      clientId,
      kind,
      payload: {
        snapshot: getSnapshot(),
        analysis: analyzeRuntime(),
        unityMessages: unityBridge.getDebugMessages().slice(-10),
      },
    });
  } catch {
    // Debug server is optional; keep the editor quiet when it is not mounted.
  }
}

async function executeCommand(command: RuntimeCommand): Promise<unknown> {
  const args = command.args && typeof command.args === 'object' ? command.args as Record<string, unknown> : {};
  switch (command.command) {
    case 'snapshot':
      return getSnapshot();
    case 'tree':
      return buildLayerTree();
    case 'syncPayload':
      return getSyncPayload();
    case 'analyze':
      return analyzeRuntime();
    case 'visualProbe': {
      const idOrName = typeof args.id === 'string'
        ? args.id
        : typeof args.name === 'string'
          ? args.name
          : undefined;
      return await visualProbe(idOrName, args);
    }
    case 'importPrefab': {
      const relPath = typeof args.relPath === 'string'
        ? args.relPath
        : typeof args.path === 'string'
          ? args.path
          : '';
      if (!relPath) throw new Error('importPrefab requires args.relPath');
      return await importPrefab(relPath, args);
    }
    case 'clear':
      return clearRuntime();
    case 'select': {
      const idOrName = typeof args.id === 'string'
        ? args.id
        : typeof args.name === 'string'
          ? args.name
          : '';
      if (!idOrName) throw new Error('select requires args.id or args.name');
      return selectNode(idOrName);
    }
    case 'setPreviewResolution': {
      const width = typeof args.width === 'number' ? args.width : Number(args.width ?? args.w);
      const height = typeof args.height === 'number' ? args.height : Number(args.height ?? args.h);
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        throw new Error('setPreviewResolution requires positive width/height');
      }
      useEditorStore.getState().setPreviewResolution(width, height);
      return getSnapshot();
    }
    case 'reload':
      window.setTimeout(() => window.location.reload(), 500);
      return { ok: true };
    case 'hitTestDesign': {
      const x = typeof args.x === 'number' ? args.x : Number(args.x);
      const y = typeof args.y === 'number' ? args.y : Number(args.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('hitTestDesign requires numeric x/y');
      const id = hitTestDesign(x, y);
      return { id, node: id ? slimNode(useEditorStore.getState().nodes[id]) : null };
    }
    case 'clickDesign': {
      const x = typeof args.x === 'number' ? args.x : Number(args.x);
      const y = typeof args.y === 'number' ? args.y : Number(args.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('clickDesign requires numeric x/y');
      const id = hitTestDesign(x, y);
      useEditorStore.getState().setSelectedIds(id ? [id] : []);
      return { selectedId: id, snapshot: getSnapshot() };
    }
    case 'dragSelectedByScreenDelta': {
      const deltaX = typeof args.deltaX === 'number' ? args.deltaX : Number(args.deltaX ?? args.dx);
      const deltaY = typeof args.deltaY === 'number' ? args.deltaY : Number(args.deltaY ?? args.dy);
      const idOrName = typeof args.id === 'string'
        ? args.id
        : typeof args.name === 'string'
          ? args.name
          : undefined;
      if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) {
        throw new Error('dragSelectedByScreenDelta requires numeric deltaX/deltaY');
      }
      return await dragSelectedByScreenDelta(deltaX, deltaY, idOrName);
    }
    case 'moveNode': {
      const idOrName = typeof args.id === 'string'
        ? args.id
        : typeof args.name === 'string'
          ? args.name
          : '';
      const id = idOrName ? findNodeId(idOrName) : null;
      const x = typeof args.x === 'number' ? args.x : Number(args.x);
      const y = typeof args.y === 'number' ? args.y : Number(args.y);
      if (!id) throw new Error('moveNode cannot find node');
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('moveNode requires numeric x/y');
      useEditorStore.getState().moveNode(id, x, y);
      fullSync();
      return { movedId: id, snapshot: getSnapshot() };
    }
    case 'fullSync':
      fullSync();
      return analyzeRuntime();
    case 'unityMessages':
      return unityBridge.getDebugMessages();
    case 'clearUnityMessages':
      unityBridge.clearDebugMessages();
      return { ok: true };
    default:
      throw new Error(`Unknown debug command: ${command.command}`);
  }
}

async function pollCommands() {
  if (polling || !enabled) return;
  polling = true;
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 5000);
  try {
    const params = new URLSearchParams({ clientId });
    const response = await fetch(`/api/uieditor-debug/commands?${params.toString()}`, { cache: 'no-cache', signal: controller.signal });
    if (!response.ok) return;
    const data = await response.json() as { commands?: RuntimeCommand[] };
    const pending = Array.isArray(data.commands) ? data.commands : [];
    for (const command of pending) {
      try {
        const result = await executeCommand(command);
        await postJson('/api/uieditor-debug/result', {
          id: command.id,
          command: command.command,
          ok: true,
          result,
          clientId,
        });
        await sendReport(`command:${command.command}`);
      } catch (err: unknown) {
        await postJson('/api/uieditor-debug/result', {
          id: command.id,
          command: command.command,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          clientId,
        });
      }
    }
  } catch {
    // Debug server is optional.
  } finally {
    window.clearTimeout(timeoutId);
    polling = false;
  }
}

if (enabled) {
  window.__UIEDITOR_DEBUG__ = {
    snapshot: getSnapshot,
    tree: buildLayerTree,
    syncPayload: getSyncPayload,
    analyze: analyzeRuntime,
    visualProbe,
    focusTargetInViewport,
    importPrefab,
    openBridgePrefab,
    clear: clearRuntime,
    select: selectNode,
    node: getDebugNode,
    setPreviewResolution: (width: number, height: number) => {
      useEditorStore.getState().setPreviewResolution(width, height);
      return getSnapshot();
    },
    reload: () => {
      window.setTimeout(() => window.location.reload(), 500);
      return { ok: true };
    },
    hitTestDesign: (x: number, y: number) => {
      const id = hitTestDesign(x, y);
      return { id, node: id ? slimNode(useEditorStore.getState().nodes[id]) : null };
    },
    dragSelectedByScreenDelta,
    createBridgeFrame,
    addFlowLineAnnotation,
    addOutsideRectAnnotation,
    captureLayerWholeShotSummary,
    bridgeBboxes: getBridgeBboxes,
    fullSync: () => {
      fullSync();
      return analyzeRuntime();
    },
    unityMessages: () => unityBridge.getDebugMessages(),
  };

  useEditorStore.subscribe((state, prev) => {
    if (
      state.nodes !== prev.nodes ||
      state.rootIds !== prev.rootIds ||
      state.pages !== prev.pages ||
      state.activePageId !== prev.activePageId ||
      state.activeArtboardId !== prev.activeArtboardId ||
      state.selectedIds !== prev.selectedIds ||
      state.previewWidth !== prev.previewWidth ||
      state.previewHeight !== prev.previewHeight ||
      state.canvasX !== prev.canvasX ||
      state.canvasY !== prev.canvasY ||
      state.canvasScale !== prev.canvasScale
    ) {
      scheduleReport();
    }
  });

  window.setInterval(() => {
    void pollCommands();
  }, 700);
  window.setTimeout(() => {
    void sendReport('boot');
  }, 500);
}

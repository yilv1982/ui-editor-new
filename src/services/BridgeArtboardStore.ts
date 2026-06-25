import { v4 as uuid } from 'uuid';
import { useEditorStore } from '../stores/editorStore';
import type { Artboard, PageData, UINode, UIStyle, NodeType } from '../types';
import { defaultStyle } from '../types';
import editorBridgeClient, {
  type ArtboardStateResponse,
  type BboxRecord,
  EditorBridgeRequestError,
  type NodeRecord,
  type SessionInfo,
  type SnapshotRecord,
  type VisualPatchOperation,
} from './EditorBridgeClient';
import { debugLog } from '../utils/debugLog';

const DEFAULT_SAVE_ROOT = 'Assets/HotRes2/UIs/Prefabs';
let bridgeStateApplyDepth = 0;

export function isApplyingBridgeState(): boolean {
  return bridgeStateApplyDepth > 0;
}

function basename(path: string | null | undefined): string {
  if (!path) return 'NewUI';
  return (path.split(/[\\/]/).pop() || path).replace(/\.prefab$/i, '') || 'NewUI';
}

function normalizeTargetPath(value: string): string {
  let path = value.replace(/\\/g, '/').trim();
  if (!path) return '';
  if (!path.startsWith('Assets/')) path = `${DEFAULT_SAVE_ROOT}/${path.replace(/^\/+/, '')}`;
  if (!path.endsWith('.prefab')) path += '.prefab';
  return path;
}

function prefabIdentity(value: string | null | undefined): string {
  return value ? normalizeTargetPath(value).toLowerCase() : '';
}

function defaultTargetFor(name: string): string {
  return `${DEFAULT_SAVE_ROOT}/${name || 'NewUI'}.prefab`;
}

function normalizePanelFramework(value: string | null | undefined): string | undefined {
  if (value === 'ugui' || value === 'ngui') return value;
  return undefined;
}

function summaryString(node: NodeRecord, componentType: string, key: string): string {
  const value = node.components.find((component) => component.type === componentType)?.summary?.[key];
  return typeof value === 'string' ? value : '';
}

function summaryNumber(node: NodeRecord, componentType: string, key: string): number | undefined {
  const value = node.components.find((component) => component.type === componentType)?.summary?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function summaryBool(node: NodeRecord, componentType: string, key: string): boolean | undefined {
  const value = node.components.find((component) => component.type === componentType)?.summary?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

function alphaFromColor(value: string | undefined): number | undefined {
  if (!value || !value.startsWith('#') || value.length < 9) return undefined;
  const alpha = Number.parseInt(value.slice(7, 9), 16);
  return Number.isFinite(alpha) ? Math.round((alpha / 255) * 1000) / 1000 : undefined;
}

function hasComponent(node: NodeRecord, type: string): boolean {
  return node.components.some((component) => component.type === type);
}

function firstComponentType(node: NodeRecord, types: string[]): string | undefined {
  return types.find((type) => hasComponent(node, type));
}

function duplicateNodeIds(nodes: Array<{ nodeId: string }>): string[] {
  const counts = new Map<string, number>();
  for (const node of nodes) counts.set(node.nodeId, (counts.get(node.nodeId) ?? 0) + 1);
  return [...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id);
}

function isVisibleBbox(box: BboxRecord | undefined): boolean {
  return !!box && box.activeInHierarchy && box.width > 1 && box.height > 1;
}

function mergeBbox(a: BboxRecord, b: BboxRecord): BboxRecord {
  const left = Math.min(a.x, b.x);
  const top = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return {
    ...b,
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    activeInHierarchy: a.activeInHierarchy || b.activeInHierarchy,
    space: a.space === b.space ? a.space : (b.space || a.space),
  };
}

function normalizeSnapshot(snapshot: SnapshotRecord | null | undefined): SnapshotRecord | null | undefined {
  if (!snapshot?.bboxes?.length) return snapshot;
  const byNodeId = new Map<string, BboxRecord>();
  for (const box of snapshot.bboxes) {
    const prev = byNodeId.get(box.nodeId);
    if (!prev) {
      byNodeId.set(box.nodeId, box);
      continue;
    }
    if (isVisibleBbox(prev) && isVisibleBbox(box)) {
      byNodeId.set(box.nodeId, mergeBbox(prev, box));
    } else if (!isVisibleBbox(prev) && isVisibleBbox(box)) {
      byNodeId.set(box.nodeId, box);
    }
  }
  return { ...snapshot, bboxes: [...byNodeId.values()] };
}

function nodeTypeOf(node: NodeRecord): NodeType {
  if (hasComponent(node, 'Text') || hasComponent(node, 'UILabel')) return 'text';
  if (hasComponent(node, 'InputField')) return 'inputfield';
  if (hasComponent(node, 'Button') || hasComponent(node, 'UIButton')) return 'button';
  if (hasComponent(node, 'Toggle')) return 'toggle';
  if (hasComponent(node, 'ScrollRect')) return 'scrollview';
  if (hasComponent(node, 'RawImage')) return 'rawimage';
  if (hasComponent(node, 'Image') || hasComponent(node, 'UISprite') || hasComponent(node, 'UITexture') || hasComponent(node, 'UI2DSprite')) return 'image';
  return 'frame';
}

function mapBridgeNode(node: NodeRecord): UINode {
  const rect = node.rectTransform;
  const pos = rect?.anchoredPosition ?? [0, 0];
  const size = rect?.sizeDelta ?? [Math.max(1, node.bbox?.width ?? 100), Math.max(1, node.bbox?.height ?? 100)];
  const textComponent = firstComponentType(node, ['Text', 'UILabel']) ?? 'Text';
  const imageComponent = firstComponentType(node, ['Image', 'UISprite', 'UITexture', 'UI2DSprite']) ?? 'Image';
  const widgetComponent = firstComponentType(node, ['UIWidget', 'UILabel', 'UISprite', 'UITexture', 'UI2DSprite']);
  const buttonComponent = firstComponentType(node, ['Button', 'UIButton']) ?? 'Button';
  const fontSize = summaryNumber(node, textComponent, 'fontSize') ?? defaultStyle.fontSize;
  const rawTextColor = summaryString(node, textComponent, 'color');
  const textColor = rawTextColor || defaultStyle.fontColor;
  const imageColor = summaryString(node, imageComponent, 'color') || (widgetComponent ? summaryString(node, widgetComponent, 'color') : '');
  const graphicColor = rawTextColor || imageColor || summaryString(node, 'RawImage', 'color');
  const canvasGroupAlpha = summaryNumber(node, 'CanvasGroup', 'alpha');
  const widgetAlpha = widgetComponent ? summaryNumber(node, widgetComponent, 'alpha') : undefined;
  const textAlignValue = summaryNumber(node, textComponent, 'alignmentValue');
  const outline = hasComponent(node, 'Outline') ? {
    color: summaryString(node, 'Outline', 'color') || '#000000',
    distance: [summaryNumber(node, 'Outline', 'distanceX') ?? 1, summaryNumber(node, 'Outline', 'distanceY') ?? -1] as [number, number],
    useGraphicAlpha: summaryBool(node, 'Outline', 'useGraphicAlpha'),
  } : undefined;
  const shadow = hasComponent(node, 'Shadow') ? {
    color: summaryString(node, 'Shadow', 'color') || '#000000',
    distance: [summaryNumber(node, 'Shadow', 'distanceX') ?? 1, summaryNumber(node, 'Shadow', 'distanceY') ?? -1] as [number, number],
    useGraphicAlpha: summaryBool(node, 'Shadow', 'useGraphicAlpha'),
  } : undefined;
  const layoutType = summaryString(node, 'HorizontalLayoutGroup', 'layoutType') ||
    summaryString(node, 'VerticalLayoutGroup', 'layoutType') ||
    summaryString(node, 'GridLayoutGroup', 'layoutType');
  const style: UIStyle = {
    ...defaultStyle,
    fontSize,
    fontColor: textColor,
    textAlign: textAlignValue === 4 || textAlignValue === 1 || textAlignValue === 7 ? 'center' : (textAlignValue === 5 || textAlignValue === 2 || textAlignValue === 8 ? 'right' : 'left'),
    backgroundOpacity: nodeTypeOf(node) === 'frame' ? 0 : defaultStyle.backgroundOpacity,
    opacity: alphaFromColor(graphicColor) ?? widgetAlpha ?? canvasGroupAlpha ?? defaultStyle.opacity,
  };
  return {
    id: node.nodeId,
    name: node.name,
    type: nodeTypeOf(node),
    x: Math.round((pos[0] ?? 0) * 1000) / 1000,
    y: Math.round((pos[1] ?? 0) * 1000) / 1000,
    width: Math.max(1, Math.round((size[0] ?? 1) * 1000) / 1000),
    height: Math.max(1, Math.round((size[1] ?? 1) * 1000) / 1000),
    rotation: rect?.localEulerAngles?.[2] ?? 0,
    visible: node.activeSelf,
    locked: false,
    children: [...node.children],
    parentId: node.parentId ?? null,
    style,
    text: summaryString(node, textComponent, 'text'),
    fontPath: summaryString(node, textComponent, 'fontPath') || undefined,
    fontStyle: summaryNumber(node, textComponent, 'fontStyle'),
    alignment: textAlignValue,
    richText: summaryBool(node, textComponent, 'richText'),
    horizontalOverflow: summaryNumber(node, textComponent, 'horizontalOverflow'),
    verticalOverflow: summaryNumber(node, textComponent, 'verticalOverflow'),
    lineSpacing: summaryNumber(node, textComponent, 'lineSpacing'),
    bestFit: summaryBool(node, textComponent, 'bestFit'),
    bestFitMinSize: summaryNumber(node, textComponent, 'bestFitMinSize'),
    bestFitMaxSize: summaryNumber(node, textComponent, 'bestFitMaxSize'),
    raycastTarget: summaryBool(node, textComponent, 'raycastTarget'),
    textOutline: outline,
    textShadow: shadow,
    imageData: summaryString(node, imageComponent, 'spritePath') || summaryString(node, imageComponent, 'sprite'),
    imageType: summaryString(node, imageComponent, 'imageType') as UINode['imageType'],
    imageColor: imageColor || undefined,
    imageEnabled: summaryBool(node, imageComponent, 'enabled'),
    imageRaycastTarget: summaryBool(node, imageComponent, 'raycastTarget'),
    fillCenter: summaryBool(node, imageComponent, 'fillCenter'),
    fillMethod: summaryNumber(node, imageComponent, 'fillMethod'),
    fillOrigin: summaryNumber(node, imageComponent, 'fillOrigin'),
    fillAmount: summaryNumber(node, imageComponent, 'fillAmount'),
    fillClockwise: summaryBool(node, imageComponent, 'fillClockwise'),
    useSpriteMesh: summaryBool(node, imageComponent, 'useSpriteMesh'),
    preserveAspect: summaryBool(node, imageComponent, 'preserveAspect'),
    outline,
    interactable: summaryBool(node, buttonComponent, 'interactable') ?? summaryBool(node, 'Toggle', 'interactable'),
    buttonTransition: summaryNumber(node, buttonComponent, 'transition'),
    buttonColors: hasComponent(node, 'Button') ? {
      normalColor: summaryString(node, 'Button', 'normalColor') || '#FFFFFFFF',
      highlightedColor: summaryString(node, 'Button', 'highlightedColor') || '#FFFFFFFF',
      pressedColor: summaryString(node, 'Button', 'pressedColor') || '#FFFFFFFF',
      disabledColor: summaryString(node, 'Button', 'disabledColor') || '#80808080',
      colorMultiplier: summaryNumber(node, 'Button', 'colorMultiplier') ?? 1,
      fadeDuration: summaryNumber(node, 'Button', 'fadeDuration') ?? 0.1,
    } : undefined,
    isMask: hasComponent(node, 'Mask') || hasComponent(node, 'RectMask2D'),
    maskType: hasComponent(node, 'RectMask2D') ? 'RectMask2D' : (hasComponent(node, 'Mask') ? 'Mask' : undefined),
    maskShowGraphic: summaryBool(node, 'Mask', 'showMaskGraphic'),
    scrollDirection: hasComponent(node, 'ScrollRect')
      ? ((summaryBool(node, 'ScrollRect', 'horizontal') && summaryBool(node, 'ScrollRect', 'vertical')) ? 'both' : (summaryBool(node, 'ScrollRect', 'horizontal') ? 'horizontal' : 'vertical'))
      : undefined,
    isOn: summaryBool(node, 'Toggle', 'isOn'),
    layoutElement: hasComponent(node, 'LayoutElement') ? {
      ignoreLayout: summaryBool(node, 'LayoutElement', 'ignoreLayout') ?? false,
      minWidth: summaryNumber(node, 'LayoutElement', 'minWidth') ?? -1,
      minHeight: summaryNumber(node, 'LayoutElement', 'minHeight') ?? -1,
      preferredWidth: summaryNumber(node, 'LayoutElement', 'preferredWidth') ?? -1,
      preferredHeight: summaryNumber(node, 'LayoutElement', 'preferredHeight') ?? -1,
      flexibleWidth: summaryNumber(node, 'LayoutElement', 'flexibleWidth') ?? -1,
      flexibleHeight: summaryNumber(node, 'LayoutElement', 'flexibleHeight') ?? -1,
    } : undefined,
    layoutGroup: layoutType ? {
      enabled: summaryBool(node, `${layoutType}LayoutGroup`, 'enabled') ?? true,
      isHorizontal: layoutType === 'Horizontal',
      isGrid: layoutType === 'Grid',
      layoutType: layoutType as 'Horizontal' | 'Vertical' | 'Grid',
      spacing: summaryNumber(node, `${layoutType}LayoutGroup`, 'spacing') ?? 0,
      spacingY: summaryNumber(node, 'GridLayoutGroup', 'spacingY') ?? 0,
      padLeft: summaryNumber(node, `${layoutType}LayoutGroup`, 'padLeft') ?? 0,
      padRight: summaryNumber(node, `${layoutType}LayoutGroup`, 'padRight') ?? 0,
      padTop: summaryNumber(node, `${layoutType}LayoutGroup`, 'padTop') ?? 0,
      padBottom: summaryNumber(node, `${layoutType}LayoutGroup`, 'padBottom') ?? 0,
      childAlignment: summaryNumber(node, `${layoutType}LayoutGroup`, 'childAlignment') ?? 0,
      childControlWidth: summaryBool(node, `${layoutType}LayoutGroup`, 'childControlWidth') ?? false,
      childControlHeight: summaryBool(node, `${layoutType}LayoutGroup`, 'childControlHeight') ?? false,
      childForceExpandWidth: summaryBool(node, `${layoutType}LayoutGroup`, 'childForceExpandWidth') ?? false,
      childForceExpandHeight: summaryBool(node, `${layoutType}LayoutGroup`, 'childForceExpandHeight') ?? false,
      reverseArrangement: summaryBool(node, `${layoutType}LayoutGroup`, 'reverseArrangement'),
      cellSizeX: summaryNumber(node, 'GridLayoutGroup', 'cellSizeX'),
      cellSizeY: summaryNumber(node, 'GridLayoutGroup', 'cellSizeY'),
      startCorner: summaryNumber(node, 'GridLayoutGroup', 'startCorner'),
      startAxis: summaryNumber(node, 'GridLayoutGroup', 'startAxis'),
      constraint: summaryNumber(node, 'GridLayoutGroup', 'constraint'),
      constraintCount: summaryNumber(node, 'GridLayoutGroup', 'constraintCount'),
    } : undefined,
    contentSizeFitter: hasComponent(node, 'ContentSizeFitter') ? {
      enabled: summaryBool(node, 'ContentSizeFitter', 'enabled') ?? true,
      horizontalFit: summaryNumber(node, 'ContentSizeFitter', 'horizontalFit') ?? 0,
      verticalFit: summaryNumber(node, 'ContentSizeFitter', 'verticalFit') ?? 0,
    } : undefined,
    unityFileId: node.unityFileId,
    anchorMin: rect ? { x: rect.anchorMin[0] ?? 0, y: rect.anchorMin[1] ?? 0 } : undefined,
    anchorMax: rect ? { x: rect.anchorMax[0] ?? 0, y: rect.anchorMax[1] ?? 0 } : undefined,
    pivot: rect ? { x: rect.pivot[0] ?? 0.5, y: rect.pivot[1] ?? 0.5 } : undefined,
    originalAnchoredPosition: rect ? { x: rect.anchoredPosition[0] ?? 0, y: rect.anchoredPosition[1] ?? 0 } : undefined,
    originalSizeDelta: rect ? { x: rect.sizeDelta[0] ?? 0, y: rect.sizeDelta[1] ?? 0 } : undefined,
    localScale: rect ? { x: rect.localScale[0] ?? 1, y: rect.localScale[1] ?? 1, z: rect.localScale[2] ?? 1 } : undefined,
  };
}

function pickDefaultSelection(snapshot: SnapshotRecord | null | undefined, rootNodeId: string | null | undefined): string | null {
  const visible = snapshot?.bboxes.find((box) => (
    box.activeInHierarchy &&
    box.width > 4 &&
    box.height > 4 &&
    box.width < (snapshot.width * 0.98) &&
    box.height < (snapshot.height * 0.98)
  ));
  return visible?.nodeId ?? rootNodeId ?? null;
}

async function stateFromSession(session: SessionInfo): Promise<ArtboardStateResponse> {
  const state = useEditorStore.getState();
  const tree = await editorBridgeClient.exportNodeTree(session.sessionId);
  const image = await editorBridgeClient.renderSnapshot(session.sessionId, undefined, {
    width: state.previewWidth,
    height: state.previewHeight,
    profile: true,
  });
  return {
    ok: true,
    session,
    revision: image.revision,
    rootNodeId: tree.rootNodeId,
    nodes: tree.nodes,
    snapshot: image.snapshot,
    selectedNodeId: pickDefaultSelection(image.snapshot, tree.rootNodeId) ?? undefined,
    dirty: false,
    undoAvailable: false,
    redoAvailable: false,
    profile: image.profile ?? null,
  };
}

function getActiveArtboard(state = useEditorStore.getState()): Artboard | null {
  const page = state.pages.find((item) => item.id === state.activePageId);
  return page?.artboards.find((item) => item.id === state.activeArtboardId) ?? null;
}

export function isEmptyLocalArtboard(artboard: Artboard | null | undefined): boolean {
  if (!artboard) return false;
  if (artboard.bridgeSessionId || artboard.bridgeWorkingPrefabPath || artboard.sourcePrefabPath) return false;
  if (artboard.rootIds?.length) return false;
  return Object.keys(artboard.nodes ?? {}).length === 0;
}

export function shouldMaterializeBridgeArtboard(artboard: Artboard | null | undefined): boolean {
  if (!artboard || artboard.bridgeSessionId) return false;
  if (artboard.bridgeWorkingPrefabPath || artboard.sourcePrefabPath) return true;
  if (artboard.rootIds?.length) return true;
  return Object.keys(artboard.nodes ?? {}).length > 0;
}

function findOpenSourceArtboard(prefabPath: string): { pageId: string; artboard: Artboard } | null {
  const target = prefabIdentity(prefabPath);
  if (!target) return null;
  const state = useEditorStore.getState();
  for (const page of state.pages) {
    for (const artboard of page.artboards) {
      if (prefabIdentity(artboard.sourcePrefabPath) === target) {
        return { pageId: page.id, artboard };
      }
    }
  }
  return null;
}

function activateArtboard(pageId: string, artboardId: string) {
  const store = useEditorStore.getState();
  if (store.activePageId !== pageId) store.switchPage(pageId);
  const nextStore = useEditorStore.getState();
  if (nextStore.activeArtboardId !== artboardId) nextStore.setActiveArtboard(artboardId);
}

function showStatusMessage(message: string) {
  updateActiveArtboard({ bridgeStatus: message });
  if (typeof window !== 'undefined') window.setTimeout(() => updateActiveArtboard({ bridgeStatus: '' }), 3500);
}

function isNodeLocked(nodeId: string): boolean {
  return !!useEditorStore.getState().nodes[nodeId]?.locked;
}

function unlockedNodeIds(nodeIds: string[]): string[] {
  return [...new Set(nodeIds)].filter((nodeId) => !!nodeId && !isNodeLocked(nodeId));
}

function nodeDepth(nodeId: string, nodes: Record<string, UINode>): number {
  let depth = 0;
  let parentId = nodes[nodeId]?.parentId ?? null;
  while (parentId && nodes[parentId]) {
    depth += 1;
    parentId = nodes[parentId].parentId ?? null;
  }
  return depth;
}

function siblingIndex(nodeId: string, nodes: Record<string, UINode>, rootIds: string[]): number {
  const node = nodes[nodeId];
  if (!node) return -1;
  const siblings = node.parentId && nodes[node.parentId] ? nodes[node.parentId].children : rootIds;
  return siblings.indexOf(nodeId);
}

function hasSelectedAncestor(nodeId: string, selected: Set<string>, nodes: Record<string, UINode>): boolean {
  let parentId = nodes[nodeId]?.parentId ?? null;
  while (parentId) {
    if (selected.has(parentId)) return true;
    parentId = nodes[parentId]?.parentId ?? null;
  }
  return false;
}

function deletableNodeIds(nodeIds: string[], artboard: Artboard, nodes: Record<string, UINode>, rootIds: string[]): string[] {
  const selected = new Set(nodeIds.filter(Boolean));
  return [...selected]
    .filter((nodeId) => {
      if (nodeId === artboard.bridgeRootNodeId) return false;
      const node = nodes[nodeId];
      if (!node || node.locked) return false;
      return !hasSelectedAncestor(nodeId, selected, nodes);
    })
    .sort((a, b) => {
      const depthDelta = nodeDepth(b, nodes) - nodeDepth(a, nodes);
      if (depthDelta !== 0) return depthDelta;
      return siblingIndex(b, nodes, rootIds) - siblingIndex(a, nodes, rootIds);
    });
}

function updateActiveArtboard(patch: Partial<Artboard>, selectedIds?: string[]) {
  bridgeStateApplyDepth += 1;
  useEditorStore.setState((state) => {
    const pageIndex = state.pages.findIndex((page) => page.id === state.activePageId);
    if (pageIndex < 0) return {};
    const page = state.pages[pageIndex];
    const artboardIndex = page.artboards.findIndex((artboard) => artboard.id === state.activeArtboardId);
    if (artboardIndex < 0) return {};
    const artboards = [...page.artboards];
    artboards[artboardIndex] = { ...artboards[artboardIndex], ...patch };
    const pages = [...state.pages];
    pages[pageIndex] = { ...page, artboards };
    const active = artboards[artboardIndex];
    return {
      pages,
      nodes: active.nodes,
      rootIds: active.rootIds,
      sourcePrefabPath: active.sourcePrefabPath,
      selectedIds: selectedIds ?? state.selectedIds,
    };
  });
  queueMicrotask(() => {
    bridgeStateApplyDepth = Math.max(0, bridgeStateApplyDepth - 1);
  });
}

function pagesWithActiveMirror(state = useEditorStore.getState()): PageData[] {
  return state.pages.map((page) => {
    if (page.id !== state.activePageId) return page;
    const artboards = page.artboards.map((artboard) => {
      if (artboard.id !== state.activeArtboardId) return artboard;
      return {
        ...artboard,
        nodes: state.nodes,
        rootIds: state.rootIds,
        sourcePrefabPath: state.sourcePrefabPath,
      };
    });
    return {
      ...page,
      artboards,
      annotations: state.annotations,
      annotationRootIds: state.annotationRootIds,
    };
  });
}

async function artboardFromBridgeState(
  response: ArtboardStateResponse,
  base: Artboard,
  name: string,
  status: string,
): Promise<Artboard> {
  const previousNodes = base.nodes ?? {};
  const nodes: Record<string, UINode> = {};
  response.nodes.forEach((node) => {
    const mapped = mapBridgeNode(node);
    mapped.locked = !!previousNodes[node.nodeId]?.locked;
    nodes[node.nodeId] = mapped;
  });
  const rootIds = response.nodes.filter((node) => !node.parentId).map((node) => node.nodeId);
  const snapshot = normalizeSnapshot(response.snapshot);
  const snapshotUrl = snapshot ? await editorBridgeClient.snapshotUrl(snapshot) : null;
  return {
    ...base,
    name,
    nodes,
    rootIds: rootIds.length > 0 ? rootIds : [response.rootNodeId].filter(Boolean),
    sourcePrefabPath: null,
    bridgeSessionId: response.session.sessionId,
    bridgeWorkingPrefabPath: response.session.workingPrefabPath,
    bridgeTargetPrefabPath: defaultTargetFor(name),
    bridgeFramework: normalizePanelFramework(response.session.framework),
    bridgeRevision: response.revision,
    bridgeRootNodeId: response.rootNodeId,
    bridgeSnapshot: snapshot,
    bridgeSnapshotUrl: snapshotUrl,
    bridgeDirty: true,
    bridgeUndoAvailable: response.undoAvailable,
    bridgeRedoAvailable: response.redoAvailable,
    bridgeStatus: status,
  };
}

async function artboardPatchFromBridgeState(
  response: ArtboardStateResponse,
  previousNodes: Record<string, UINode>,
  name: string,
  status: string,
  sourcePrefabPath: string | null,
): Promise<{ patch: Partial<Artboard>; selectedNodeId: string | null }> {
  const nodes: Record<string, UINode> = {};
  response.nodes.forEach((node) => {
    const mapped = mapBridgeNode(node);
    mapped.locked = !!previousNodes[node.nodeId]?.locked;
    nodes[node.nodeId] = mapped;
  });
  const rootIds = response.nodes.filter((node) => !node.parentId).map((node) => node.nodeId);
  const snapshot = normalizeSnapshot(response.snapshot);
  const snapshotUrl = snapshot ? await editorBridgeClient.snapshotUrl(snapshot) : null;
  const selectedNodeId = response.selectedNodeId ?? pickDefaultSelection(snapshot, response.rootNodeId);
  return {
    patch: {
      name,
      nodes,
      rootIds: rootIds.length > 0 ? rootIds : [response.rootNodeId].filter(Boolean),
      sourcePrefabPath,
      bridgeSessionId: response.session.sessionId,
      bridgeWorkingPrefabPath: response.session.workingPrefabPath,
      bridgeTargetPrefabPath: sourcePrefabPath || defaultTargetFor(name),
      bridgeFramework: normalizePanelFramework(response.session.framework),
      bridgeRevision: response.revision,
      bridgeRootNodeId: response.rootNodeId,
      bridgeSnapshot: snapshot,
      bridgeSnapshotUrl: snapshotUrl,
      bridgeDirty: response.dirty,
      bridgeUndoAvailable: response.undoAvailable,
      bridgeRedoAvailable: response.redoAvailable,
      bridgeStatus: status,
    },
    selectedNodeId,
  };
}

export async function applyBridgeStateToActiveArtboard(response: ArtboardStateResponse, status?: string, selectedIdsOverride?: string[]) {
  const nodes: Record<string, UINode> = {};
  const previousNodes = getActiveArtboard()?.nodes ?? useEditorStore.getState().nodes;
  const duplicates = duplicateNodeIds(response.nodes);
  response.nodes.forEach((node) => {
    const mapped = mapBridgeNode(node);
    mapped.locked = !!previousNodes[node.nodeId]?.locked;
    nodes[node.nodeId] = mapped;
  });
  const rootIds = response.nodes.filter((node) => !node.parentId).map((node) => node.nodeId);
  const fallbackName = basename(response.session.sourcePrefabPath || response.session.workingPrefabPath);
  const snapshot = normalizeSnapshot(response.snapshot);
  const snapshotUrl = snapshot ? await editorBridgeClient.snapshotUrl(snapshot) : null;
  const selectedNodeId = response.selectedNodeId ?? pickDefaultSelection(snapshot, response.rootNodeId);
  debugLog('bridge-state', 'apply-active-artboard', {
    status,
    sessionId: response.session.sessionId,
    revision: response.revision,
    responseNodeCount: response.nodes.length,
    mappedNodeCount: Object.keys(nodes).length,
    rootCount: rootIds.length,
    selectedNodeId,
    duplicateNodeIds: duplicates,
    snapshotId: snapshot?.snapshotId,
    snapshotBboxCount: snapshot?.bboxes.length,
    profileTotalMs: response.profile?.totalMs,
  });
  updateActiveArtboard({
    name: getActiveArtboard()?.name || fallbackName,
    nodes,
    rootIds: rootIds.length > 0 ? rootIds : [response.rootNodeId].filter(Boolean),
    sourcePrefabPath: response.session.sourcePrefabPath || null,
    bridgeSessionId: response.session.sessionId,
    bridgeWorkingPrefabPath: response.session.workingPrefabPath,
    bridgeTargetPrefabPath: response.session.sourcePrefabPath || getActiveArtboard()?.bridgeTargetPrefabPath || defaultTargetFor(fallbackName),
    bridgeFramework: normalizePanelFramework(response.session.framework),
    bridgeRevision: response.revision,
    bridgeRootNodeId: response.rootNodeId,
    bridgeSnapshot: snapshot,
    bridgeSnapshotUrl: snapshotUrl,
    bridgeDirty: response.dirty,
    bridgeUndoAvailable: response.undoAvailable,
    bridgeRedoAvailable: response.redoAvailable,
    bridgeStatus: status,
  }, selectedIdsOverride ?? (selectedNodeId ? [selectedNodeId] : []));
}

function isSessionNotFoundError(err: unknown): boolean {
  return err instanceof EditorBridgeRequestError && err.code === 'SESSION_NOT_FOUND';
}

function isPrefabNotFoundError(err: unknown): boolean {
  return err instanceof EditorBridgeRequestError && err.code === 'PREFAB_NOT_FOUND';
}

async function rematerializeActiveArtboardAfterMissingWorkingPrefab(
  artboard: Artboard,
  status = '临时 Prefab 已不存在，正在重建画板...',
): Promise<Artboard> {
  debugLog('bridge-session', 'working-prefab-missing', {
    artboardId: artboard.id,
    artboardName: artboard.name,
    workingPrefabPath: artboard.bridgeWorkingPrefabPath,
    sourcePrefabPath: artboard.sourcePrefabPath,
  });
  updateActiveArtboard({
    bridgeSessionId: undefined,
    bridgeWorkingPrefabPath: undefined,
    bridgeRevision: undefined,
    bridgeRootNodeId: undefined,
    bridgeSnapshot: null,
    bridgeSnapshotUrl: null,
    bridgeStatus: status,
  }, []);
  if (artboard.sourcePrefabPath) {
    await openPrefabInActiveArtboard(artboard.sourcePrefabPath);
  } else {
    await createBlankInActiveArtboard(artboard.name || 'NewUI');
  }
  const next = getActiveArtboard();
  if (!next?.bridgeSessionId) throw new Error('Bridge artboard session was not created');
  return next;
}

async function recoverActiveBridgeSession(status = '已恢复 Unity session'): Promise<Artboard> {
  const current = getActiveArtboard();
  if (!current?.bridgeWorkingPrefabPath) {
    throw new Error('Unity session 已失效，且当前画板没有 working Prefab 路径，无法恢复');
  }
  debugLog('bridge-session', 'recover-request', {
    artboardId: current.id,
    artboardName: current.name,
    oldSessionId: current.bridgeSessionId,
    workingPrefabPath: current.bridgeWorkingPrefabPath,
    sourcePrefabPath: current.sourcePrefabPath,
  });
  let response: ArtboardStateResponse;
  try {
    response = await editorBridgeClient.resumeSession({
      workingPrefabPath: current.bridgeWorkingPrefabPath,
      sourcePrefabPath: current.sourcePrefabPath,
      selectedNodeId: useEditorStore.getState().selectedIds[0],
    });
  } catch (err) {
    if (isPrefabNotFoundError(err)) {
      return rematerializeActiveArtboardAfterMissingWorkingPrefab(current);
    }
    throw err;
  }
  await applyBridgeStateToActiveArtboard(response, status);
  const recovered = getActiveArtboard();
  if (!recovered?.bridgeSessionId) {
    throw new Error('Unity session 恢复失败');
  }
  debugLog('bridge-session', 'recover-ok', {
    artboardId: recovered.id,
    newSessionId: recovered.bridgeSessionId,
    workingPrefabPath: recovered.bridgeWorkingPrefabPath,
  });
  return recovered;
}

async function runWithRecoveredActiveSession<T>(
  operation: (artboard: Artboard) => Promise<T>,
  status = '已恢复 Unity session',
): Promise<T> {
  const artboard = await ensureActiveBridgeArtboard();
  try {
    return await operation(artboard);
  } catch (err) {
    if (!isSessionNotFoundError(err)) throw err;
    const recovered = await recoverActiveBridgeSession(status);
    return operation(recovered);
  }
}

export async function refreshActiveBridgeSnapshot(width?: number, height?: number) {
  const snapshotResponse = await runWithRecoveredActiveSession((artboard) => {
    if (!artboard.bridgeSessionId) throw new Error('Bridge session was not created');
    const state = useEditorStore.getState();
    return editorBridgeClient.renderSnapshot(artboard.bridgeSessionId, undefined, {
      width: width ?? state.previewWidth,
      height: height ?? state.previewHeight,
      profile: true,
    });
  }, '已恢复画板截图 session');
  const snapshot = normalizeSnapshot(snapshotResponse.snapshot);
  const snapshotUrl = snapshot ? await editorBridgeClient.snapshotUrl(snapshot) : null;
  updateActiveArtboard({
    bridgeRevision: snapshotResponse.revision,
    bridgeSnapshot: snapshot,
    bridgeSnapshotUrl: snapshotUrl,
    bridgeStatus: '',
  });
}

export async function ensureActiveBridgeArtboard(): Promise<Artboard> {
  const current = getActiveArtboard();
  if (current?.bridgeSessionId) return current;
  if (current?.bridgeWorkingPrefabPath) {
    try {
      const response = await editorBridgeClient.resumeSession({
        workingPrefabPath: current.bridgeWorkingPrefabPath,
        sourcePrefabPath: current.sourcePrefabPath,
        selectedNodeId: useEditorStore.getState().selectedIds[0],
      });
      await applyBridgeStateToActiveArtboard(response, `已恢复画板: ${current.name}`);
    } catch (err) {
      if (!isPrefabNotFoundError(err)) throw err;
      return rematerializeActiveArtboardAfterMissingWorkingPrefab(current);
    }
  } else if (current?.sourcePrefabPath) {
    await openPrefabInActiveArtboard(current.sourcePrefabPath);
  } else {
    await createBlankInActiveArtboard(current?.name || 'NewUI');
  }
  const next = getActiveArtboard();
  if (!next?.bridgeSessionId) throw new Error('Bridge artboard session was not created');
  return next;
}

export async function createBlankInActiveArtboard(name = 'NewUI') {
  const response = await editorBridgeClient.createBlankArtboard(name);
  await applyBridgeStateToActiveArtboard(response, `已新建画板: ${name}`);
}

export async function openPrefabInActiveArtboard(prefabPath: string) {
  const state = useEditorStore.getState();
  const opened = await editorBridgeClient.openPrefab(prefabPath, 'temp-copy', {
    width: state.previewWidth,
    height: state.previewHeight,
  });
  const response = await stateFromSession(opened.session);
  await applyBridgeStateToActiveArtboard(response, `已打开 UI: ${opened.session.sourcePrefabPath}`);
}

export async function openPrefabInNewArtboard(prefabPath: string) {
  const existing = findOpenSourceArtboard(prefabPath);
  if (existing) {
    activateArtboard(existing.pageId, existing.artboard.id);
    showStatusMessage('已有同名 UI 被打开');
    return;
  }
  const name = basename(prefabPath);
  const state = useEditorStore.getState();
  const activePage = state.pages.find((item) => item.id === state.activePageId);
  const activeArtboard = activePage?.artboards.find((item) => item.id === state.activeArtboardId) ?? null;
  const replaceActivePlaceholder = isEmptyLocalArtboard(activeArtboard)
    ? { pageId: state.activePageId, artboardId: state.activeArtboardId }
    : null;
  const opened = await editorBridgeClient.openPrefab(prefabPath, 'temp-copy', {
    width: state.previewWidth,
    height: state.previewHeight,
  });
  const response = await stateFromSession(opened.session);
  const sourcePrefabPath = opened.session.sourcePrefabPath || null;
  const { patch, selectedNodeId } = await artboardPatchFromBridgeState(
    response,
    {},
    name,
    `已打开 UI: ${opened.session.sourcePrefabPath}`,
    sourcePrefabPath,
  );
  if (replaceActivePlaceholder) {
    activateArtboard(replaceActivePlaceholder.pageId, replaceActivePlaceholder.artboardId);
    updateActiveArtboard(patch, selectedNodeId ? [selectedNodeId] : []);
    return;
  }
  useEditorStore.getState().addArtboard({
    name,
    artboard: patch,
    selectedIds: selectedNodeId ? [selectedNodeId] : [],
  });
}

export async function insertPrefabIntoArtboard(artboardId: string, prefabPath: string, point: { x: number; y: number }, pageId?: string) {
  const state = useEditorStore.getState();
  debugLog('bridge-insert', 'activate-target-artboard', {
    pageId: pageId ?? state.activePageId,
    artboardId,
    prefabPath,
    point: { x: Math.round(point.x), y: Math.round(point.y) },
    previousActivePageId: state.activePageId,
    previousActiveArtboardId: state.activeArtboardId,
  });
  activateArtboard(pageId ?? state.activePageId, artboardId);
  await insertPrefabIntoActiveArtboard(prefabPath, point);
}

export async function insertPrefabIntoNode(parentId: string, prefabPath: string, options: { index?: number } = {}) {
  const startedAt = performance.now();
  const response = await runWithRecoveredActiveSession((artboard) => {
    debugLog('bridge-insert', 'request-node-parent', {
      sessionId: artboard.bridgeSessionId,
      artboardId: artboard.id,
      artboardName: artboard.name,
      prefabPath,
      parentId,
      index: options.index,
      beforeNodeCount: Object.keys(artboard.nodes ?? {}).length,
    });
    return editorBridgeClient.insertPrefab(artboard.bridgeSessionId!, prefabPath, {
      parentId,
      x: 0,
      y: 0,
      index: options.index,
    }, { skipSnapshot: false });
  }, '已恢复插入 session');
  debugLog('bridge-insert', 'response-node-parent', {
    prefabPath,
    parentId,
    elapsedMs: Math.round(performance.now() - startedAt),
    responseNodeCount: response.nodes.length,
    rootNodeId: response.rootNodeId,
    selectedNodeId: response.selectedNodeId,
    dirty: response.dirty,
    duplicateNodeIds: duplicateNodeIds(response.nodes),
    snapshotId: response.snapshot?.snapshotId,
    bboxCount: response.snapshot?.bboxes.length,
    profileTotalMs: response.profile?.totalMs,
    profile: response.profile?.entries,
  });
  await applyBridgeStateToActiveArtboard(response, '已插入 UI');
}

export async function duplicateBridgeArtboard(sourceArtboardId?: string) {
  let state = useEditorStore.getState();
  const page = state.pages.find((item) => item.id === state.activePageId);
  const sourceId = sourceArtboardId ?? state.activeArtboardId;
  let source = page?.artboards.find((item) => item.id === sourceId) ?? null;
  if (!source) throw new Error('找不到要复制的画板');

  if (source.id === state.activeArtboardId && !source.bridgeWorkingPrefabPath && !source.sourcePrefabPath) {
    await ensureActiveBridgeArtboard();
    state = useEditorStore.getState();
    source = getActiveArtboard();
  }

  const cloneSourcePath = source?.bridgeWorkingPrefabPath || source?.sourcePrefabPath;
  if (!source || !cloneSourcePath) {
    throw new Error('当前画板还没有可复制的 Unity 临时 Prefab');
  }

  const name = `${source.name || basename(source.sourcePrefabPath || source.bridgeWorkingPrefabPath)} 副本`;
  const newId = useEditorStore.getState().addArtboard({
    name,
    x: source.x,
    y: source.y + source.height + 200,
  });
  if (!newId) throw new Error('创建画板副本失败');

  const opened = await editorBridgeClient.openPrefab(cloneSourcePath, 'temp-copy');
  const response = await stateFromSession(opened.session);
  await applyBridgeStateToActiveArtboard(response, `已复制画板: ${source.name}`);
  updateActiveArtboard({
    name,
    sourcePrefabPath: null,
    bridgeTargetPrefabPath: defaultTargetFor(name),
    bridgeDirty: true,
    bridgeStatus: '画板副本尚未保存',
  });
}

export async function duplicateBridgePage(sourcePageId?: string) {
  let state = useEditorStore.getState();
  let pages = pagesWithActiveMirror(state);
  const pageId = sourcePageId ?? state.activePageId;
  let sourcePage = pages.find((item) => item.id === pageId);
  if (!sourcePage) throw new Error('找不到要复制的图层');

  const activeSource = sourcePage.id === state.activePageId
    ? sourcePage.artboards.find((item) => item.id === state.activeArtboardId)
    : null;
  if (activeSource && !activeSource.bridgeWorkingPrefabPath && !activeSource.sourcePrefabPath) {
    await ensureActiveBridgeArtboard();
    state = useEditorStore.getState();
    pages = pagesWithActiveMirror(state);
    sourcePage = pages.find((item) => item.id === pageId);
  }
  if (!sourcePage) throw new Error('找不到要复制的图层');

  const sessionIdsToCleanup: string[] = [];
  try {
    const idMap = new Map<string, string>();
    const artboards: Artboard[] = [];
    for (const source of sourcePage.artboards) {
      const id = uuid();
      idMap.set(source.id, id);
      const name = `${source.name || basename(source.sourcePrefabPath || source.bridgeWorkingPrefabPath)} 副本`;
      const cloneSourcePath = source.bridgeWorkingPrefabPath || source.sourcePrefabPath;
      let response: ArtboardStateResponse;
      if (cloneSourcePath) {
        const opened = await editorBridgeClient.openPrefab(cloneSourcePath, 'temp-copy');
        sessionIdsToCleanup.push(opened.session.sessionId);
        response = await stateFromSession(opened.session);
      } else {
        response = await editorBridgeClient.createBlankArtboard(name);
        if (response.session?.sessionId) sessionIdsToCleanup.push(response.session.sessionId);
      }
      artboards.push(await artboardFromBridgeState(response, {
        ...source,
        id,
        name,
        nodes: {},
        rootIds: [],
        sourcePrefabPath: null,
      }, name, `已复制图层: ${sourcePage.name}`));
    }

    const newPageId = uuid();
    const activeArtboardId = idMap.get(sourcePage.activeArtboardId) ?? artboards[0]?.id;
    if (!activeArtboardId || artboards.length === 0) throw new Error('图层没有可复制的画板');
    const newPage: PageData = {
      id: newPageId,
      name: `${sourcePage.name || '图层'} 副本`,
      artboards,
      activeArtboardId,
      annotations: structuredClone(sourcePage.annotations ?? {}),
      annotationRootIds: [...(sourcePage.annotationRootIds ?? [])],
      pageGroup: sourcePage.pageGroup,
    };
    const activeArtboard = artboards.find((item) => item.id === activeArtboardId) ?? artboards[0];
    useEditorStore.setState({
      pages: [...pages, newPage],
      activePageId: newPageId,
      activeArtboardId,
      nodes: activeArtboard.nodes,
      rootIds: activeArtboard.rootIds,
      sourcePrefabPath: null,
      annotations: structuredClone(newPage.annotations ?? {}),
      annotationRootIds: [...(newPage.annotationRootIds ?? [])],
      selectedIds: [],
      selectedArtboardId: null,
      selectedAnnotationIds: [],
      history: [],
      historyIndex: -1,
    });
    sessionIdsToCleanup.length = 0;
    return newPageId;
  } finally {
    await Promise.all(sessionIdsToCleanup.map((sessionId) => editorBridgeClient.closePrefab(sessionId, true).catch(() => undefined)));
  }
}

export async function moveNodeOnBridge(nodeId: string, x: number, y: number, skipSnapshot = false) {
  if (isNodeLocked(nodeId)) return;
  const response = await runWithRecoveredActiveSession((artboard) =>
    editorBridgeClient.moveNode(artboard.bridgeSessionId!, nodeId, x, y, { skipSnapshot }),
  '已恢复移动 session');
  if (!skipSnapshot) await applyBridgeStateToActiveArtboard(response, '节点已移动');
}

export async function moveNodesOnBridge(
  moves: Array<{ nodeId: string; x: number; y: number }>,
  status = '节点已对齐',
  selectedIdsOverride?: string[],
) {
  moves = moves.filter((move) => !isNodeLocked(move.nodeId));
  const deduped: Array<{ nodeId: string; x: number; y: number }> = [];
  const seen = new Set<string>();
  for (const move of moves) {
    if (!move.nodeId || seen.has(move.nodeId)) continue;
    seen.add(move.nodeId);
    deduped.push(move);
  }
  if (deduped.length === 0) return;
  let response: ArtboardStateResponse | null = null;
  response = await runWithRecoveredActiveSession(async (artboard) => {
    let current: ArtboardStateResponse | null = null;
    for (let index = 0; index < deduped.length; index += 1) {
      const move = deduped[index];
      current = await editorBridgeClient.moveNode(artboard.bridgeSessionId!, move.nodeId, move.x, move.y, {
        skipSnapshot: index < deduped.length - 1,
      });
    }
    return current;
  }, '已恢复移动 session');
  if (response) await applyBridgeStateToActiveArtboard(response, status, selectedIdsOverride);
}

export async function resizeNodeOnBridge(nodeId: string, width: number, height: number, skipSnapshot = false) {
  if (isNodeLocked(nodeId)) return;
  const response = await runWithRecoveredActiveSession((artboard) =>
    editorBridgeClient.resizeNode(artboard.bridgeSessionId!, nodeId, width, height, { skipSnapshot }),
  '已恢复缩放 session');
  if (!skipSnapshot) await applyBridgeStateToActiveArtboard(response, '节点已缩放');
}

async function applyVisualFieldsOnBridge(operations: VisualPatchOperation[], status = '属性已同步') {
  if (operations.length === 0) return;
  const selectedBefore = useEditorStore.getState().selectedIds;
  const operationNodeIds = [...new Set(operations.map((item) => item.nodeId).filter(Boolean))];
  const response = await runWithRecoveredActiveSession(async (artboard) => {
    debugLog('bridge-op', 'apply-visual-fields', {
      sessionId: artboard.bridgeSessionId,
      selectedBefore,
      operationNodeIds,
      fields: operations.map((item) => item.field),
    });
    await editorBridgeClient.applyVisualPatch(artboard.bridgeSessionId!, {
      patchId: globalThis.crypto?.randomUUID?.() ?? `patch-${Date.now()}`,
      baseRevision: artboard.bridgeRevision ?? '',
      operations,
    });
    return stateFromSession({
      sessionId: artboard.bridgeSessionId!,
      sourcePrefabPath: artboard.sourcePrefabPath ?? '',
      workingPrefabPath: artboard.bridgeWorkingPrefabPath ?? '',
      mode: 'temp-copy',
      revision: artboard.bridgeRevision ?? '',
    });
  }, '已恢复属性同步 session');
  const responseNodeIds = new Set(response.nodes.map((item) => item.nodeId));
  const selectedAfter = selectedBefore.filter((id) => responseNodeIds.has(id));
  const operationSelection = operationNodeIds.filter((id) => responseNodeIds.has(id));
  await applyBridgeStateToActiveArtboard(response, status, selectedAfter.length > 0 ? selectedAfter : operationSelection);
}

export async function setRectTransformFieldsOnBridge(nodeId: string, params: {
  anchorMin?: { x: number; y: number };
  anchorMax?: { x: number; y: number };
  pivot?: { x: number; y: number };
  anchoredPosition?: { x: number; y: number };
}) {
  if (isNodeLocked(nodeId)) return;
  const operations: VisualPatchOperation[] = [];
  if (params.anchorMin) operations.push(op(nodeId, 'rectTransform.anchorMin', { value: [params.anchorMin.x, params.anchorMin.y] }));
  if (params.anchorMax) operations.push(op(nodeId, 'rectTransform.anchorMax', { value: [params.anchorMax.x, params.anchorMax.y] }));
  if (params.pivot) operations.push(op(nodeId, 'rectTransform.pivot', { value: [params.pivot.x, params.pivot.y] }));
  if (params.anchoredPosition) operations.push(op(nodeId, 'rectTransform.anchoredPosition', { value: [params.anchoredPosition.x, params.anchoredPosition.y] }));
  await applyVisualFieldsOnBridge(operations, 'RectTransform 已同步');
}

export async function setTextOnBridge(nodeId: string, text: string) {
  if (isNodeLocked(nodeId)) return;
  const response = await runWithRecoveredActiveSession((artboard) =>
    editorBridgeClient.setText(artboard.bridgeSessionId!, nodeId, text, { skipSnapshot: false }),
  '已恢复文本同步 session');
  await applyBridgeStateToActiveArtboard(response, '文本已同步');
}

export async function setTextContentOnBridge(nodeId: string, text: string, richText?: boolean) {
  if (isNodeLocked(nodeId)) return;
  if (typeof richText !== 'boolean') {
    await setTextOnBridge(nodeId, text);
    return;
  }
  await applyVisualFieldsOnBridge([
    op(nodeId, 'Text.text', { stringValue: text }),
    op(nodeId, 'Text.richText', { boolValue: richText }),
  ], '文本已同步');
}

export async function setTextStyleOnBridge(nodeId: string, params: { fontSize?: number; color?: string; fontPath?: string }) {
  if (isNodeLocked(nodeId)) return;
  const response = await runWithRecoveredActiveSession((artboard) =>
    editorBridgeClient.setTextStyle(artboard.bridgeSessionId!, nodeId, params, { skipSnapshot: false }),
  '已恢复文本样式 session');
  await applyBridgeStateToActiveArtboard(response, '文本样式已同步');
}

export async function renameNodeOnBridge(nodeId: string, name: string) {
  if (isNodeLocked(nodeId)) return;
  await applyVisualFieldsOnBridge([
    op(nodeId, 'GameObject.name', { stringValue: name }),
  ], '节点已重命名');
}

export async function setImageOnBridge(nodeId: string, spritePath: string) {
  if (isNodeLocked(nodeId)) return;
  const response = await runWithRecoveredActiveSession((artboard) =>
    editorBridgeClient.setImage(artboard.bridgeSessionId!, nodeId, spritePath, { skipSnapshot: false }),
  '已恢复图片同步 session');
  await applyBridgeStateToActiveArtboard(response, '图片已同步');
}

export async function setVisibleOnBridge(nodeId: string, visible: boolean) {
  const response = await runWithRecoveredActiveSession((artboard) =>
    editorBridgeClient.setVisible(artboard.bridgeSessionId!, nodeId, visible, { skipSnapshot: false }),
  '已恢复显隐同步 session');
  await applyBridgeStateToActiveArtboard(response, '显隐已同步');
}

export async function setVisibleNodesOnBridge(nodeIds: string[], visible: boolean, selectedIdsOverride?: string[]) {
  const ids = [...new Set(nodeIds)].filter(Boolean);
  if (ids.length === 0) return;
  let response: ArtboardStateResponse | null = null;
  response = await runWithRecoveredActiveSession(async (artboard) => {
    let current: ArtboardStateResponse | null = null;
    for (let index = 0; index < ids.length; index += 1) {
      current = await editorBridgeClient.setVisible(artboard.bridgeSessionId!, ids[index], visible, {
        skipSnapshot: index < ids.length - 1,
      });
    }
    return current;
  }, '已恢复显隐同步 session');
  if (response) await applyBridgeStateToActiveArtboard(response, '显隐已同步', selectedIdsOverride);
}

export async function setOpacityNodesOnBridge(nodeIds: string[], opacity: number, selectedIdsOverride?: string[]) {
  const ids = unlockedNodeIds(nodeIds);
  if (ids.length === 0) return;
  const clamped = Math.max(0, Math.min(1, opacity));
  const operations: VisualPatchOperation[] = ids.map((nodeId) => op(nodeId, 'Graphic.alpha', { numberValue: clamped }));
  const response = await runWithRecoveredActiveSession(async (artboard) => {
    await editorBridgeClient.applyVisualPatch(artboard.bridgeSessionId!, {
      patchId: globalThis.crypto?.randomUUID?.() ?? `patch-${Date.now()}`,
      baseRevision: artboard.bridgeRevision ?? '',
      operations,
    });
    return stateFromSession({
      sessionId: artboard.bridgeSessionId!,
      sourcePrefabPath: artboard.sourcePrefabPath ?? '',
      workingPrefabPath: artboard.bridgeWorkingPrefabPath ?? '',
      mode: 'temp-copy',
      revision: artboard.bridgeRevision ?? '',
    });
  }, '已恢复透明度同步 session');
  await applyBridgeStateToActiveArtboard(response, '透明度已同步', selectedIdsOverride);
}

export async function deleteNodeOnBridge(nodeId: string) {
  await deleteNodesOnBridge([nodeId]);
}

export async function deleteNodesOnBridge(nodeIds: string[]) {
  const artboard = await ensureActiveBridgeArtboard();
  const state = useEditorStore.getState();
  const ids = deletableNodeIds(nodeIds, artboard, state.nodes, state.rootIds);
  debugLog('bridge-op', 'delete-nodes', {
    requestedNodeIds: nodeIds,
    deletableNodeIds: ids,
    rootNodeId: artboard.bridgeRootNodeId,
    sessionId: artboard.bridgeSessionId,
  });
  if (ids.length === 0) {
    showStatusMessage('没有可删除的节点');
    return;
  }

  let response: ArtboardStateResponse | null = null;
  try {
    response = await runWithRecoveredActiveSession(async (active) => {
      let current: ArtboardStateResponse | null = null;
      for (let index = 0; index < ids.length; index += 1) {
        current = await editorBridgeClient.deleteNode(active.bridgeSessionId!, ids[index], {
          skipSnapshot: index < ids.length - 1,
        });
      }
      return current;
    }, '已恢复删除 session');
  } catch (err: any) {
    showStatusMessage(`删除失败: ${err?.message || String(err)}`);
    throw err;
  }

  if (response) await applyBridgeStateToActiveArtboard(response, ids.length > 1 ? `已删除 ${ids.length} 个节点` : '节点已删除', []);
}

export async function deleteNodesFromBridgeSession(sessionId: string, nodeIds: string[]) {
  const ids = [...new Set(nodeIds)].filter(Boolean);
  if (!sessionId || ids.length === 0) return;
  for (let index = 0; index < ids.length; index += 1) {
    await editorBridgeClient.deleteNode(sessionId, ids[index], {
      skipSnapshot: index < ids.length - 1,
    });
  }
}

export async function duplicateNodesOnBridge(nodeIds: string[], offset = { x: 20, y: -20 }) {
  const ids = unlockedNodeIds(nodeIds);
  if (ids.length === 0) return;
  const response = await runWithRecoveredActiveSession((artboard) =>
    editorBridgeClient.duplicateNodes(artboard.bridgeSessionId!, ids, {
      offsetX: offset.x,
      offsetY: offset.y,
    }, { skipSnapshot: false }),
  '已恢复复制 session');
  await applyBridgeStateToActiveArtboard(response, ids.length > 1 ? '节点已复制' : '节点已复制');
}

export async function copyNodesToActiveBridgeSession(sourceSessionId: string, nodeIds: string[], offset = { x: 20, y: -20 }) {
  const ids = [...new Set(nodeIds)].filter(Boolean);
  if (!sourceSessionId || ids.length === 0) return;
  const artboard = await ensureActiveBridgeArtboard();
  if (!artboard.bridgeSessionId) return;
  const response = await editorBridgeClient.copyNodesToSession(sourceSessionId, artboard.bridgeSessionId, ids, {
    targetParentId: artboard.bridgeRootNodeId ?? null,
    offsetX: offset.x,
    offsetY: offset.y,
  }, { skipSnapshot: false });
  await applyBridgeStateToActiveArtboard(response, ids.length > 1 ? '节点已粘贴' : '节点已粘贴');
}

export async function groupNodesOnBridge(nodeIds: string[], name?: string) {
  const ids = unlockedNodeIds(nodeIds);
  if (ids.length === 0) return;
  const response = await runWithRecoveredActiveSession((artboard) =>
    editorBridgeClient.groupNodes(artboard.bridgeSessionId!, ids, name || `Group_${Date.now().toString(36).slice(-4)}`, { skipSnapshot: false }),
  '已恢复编组 session');
  await applyBridgeStateToActiveArtboard(response, '节点已编组');
}

export async function ungroupNodesOnBridge(nodeIds: string[]) {
  const ids = unlockedNodeIds(nodeIds);
  if (ids.length === 0) return;
  const response = await runWithRecoveredActiveSession((artboard) =>
    editorBridgeClient.ungroupNodes(artboard.bridgeSessionId!, ids, { skipSnapshot: false }),
  '已恢复解组 session');
  await applyBridgeStateToActiveArtboard(response, '节点已解组');
}

export async function clearActiveBridgeArtboardChildren() {
  const artboard = await ensureActiveBridgeArtboard();
  const rootNodeId = artboard.bridgeRootNodeId;
  const nodes = useEditorStore.getState().nodes;
  const ids = rootNodeId && nodes[rootNodeId]
    ? [...nodes[rootNodeId].children]
    : Object.keys(nodes).filter((id) => id !== rootNodeId);
  for (const id of ids) {
    const latest = getActiveArtboard();
    if (!latest?.bridgeSessionId) break;
    const response = await editorBridgeClient.deleteNode(latest.bridgeSessionId, id, { skipSnapshot: id === ids[ids.length - 1] ? false : true });
    if (id === ids[ids.length - 1]) await applyBridgeStateToActiveArtboard(response, '已清空画板');
  }
}

export async function reparentNodeOnBridge(nodeId: string, parentId: string | null, index?: number) {
  if (isNodeLocked(nodeId)) return;
  const response = await runWithRecoveredActiveSession((artboard) =>
    editorBridgeClient.reparentNode(artboard.bridgeSessionId!, nodeId, parentId, index ?? -1, { skipSnapshot: false }),
  '已恢复层级同步 session');
  await applyBridgeStateToActiveArtboard(response, '层级已同步');
}

export async function reparentNodesOnBridge(
  operations: Array<{ nodeId: string; parentId: string | null; index?: number }>,
  selectedIdsOverride?: string[],
) {
  const filtered = operations.filter((item) => item.nodeId && !isNodeLocked(item.nodeId));
  if (filtered.length === 0) return;
  let response: ArtboardStateResponse | null = null;
  response = await runWithRecoveredActiveSession(async (artboard) => {
    let current: ArtboardStateResponse | null = null;
    for (let index = 0; index < filtered.length; index += 1) {
      const item = filtered[index];
      current = await editorBridgeClient.reparentNode(artboard.bridgeSessionId!, item.nodeId, item.parentId, item.index ?? -1, {
        skipSnapshot: index < filtered.length - 1,
      });
    }
    return current;
  }, '已恢复层级同步 session');
  if (response) await applyBridgeStateToActiveArtboard(response, '层级已同步', selectedIdsOverride);
}

export async function reorderNodesOnBridge(nodeIds: string[], direction: 'up' | 'down' | 'top' | 'bottom') {
  const selectedIds = unlockedNodeIds(nodeIds);
  if (selectedIds.length === 0) return;
  const state = useEditorStore.getState();
  const groups = new Map<string, { parentId: string | null; siblings: string[]; selected: string[] }>();
  for (const nodeId of selectedIds) {
    const node = state.nodes[nodeId];
    if (!node) continue;
    const parentId = node.parentId ?? null;
    const key = parentId ?? '__root__';
    if (!groups.has(key)) {
      const siblings = parentId && state.nodes[parentId] ? [...state.nodes[parentId].children] : [...state.rootIds];
      groups.set(key, { parentId, siblings, selected: [] });
    }
    groups.get(key)!.selected.push(nodeId);
  }

  const operations: Array<{ nodeId: string; parentId: string | null; index: number }> = [];
  for (const group of groups.values()) {
    const finalOrder = [...group.siblings];
    for (const nodeId of group.selected) {
      const currentIndex = finalOrder.indexOf(nodeId);
      if (currentIndex < 0) continue;
      let nextIndex = currentIndex;
      if (direction === 'up') nextIndex = currentIndex - 1;
      else if (direction === 'down') nextIndex = currentIndex + 1;
      else if (direction === 'top') nextIndex = 0;
      else nextIndex = finalOrder.length - 1;
      if (nextIndex < 0 || nextIndex >= finalOrder.length || nextIndex === currentIndex) continue;
      finalOrder.splice(currentIndex, 1);
      finalOrder.splice(nextIndex, 0, nodeId);
    }
    const selectedInFinalOrder = finalOrder.filter((id) => group.selected.includes(id));
    const ordered = direction === 'down' || direction === 'bottom'
      ? [...selectedInFinalOrder].reverse()
      : selectedInFinalOrder;
    for (const nodeId of ordered) {
      const before = group.siblings.indexOf(nodeId);
      const after = finalOrder.indexOf(nodeId);
      if (before >= 0 && after >= 0 && before !== after) {
        operations.push({ nodeId, parentId: group.parentId, index: after });
      }
    }
  }
  if (operations.length === 0) return;

  let response: ArtboardStateResponse | null = null;
  response = await runWithRecoveredActiveSession(async (artboard) => {
    let current: ArtboardStateResponse | null = null;
    for (let index = 0; index < operations.length; index += 1) {
      const op = operations[index];
      current = await editorBridgeClient.reparentNode(artboard.bridgeSessionId!, op.nodeId, op.parentId, op.index, {
        skipSnapshot: index < operations.length - 1,
      });
    }
    return current;
  }, '已恢复层级同步 session');
  if (response) await applyBridgeStateToActiveArtboard(response, '层级已同步', selectedIds);
}

export async function undoActiveBridgeArtboard() {
  const response = await runWithRecoveredActiveSession((artboard) =>
    editorBridgeClient.undoArtboard(artboard.bridgeSessionId!, { skipSnapshot: false }),
  '已恢复撤销 session');
  await applyBridgeStateToActiveArtboard(response, '已撤销');
}

export async function redoActiveBridgeArtboard() {
  const response = await runWithRecoveredActiveSession((artboard) =>
    editorBridgeClient.redoArtboard(artboard.bridgeSessionId!, { skipSnapshot: false }),
  '已恢复重做 session');
  await applyBridgeStateToActiveArtboard(response, '已重做');
}

export async function closeBridgeArtboardSession(artboardId: string, pageId?: string) {
  const state = useEditorStore.getState();
  const page = state.pages.find((item) => item.id === (pageId ?? state.activePageId));
  const artboard = page?.artboards.find((item) => item.id === artboardId);
  if (!artboard?.bridgeSessionId && !artboard?.bridgeWorkingPrefabPath) return;
  await editorBridgeClient.closePrefab(artboard?.bridgeSessionId, true, artboard?.bridgeWorkingPrefabPath);
}

function colorWithAlpha(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.startsWith('#') && value.length === 7) return `${value}FF`;
  return value;
}

function imageTypeToUnity(value: unknown): string | undefined {
  if (value === 'Simple' || value === 'Sliced' || value === 'Tiled' || value === 'Filled') return value;
  return undefined;
}

function unityPointFromEditor(node: UINode): { x: number; y: number } {
  return { x: node.x, y: node.y };
}

function op(nodeId: string, field: string, data: Omit<VisualPatchOperation, 'op' | 'nodeId' | 'field'>): VisualPatchOperation {
  return { op: 'set', nodeId, field, ...data };
}

function sameEffect(a: UINode['outline'] | UINode['textOutline'] | UINode['textShadow'], b: UINode['outline'] | UINode['textOutline'] | UINode['textShadow']): boolean {
  return a?.color === b?.color &&
    a?.distance?.[0] === b?.distance?.[0] &&
    a?.distance?.[1] === b?.distance?.[1] &&
    a?.useGraphicAlpha === b?.useGraphicAlpha;
}

function pushEffectOps(ops: VisualPatchOperation[], nodeId: string, prefix: 'Outline' | 'Shadow', prevEffect: UINode['outline'], nextEffect: UINode['outline']) {
  if (!!prevEffect !== !!nextEffect) ops.push(op(nodeId, `${prefix}.enabled`, { boolValue: !!nextEffect }));
  if (!nextEffect) return;
  if (prevEffect?.color !== nextEffect.color) ops.push(op(nodeId, `${prefix}.color`, { stringValue: colorWithAlpha(nextEffect.color) }));
  if (prevEffect?.distance?.[0] !== nextEffect.distance?.[0] || prevEffect?.distance?.[1] !== nextEffect.distance?.[1]) {
    ops.push(op(nodeId, `${prefix}.distance`, { value: [nextEffect.distance?.[0] ?? 1, nextEffect.distance?.[1] ?? -1] }));
  }
  if (prevEffect?.useGraphicAlpha !== nextEffect.useGraphicAlpha && typeof nextEffect.useGraphicAlpha === 'boolean') {
    ops.push(op(nodeId, `${prefix}.useGraphicAlpha`, { boolValue: nextEffect.useGraphicAlpha }));
  }
}

export async function createVisualNodeOnBridge(node: UINode) {
  const response = await runWithRecoveredActiveSession((artboard) => {
    const point = unityPointFromEditor(node);
    const parentId = node.parentId ?? artboard.bridgeRootNodeId ?? null;
    const common = {
      parentId,
      name: node.name,
      x: point.x,
      y: point.y,
      width: node.width,
      height: node.height,
    };
    if (['button', 'scrollview', 'toggle', 'inputfield', 'rawimage'].includes(node.type)) {
      return editorBridgeClient.createWidgetNode(artboard.bridgeSessionId!, {
        ...common,
        widgetType: node.type,
      }, { skipSnapshot: false });
    }
    if (node.type === 'text') {
      return editorBridgeClient.createTextNode(artboard.bridgeSessionId!, {
        ...common,
        text: node.text ?? 'Text',
        fontSize: node.style?.fontSize,
        color: colorWithAlpha(node.style?.fontColor),
      }, { skipSnapshot: false });
    }
    if (node.type === 'image' || node.type === 'rawimage') {
      return editorBridgeClient.createImageNode(artboard.bridgeSessionId!, {
        ...common,
        spritePath: node.imageData,
        color: colorWithAlpha(node.imageColor || '#FFFFFFFF'),
      }, { skipSnapshot: false });
    }
    return editorBridgeClient.createFrameNode(artboard.bridgeSessionId!, common, { skipSnapshot: false });
  }, '已恢复创建节点 session');
  await applyBridgeStateToActiveArtboard(response, '节点已创建');
}

export async function createWidgetNodeOnBridge(params: {
  widgetType: NodeType;
  name?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  parentId?: string | null;
  spritePath?: string;
  color?: string;
}) {
  const response = await runWithRecoveredActiveSession((artboard) => {
    const common = {
      parentId: params.parentId ?? artboard.bridgeRootNodeId ?? null,
      name: params.name ?? params.widgetType,
      x: params.x ?? 0,
      y: params.y ?? 0,
      width: params.width,
      height: params.height,
    };
    if (params.widgetType === 'frame') {
      return editorBridgeClient.createFrameNode(artboard.bridgeSessionId!, common, { skipSnapshot: false });
    }
    if (params.widgetType === 'text') {
      return editorBridgeClient.createTextNode(artboard.bridgeSessionId!, {
        ...common,
        text: params.name ?? 'Text',
      }, { skipSnapshot: false });
    }
    if (params.widgetType === 'image') {
      return editorBridgeClient.createImageNode(artboard.bridgeSessionId!, {
        ...common,
        spritePath: params.spritePath,
        color: params.color,
      }, { skipSnapshot: false });
    }
    return editorBridgeClient.createWidgetNode(artboard.bridgeSessionId!, {
      ...common,
      widgetType: params.widgetType,
    }, { skipSnapshot: false });
  }, '已恢复创建控件 session');
  await applyBridgeStateToActiveArtboard(response, '控件已创建');
}

export async function syncNodeVisualDelta(prev: UINode | undefined, next: UINode | undefined) {
  if (prev?.locked || next?.locked) return;
  if (!next) {
    if (prev) await deleteNodeOnBridge(prev.id);
    return;
  }
  if (!prev) {
    await createVisualNodeOnBridge(next);
    return;
  }
  if (prev.parentId !== next.parentId) {
    await reparentNodeOnBridge(next.id, next.parentId, undefined);
    return;
  }
  const operations: VisualPatchOperation[] = [];
  if (prev.name !== next.name) operations.push(op(next.id, 'GameObject.name', { stringValue: next.name }));
  if (
    prev.anchorMin?.x !== next.anchorMin?.x ||
    prev.anchorMin?.y !== next.anchorMin?.y
  ) {
    operations.push(op(next.id, 'rectTransform.anchorMin', { value: [next.anchorMin?.x ?? 0, next.anchorMin?.y ?? 0] }));
  }
  if (
    prev.anchorMax?.x !== next.anchorMax?.x ||
    prev.anchorMax?.y !== next.anchorMax?.y
  ) {
    operations.push(op(next.id, 'rectTransform.anchorMax', { value: [next.anchorMax?.x ?? 0, next.anchorMax?.y ?? 0] }));
  }
  if (prev.pivot?.x !== next.pivot?.x || prev.pivot?.y !== next.pivot?.y) {
    operations.push(op(next.id, 'rectTransform.pivot', { value: [next.pivot?.x ?? 0.5, next.pivot?.y ?? 0.5] }));
  }
  if (prev.x !== next.x || prev.y !== next.y) {
    await moveNodeOnBridge(next.id, next.x, next.y, false);
    return;
  }
  if (prev.width !== next.width || prev.height !== next.height) {
    await resizeNodeOnBridge(next.id, next.width, next.height);
    return;
  }
  if (prev.visible !== next.visible) {
    await setVisibleOnBridge(next.id, next.visible !== false);
    return;
  }
  if (prev.rotation !== next.rotation) {
    operations.push(op(next.id, 'rectTransform.localEulerAngles.z', { numberValue: next.rotation || 0 }));
  }
  if (
    prev.localScale?.x !== next.localScale?.x ||
    prev.localScale?.y !== next.localScale?.y ||
    prev.localScale?.z !== next.localScale?.z
  ) {
    operations.push(op(next.id, 'rectTransform.localScale', { value: [next.localScale?.x ?? 1, next.localScale?.y ?? 1, next.localScale?.z ?? 1] }));
  }
  if (prev.text !== next.text && typeof next.text === 'string') {
    operations.push(op(next.id, 'Text.text', { stringValue: next.text }));
  }
  if (prev.style?.fontSize !== next.style?.fontSize && typeof next.style?.fontSize === 'number') operations.push(op(next.id, 'Text.fontSize', { numberValue: next.style.fontSize }));
  if (prev.style?.fontColor !== next.style?.fontColor) operations.push(op(next.id, 'Text.color', { stringValue: colorWithAlpha(next.style?.fontColor) }));
  if (prev.style?.opacity !== next.style?.opacity && typeof next.style?.opacity === 'number') operations.push(op(next.id, 'Graphic.alpha', { numberValue: Math.max(0, Math.min(1, next.style.opacity)) }));
  if (prev.fontPath !== next.fontPath && next.fontPath) operations.push(op(next.id, 'Text.font', { stringValue: next.fontPath }));
  if (prev.fontStyle !== next.fontStyle && typeof next.fontStyle === 'number') operations.push(op(next.id, 'Text.fontStyle', { numberValue: next.fontStyle }));
  if (prev.alignment !== next.alignment && typeof next.alignment === 'number') operations.push(op(next.id, 'Text.alignment', { numberValue: next.alignment }));
  if (prev.richText !== next.richText && typeof next.richText === 'boolean') operations.push(op(next.id, 'Text.richText', { boolValue: next.richText }));
  if (prev.horizontalOverflow !== next.horizontalOverflow && typeof next.horizontalOverflow === 'number') operations.push(op(next.id, 'Text.horizontalOverflow', { numberValue: next.horizontalOverflow }));
  if (prev.verticalOverflow !== next.verticalOverflow && typeof next.verticalOverflow === 'number') operations.push(op(next.id, 'Text.verticalOverflow', { numberValue: next.verticalOverflow }));
  if (prev.lineSpacing !== next.lineSpacing && typeof next.lineSpacing === 'number') operations.push(op(next.id, 'Text.lineSpacing', { numberValue: next.lineSpacing }));
  if (prev.bestFit !== next.bestFit && typeof next.bestFit === 'boolean') operations.push(op(next.id, 'Text.bestFit', { boolValue: next.bestFit }));
  if (prev.bestFitMinSize !== next.bestFitMinSize && typeof next.bestFitMinSize === 'number') operations.push(op(next.id, 'Text.bestFitMinSize', { numberValue: next.bestFitMinSize }));
  if (prev.bestFitMaxSize !== next.bestFitMaxSize && typeof next.bestFitMaxSize === 'number') operations.push(op(next.id, 'Text.bestFitMaxSize', { numberValue: next.bestFitMaxSize }));
  if (prev.raycastTarget !== next.raycastTarget && typeof next.raycastTarget === 'boolean') operations.push(op(next.id, 'Text.raycastTarget', { boolValue: next.raycastTarget }));
  if (prev.imageColor !== next.imageColor) operations.push(op(next.id, 'Image.color', { stringValue: colorWithAlpha(next.imageColor || '#FFFFFFFF') }));
  if (prev.imageData !== next.imageData) operations.push(op(next.id, 'Image.sprite', { stringValue: next.imageData || '' }));
  if (prev.imageType !== next.imageType) {
    const unityType = imageTypeToUnity(next.imageType);
    if (unityType) operations.push(op(next.id, 'Image.type', { stringValue: unityType }));
  }
  if (prev.imageEnabled !== next.imageEnabled && typeof next.imageEnabled === 'boolean') operations.push(op(next.id, 'Image.enabled', { boolValue: next.imageEnabled }));
  if (prev.imageRaycastTarget !== next.imageRaycastTarget && typeof next.imageRaycastTarget === 'boolean') operations.push(op(next.id, 'Image.raycastTarget', { boolValue: next.imageRaycastTarget }));
  if (prev.fillCenter !== next.fillCenter && typeof next.fillCenter === 'boolean') operations.push(op(next.id, 'Image.fillCenter', { boolValue: next.fillCenter }));
  if (prev.fillMethod !== next.fillMethod && typeof next.fillMethod === 'number') operations.push(op(next.id, 'Image.fillMethod', { numberValue: next.fillMethod }));
  if (prev.fillOrigin !== next.fillOrigin && typeof next.fillOrigin === 'number') operations.push(op(next.id, 'Image.fillOrigin', { numberValue: next.fillOrigin }));
  if (prev.fillAmount !== next.fillAmount && typeof next.fillAmount === 'number') operations.push(op(next.id, 'Image.fillAmount', { numberValue: next.fillAmount }));
  if (prev.fillClockwise !== next.fillClockwise && typeof next.fillClockwise === 'boolean') operations.push(op(next.id, 'Image.fillClockwise', { boolValue: next.fillClockwise }));
  if (prev.useSpriteMesh !== next.useSpriteMesh && typeof next.useSpriteMesh === 'boolean') operations.push(op(next.id, 'Image.useSpriteMesh', { boolValue: next.useSpriteMesh }));
  if (prev.preserveAspect !== next.preserveAspect && typeof next.preserveAspect === 'boolean') operations.push(op(next.id, 'Image.preserveAspect', { boolValue: next.preserveAspect }));
  if (prev.interactable !== next.interactable && typeof next.interactable === 'boolean') operations.push(op(next.id, 'Button.interactable', { boolValue: next.interactable }));
  if (prev.buttonTransition !== next.buttonTransition && typeof next.buttonTransition === 'number') operations.push(op(next.id, 'Button.transition', { numberValue: next.buttonTransition }));
  if (prev.buttonColors && next.buttonColors) {
    (['normalColor', 'highlightedColor', 'pressedColor', 'disabledColor'] as const).forEach((key) => {
      if (prev.buttonColors?.[key] !== next.buttonColors?.[key]) operations.push(op(next.id, `Button.colors.${key}`, { stringValue: colorWithAlpha(next.buttonColors?.[key]) }));
    });
    if (prev.buttonColors.colorMultiplier !== next.buttonColors.colorMultiplier) operations.push(op(next.id, 'Button.colors.colorMultiplier', { numberValue: next.buttonColors.colorMultiplier }));
    if (prev.buttonColors.fadeDuration !== next.buttonColors.fadeDuration) operations.push(op(next.id, 'Button.colors.fadeDuration', { numberValue: next.buttonColors.fadeDuration }));
  }
  if (!sameEffect(prev.outline, next.outline)) pushEffectOps(operations, next.id, 'Outline', prev.outline, next.outline);
  if (!sameEffect(prev.textOutline, next.textOutline)) pushEffectOps(operations, next.id, 'Outline', prev.textOutline, next.textOutline);
  if (!sameEffect(prev.textShadow, next.textShadow)) pushEffectOps(operations, next.id, 'Shadow', prev.textShadow, next.textShadow);
  if (prev.isMask !== next.isMask || prev.maskType !== next.maskType) operations.push(op(next.id, 'Mask.type', { stringValue: next.isMask ? (next.maskType || 'Mask') : 'None' }));
  if (prev.maskShowGraphic !== next.maskShowGraphic && typeof next.maskShowGraphic === 'boolean') operations.push(op(next.id, 'Mask.showGraphic', { boolValue: next.maskShowGraphic }));
  if (prev.scrollDirection !== next.scrollDirection && next.scrollDirection) {
    operations.push(op(next.id, 'ScrollRect.horizontal', { boolValue: next.scrollDirection === 'horizontal' || next.scrollDirection === 'both' }));
    operations.push(op(next.id, 'ScrollRect.vertical', { boolValue: next.scrollDirection === 'vertical' || next.scrollDirection === 'both' }));
  }
  if (prev.isOn !== next.isOn && typeof next.isOn === 'boolean') operations.push(op(next.id, 'Toggle.isOn', { boolValue: next.isOn }));
  if (prev.layoutElement !== next.layoutElement && next.layoutElement) {
    operations.push(op(next.id, 'LayoutElement.ignoreLayout', { boolValue: next.layoutElement.ignoreLayout }));
    operations.push(op(next.id, 'LayoutElement.minWidth', { numberValue: next.layoutElement.minWidth }));
    operations.push(op(next.id, 'LayoutElement.minHeight', { numberValue: next.layoutElement.minHeight }));
    operations.push(op(next.id, 'LayoutElement.preferredWidth', { numberValue: next.layoutElement.preferredWidth }));
    operations.push(op(next.id, 'LayoutElement.preferredHeight', { numberValue: next.layoutElement.preferredHeight }));
    operations.push(op(next.id, 'LayoutElement.flexibleWidth', { numberValue: next.layoutElement.flexibleWidth }));
    operations.push(op(next.id, 'LayoutElement.flexibleHeight', { numberValue: next.layoutElement.flexibleHeight }));
  }
  if (prev.layoutGroup !== next.layoutGroup && next.layoutGroup) {
    operations.push(op(next.id, 'LayoutGroup.type', { stringValue: next.layoutGroup.layoutType || (next.layoutGroup.isGrid ? 'Grid' : (next.layoutGroup.isHorizontal ? 'Horizontal' : 'Vertical')) }));
    operations.push(op(next.id, 'LayoutGroup.enabled', { boolValue: next.layoutGroup.enabled }));
    operations.push(op(next.id, 'LayoutGroup.spacing', { numberValue: next.layoutGroup.spacing }));
    if (typeof next.layoutGroup.spacingY === 'number') operations.push(op(next.id, 'LayoutGroup.spacingY', { numberValue: next.layoutGroup.spacingY }));
    operations.push(op(next.id, 'LayoutGroup.padding.left', { numberValue: next.layoutGroup.padLeft }));
    operations.push(op(next.id, 'LayoutGroup.padding.right', { numberValue: next.layoutGroup.padRight }));
    operations.push(op(next.id, 'LayoutGroup.padding.top', { numberValue: next.layoutGroup.padTop }));
    operations.push(op(next.id, 'LayoutGroup.padding.bottom', { numberValue: next.layoutGroup.padBottom }));
    operations.push(op(next.id, 'LayoutGroup.childAlignment', { numberValue: next.layoutGroup.childAlignment }));
    operations.push(op(next.id, 'LayoutGroup.childControlWidth', { boolValue: next.layoutGroup.childControlWidth }));
    operations.push(op(next.id, 'LayoutGroup.childControlHeight', { boolValue: next.layoutGroup.childControlHeight }));
    operations.push(op(next.id, 'LayoutGroup.childForceExpandWidth', { boolValue: next.layoutGroup.childForceExpandWidth }));
    operations.push(op(next.id, 'LayoutGroup.childForceExpandHeight', { boolValue: next.layoutGroup.childForceExpandHeight }));
    if (typeof next.layoutGroup.reverseArrangement === 'boolean') operations.push(op(next.id, 'LayoutGroup.reverseArrangement', { boolValue: next.layoutGroup.reverseArrangement }));
    if (typeof next.layoutGroup.cellSizeX === 'number' || typeof next.layoutGroup.cellSizeY === 'number') operations.push(op(next.id, 'GridLayoutGroup.cellSize', { value: [next.layoutGroup.cellSizeX ?? 100, next.layoutGroup.cellSizeY ?? 100] }));
    if (typeof next.layoutGroup.startCorner === 'number') operations.push(op(next.id, 'GridLayoutGroup.startCorner', { numberValue: next.layoutGroup.startCorner }));
    if (typeof next.layoutGroup.startAxis === 'number') operations.push(op(next.id, 'GridLayoutGroup.startAxis', { numberValue: next.layoutGroup.startAxis }));
    if (typeof next.layoutGroup.constraint === 'number') operations.push(op(next.id, 'GridLayoutGroup.constraint', { numberValue: next.layoutGroup.constraint }));
    if (typeof next.layoutGroup.constraintCount === 'number') operations.push(op(next.id, 'GridLayoutGroup.constraintCount', { numberValue: next.layoutGroup.constraintCount }));
  }
  if (prev.contentSizeFitter !== next.contentSizeFitter && next.contentSizeFitter) {
    operations.push(op(next.id, 'ContentSizeFitter.enabled', { boolValue: next.contentSizeFitter.enabled }));
    operations.push(op(next.id, 'ContentSizeFitter.horizontalFit', { numberValue: next.contentSizeFitter.horizontalFit }));
    operations.push(op(next.id, 'ContentSizeFitter.verticalFit', { numberValue: next.contentSizeFitter.verticalFit }));
  }
  await applyVisualFieldsOnBridge(operations);
}

export async function insertPrefabIntoActiveArtboard(prefabPath: string, point: { x: number; y: number }) {
  const state = useEditorStore.getState();
  const viewportWidth = state.previewWidth;
  const viewportHeight = state.previewHeight;
  const startedAt = performance.now();
  const response = await runWithRecoveredActiveSession((artboard) => {
    const rootNodeId = artboard.bridgeRootNodeId ?? null;
    debugLog('bridge-insert', 'request', {
      sessionId: artboard.bridgeSessionId,
      artboardId: artboard.id,
      artboardName: artboard.name,
      prefabPath,
      point: { x: Math.round(point.x), y: Math.round(point.y) },
      unityPosition: {
        x: Math.round(point.x - viewportWidth / 2),
        y: Math.round(viewportHeight / 2 - point.y),
      },
      parentId: rootNodeId,
      beforeNodeCount: Object.keys(artboard.nodes ?? {}).length,
      beforeRootCount: artboard.rootIds?.length ?? 0,
    });
    return editorBridgeClient.insertPrefab(artboard.bridgeSessionId!, prefabPath, {
      parentId: rootNodeId,
      x: Math.round(point.x - viewportWidth / 2),
      y: Math.round(viewportHeight / 2 - point.y),
    }, { skipSnapshot: false });
  }, '已恢复插入 session');
  debugLog('bridge-insert', 'response', {
    prefabPath,
    elapsedMs: Math.round(performance.now() - startedAt),
    responseNodeCount: response.nodes.length,
    rootNodeId: response.rootNodeId,
    selectedNodeId: response.selectedNodeId,
    dirty: response.dirty,
    duplicateNodeIds: duplicateNodeIds(response.nodes),
    snapshotId: response.snapshot?.snapshotId,
    bboxCount: response.snapshot?.bboxes.length,
    profileTotalMs: response.profile?.totalMs,
    profile: response.profile?.entries,
  });
  await applyBridgeStateToActiveArtboard(response, '已插入 UI');
}

export async function saveActiveBridgeArtboard(targetPath?: string | null, options: { saveAs?: boolean } = {}) {
  const artboard = await ensureActiveBridgeArtboard();
  const target = options.saveAs || !artboard.sourcePrefabPath
    ? normalizeTargetPath(targetPath || artboard.bridgeTargetPrefabPath || defaultTargetFor(artboard.name))
    : null;
  const result = await runWithRecoveredActiveSession((active) =>
    editorBridgeClient.saveArtboard(active.bridgeSessionId!, target),
  '已恢复保存 session');
  updateActiveArtboard({
    name: basename(result.sourcePrefabPath || result.savedPath || artboard.name),
    sourcePrefabPath: result.sourcePrefabPath || result.savedPath || artboard.sourcePrefabPath,
    bridgeWorkingPrefabPath: result.workingPrefabPath,
    bridgeTargetPrefabPath: result.sourcePrefabPath || result.savedPath,
    bridgeRevision: result.revision,
    bridgeDirty: false,
    bridgeStatus: `已保存: ${result.savedPath}`,
  });
  return result;
}

export function bboxForNode(snapshot: SnapshotRecord | null | undefined, nodeId: string | null | undefined): BboxRecord | null {
  if (!snapshot || !nodeId) return null;
  return snapshot.bboxes.find((box) => box.nodeId === nodeId) ?? null;
}

export function createLocalArtboardId(): string {
  return uuid();
}

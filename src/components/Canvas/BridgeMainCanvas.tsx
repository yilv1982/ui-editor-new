import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { alignNodes } from '../../App';
import { DEFAULT_PREVIEW_HEIGHT, DEFAULT_PREVIEW_WIDTH, DESIGN_HEIGHT, DESIGN_WIDTH } from '../../config/assetPaths';
import { useEditorStore } from '../../stores/editorStore';
import type { BboxRecord } from '../../services/EditorBridgeClient';
import {
  ensureActiveBridgeArtboard,
  createWidgetNodeOnBridge,
  insertPrefabIntoArtboard,
  isEmptyLocalArtboard,
  isApplyingBridgeState,
  moveNodeOnBridge,
  refreshActiveBridgeSnapshot,
  reparentNodeOnBridge,
  resizeNodeOnBridge,
  shouldMaterializeBridgeArtboard,
  syncNodeVisualDelta,
} from '../../services/BridgeArtboardStore';
import { registerDropTarget } from '../../utils/customDrag';
import { debugLog } from '../../utils/debugLog';
import ArtboardsOverlay from './ArtboardsOverlay';
import ArtboardSidebarOverlay from './ArtboardSidebarOverlay';
import AnnotationListDialog from '../Panels/AnnotationListDialog';
import UEExportDialog from '../Panels/UEExportDialog';
import AnnotationModeBar from './AnnotationModeBar';
import AnnotationOverlay from './AnnotationOverlay';
import type { PreviewDraft } from './AnnotationOverlay';
import SceneToolbar from './SceneToolbar';
import TextInlineEditor from './TextInlineEditor';

/**
 * BridgeMainCanvas is the only main editor canvas.
 * It renders Unity Editor Bridge snapshots and keeps old shell interactions
 * such as pan/zoom, bbox selection, rulers, guides, measuring, annotations,
 * and scene transform handles.
 */
const RULER_SIZE = 24;
const RULER_BG = '#1e1e2e';
const RULER_TEXT = '#6c7086';
const RULER_TICK = '#45475a';
const RULER_SEL = 'rgba(76,126,243,0.25)';
const RULER_MOUSE = '#f38ba8';
const SELECTION_COLOR = '#4C7EF3';
const SELECTION_FILL = 'rgba(76,126,243,0.08)';
const HANDLE_SIZE = 10;
const EDGE_HANDLE_SIZE = 8;
const AXIS_LEN = 58;
const AXIS_HIT = 12;
const ROTATE_PAD = 28;
const MIN_NODE_SIZE = 1;

const RESOLUTION_PRESETS = [
  { w: DEFAULT_PREVIEW_WIDTH, h: DEFAULT_PREVIEW_HEIGHT, label: `${DEFAULT_PREVIEW_WIDTH}x${DEFAULT_PREVIEW_HEIGHT} (默认)` },
  { w: DESIGN_WIDTH, h: DESIGN_HEIGHT, label: `${DESIGN_WIDTH}x${DESIGN_HEIGHT} (横屏基准)` },
  { w: 1334, h: 750, label: '1334x750 (iPhone)' },
  { w: 2560, h: 1440, label: '2560x1440 (QHD)' },
];

type Guide = { id: number; axis: 'h' | 'v'; designPos: number };
type RectHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
type TransformHandle = RectHandle | 'move' | 'move-x' | 'move-y' | 'rotate' | `scale-${'nw' | 'ne' | 'se' | 'sw'}`;
type TransformPreview = {
  nodeId: string;
  boxX: number;
  boxY: number;
  boxWidth: number;
  boxHeight: number;
  nodeX: number;
  nodeY: number;
  nodeWidth: number;
  nodeHeight: number;
  rotation: number;
};
type TransformSession = {
  handle: TransformHandle;
  startClientX: number;
  startClientY: number;
  startBoxX: number;
  startBoxY: number;
  startBoxWidth: number;
  startBoxHeight: number;
  startNodeX: number;
  startNodeY: number;
  startNodeWidth: number;
  startNodeHeight: number;
  pivotX: number;
  pivotY: number;
  pixelScale: number;
  startRotation: number;
  centerClientX: number;
  centerClientY: number;
  startAngle: number;
  latest: TransformPreview;
};

function pickBboxAtPoint(bboxes: BboxRecord[], x: number, y: number, rootNodeId?: string | null): BboxRecord | null {
  const nodes = useEditorStore.getState().nodes;
  for (let i = bboxes.length - 1; i >= 0; i -= 1) {
    const box = bboxes[i];
    if (!box.activeInHierarchy || box.width <= 1 || box.height <= 1) continue;
    if (box.nodeId === rootNodeId) continue;
    if (nodes[box.nodeId]?.locked) continue;
    if (x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height) return box;
  }
  return null;
}

function pickBboxesInRect(
  bboxes: BboxRecord[],
  rect: { left: number; right: number; top: number; bottom: number },
  nodes: Record<string, unknown>,
  rootNodeId?: string | null,
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const box of bboxes) {
    if (!box.activeInHierarchy || box.width <= 1 || box.height <= 1) continue;
    if (!nodes[box.nodeId] || box.nodeId === rootNodeId || seen.has(box.nodeId)) continue;
    if ((nodes[box.nodeId] as { locked?: boolean }).locked) continue;
    const ix = Math.max(0, Math.min(box.x + box.width, rect.right) - Math.max(box.x, rect.left));
    const iy = Math.max(0, Math.min(box.y + box.height, rect.bottom) - Math.max(box.y, rect.top));
    if (ix * iy < 4) continue;
    ids.push(box.nodeId);
    seen.add(box.nodeId);
  }
  return ids;
}

function sameOrder(a: string[] | undefined, b: string[] | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.length !== b.length) return false;
  return a.every((item, index) => item === b[index]);
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el?.closest('button,input,textarea,select,[data-artboard-title],[data-canvas-ui]');
}

function safeReleasePointerCapture(el: Element, pointerId: number) {
  try {
    if ((el as HTMLElement).hasPointerCapture?.(pointerId)) {
      (el as HTMLElement).releasePointerCapture(pointerId);
    }
  } catch {
    // Browser can throw if capture was already released.
  }
}

function rectCursor(handle: RectHandle): string {
  switch (handle) {
    case 'n':
    case 's':
      return 'ns-resize';
    case 'e':
    case 'w':
      return 'ew-resize';
    case 'ne':
    case 'sw':
      return 'nesw-resize';
    case 'nw':
    case 'se':
      return 'nwse-resize';
    default:
      return 'default';
  }
}

function rectHandleStyle(handle: RectHandle, width: number, height: number, scale = 1): React.CSSProperties {
  const size = (handle === 'n' || handle === 'e' || handle === 's' || handle === 'w') ? EDGE_HANDLE_SIZE : HANDLE_SIZE;
  const half = size / 2;
  const x = handle.includes('w') ? 0 : (handle.includes('e') ? width : width / 2);
  const y = handle.includes('n') ? 0 : (handle.includes('s') ? height : height / 2);
  return {
    left: x * scale - half,
    top: y * scale - half,
    width: size,
    height: size,
    cursor: rectCursor(handle),
  };
}

function normalizeScaleHandle(handle: TransformHandle): RectHandle {
  return handle.startsWith('scale-') ? handle.slice(6) as RectHandle : handle as RectHandle;
}

function isResizeLikeHandle(handle: TransformHandle): boolean {
  return ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].includes(handle) || handle.startsWith('scale-');
}

function computeTransformPreview(session: TransformSession, clientX: number, clientY: number, shiftKey: boolean): TransformPreview {
  const dx = (clientX - session.startClientX) / Math.max(0.0001, session.pixelScale);
  const dy = (clientY - session.startClientY) / Math.max(0.0001, session.pixelScale);
  if (session.handle === 'rotate') {
    const angle = Math.atan2(clientY - session.centerClientY, clientX - session.centerClientX);
    let rotation = session.startRotation + (angle - session.startAngle) * (180 / Math.PI);
    if (shiftKey) rotation = Math.round(rotation / 15) * 15;
    return { ...session.latest, rotation };
  }
  if (session.handle === 'move' || session.handle === 'move-x' || session.handle === 'move-y') {
    const xDelta = session.handle === 'move-y' ? 0 : dx;
    const yDelta = session.handle === 'move-x' ? 0 : dy;
    return {
      nodeId: session.latest.nodeId,
      boxX: session.startBoxX + xDelta,
      boxY: session.startBoxY + yDelta,
      boxWidth: session.startBoxWidth,
      boxHeight: session.startBoxHeight,
      nodeX: Math.round(session.startNodeX + xDelta),
      nodeY: Math.round(session.startNodeY - yDelta),
      nodeWidth: session.startNodeWidth,
      nodeHeight: session.startNodeHeight,
      rotation: session.startRotation,
    };
  }
  if (!isResizeLikeHandle(session.handle)) return session.latest;
  const handle = normalizeScaleHandle(session.handle);
  const lockAspect = shiftKey || session.handle.startsWith('scale-');
  let boxX = session.startBoxX;
  let boxY = session.startBoxY;
  let boxWidth = session.startBoxWidth;
  let boxHeight = session.startBoxHeight;
  if (handle.includes('e')) boxWidth = session.startBoxWidth + dx;
  if (handle.includes('w')) {
    boxWidth = session.startBoxWidth - dx;
    boxX = session.startBoxX + dx;
  }
  if (handle.includes('s')) boxHeight = session.startBoxHeight + dy;
  if (handle.includes('n')) {
    boxHeight = session.startBoxHeight - dy;
    boxY = session.startBoxY + dy;
  }
  if (boxWidth < MIN_NODE_SIZE) {
    if (handle.includes('w')) boxX -= MIN_NODE_SIZE - boxWidth;
    boxWidth = MIN_NODE_SIZE;
  }
  if (boxHeight < MIN_NODE_SIZE) {
    if (handle.includes('n')) boxY -= MIN_NODE_SIZE - boxHeight;
    boxHeight = MIN_NODE_SIZE;
  }
  const isCorner = (handle.includes('e') || handle.includes('w')) && (handle.includes('n') || handle.includes('s'));
  if (lockAspect && isCorner && session.startBoxWidth > 0 && session.startBoxHeight > 0) {
    const aspect = session.startBoxWidth / session.startBoxHeight;
    const wFactor = boxWidth / session.startBoxWidth;
    const hFactor = boxHeight / session.startBoxHeight;
    const factor = Math.max(MIN_NODE_SIZE / session.startBoxWidth, Math.abs(wFactor - 1) > Math.abs(hFactor - 1) ? wFactor : hFactor);
    boxWidth = Math.max(MIN_NODE_SIZE, session.startBoxWidth * factor);
    boxHeight = Math.max(MIN_NODE_SIZE, boxWidth / aspect);
    if (handle.includes('w')) boxX = session.startBoxX + session.startBoxWidth - boxWidth;
    else boxX = session.startBoxX;
    if (handle.includes('n')) boxY = session.startBoxY + session.startBoxHeight - boxHeight;
    else boxY = session.startBoxY;
  }
  const oldPivotScreenX = session.startBoxX + session.pivotX * session.startBoxWidth;
  const oldPivotScreenY = session.startBoxY + (1 - session.pivotY) * session.startBoxHeight;
  const newPivotScreenX = boxX + session.pivotX * boxWidth;
  const newPivotScreenY = boxY + (1 - session.pivotY) * boxHeight;
  return {
    nodeId: session.latest.nodeId,
    boxX,
    boxY,
    boxWidth,
    boxHeight,
    nodeX: Math.round(session.startNodeX + newPivotScreenX - oldPivotScreenX),
    nodeY: Math.round(session.startNodeY - (newPivotScreenY - oldPivotScreenY)),
    nodeWidth: Math.round(Math.max(MIN_NODE_SIZE, session.startNodeWidth + (boxWidth - session.startBoxWidth))),
    nodeHeight: Math.round(Math.max(MIN_NODE_SIZE, session.startNodeHeight + (boxHeight - session.startBoxHeight))),
    rotation: session.startRotation,
  };
}

export default function BridgeMainCanvas() {
  const containerRef = useRef<HTMLDivElement>(null);
  const hRulerRef = useRef<HTMLCanvasElement>(null);
  const vRulerRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{
    nodeId: string;
    startClientX: number;
    startClientY: number;
    startX: number;
    startY: number;
    deltaX: number;
    deltaY: number;
  } | null>(null);
  const measureRef = useRef<{ startX: number; startY: number; measuring: boolean } | null>(null);
  const panRef = useRef<{ isPanning: boolean; startX: number; startY: number } | null>(null);
  const spaceHeld = useRef(false);
  const guideIdCounter = useRef(0);
  const guideDragRef = useRef<{ axis: 'h' | 'v'; existingId?: number; startClientPos: number } | null>(null);
  const annDraftRef = useRef<{ startDesign: { x: number; y: number }; type: 'arrow' | 'rect' | 'dimension' } | null>(null);
  const dblClickRef = useRef<{ nodeId: string; time: number } | null>(null);
  const transformRef = useRef<TransformSession | null>(null);
  const lastViewportArtboardIdRef = useRef<string | null>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragPreview, setDragPreview] = useState<{ nodeId: string; dx: number; dy: number } | null>(null);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [mousePos, setMousePos] = useState<{ x: number; y: number } | null>(null);
  const [guides, setGuides] = useState<Guide[]>([]);
  const [guideDragPos, setGuideDragPos] = useState<{ axis: 'h' | 'v'; screenPos: number } | null>(null);
  const [measureRect, setMeasureRect] = useState<{ sx: number; sy: number; ex: number; ey: number } | null>(null);
  const [previewDraft, setPreviewDraft] = useState<PreviewDraft | null>(null);
  const [transformPreview, setTransformPreview] = useState<TransformPreview | null>(null);
  const [annListOpen, setAnnListOpen] = useState(false);
  const [ueExportOpen, setUeExportOpen] = useState(false);
  const syncQueueRef = useRef<Promise<void>>(Promise.resolve());
  const ignoreNextNodeSyncRef = useRef(0);

  const state = useEditorStore();
  const page = state.pages.find((item) => item.id === state.activePageId);
  const activeArtboard = page?.artboards.find((item) => item.id === state.activeArtboardId) ?? null;
  const snapshot = activeArtboard?.bridgeSnapshot ?? null;
  const snapshotUrl = activeArtboard?.bridgeSnapshotUrl ?? null;
  const emptyLocalArtboard = isEmptyLocalArtboard(activeArtboard);
  const selectedId = state.selectedIds[0] ?? null;
  const snapshotViewport = useMemo(() => {
    const viewport = snapshot?.viewport;
    return {
      x: viewport?.x ?? 0,
      y: viewport?.y ?? 0,
      width: viewport?.width ?? state.previewWidth,
      height: viewport?.height ?? state.previewHeight,
    };
  }, [snapshot?.viewport, state.previewWidth, state.previewHeight]);
  const selectedBox = useMemo(() => {
    if (!snapshot || !selectedId) return null;
    return snapshot.bboxes.find((box: BboxRecord) => box.nodeId === selectedId) ?? null;
  }, [snapshot, selectedId]);
  const selectedBoxes = useMemo(() => {
    if (!snapshot) return [];
    const selected = new Set(state.selectedIds);
    return snapshot.bboxes.filter((box: BboxRecord) => selected.has(box.nodeId));
  }, [snapshot, state.selectedIds]);

  const artboardX = activeArtboard?.x ?? 0;
  const artboardY = activeArtboard?.y ?? 0;
  const screenX = state.canvasX + artboardX * state.canvasScale;
  const screenY = state.canvasY + artboardY * state.canvasScale;
  const screenW = state.previewWidth * state.canvasScale;
  const screenH = state.previewHeight * state.canvasScale;
  const snapshotImageW = (snapshot?.width ?? state.previewWidth) * state.canvasScale;
  const snapshotImageH = (snapshot?.height ?? state.previewHeight) * state.canvasScale;
  const snapshotScreenX = screenX - snapshotViewport.x * state.canvasScale;
  const snapshotScreenY = screenY - snapshotViewport.y * state.canvasScale;
  const editingTextId = state.editingTextId;
  const annotationTool = state.annotationTool;

  const clientToContainer = useCallback((clientX: number, clientY: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return { x: clientX - rect.left, y: clientY - rect.top, rect };
  }, []);

  const clientToWorld = useCallback((clientX: number, clientY: number) => {
    const point = clientToContainer(clientX, clientY);
    const scale = useEditorStore.getState().canvasScale;
    if (!point || scale <= 0) return null;
    const st = useEditorStore.getState();
    return {
      x: (point.x - st.canvasX) / scale,
      y: (point.y - st.canvasY) / scale,
      screenX: point.x,
      screenY: point.y,
    };
  }, [clientToContainer]);

  const clientToActiveLocal = useCallback((clientX: number, clientY: number) => {
    const world = clientToWorld(clientX, clientY);
    const st = useEditorStore.getState();
    const activePage = st.pages.find((item) => item.id === st.activePageId);
    const active = activePage?.artboards.find((item) => item.id === st.activeArtboardId);
    if (!world || !active) return null;
    return {
      x: world.x - active.x,
      y: world.y - active.y,
      worldX: world.x,
      worldY: world.y,
      screenX: world.screenX,
      screenY: world.screenY,
    };
  }, [clientToWorld]);

  const focusArtboardInViewport = useCallback((artboard = activeArtboard) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!artboard || !rect || rect.width <= 0 || rect.height <= 0) return false;
    const st = useEditorStore.getState();
    const scale = st.canvasScale;
    const nextX = rect.width / 2 - (artboard.x + artboard.width / 2) * scale;
    const nextY = rect.height / 2 - (artboard.y + artboard.height / 2) * scale;
    st.setCanvasTransform(nextX, nextY, scale);
    debugLog('viewport', 'focus-artboard', {
      artboardId: artboard.id,
      artboardName: artboard.name,
      canvas: {
        x: Math.round(nextX),
        y: Math.round(nextY),
        scale,
      },
    });
    return true;
  }, [activeArtboard]);

  const hitNodeAtClient = useCallback((clientX: number, clientY: number): BboxRecord | null => {
    const st = useEditorStore.getState();
    const activePage = st.pages.find((item) => item.id === st.activePageId);
    const active = activePage?.artboards.find((item) => item.id === st.activeArtboardId);
    const boxSnapshot = active?.bridgeSnapshot;
    if (!active || !boxSnapshot) return null;
    const point = clientToActiveLocal(clientX, clientY);
    if (!point) return null;
    return pickBboxAtPoint(boxSnapshot.bboxes, point.x + snapshotViewport.x, point.y + snapshotViewport.y, active.bridgeRootNodeId);
  }, [clientToActiveLocal, snapshotViewport.x, snapshotViewport.y]);

  const beginTransform = useCallback((event: React.PointerEvent<HTMLElement | SVGElement>, box: BboxRecord, handle: TransformHandle) => {
    const st = useEditorStore.getState();
    const node = st.nodes[box.nodeId];
    if (!node) return;
    if (node.locked) return;
    event.preventDefault();
    event.stopPropagation();
    st.setSelectedIds([box.nodeId]);
    const pivotX = node.pivot?.x ?? 0.5;
    const pivotY = node.pivot?.y ?? 0.5;
    const centerClientX = snapshotScreenX + (box.x + box.width / 2) * st.canvasScale;
    const centerClientY = snapshotScreenY + (box.y + box.height / 2) * st.canvasScale;
    const latest: TransformPreview = {
      nodeId: box.nodeId,
      boxX: box.x,
      boxY: box.y,
      boxWidth: box.width,
      boxHeight: box.height,
      nodeX: node.x,
      nodeY: node.y,
      nodeWidth: node.width,
      nodeHeight: node.height,
      rotation: node.rotation || 0,
    };
    transformRef.current = {
      handle,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startBoxX: box.x,
      startBoxY: box.y,
      startBoxWidth: box.width,
      startBoxHeight: box.height,
      startNodeX: node.x,
      startNodeY: node.y,
      startNodeWidth: node.width,
      startNodeHeight: node.height,
      pivotX,
      pivotY,
      pixelScale: st.canvasScale,
      startRotation: node.rotation || 0,
      centerClientX,
      centerClientY,
      startAngle: Math.atan2(event.clientY - centerClientY, event.clientX - centerClientX),
      latest,
    };
    setTransformPreview(latest);
    try {
      (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    } catch {
      // Ignore capture failures; the parent canvas still receives bubbled pointer events.
    }
  }, [snapshotScreenX, snapshotScreenY]);

  const downloadSnapshot = useCallback(() => {
    const artboard = useEditorStore.getState().pages
      .find((item) => item.id === useEditorStore.getState().activePageId)
      ?.artboards.find((item) => item.id === useEditorStore.getState().activeArtboardId);
    if (!artboard?.bridgeSnapshotUrl) return;
    const now = new Date();
    const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
    const a = document.createElement('a');
    a.href = artboard.bridgeSnapshotUrl;
    a.download = `${artboard.name || 'UIEditor'}_${ts}.png`;
    a.click();
  }, []);

  useEffect(() => {
    if (activeArtboard?.bridgeSessionId || loading) return;
    if (!shouldMaterializeBridgeArtboard(activeArtboard)) return;
    setLoading(true);
    setError(null);
    void ensureActiveBridgeArtboard()
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [activeArtboard?.id, activeArtboard?.bridgeSessionId, loading]);

  useEffect(() => {
    if (!activeArtboard?.id) return;
    if (lastViewportArtboardIdRef.current === activeArtboard.id) return;
    if (focusArtboardInViewport(activeArtboard)) {
      lastViewportArtboardIdRef.current = activeArtboard.id;
    }
  }, [activeArtboard, containerSize.width, containerSize.height, focusArtboardInViewport]);

  useEffect(() => {
    return useEditorStore.subscribe((nextState, prevState) => {
      if (isApplyingBridgeState()) return;
      if (ignoreNextNodeSyncRef.current > 0) {
        ignoreNextNodeSyncRef.current -= 1;
        return;
      }
      if (nextState.activeArtboardId !== prevState.activeArtboardId || nextState.activePageId !== prevState.activePageId) return;
      if (nextState.nodes === prevState.nodes) return;
      const enqueue = (task: () => Promise<void>) => {
        syncQueueRef.current = syncQueueRef.current
          .catch(() => undefined)
          .then(task)
          .catch((err) => setError(err instanceof Error ? err.message : String(err)));
      };
      if (!sameOrder(nextState.rootIds, prevState.rootIds)) {
        nextState.rootIds.forEach((nodeId, index) => {
          if (prevState.rootIds[index] !== nodeId) {
            enqueue(() => reparentNodeOnBridge(nodeId, null, index));
          }
        });
      }
      Object.keys(nextState.nodes).forEach((nodeId) => {
        const nextNode = nextState.nodes[nodeId];
        const prevNode = prevState.nodes[nodeId];
        if (!nextNode || !prevNode || sameOrder(nextNode.children, prevNode.children)) return;
        nextNode.children.forEach((childId, index) => {
          if (prevNode.children[index] !== childId) {
            enqueue(() => reparentNodeOnBridge(childId, nodeId, index));
          }
        });
      });
      const changedIds = new Set<string>();
      Object.keys(nextState.nodes).forEach((id) => {
        if (nextState.nodes[id] !== prevState.nodes[id]) changedIds.add(id);
      });
      Object.keys(prevState.nodes).forEach((id) => {
        if (!nextState.nodes[id]) changedIds.add(id);
      });
      if (changedIds.size === 0) return;
      for (const nodeId of changedIds) {
        enqueue(() => syncNodeVisualDelta(prevState.nodes[nodeId], nextState.nodes[nodeId]));
      }
    });
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    return registerDropTarget({
      element: el,
      onDrop: (type, data, clientX, clientY) => {
        const st = useEditorStore.getState();
        const activePage = st.pages.find((item) => item.id === st.activePageId);
        const artboards = activePage?.artboards ?? [];
        const prefabPath = typeof data?.relPath === 'string' ? data.relPath : '';
        const rect = el.getBoundingClientRect();
        const localClientX = clientX - rect.left;
        const localClientY = clientY - rect.top;
        const targetArtboard = artboards.find((artboard) => {
          const x = st.canvasX + artboard.x * st.canvasScale;
          const y = st.canvasY + artboard.y * st.canvasScale;
          const w = st.previewWidth * st.canvasScale;
          const h = st.previewHeight * st.canvasScale;
          return localClientX >= x && localClientX <= x + w && localClientY >= y && localClientY <= y + h;
        });
        const active = targetArtboard ?? activePage?.artboards.find((item) => item.id === st.activeArtboardId);
        debugLog('canvas-drop', 'hit-test', {
          type,
          prefabPath,
          client: { x: clientX, y: clientY },
          localClient: { x: Math.round(localClientX), y: Math.round(localClientY) },
          activePageId: activePage?.id,
          activeArtboardId: st.activeArtboardId,
          targetArtboardId: targetArtboard?.id,
          targetArtboardName: targetArtboard?.name,
          artboardCount: artboards.length,
          canvas: {
            x: Math.round(st.canvasX),
            y: Math.round(st.canvasY),
            scale: st.canvasScale,
            previewWidth: st.previewWidth,
            previewHeight: st.previewHeight,
          },
        });
        if (!active || !targetArtboard) {
          debugLog('canvas-drop', 'ignored-no-artboard-hit', {
            type,
            prefabPath,
            activeArtboardId: st.activeArtboardId,
            targetArtboardId: targetArtboard?.id,
          });
          return;
        }
        const ax = st.canvasX + active.x * st.canvasScale;
        const ay = st.canvasY + active.y * st.canvasScale;
        const point = {
          x: (localClientX - ax) / st.canvasScale,
          y: (localClientY - ay) / st.canvasScale,
        };
        debugLog('canvas-drop', 'resolved-target', {
          type,
          prefabPath,
          artboardId: active.id,
          artboardName: active.name,
          point: { x: Math.round(point.x), y: Math.round(point.y) },
          workingPrefabPath: active.bridgeWorkingPrefabPath,
          sourcePrefabPath: active.sourcePrefabPath,
        });
        if (type === 'application/uieditor-prefab' || type === 'application/component') {
          if (!prefabPath) {
            debugLog('canvas-drop', 'ignored-missing-prefab-path', { type, dataName: typeof data?.name === 'string' ? data.name : undefined });
            setError('这个组件没有 Prefab 路径，不能插入画板');
            return;
          }
          void insertPrefabIntoArtboard(active.id, prefabPath, point, activePage?.id).catch((err) => {
            debugLog('canvas-drop', 'insert-prefab-error', {
              prefabPath,
              artboardId: active.id,
              error: err instanceof Error ? err.message : String(err),
            });
            setError(err instanceof Error ? err.message : String(err));
          });
          return;
        }
        if (type === 'application/atlas-image') {
          const x = Math.round(point.x - st.previewWidth / 2);
          const y = Math.round(st.previewHeight / 2 - point.y);
          void createWidgetNodeOnBridge({
            widgetType: 'image',
            name: typeof data?.name === 'string' ? data.name : 'Image',
            x,
            y,
            width: 160,
            height: 160,
            parentId: active.bridgeRootNodeId || undefined,
            spritePath: typeof data?.path === 'string' ? data.path : undefined,
          }).catch((err) => {
            debugLog('canvas-drop', 'create-image-error', { error: err instanceof Error ? err.message : String(err) });
            setError(err instanceof Error ? err.message : String(err));
          });
        }
      },
    });
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setContainerSize({ width, height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      if (!guideDragRef.current) return;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const screenPos = guideDragRef.current.axis === 'h'
        ? event.clientY - rect.top
        : event.clientX - rect.left;
      setGuideDragPos({ axis: guideDragRef.current.axis, screenPos });
    };
    const onUp = (event: PointerEvent) => {
      if (!guideDragRef.current) return;
      const rect = containerRef.current?.getBoundingClientRect();
      if (rect) {
        const st = useEditorStore.getState();
        const { axis, existingId } = guideDragRef.current;
        const screenPos = axis === 'h' ? event.clientY - rect.top : event.clientX - rect.left;
        const designPos = axis === 'h'
          ? (screenPos - st.canvasY) / st.canvasScale
          : (screenPos - st.canvasX) / st.canvasScale;
        const inRuler = screenPos < RULER_SIZE;
        if (existingId !== undefined) {
          if (inRuler) {
            setGuides((prev) => prev.filter((guide) => guide.id !== existingId));
          } else {
            setGuides((prev) => prev.map((guide) => guide.id === existingId ? { ...guide, designPos } : guide));
          }
        } else if (!inRuler) {
          const id = ++guideIdCounter.current;
          setGuides((prev) => [...prev, { id, axis, designPos }]);
        }
      }
      guideDragRef.current = null;
      setGuideDragPos(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, []);

  useEffect(() => {
    let lastSpaceUpAt = 0;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || event.repeat) return;
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      spaceHeld.current = true;
      if (containerRef.current) containerRef.current.style.cursor = 'grab';
      const now = performance.now();
      if (now - lastSpaceUpAt < 300) {
        const rect = containerRef.current?.getBoundingClientRect();
        if (rect) {
          const st = useEditorStore.getState();
          const cx = (rect.width - st.previewWidth) / 2 - artboardX;
          const cy = (rect.height - st.previewHeight) / 2 - artboardY;
          st.setCanvasTransform(cx, cy, 1);
        }
        lastSpaceUpAt = 0;
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code !== 'Space') return;
      spaceHeld.current = false;
      lastSpaceUpAt = performance.now();
      if (containerRef.current && !panRef.current?.isPanning) {
        containerRef.current.style.cursor = '';
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [artboardX, artboardY]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      const mouseX = event.clientX - rect.left;
      const mouseY = event.clientY - rect.top;
      const st = useEditorStore.getState();
      const scaleBy = 1.08;
      const nextScale = Math.max(0.1, Math.min(5, st.canvasScale * (event.deltaY < 0 ? scaleBy : 1 / scaleBy)));
      const nextX = mouseX - (mouseX - st.canvasX) * (nextScale / st.canvasScale);
      const nextY = mouseY - (mouseY - st.canvasY) * (nextScale / st.canvasScale);
      st.setCanvasTransform(nextX, nextY, nextScale);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const selectedScreenBox = useMemo(() => {
    if (!selectedBox) return null;
    return {
      x: snapshotScreenX + selectedBox.x * state.canvasScale,
      y: snapshotScreenY + selectedBox.y * state.canvasScale,
      width: selectedBox.width * state.canvasScale,
      height: selectedBox.height * state.canvasScale,
    };
  }, [snapshotScreenX, snapshotScreenY, selectedBox, state.canvasScale]);

  useEffect(() => {
    const { width: cw, height: ch } = containerSize;
    if (cw === 0 || ch === 0) return;

    const hEl = hRulerRef.current;
    if (hEl) {
      if (hEl.width !== cw) hEl.width = cw;
      const ctx = hEl.getContext('2d');
      if (ctx) {
        ctx.clearRect(0, 0, cw, RULER_SIZE);
        ctx.fillStyle = RULER_BG;
        ctx.fillRect(0, 0, cw, RULER_SIZE);
        ctx.strokeStyle = RULER_TICK;
        ctx.beginPath();
        ctx.moveTo(0, RULER_SIZE - 1);
        ctx.lineTo(cw, RULER_SIZE - 1);
        ctx.stroke();

        if (selectedScreenBox) {
          ctx.fillStyle = RULER_SEL;
          ctx.fillRect(selectedScreenBox.x, 0, selectedScreenBox.width, RULER_SIZE);
          if (selectedScreenBox.width > 20 && selectedBox) {
            ctx.fillStyle = '#4C7EF3';
            ctx.font = 'bold 9px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(String(Math.round(selectedBox.width)), selectedScreenBox.x + selectedScreenBox.width / 2, RULER_SIZE - 3);
          }
        }

        ctx.fillStyle = RULER_TEXT;
        ctx.font = '9px sans-serif';
        ctx.textAlign = 'center';
        const step = state.canvasScale > 0.3 ? 100 : 200;
        const start = Math.floor(-state.canvasX / state.canvasScale / step) * step;
        const end = Math.ceil((cw - state.canvasX) / state.canvasScale / step) * step;
        for (let v = start; v <= end; v += step) {
          const sx = state.canvasX + v * state.canvasScale;
          if (sx < RULER_SIZE || sx > cw) continue;
          ctx.strokeStyle = RULER_TICK;
          ctx.beginPath();
          ctx.moveTo(sx, RULER_SIZE - 8);
          ctx.lineTo(sx, RULER_SIZE - 1);
          ctx.stroke();
          ctx.fillStyle = RULER_TEXT;
          ctx.fillText(String(v), sx, RULER_SIZE - 10);
        }
        if (mousePos) {
          const mx = state.canvasX + mousePos.x * state.canvasScale;
          ctx.fillStyle = RULER_MOUSE;
          ctx.fillRect(mx - 0.5, 0, 1, RULER_SIZE);
        }
      }
    }

    const vEl = vRulerRef.current;
    if (vEl) {
      if (vEl.height !== ch) vEl.height = ch;
      const ctx = vEl.getContext('2d');
      if (ctx) {
        ctx.clearRect(0, 0, RULER_SIZE, ch);
        ctx.fillStyle = RULER_BG;
        ctx.fillRect(0, 0, RULER_SIZE, ch);
        ctx.strokeStyle = RULER_TICK;
        ctx.beginPath();
        ctx.moveTo(RULER_SIZE - 1, 0);
        ctx.lineTo(RULER_SIZE - 1, ch);
        ctx.stroke();

        if (selectedScreenBox) {
          ctx.fillStyle = RULER_SEL;
          ctx.fillRect(0, selectedScreenBox.y, RULER_SIZE, selectedScreenBox.height);
          if (selectedScreenBox.height > 20 && selectedBox) {
            ctx.save();
            ctx.fillStyle = '#4C7EF3';
            ctx.font = 'bold 9px sans-serif';
            ctx.translate(RULER_SIZE / 2, selectedScreenBox.y + selectedScreenBox.height / 2);
            ctx.rotate(-Math.PI / 2);
            ctx.textAlign = 'center';
            ctx.fillText(String(Math.round(selectedBox.height)), 0, 3);
            ctx.restore();
          }
        }

        ctx.fillStyle = RULER_TEXT;
        ctx.font = '9px sans-serif';
        const step = state.canvasScale > 0.3 ? 100 : 200;
        const start = Math.floor(-state.canvasY / state.canvasScale / step) * step;
        const end = Math.ceil((ch - state.canvasY) / state.canvasScale / step) * step;
        for (let v = start; v <= end; v += step) {
          const sy = state.canvasY + v * state.canvasScale;
          if (sy < RULER_SIZE || sy > ch) continue;
          ctx.strokeStyle = RULER_TICK;
          ctx.beginPath();
          ctx.moveTo(RULER_SIZE - 8, sy);
          ctx.lineTo(RULER_SIZE - 1, sy);
          ctx.stroke();
          ctx.save();
          ctx.translate(RULER_SIZE - 10, sy + 3);
          ctx.rotate(-Math.PI / 2);
          ctx.textAlign = 'center';
          ctx.fillStyle = RULER_TEXT;
          ctx.fillText(String(v), 0, 0);
          ctx.restore();
        }
        if (mousePos) {
          const my = state.canvasY + mousePos.y * state.canvasScale;
          ctx.fillStyle = RULER_MOUSE;
          ctx.fillRect(0, my - 0.5, RULER_SIZE, 1);
        }
      }
    }
  }, [containerSize, mousePos, selectedBox, selectedScreenBox, state.canvasScale, state.canvasX, state.canvasY]);

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (isInteractiveTarget(event.target)) return;
    setError(null);

    const st = useEditorStore.getState();
    const point = clientToActiveLocal(event.clientX, event.clientY);

    if (annotationTool) {
      if (!point) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      if (annotationTool === 'arrow' || annotationTool === 'rect' || annotationTool === 'dimension') {
        annDraftRef.current = { startDesign: { x: point.worldX, y: point.worldY }, type: annotationTool };
        setPreviewDraft({
          type: annotationTool,
          startScreen: { x: point.screenX, y: point.screenY },
          currentScreen: { x: point.screenX, y: point.screenY },
          color: '#f38ba8',
        });
        return;
      }
      if (annotationTool === 'text' || annotationTool === 'number') {
        const id = st.addAnnotation(annotationTool, point.worldX, point.worldY);
        st.setSelectedAnnotationIds([id]);
        return;
      }
      if (annotationTool === 'flow-line') {
        const hit = hitNodeAtClient(event.clientX, event.clientY);
        if (!hit) {
          st.setAnnotationHint('请点击节点', 1600);
          return;
        }
        const srcId = st.flowLineDraftSrcId;
        if (!srcId) {
          st.setFlowLineDraftSrcId(hit.nodeId);
          st.setAnnotationHint('再点终点节点', 1200);
        } else if (srcId === hit.nodeId) {
          st.setAnnotationHint('终点不能和起点相同', 1600);
        } else {
          const id = st.addAnnotation('flow-line', point.worldX, point.worldY, {
            refNodeId: srcId,
            text: hit.nodeId,
            color: '#f9e2af',
          });
          st.setSelectedAnnotationIds([id]);
          st.setFlowLineDraftSrcId(null);
        }
        return;
      }
    }

    if ((event.button === 1 || st.sceneTool === 'hand' || spaceHeld.current) && event.buttons !== 0) {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      panRef.current = { isPanning: true, startX: event.clientX, startY: event.clientY };
      if (containerRef.current) containerRef.current.style.cursor = 'grabbing';
      return;
    }

    if (!point) return;

    if (st.tool !== 'select') {
      event.preventDefault();
      const x = Math.round(point.x - st.previewWidth / 2);
      const y = Math.round(st.previewHeight / 2 - point.y);
      const widgetType = st.tool === 'text' ? 'text' : 'frame';
      void createWidgetNodeOnBridge({
        widgetType,
        x,
        y,
        width: widgetType === 'text' ? 240 : 300,
        height: widgetType === 'text' ? 64 : 200,
        parentId: activeArtboard?.bridgeRootNodeId || undefined,
        name: widgetType === 'text' ? 'Text' : 'Frame',
      }).catch((err) => setError(err instanceof Error ? err.message : String(err)));
      st.setTool('select');
      return;
    }

    const hit = snapshot
      ? pickBboxAtPoint(snapshot.bboxes, point.x + snapshotViewport.x, point.y + snapshotViewport.y, activeArtboard?.bridgeRootNodeId)
      : null;
    if (!hit) {
      st.setSelectedIds([]);
      measureRef.current = { startX: event.clientX, startY: event.clientY, measuring: false };
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }

    const node = st.nodes[hit.nodeId];
    if (node?.locked) {
      measureRef.current = { startX: event.clientX, startY: event.clientY, measuring: false };
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    if ((event.shiftKey || event.ctrlKey || event.metaKey) && hit.nodeId) {
      const ids = st.selectedIds.includes(hit.nodeId)
        ? st.selectedIds.filter((id) => id !== hit.nodeId)
        : [...st.selectedIds, hit.nodeId];
      st.setSelectedIds(ids);
    } else {
      st.setSelectedIds([hit.nodeId]);
    }
    const now = Date.now();
    const prev = dblClickRef.current;
    if (prev && prev.nodeId === hit.nodeId && now - prev.time < 400 && node?.type === 'text') {
      dblClickRef.current = null;
      st.setEditingTextId(hit.nodeId);
      return;
    }
    dblClickRef.current = { nodeId: hit.nodeId, time: now };

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      nodeId: hit.nodeId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: node?.x ?? 0,
      startY: node?.y ?? 0,
      deltaX: 0,
      deltaY: 0,
    };
  }, [activeArtboard?.bridgeRootNodeId, annotationTool, clientToActiveLocal, hitNodeAtClient, snapshot, snapshotViewport.x, snapshotViewport.y]);

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const st = useEditorStore.getState();
    const world = clientToWorld(event.clientX, event.clientY);
    if (world) setMousePos({ x: world.x, y: world.y });

    if (annotationTool) {
      const point = clientToContainer(event.clientX, event.clientY);
      const draft = annDraftRef.current;
      if (point && draft) {
        setPreviewDraft({
          type: draft.type,
          startScreen: {
            x: st.canvasX + draft.startDesign.x * st.canvasScale,
            y: st.canvasY + draft.startDesign.y * st.canvasScale,
          },
          currentScreen: { x: point.x, y: point.y },
          color: '#f38ba8',
        });
      } else if (point && (annotationTool === 'text' || annotationTool === 'number')) {
        setPreviewDraft({
          type: annotationTool,
          currentScreen: { x: point.x, y: point.y },
          color: '#f38ba8',
        });
      } else if (point && annotationTool === 'flow-line' && st.flowLineDraftSrcId) {
        const hover = hitNodeAtClient(event.clientX, event.clientY);
        setPreviewDraft({
          type: 'flow-line',
          currentScreen: { x: point.x, y: point.y },
          flowLineSrcId: st.flowLineDraftSrcId,
          flowLineHoverDstId: hover && hover.nodeId !== st.flowLineDraftSrcId ? hover.nodeId : undefined,
          color: '#f9e2af',
        });
      } else if (annotationTool === 'flow-line') {
        setPreviewDraft((prev) => (prev ? null : prev));
      }
    }

    if (panRef.current?.isPanning) {
      const dx = event.clientX - panRef.current.startX;
      const dy = event.clientY - panRef.current.startY;
      panRef.current.startX = event.clientX;
      panRef.current.startY = event.clientY;
      st.setCanvasTransform(st.canvasX + dx, st.canvasY + dy, st.canvasScale);
      return;
    }

    if (transformRef.current) {
      const next = computeTransformPreview(transformRef.current, event.clientX, event.clientY, event.shiftKey);
      transformRef.current.latest = next;
      setTransformPreview(next);
      return;
    }

    if (guideDragRef.current) {
      const point = clientToContainer(event.clientX, event.clientY);
      if (point) {
        const screenPos = guideDragRef.current.axis === 'h' ? point.y : point.x;
        setGuideDragPos({ axis: guideDragRef.current.axis, screenPos });
      }
      return;
    }

    const drag = dragRef.current;
    if (drag && st.canvasScale > 0) {
      const dx = (event.clientX - drag.startClientX) / st.canvasScale;
      const dy = (event.clientY - drag.startClientY) / st.canvasScale;
      dragRef.current = { ...drag, deltaX: dx, deltaY: dy };
      setDragPreview({ nodeId: drag.nodeId, dx, dy });
      return;
    }

    if (measureRef.current) {
      const dx = event.clientX - measureRef.current.startX;
      const dy = event.clientY - measureRef.current.startY;
      if (!measureRef.current.measuring && (Math.abs(dx) + Math.abs(dy)) > 5) {
        measureRef.current.measuring = true;
      }
      if (measureRef.current.measuring) {
        setMeasureRect({
          sx: measureRef.current.startX,
          sy: measureRef.current.startY,
          ex: event.clientX,
          ey: event.clientY,
        });
      }
    }
  }, [annotationTool, clientToContainer, clientToWorld, hitNodeAtClient]);

  const handlePointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (panRef.current?.isPanning) {
      safeReleasePointerCapture(event.currentTarget, event.pointerId);
      panRef.current = null;
      if (containerRef.current) containerRef.current.style.cursor = spaceHeld.current ? 'grab' : '';
      return;
    }

    if (transformRef.current) {
      const session = transformRef.current;
      const next = computeTransformPreview(session, event.clientX, event.clientY, event.shiftKey);
      safeReleasePointerCapture(event.currentTarget, event.pointerId);
      transformRef.current = null;
      setTransformPreview(null);
      const st = useEditorStore.getState();
      const node = st.nodes[next.nodeId];
      if (!node) return;
      if (session.handle === 'rotate') {
        if (Math.round((node.rotation || 0) * 100) / 100 === Math.round(next.rotation * 100) / 100) return;
        ignoreNextNodeSyncRef.current += 1;
        st.updateNode(next.nodeId, { rotation: next.rotation });
        void syncNodeVisualDelta(node, { ...node, rotation: next.rotation }).catch((err) => setError(err instanceof Error ? err.message : String(err)));
        return;
      }
      if (session.handle === 'move' || session.handle === 'move-x' || session.handle === 'move-y') {
        if (node.x === next.nodeX && node.y === next.nodeY) return;
        ignoreNextNodeSyncRef.current += 1;
        st.moveNode(next.nodeId, next.nodeX, next.nodeY);
        void moveNodeOnBridge(next.nodeId, next.nodeX, next.nodeY, false).catch((err) => setError(err instanceof Error ? err.message : String(err)));
        return;
      }
      if (isResizeLikeHandle(session.handle)) {
        const moved = node.x !== next.nodeX || node.y !== next.nodeY;
        const resized = node.width !== next.nodeWidth || node.height !== next.nodeHeight;
        if (!moved && !resized) return;
        ignoreNextNodeSyncRef.current += (moved ? 1 : 0) + (resized ? 1 : 0);
        if (moved) st.moveNode(next.nodeId, next.nodeX, next.nodeY);
        if (resized) st.resizeNode(next.nodeId, next.nodeWidth, next.nodeHeight);
        void (async () => {
          if (moved && resized) await moveNodeOnBridge(next.nodeId, next.nodeX, next.nodeY, true);
          if (resized) await resizeNodeOnBridge(next.nodeId, next.nodeWidth, next.nodeHeight, false);
          else if (moved) await moveNodeOnBridge(next.nodeId, next.nodeX, next.nodeY, false);
        })().catch((err) => setError(err instanceof Error ? err.message : String(err)));
      }
      return;
    }

    if (annDraftRef.current) {
      const draft = annDraftRef.current;
      annDraftRef.current = null;
      setPreviewDraft(null);
      safeReleasePointerCapture(event.currentTarget, event.pointerId);
      const end = clientToWorld(event.clientX, event.clientY);
      if (!end) return;
      const st = useEditorStore.getState();
      const dx = end.x - draft.startDesign.x;
      const dy = end.y - draft.startDesign.y;
      const designMin = 4 / Math.max(0.1, st.canvasScale);
      if (Math.abs(dx) < designMin && Math.abs(dy) < designMin) return;
      const id = draft.type === 'arrow' || draft.type === 'dimension'
        ? st.addAnnotation(draft.type, draft.startDesign.x, draft.startDesign.y, {
            width: dx,
            height: dy,
            points: [{ x: 0, y: 0 }, { x: dx, y: dy }],
          })
        : st.addAnnotation(draft.type, Math.min(draft.startDesign.x, end.x), Math.min(draft.startDesign.y, end.y), {
            width: Math.abs(dx),
            height: Math.abs(dy),
          });
      st.setSelectedAnnotationIds([id]);
      return;
    }

    if (dragRef.current) {
      const drag = dragRef.current;
      safeReleasePointerCapture(event.currentTarget, event.pointerId);
      dragRef.current = null;
      setDragPreview(null);
      const x = Math.round(drag.startX + drag.deltaX);
      const y = Math.round(drag.startY - drag.deltaY);
      ignoreNextNodeSyncRef.current += 1;
      useEditorStore.getState().moveNode(drag.nodeId, x, y);
      void moveNodeOnBridge(drag.nodeId, x, y, false).catch((err) => setError(err instanceof Error ? err.message : String(err)));
      return;
    }

    if (measureRef.current) {
      const measure = measureRef.current;
      safeReleasePointerCapture(event.currentTarget, event.pointerId);
      measureRef.current = null;
      setMeasureRect(null);
      if (measure.measuring && snapshot) {
        const start = clientToActiveLocal(measure.startX, measure.startY);
        const end = clientToActiveLocal(event.clientX, event.clientY);
        if (start && end) {
          const left = Math.min(start.x, end.x);
          const right = Math.max(start.x, end.x);
          const top = Math.min(start.y, end.y);
          const bottom = Math.max(start.y, end.y);
          const st = useEditorStore.getState();
          const hits = pickBboxesInRect(snapshot.bboxes, {
            left: left + snapshotViewport.x,
            right: right + snapshotViewport.x,
            top: top + snapshotViewport.y,
            bottom: bottom + snapshotViewport.y,
          }, st.nodes, activeArtboard?.bridgeRootNodeId);
          if (event.shiftKey) {
            const merged = [...st.selectedIds];
            for (const id of hits) {
              const index = merged.indexOf(id);
              if (index >= 0) merged.splice(index, 1);
              else merged.push(id);
            }
            st.setSelectedIds(merged);
          } else {
            st.setSelectedIds(hits);
          }
          if (hits.length > 0) st.revealSelectedInLayer();
        }
      }
    }
  }, [activeArtboard?.bridgeRootNodeId, clientToActiveLocal, clientToWorld, snapshot, snapshotViewport.x, snapshotViewport.y]);

  const handlePointerCancel = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    safeReleasePointerCapture(event.currentTarget, event.pointerId);
    dragRef.current = null;
    transformRef.current = null;
    measureRef.current = null;
    panRef.current = null;
    annDraftRef.current = null;
    setDragPreview(null);
    setTransformPreview(null);
    setMeasureRect(null);
    setPreviewDraft(null);
    if (containerRef.current) containerRef.current.style.cursor = '';
  }, []);

  const handleMouseLeave = useCallback(() => {
    setMousePos(null);
    if (!annDraftRef.current) setPreviewDraft(null);
  }, []);

  return (
    <div
      ref={containerRef}
      data-canvas-container
      className="canvas-area relative flex-1 overflow-hidden bg-[#181825]"
      data-scene-tool={state.sceneTool}
      style={annotationTool ? { cursor: 'crosshair' } : undefined}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onMouseLeave={handleMouseLeave}
    >
      <div
        className="pointer-events-none absolute bg-[#162d3f] shadow-2xl"
        style={{ left: screenX, top: screenY, width: screenW, height: screenH }}
      />
      {snapshotUrl ? (
        <div
          className="pointer-events-none absolute"
          style={{ left: snapshotScreenX, top: snapshotScreenY, width: snapshotImageW, height: snapshotImageH }}
        >
          <img
            src={snapshotUrl}
            alt=""
            className="h-full w-full select-none object-fill"
            draggable={false}
            style={{ filter: state.grayscaleMode ? 'grayscale(1)' : undefined }}
          />
        </div>
      ) : (
        <div
          className="absolute bg-[#162d3f] shadow-2xl"
          style={{ left: screenX, top: screenY, width: screenW, height: screenH }}
        >
          <div className="flex h-full w-full items-center justify-center text-sm text-[#a6adc8]">
            {loading ? '正在读取 Unity 临时 Prefab...' : (emptyLocalArtboard ? '空画板' : '等待 Unity Bridge 截图')}
          </div>
        </div>
      )}
      <div
        className="pointer-events-none absolute border border-[#89b4fa]/70 shadow-[0_0_0_1px_rgba(0,0,0,0.35)]"
        style={{ left: screenX, top: screenY, width: screenW, height: screenH }}
      />

      {selectedBoxes.map((box: BboxRecord) => {
        const offset = dragPreview?.nodeId === box.nodeId ? dragPreview : null;
        const t = transformPreview?.nodeId === box.nodeId ? transformPreview : null;
        const localX = t ? t.boxX : box.x + (offset?.dx ?? 0);
        const localY = t ? t.boxY : box.y + (offset?.dy ?? 0);
        const localW = t ? t.boxWidth : box.width;
        const localH = t ? t.boxHeight : box.height;
        const isPrimary = box.nodeId === selectedId;
        const locked = !!state.nodes[box.nodeId]?.locked;
        const showMoveGizmo = !locked && isPrimary && (state.sceneTool === 'move' || state.sceneTool === 'transform');
        const showRotateGizmo = !locked && isPrimary && (state.sceneTool === 'rotate' || state.sceneTool === 'transform');
        const showRectHandles = !locked && isPrimary && (state.sceneTool === 'rect' || state.sceneTool === 'transform');
        const showScaleHandles = !locked && isPrimary && (state.sceneTool === 'scale' || state.sceneTool === 'transform');
        const screenBoxW = Math.max(1, localW * state.canvasScale);
        const screenBoxH = Math.max(1, localH * state.canvasScale);
        const centerX = screenBoxW / 2;
        const centerY = screenBoxH / 2;
        const rectHandles: RectHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
        const scaleHandles: ('nw' | 'ne' | 'se' | 'sw')[] = ['nw', 'ne', 'se', 'sw'];
        return (
          <div
            key={box.nodeId}
            data-overlay-root
            data-node-id={box.nodeId}
            className="pointer-events-none absolute"
            style={{
              left: snapshotScreenX + localX * state.canvasScale,
              top: snapshotScreenY + localY * state.canvasScale,
              width: screenBoxW,
              height: screenBoxH,
              transform: t && state.sceneTool === 'rotate' ? `rotate(${t.rotation}deg)` : undefined,
              transformOrigin: 'center center',
            }}
          >
            <div
              className="absolute inset-0 border-2"
              style={{ borderColor: locked ? '#f38ba8' : SELECTION_COLOR, background: locked ? 'rgba(243,139,168,0.08)' : SELECTION_FILL }}
            />
            {locked && (
              <div className="absolute -right-1 -top-5 rounded bg-[#f38ba8] px-1.5 py-0.5 text-[10px] font-semibold text-[#1e1e2e]">
                锁定
              </div>
            )}

            {showMoveGizmo && (
              <svg
                className="absolute overflow-visible"
                style={{
                  left: centerX - AXIS_LEN,
                  top: centerY - AXIS_LEN,
                  width: AXIS_LEN * 2,
                  height: AXIS_LEN * 2,
                  pointerEvents: 'none',
                }}
              >
                <line x1={AXIS_LEN} y1={AXIS_LEN} x2={AXIS_LEN * 2 - 10} y2={AXIS_LEN} stroke="#E05555" strokeWidth="2.5" />
                <polygon points={`${AXIS_LEN * 2},${AXIS_LEN} ${AXIS_LEN * 2 - 10},${AXIS_LEN - 5} ${AXIS_LEN * 2 - 10},${AXIS_LEN + 5}`} fill="#E05555" />
                <rect
                  data-testid="transform-handle-move-x"
                  data-drag-handle="move-x"
                  x={AXIS_LEN + 4}
                  y={AXIS_LEN - AXIS_HIT / 2}
                  width={AXIS_LEN - 4}
                  height={AXIS_HIT}
                  fill="transparent"
                  style={{ cursor: 'ew-resize', pointerEvents: 'auto' }}
                  onPointerDown={(event) => beginTransform(event, box, 'move-x')}
                />
                <line x1={AXIS_LEN} y1={AXIS_LEN} x2={AXIS_LEN} y2={10} stroke="#7EC850" strokeWidth="2.5" />
                <polygon points={`${AXIS_LEN},0 ${AXIS_LEN - 5},10 ${AXIS_LEN + 5},10`} fill="#7EC850" />
                <rect
                  data-testid="transform-handle-move-y"
                  data-drag-handle="move-y"
                  x={AXIS_LEN - AXIS_HIT / 2}
                  y={0}
                  width={AXIS_HIT}
                  height={AXIS_LEN - 4}
                  fill="transparent"
                  style={{ cursor: 'ns-resize', pointerEvents: 'auto' }}
                  onPointerDown={(event) => beginTransform(event, box, 'move-y')}
                />
                <rect
                  data-testid="transform-handle-move"
                  data-drag-handle="move"
                  x={AXIS_LEN - 5}
                  y={AXIS_LEN - 5}
                  width={10}
                  height={10}
                  rx={1}
                  fill="#F5C542"
                  style={{ cursor: 'move', pointerEvents: 'auto' }}
                  onPointerDown={(event) => beginTransform(event, box, 'move')}
                />
              </svg>
            )}

            {showRotateGizmo && (() => {
              const radius = Math.max(screenBoxW, screenBoxH) / 2 + ROTATE_PAD;
              const size = radius * 2 + 16;
              return (
                <svg
                  className="absolute overflow-visible"
                  style={{
                    left: centerX - radius - 8,
                    top: centerY - radius - 8,
                    width: size,
                    height: size,
                    pointerEvents: 'none',
                  }}
                >
                  <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke={SELECTION_COLOR} strokeWidth={2} opacity={0.65} />
                  <circle
                    data-testid="transform-handle-rotate"
                    data-drag-handle="rotate"
                    cx={size / 2}
                    cy={size / 2}
                    r={radius}
                    fill="none"
                    stroke="transparent"
                    strokeWidth={16}
                    style={{ cursor: 'crosshair', pointerEvents: 'auto' }}
                    onPointerDown={(event) => beginTransform(event, box, 'rotate')}
                  />
                </svg>
              );
            })()}

            {showRectHandles && rectHandles.map((handle) => (
              <div
                key={handle}
                data-testid={`transform-handle-rect-${handle}`}
                data-drag-handle={handle}
                className="absolute rounded-full bg-[#4C7EF3] shadow-[0_0_0_1.5px_#fff,0_1px_3px_rgba(0,0,0,0.3)]"
                style={{ ...rectHandleStyle(handle, localW, localH, state.canvasScale), pointerEvents: 'auto' }}
                onPointerDown={(event) => beginTransform(event, box, handle)}
              />
            ))}

            {showScaleHandles && scaleHandles.map((handle) => (
              <div
                key={`scale-${handle}`}
                data-testid={`transform-handle-scale-${handle}`}
                data-drag-handle={`scale-${handle}`}
                className="absolute bg-[#4C7EF3] shadow-[0_0_0_1.5px_#fff,0_1px_3px_rgba(0,0,0,0.3)]"
                style={{
                  ...rectHandleStyle(handle, localW, localH, state.canvasScale),
                  transform: 'rotate(45deg)',
                  pointerEvents: 'auto',
                }}
                onPointerDown={(event) => beginTransform(event, box, `scale-${handle}`)}
              />
            ))}
          </div>
        );
      })}

      <div className="pointer-events-none absolute inset-0 z-20">
        <AnnotationOverlay
          offsetX={state.canvasX}
          offsetY={state.canvasY}
          scale={state.canvasScale}
          effectiveW={state.previewWidth}
          effectiveH={state.previewHeight}
          previewDraft={previewDraft ?? undefined}
        />
      </div>

      {editingTextId && (
        <div className="pointer-events-none absolute inset-0 z-30">
          <TextInlineEditor nodeId={editingTextId} />
        </div>
      )}

      {measureRect && (() => {
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return null;
        const left = Math.min(measureRect.sx, measureRect.ex) - rect.left;
        const top = Math.min(measureRect.sy, measureRect.ey) - rect.top;
        const width = Math.abs(measureRect.ex - measureRect.sx);
        const height = Math.abs(measureRect.ey - measureRect.sy);
        const designW = Math.round(width / state.canvasScale);
        const designH = Math.round(height / state.canvasScale);
        if (width < 2 && height < 2) return null;
        return (
          <div className="pointer-events-none absolute z-30" style={{ left, top, width, height }}>
            <div className="absolute inset-0 border border-dashed border-[#f38ba8] bg-[#f38ba8]/10" />
            {designW > 0 && (
              <div
                className="absolute left-1/2 top-[-20px] -translate-x-1/2 rounded bg-[#f38ba8] px-1.5 py-0.5 text-[11px] font-semibold text-[#1e1e2e]"
              >
                {designW}px
              </div>
            )}
            {designH > 0 && (
              <div
                className="absolute right-[-42px] top-1/2 -translate-y-1/2 rounded bg-[#f38ba8] px-1.5 py-0.5 text-[11px] font-semibold text-[#1e1e2e]"
              >
                {designH}px
              </div>
            )}
          </div>
        );
      })()}

      <ArtboardsOverlay />
      <ArtboardSidebarOverlay />

      <div
        data-canvas-ui
        className="absolute left-1/2 z-40 flex -translate-x-1/2 items-center gap-1 rounded-lg border border-[#313244] bg-[#1e1e2e]/90 px-2 py-1 backdrop-blur"
        style={{ top: RULER_SIZE + 6 }}
      >
        {([
          { key: 'select' as const, label: '选择', icon: '⊹' },
          { key: 'frame' as const, label: '矩形', icon: '▢' },
          { key: 'text' as const, label: '文字', icon: 'T' },
        ]).map((tool) => (
          <button
            key={tool.key}
            data-testid={`canvas-tool-${tool.key}`}
            onClick={() => useEditorStore.getState().setTool(tool.key)}
            className={`rounded px-3 py-1 text-xs transition-colors ${
              state.tool === tool.key ? 'bg-[#89b4fa] text-[#1e1e2e]' : 'text-[#a6adc8] hover:bg-[#313244]'
            }`}
            title={tool.label}
          >
            {tool.icon} {tool.label}
          </button>
        ))}
        <span className="h-4 w-px bg-[#45475a]" />
        <select
          value={`${state.previewWidth}x${state.previewHeight}`}
          onChange={(event) => {
            const [w, h] = event.target.value.split('x').map(Number);
            useEditorStore.getState().setPreviewResolution(w, h);
            void refreshActiveBridgeSnapshot(w, h).catch((err) => setError(err instanceof Error ? err.message : String(err)));
          }}
          className="rounded border border-[#45475a] bg-[#313244] px-1.5 py-1 text-[13px] text-[#cdd6f4] outline-none"
          title="预览分辨率"
        >
          {RESOLUTION_PRESETS.map((r) => (
            <option key={r.label} value={`${r.w}x${r.h}`}>{r.label}</option>
          ))}
        </select>
        <span className="h-4 w-px bg-[#45475a]" />
        <button
          onClick={() => {
            const st = useEditorStore.getState();
            const id = st.addArtboard();
            const nextState = useEditorStore.getState();
            const nextPage = nextState.pages.find((item) => item.id === nextState.activePageId);
            const newArtboard = nextPage?.artboards.find((item) => item.id === id);
            const rect = containerRef.current?.getBoundingClientRect();
            if (newArtboard && rect) {
              const targetCanvasX = rect.width / 2 - (newArtboard.x + st.previewWidth / 2) * st.canvasScale;
              const targetCanvasY = rect.height / 2 - (newArtboard.y + st.previewHeight / 2) * st.canvasScale;
              st.setCanvasTransform(targetCanvasX, targetCanvasY, st.canvasScale);
            }
          }}
          title="新建画板"
          className="rounded px-2 py-1 text-xs text-[#a6e3a1] transition-colors hover:bg-[#313244]"
        >
          + 画板
        </button>
        <span className="h-4 w-px bg-[#45475a]" />
        <button
          onClick={() => useEditorStore.getState().setAnnotationTool('arrow')}
          title="进入批注模式"
          className={`rounded px-2 py-1 text-xs transition-colors ${
            state.annotationTool ? 'bg-[#cba6f7] text-[#1e1e2e]' : 'text-[#cba6f7] hover:bg-[#313244]'
          }`}
        >
          批注
        </button>
        <button
          onClick={() => useEditorStore.getState().toggleAnnotationLayer()}
          title={state.annotationLayerVisible ? '隐藏批注层' : '显示批注层'}
          className={`rounded px-2 py-1 text-sm transition-colors ${
            state.annotationLayerVisible ? 'text-[#a6adc8] hover:bg-[#313244]' : 'text-[#6c7086] hover:bg-[#313244]'
          }`}
        >
          {state.annotationLayerVisible ? '眼' : '隐'}
        </button>
        <button
          onClick={() => useEditorStore.getState().toggleGrayscaleMode()}
          title={state.grayscaleMode ? '关闭灰度模式' : '画布灰度化'}
          className={`rounded px-2 py-1 text-sm transition-colors ${
            state.grayscaleMode ? 'bg-[#45475a] text-[#cdd6f4]' : 'text-[#a6adc8] hover:bg-[#313244]'
          }`}
        >
          ◐
        </button>
        <button
          onClick={() => setAnnListOpen(true)}
          title="批注列表"
          className="rounded px-2 py-1 text-xs text-[#a6adc8] transition-colors hover:bg-[#313244]"
        >
          列表
        </button>
        <span className="h-4 w-px bg-[#45475a]" />
        <button
          onClick={() => useEditorStore.getState().toggleRulers()}
          title={state.rulersVisible ? '隐藏标尺' : '显示标尺'}
          className={`rounded px-2 py-1 text-xs transition-colors ${
            state.rulersVisible ? 'text-[#a6adc8] hover:bg-[#313244]' : 'text-[#6c7086] hover:bg-[#313244]'
          }`}
        >
          标尺
        </button>
        <button
          onClick={downloadSnapshot}
          className="rounded px-2 py-1 text-xs text-[#a6adc8] transition-colors hover:bg-[#313244]"
          title="下载当前 Bridge 截图"
        >
          截图
        </button>
        <button
          onClick={() => setUeExportOpen(true)}
          className="rounded px-2 py-1 text-xs text-[#a6adc8] transition-colors hover:bg-[#313244]"
          title="导出评审图"
        >
          导出
        </button>
        <AnnotationModeBar />
      </div>

      <SceneToolbar onAlign={alignNodes} />

      {annListOpen && <AnnotationListDialog onClose={() => setAnnListOpen(false)} />}
      {ueExportOpen && <UEExportDialog onClose={() => setUeExportOpen(false)} />}

      {state.rulersVisible && (
        <canvas
          ref={hRulerRef}
          className="absolute left-0 top-0 z-40"
          width={containerSize.width}
          height={RULER_SIZE}
          style={{ width: containerSize.width, height: RULER_SIZE, cursor: 'ns-resize' }}
          onPointerDown={(event) => {
            event.preventDefault();
            guideDragRef.current = { axis: 'h', startClientPos: event.clientY };
          }}
        />
      )}
      {state.rulersVisible && (
        <canvas
          ref={vRulerRef}
          className="absolute left-0 top-0 z-40"
          width={RULER_SIZE}
          height={containerSize.height}
          style={{ width: RULER_SIZE, height: containerSize.height, cursor: 'ew-resize' }}
          onPointerDown={(event) => {
            event.preventDefault();
            guideDragRef.current = { axis: 'v', startClientPos: event.clientX };
          }}
        />
      )}
      {state.rulersVisible && (
        <div
          className="pointer-events-none absolute left-0 top-0 z-40"
          style={{
            width: RULER_SIZE,
            height: RULER_SIZE,
            background: RULER_BG,
            borderRight: `1px solid ${RULER_TICK}`,
            borderBottom: `1px solid ${RULER_TICK}`,
          }}
        />
      )}

      {guides.map((guide) => {
        const screenPos = guide.axis === 'h'
          ? state.canvasY + guide.designPos * state.canvasScale
          : state.canvasX + guide.designPos * state.canvasScale;
        return (
          <div
            key={guide.id}
            className="absolute z-[35]"
            style={guide.axis === 'h' ? {
              left: 0,
              right: 0,
              top: screenPos,
              height: 0,
              borderTop: '1px solid #00d4aa',
              cursor: 'ns-resize',
              pointerEvents: 'auto',
              padding: '3px 0',
              marginTop: -3,
            } : {
              top: 0,
              bottom: 0,
              left: screenPos,
              width: 0,
              borderLeft: '1px solid #00d4aa',
              cursor: 'ew-resize',
              pointerEvents: 'auto',
              padding: '0 3px',
              marginLeft: -3,
            }}
            onPointerDown={(event) => {
              event.stopPropagation();
              event.preventDefault();
              guideDragRef.current = {
                axis: guide.axis,
                existingId: guide.id,
                startClientPos: guide.axis === 'h' ? event.clientY : event.clientX,
              };
            }}
          >
            <span
              className="absolute select-none rounded px-1 text-[11px] font-semibold"
              style={{
                background: '#00d4aa',
                color: '#1e1e2e',
                whiteSpace: 'nowrap',
                ...(guide.axis === 'h'
                  ? { left: RULER_SIZE + 2, top: -8 }
                  : { top: RULER_SIZE + 2, left: -12, writingMode: 'vertical-lr' }),
              }}
            >
              {Math.round(guide.designPos)}
            </span>
          </div>
        );
      })}

      {guideDragPos && (() => {
        const designPos = guideDragPos.axis === 'h'
          ? Math.round((guideDragPos.screenPos - state.canvasY) / state.canvasScale)
          : Math.round((guideDragPos.screenPos - state.canvasX) / state.canvasScale);
        return (
          <div
            className="pointer-events-none absolute z-[35]"
            style={guideDragPos.axis === 'h' ? {
              left: 0,
              right: 0,
              top: guideDragPos.screenPos,
              height: 0,
              borderTop: '1px dashed #00d4aa',
              opacity: 0.7,
            } : {
              top: 0,
              bottom: 0,
              left: guideDragPos.screenPos,
              width: 0,
              borderLeft: '1px dashed #00d4aa',
              opacity: 0.7,
            }}
          >
            <span
              className="absolute select-none whitespace-nowrap rounded px-1.5 py-0.5 text-[12px] font-semibold"
              style={{
                background: '#00d4aa',
                color: '#1e1e2e',
                ...(guideDragPos.axis === 'h'
                  ? { left: RULER_SIZE + 4, top: 4 }
                  : { top: RULER_SIZE + 4, left: 4 }),
              }}
            >
              {designPos}px
            </span>
          </div>
        );
      })()}

      {mousePos && (
        <div data-canvas-ui className="absolute bottom-3 left-3 z-40 rounded bg-[#1e1e2e] px-2 py-1 text-[12px] text-[#6c7086]">
          X: {Math.round(mousePos.x)} &nbsp; Y: {Math.round(mousePos.y)}
        </div>
      )}

      <div data-canvas-ui className="absolute bottom-3 right-3 z-40 rounded bg-[#1e1e2e] px-2 py-1 text-xs text-[#6c7086]">
        {Math.round(state.canvasScale * 100)}%
      </div>

      {(error || activeArtboard?.bridgeStatus) && (
        <div data-canvas-ui className="absolute bottom-12 left-3 z-40 rounded bg-[#1e1e2e]/95 px-3 py-1 text-xs text-[#cdd6f4] shadow">
          {error || activeArtboard?.bridgeStatus}
        </div>
      )}
    </div>
  );
}

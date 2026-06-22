/**
 * SelectionOverlay — 选中节点的 HTML/SVG 覆盖层
 * 在 Unity WebGL 画布上方绘制 resize 手柄和边框（仿 Unity Scene Gizmo 效果）
 * 根据 sceneTool 显示不同手柄组合：
 *   move   → 红绿十字轴箭头 + 中心方块
 *   rotate → 蓝色大圆环
 *   scale  → 四角菱形
 *   rect   → 圆形角+边手柄
 *   transform → 全部
 */
import { useCallback, useRef, useEffect, useState } from 'react';
import type { NodeBounds } from '../../services/UnityBridge';
import type { SceneTool } from '../../types';
import { useEditorStore } from '../../stores/editorStore';
import { beginInteractiveSync, endInteractiveSync } from '../../services/StoreSync';
import { exportSingleNodeForUnity } from '../../utils/exportJson';
import unityBridge from '../../services/UnityBridge';
import { deepDuplicateNode } from '../../App';

interface SelectionOverlayProps {
  bounds: NodeBounds[];
  pixelScale: number;
  canvasOffset: { x: number; y: number };
  sceneTool: SceneTool;
}

// ---- 视觉常量 ----
const CORNER_SIZE = 10;
const EDGE_SIZE = 8;
const CORNER_HALF = CORNER_SIZE / 2;
const EDGE_HALF = EDGE_SIZE / 2;
const SELECTION_COLOR = '#4C7EF3';
const SELECTION_FILL = 'rgba(76,126,243,0.06)';

// Move gizmo
const AXIS_LEN = 60;       // 轴箭头长度 (px)
const AXIS_WIDTH = 2.5;    // 轴线宽
const ARROW_SIZE = 10;     // 箭头三角大小
const CENTER_SIZE = 8;     // 中心方块
const CENTER_HALF = CENTER_SIZE / 2;
const AXIS_HIT_WIDTH = 12; // 轴可点击宽度（px）
const COLOR_X = '#E05555';  // 红
const COLOR_Y = '#7EC850';  // 绿
const COLOR_FREE = '#F5C542'; // 黄

// Rotate gizmo
const ROTATE_PAD = 30;     // 圆环超出选中框的距离
const ROTATE_STROKE = 2;
const ROTATE_HIT_WIDTH = 14; // 圆环可点击宽度

// 缩放菱形手柄
const SCALE_SIZE = 10;

type HandlePosition = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
type DragHandle =
  | HandlePosition
  | 'move' | 'move-x' | 'move-y'
  | 'rotate'
  | `scale-${'nw' | 'ne' | 'se' | 'sw'}`;

const HANDLE_CURSORS: Record<HandlePosition, string> = {
  nw: 'nw-resize', n: 'n-resize', ne: 'ne-resize',
  w: 'w-resize', e: 'e-resize',
  sw: 'sw-resize', s: 's-resize', se: 'se-resize',
};

const CORNER_HANDLES: HandlePosition[] = ['nw', 'ne', 'se', 'sw'];
const EDGE_HANDLES: HandlePosition[] = ['n', 'e', 's', 'w'];
const SCALE_CORNERS: ('nw' | 'ne' | 'se' | 'sw')[] = ['nw', 'ne', 'se', 'sw'];

const SCALE_ANCHOR: Record<string, 'nw' | 'ne' | 'se' | 'sw'> = {
  'scale-se': 'nw', 'scale-sw': 'ne', 'scale-ne': 'sw', 'scale-nw': 'se',
};

export default function SelectionOverlay({ bounds, pixelScale, canvasOffset, sceneTool }: SelectionOverlayProps) {
  // 拖动期间用 baseline(Unity 给的精确屏幕坐标) + store delta 算实时位置，避免等 Unity 回传
  // null 时直接用 props.bounds（非拖动状态）
  const [adjustedBounds, setAdjustedBounds] = useState<NodeBounds[] | null>(null);
  // 用 ref 镜像最新 props（PointerDown 闭包要读最新 bounds 抓 baseline）
  const latestBoundsRef = useRef<NodeBounds[]>(bounds);
  latestBoundsRef.current = bounds;
  const latestPixelScaleRef = useRef<number>(pixelScale);
  latestPixelScaleRef.current = pixelScale;
  const baselineRef = useRef<{
    bounds: Map<string, NodeBounds>;
    states: Map<string, { x: number; y: number; width: number; height: number }>;
    pixelScale: number;
  } | null>(null);
  const dragRef = useRef<{
    handle: DragHandle;
    startX: number;
    startY: number;
    nodeId: string;
    origBounds: NodeBounds;
    startAngle?: number;
    initialRotation?: number;
    centerX?: number;
    centerY?: number;
    anchorX?: number;
    anchorY?: number;
    initialWidth?: number;
    initialHeight?: number;
    initialDist?: number;
    initialNodeX?: number;
    initialNodeY?: number;
  } | null>(null);

  const pushHistory = useEditorStore((s) => s.pushHistory);

  const getInteractionPixelScale = useCallback(() => {
    const scale = baselineRef.current?.pixelScale ?? latestPixelScaleRef.current;
    return scale > 0 ? scale : 1;
  }, []);

  /**
   * 增量同步指定节点到 Unity（拖动期间使用，避开 fullSync 整页开销）
   */
  const pushIncrementalUpdate = useCallback((nodeIds: string[]) => {
    const st = useEditorStore.getState();
    const page = st.pages.find((p) => p.id === st.activePageId);
    if (!page) return;
    const artboard = page.artboards.find((a) => a.id === st.activeArtboardId);
    if (!artboard) return;
    // active 画板用顶层镜像 nodes（最新值），其他画板用 artboard.nodes（拖动只动 active 画板，但保险写法）
    const useNodes = st.nodes;
    for (const id of nodeIds) {
      const json = exportSingleNodeForUnity(id, useNodes, artboard.id, st.previewWidth, st.previewHeight);
      if (json) unityBridge.updateNode(json);
    }
  }, []);

  /**
   * 根据 baseline + store 当前状态算实时 bounds（拖动期间使用）
   * 公式：adjusted.x = baseline.x + (currentStore.x - baselineStore.x) * pixelScale
   * 静态偏差（anchor/pivot/dpr/camera 投影）全部由 baseline 继承，只算 delta，必然准确
   */
  const recomputeAdjustedBounds = useCallback(() => {
    const baseline = baselineRef.current;
    if (!baseline) return;
    const st = useEditorStore.getState();
    const ids = st.selectedIds;
    const out: NodeBounds[] = [];
    for (const id of ids) {
      const baseBound = baseline.bounds.get(id);
      const baseState = baseline.states.get(id);
      const curNode = st.nodes[id];
      if (!baseBound || !baseState || !curNode) continue;
      const dx = (curNode.x - baseState.x) * baseline.pixelScale;
      const dy = (curNode.y - baseState.y) * baseline.pixelScale;
      const dw = (curNode.width - baseState.width) * baseline.pixelScale;
      const dh = (curNode.height - baseState.height) * baseline.pixelScale;
      out.push({
        id,
        x: baseBound.x + dx,
        y: baseBound.y + dy,
        width: baseBound.width + dw,
        height: baseBound.height + dh,
      });
    }
    setAdjustedBounds(out);
  }, []);

  // ======== window 级别拖拽 — 不受 DOM 重渲染影响 ========
  const onWindowPointerMove = useCallback((e: PointerEvent) => {
    if (!dragRef.current) return;
    const { handle, startX, startY, nodeId } = dragRef.current;
    const state = useEditorStore.getState();
    const node = state.nodes[nodeId];
    if (!node) return;

    // 旋转
    if (handle === 'rotate') {
      const { startAngle, initialRotation, centerX, centerY } = dragRef.current;
      const currentAngle = Math.atan2(e.clientY - centerY!, e.clientX - centerX!);
      let deltaDeg = (currentAngle - startAngle!) * (180 / Math.PI);
      if (e.shiftKey) {
        const total = initialRotation! + deltaDeg;
        deltaDeg = Math.round(total / 15) * 15 - initialRotation!;
      }
      state.updateNode(nodeId, { rotation: initialRotation! + deltaDeg });
      pushIncrementalUpdate([nodeId]);
      recomputeAdjustedBounds();
      return;
    }

    // 等比缩放
    if (handle.startsWith('scale-')) {
      const { anchorX, anchorY, initialWidth, initialHeight, initialDist, initialNodeX, initialNodeY } = dragRef.current;
      const currentDist = Math.sqrt((e.clientX - anchorX!) ** 2 + (e.clientY - anchorY!) ** 2);
      const factor = currentDist / initialDist!;
      const newW = Math.max(1, Math.round(initialWidth! * factor));
      const newH = Math.max(1, Math.round(initialHeight! * factor));
      const corner = handle.replace('scale-', '');
      let newX = initialNodeX!, newY = initialNodeY!;
      if (corner.includes('w')) newX = initialNodeX! + (initialWidth! - newW);
      if (corner.includes('n')) newY = initialNodeY! + (initialHeight! - newH);
      state.moveNode(nodeId, newX, newY);
      state.resizeNode(nodeId, newW, newH);
      pushIncrementalUpdate([nodeId]);
      recomputeAdjustedBounds();
      return;
    }

    // 移动（自由 / 轴约束）
    const scale = getInteractionPixelScale();
    const rawDx = (e.clientX - startX) / scale;
    const rawDy = (e.clientY - startY) / scale;

    if (handle === 'move' || handle === 'move-x' || handle === 'move-y') {
      const dx = handle === 'move-y' ? 0 : rawDx;
      const dy = handle === 'move-x' ? 0 : rawDy;
      // 批量移动：如果拖拽节点在多选集合中，所有选中节点一起移动
      const sids = state.selectedIds;
      const movedIds: string[] = [];
      if (sids.length > 1 && sids.includes(nodeId)) {
        for (const sid of sids) {
          const sn = state.nodes[sid];
          if (sn) {
            state.moveNode(sid, sn.x + dx, sn.y + dy);
            movedIds.push(sid);
          }
        }
      } else {
        state.moveNode(nodeId, node.x + dx, node.y + dy);
        movedIds.push(nodeId);
      }
      pushIncrementalUpdate(movedIds);
      recomputeAdjustedBounds();
      dragRef.current.startX = e.clientX;
      dragRef.current.startY = e.clientY;
      return;
    }

    // Rect resize — 基于初始尺寸+总位移
    //   Shift: 角手柄锁定宽高比
    //   Alt:   以中心点缩放(对边对称变化),不按 Alt 时锚定对角/对边
    const initW = dragRef.current.initialWidth ?? node.width;
    const initH = dragRef.current.initialHeight ?? node.height;
    const initX = dragRef.current.initialNodeX ?? node.x;
    const initY = dragRef.current.initialNodeY ?? node.y;
    const totalDx = (e.clientX - startX) / scale;
    const totalDy = (e.clientY - startY) / scale;
    // Alt: 中心点缩放——一侧变化量在另一侧对称镜像,即总尺寸变化翻倍,中心不动
    const altMul = e.altKey ? 2 : 1;
    let newW = initW, newH = initH;
    let newX = initX, newY = initY;
    if (handle.includes('e')) newW = Math.max(1, initW + totalDx * altMul);
    if (handle.includes('w')) { newW = Math.max(1, initW - totalDx * altMul); newX = initX + (initW - newW) / (e.altKey ? 2 : 1); }
    if (handle.includes('s')) newH = Math.max(1, initH + totalDy * altMul);
    if (handle.includes('n')) { newH = Math.max(1, initH - totalDy * altMul); newY = initY + (initH - newH) / (e.altKey ? 2 : 1); }
    // Alt 模式下,纯东/南手柄也需要把节点反向偏移,保持中心不动
    if (e.altKey) {
      if (handle === 'e' || handle === 'se' || handle === 'ne') newX = initX - (newW - initW) / 2;
      if (handle === 's' || handle === 'se' || handle === 'sw') newY = initY - (newH - initH) / 2;
    }

    // Shift 等比:仅在角手柄(同时含横向和纵向)生效;按对角线主驱方向锁定比例
    const isCorner = (handle.includes('e') || handle.includes('w')) &&
                     (handle.includes('s') || handle.includes('n'));
    if (e.shiftKey && isCorner && initW > 0 && initH > 0) {
      const aspect = initW / initH;
      // 选缩放因子绝对值更大的轴作为主导
      const fW = newW / initW;
      const fH = newH / initH;
      const factor = Math.abs(fW - 1) > Math.abs(fH - 1) ? fW : fH;
      newW = Math.max(1, initW * factor);
      newH = Math.max(1, newW / aspect);
      // 重新算 newX/newY
      if (e.altKey) {
        // 中心不动
        newX = initX - (newW - initW) / 2;
        newY = initY - (newH - initH) / 2;
      } else {
        // 对角不动
        newX = initX;
        newY = initY;
        if (handle.includes('w')) newX = initX + (initW - newW);
        if (handle.includes('n')) newY = initY + (initH - newH);
      }
    }

    state.moveNode(nodeId, newX, newY);
    state.resizeNode(nodeId, newW, newH);
    pushIncrementalUpdate([nodeId]);
    recomputeAdjustedBounds();
  }, [pushIncrementalUpdate, recomputeAdjustedBounds]);

  const onWindowPointerUp = useCallback(() => {
    if (dragRef.current) {
      dragRef.current = null;
      baselineRef.current = null;
      setAdjustedBounds(null);
      endInteractiveSync(); // 一次 fullSync 兜底
    }
  }, []);

  useEffect(() => {
    window.addEventListener('pointermove', onWindowPointerMove);
    window.addEventListener('pointerup', onWindowPointerUp);
    return () => {
      window.removeEventListener('pointermove', onWindowPointerMove);
      window.removeEventListener('pointerup', onWindowPointerUp);
    };
  }, [onWindowPointerMove, onWindowPointerUp]);

  // ======== Pointer down (仍在手柄元素上) ========
  const handlePointerDown = useCallback((
    e: React.PointerEvent,
    initialNodeId: string,
    handle: DragHandle,
    bound: NodeBounds,
  ) => {
    e.stopPropagation();
    e.preventDefault();
    beginInteractiveSync();

    // 抓 baseline 的 helper：用最新 props.bounds + store 当前状态，给 recomputeAdjustedBounds 用
    const captureBaseline = () => {
      const st = useEditorStore.getState();
      const ids = st.selectedIds;
      const b = new Map<string, NodeBounds>();
      for (const nb of latestBoundsRef.current) b.set(nb.id, nb);
      const states = new Map<string, { x: number; y: number; width: number; height: number }>();
      for (const id of ids) {
        const n = st.nodes[id];
        if (n) states.set(id, { x: n.x, y: n.y, width: n.width, height: n.height });
      }
      baselineRef.current = {
        bounds: b,
        states,
        pixelScale: latestPixelScaleRef.current,
      };
    };

    let nodeId = initialNodeId;
    const state = useEditorStore.getState();

    // Alt + 移动手柄：拖动复制 —— 复制选中节点后，让 drag 操作作用于副本
    // 复制走 addNode（内部会自行 pushHistory），所以这条路径上不再额外 push 一次
    const isMoveLike = handle === 'move' || handle === 'move-x' || handle === 'move-y';
    const isAltDuplicate = e.altKey && isMoveLike && !!state.nodes[nodeId];
    if (!isAltDuplicate) pushHistory();

    let node = state.nodes[nodeId];

    if (isAltDuplicate) {
      const sids = state.selectedIds.length > 1 && state.selectedIds.includes(nodeId)
        ? state.selectedIds
        : [nodeId];
      const idMap = new Map<string, string>();
      sids.forEach((sid) => {
        const newId = deepDuplicateNode(sid, state.nodes, state.addNode, 0, 0);
        if (newId) idMap.set(sid, newId);
      });
      const newIds = [...idMap.values()];
      if (newIds.length === 0) {
        // Alt 复制全部失败：撤销 beginInteractiveSync，不进入拖动状态
        endInteractiveSync();
        return;
      }
      state.setSelectedIds(newIds);
      const mapped = idMap.get(nodeId);
      if (mapped) {
        nodeId = mapped;
        node = useEditorStore.getState().nodes[nodeId];
      }
    }

    // 旋转
    if (handle === 'rotate') {
      const el = (e.target as HTMLElement).closest('[data-overlay-root]');
      const containerRect = el?.getBoundingClientRect() || { left: 0, top: 0 };
      const centerX = bound.x + canvasOffset.x + bound.width / 2 + containerRect.left;
      const centerY = bound.y + canvasOffset.y + bound.height / 2 + containerRect.top;
      const startAngle = Math.atan2(e.clientY - centerY, e.clientX - centerX);
      dragRef.current = {
        handle, startX: e.clientX, startY: e.clientY,
        nodeId, origBounds: { ...bound },
        startAngle, initialRotation: node?.rotation || 0,
        centerX, centerY,
      };
      captureBaseline();
      return;
    }

    // 等比缩放
    if (handle.startsWith('scale-')) {
      const anchor = SCALE_ANCHOR[handle];
      const scale = getInteractionPixelScale();
      const el = (e.target as HTMLElement).closest('[data-overlay-root]');
      const containerRect = el?.getBoundingClientRect() || { left: 0, top: 0 };
      const bx = bound.x + canvasOffset.x + containerRect.left;
      const by = bound.y + canvasOffset.y + containerRect.top;
      const anchorX = anchor.includes('e') ? bx + bound.width : bx;
      const anchorY = anchor.includes('s') ? by + bound.height : by;
      const initialDist = Math.max(Math.sqrt((e.clientX - anchorX) ** 2 + (e.clientY - anchorY) ** 2), 1);
      dragRef.current = {
        handle, startX: e.clientX, startY: e.clientY,
        nodeId, origBounds: { ...bound },
        anchorX, anchorY,
        initialWidth: node?.width || bound.width / scale,
        initialHeight: node?.height || bound.height / scale,
        initialDist,
        initialNodeX: node?.x || 0,
        initialNodeY: node?.y || 0,
      };
      captureBaseline();
      return;
    }

    // 移动 / 轴约束移动 / rect resize — rect resize 需要记初始尺寸,以便基于总位移计算(Shift 切换不跳变)
    dragRef.current = {
      handle, startX: e.clientX, startY: e.clientY,
      nodeId, origBounds: { ...bound },
      initialWidth: node?.width || bound.width,
      initialHeight: node?.height || bound.height,
      initialNodeX: node?.x || 0,
      initialNodeY: node?.y || 0,
    };
    captureBaseline();
  }, [pushHistory, canvasOffset, getInteractionPixelScale]);

  // ======== 手柄显示条件 ========
  const showMoveGizmo = sceneTool === 'move' || sceneTool === 'transform';
  const showRotateGizmo = sceneTool === 'rotate' || sceneTool === 'transform';
  const showRect = sceneTool === 'rect' || sceneTool === 'transform';
  const showScale = sceneTool === 'scale' || sceneTool === 'transform';
  // 非 hand/move 时允许拖拽区移动（move 用 gizmo 中心方块代替）
  const showFillMove = sceneTool !== 'hand' && sceneTool !== 'move';

  return (
    <div
      className="absolute inset-0 pointer-events-none"
      data-overlay-root
    >
      {(adjustedBounds ?? bounds).map((b) => {
        const left = b.x + canvasOffset.x;
        const top = b.y + canvasOffset.y;
        const cx = b.width / 2;
        const cy = b.height / 2;

        return (
          <div key={b.id} style={{ position: 'absolute', left, top, width: b.width, height: b.height }}>
            {/* 选中半透明填充（仅视觉，不拦截点击） */}
            {showFillMove && (
              <div
                style={{
                  position: 'absolute', inset: 0,
                  background: SELECTION_FILL,
                  pointerEvents: 'none',
                }}
              />
            )}

            {/* 选中边框（始终显示） */}
            <div style={{
              position: 'absolute', inset: -1,
              border: `1.5px solid ${SELECTION_COLOR}`,
              pointerEvents: 'none',
            }} />

            {/* ======== Move Gizmo — 红绿十字轴箭头 ======== */}
            {showMoveGizmo && (
              <svg
                style={{
                  position: 'absolute',
                  left: cx - AXIS_LEN, top: cy - AXIS_LEN,
                  width: AXIS_LEN * 2, height: AXIS_LEN * 2,
                  overflow: 'visible', pointerEvents: 'none',
                }}
              >
                {/* X 轴线（红） */}
                <line
                  x1={AXIS_LEN} y1={AXIS_LEN}
                  x2={AXIS_LEN * 2 - ARROW_SIZE} y2={AXIS_LEN}
                  stroke={COLOR_X} strokeWidth={AXIS_WIDTH}
                />
                {/* X 轴箭头 */}
                <polygon
                  points={`${AXIS_LEN * 2},${AXIS_LEN} ${AXIS_LEN * 2 - ARROW_SIZE},${AXIS_LEN - ARROW_SIZE / 2} ${AXIS_LEN * 2 - ARROW_SIZE},${AXIS_LEN + ARROW_SIZE / 2}`}
                  fill={COLOR_X}
                />
                {/* X 轴可拖拽区域 */}
                <rect
                  data-drag-handle=""
                  x={AXIS_LEN + 4} y={AXIS_LEN - AXIS_HIT_WIDTH / 2}
                  width={AXIS_LEN - 4} height={AXIS_HIT_WIDTH}
                  fill="transparent" cursor="ew-resize"
                  pointerEvents="all"
                  onPointerDown={(e: React.PointerEvent<SVGRectElement>) =>
                    handlePointerDown(e as unknown as React.PointerEvent, b.id, 'move-x', b)
                  }
                />

                {/* Y 轴线（绿，向上） */}
                <line
                  x1={AXIS_LEN} y1={AXIS_LEN}
                  x2={AXIS_LEN} y2={ARROW_SIZE}
                  stroke={COLOR_Y} strokeWidth={AXIS_WIDTH}
                />
                {/* Y 轴箭头 */}
                <polygon
                  points={`${AXIS_LEN},0 ${AXIS_LEN - ARROW_SIZE / 2},${ARROW_SIZE} ${AXIS_LEN + ARROW_SIZE / 2},${ARROW_SIZE}`}
                  fill={COLOR_Y}
                />
                {/* Y 轴可拖拽区域 */}
                <rect
                  data-drag-handle=""
                  x={AXIS_LEN - AXIS_HIT_WIDTH / 2} y={0}
                  width={AXIS_HIT_WIDTH} height={AXIS_LEN - 4}
                  fill="transparent" cursor="ns-resize"
                  pointerEvents="all"
                  onPointerDown={(e: React.PointerEvent<SVGRectElement>) =>
                    handlePointerDown(e as unknown as React.PointerEvent, b.id, 'move-y', b)
                  }
                />

                {/* 中心自由移动方块（黄） */}
                <rect
                  data-drag-handle=""
                  x={AXIS_LEN - CENTER_HALF} y={AXIS_LEN - CENTER_HALF}
                  width={CENTER_SIZE} height={CENTER_SIZE}
                  fill={COLOR_FREE} rx="1"
                  cursor="move"
                  pointerEvents="all"
                  onPointerDown={(e: React.PointerEvent<SVGRectElement>) =>
                    handlePointerDown(e as unknown as React.PointerEvent, b.id, 'move', b)
                  }
                />
              </svg>
            )}

            {/* ======== Rotate Gizmo — 蓝色大圆环 ======== */}
            {showRotateGizmo && (() => {
              const radius = Math.max(b.width, b.height) / 2 + ROTATE_PAD;
              const size = radius * 2 + ROTATE_HIT_WIDTH;
              return (
                <svg
                  style={{
                    position: 'absolute',
                    left: cx - radius - ROTATE_HIT_WIDTH / 2,
                    top: cy - radius - ROTATE_HIT_WIDTH / 2,
                    width: size, height: size,
                    overflow: 'visible', pointerEvents: 'none',
                  }}
                >
                  {/* 可见圆环 */}
                  <circle
                    cx={size / 2} cy={size / 2} r={radius}
                    fill="none" stroke={SELECTION_COLOR} strokeWidth={ROTATE_STROKE}
                    opacity={0.6}
                  />
                  {/* 可点击透明粗圆环 */}
                  <circle
                    data-drag-handle=""
                    cx={size / 2} cy={size / 2} r={radius}
                    fill="none" stroke="transparent" strokeWidth={ROTATE_HIT_WIDTH}
                    cursor="crosshair"
                    pointerEvents="all"
                    onPointerDown={(e: React.PointerEvent<SVGCircleElement>) =>
                      handlePointerDown(e as unknown as React.PointerEvent, b.id, 'rotate', b)
                    }
                  />
                </svg>
              );
            })()}

            {/* ======== Rect 手柄（圆形角+边） ======== */}
            {showRect && CORNER_HANDLES.map((pos) => (
              <div key={pos} data-drag-handle style={{
                position: 'absolute',
                width: CORNER_SIZE, height: CORNER_SIZE,
                background: SELECTION_COLOR, borderRadius: '50%',
                cursor: HANDLE_CURSORS[pos], pointerEvents: 'auto',
                boxShadow: '0 0 0 1.5px #fff, 0 1px 3px rgba(0,0,0,0.3)',
                ...getCornerStyle(pos, b.width, b.height),
              }} onPointerDown={(e) => handlePointerDown(e, b.id, pos, b)} />
            ))}
            {showRect && EDGE_HANDLES.map((pos) => (
              <div key={pos} data-drag-handle style={{
                position: 'absolute',
                width: EDGE_SIZE, height: EDGE_SIZE,
                background: SELECTION_COLOR, borderRadius: '50%',
                cursor: HANDLE_CURSORS[pos], pointerEvents: 'auto',
                boxShadow: '0 0 0 1.5px #fff, 0 1px 3px rgba(0,0,0,0.3)',
                ...getEdgeStyle(pos, b.width, b.height),
              }} onPointerDown={(e) => handlePointerDown(e, b.id, pos, b)} />
            ))}

            {/* ======== 缩放菱形手柄（四角） ======== */}
            {showScale && SCALE_CORNERS.map((corner) => (
              <div key={`sc-${corner}`} data-drag-handle style={{
                position: 'absolute',
                width: SCALE_SIZE, height: SCALE_SIZE,
                background: SELECTION_COLOR,
                transform: 'rotate(45deg)',
                cursor: HANDLE_CURSORS[corner], pointerEvents: 'auto',
                boxShadow: '0 0 0 1.5px #fff, 0 1px 3px rgba(0,0,0,0.3)',
                ...getCornerStyle(corner, b.width, b.height),
              }} onPointerDown={(e) => handlePointerDown(e, b.id, `scale-${corner}`, b)} />
            ))}
          </div>
        );
      })}
    </div>
  );
}

// ---- 手柄定位 ----
function getCornerStyle(pos: string, w: number, h: number): React.CSSProperties {
  const half = CORNER_HALF;
  switch (pos) {
    case 'nw': return { left: -half, top: -half };
    case 'ne': return { left: w - half, top: -half };
    case 'se': return { left: w - half, top: h - half };
    case 'sw': return { left: -half, top: h - half };
    default: return {};
  }
}

function getEdgeStyle(pos: string, w: number, h: number): React.CSSProperties {
  const half = EDGE_HALF;
  switch (pos) {
    case 'n': return { left: w / 2 - half, top: -half };
    case 'e': return { left: w - half, top: h / 2 - half };
    case 's': return { left: w / 2 - half, top: h - half };
    case 'w': return { left: -half, top: h / 2 - half };
    default: return {};
  }
}

/**
 * 自定义拖拽引擎 — 用鼠标事件模拟拖拽，避免触发 OS 级 dragstart 事件。
 * 解决与 Eagle 等全局拖拽拦截软件的冲突。
 */

import { debugLog } from './debugLog';

// ──────── 类型 ────────

interface DragState {
  type: string;
  data: any;
  previewHtml: string;
  preview: HTMLElement | null;
  startX: number;
  startY: number;
  started: boolean;
}

interface DropTarget {
  element: HTMLElement;
  onDrop: (type: string, data: any, x: number, y: number) => void;
  onDragOver?: (type: string, x: number, y: number) => void;
  onDragLeave?: () => void;
}

// ──────── 模块状态 ────────

let dragState: DragState | null = null;
const dropTargets: Set<DropTarget> = new Set();
let activeTarget: DropTarget | null = null;

const DRAG_THRESHOLD = 4; // 超过 4px 才开始拖拽，避免误触

function dataSummary(data: any): Record<string, unknown> {
  return {
    relPath: typeof data?.relPath === 'string' ? data.relPath : undefined,
    path: typeof data?.path === 'string' ? data.path : undefined,
    name: typeof data?.name === 'string' ? data.name : undefined,
  };
}

function targetSummary(target: DropTarget | null): Record<string, unknown> {
  if (!target) return { hit: false };
  const el = target.element;
  const rect = el.getBoundingClientRect();
  return {
    hit: true,
    testId: el.dataset.testid,
    artboardId: el.dataset.artboardId,
    nodeId: el.dataset.layerNodeId,
    className: typeof el.className === 'string' ? el.className.slice(0, 120) : undefined,
    rect: {
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
  };
}

// ──────── 拖拽源 API ────────

/**
 * 开始一次自定义拖拽。在拖拽源的 onMouseDown 中调用。
 * @param e - 原始 MouseEvent（React 的或原生的）
 * @param type - 数据类型标识，如 'application/atlas-image'
 * @param data - 传递的数据对象
 * @param previewHtml - 拖拽预览的 HTML 内容
 */
export function startCustomDrag(
  e: React.MouseEvent | MouseEvent,
  type: string,
  data: any,
  previewHtml: string = '',
) {
  // 只响应左键
  if (e.button !== 0) return;

  e.preventDefault();
  e.stopPropagation();

  dragState = {
    type,
    data,
    previewHtml,
    preview: null,
    startX: e.clientX,
    startY: e.clientY,
    started: false,
  };

  debugLog('drag', 'start', {
    type,
    start: { x: e.clientX, y: e.clientY },
    data: dataSummary(data),
    dropTargets: dropTargets.size,
  });

  document.addEventListener('mousemove', onMouseMove, true);
  document.addEventListener('mouseup', onMouseUp, true);
}

/**
 * 当前是否正在拖拽中（已超过阈值）
 */
export function isDragging(): boolean {
  return dragState?.started ?? false;
}

/**
 * 获取当前拖拽的数据类型（未拖拽时返回 null）
 */
export function getDragType(): string | null {
  return dragState?.type ?? null;
}

// ──────── Drop Target API ────────

/**
 * 注册一个 drop target。返回 unregister 函数。
 */
export function registerDropTarget(target: DropTarget): () => void {
  dropTargets.add(target);
  return () => {
    dropTargets.delete(target);
    if (activeTarget === target) activeTarget = null;
  };
}

// ──────── 内部事件处理 ────────

function onMouseMove(e: MouseEvent) {
  if (!dragState) return;

  const dx = e.clientX - dragState.startX;
  const dy = e.clientY - dragState.startY;

  // 超过阈值才创建预览并开始拖拽
  if (!dragState.started) {
    if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
    dragState.started = true;
    createPreview(e.clientX, e.clientY);
    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';
    debugLog('drag', 'threshold-passed', {
      type: dragState.type,
      delta: { x: Math.round(dx), y: Math.round(dy) },
      data: dataSummary(dragState.data),
      dropTargets: dropTargets.size,
    });
  }

  // 移动预览
  if (dragState.preview) {
    dragState.preview.style.left = `${e.clientX + 12}px`;
    dragState.preview.style.top = `${e.clientY + 12}px`;
  }

  // 检测哪个 drop target 包含光标
  const target = findTargetAt(e.clientX, e.clientY);
  if (target !== activeTarget) {
    if (activeTarget?.onDragLeave) activeTarget.onDragLeave();
    activeTarget = target;
    debugLog('drag', 'target-change', {
      type: dragState.type,
      point: { x: e.clientX, y: e.clientY },
      target: targetSummary(target),
    });
    if (target?.onDragOver) target.onDragOver(dragState.type, e.clientX, e.clientY);
  } else if (target?.onDragOver) {
    target.onDragOver(dragState.type, e.clientX, e.clientY);
  }
}

function onMouseUp(e: MouseEvent) {
  if (!dragState) { cleanup(); return; }

  if (dragState.started) {
    const target = findTargetAt(e.clientX, e.clientY);
    debugLog('drag', 'drop', {
      type: dragState.type,
      point: { x: e.clientX, y: e.clientY },
      data: dataSummary(dragState.data),
      target: targetSummary(target),
      dropTargets: dropTargets.size,
    });
    if (target) {
      target.onDrop(dragState.type, dragState.data, e.clientX, e.clientY);
    }
    if (activeTarget?.onDragLeave) activeTarget.onDragLeave();
  }

  cleanup();
}

function findTargetAt(x: number, y: number): DropTarget | null {
  let best: { target: DropTarget; area: number } | null = null;
  for (const target of dropTargets) {
    const rect = target.element.getBoundingClientRect();
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
      const area = Math.max(1, rect.width * rect.height);
      if (!best || area < best.area) best = { target, area };
    }
  }
  return best?.target ?? null;
}

function createPreview(x: number, y: number) {
  if (!dragState || !dragState.previewHtml) return;
  const el = document.createElement('div');
  el.style.cssText = `
    position: fixed;
    left: ${x + 12}px;
    top: ${y + 12}px;
    z-index: 99999;
    pointer-events: none;
    background: #1e1e2e;
    border: 1px solid #45475a;
    border-radius: 6px;
    padding: 4px 8px;
    color: #cdd6f4;
    font-size: 11px;
    white-space: nowrap;
    box-shadow: 0 4px 12px rgba(0,0,0,0.4);
    opacity: 0.92;
    max-width: 200px;
    overflow: hidden;
    display: flex;
    align-items: center;
    gap: 6px;
  `;
  el.innerHTML = dragState.previewHtml;
  document.body.appendChild(el);
  dragState.preview = el;
}

function cleanup() {
  document.removeEventListener('mousemove', onMouseMove, true);
  document.removeEventListener('mouseup', onMouseUp, true);
  if (dragState?.preview) {
    dragState.preview.remove();
  }
  dragState = null;
  activeTarget = null;
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
}

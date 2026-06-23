import { useEffect, useRef, useState } from 'react';
import Toolbar from './components/Panels/Toolbar';
import ComponentLibrary from './components/Panels/ComponentLibrary';
import AtlasLibrary from './components/Panels/AtlasLibrary';
import TemplateLibrary from './components/Panels/TemplateLibrary';
import JenkinsSyncButton from './components/Panels/JenkinsSyncButton';
import UnityCanvas from './components/Canvas/BridgeSnapshotCanvas';
import PropertyPanel from './components/Panels/PropertyPanel';
import LayerPanel from './components/Panels/LayerPanel';
import ShortcutsDialog from './components/Panels/ShortcutsDialog';
import { useEditorStore } from './stores/editorStore';
import { widgetDefs } from './data/componentDefs';
import {
  createWidgetNodeOnBridge,
  copyNodesToActiveBridgeSession,
  deleteNodeOnBridge,
  deleteNodesFromBridgeSession,
  duplicateNodesOnBridge,
  groupNodesOnBridge,
  moveNodesOnBridge,
  redoActiveBridgeArtboard,
  reorderNodesOnBridge,
  setOpacityNodesOnBridge,
  setVisibleNodesOnBridge,
  undoActiveBridgeArtboard,
  ungroupNodesOnBridge,
} from './services/BridgeArtboardStore';

function editableNodeIds(ids: string[], nodes: ReturnType<typeof useEditorStore.getState>['nodes']): string[] {
  return ids.filter((id) => {
    const node = nodes[id];
    return !!node && !node.locked;
  });
}

async function alignNodes(mode: 'left' | 'right' | 'top' | 'bottom' | 'center-h' | 'center-v' | 'distribute-h' | 'distribute-v') {
  const { selectedIds, nodes, previewWidth, previewHeight } = useEditorStore.getState();
  const editableSelectedIds = editableNodeIds(selectedIds, nodes);
  const moves: Array<{ nodeId: string; x: number; y: number }> = [];
  const pushMove = (nodeId: string, x: number, y: number) => {
    const node = nodes[nodeId];
    if (!node) return;
    const nextX = Math.round(x);
    const nextY = Math.round(y);
    if (node.x === nextX && node.y === nextY) return;
    moves.push({ nodeId, x: nextX, y: nextY });
  };

  if (editableSelectedIds.length < 2 && !mode.startsWith('distribute')) {
    if (editableSelectedIds.length === 1) {
      const n = nodes[editableSelectedIds[0]];
      if (!n) return;

      // 有父节点时以父节点为参考，否则以当前画布尺寸
      let refW = previewWidth;
      let refH = previewHeight;
      if (n.parentId && nodes[n.parentId]) {
        refW = nodes[n.parentId].width;
        refH = nodes[n.parentId].height;
      }

      switch (mode) {
        case 'left': pushMove(n.id, 0, n.y); break;
        case 'right': pushMove(n.id, refW - n.width, n.y); break;
        case 'top': pushMove(n.id, n.x, 0); break;
        case 'bottom': pushMove(n.id, n.x, refH - n.height); break;
        case 'center-h': pushMove(n.id, (refW - n.width) / 2, n.y); break;
        case 'center-v': pushMove(n.id, n.x, (refH - n.height) / 2); break;
      }
    }
    await moveNodesOnBridge(moves, '节点已对齐', selectedIds);
    return;
  }

  const selected = editableSelectedIds.map((id) => nodes[id]).filter(Boolean);
  if (selected.length < 2) return;

  switch (mode) {
    case 'left': {
      const minX = Math.min(...selected.map((n) => n.x));
      selected.forEach((n) => pushMove(n.id, minX, n.y));
      break;
    }
    case 'right': {
      const maxRight = Math.max(...selected.map((n) => n.x + n.width));
      selected.forEach((n) => pushMove(n.id, maxRight - n.width, n.y));
      break;
    }
    case 'top': {
      const minY = Math.min(...selected.map((n) => n.y));
      selected.forEach((n) => pushMove(n.id, n.x, minY));
      break;
    }
    case 'bottom': {
      const maxBottom = Math.max(...selected.map((n) => n.y + n.height));
      selected.forEach((n) => pushMove(n.id, n.x, maxBottom - n.height));
      break;
    }
    case 'center-h': {
      const minX = Math.min(...selected.map((n) => n.x));
      const maxRight = Math.max(...selected.map((n) => n.x + n.width));
      const center = (minX + maxRight) / 2;
      selected.forEach((n) => pushMove(n.id, center - n.width / 2, n.y));
      break;
    }
    case 'center-v': {
      const minY = Math.min(...selected.map((n) => n.y));
      const maxBottom = Math.max(...selected.map((n) => n.y + n.height));
      const center = (minY + maxBottom) / 2;
      selected.forEach((n) => pushMove(n.id, n.x, center - n.height / 2));
      break;
    }
    case 'distribute-h': {
      if (selected.length < 3) return;
      const sorted = [...selected].sort((a, b) => a.x - b.x);
      const totalWidth = sorted.reduce((s, n) => s + n.width, 0);
      const minX = sorted[0].x;
      const maxRight = sorted[sorted.length - 1].x + sorted[sorted.length - 1].width;
      const gap = (maxRight - minX - totalWidth) / (sorted.length - 1);
      let cx = minX;
      sorted.forEach((n) => {
        pushMove(n.id, cx, n.y);
        cx += n.width + gap;
      });
      break;
    }
    case 'distribute-v': {
      if (selected.length < 3) return;
      const sorted = [...selected].sort((a, b) => a.y - b.y);
      const totalHeight = sorted.reduce((s, n) => s + n.height, 0);
      const minY = sorted[0].y;
      const maxBottom = sorted[sorted.length - 1].y + sorted[sorted.length - 1].height;
      const gap = (maxBottom - minY - totalHeight) / (sorted.length - 1);
      let cy = minY;
      sorted.forEach((n) => {
        pushMove(n.id, n.x, cy);
        cy += n.height + gap;
      });
      break;
    }
  }
  await moveNodesOnBridge(moves, mode.startsWith('distribute') ? '节点已分布' : '节点已对齐', selectedIds);
}

function activeBridgeSessionId(): string | null {
  const state = useEditorStore.getState();
  const page = state.pages.find((item) => item.id === state.activePageId);
  const artboard = page?.artboards.find((item) => item.id === state.activeArtboardId);
  return artboard?.bridgeSessionId ?? null;
}

async function duplicateSelected() {
  const { selectedIds, nodes } = useEditorStore.getState();
  const editableSelectedIds = editableNodeIds(selectedIds, nodes);
  if (editableSelectedIds.length === 0) return;
  await duplicateNodesOnBridge(editableSelectedIds);
}

/** 深拷贝节点及其所有子节点，返回新根节点 id */
function deepDuplicateNode(
  srcId: string,
  nodes: Record<string, any>,
  addNode: (type: any, x: number, y: number, options?: any) => string,
  offsetX = 0,
  offsetY = 0,
  overrideParentId?: string | null,
): string | null {
  const src = nodes[srcId];
  if (!src) return null;

  // 浅拷贝所有属性，深拷贝对象类型字段
  const options: Record<string, any> = {};
  for (const key of Object.keys(src)) {
    if (key === 'id' || key === 'children') continue;
    const v = src[key];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      options[key] = { ...v };
    } else {
      options[key] = v;
    }
  }
  options.name = src.name + '_copy';
  if (overrideParentId !== undefined) options.parentId = overrideParentId || undefined;

  const newId = addNode(src.type, src.x + offsetX, src.y + offsetY, options);

  // 递归复制子节点（子节点不需要偏移，因为它们的坐标是相对父节点的）
  if (src.children && src.children.length > 0) {
    for (const childId of src.children) {
      deepDuplicateNode(childId, nodes, addNode, 0, 0, newId);
    }
  }

  return newId;
}

let bridgeClipboard: { sessionId: string; nodeIds: string[]; mode: 'copy' | 'cut' } | null = null;

/** Ctrl+C — 只记录当前 Bridge session 内可安全复制的节点。 */
function copySelected() {
  const { selectedIds, nodes } = useEditorStore.getState();
  const editableSelectedIds = editableNodeIds(selectedIds, nodes);
  if (editableSelectedIds.length === 0) return;
  const sessionId = activeBridgeSessionId();
  bridgeClipboard = sessionId ? { sessionId, nodeIds: [...editableSelectedIds], mode: 'copy' } : null;
}

/** Ctrl+V — 通过 Unity Bridge 在同 session 复制，跨 session 克隆到当前画板 root。 */
async function pasteNodes() {
  const sessionId = activeBridgeSessionId();
  if (!bridgeClipboard || !sessionId) return;
  const clip = bridgeClipboard;
  if (bridgeClipboard && sessionId && bridgeClipboard.sessionId === sessionId) {
    await duplicateNodesOnBridge(clip.nodeIds);
  } else {
    await copyNodesToActiveBridgeSession(clip.sessionId, clip.nodeIds);
  }
  if (clip.mode === 'cut') {
    if (clip.sessionId === sessionId) {
      for (const nodeId of clip.nodeIds) await deleteNodeOnBridge(nodeId);
    } else {
      await deleteNodesFromBridgeSession(clip.sessionId, clip.nodeIds);
    }
    bridgeClipboard = null;
  }
}

/** Ctrl+X — 标记剪切；粘贴成功后再通过 Bridge 删除源节点，避免剪贴板 nodeId 失效。 */
function cutSelected() {
  const state = useEditorStore.getState();
  if (state.selectedIds.length === 0) return;
  const ids = editableNodeIds(state.selectedIds, state.nodes);
  if (ids.length === 0) return;
  const sessionId = activeBridgeSessionId();
  bridgeClipboard = sessionId ? { sessionId, nodeIds: [...ids], mode: 'cut' } : null;
}

export default function App() {
  const appRef = useRef<HTMLDivElement>(null);
  const [appWidth, setAppWidth] = useState<number>(() => window.innerWidth || 0);
  const [leftTab, setLeftTab] = useState<'components' | 'atlas' | 'templates'>('components');
  // 图层面板宽度(可拖拽);持久化到 localStorage
  const [layerPanelWidth, setLayerPanelWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem('layerPanelWidth'));
    return Number.isFinite(saved) && saved >= 200 && saved <= 800 ? saved : 288;
  });
  useEffect(() => {
    localStorage.setItem('layerPanelWidth', String(layerPanelWidth));
  }, [layerPanelWidth]);
  // 图层面板折叠（Ctrl+B 切换）。折叠时记住上次宽度便于恢复
  const [layerPanelCollapsed, setLayerPanelCollapsed] = useState<boolean>(false);
  const lastLayerPanelWidthRef = useRef<number>(layerPanelWidth);
  // 面板可见性：Tab 全部隐藏，Shift+Tab 仅隐藏左右
  const [panelsVisible, setPanelsVisible] = useState<boolean>(true);
  const [toolbarVisible, setToolbarVisible] = useState<boolean>(true);
  const [shortcutsOpen, setShortcutsOpen] = useState<boolean>(false);
  const locateImagePath = useEditorStore((s) => s.locateImagePath);

  useEffect(() => {
    const el = appRef.current;
    if (!el) return;
    const updateWidth = () => setAppWidth(el.getBoundingClientRect().width);
    updateWidth();
    const ro = new ResizeObserver(updateWidth);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Codex 内置浏览器常以窄侧栏呈现。固定三栏会把画布挤没，
  // 因此窄宽度下优先保留左侧导入面板和画布。
  const compactLayout = appWidth > 0 && appWidth < 1400;
  const narrowPanelLayout = appWidth > 0 && appWidth < 1280;
  const showLayerPanel = panelsVisible && !layerPanelCollapsed && !narrowPanelLayout;
  const showPropertyPanel = panelsVisible && !compactLayout;
  const leftPanelClass = narrowPanelLayout ? 'w-56' : 'w-64';
  const effectiveLayerPanelWidth = compactLayout ? Math.min(layerPanelWidth, 224) : layerPanelWidth;

  useEffect(() => {
    if (locateImagePath) setLeftTab('atlas');
  }, [locateImagePath]);

  useEffect(() => {
    const onOpen = () => setShortcutsOpen(true);
    window.addEventListener('shortcuts:open', onOpen);
    return () => window.removeEventListener('shortcuts:open', onOpen);
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = document.activeElement?.tagName;
      const inInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

      const state = useEditorStore.getState();

      // 画布尺寸辅助（zoom/fit 用）
      const getCanvasRect = () => {
        const el = document.querySelector('[data-canvas-container]') as HTMLElement | null;
        return el?.getBoundingClientRect() ?? null;
      };
      const zoomBy = (factor: number) => {
        const rect = getCanvasRect();
        if (!rect) return;
        const cx = rect.width / 2;
        const cy = rect.height / 2;
        const { canvasX, canvasY, canvasScale, setCanvasTransform } = state;
        const newScale = Math.max(0.1, Math.min(5, canvasScale * factor));
        const newX = cx - (cx - canvasX) * (newScale / canvasScale);
        const newY = cy - (cy - canvasY) * (newScale / canvasScale);
        setCanvasTransform(newX, newY, newScale);
      };
      const fitView = () => {
        const rect = getCanvasRect();
        if (!rect) return;
        const sx = rect.width / state.previewWidth;
        const sy = rect.height / state.previewHeight;
        const scale = Math.min(sx, sy) * 0.9;
        const cx = (rect.width - state.previewWidth * scale) / 2;
        const cy = (rect.height - state.previewHeight * scale) / 2;
        state.setCanvasTransform(cx, cy, scale);
      };
      const actualSize = () => {
        const rect = getCanvasRect();
        if (!rect) return;
        const cx = (rect.width - state.previewWidth) / 2;
        const cy = (rect.height - state.previewHeight) / 2;
        state.setCanvasTransform(cx, cy, 1);
      };
      const focusSelection = () => {
        const ids = state.selectedIds;
        if (ids.length === 0) return;
        // 计算选中节点的并集 bbox（绝对坐标）
        const absOf = (id: string) => {
          let ax = 0, ay = 0;
          let cur: typeof state.nodes[string] | undefined = state.nodes[id];
          while (cur) {
            ax += cur.x; ay += cur.y;
            cur = cur.parentId ? state.nodes[cur.parentId] : undefined;
          }
          return { ax, ay };
        };
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        ids.forEach((id) => {
          const n = state.nodes[id];
          if (!n) return;
          const { ax, ay } = absOf(id);
          minX = Math.min(minX, ax);
          minY = Math.min(minY, ay);
          maxX = Math.max(maxX, ax + n.width);
          maxY = Math.max(maxY, ay + n.height);
        });
        if (!isFinite(minX)) return;
        const rect = getCanvasRect();
        if (!rect) return;
        const bw = maxX - minX;
        const bh = maxY - minY;
        const padFactor = 1.4;
        const fitScale = Math.min(rect.width / (bw * padFactor), rect.height / (bh * padFactor), 2);
        const scale = Math.max(0.1, Math.min(fitScale, 5));
        const centerX = (minX + maxX) / 2;
        const centerY = (minY + maxY) / 2;
        const cx = rect.width / 2 - centerX * scale;
        const cy = rect.height / 2 - centerY * scale;
        state.setCanvasTransform(cx, cy, scale);
      };

      // Ctrl 组合键（输入框内也响应 undo/redo/save）
      if (e.ctrlKey || e.metaKey) {
        // 先处理需要 Shift 修饰的组合
        if (e.shiftKey) {
          switch (e.key) {
            case 'z': case 'Z':
              e.preventDefault();
              void redoActiveBridgeArtboard();
              if (inInput) (document.activeElement as HTMLElement)?.blur();
              return;
            case 's': case 'S':
              if (inInput) return;
              e.preventDefault();
              window.dispatchEvent(new Event('uieditor:save'));
              return;
            case 'h': case 'H':
              if (inInput) return;
              e.preventDefault();
              state.toggleGrayscaleMode();
              return;
            case 'd': case 'D':
              if (inInput) return;
              e.preventDefault();
              state.setSelectedIds([]);
              return;
            case 'g': case 'G':
              if (inInput) return;
              e.preventDefault();
              void ungroupNodesOnBridge(editableNodeIds(state.selectedIds, state.nodes));
              return;
            case '}': case ']':
              if (inInput) return;
              e.preventDefault();
              void reorderNodesOnBridge(editableNodeIds(state.selectedIds, state.nodes), 'top');
              return;
            case '{': case '[':
              if (inInput) return;
              e.preventDefault();
              void reorderNodesOnBridge(editableNodeIds(state.selectedIds, state.nodes), 'bottom');
              return;
          }
        }

        switch (e.key) {
          case 'z':
            e.preventDefault();
            void undoActiveBridgeArtboard();
            if (inInput) (document.activeElement as HTMLElement)?.blur();
            return;
          case 'y': e.preventDefault(); void redoActiveBridgeArtboard(); if (inInput) (document.activeElement as HTMLElement)?.blur(); return;
          case 's': e.preventDefault(); window.dispatchEvent(new Event('uieditor:save')); return;
        }
        if (inInput) return;
        switch (e.key) {
          case 'd': e.preventDefault(); void duplicateSelected(); return;
          case 'a': e.preventDefault(); state.setSelectedIds(Object.keys(state.nodes)); return;
          case 'c': e.preventDefault(); copySelected(); return;
          case 'v': e.preventDefault(); void pasteNodes(); return;
          case 'x': e.preventDefault(); cutSelected(); return;
          case 'g': e.preventDefault(); void groupNodesOnBridge(editableNodeIds(state.selectedIds, state.nodes)); return;
          case 'h': e.preventDefault(); state.toggleAnnotationLayer(); return;
          case 'r': e.preventDefault(); state.toggleRulers(); return;
          case 'l': e.preventDefault(); {
            const ids = state.selectedIds;
            if (ids.length === 0) return;
            // 任一未锁则全锁；全锁则解锁
            const anyUnlocked = ids.some((id) => state.nodes[id] && !state.nodes[id].locked);
            ids.forEach((id) => state.updateNode(id, { locked: anyUnlocked }));
            return;
          }
          case 'b': e.preventDefault(); {
            // 折叠/展开图层面板。折叠前记住宽度
            setLayerPanelCollapsed((cur) => {
              if (!cur) {
                lastLayerPanelWidthRef.current = layerPanelWidth;
              } else {
                // 恢复时如果当前宽度异常，回到上次记住的值
                const last = lastLayerPanelWidthRef.current;
                if (last >= 200 && last <= 800) setLayerPanelWidth(last);
              }
              return !cur;
            });
            return;
          }
          case '0': e.preventDefault(); fitView(); return;
          case '1': e.preventDefault(); actualSize(); return;
          case '=': case '+': e.preventDefault(); zoomBy(1.2); return;
          case '-': case '_': e.preventDefault(); zoomBy(1 / 1.2); return;
          case ']': e.preventDefault(); void reorderNodesOnBridge(editableNodeIds(state.selectedIds, state.nodes), 'up'); return;
          case '[': e.preventDefault(); void reorderNodesOnBridge(editableNodeIds(state.selectedIds, state.nodes), 'down'); return;
          case 'PageUp':
          case 'PageDown': {
            e.preventDefault();
            // Ctrl+PageUp/Down → 切换画板
            const cur = state.pages.find((p) => p.id === state.activePageId);
            if (!cur || cur.artboards.length === 0) return;
            const idx = cur.artboards.findIndex((a) => a.id === state.activeArtboardId);
            const next = e.key === 'PageUp' ? idx - 1 : idx + 1;
            if (next < 0 || next >= cur.artboards.length) return;
            state.setActiveArtboard(cur.artboards[next].id);
            return;
          }
        }
      }

      // Alt 对齐组合（不能在输入框内）
      if (e.altKey && !e.ctrlKey && !e.metaKey && !inInput) {
        const k = e.key.toLowerCase();
        const map: Record<string, 'left' | 'right' | 'top' | 'bottom' | 'center-h' | 'center-v'> = {
          a: 'left', d: 'right', w: 'top', s: 'bottom', h: 'center-h', v: 'center-v',
        };
        if (map[k]) {
          e.preventDefault();
          void alignNodes(map[k]);
          return;
        }
      }
      // Ctrl+Alt+H/V 分布
      if ((e.ctrlKey || e.metaKey) && e.altKey && !inInput) {
        const k = e.key.toLowerCase();
        if (k === 'h') { e.preventDefault(); void alignNodes('distribute-h'); return; }
        if (k === 'v') { e.preventDefault(); void alignNodes('distribute-v'); return; }
      }

      if (inInput) return;

      // ? (Shift+/) → 切换快捷键面板
      if (e.key === '?') {
        e.preventDefault();
        setShortcutsOpen((v) => !v);
        return;
      }

      // Tab: 沉浸预览 —— 隐藏左右面板与顶部 Toolbar；Shift+Tab 仅隐藏左右面板（保留 Toolbar）
      if (e.key === 'Tab') {
        e.preventDefault();
        if (e.shiftKey) {
          setPanelsVisible((v) => !v);
          setToolbarVisible(true);
        } else {
          setPanelsVisible((v) => {
            const next = !v;
            setToolbarVisible(next);
            return next;
          });
        }
        return;
      }

      // Esc: 第一次清流程线起点(仅流程线工具),第二次/其他工具直接退出
      if (e.key === 'Escape') {
        if (state.annotationTool) {
          e.preventDefault();
          if (state.annotationTool === 'flow-line' && state.flowLineDraftSrcId) {
            state.setFlowLineDraftSrcId(null);
            state.setAnnotationHint('已取消起点,重新选择', 1500);
          } else {
            state.setAnnotationTool(null);
          }
          return;
        }
      }

      // Delete
      if (e.key === 'Delete' || e.key === 'Backspace') {
        // 批注优先
        if (state.selectedAnnotationIds.length > 0) {
          e.preventDefault();
          state.selectedAnnotationIds.forEach((id) => state.deleteAnnotation(id));
          return;
        }
        void (async () => {
          for (const id of editableNodeIds([...state.selectedIds], state.nodes)) {
            await deleteNodeOnBridge(id);
          }
        })();
        return;
      }

      // F2 全局重命名：通知图层面板启动输入框
      if (e.key === 'F2') {
        if (state.selectedIds.length === 1) {
          if (state.nodes[state.selectedIds[0]]?.locked) return;
          e.preventDefault();
          state.requestRenameSelected();
        }
        return;
      }

      // PageUp/Down（无 Ctrl）→ 切换页面
      if (e.key === 'PageUp' || e.key === 'PageDown') {
        if (state.pages.length <= 1) return;
        e.preventDefault();
        const idx = state.pages.findIndex((p) => p.id === state.activePageId);
        const next = e.key === 'PageUp' ? idx - 1 : idx + 1;
        if (next < 0 || next >= state.pages.length) return;
        state.switchPage(state.pages[next].id);
        return;
      }

      // 场景工具快捷键 Q/W/E/R/T/Y
      if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        // F → 聚焦选中（早于工具键判断，避免被 'f' 误吞作流程线）
        if (e.key === 'f' || e.key === 'F') {
          if (state.selectedIds.length > 0) {
            e.preventDefault();
            focusSelection();
            return;
          }
        }
        // Enter → 进入文本节点的内联编辑
        if (e.key === 'Enter' && state.selectedIds.length === 1) {
          const n = state.nodes[state.selectedIds[0]];
          if (n && n.type === 'text' && !n.locked) {
            e.preventDefault();
            state.setEditingTextId(n.id);
            return;
          }
        }
        // \\ → 切换选中节点 visible
        if (e.key === '\\') {
          const ids = state.selectedIds;
          if (ids.length === 0) return;
          e.preventDefault();
          const anyVisible = ids.some((id) => state.nodes[id]?.visible !== false);
          void setVisibleNodesOnBridge(ids, !anyVisible, ids);
          return;
        }

        // 数字键 0-9 → 选中节点不透明度（1=10%, ..., 9=90%, 0=100%）
        if (state.selectedIds.length > 0 && /^[0-9]$/.test(e.key)) {
          e.preventDefault();
          const n = parseInt(e.key, 10);
          const opacity = n === 0 ? 1 : n / 10;
          void setOpacityNodesOnBridge(editableNodeIds(state.selectedIds, state.nodes), opacity, state.selectedIds);
          return;
        }

        const sceneToolMap: Record<string, 'hand' | 'move' | 'rotate' | 'scale' | 'rect' | 'transform'> = {
          q: 'hand', w: 'move', e: 'rotate',
          r: 'scale', t: 'rect', y: 'transform',
        };
        const st = sceneToolMap[e.key.toLowerCase()];
        if (st) {
          e.preventDefault();
          state.setSceneTool(st);
          return;
        }

        // 批注工具快捷键 A/F/N（F 上面已处理 focus，剩下的不会到这里）
        const annToolMap: Record<string, 'arrow' | 'flow-line' | 'number'> = {
          a: 'arrow', f: 'flow-line', n: 'number',
        };
        const at = annToolMap[e.key.toLowerCase()];
        if (at) {
          e.preventDefault();
          const cur = state.annotationTool;
          state.setAnnotationTool(cur === at ? null : at);
          return;
        }
      }

      // 方向键移动
      const moveStep = e.shiftKey ? 10 : 1;
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
        e.preventDefault();
        if (state.selectedIds.length === 0) return;
        const moves = editableNodeIds(state.selectedIds, state.nodes).flatMap((id) => {
          const n = state.nodes[id];
          if (!n) return [];
          switch (e.key) {
            case 'ArrowUp': return [{ nodeId: id, x: n.x, y: n.y - moveStep }];
            case 'ArrowDown': return [{ nodeId: id, x: n.x, y: n.y + moveStep }];
            case 'ArrowLeft': return [{ nodeId: id, x: n.x - moveStep, y: n.y }];
            case 'ArrowRight': return [{ nodeId: id, x: n.x + moveStep, y: n.y }];
            default: return [];
          }
        });
        void moveNodesOnBridge(moves, '节点已移动', state.selectedIds);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  return (
    <div ref={appRef} className="w-full h-full flex flex-col">
      {toolbarVisible && <Toolbar />}
      <div className="flex-1 flex overflow-hidden">
        {/* 左侧：组件库 / 图片资源 Tab 切换 */}
        {panelsVisible && (
        <div className={`${leftPanelClass} shrink-0 flex flex-col overflow-hidden bg-[#1e1e2e] border-r border-[#313244]`}>
          <div className="flex shrink-0 border-b border-[#313244]">
            <button
              onClick={() => setLeftTab('components')}
              className={`flex-1 py-2 text-sm text-center transition-colors ${
                leftTab === 'components'
                  ? 'text-[#89b4fa] border-b-2 border-[#89b4fa] bg-[#1e1e2e]'
                  : 'text-[#6c7086] hover:text-[#a6adc8]'
              }`}
            >
              组件库
            </button>
            <button
              onClick={() => setLeftTab('atlas')}
              className={`flex-1 py-2 text-sm text-center transition-colors ${
                leftTab === 'atlas'
                  ? 'text-[#89b4fa] border-b-2 border-[#89b4fa] bg-[#1e1e2e]'
                  : 'text-[#6c7086] hover:text-[#a6adc8]'
              }`}
            >
              图片
            </button>
            <button
              onClick={() => setLeftTab('templates')}
              className={`flex-1 py-2 text-sm text-center transition-colors ${
                leftTab === 'templates'
                  ? 'text-[#89b4fa] border-b-2 border-[#89b4fa] bg-[#1e1e2e]'
                  : 'text-[#6c7086] hover:text-[#a6adc8]'
              }`}
            >
              项目UI
            </button>
          </div>
          <div className="flex-1 overflow-hidden">
            {leftTab === 'components' ? <ComponentLibrary /> : leftTab === 'atlas' ? <AtlasLibrary /> : <TemplateLibrary />}
          </div>
          {/* 底部：Jenkins 同步按钮（三个 tab 共用） */}
          <div className="shrink-0 px-3 py-2 border-t border-[#313244]">
            <JenkinsSyncButton />
          </div>
        </div>
        )}
        {/* 图层面板 + 基础控件 */}
        {showLayerPanel && (
        <div
          className="border-l border-[#313244] overflow-hidden flex flex-col relative shrink-0"
          style={{ width: effectiveLayerPanelWidth }}
        >
          {/* 左侧拖拽条:拖动改变本面板宽度 */}
          <div
            className="absolute left-0 top-0 bottom-0 w-1 cursor-ew-resize hover:bg-[#89b4fa] z-10"
            onPointerDown={(e) => {
              e.preventDefault();
              const startX = e.clientX;
              const startW = layerPanelWidth;
              const onMove = (ev: PointerEvent) => {
                // 面板在右侧,向左拖增加宽度 → 取负 dx
                const dx = ev.clientX - startX;
                const next = Math.max(200, Math.min(800, startW - dx));
                setLayerPanelWidth(next);
              };
              const onUp = () => {
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onUp);
              };
              window.addEventListener('pointermove', onMove);
              window.addEventListener('pointerup', onUp);
            }}
          />
          <div className="flex-1 overflow-hidden">
            <LayerPanel />
          </div>
          {/* 基础控件 */}
          <div className="shrink-0 border-t border-[#313244] px-2 py-2">
            <div className="text-[12px] text-[#6c7086] mb-1.5 px-1">基础控件</div>
            <div className="grid grid-cols-4 gap-1">
              {widgetDefs.map((w) => (
                <button
                  key={w.name}
                  onClick={() => {
                    const store = useEditorStore.getState();
                    const parentId = store.selectedIds.length === 1 ? store.selectedIds[0] : undefined;
                    void createWidgetNodeOnBridge({
                      widgetType: w.type,
                      name: w.name,
                      width: w.defaultWidth,
                      height: w.defaultHeight,
                      parentId,
                    });
                  }}
                  className="flex flex-col items-center p-1 rounded bg-[#313244] hover:bg-[#45475a] transition-colors"
                  title={w.displayName}
                >
                  <span className="text-[11px] font-bold px-1 py-0.5 rounded" style={{ backgroundColor: w.color, color: '#1e1e2e' }}>
                    {w.icon}
                  </span>
                  <span className="text-[11px] text-[#a6adc8] mt-0.5">{w.displayName}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
        )}
        {/* 中间：画布 */}
        <UnityCanvas />
        {/* 右侧：属性 */}
        {showPropertyPanel && <PropertyPanel />}
      </div>
      <ShortcutsDialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </div>
  );
}

// 导出对齐函数供画布工具栏使用
export { alignNodes, duplicateSelected, deepDuplicateNode };

/**
 * Store → Unity 同步订阅
 * 监听 Zustand store 变化，自动推送到 Unity WebGL
 */
import { useEditorStore } from '../stores/editorStore';
import { exportPageForUnity } from '../utils/exportJson';
import unityBridge from './UnityBridge';

let unsubscribe: (() => void) | null = null;
// RAF 节流：合并同一帧内的多次节点变化为一次全量同步
let rafId: number | null = null;

// 拖动等高频交互期间，跳过 fullSync 调度（由 SelectionOverlay 直接调 unityBridge.updateNode 推增量）
let _isInteractive = false;

/**
 * 启动 store → Unity 同步
 * 在 Unity WebGL 就绪后调用
 */
export function startStoreSync() {
  if (unsubscribe) return;

  const initialState = useEditorStore.getState();
  unityBridge.setCanvasSize(initialState.previewWidth, initialState.previewHeight);

  // 先做一次全量同步
  fullSync();

  // SyncFullTree 可能重建 Unity 端 ContentRoot；首帧后重放一次预览尺寸，
  // 确保刷新页面时竖屏/异形屏设置不会被初次全量同步覆盖。
  requestAnimationFrame(() => {
    const state = useEditorStore.getState();
    unityBridge.setCanvasSize(state.previewWidth, state.previewHeight);
    if (state.selectedIds.length > 0) {
      requestAnimationFrame(() => unityBridge.setSelection(useEditorStore.getState().selectedIds));
    }
  });

  // 订阅 store 变化
  unsubscribe = useEditorStore.subscribe((state, prev) => {
    // 节点/画板/页面变化 → 下一帧做一次全量同步（合并同帧内多次 moveNode/resizeNode）
    if (
      state.pages !== prev.pages ||
      state.nodes !== prev.nodes ||
      state.rootIds !== prev.rootIds ||
      state.activePageId !== prev.activePageId ||
      state.activeArtboardId !== prev.activeArtboardId
    ) {
      // 拖动期间：增量同步由 SelectionOverlay 直接推送，这里完全跳过 fullSync 调度
      if (!_isInteractive) {
        scheduleFullSync();
      }
    }

    // 选中变化 → 立即同步（不需要节流）
    if (state.selectedIds !== prev.selectedIds) {
      unityBridge.setSelection(state.selectedIds);
    }

    // 分辨率变化 → 更新 Canvas，然后刷新选区 bounds
    if (state.previewWidth !== prev.previewWidth || state.previewHeight !== prev.previewHeight) {
      unityBridge.setCanvasSize(state.previewWidth, state.previewHeight);
      // 延迟一帧让 Unity 完成布局重建后，重新发送选中状态以获取更新的 nodeBounds
      requestAnimationFrame(() => {
        const ids = useEditorStore.getState().selectedIds;
        if (ids.length > 0) {
          unityBridge.setSelection(ids);
        }
      });
    }
  });
}

/**
 * 调度一次下一帧的全量同步（同帧内多次调用只执行一次）
 */
function scheduleFullSync() {
  if (rafId !== null) return;
  rafId = requestAnimationFrame(() => {
    rafId = null;
    fullSync();
  });
}

/**
 * 停止同步
 */
export function stopStoreSync() {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

/**
 * 进入高频交互模式（如拖动手柄）：之后所有 store 变化都不再触发 fullSync 调度，
 * 调用方负责通过 unityBridge.updateNode 推增量同步。
 * 同时取消任何 pending 的 fullSync 调度，避免拖动开始瞬间被旧调度干扰。
 */
export function beginInteractiveSync() {
  _isInteractive = true;
  if (rafId !== null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

/**
 * 退出高频交互模式：立即做一次 fullSync 兜底，纠正增量同步可能的不一致。
 */
export function endInteractiveSync() {
  if (!_isInteractive) return; // 防重复调用
  _isInteractive = false;
  fullSync();
}

/**
 * 全量同步当前 Page（含所有画板）到 Unity
 * 同步后重新发送选中状态，触发 Unity 回传最新的 nodeBounds
 */
export function fullSync() {
  const state = useEditorStore.getState();
  // 先把顶层镜像 flush 进 pages（避免 active 画板的最新节点没写回）
  const pi = state.pages.findIndex((p) => p.id === state.activePageId);
  if (pi < 0) return;
  const page = state.pages[pi];
  // 临时构造一个 page 副本,让 activeArtboard 的 nodes/rootIds 是镜像的最新值
  const ai = page.artboards.findIndex((a) => a.id === state.activeArtboardId);
  const pageForSync = ai >= 0 ? {
    ...page,
    artboards: page.artboards.map((a, i) => i === ai ? {
      ...a, nodes: state.nodes, rootIds: state.rootIds, sourcePrefabPath: state.sourcePrefabPath,
    } : a),
  } : page;

  const json = exportPageForUnity(pageForSync, {
    canvasWidth: state.previewWidth,
    canvasHeight: state.previewHeight,
  });
  unityBridge.syncFullTree(json);

  // 重新发送选中节点，让 Unity 重新计算并回传选中框的屏幕坐标
  if (state.selectedIds.length > 0) {
    unityBridge.setSelection(state.selectedIds);
  }
}

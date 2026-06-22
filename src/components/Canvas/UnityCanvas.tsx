/**
 * UnityCanvas — Unity WebGL 画布容器（替代 Konva EditorCanvas）
 * 负责 WebGL 加载、画布导航、拖放处理、工具栏覆盖层
 */
import { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import unityBridge from '../../services/UnityBridge';
import { startStoreSync, stopStoreSync } from '../../services/StoreSync';
import SelectionOverlay from './SelectionOverlay';
import AnnotationOverlay from './AnnotationOverlay';
import ArtboardsOverlay from './ArtboardsOverlay';
import ArtboardSidebarOverlay from './ArtboardSidebarOverlay';
import type { PreviewDraft } from './AnnotationOverlay';
import AnnotationModeBar from './AnnotationModeBar';
import UEExportDialog from '../Panels/UEExportDialog';
import AnnotationListDialog from '../Panels/AnnotationListDialog';
import TextInlineEditor from './TextInlineEditor';
import SceneToolbar from './SceneToolbar';
import { useEditorStore } from '../../stores/editorStore';
import { useShallow } from 'zustand/react/shallow';
import { DESIGN_WIDTH, DESIGN_HEIGHT, DEFAULT_PREVIEW_WIDTH, DEFAULT_PREVIEW_HEIGHT } from '../../config/assetPaths';
import { getAdaptedAbsolutePosition } from '../../utils/anchorAdapt';
import { importPsd } from '../../utils/importPsd';
import { registerDropTarget } from '../../utils/customDrag';
import { fetchPrefabTemplate, importPrefabTemplateNode } from '../../utils/importPrefabTemplate';
import { alignNodes } from '../../App';
import type { NodeBounds } from '../../services/UnityBridge';
import type { UINode } from '../../types';

interface ComponentDragPayload {
  name: string;
  displayName?: string;
  thumbnail: string;
  defaultWidth: number;
  defaultHeight: number;
  relPath?: string;
}

function debugFocusActive(): boolean {
  const until = (window as typeof window & { __UIEDITOR_DEBUG_FOCUS_UNTIL?: number }).__UIEDITOR_DEBUG_FOCUS_UNTIL;
  return typeof until === 'number' && performance.now() < until;
}

/** JS 回退命中检测：遍历整棵节点树，返回最深/最上层有视觉内容的节点 */
function jsHitTest(
  nodes: Record<string, UINode>,
  rootIds: string[],
  designX: number,
  designY: number,
): string | null {
  let result: string | null = null;

  function walk(nodeId: string, parentAbsX: number, parentAbsY: number, layoutOverride?: { x: number; y: number; w?: number; h?: number }, inLayout?: boolean) {
    const node = nodes[nodeId];
    if (!node || !node.visible) return;
    const absX = parentAbsX + (layoutOverride ? layoutOverride.x : node.x);
    const absY = parentAbsY + (layoutOverride ? layoutOverride.y : node.y);
    const actualW = layoutOverride?.w ?? node.width;
    const actualH = layoutOverride?.h ?? node.height;
    const hit = designX >= absX && designX <= absX + actualW &&
        designY >= absY && designY <= absY + actualH;
    if (hit) {
      const isTransparentFrame = node.type === 'frame'
        && (!node.style.backgroundColor || node.style.backgroundColor === 'transparent' || node.style.backgroundOpacity === 0)
        && !node.imageData;
      if (!isTransparentFrame || inLayout) {
        result = nodeId;
      }
    }

    // 始终遍历子节点（子节点可能溢出父节点范围）
    const lg = node.layoutGroup;
    if (lg?.enabled && lg.layoutType === 'Grid' && node.children.length > 0) {
      const cellW = lg.cellSizeX || 100;
      const cellH = lg.cellSizeY || 100;
      const spX = lg.spacing;
      const spY = lg.spacingY || 0;
      const cols = lg.constraint === 1
        ? Math.max(1, lg.constraintCount || 2)
        : Math.max(1, Math.floor((actualW - lg.padLeft - lg.padRight + spX) / (cellW + spX)));
      let idx = 0;
      for (const childId of node.children) {
        const child = nodes[childId];
        if (!child || !child.visible) continue;
        const col = idx % cols;
        const row = Math.floor(idx / cols);
        walk(childId, absX, absY, {
          x: lg.padLeft + col * (cellW + spX),
          y: lg.padTop + row * (cellH + spY),
          w: cellW,
          h: cellH,
        }, true);
        idx++;
      }
    } else if (lg?.enabled && node.children.length > 0) {
      const innerW = actualW - lg.padLeft - lg.padRight;
      const innerH = actualH - lg.padTop - lg.padBottom;
      let cursor = lg.isHorizontal ? lg.padLeft : lg.padTop;
      for (const childId of node.children) {
        const child = nodes[childId];
        if (!child || !child.visible) continue;
        const cw = lg.isHorizontal ? child.width : (lg.childControlWidth ? innerW : child.width);
        const ch = lg.isHorizontal ? (lg.childControlHeight ? innerH : child.height) : child.height;
        const align = lg.childAlignment || 0;
        const alignCol = align % 3;
        const alignRow = Math.floor(align / 3);
        let cx: number, cy: number;
        if (lg.isHorizontal) {
          cx = cursor;
          const extraY = innerH - ch;
          cy = lg.padTop + (alignRow === 0 ? 0 : alignRow === 1 ? extraY / 2 : extraY);
        } else {
          const extraX = innerW - cw;
          cx = lg.padLeft + (alignCol === 0 ? 0 : alignCol === 1 ? extraX / 2 : extraX);
          cy = cursor;
        }
        walk(childId, absX, absY, { x: cx, y: cy, w: cw, h: ch }, true);
        cursor += (lg.isHorizontal ? cw : ch) + lg.spacing;
      }
    } else {
      for (const childId of node.children) {
        walk(childId, absX, absY, undefined, inLayout);
      }
    }
  }
  for (const rootId of rootIds) {
    walk(rootId, 0, 0);
  }
  return result;
}

/** 框选：返回完全落在矩形内的"最浅一层"可见节点 id 列表（自顶向下，命中即停） */
function jsRectSelect(
  nodes: Record<string, UINode>,
  rootIds: string[],
  rectMinX: number,
  rectMinY: number,
  rectMaxX: number,
  rectMaxY: number,
): string[] {
  const result: string[] = [];

  function walk(nodeId: string, parentAbsX: number, parentAbsY: number, layoutOverride?: { x: number; y: number; w?: number; h?: number }) {
    const node = nodes[nodeId];
    if (!node || !node.visible) return;
    const absX = parentAbsX + (layoutOverride ? layoutOverride.x : node.x);
    const absY = parentAbsY + (layoutOverride ? layoutOverride.y : node.y);
    const w = layoutOverride?.w ?? node.width;
    const h = layoutOverride?.h ?? node.height;

    const fullyInside = absX >= rectMinX && absY >= rectMinY && absX + w <= rectMaxX && absY + h <= rectMaxY;
    if (fullyInside) {
      result.push(nodeId);
      return; // 命中即停，不再选其子节点
    }

    // 未被完全包含 → 下钻，子节点可能单独被框中
    const lg = node.layoutGroup;
    if (lg?.enabled && lg.layoutType === 'Grid' && node.children.length > 0) {
      const cellW = lg.cellSizeX || 100;
      const cellH = lg.cellSizeY || 100;
      const spX = lg.spacing;
      const spY = lg.spacingY || 0;
      const cols = lg.constraint === 1
        ? Math.max(1, lg.constraintCount || 2)
        : Math.max(1, Math.floor((w - lg.padLeft - lg.padRight + spX) / (cellW + spX)));
      let idx = 0;
      for (const childId of node.children) {
        const child = nodes[childId];
        if (!child || !child.visible) continue;
        const col = idx % cols;
        const row = Math.floor(idx / cols);
        walk(childId, absX, absY, { x: lg.padLeft + col * (cellW + spX), y: lg.padTop + row * (cellH + spY), w: cellW, h: cellH });
        idx++;
      }
    } else if (lg?.enabled && node.children.length > 0) {
      const innerW = w - lg.padLeft - lg.padRight;
      const innerH = h - lg.padTop - lg.padBottom;
      let cursor = lg.isHorizontal ? lg.padLeft : lg.padTop;
      for (const childId of node.children) {
        const child = nodes[childId];
        if (!child || !child.visible) continue;
        const cw = lg.isHorizontal ? child.width : (lg.childControlWidth ? innerW : child.width);
        const ch = lg.isHorizontal ? (lg.childControlHeight ? innerH : child.height) : child.height;
        const align = lg.childAlignment || 0;
        const alignCol = align % 3;
        const alignRow = Math.floor(align / 3);
        let cx: number, cy: number;
        if (lg.isHorizontal) {
          cx = cursor;
          const extraY = innerH - ch;
          cy = lg.padTop + (alignRow === 0 ? 0 : alignRow === 1 ? extraY / 2 : extraY);
        } else {
          const extraX = innerW - cw;
          cx = lg.padLeft + (alignCol === 0 ? 0 : alignCol === 1 ? extraX / 2 : extraX);
          cy = cursor;
        }
        walk(childId, absX, absY, { x: cx, y: cy, w: cw, h: ch });
        cursor += (lg.isHorizontal ? cw : ch) + lg.spacing;
      }
    } else {
      for (const childId of node.children) {
        walk(childId, absX, absY);
      }
    }
  }

  for (const rootId of rootIds) walk(rootId, 0, 0);
  return result;
}

// 把 Unity canvas 按当前 active 画板区域 (previewWidth × previewHeight) 裁剪
// canvas CSS 显示尺寸 = container 100%；Unity 渲染分辨率（canvas.width/height）可能不同
// active 画板 CSS 位置：left=canvasX+abX*canvasScale, top=canvasY+abY*canvasScale, w=previewWidth*canvasScale, h=previewHeight*canvasScale
// 输出 canvas 始终 = 设计画布尺寸 (previewWidth × previewHeight)，让导出 PNG 分辨率与设计稿一致
export function cropCanvasToDesignArea(c: HTMLCanvasElement): HTMLCanvasElement | null {
  const st = useEditorStore.getState();
  const rect = c.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  const sxRatio = c.width / rect.width;
  const syRatio = c.height / rect.height;
  // 找 active 画板的位置(画布世界坐标)
  const page = st.pages.find((p) => p.id === st.activePageId);
  const activeAb = page?.artboards.find((a) => a.id === st.activeArtboardId);
  const abX = activeAb?.x ?? 0;
  const abY = activeAb?.y ?? 0;
  // CSS 像素中的设计画布矩形（截 active 画板范围）
  const cssX = st.canvasX + abX * st.canvasScale;
  const cssY = st.canvasY + abY * st.canvasScale;
  const cssW = st.previewWidth * st.canvasScale;
  const cssH = st.previewHeight * st.canvasScale;
  // 转 Unity canvas 像素并裁剪到 [0, canvas.width/height]
  let sx = Math.max(0, Math.floor(cssX * sxRatio));
  let sy = Math.max(0, Math.floor(cssY * syRatio));
  let sw = Math.min(c.width - sx, Math.ceil(cssW * sxRatio));
  let sh = Math.min(c.height - sy, Math.ceil(cssH * syRatio));
  if (sw <= 0 || sh <= 0) return null;
  // 输出始终为设计画布尺寸（如 1920×1080），与画布预设分辨率保持一致
  const out = document.createElement('canvas');
  out.width = st.previewWidth;
  out.height = st.previewHeight;
  const ctx = out.getContext('2d');
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  // 灰度模式: 利用 canvas filter 在 drawImage 时直接转灰度
  if (st.grayscaleMode) ctx.filter = 'grayscale(1)';
  ctx.drawImage(c, sx, sy, sw, sh, 0, 0, out.width, out.height);
  return out;
}

// WebGL build 文件路径
const WEBGL_BASE = '/unity';

// 标尺常量
const RULER_SIZE = 24;
const RULER_BG = '#1e1e2e';
const RULER_TEXT = '#6c7086';
const RULER_TICK = '#45475a';
const RULER_SEL = 'rgba(76,126,243,0.25)';
const RULER_MOUSE = '#f38ba8';
const LOADER_URL = `${WEBGL_BASE}/Build/unity.loader.js`;
const BUILD_CONFIG = {
  dataUrl: `${WEBGL_BASE}/Build/unity.data`,
  frameworkUrl: `${WEBGL_BASE}/Build/unity.framework.js`,
  codeUrl: `${WEBGL_BASE}/Build/unity.wasm`,
  streamingAssetsUrl: `${WEBGL_BASE}/StreamingAssets`,
};

// 分辨率预设
const RESOLUTION_PRESETS = [
  { w: DEFAULT_PREVIEW_WIDTH, h: DEFAULT_PREVIEW_HEIGHT, label: `${DEFAULT_PREVIEW_WIDTH}×${DEFAULT_PREVIEW_HEIGHT} (默认)` },
  { w: DESIGN_WIDTH, h: DESIGN_HEIGHT, label: `${DESIGN_WIDTH}×${DESIGN_HEIGHT} (横屏基准)` },
  { w: 1334, h: 750, label: '1334×750 (iPhone)' },
  { w: 2560, h: 1440, label: '2560×1440 (QHD)' },
];

function getPreviewFitTransform(rect: DOMRect, width: number, height: number, artboardX = 0, artboardY = 0) {
  const scaleX = rect.width / width;
  const scaleY = rect.height / height;
  const scale = Math.min(scaleX, scaleY) * 0.9;
  return {
    x: (rect.width - width * scale) / 2 - artboardX * scale,
    y: (rect.height - height * scale) / 2 - artboardY * scale,
    scale,
  };
}

function getPreviewContentScale(width: number, height: number) {
  const sx = width > 0 ? width / DESIGN_WIDTH : 1;
  const sy = height > 0 ? height / DESIGN_HEIGHT : 1;
  const scale = Math.min(sx, sy);
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

function getCameraTransform(
  rect: DOMRect,
  unityRenderHeight: number,
  canvasX: number,
  canvasY: number,
  canvasScale: number,
  previewWidth: number,
  previewHeight: number,
) {
  // WebGL 端 SetCanvasSize 仍会把 ContentRoot 按预览分辨率相对 1920x1080 缩放。
  // 相机反向补偿这层内部缩放，保证最终屏幕比例仍等于 React 的 canvasScale。
  const screenScale = canvasScale > 0 ? canvasScale : 1;
  const contentScale = getPreviewContentScale(previewWidth, previewHeight);
  const cameraScale = screenScale / contentScale;
  return {
    x: (rect.width / 2 - canvasX) / cameraScale,
    y: -(rect.height / 2 - canvasY) / cameraScale,
    zoom: cameraScale * (unityRenderHeight / rect.height),
  };
}


export default function UnityCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [ueDialogOpen, setUeDialogOpen] = useState(false);
  const [annListOpen, setAnnListOpen] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [nodeBounds, setNodeBounds] = useState<NodeBounds[]>([]);
  const [mousePos, setMousePos] = useState<{ x: number; y: number } | null>(null);

  // 测量尺状态
  const measureRef = useRef<{ startX: number; startY: number; measuring: boolean } | null>(null);
  const annDraftRef = useRef<{ startDesign: { x: number; y: number }; type: 'arrow' | 'rect' | 'dimension' } | null>(null);
  const flowLineDraftSrcPageRef = useRef<string | null>(null);
  const dblClickRef = useRef<{ nodeId: string; time: number } | null>(null);
  const [measureRect, setMeasureRect] = useState<{ sx: number; sy: number; ex: number; ey: number } | null>(null);
  const [previewDraft, setPreviewDraft] = useState<PreviewDraft | null>(null);

  // 参考线（PS 风格 guide lines）
  const [guides, setGuides] = useState<{ id: number; axis: 'h' | 'v'; designPos: number }[]>([]);
  const guideIdCounter = useRef(0);
  const guideDragRef = useRef<{
    axis: 'h' | 'v';
    existingId?: number; // 拖拽已有参考线时的 id
    startClientPos: number;
  } | null>(null);
  const [guideDragPos, setGuideDragPos] = useState<{ axis: 'h' | 'v'; screenPos: number } | null>(null);

  // 标尺
  const hRulerRef = useRef<HTMLCanvasElement>(null);
  const vRulerRef = useRef<HTMLCanvasElement>(null);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });

  // 平移/缩放状态
  const panRef = useRef<{ isPanning: boolean; startX: number; startY: number } | null>(null);
  const spaceHeld = useRef(false);

  // Store 状态
  const selectedIds = useEditorStore((s) => s.selectedIds);
  // 不再订阅整个 nodes 表：拖动节点会让整个 UnityCanvas re-render，
  // 进而让 ruler canvas 每帧重绘。改为只订阅选中节点（在下方算 overlayBounds 用）。
  const selectedNodes = useEditorStore(useShallow((s) => {
    return s.selectedIds.map((id) => s.nodes[id]).filter(Boolean);
  }));
  const addNode = useEditorStore((s) => s.addNode);
  const canvasX = useEditorStore((s) => s.canvasX);
  const canvasY = useEditorStore((s) => s.canvasY);
  const canvasScale = useEditorStore((s) => s.canvasScale);
  const setCanvasTransform = useEditorStore((s) => s.setCanvasTransform);
  const previewWidth = useEditorStore((s) => s.previewWidth);
  const previewHeight = useEditorStore((s) => s.previewHeight);
  const setPreviewResolution = useEditorStore((s) => s.setPreviewResolution);
  const rulersVisible = useEditorStore((s) => s.rulersVisible);
  const tool = useEditorStore((s) => s.tool);
  const sceneTool = useEditorStore((s) => s.sceneTool);
  const editingTextId = useEditorStore((s) => s.editingTextId);
  const annotationTool = useEditorStore((s) => s.annotationTool);
  const setAnnotationTool = useEditorStore((s) => s.setAnnotationTool);
  const annotationLayerVisible = useEditorStore((s) => s.annotationLayerVisible);
  const toggleAnnotationLayer = useEditorStore((s) => s.toggleAnnotationLayer);
  const grayscaleMode = useEditorStore((s) => s.grayscaleMode);
  const toggleGrayscaleMode = useEditorStore((s) => s.toggleGrayscaleMode);

  // 从 store 计算 SelectionOverlay 的屏幕坐标（跟随 canvasX/canvasY/canvasScale 缩放）
  // 注意：节点 x/y 是画板内本地坐标，要加上 active artboard 的 (x, y) 偏移
  const activePage = useEditorStore((s) => s.pages.find((p) => p.id === s.activePageId));
  const activeArtboardId = useEditorStore((s) => s.activeArtboardId);
  const activeArtboard = activePage?.artboards.find((a) => a.id === activeArtboardId);
  const artboardOffX = activeArtboard?.x ?? 0;
  const artboardOffY = activeArtboard?.y ?? 0;

  const overlayBounds = useMemo<NodeBounds[]>(() => {
    const fullNodes = useEditorStore.getState().nodes;
    return selectedNodes.map((node) => {
      const adapted = getAdaptedAbsolutePosition(node.id, fullNodes, previewWidth, previewHeight);
      return {
        id: node.id,
        x: canvasX + (artboardOffX + adapted.x) * canvasScale,
        y: canvasY + (artboardOffY + adapted.y) * canvasScale,
        width: adapted.width * canvasScale,
        height: adapted.height * canvasScale,
      };
    });
  }, [selectedNodes, canvasX, canvasY, canvasScale, artboardOffX, artboardOffY, previewWidth, previewHeight]);

  const align = useCallback((mode: Parameters<typeof alignNodes>[0]) => alignNodes(mode), []);

  // 工具被清空时同步清 flowLineDraftSrcPageRef + preview ghost
  useEffect(() => {
    if (!annotationTool) {
      flowLineDraftSrcPageRef.current = null;
      setPreviewDraft(null);
    }
  }, [annotationTool]);

  // ======== 加载 Unity WebGL ========
  useEffect(() => {
    if (!canvasRef.current) return;
    let mounted = true;

    async function init() {
      try {
        // 先检测 framework 文件是否存在，避免长时间等待
        const checkResp = await fetch(BUILD_CONFIG.frameworkUrl, { method: 'HEAD' });
        if (!checkResp.ok) {
          throw new Error(`Unity Build 文件不存在: ${BUILD_CONFIG.frameworkUrl} (${checkResp.status})`);
        }

        unityBridge.onNodeBounds((bounds) => {
          if (mounted) setNodeBounds(bounds);
        });

        await unityBridge.load(
          canvasRef.current!,
          LOADER_URL,
          BUILD_CONFIG,
          (p) => { if (mounted) setProgress(p); }
        );

        if (!mounted) return;

        unityBridge.setBaseUrl(window.location.origin);
        setLoading(false);

        // 等待 Unity 端完全初始化后再同步
        await new Promise((r) => setTimeout(r, 500));
        if (!mounted) return;

        try {
          startStoreSync();
        } catch (syncErr) {
          console.warn('[UnityCanvas] 首次同步失败，重试...', syncErr);
          await new Promise((r) => setTimeout(r, 1000));
          if (mounted) startStoreSync();
        }

        // 初始居中 — 同步到 store，相机同步 useEffect 会自动推送到 Unity
        if (containerRef.current && !debugFocusActive()) {
          const rect = containerRef.current.getBoundingClientRect();
          const st = useEditorStore.getState();
          const page = st.pages.find((p) => p.id === st.activePageId);
          const activeArtboard = page?.artboards.find((a) => a.id === st.activeArtboardId);
          const fit = getPreviewFitTransform(rect, st.previewWidth, st.previewHeight, activeArtboard?.x ?? 0, activeArtboard?.y ?? 0);
          setCanvasTransform(fit.x, fit.y, fit.scale);
        }
      } catch (e: any) {
        if (mounted) {
          console.error('[UnityCanvas] 加载错误:', e);
          setError(e.message || String(e) || 'Unity WebGL 加载失败');
          setLoading(false);
        }
      }
    }

    init();

    return () => {
      mounted = false;
      stopStoreSync();
      unityBridge.destroy();
    };
  }, []);

  // ======== WebGL 上下文丢失检测 & 自动恢复 ========
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let recovering = false;

    async function recover() {
      if (recovering || loading || unityBridge.isReloading) return;
      if (!unityBridge.isContextLost()) return;
      recovering = true;
      console.warn('[UnityCanvas] WebGL context lost, 正在恢复...');
      setRecovering(true);
      try {
        stopStoreSync();
        await unityBridge.reload((p) => setProgress(p));
        unityBridge.setBaseUrl(window.location.origin);
        await new Promise((r) => setTimeout(r, 300));
        startStoreSync();
        // 恢复相机
        if (containerRef.current) {
          const rect = containerRef.current.getBoundingClientRect();
          const { canvasX, canvasY, canvasScale, previewWidth, previewHeight } = useEditorStore.getState();
          const unityH = canvasRef.current?.height || rect.height;
          const cam = getCameraTransform(rect, unityH, canvasX, canvasY, canvasScale, previewWidth, previewHeight);
          unityBridge.setCamera(cam.x, cam.y, cam.zoom);
        }
        console.log('[UnityCanvas] WebGL 恢复完成');
      } catch (e: any) {
        console.error('[UnityCanvas] WebGL 恢复失败:', e);
        setError(e.message || 'WebGL 恢复失败');
      } finally {
        setRecovering(false);
        recovering = false;
      }
    }

    const onContextLost = (e: Event) => {
      e.preventDefault();
      console.warn('[UnityCanvas] webglcontextlost event');
    };

    const onContextRestored = () => {
      console.log('[UnityCanvas] webglcontextrestored event');
      recover();
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        setTimeout(() => recover(), 200);
      }
    };

    canvas.addEventListener('webglcontextlost', onContextLost);
    canvas.addEventListener('webglcontextrestored', onContextRestored);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      canvas.removeEventListener('webglcontextlost', onContextLost);
      canvas.removeEventListener('webglcontextrestored', onContextRestored);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [loading]);

  // ======== 同步相机到 Unity ========
  // 将 React 的 canvasX/canvasY/canvasScale 转换为 Unity 正交相机参数。
  // HTML 覆盖层、画板和标尺都按屏幕缩放 canvasScale 绘制。
  // WebGL 端 ContentRoot 还会按 preview/contentScale 缩放一次，所以相机使用
  // cameraScale = canvasScale / contentScale 抵消这层内部缩放。
  //   world_x = (containerW/2 - canvasX) / cameraScale
  //   world_y = -(containerH/2 - canvasY) / cameraScale
  //   zoom    = cameraScale * (unityRenderH / cssH)     → 修正 Unity 渲染分辨率与 CSS 尺寸的差异
  //             CameraController: orthoSize = Screen.height/2/zoom
  //             我们希望 ContentRoot 缩放后最终等价于 cssH/2/canvasScale
  useEffect(() => {
    if (!loading && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      // Unity WebGL 默认渲染分辨率（如 960×600）可能与 CSS 容器尺寸不同
      // canvas.height = Unity 的 Screen.height；rect.height = CSS 显示高度
      const unityH = canvasRef.current?.height || rect.height;
      const cam = getCameraTransform(rect, unityH, canvasX, canvasY, canvasScale, previewWidth, previewHeight);
      unityBridge.setCamera(cam.x, cam.y, cam.zoom);
    }
    // containerSize 是依赖：Tab 切换/面板折叠改变容器尺寸时，相机投影中心需同步
  }, [canvasX, canvasY, canvasScale, previewWidth, previewHeight, loading, containerSize.width, containerSize.height]);

  // ======== 切换分辨率时自动适配画布（fit to view） ========
  useEffect(() => {
    if (loading || !containerRef.current) return;
    if (debugFocusActive()) return;
    const rect = containerRef.current.getBoundingClientRect();
    const st = useEditorStore.getState();
    const page = st.pages.find((p) => p.id === st.activePageId);
    const activeArtboard = page?.artboards.find((a) => a.id === st.activeArtboardId);
    const fit = getPreviewFitTransform(rect, previewWidth, previewHeight, activeArtboard?.x ?? 0, activeArtboard?.y ?? 0);
    setCanvasTransform(fit.x, fit.y, fit.scale);
  }, [loading, previewWidth, previewHeight, activeArtboardId, setCanvasTransform]);

  // ======== 平移 & 点击选中 ========
  const handlePointerDown = useCallback(async (e: React.PointerEvent) => {
    // 忽略工具栏按钮/控件上的点击，避免意外清空选中
    if ((e.target as HTMLElement).closest('button, select, input, textarea')) return;

    // 忽略 SelectionOverlay 拖拽手柄上的点击，由 overlay 自行处理
    if ((e.target as HTMLElement).closest('[data-drag-handle]')) return;

    // 忽略画板标题栏上的点击，由 ArtboardsOverlay 自行处理（拖板、选板、改名）
    if ((e.target as HTMLElement).closest('[data-artboard-title]')) return;

    // 任意 contenteditable 区域内的点击都跳过(富文本编辑器等模态弹窗用)
    if ((e.target as HTMLElement).closest('[contenteditable="true"]')) return;

    // 批注工具激活时,优先处理批注创建
    const stCheck = useEditorStore.getState();
    const annTool = stCheck.annotationTool;
    if (annTool && e.button === 0 && canvasRef.current) {
      // 点击命中已有批注 (svg <g> / <rect>) 时让 overlay 处理(选中/双击编辑),不要创建新批注
      if ((e.target as HTMLElement).closest('[data-annotation-glyph]')) return;
      e.preventDefault();
      e.stopPropagation();
      const rect = canvasRef.current.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const designX = (sx - stCheck.canvasX) / stCheck.canvasScale;
      const designY = (sy - stCheck.canvasY) / stCheck.canvasScale;
      if (annTool === 'flow-line') {
        // 找点击落在哪个画板内,用画板本地坐标命中节点
        const pageObj = stCheck.pages.find((p) => p.id === stCheck.activePageId);
        let hitId: string | null = null;
        let hitArtboardId: string | null = null;
        if (pageObj) {
          for (const ab of pageObj.artboards) {
            if (designX >= ab.x && designX <= ab.x + stCheck.previewWidth && designY >= ab.y && designY <= ab.y + stCheck.previewHeight) {
              const localX = designX - ab.x;
              const localY = designY - ab.y;
              const useNodes = ab.id === stCheck.activeArtboardId ? stCheck.nodes : ab.nodes;
              const useRoots = ab.id === stCheck.activeArtboardId ? stCheck.rootIds : ab.rootIds;
              hitId = jsHitTest(useNodes, useRoots, localX, localY);
              if (hitId) { hitArtboardId = ab.id; break; }
              // 即使没命中节点,也记下落在哪个画板上(允许"画板→画板"流程线)
              if (!hitArtboardId) hitArtboardId = ab.id;
            }
          }
        }
        if (!hitId) {
          stCheck.setAnnotationHint('需要点击一个 UI 节点', 1500);
          return;
        }
        const draftSrcId = stCheck.flowLineDraftSrcId;
        const draftSrcPage = flowLineDraftSrcPageRef.current;
        // 命中节点的画板不是 active → 切过去再继续
        if (hitArtboardId && hitArtboardId !== stCheck.activeArtboardId) {
          stCheck.setActiveArtboard(hitArtboardId);
        }
        if (!draftSrcId) {
          stCheck.setFlowLineDraftSrcId(hitId);
          flowLineDraftSrcPageRef.current = stCheck.activePageId;
        } else {
          const dstPageId = stCheck.activePageId;
          const isCrossPage = draftSrcPage !== null && draftSrcPage !== dstPageId;
          if (isCrossPage && draftSrcPage) {
            stCheck.switchPage(draftSrcPage);
            const stSrc = useEditorStore.getState();
            stSrc.addAnnotation('flow-line', 0, 0, {
              refNodeId: draftSrcId,
              refPageId: dstPageId,
              text: hitId,
            });
            stSrc.switchPage(dstPageId);
          } else {
            stCheck.addAnnotation('flow-line', 0, 0, {
              refNodeId: draftSrcId,
              text: hitId,
            });
          }
          // 清起点,但保留工具激活
          stCheck.setFlowLineDraftSrcId(null);
          flowLineDraftSrcPageRef.current = null;
        }
        return;
      }
      if (annTool === 'text' || annTool === 'number') {
        // 点击型 - 创建后保持工具激活
        const id = stCheck.addAnnotation(annTool, designX - (annTool === 'number' ? 14 : 60), designY - 14);
        stCheck.setSelectedAnnotationIds([id]);
        // 不退出工具,可继续连画
      } else {
        // 拖拽型 (arrow / rect / dimension)
        annDraftRef.current = { startDesign: { x: designX, y: designY }, type: annTool };
        setPreviewDraft({
          type: annTool,
          startScreen: { x: sx, y: sy },
          currentScreen: { x: sx, y: sy },
          color: '#f38ba8',
        });
      }
      return;
    }

    // 中键 或 Space+左键 或 Hand 工具左键 → 平移
    const isHandTool = useEditorStore.getState().sceneTool === 'hand';
    if (e.button === 1 || (e.button === 0 && (spaceHeld.current || isHandTool))) {
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      panRef.current = { isPanning: true, startX: e.clientX, startY: e.clientY };
      if (containerRef.current) containerRef.current.style.cursor = 'grabbing';
      return;
    }

    // 左键 → 记录起点，等 pointerUp/pointerMove 决定是选中还是测量
    if (e.button === 0 && !loading && canvasRef.current) {
      const currentTool = useEditorStore.getState().tool;

      // frame / text / image 工具：创建节点，有选中节点时作为其子节点
      if (currentTool !== 'select') {
        const rect = canvasRef.current.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const st = useEditorStore.getState();
        const designX = (x - st.canvasX) / st.canvasScale;
        const designY = (y - st.canvasY) / st.canvasScale;
        const parentId = st.selectedIds.length === 1 ? st.selectedIds[0] : undefined;
        // 子节点坐标相对于父节点
        let localX = designX, localY = designY;
        if (parentId) {
          const parent = st.nodes[parentId];
          if (parent) {
            let ax = parent.x, ay = parent.y;
            let pid = parent.parentId;
            while (pid && st.nodes[pid]) { ax += st.nodes[pid].x; ay += st.nodes[pid].y; pid = st.nodes[pid].parentId; }
            localX = designX - ax;
            localY = designY - ay;
          }
        }
        const newId = st.addNode(currentTool, localX, localY, parentId ? { parentId } : undefined);
        st.setSelectedIds([newId]);
        st.setTool('select');
        return;
      }

      // select 工具：记录起点，延迟判断
      measureRef.current = { startX: e.clientX, startY: e.clientY, measuring: false };
    }
  }, [loading]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    // 批注 preview 更新
    {
      const stPv = useEditorStore.getState();
      const annTool = stPv.annotationTool;
      if (annTool && canvasRef.current) {
        const rect = canvasRef.current.getBoundingClientRect();
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;
        const draft = annDraftRef.current;
        const flowSrc = stPv.flowLineDraftSrcId;

        if (draft && (annTool === 'arrow' || annTool === 'rect' || annTool === 'dimension')) {
          const startSx = stPv.canvasX + draft.startDesign.x * stPv.canvasScale;
          const startSy = stPv.canvasY + draft.startDesign.y * stPv.canvasScale;
          setPreviewDraft({
            type: annTool,
            startScreen: { x: startSx, y: startSy },
            currentScreen: { x: sx, y: sy },
            color: '#f38ba8',
          });
        }
        else if (annTool === 'flow-line' && flowSrc) {
          const worldX = (sx - stPv.canvasX) / stPv.canvasScale;
          const worldY = (sy - stPv.canvasY) / stPv.canvasScale;
          // 找鼠标落在哪个画板内,用画板本地坐标命中
          const pageObj = stPv.pages.find((p) => p.id === stPv.activePageId);
          let hoverId: string | undefined;
          if (pageObj) {
            for (const ab of pageObj.artboards) {
              if (worldX >= ab.x && worldX <= ab.x + stPv.previewWidth && worldY >= ab.y && worldY <= ab.y + stPv.previewHeight) {
                const localX = worldX - ab.x;
                const localY = worldY - ab.y;
                const useNodes = ab.id === stPv.activeArtboardId ? stPv.nodes : ab.nodes;
                const useRoots = ab.id === stPv.activeArtboardId ? stPv.rootIds : ab.rootIds;
                hoverId = jsHitTest(useNodes, useRoots, localX, localY) || undefined;
                break;
              }
            }
          }
          setPreviewDraft({
            type: 'flow-line',
            currentScreen: { x: sx, y: sy },
            flowLineSrcId: flowSrc,
            flowLineHoverDstId: hoverId && hoverId !== flowSrc ? hoverId : undefined,
            color: '#f9e2af',
          });
        }
        else if (annTool === 'text' || annTool === 'number') {
          setPreviewDraft({
            type: annTool,
            currentScreen: { x: sx, y: sy },
            color: '#f38ba8',
          });
        }
        else if (annTool === 'flow-line' && !flowSrc) {
          setPreviewDraft((prev) => (prev ? null : prev));
        }
      } else {
        setPreviewDraft((prev) => (prev ? null : prev));
      }
    }
    if (panRef.current?.isPanning) {
      const dx = e.clientX - panRef.current.startX;
      const dy = e.clientY - panRef.current.startY;
      panRef.current.startX = e.clientX;
      panRef.current.startY = e.clientY;
      setCanvasTransform(canvasX + dx, canvasY + dy, canvasScale);
      return;
    }
    // 参考线拖拽
    if (guideDragRef.current) {
      const containerRect = containerRef.current?.getBoundingClientRect();
      if (containerRect) {
        const pos = guideDragRef.current.axis === 'h'
          ? e.clientY - containerRect.top
          : e.clientX - containerRect.left;
        setGuideDragPos({ axis: guideDragRef.current.axis, screenPos: pos });
      }
      return;
    }
    // 测量尺：拖拽超过阈值后启动
    if (measureRef.current) {
      const dx = e.clientX - measureRef.current.startX;
      const dy = e.clientY - measureRef.current.startY;
      if (!measureRef.current.measuring && (Math.abs(dx) + Math.abs(dy)) > 5) {
        measureRef.current.measuring = true;
      }
      if (measureRef.current.measuring) {
        setMeasureRect({
          sx: measureRef.current.startX,
          sy: measureRef.current.startY,
          ex: e.clientX,
          ey: e.clientY,
        });
      }
    }
  }, [canvasX, canvasY, canvasScale, setCanvasTransform]);

  const handlePointerUp = useCallback(async (e: React.PointerEvent) => {
    if (panRef.current?.isPanning) {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      panRef.current = null;
      if (containerRef.current) {
        containerRef.current.style.cursor = spaceHeld.current ? 'grab' : '';
      }
      return;
    }
    // 批注拖拽创建完成
    if (annDraftRef.current && canvasRef.current) {
      const draft = annDraftRef.current;
      annDraftRef.current = null;
      setPreviewDraft(null);
      const rect = canvasRef.current.getBoundingClientRect();
      const st = useEditorStore.getState();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const endDesign = { x: (sx - st.canvasX) / st.canvasScale, y: (sy - st.canvasY) / st.canvasScale };
      const dx = endDesign.x - draft.startDesign.x;
      const dy = endDesign.y - draft.startDesign.y;
      // 阈值改成屏幕像素 4px(反推回设计像素)
      const screenMin = 4;
      const designMin = screenMin / st.canvasScale;
      if (Math.abs(dx) < designMin && Math.abs(dy) < designMin) {
        // 不达阈值,不创建,但工具保持激活
        return;
      }
      let id: string;
      if (draft.type === 'arrow' || draft.type === 'dimension') {
        id = st.addAnnotation(draft.type, draft.startDesign.x, draft.startDesign.y, {
          width: dx,
          height: dy,
          points: [{ x: 0, y: 0 }, { x: dx, y: dy }],
        });
      } else {
        id = st.addAnnotation(draft.type, Math.min(draft.startDesign.x, endDesign.x), Math.min(draft.startDesign.y, endDesign.y), {
          width: Math.abs(dx),
          height: Math.abs(dy),
        });
      }
      st.setSelectedAnnotationIds([id]);
      // 不退出工具,可继续连画
      return;
    }
    // 测量尺 / 点击选择
    if (measureRef.current) {
      if (measureRef.current.measuring) {
        // 拖拽了 → 框选命中（仅在 active 画板内）
        const startX = measureRef.current.startX;
        const startY = measureRef.current.startY;
        measureRef.current = null;
        setMeasureRect(null);
        if (canvasRef.current) {
          const rect = canvasRef.current.getBoundingClientRect();
          const st = useEditorStore.getState();
          const sx1 = startX - rect.left;
          const sy1 = startY - rect.top;
          const sx2 = e.clientX - rect.left;
          const sy2 = e.clientY - rect.top;
          // 屏幕 → 画布世界坐标（画板世界坐标使用当前预览分辨率单位）
          const worldX1 = (Math.min(sx1, sx2) - st.canvasX) / st.canvasScale;
          const worldY1 = (Math.min(sy1, sy2) - st.canvasY) / st.canvasScale;
          const worldX2 = (Math.max(sx1, sx2) - st.canvasX) / st.canvasScale;
          const worldY2 = (Math.max(sy1, sy2) - st.canvasY) / st.canvasScale;
          // 框选范围限定在 active 画板内：把世界坐标换算为画板本地坐标
          const page = st.pages.find((p) => p.id === st.activePageId);
          const activeAb = page?.artboards.find((a) => a.id === st.activeArtboardId);
          const offX = activeAb?.x ?? 0;
          const offY = activeAb?.y ?? 0;
          const dx1 = worldX1 - offX;
          const dy1 = worldY1 - offY;
          const dx2 = worldX2 - offX;
          const dy2 = worldY2 - offY;
          const hits = jsRectSelect(st.nodes, st.rootIds, dx1, dy1, dx2, dy2);
          const setIds = st.setSelectedIds;
          const reveal = st.revealSelectedInLayer;
          if (e.shiftKey) {
            // 追加 / 反选已存在
            const merged = [...st.selectedIds];
            for (const id of hits) {
              const idx = merged.indexOf(id);
              if (idx >= 0) merged.splice(idx, 1);
              else merged.push(id);
            }
            setIds(merged);
          } else {
            setIds(hits);
          }
          if (hits.length > 0) reveal();
        }
      } else {
        // 没拖拽 → 当作点击，做 hitTest 选择
        measureRef.current = null;
        if (canvasRef.current) {
          const rect = canvasRef.current.getBoundingClientRect();
          const x = e.clientX - rect.left;
          const y = e.clientY - rect.top;
          const st = useEditorStore.getState();
          const worldX = (x - st.canvasX) / st.canvasScale;
          const worldY = (y - st.canvasY) / st.canvasScale;

          // 先找落在哪个画板内
          const page = st.pages.find((p) => p.id === st.activePageId);
          let hitArtboard: import('../../types').Artboard | undefined;
          if (page) {
            for (const ab of page.artboards) {
              if (worldX >= ab.x && worldX <= ab.x + st.previewWidth && worldY >= ab.y && worldY <= ab.y + st.previewHeight) {
                hitArtboard = ab;
                break;
              }
            }
          }

          // 在画板内：用画板本地坐标做节点命中
          let nodeId = '';
          if (hitArtboard) {
            const localX = worldX - hitArtboard.x;
            const localY = worldY - hitArtboard.y;
            // 非 active 画板要用 artboard.nodes，active 画板用镜像 st.nodes
            const targetNodes = hitArtboard.id === st.activeArtboardId ? st.nodes : hitArtboard.nodes;
            const targetRootIds = hitArtboard.id === st.activeArtboardId ? st.rootIds : hitArtboard.rootIds;
            nodeId = jsHitTest(targetNodes, targetRootIds, localX, localY) || '';
            // Unity 回退命中暂时只对 active 画板有效（不关键，JS 命中基本够用）
            if (!nodeId && hitArtboard.id === st.activeArtboardId) {
              nodeId = await unityBridge.hitTest(x, y) || '';
            }
            // 命中非 active 画板的节点 → 先切 active 再选节点
            if (hitArtboard.id !== st.activeArtboardId) {
              st.setActiveArtboard(hitArtboard.id);
            }
          }

          const setIds = useEditorStore.getState().setSelectedIds;
          const reveal = useEditorStore.getState().revealSelectedInLayer;
          if ((e.shiftKey || e.ctrlKey || e.metaKey) && nodeId) {
            const current = useEditorStore.getState().selectedIds;
            if (current.includes(nodeId)) {
              setIds(current.filter((id) => id !== nodeId));
            } else {
              setIds([...current, nodeId]);
            }
            reveal();
          } else if (nodeId) {
            setIds([nodeId]);
            reveal();
            // 双击检测：300ms 内同一节点两次点击 → 进入文本编辑
            const now = Date.now();
            const prev = dblClickRef.current;
            if (prev && prev.nodeId === nodeId && now - prev.time < 400) {
              dblClickRef.current = null;
              const n = useEditorStore.getState().nodes[nodeId];
              if (n && n.type === 'text') {
                useEditorStore.getState().setEditingTextId(nodeId);
              }
            } else {
              dblClickRef.current = { nodeId, time: now };
            }
          } else {
            // 点在画板内空白 or 任何画板外 — 清节点选区
            setIds([]);
          }
        }
      }
    }
  }, []);

  const handlePointerCancel = useCallback(() => {
    if (annDraftRef.current) {
      annDraftRef.current = null;
      setPreviewDraft(null);
    }
  }, []);

  // 参考线拖拽：window 级事件（标尺 pointerdown 后拖到画布区域）
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!guideDragRef.current) return;
      const containerRect = containerRef.current?.getBoundingClientRect();
      if (!containerRect) return;
      const pos = guideDragRef.current.axis === 'h'
        ? e.clientY - containerRect.top
        : e.clientX - containerRect.left;
      setGuideDragPos({ axis: guideDragRef.current.axis, screenPos: pos });
    };
    const onUp = (e: PointerEvent) => {
      if (!guideDragRef.current) { return; }
      const containerRect = containerRef.current?.getBoundingClientRect();
      if (containerRect) {
        const { axis, existingId } = guideDragRef.current;
        const screenPos = axis === 'h'
          ? e.clientY - containerRect.top
          : e.clientX - containerRect.left;
        // 设计坐标
        const designPos = axis === 'h'
          ? (screenPos - canvasY) / canvasScale
          : (screenPos - canvasX) / canvasScale;
        // 拖回标尺区域 → 删除
        const inRuler = axis === 'h' ? screenPos < RULER_SIZE : screenPos < RULER_SIZE;
        if (existingId !== undefined) {
          if (inRuler) {
            setGuides((prev) => prev.filter((g) => g.id !== existingId));
          } else {
            setGuides((prev) => prev.map((g) => g.id === existingId ? { ...g, designPos } : g));
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
  }, [canvasX, canvasY, canvasScale]);

  // Space 键监听
  useEffect(() => {
    let lastSpaceUpAt = 0;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat) {
        const tag = document.activeElement?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        spaceHeld.current = true;
        if (containerRef.current) containerRef.current.style.cursor = 'grab';
        // 双击 Space → 视图回到 100% 并居中
        const now = performance.now();
        if (now - lastSpaceUpAt < 300) {
          const rect = containerRef.current?.getBoundingClientRect();
          if (rect) {
            const st = useEditorStore.getState();
            const cx = (rect.width - st.previewWidth) / 2;
            const cy = (rect.height - st.previewHeight) / 2;
            st.setCanvasTransform(cx, cy, 1);
          }
          lastSpaceUpAt = 0;
        }
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        spaceHeld.current = false;
        lastSpaceUpAt = performance.now();
        if (containerRef.current && !panRef.current?.isPanning) {
          containerRef.current.style.cursor = '';
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  // ======== 标尺：容器尺寸监听 ========
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

  // ======== 标尺绘制 ========
  useEffect(() => {
    const { width: cw, height: ch } = containerSize;
    if (cw === 0 || ch === 0) return;

    // 水平标尺
    const hEl = hRulerRef.current;
    if (hEl) {
      if (hEl.width !== cw) hEl.width = cw;
      const ctx = hEl.getContext('2d');
      if (ctx) {
        ctx.clearRect(0, 0, cw, RULER_SIZE);
        ctx.fillStyle = RULER_BG;
        ctx.fillRect(0, 0, cw, RULER_SIZE);
        ctx.strokeStyle = RULER_TICK;
        ctx.beginPath(); ctx.moveTo(0, RULER_SIZE - 1); ctx.lineTo(cw, RULER_SIZE - 1); ctx.stroke();

        // 选中节点范围标识 + 宽度尺寸
        for (let i = 0; i < overlayBounds.length; i++) {
          const b = overlayBounds[i];
          ctx.fillStyle = RULER_SEL;
          ctx.fillRect(b.x, 0, b.width, RULER_SIZE);
          // 宽度数值
          const node = selectedIds[i] ? useEditorStore.getState().nodes[selectedIds[i]] : null;
          if (node && b.width > 20) {
            ctx.fillStyle = '#4C7EF3';
            ctx.font = 'bold 9px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(String(Math.round(node.width)), b.x + b.width / 2, RULER_SIZE - 3);
          }
        }

        // 刻度
        ctx.fillStyle = RULER_TEXT;
        ctx.font = '9px sans-serif';
        ctx.textAlign = 'center';
        const step = canvasScale > 0.3 ? 100 : 200;
        const start = Math.floor(-canvasX / canvasScale / step) * step;
        const end = Math.ceil((cw - canvasX) / canvasScale / step) * step;
        for (let v = start; v <= end; v += step) {
          const sx = canvasX + v * canvasScale;
          if (sx < RULER_SIZE || sx > cw) continue;
          ctx.strokeStyle = RULER_TICK;
          ctx.beginPath(); ctx.moveTo(sx, RULER_SIZE - 8); ctx.lineTo(sx, RULER_SIZE - 1); ctx.stroke();
          ctx.fillStyle = RULER_TEXT;
          ctx.fillText(String(v), sx, RULER_SIZE - 10);
        }

        // 鼠标位置
        if (mousePos) {
          const mx = canvasX + mousePos.x * canvasScale;
          ctx.fillStyle = RULER_MOUSE;
          ctx.fillRect(mx - 0.5, 0, 1, RULER_SIZE);
        }
      }
    }

    // 垂直标尺
    const vEl = vRulerRef.current;
    if (vEl) {
      if (vEl.height !== ch) vEl.height = ch;
      const ctx = vEl.getContext('2d');
      if (ctx) {
        ctx.clearRect(0, 0, RULER_SIZE, ch);
        ctx.fillStyle = RULER_BG;
        ctx.fillRect(0, 0, RULER_SIZE, ch);
        ctx.strokeStyle = RULER_TICK;
        ctx.beginPath(); ctx.moveTo(RULER_SIZE - 1, 0); ctx.lineTo(RULER_SIZE - 1, ch); ctx.stroke();

        // 选中节点范围标识 + 高度尺寸
        for (let i = 0; i < overlayBounds.length; i++) {
          const b = overlayBounds[i];
          ctx.fillStyle = RULER_SEL;
          ctx.fillRect(0, b.y, RULER_SIZE, b.height);
          // 高度数值
          const node = selectedIds[i] ? useEditorStore.getState().nodes[selectedIds[i]] : null;
          if (node && b.height > 20) {
            ctx.save();
            ctx.fillStyle = '#4C7EF3';
            ctx.font = 'bold 9px sans-serif';
            ctx.translate(RULER_SIZE / 2, b.y + b.height / 2);
            ctx.rotate(-Math.PI / 2);
            ctx.textAlign = 'center';
            ctx.fillText(String(Math.round(node.height)), 0, 3);
            ctx.restore();
          }
        }

        // 刻度
        ctx.fillStyle = RULER_TEXT;
        ctx.font = '9px sans-serif';
        const step = canvasScale > 0.3 ? 100 : 200;
        const start = Math.floor(-canvasY / canvasScale / step) * step;
        const end = Math.ceil((ch - canvasY) / canvasScale / step) * step;
        for (let v = start; v <= end; v += step) {
          const sy = canvasY + v * canvasScale;
          if (sy < RULER_SIZE || sy > ch) continue;
          ctx.strokeStyle = RULER_TICK;
          ctx.beginPath(); ctx.moveTo(RULER_SIZE - 8, sy); ctx.lineTo(RULER_SIZE - 1, sy); ctx.stroke();
          ctx.save();
          ctx.translate(RULER_SIZE - 10, sy + 3);
          ctx.rotate(-Math.PI / 2);
          ctx.textAlign = 'center';
          ctx.fillStyle = RULER_TEXT;
          ctx.fillText(String(v), 0, 0);
          ctx.restore();
        }

        // 鼠标位置
        if (mousePos) {
          const my = canvasY + mousePos.y * canvasScale;
          ctx.fillStyle = RULER_MOUSE;
          ctx.fillRect(0, my - 0.5, RULER_SIZE, 1);
        }
      }
    }
  }, [canvasX, canvasY, canvasScale, mousePos, containerSize, overlayBounds]);

  // ======== 鼠标坐标追踪 ========
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = (e.clientX - rect.left - canvasX) / canvasScale;
    const y = (e.clientY - rect.top - canvasY) / canvasScale;
    setMousePos({ x, y });
  }, [canvasX, canvasY, canvasScale]);

  // ======== 原生拖放处理（文件、PSD、外部 URL 拖入）========
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();

    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = (e.clientX - rect.left - canvasX) / canvasScale;
    const y = (e.clientY - rect.top - canvasY) / canvasScale;

    // 1. PSD 文件拖入
    const files = Array.from(e.dataTransfer.files);
    const psdFiles = files.filter((f) => f.name.toLowerCase().endsWith('.psd'));
    if (psdFiles.length > 0) {
      psdFiles.forEach(async (file) => {
        try {
          const result = await importPsd(file);
          console.log(`PSD 导入完成: ${result.name}, ${result.layerCount} 个图层`);
        } catch (err) {
          console.error('PSD 导入失败:', err);
        }
      });
      return;
    }

    // 4. 外部图片文件拖入
    const imageFiles = files.filter((f) => f.type.startsWith('image/'));
    imageFiles.forEach((file, index) => {
      const reader = new FileReader();
      reader.onload = async (ev) => {
        const dataUrl = ev.target?.result as string;
        const img = new window.Image();
        img.onload = async () => {
          const maxSize = 800;
          let w = img.width;
          let h = img.height;
          if (w > maxSize || h > maxSize) {
            const ratio = Math.min(maxSize / w, maxSize / h);
            w = Math.round(w * ratio);
            h = Math.round(h * ratio);
          }
          const name = file.name.replace(/\.[^.]+$/, '');
          // 上传 base64 到临时存储，获取服务器 URL（Unity WebGL 可加载）
          let imageData = dataUrl;
          try {
            const res = await fetch('/api/temp-image', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ dataUrl, name }),
            });
            const result = await res.json();
            if (result.url) imageData = result.url;
          } catch {}
          addNode('image', x + index * 20, y + index * 20, {
            name,
            width: w,
            height: h,
            imageData,
          } as any);
        };
        img.src = dataUrl;
      };
      reader.readAsDataURL(file);
    });

    // 5. 外部 URL 拖入
    if (imageFiles.length === 0) {
      const url = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
      if (url && /\.(png|jpg|jpeg|gif|svg|webp)/i.test(url)) {
        const name = url.split('/').pop()?.replace(/\.[^.]+$/, '') || 'image';
        addNode('image', x, y, {
          name,
          width: 200,
          height: 200,
          imageData: url,
        } as any);
      }
    }
  }, [canvasX, canvasY, canvasScale, addNode]);

  // ======== 自定义拖拽 drop target（组件库/图集库，不触发 OS dragstart，避免 Eagle 拦截）========
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const addComponentPlaceholder = (comp: ComponentDragPayload, x: number, y: number) => {
      const img = new window.Image();
      img.onload = () => {
        addNode('component', x, y, {
          name: `@${comp.name}`,
          width: img.naturalWidth || comp.defaultWidth,
          height: img.naturalHeight || comp.defaultHeight,
          componentRef: comp.name,
        });
      };
      img.onerror = () => {
        addNode('component', x, y, {
          name: `@${comp.name}`,
          width: comp.defaultWidth,
          height: comp.defaultHeight,
          componentRef: comp.name,
        });
      };
      img.src = comp.thumbnail;
    };

    return registerDropTarget({
      element: el,
      onDrop: (type, data, clientX, clientY) => {
        const rect = el.getBoundingClientRect();
        const x = (clientX - rect.left - canvasX) / canvasScale;
        const y = (clientY - rect.top - canvasY) / canvasScale;

        if (type === 'application/component') {
          const comp = data as ComponentDragPayload;
          if (comp.relPath) {
            void (async () => {
              try {
                const parsed = await fetchPrefabTemplate(comp.relPath!, comp.name);
                if (parsed.root) {
                  const store = useEditorStore.getState();
                  const rootId = importPrefabTemplateNode(parsed.root, null, store.addNode, {
                    x,
                    y,
                    name: parsed.name || comp.name,
                  });
                  store.setSelectedIds([rootId]);
                  return;
                }
              } catch (err) {
                console.warn('[component drop] prefab parse failed:', err);
              }
              addComponentPlaceholder(comp, x, y);
            })();
          } else {
            addComponentPlaceholder(comp, x, y);
          }
        } else if (type === 'application/atlas-image') {
          const imgData = data;
          const img = new window.Image();
          img.onload = () => {
            addNode('image', x, y, {
              name: imgData.name,
              width: img.naturalWidth,
              height: img.naturalHeight,
              imageData: imgData.path,
              sliceEnabled: !!imgData.sliceBorder,
              sliceBorder: imgData.sliceBorder || undefined,
            } as any);
          };
          img.onerror = () => {
            addNode('image', x, y, {
              name: imgData.name,
              width: 100,
              height: 100,
              imageData: imgData.path,
              sliceEnabled: !!imgData.sliceBorder,
              sliceBorder: imgData.sliceBorder || undefined,
            } as any);
          };
          img.src = imgData.path;
        }
      },
    });
  }, [canvasX, canvasY, canvasScale, addNode]);

  // 用 ref 绑定 wheel 事件（非 passive，可 preventDefault）
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const { canvasX, canvasY, canvasScale, setCanvasTransform } = useEditorStore.getState();
      const scaleBy = 1.08;
      const direction = e.deltaY < 0 ? 1 : -1;
      const newScale = Math.max(0.1, Math.min(5, canvasScale * (direction > 0 ? scaleBy : 1 / scaleBy)));
      const newX = mouseX - (mouseX - canvasX) * (newScale / canvasScale);
      const newY = mouseY - (mouseY - canvasY) * (newScale / canvasScale);
      setCanvasTransform(newX, newY, newScale);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  return (
    <div
      ref={containerRef}
      data-canvas-container
      className="canvas-area flex-1 bg-[#181825] overflow-hidden relative"
      data-scene-tool={sceneTool}
      style={annotationTool ? { cursor: 'crosshair' } : undefined}
      onPointerDownCapture={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onPointerLeave={handlePointerCancel}
      onMouseMove={handleMouseMove}
      onMouseLeave={() => setMousePos(null)}
      onDrop={handleDrop}
      onDragOver={(e) => e.preventDefault()}
    >
      {/* Unity WebGL Canvas */}
      <canvas
        ref={canvasRef}
        id="unity-canvas"
        className="w-full h-full"
        style={{
          display: loading && error ? 'none' : 'block',
          filter: grayscaleMode ? 'grayscale(1)' : undefined,
        }}
        tabIndex={-1}
      />

      {/* 选中覆盖层 — bounds 来自 Unity 回传（精确），pixelScale 用于拖动期间根据 store delta 实时调整选中框位置 */}
      {!loading && (
        <div className="absolute inset-0 z-10 pointer-events-none">
          <SelectionOverlay bounds={nodeBounds} pixelScale={canvasScale} canvasOffset={{ x: 0, y: 0 }} sceneTool={sceneTool} />
        </div>
      )}

      {/* 批注模式条 - 已移到"📌 批注"按钮下方,见下面工具栏 */}

      {/* 批注覆盖层 — 设计坐标 → 屏幕坐标 = canvasX + designX * canvasScale */}
      {!loading && (
        <div className="absolute inset-0 z-20 pointer-events-none">
          <AnnotationOverlay
            offsetX={canvasX}
            offsetY={canvasY}
            scale={canvasScale}
            effectiveW={previewWidth}
            effectiveH={previewHeight}
            previewDraft={previewDraft ?? undefined}
          />
        </div>
      )}

      {/* 内联文本编辑器 */}
      {editingTextId && (
        <div className="absolute inset-0 z-20 pointer-events-none">
          <TextInlineEditor nodeId={editingTextId} />
        </div>
      )}

      {/* 测量尺 */}
      {measureRect && (() => {
        const containerRect = containerRef.current?.getBoundingClientRect();
        if (!containerRect) return null;
        const left = Math.min(measureRect.sx, measureRect.ex) - containerRect.left;
        const top = Math.min(measureRect.sy, measureRect.ey) - containerRect.top;
        const width = Math.abs(measureRect.ex - measureRect.sx);
        const height = Math.abs(measureRect.ey - measureRect.sy);
        // 换算为设计坐标像素
        const designW = Math.round(width / canvasScale);
        const designH = Math.round(height / canvasScale);
        if (width < 2 && height < 2) return null;
        return (
          <div
            className="absolute z-20 pointer-events-none"
            style={{ left, top, width, height }}
          >
            {/* 虚线矩形 */}
            <div style={{
              position: 'absolute', inset: 0,
              border: '1.5px dashed #f38ba8',
              background: 'rgba(243,139,168,0.06)',
            }} />
            {/* 宽度标注 */}
            {designW > 0 && (
              <div style={{
                position: 'absolute', left: '50%', top: -20,
                transform: 'translateX(-50%)',
                background: '#f38ba8', color: '#1e1e2e',
                padding: '1px 6px', borderRadius: 3,
                fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
              }}>
                {designW}px
              </div>
            )}
            {/* 高度标注 */}
            {designH > 0 && (
              <div style={{
                position: 'absolute', left: width + 6, top: '50%',
                transform: 'translateY(-50%)',
                background: '#f38ba8', color: '#1e1e2e',
                padding: '1px 6px', borderRadius: 3,
                fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
              }}>
                {designH}px
              </div>
            )}
          </div>
        );
      })()}

      {/* 画板 overlay：边框 + 标题栏 + 拖动 */}
      {!loading && <ArtboardsOverlay />}

      {/* 画板侧边 UE 说明面板（实时显示画板右侧） */}
      {!loading && <ArtboardSidebarOverlay />}

      {/* ===== 工具栏覆盖层 ===== */}

      {/* 顶部中央：工具切换 + 分辨率 */}
      <div className="absolute left-1/2 -translate-x-1/2 z-20 flex items-center gap-1 bg-[#1e1e2e]/90 backdrop-blur rounded-lg px-2 py-1 border border-[#313244]" style={{ top: RULER_SIZE + 6 }}>
        {([
          { key: 'select' as const, label: '选择', icon: '⊹' },
          { key: 'frame' as const, label: '矩形', icon: '▢' },
          { key: 'text' as const, label: '文字', icon: 'T' },
        ]).map((t) => (
          <button
            key={t.key}
            onClick={() => useEditorStore.getState().setTool(t.key)}
            className={`px-3 py-1 text-xs rounded transition-colors ${
              tool === t.key ? 'bg-[#89b4fa] text-[#1e1e2e]' : 'text-[#a6adc8] hover:bg-[#313244]'
            }`}
          >
            {t.icon} {t.label}
          </button>
        ))}
        <span className="w-px h-4 bg-[#45475a]" />
        <select
          value={`${previewWidth}x${previewHeight}`}
          onChange={(e) => {
            const [w, h] = e.target.value.split('x').map(Number);
            setPreviewResolution(w, h);
          }}
          className="text-[13px] bg-[#313244] text-[#cdd6f4] border border-[#45475a] rounded px-1.5 py-1 outline-none"
          title="预览分辨率（模拟游戏设备尺寸，所有画板一起缩）"
        >
          {RESOLUTION_PRESETS.map((r) => (
            <option key={r.label} value={`${r.w}x${r.h}`}>{r.label}</option>
          ))}
        </select>
        <span className="w-px h-4 bg-[#45475a]" />
        {/* 新画板 */}
        <button
          onClick={() => {
            const st = useEditorStore.getState();
            const id = st.addArtboard();
            // 把画布平移到新画板位置，让用户立刻能看到
            const page = st.pages.find((p) => p.id === st.activePageId);
            const newAb = page?.artboards.find((a) => a.id === id);
            const rect = containerRef.current?.getBoundingClientRect();
            if (newAb && rect) {
              // 让新画板居中于视口
              const targetCanvasX = rect.width / 2 - (newAb.x + st.previewWidth / 2) * st.canvasScale;
              const targetCanvasY = rect.height / 2 - (newAb.y + st.previewHeight / 2) * st.canvasScale;
              st.setCanvasTransform(targetCanvasX, targetCanvasY, st.canvasScale);
            }
          }}
          title="在当前页新建画板（自动居中显示）"
          className="px-2 py-1 text-xs text-[#a6e3a1] hover:bg-[#313244] rounded transition-colors"
        >
          ＋画板
        </button>
        <span className="w-px h-4 bg-[#45475a]" />
        {/* 进入批注模式 */}
        <button
          onClick={() => setAnnotationTool('arrow')}
          title="进入批注模式"
          className={`px-2 py-1 text-xs rounded transition-colors ${
            annotationTool
              ? 'bg-[#cba6f7] text-[#1e1e2e]'
              : 'text-[#cba6f7] hover:bg-[#313244]'
          }`}
        >
          📌 批注
        </button>
        <button
          onClick={toggleAnnotationLayer}
          title={annotationLayerVisible ? '隐藏批注层' : '显示批注层'}
          className={`px-2 py-1 text-sm rounded transition-colors ${
            annotationLayerVisible ? 'text-[#a6adc8] hover:bg-[#313244]' : 'text-[#6c7086] hover:bg-[#313244]'
          }`}
        >
          {annotationLayerVisible ? '👁' : '⊘'}
        </button>
        <button
          onClick={toggleGrayscaleMode}
          title={grayscaleMode ? '关闭灰度模式' : '画布灰度化(对接 UE 稿)'}
          className={`px-2 py-1 text-sm rounded transition-colors ${
            grayscaleMode ? 'bg-[#45475a] text-[#cdd6f4]' : 'text-[#a6adc8] hover:bg-[#313244]'
          }`}
        >
          ◐
        </button>
        <button
          onClick={() => setAnnListOpen(true)}
          title="批注列表(查看/定位/删除画布外批注)"
          className="px-2 py-1 text-xs text-[#a6adc8] hover:bg-[#313244] rounded transition-colors"
        >
          📝
        </button>
        <span className="w-px h-4 bg-[#45475a]" />
        <button
          onClick={async () => {
            const st = useEditorStore.getState();
            const page = st.pages.find((p) => p.id === st.activePageId);
            if (!page || page.artboards.length === 0) return;

            const now = new Date();
            const ts = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
            const rootName = st.rootIds.length > 0 ? (st.nodes[st.rootIds[0]]?.name || 'UIEditor') : 'UIEditor';

            // 单画板:保留原行为,直接截当前 active
            if (page.artboards.length === 1) {
              const c = document.getElementById('unity-canvas') as HTMLCanvasElement | null;
              if (!c) return;
              const cropped = cropCanvasToDesignArea(c);
              if (!cropped) return;
              cropped.toBlob((blob) => {
                if (!blob) return;
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `${rootName}_${ts}.png`;
                a.click();
                URL.revokeObjectURL(url);
              }, 'image/png');
              return;
            }

            // 多画板:依次切 active(并 fit 视野) → 截图 → 竖向拼接
            const { captureArtboardWithAnnotations } = await import('../../utils/ueExport/common');
            const originalArtboardId = st.activeArtboardId;
            const originalCanvasX = st.canvasX;
            const originalCanvasY = st.canvasY;
            const originalCanvasScale = st.canvasScale;
            const shots: { name: string; canvas: HTMLCanvasElement }[] = [];
            try {
              for (const ab of page.artboards) {
                const snap = await captureArtboardWithAnnotations(page, ab, false);
                if (snap) shots.push({ name: ab.name, canvas: snap.canvas });
              }
            } finally {
              if (useEditorStore.getState().activeArtboardId !== originalArtboardId) {
                useEditorStore.getState().setActiveArtboard(originalArtboardId);
              }
              useEditorStore.getState().setCanvasTransform(originalCanvasX, originalCanvasY, originalCanvasScale);
            }

            if (shots.length === 0) return;

            const padding = 24;
            const labelH = 36;
            const gap = 24;
            const w = Math.max(...shots.map((s) => s.canvas.width)) + padding * 2;
            const h = padding * 2 +
              shots.reduce((sum, s) => sum + labelH + s.canvas.height + gap, 0) - gap;

            const out = document.createElement('canvas');
            out.width = w; out.height = h;
            const ctx = out.getContext('2d')!;
            ctx.fillStyle = '#1e1e2e';
            ctx.fillRect(0, 0, w, h);
            ctx.font = 'bold 20px sans-serif';
            ctx.fillStyle = '#cdd6f4';
            ctx.textBaseline = 'top';

            let y = padding;
            for (const s of shots) {
              ctx.textAlign = 'left';
              ctx.fillStyle = '#cdd6f4';
              ctx.fillText(s.name, padding, y + 8);
              y += labelH;
              const x = (w - s.canvas.width) / 2;
              ctx.drawImage(s.canvas, x, y);
              y += s.canvas.height + gap;
            }

            out.toBlob((blob) => {
              if (!blob) return;
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `${rootName}_${page.artboards.length}画板_${ts}.png`;
              a.click();
              URL.revokeObjectURL(url);
            }, 'image/png');
          }}
          className="px-2 py-1 text-xs text-[#a6adc8] hover:bg-[#313244] rounded transition-colors"
          title="截图画布(多画板自动拼接)"
        >
          📷
        </button>
        <button
          onClick={() => setUeDialogOpen(true)}
          className="px-2 py-1 text-xs text-[#a6adc8] hover:bg-[#313244] rounded transition-colors"
          title="导出 UE 图(三种版式)"
        >
          📋
        </button>
        <button
          onClick={async () => {
            const { exportFlowLayout } = await import('../../utils/ueExport');
            await exportFlowLayout({ includeAnnotations: false, showPageNumber: false, filenamePrefix: 'LOA-UI_效果图版', title: 'LOA-UI 设计' });
          }}
          className="px-2 py-1 text-xs text-[#a6adc8] hover:bg-[#313244] rounded transition-colors"
          title="截全部图层(拼成长图)"
        >
          📑
        </button>
        <AnnotationModeBar />
      </div>

      {/* 场景工具栏 + 对齐工具（左侧统一面板） */}
      <SceneToolbar onAlign={align} />

      {/* UE 图导出弹窗 */}
      {ueDialogOpen && <UEExportDialog onClose={() => setUeDialogOpen(false)} />}

      {/* 批注列表调试弹窗 */}
      {annListOpen && <AnnotationListDialog onClose={() => setAnnListOpen(false)} />}

      {/* 标尺 — 可从标尺拖拽创建参考线 */}
      {rulersVisible && (
      <canvas ref={hRulerRef} className="absolute top-0 left-0 z-20"
        width={containerSize.width} height={RULER_SIZE}
        style={{ width: containerSize.width, height: RULER_SIZE, cursor: 'ns-resize' }}
        onPointerDown={(e) => {
          e.preventDefault();
          guideDragRef.current = { axis: 'h', startClientPos: e.clientY };
        }}
      />
      )}
      {rulersVisible && (
      <canvas ref={vRulerRef} className="absolute top-0 left-0 z-20"
        width={RULER_SIZE} height={containerSize.height}
        style={{ width: RULER_SIZE, height: containerSize.height, cursor: 'ew-resize' }}
        onPointerDown={(e) => {
          e.preventDefault();
          guideDragRef.current = { axis: 'v', startClientPos: e.clientX };
        }}
      />
      )}
      {rulersVisible && (
      <div className="absolute top-0 left-0 z-20 pointer-events-none" style={{
        width: RULER_SIZE, height: RULER_SIZE, background: RULER_BG,
        borderRight: `1px solid ${RULER_TICK}`, borderBottom: `1px solid ${RULER_TICK}`,
      }} />
      )}

      {/* 参考线渲染 */}
      {guides.map((g) => {
        const screenPos = g.axis === 'h'
          ? canvasY + g.designPos * canvasScale
          : canvasX + g.designPos * canvasScale;
        return (
          <div
            key={g.id}
            className="absolute z-15"
            style={g.axis === 'h' ? {
              left: 0, right: 0, top: screenPos, height: 0,
              borderTop: '1px solid #00d4aa',
              cursor: 'ns-resize',
              pointerEvents: 'auto',
              padding: '3px 0',
              marginTop: -3,
            } : {
              top: 0, bottom: 0, left: screenPos, width: 0,
              borderLeft: '1px solid #00d4aa',
              cursor: 'ew-resize',
              pointerEvents: 'auto',
              padding: '0 3px',
              marginLeft: -3,
            }}
            onPointerDown={(e) => {
              e.stopPropagation();
              e.preventDefault();
              guideDragRef.current = {
                axis: g.axis,
                existingId: g.id,
                startClientPos: g.axis === 'h' ? e.clientY : e.clientX,
              };
            }}
          >
            {/* 设计坐标标签 */}
            <span className="absolute text-[11px] px-1 rounded select-none" style={{
              background: '#00d4aa', color: '#1e1e2e', fontWeight: 600, whiteSpace: 'nowrap',
              ...(g.axis === 'h'
                ? { left: RULER_SIZE + 2, top: -8 }
                : { top: RULER_SIZE + 2, left: -12, writingMode: 'vertical-lr' }),
            }}>
              {Math.round(g.designPos)}
            </span>
          </div>
        );
      })}

      {/* 拖拽中的参考线预览 + 距离标注 */}
      {guideDragPos && (() => {
        const designPos = guideDragPos.axis === 'h'
          ? Math.round((guideDragPos.screenPos - canvasY) / canvasScale)
          : Math.round((guideDragPos.screenPos - canvasX) / canvasScale);
        return (
          <div className="absolute z-15 pointer-events-none" style={guideDragPos.axis === 'h' ? {
            left: 0, right: 0, top: guideDragPos.screenPos, height: 0,
            borderTop: '1px dashed #00d4aa',
            opacity: 0.7,
          } : {
            top: 0, bottom: 0, left: guideDragPos.screenPos, width: 0,
            borderLeft: '1px dashed #00d4aa',
            opacity: 0.7,
          }}>
            <span className="absolute text-[12px] px-1.5 py-0.5 rounded select-none whitespace-nowrap"
              style={{
                background: '#00d4aa', color: '#1e1e2e', fontWeight: 600,
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

      {/* 底部左侧：鼠标坐标 */}
      {mousePos && (
        <div className="absolute bottom-3 left-3 z-20 text-[12px] text-[#6c7086] bg-[#1e1e2e] px-2 py-1 rounded">
          X: {Math.round(mousePos.x)} &nbsp; Y: {Math.round(mousePos.y)}
        </div>
      )}

      {/* 底部右侧：缩放百分比 */}
      <div className="absolute bottom-3 right-3 z-20 text-xs text-[#6c7086] bg-[#1e1e2e] px-2 py-1 rounded">
        {Math.round(canvasScale * 100)}%
      </div>

      {/* Loading 进度 */}
      {loading && !error && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-[#181825]">
          <div className="text-[#a6adc8] text-sm mb-3">Unity WebGL 加载中...</div>
          <div className="w-48 h-1.5 bg-[#313244] rounded-full overflow-hidden">
            <div
              className="h-full bg-[#89b4fa] rounded-full transition-all duration-200"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>
          <div className="text-[#6c7086] text-xs mt-2">{Math.round(progress * 100)}%</div>
        </div>
      )}

      {/* WebGL 上下文恢复中 */}
      {recovering && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-[#181825]/80 backdrop-blur-sm">
          <div className="text-[#a6adc8] text-sm mb-3">WebGL 上下文丢失，正在恢复...</div>
          <div className="w-48 h-1.5 bg-[#313244] rounded-full overflow-hidden">
            <div
              className="h-full bg-[#f9e2af] rounded-full transition-all duration-200"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-[#181825]">
          <div className="text-[#f38ba8] text-sm mb-2">Unity WebGL 加载失败</div>
          <div className="text-[#6c7086] text-xs max-w-md text-center">{error}</div>
          <div className="text-[#6c7086] text-xs mt-4">
            当前分支已移除旧 WebGL 构建产物，后续将改为 Unity Editor Bridge 截图预览。
          </div>
          <div className="text-[#6c7086] text-xs mt-1">
            继续改造前可先按 WORKITEM.md 处理截图式编辑链路。
          </div>
        </div>
      )}
    </div>
  );
}

// src/utils/ueExport/layoutMultiSidebar.ts
// 版式 4: 多屏侧栏型 — 按"图层(page)"为单位一次性截整个画板包围盒(保留画板间相对位置和流程线),
// 每个画板的右侧紧贴该画板自己的说明栏(说明栏跟随画板纵向位置)。
import { useEditorStore } from '../../stores/editorStore';
import { captureLayerWholeShot, timestamp, downloadCanvas } from './common';
import type { LayerSnapshot } from './common';
import { drawSidebar } from './sidebarRenderer';
import type { Artboard, PageData, SidebarBlock } from '../../types';

export interface MultiSidebarOptions {
  includeAnnotations: boolean;
  /** 文档作者(显示在右上角) */
  author?: string;
  /** 要导出的 pages 范围（缺省=全工程） */
  pages?: PageData[];
}

const COL_GAP = 24;
const PAGE_GAP = 28;
const PADDING = 32;
const TITLE_H = 80;
const SCREENSHOT_W = 1280;
const SIDEBAR_W = 480;
const GROUP_TITLE_H = 56;
const SEPARATOR_H = 1;
const ARTBOARD_TITLE_H = 28;
const SIDEBAR_PAD_TOP = 4;

export async function exportMultiSidebarLayout(opts: MultiSidebarOptions) {
  const state = useEditorStore.getState();
  const pages = opts.pages ?? state.pages;
  if (pages.length === 0 || !pages.some((p) => p.artboards.length > 0)) {
    alert('当前选择的图层没有任何画板。');
    return;
  }

  const originalPageId = state.activePageId;
  const originalArtboardId = state.activeArtboardId;
  const originalCanvasX = state.canvasX;
  const originalCanvasY = state.canvasY;
  const originalCanvasScale = state.canvasScale;

  // Step 1: 每个 page 一次性截整张大图
  const layerSnaps: LayerSnapshot[] = [];
  try {
    for (const page of pages) {
      if (page.artboards.length === 0) continue;
      const snap = await captureLayerWholeShot(page, opts.includeAnnotations);
      if (snap) layerSnaps.push(snap);
    }
  } finally {
    const st = useEditorStore.getState();
    if (st.activePageId !== originalPageId) st.switchPage(originalPageId);
    if (useEditorStore.getState().activeArtboardId !== originalArtboardId) {
      useEditorStore.getState().setActiveArtboard(originalArtboardId);
    }
    useEditorStore.getState().setCanvasTransform(originalCanvasX, originalCanvasY, originalCanvasScale);
  }

  if (layerSnaps.length === 0) {
    alert('截图失败,请确认画布已加载。');
    return;
  }

  // Step 2: 预测量
  const measureCanvas = document.createElement('canvas');
  measureCanvas.width = 100; measureCanvas.height = 100;
  const measureCtx = measureCanvas.getContext('2d')!;

  // inset-image: 同 page 内引用同 page 的画板时,从大图截子区域
  const insetCacheBig = new Map<string, HTMLCanvasElement>();
  const getPageSnapshot = (pageId: string, artboardId?: string) => {
    const ls = layerSnaps.find((s) => s.page.id === pageId);
    if (!ls) return undefined;
    const ab = artboardId
      ? ls.page.artboards.find((a) => a.id === artboardId)
      : ls.page.artboards.find((a) => a.id === ls.page.activeArtboardId)
        ?? ls.page.artboards[0];
    if (!ab) return undefined;
    const cacheKey = `${pageId}::${ab.id}`;
    const cached = insetCacheBig.get(cacheKey);
    if (cached) return cached;

    const ratio = ls.designToPixelRatio;
    const sx = Math.round((ab.x - ls.bboxX) * ratio);
    const sy = Math.round((ab.y - ls.bboxY) * ratio);
    const sw = Math.round(ab.width * ratio);
    const sh = Math.round(ab.height * ratio);
    const sub = document.createElement('canvas');
    sub.width = Math.max(1, sw);
    sub.height = Math.max(1, sh);
    sub.getContext('2d')!.drawImage(ls.canvas, sx, sy, sw, sh, 0, 0, sub.width, sub.height);
    insetCacheBig.set(cacheKey, sub);
    return sub;
  };

  interface PageRender {
    snap: LayerSnapshot;
    /** 大图在版式中的显示尺寸(像素) */
    displayW: number;
    displayH: number;
    /** 设计像素 → 版式显示像素 缩放(displayW / bboxW) */
    layoutScale: number;
    /** 该 page 行总高(max(大图高,sidebar 列总占用)) */
    rowH: number;
    /** 排序后的画板(按 y, 然后 x) */
    cells: { artboard: Artboard; index: number; sidebarTop: number; sidebarH: number }[];
  }

  const pageRenders: PageRender[] = [];
  for (const snap of layerSnaps) {
    const layoutScale = SCREENSHOT_W / snap.bboxW;
    const displayW = SCREENSHOT_W;
    const displayH = snap.bboxH * layoutScale;

    // 排序画板: 先 y 再 x;只保留启用了说明栏的画板
    const sortedAbs = [...snap.page.artboards]
      .filter((a) => a.sidebarEnabled)
      .sort((a, b) =>
        a.y !== b.y ? a.y - b.y : a.x - b.x,
      );

    // 每个画板对应右侧的 sidebar 块,顶部对齐到画板在版式中的 y
    const cells: PageRender['cells'] = [];
    let maxSidebarBottom = 0;
    let prevSidebarBottom = 0;
    for (let i = 0; i < sortedAbs.length; i++) {
      const ab = sortedAbs[i];
      const yInLayout = (ab.y - snap.bboxY) * layoutScale;
      const blocks = (ab.sidebar ?? []) as SidebarBlock[];
      const blocksH = blocks.length > 0
        ? drawSidebar({ ctx: measureCtx, width: SIDEBAR_W, getPageSnapshot }, 0, 0, blocks)
        : 0;
      const sidebarTop = Math.max(yInLayout, prevSidebarBottom + 8);
      const sidebarTotalH = ARTBOARD_TITLE_H + SIDEBAR_PAD_TOP + blocksH;
      cells.push({
        artboard: ab,
        index: i + 1,
        sidebarTop,
        sidebarH: sidebarTotalH,
      });
      prevSidebarBottom = sidebarTop + sidebarTotalH;
      maxSidebarBottom = Math.max(maxSidebarBottom, prevSidebarBottom);
    }

    const rowH = Math.max(displayH, maxSidebarBottom);
    pageRenders.push({ snap, displayW, displayH, layoutScale, rowH, cells });
  }

  // 总宽
  const totalW = PADDING + SCREENSHOT_W + COL_GAP + SIDEBAR_W + PADDING;

  // 按 pageGroup 分 section
  type Section = { title: string | null; items: PageRender[] };
  const sections: Section[] = [];
  for (const pr of pageRenders) {
    const t = pr.snap.page.pageGroup ?? null;
    const last = sections[sections.length - 1];
    if (last && last.title === t) last.items.push(pr);
    else sections.push({ title: t, items: [pr] });
  }

  // 总高
  let totalH = PADDING + TITLE_H + PAGE_GAP;
  for (const sec of sections) {
    if (sec.title) totalH += GROUP_TITLE_H + SEPARATOR_H + 8;
    for (const pr of sec.items) totalH += pr.rowH + PAGE_GAP;
    totalH += PAGE_GAP;
  }
  totalH += PADDING;

  // Step 3: 绘制
  const out = document.createElement('canvas');
  out.width = totalW;
  out.height = totalH;
  const ctx = out.getContext('2d')!;
  ctx.fillStyle = '#1e1e2e';
  ctx.fillRect(0, 0, totalW, totalH);

  // 顶部
  const docName = sections[0]?.title ?? 'LOA-UE';
  const titleText = docName === 'LOA-UE' ? 'LOA-UE' : `LOA-UE  ${docName}`;
  ctx.fillStyle = '#f9e2af';
  ctx.font = 'bold 32px sans-serif';
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  ctx.fillText(titleText, PADDING, PADDING);
  ctx.fillStyle = '#a6adc8';
  ctx.font = '16px sans-serif';
  const d = new Date(), pp = (n: number) => String(n).padStart(2, '0');
  const dateStr = `${d.getFullYear()}-${pp(d.getMonth() + 1)}-${pp(d.getDate())}`;
  ctx.fillText(dateStr, PADDING, PADDING + 40);
  if (opts.author && opts.author.trim()) {
    ctx.textAlign = 'right';
    ctx.fillText(opts.author, totalW - PADDING, PADDING + 16);
    ctx.textAlign = 'left';
  }

  // 各 section
  let y = PADDING + TITLE_H + PAGE_GAP;
  const sbColX = PADDING + SCREENSHOT_W + COL_GAP;
  for (const sec of sections) {
    if (sec.title) {
      ctx.fillStyle = '#cdd6f4';
      ctx.font = 'bold 22px sans-serif';
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText(sec.title, PADDING, y + 8);
      y += GROUP_TITLE_H;
      ctx.fillStyle = '#313244';
      ctx.fillRect(PADDING, y, totalW - PADDING * 2, SEPARATOR_H);
      y += SEPARATOR_H + 8;
    }

    for (const pr of sec.items) {
      // 大图
      ctx.drawImage(pr.snap.canvas, PADDING, y, pr.displayW, pr.displayH);

      // 每个画板对应的 sidebar 块,跟随画板的 y 位置
      for (const cell of pr.cells) {
        const blocks = (cell.artboard.sidebar ?? []) as SidebarBlock[];
        const sbY = y + cell.sidebarTop;

        // 画板小标题: "1. ArtboardName"
        ctx.fillStyle = '#94e2d5';
        ctx.font = 'bold 14px sans-serif';
        ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        ctx.fillText(`${cell.index}. ${cell.artboard.name}`, sbColX, sbY);

        // 视觉对齐线: 从大图右侧画板顶部 → 该画板的 sidebar 起点
        const abYInLayout = (cell.artboard.y - pr.snap.bboxY) * pr.layoutScale;
        const abEndX = PADDING + pr.displayW;
        const guideStartX = abEndX + 4;
        const guideEndX = sbColX - 4;
        const guideStartY = y + abYInLayout + 8;  // 略偏离画板顶端
        const guideEndY = sbY + 12;
        ctx.save();
        ctx.strokeStyle = 'rgba(148, 226, 213, 0.35)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(guideStartX, guideStartY);
        ctx.lineTo(guideEndX, guideEndY);
        ctx.stroke();
        ctx.restore();

        if (blocks.length > 0) {
          drawSidebar(
            { ctx, width: SIDEBAR_W, getPageSnapshot },
            sbColX, sbY + ARTBOARD_TITLE_H + SIDEBAR_PAD_TOP, blocks,
          );
        }
      }

      y += pr.rowH + PAGE_GAP;
    }
    y += PAGE_GAP;
  }

  downloadCanvas(out, `${docName.replace(/[\\/:*?"<>|]/g, '_')}_对接评审版_${timestamp()}.png`);
}

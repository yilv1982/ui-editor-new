// src/utils/ueExport/layoutFlow.ts
// 版式 2: 流程拼接型 — 多页竖排,每页带圆形序号,适合策划/评审稿
import { useEditorStore } from '../../stores/editorStore';
import { captureArtboardWithAnnotations, timestamp, downloadCanvas } from './common';
import type { PageData } from '../../types';

export interface FlowOptions {
  includeAnnotations: boolean;
  /** 是否显示每页左上角的圆形序号(默认 true,简单截长图场景可关掉) */
  showPageNumber?: boolean;
  /** 文件名前缀(默认 LOA-UI_流程评审版) */
  filenamePrefix?: string;
  /** 顶部标题(默认 "LOA-UE 设计",UI 长图场景可传 "LOA-UI 设计") */
  title?: string;
  /** 要导出的 pages 范围（缺省=全工程） */
  pages?: PageData[];
}

export async function exportFlowLayout(opts: FlowOptions) {
  const state = useEditorStore.getState();
  const pages = opts.pages ?? state.pages;
  if (pages.length === 0) return;
  const originalPageId = state.activePageId;
  const originalArtboardId = state.activeArtboardId;
  const originalCanvasX = state.canvasX;
  const originalCanvasY = state.canvasY;
  const originalCanvasScale = state.canvasScale;

  type Snap = NonNullable<Awaited<ReturnType<typeof captureArtboardWithAnnotations>>>;
  const snapshots: Snap[] = [];
  try {
    for (const p of pages) {
      for (const a of p.artboards) {
        const s = await captureArtboardWithAnnotations(p, a, opts.includeAnnotations);
        if (s) snapshots.push(s);
      }
    }
  } finally {
    const st = useEditorStore.getState();
    if (st.activePageId !== originalPageId) st.switchPage(originalPageId);
    if (useEditorStore.getState().activeArtboardId !== originalArtboardId) {
      useEditorStore.getState().setActiveArtboard(originalArtboardId);
    }
    useEditorStore.getState().setCanvasTransform(originalCanvasX, originalCanvasY, originalCanvasScale);
  }

  if (snapshots.length === 0) return;

  const padding = 24;
  const titleH = 80;
  const labelH = 44;
  const gap = 32;
  const w = Math.max(...snapshots.map((s) => s.canvas.width)) + padding * 2;
  const h = padding * 2 + titleH + gap +
    snapshots.reduce((sum, x) => sum + x.canvas.height + labelH + gap, 0) - gap;

  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const ctx = out.getContext('2d')!;
  ctx.fillStyle = '#1e1e2e';
  ctx.fillRect(0, 0, w, h);

  ctx.fillStyle = '#f9e2af';
  ctx.font = 'bold 48px sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(opts.title ?? 'LOA-UE 设计', w / 2, padding + titleH / 2);
  ctx.fillStyle = '#a6adc8';
  ctx.font = '20px sans-serif';
  const d = new Date(), p = (n: number) => String(n).padStart(2, '0');
  ctx.textAlign = 'right';
  ctx.fillText(
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`,
    w - padding, padding + titleH - 12
  );

  // 同 page 多画板时显示 pageName / artboardName,否则显示 pageName
  const pageArtboardCount = new Map<string, number>();
  for (const s of snapshots) {
    pageArtboardCount.set(s.pageId, (pageArtboardCount.get(s.pageId) ?? 0) + 1);
  }

  let y = padding + titleH + gap;
  ctx.font = 'bold 22px sans-serif';
  for (let i = 0; i < snapshots.length; i++) {
    const s = snapshots[i];
    const x = (w - s.canvas.width) / 2;
    // 截图
    ctx.drawImage(s.canvas, x, y);
    // 序号圆(图片内左上角,叠在截图上)
    if (opts.showPageNumber !== false) {
      ctx.fillStyle = '#f38ba8';
      ctx.beginPath();
      ctx.arc(x + 28, y + 28, 18, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#1e1e2e';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), x + 28, y + 28);
    }
    y += s.canvas.height;
    // 名称
    ctx.fillStyle = '#cdd6f4';
    const label = (pageArtboardCount.get(s.pageId) ?? 1) > 1
      ? `${s.pageName} / ${s.artboardName}`
      : s.pageName;
    ctx.fillText(label, w / 2, y + labelH / 2);
    y += labelH + gap;
  }

  downloadCanvas(out, `${opts.filenamePrefix ?? 'LOA-UI_流程评审版'}_${timestamp()}.png`);
}

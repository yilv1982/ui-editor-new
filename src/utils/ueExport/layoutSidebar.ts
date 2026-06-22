// src/utils/ueExport/layoutSidebar.ts
// 版式 1: 单屏侧栏型 — 左截图 + 右控件索引/批注说明,适合程序对接稿
import { useEditorStore } from '../../stores/editorStore';
import { captureArtboardWithAnnotations, timestamp, downloadCanvas } from './common';
import { extractWidgetIndex } from './widgetIndex';

export interface SidebarOptions {
  includeAnnotations: boolean;
  includeWidgetIndex: boolean;
}

export async function exportSidebarLayout(opts: SidebarOptions) {
  const state = useEditorStore.getState();
  const page = state.pages.find((p) => p.id === state.activePageId);
  if (!page) return;
  const artboard = page.artboards.find((a) => a.id === page.activeArtboardId) ?? page.artboards[0];
  if (!artboard) return;

  const originalCanvasX = state.canvasX;
  const originalCanvasY = state.canvasY;
  const originalCanvasScale = state.canvasScale;

  let snapshot: Awaited<ReturnType<typeof captureArtboardWithAnnotations>> | null = null;
  try {
    snapshot = await captureArtboardWithAnnotations(page, artboard, opts.includeAnnotations);
  } finally {
    useEditorStore.getState().setCanvasTransform(originalCanvasX, originalCanvasY, originalCanvasScale);
  }
  if (!snapshot) return;

  const sidebarW = 360;
  const titleH = 60;
  const padding = 20;
  const totalW = snapshot.canvas.width + sidebarW + padding * 3;
  const totalH = Math.max(snapshot.canvas.height, 600) + titleH + padding * 2;

  const out = document.createElement('canvas');
  out.width = totalW;
  out.height = totalH;
  const ctx = out.getContext('2d')!;
  ctx.fillStyle = '#1e1e2e';
  ctx.fillRect(0, 0, totalW, totalH);

  // 顶部标题
  ctx.fillStyle = '#f9e2af';
  ctx.font = 'bold 32px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('LOA-UE 设计', padding, padding);
  ctx.fillStyle = '#a6adc8';
  ctx.font = '18px sans-serif';
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const subtitle = page.artboards.length > 1
    ? `${page.name} / ${artboard.name}`
    : page.name;
  ctx.fillText(
    `${subtitle}  ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`,
    padding, padding + 36
  );

  // 截图
  ctx.drawImage(snapshot.canvas, padding, padding + titleH);

  // 侧栏
  const sx = padding + snapshot.canvas.width + padding;
  let sy = padding + titleH;
  ctx.font = 'bold 20px sans-serif';

  if (opts.includeWidgetIndex) {
    const widgets = extractWidgetIndex(state.nodes, state.rootIds);
    ctx.fillStyle = '#cdd6f4';
    ctx.fillText('控件索引', sx, sy); sy += 30;
    ctx.font = '14px sans-serif';
    widgets.forEach((w, i) => {
      ctx.fillStyle = '#a6adc8';
      ctx.fillText(`${i + 1}. ${w.name} (${w.type})`, sx, sy);
      sy += 22;
    });
    sy += 16;
  }

  if (opts.includeAnnotations && snapshot.annotations.length > 0) {
    ctx.fillStyle = '#cdd6f4';
    ctx.font = 'bold 20px sans-serif';
    ctx.fillText('批注说明', sx, sy); sy += 30;
    ctx.font = '14px sans-serif';
    const numbered = snapshot.annotations
      .filter((a) => a.type === 'number')
      .sort((x, y) => (x.badgeNumber ?? 0) - (y.badgeNumber ?? 0));
    const texts = snapshot.annotations.filter((a) => a.type === 'text');
    [...numbered, ...texts].forEach((a) => {
      ctx.fillStyle = '#a6adc8';
      const prefix = a.type === 'number' ? `${a.badgeNumber ?? '?'}. ` : '· ';
      const label = a.type === 'number' ? '(请补充说明)' : (a.text ?? '');
      ctx.fillText(`${prefix}${label}`, sx, sy);
      sy += 22;
    });
  }

  downloadCanvas(out, page.artboards.length > 1
    ? `${page.name}_${artboard.name}_单屏对接版_${timestamp()}.png`
    : `${page.name}_单屏对接版_${timestamp()}.png`);
}

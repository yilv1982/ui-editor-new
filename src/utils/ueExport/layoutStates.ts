// src/utils/ueExport/layoutStates.ts
// 版式 3: 状态对比型 — 按 pageGroup 分组横向并排,适合美术参考
import { useEditorStore } from '../../stores/editorStore';
import { captureArtboardWithAnnotations, timestamp, downloadCanvas } from './common';
import type { Artboard, PageData } from '../../types';

export interface StatesOptions {
  includeAnnotations: boolean;
  /** 要导出的 pages 范围（缺省=全工程） */
  pages?: PageData[];
}

type Cell = { page: PageData; artboard: Artboard };

export async function exportStatesLayout(opts: StatesOptions) {
  const state = useEditorStore.getState();
  const pages = opts.pages ?? state.pages;
  const grouped = new Map<string, Cell[]>();
  for (const p of pages) {
    const key = p.pageGroup ?? '__未分组__';
    if (!grouped.has(key)) grouped.set(key, []);
    for (const a of p.artboards) {
      grouped.get(key)!.push({ page: p, artboard: a });
    }
  }
  const groups = [...grouped.entries()].filter(([k]) => k !== '__未分组__');
  if (groups.length === 0) {
    alert('当前没有任何页面被设置分组(右键页面 → 设置分组)。');
    return;
  }

  const originalPageId = state.activePageId;
  const originalArtboardId = state.activeArtboardId;
  const originalCanvasX = state.canvasX;
  const originalCanvasY = state.canvasY;
  const originalCanvasScale = state.canvasScale;
  type Snap = NonNullable<Awaited<ReturnType<typeof captureArtboardWithAnnotations>>>;
  const groupSnapshots: { name: string; shots: (Snap | null)[]; cells: Cell[] }[] = [];
  try {
    for (const [name, cells] of groups) {
      const shots: (Snap | null)[] = [];
      for (const c of cells) {
        shots.push(await captureArtboardWithAnnotations(c.page, c.artboard, opts.includeAnnotations));
      }
      groupSnapshots.push({ name, shots, cells });
    }
  } finally {
    const st = useEditorStore.getState();
    if (st.activePageId !== originalPageId) st.switchPage(originalPageId);
    if (useEditorStore.getState().activeArtboardId !== originalArtboardId) {
      useEditorStore.getState().setActiveArtboard(originalArtboardId);
    }
    useEditorStore.getState().setCanvasTransform(originalCanvasX, originalCanvasY, originalCanvasScale);
  }

  const padding = 24;
  const titleH = 80;
  const groupTitleH = 36;
  const labelH = 32;
  const gap = 24;
  const colsPerRow = 4;
  const cellW = 480;
  const cellH = 270;

  let totalH = padding + titleH;
  for (const g of groupSnapshots) {
    const rows = Math.ceil(g.shots.length / colsPerRow);
    totalH += groupTitleH + rows * (cellH + labelH + gap) + gap;
  }
  totalH += padding;

  const totalW = padding * 2 + colsPerRow * cellW + (colsPerRow - 1) * gap;

  const out = document.createElement('canvas');
  out.width = totalW; out.height = totalH;
  const ctx = out.getContext('2d')!;
  ctx.fillStyle = '#1e1e2e';
  ctx.fillRect(0, 0, totalW, totalH);

  ctx.fillStyle = '#f9e2af';
  ctx.font = 'bold 32px sans-serif';
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  ctx.fillText('LOA-UE 设计 · 状态对比', padding, padding);
  ctx.fillStyle = '#a6adc8';
  ctx.font = '18px sans-serif';
  const d = new Date(), p = (n: number) => String(n).padStart(2, '0');
  ctx.fillText(
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`,
    padding, padding + 36
  );

  let y = padding + titleH;
  for (const g of groupSnapshots) {
    ctx.fillStyle = '#cdd6f4';
    ctx.font = 'bold 22px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(g.name, padding, y);
    y += groupTitleH;

    g.shots.forEach((s, i) => {
      if (!s) return;
      const cell = g.cells[i];
      const col = i % colsPerRow;
      const row = Math.floor(i / colsPerRow);
      const x = padding + col * (cellW + gap);
      const cy = y + row * (cellH + labelH + gap);
      const sw = s.canvas.width, sh = s.canvas.height;
      const ratio = Math.min(cellW / sw, cellH / sh);
      const dw = sw * ratio, dh = sh * ratio;
      ctx.drawImage(s.canvas, x + (cellW - dw) / 2, cy + (cellH - dh) / 2, dw, dh);
      ctx.fillStyle = '#a6adc8';
      ctx.font = '16px sans-serif';
      ctx.textAlign = 'center';
      const label = cell.page.artboards.length > 1
        ? `${s.pageName} · ${s.artboardName}`
        : s.pageName;
      ctx.fillText(label, x + cellW / 2, cy + cellH + 16);
    });

    const rows = Math.ceil(g.shots.length / colsPerRow);
    y += rows * (cellH + labelH + gap) + gap;
  }

  downloadCanvas(out, `LOA-UI_状态对比版_${timestamp()}.png`);
}

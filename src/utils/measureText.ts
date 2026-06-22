/**
 * 测量文本在指定宽度下的渲染高度（用于 ContentSizeFitter.verticalFit=PreferredSize 模拟）。
 *
 * 用 Canvas 2D measureText 模拟 Unity Text 的换行：以宽度为限，按字符宽度累加，超出即换行。
 * 与 Unity TMP/UGUI 真实渲染会有偏差，但足够编辑器预览。
 */

let cachedCtx: CanvasRenderingContext2D | null = null;
function getCtx(): CanvasRenderingContext2D | null {
  if (cachedCtx) return cachedCtx;
  try {
    const c = document.createElement('canvas');
    cachedCtx = c.getContext('2d');
  } catch {
    cachedCtx = null;
  }
  return cachedCtx;
}

export interface MeasureOptions {
  text: string;
  fontSize: number;
  width: number;          // 包围盒宽（含 padding 等，调用方需扣除）
  lineSpacing?: number;   // Unity Text.lineSpacing 倍率，默认 1
  fontFamily?: string;
  fontWeight?: string | number;
}

export function measureTextHeight(opts: MeasureOptions): number {
  const text = opts.text ?? '';
  const fontSize = Math.max(1, opts.fontSize || 24);
  const width = Math.max(1, opts.width || 1);
  const lineSpacing = opts.lineSpacing ?? 1;
  const fontFamily = opts.fontFamily || 'Arial, sans-serif';
  const fontWeight = opts.fontWeight || 'normal';

  // UGUI Text 的 preferred height 通常接近 fontSize * lineSpacing * 1.44。
  const lineHeight = fontSize * (lineSpacing > 0 ? lineSpacing : 1) * 1.44;

  if (!text) return Math.ceil(lineHeight);

  const ctx = getCtx();
  // 没有 canvas 环境时，按字符密度估算
  if (!ctx) {
    const charsPerLine = Math.max(1, Math.floor(width / (fontSize * 0.6)));
    let lines = 0;
    for (const seg of text.split(/\r?\n/)) {
      lines += Math.max(1, Math.ceil(seg.length / charsPerLine));
    }
    return Math.ceil(lines * lineHeight);
  }

  ctx.font = `${fontWeight} ${fontSize}px ${fontFamily}`;

  let totalLines = 0;
  for (const segment of text.split(/\r?\n/)) {
    if (!segment) { totalLines += 1; continue; }
    let lineWidth = 0;
    let lines = 1;
    // 按字符累加（不区分中英文，均匀处理 CJK 与拉丁）
    for (const ch of segment) {
      const w = ctx.measureText(ch).width;
      if (lineWidth + w > width && lineWidth > 0) {
        lines += 1;
        lineWidth = w;
      } else {
        lineWidth += w;
      }
    }
    totalLines += lines;
  }

  return Math.ceil(totalLines * lineHeight);
}

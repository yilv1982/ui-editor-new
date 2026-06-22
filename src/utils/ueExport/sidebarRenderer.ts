// src/utils/ueExport/sidebarRenderer.ts
// 在已有的 canvas 上绘制说明栏 block 列表,返回所占总高度。
// 使用 canvas 2D context 直接绘制,不依赖 DOM。
import type { SidebarBlock } from '../../types';
import { TAG_COLORS } from '../../types';

export interface SidebarRenderContext {
  ctx: CanvasRenderingContext2D;
  width: number;                                    // sidebar 列宽
  /** inset-image block 用 — 给 (refPageId, refArtboardId?) 返回截图 canvas;
   *  refArtboardId 缺省时由实现自行选择(通常是该 page 的 active 画板)。 */
  getPageSnapshot: (pageId: string, artboardId?: string) => HTMLCanvasElement | undefined;
}

const COLORS = {
  text: '#cdd6f4',
  muted: '#a6adc8',
  titleBar: '#89b4fa',
  insetBorder: '#45475a',
};

const PADDING_X = 12;
const FONT_FAMILY = 'sans-serif';
const PLAIN_FONT_SIZE = 16;
const PLAIN_LINE_HEIGHT = 24;
const TITLE_FONT_SIZE = 20;
const TITLE_LINE_HEIGHT = 28;
const TITLE_TOP_GAP = 8;
const BULLET_INDENT = 16;
const TAG_FONT_SIZE = 14;
const TAG_PADDING_X = 8;
const TAG_PADDING_Y = 4;
const TAG_GAP = 6;
const TAG_LINE_HEIGHT = 28;
const BLOCK_GAP = 6;

/** 绘制单个 block,返回所占高度 */
function drawBlock(
  rcx: SidebarRenderContext,
  block: SidebarBlock,
  x: number,
  y: number,
  numberedSeq: { count: number },
): number {
  const { ctx, width } = rcx;
  const innerW = width - PADDING_X * 2;
  const innerX = x + PADDING_X;

  if (block.type === 'plain') {
    ctx.fillStyle = COLORS.text;
    ctx.font = `${PLAIN_FONT_SIZE}px ${FONT_FAMILY}`;
    ctx.textBaseline = 'top';
    return wrapRichText(ctx, block.text ?? '', innerX, y, innerW, PLAIN_LINE_HEIGHT);
  }

  if (block.type === 'title') {
    const top = y + TITLE_TOP_GAP;
    // 左侧 3px 蓝色竖条
    ctx.fillStyle = COLORS.titleBar;
    ctx.fillRect(x + 4, top, 3, TITLE_LINE_HEIGHT - 4);
    ctx.fillStyle = COLORS.text;
    ctx.font = `bold ${TITLE_FONT_SIZE}px ${FONT_FAMILY}`;
    ctx.textBaseline = 'top';
    const used = wrapRichText(ctx, block.text ?? '', innerX + 4, top, innerW - 4, TITLE_LINE_HEIGHT);
    return TITLE_TOP_GAP + used;
  }

  if (block.type === 'bullet') {
    ctx.fillStyle = COLORS.text;
    ctx.font = `${PLAIN_FONT_SIZE}px ${FONT_FAMILY}`;
    ctx.textBaseline = 'top';
    ctx.fillText('·', innerX, y);
    return wrapRichText(ctx, block.text ?? '', innerX + BULLET_INDENT, y, innerW - BULLET_INDENT, PLAIN_LINE_HEIGHT);
  }

  if (block.type === 'numbered') {
    numberedSeq.count += 1;
    const prefix = `${numberedSeq.count}.`;
    ctx.fillStyle = COLORS.text;
    ctx.font = `${PLAIN_FONT_SIZE}px ${FONT_FAMILY}`;
    ctx.textBaseline = 'top';
    ctx.fillText(prefix, innerX, y);
    return wrapRichText(ctx, block.text ?? '', innerX + BULLET_INDENT + 4, y, innerW - BULLET_INDENT - 4, PLAIN_LINE_HEIGHT);
  }

  if (block.type === 'tag') {
    const role = block.role ?? 'program';
    const colors = TAG_COLORS[role];
    const labelText = colors.label;
    ctx.font = `bold ${TAG_FONT_SIZE}px ${FONT_FAMILY}`;
    const labelW = ctx.measureText(labelText).width + TAG_PADDING_X * 2;
    const tagH = TAG_FONT_SIZE + TAG_PADDING_Y * 2;
    // 圆角矩形
    drawRoundedRect(ctx, innerX, y + 2, labelW, tagH, 4);
    ctx.fillStyle = colors.bg;
    ctx.fill();
    ctx.fillStyle = colors.fg;
    ctx.textBaseline = 'middle';
    ctx.fillText(labelText, innerX + TAG_PADDING_X, y + 2 + tagH / 2);
    // 附加文本(在标签之后，支持富文本 + 换行)
    if (block.text && block.text.length > 0) {
      ctx.fillStyle = COLORS.text;
      ctx.font = `${TAG_FONT_SIZE}px ${FONT_FAMILY}`;
      ctx.textBaseline = 'top';
      const textX = innerX + labelW + TAG_GAP;
      const textW = innerW - labelW - TAG_GAP;
      const textH = wrapRichText(ctx, ' ' + block.text, textX, y + 2, textW, TAG_LINE_HEIGHT);
      return Math.max(TAG_LINE_HEIGHT, textH + 4);
    }
    return TAG_LINE_HEIGHT;
  }

  if (block.type === 'inset-image') {
    if (!block.refPageId) return 0;
    const snap = rcx.getPageSnapshot(block.refPageId, block.refArtboardId);
    if (!snap) return 0;
    const targetW = innerW;
    const ratio = targetW / snap.width;
    const targetH = snap.height * ratio;
    ctx.drawImage(snap, innerX, y, targetW, targetH);
    ctx.strokeStyle = COLORS.insetBorder;
    ctx.lineWidth = 1;
    ctx.strokeRect(innerX, y, targetW, targetH);
    return targetH;
  }

  return 0;
}

/** 主入口: 顺序绘制 blocks,返回总高度 */
export function drawSidebar(
  rcx: SidebarRenderContext,
  x: number,
  y: number,
  blocks: SidebarBlock[],
): number {
  let cy = y;
  const numberedSeq = { count: 0 };
  let lastWasNumbered = false;
  for (const b of blocks) {
    if (b.type !== 'numbered') {
      // 非 numbered 中断重置序号
      if (lastWasNumbered) numberedSeq.count = 0;
      lastWasNumbered = false;
    } else {
      lastWasNumbered = true;
    }
    const h = drawBlock(rcx, b, x, cy, numberedSeq);
    cy += h + BLOCK_GAP;
  }
  return cy - y;
}

// ---- helpers ----

interface RichSegment {
  ch: string;
  color?: string;
  bold?: boolean;
}

/** 把 [color=#xxx]...[/color] / [b]...[/b] 标签解析为按字符级的片段数组 */
function parseRichSegments(text: string): RichSegment[] {
  const out: RichSegment[] = [];
  const colorRe = /\[color=(#[0-9a-fA-F]{3,8})\](.*?)\[\/color\]/gs;
  let last = 0;
  let m: RegExpExecArray | null;
  const pushPlain = (s: string, color?: string) => {
    const boldRe = /\[b\](.*?)\[\/b\]/gs;
    let l = 0;
    let bm: RegExpExecArray | null;
    while ((bm = boldRe.exec(s)) !== null) {
      if (bm.index > l) {
        for (const ch of s.slice(l, bm.index)) out.push({ ch, color });
      }
      for (const ch of bm[1]) out.push({ ch, color, bold: true });
      l = boldRe.lastIndex;
    }
    if (l < s.length) {
      for (const ch of s.slice(l)) out.push({ ch, color });
    }
  };
  while ((m = colorRe.exec(text)) !== null) {
    if (m.index > last) pushPlain(text.slice(last, m.index));
    pushPlain(m[2], m[1]);
    last = colorRe.lastIndex;
  }
  if (last < text.length) pushPlain(text.slice(last));
  return out;
}

function wrapRichText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
): number {
  if (!text) return lineHeight;
  // 保留原 font 以便恢复（bold 段会临时修改）
  const baseFont = ctx.font;
  const baseFill = ctx.fillStyle;

  const segs = parseRichSegments(text);
  // 按 \n 切行（segment 里可能含换行符）
  const lines: RichSegment[][] = [[]];
  for (const s of segs) {
    if (s.ch === '\n') {
      lines.push([]);
    } else {
      lines[lines.length - 1].push(s);
    }
  }

  const measure = (s: RichSegment): number => {
    if (s.bold) {
      const prev = ctx.font;
      ctx.font = `bold ${prev.replace(/^bold\s+/, '')}`;
      const w = ctx.measureText(s.ch).width;
      ctx.font = prev;
      return w;
    }
    return ctx.measureText(s.ch).width;
  };

  const drawLine = (segs: RichSegment[], lx: number, ly: number) => {
    let cx = lx;
    for (const s of segs) {
      const prevFont = ctx.font;
      const prevFill = ctx.fillStyle;
      if (s.bold) ctx.font = `bold ${prevFont.replace(/^bold\s+/, '')}`;
      if (s.color) ctx.fillStyle = s.color;
      ctx.fillText(s.ch, cx, ly);
      cx += ctx.measureText(s.ch).width;
      ctx.font = prevFont;
      ctx.fillStyle = prevFill;
    }
  };

  let cy = y;
  for (const line of lines) {
    if (line.length === 0) {
      cy += lineHeight;  // 空行也占行高
      continue;
    }
    let cur: RichSegment[] = [];
    let curW = 0;
    for (const s of line) {
      const w = measure(s);
      if (curW + w > maxWidth && cur.length > 0) {
        drawLine(cur, x, cy);
        cy += lineHeight;
        cur = [s];
        curW = w;
      } else {
        cur.push(s);
        curW += w;
      }
    }
    if (cur.length > 0) {
      drawLine(cur, x, cy);
      cy += lineHeight;
    }
  }

  ctx.font = baseFont;
  ctx.fillStyle = baseFill;
  return cy - y;
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y,     x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x,     y + h, r);
  ctx.arcTo(x,     y + h, x,     y,     r);
  ctx.arcTo(x,     y,     x + w, y,     r);
  ctx.closePath();
}

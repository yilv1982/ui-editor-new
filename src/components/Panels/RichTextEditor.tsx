/**
 * RichTextEditor — 弹窗富文本编辑器,用于编辑带颜色标签的文本。
 * 内部用 contenteditable,导出/导入用 [color=#xxx]...[/color] 标签格式。
 */
import { useEffect, useRef, useState } from 'react';

interface ColorPreset { color: string; label: string; desc?: string }

interface Props {
  initialText: string;
  onConfirm: (text: string) => void;
  onCancel: () => void;
}

/** 解析 [color=#xxx]...[/color] 和 [b]...[/b] 标签 → HTML */
function tagsToHtml(text: string): string {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return escaped
    .replace(/\[color=(#[0-9a-fA-F]{3,8})\](.*?)\[\/color\]/gs, (_, c, inner) =>
      `<span style="color:${c}">${inner}</span>`
    )
    .replace(/\[b\](.*?)\[\/b\]/gs, (_, inner) => `<b>${inner}</b>`);
}

/** 把 contenteditable 的 innerHTML 还原为 [color=...] / [b] 标签格式 */
function htmlToTags(node: Node): string {
  let out = '';
  node.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      out += child.textContent ?? '';
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const el = child as HTMLElement;
      if (el.tagName === 'BR') {
        out += '\n';
        return;
      }
      // execCommand 用 <font color="..."> 实现颜色,也支持 <span style="color:...">
      const color = el.style.color
        || (el.tagName === 'FONT' ? (el.getAttribute('color') ?? '') : '')
        || el.getAttribute('data-color')
        || '';
      const isBold = el.tagName === 'B'
        || el.tagName === 'STRONG'
        || el.style.fontWeight === 'bold'
        || el.style.fontWeight === '700';
      let inner = htmlToTags(el);
      if (color) {
        const hex = rgbToHex(color);
        inner = `[color=${hex}]${inner}[/color]`;
      }
      if (isBold) {
        inner = `[b]${inner}[/b]`;
      }
      out += inner;
    }
  });
  return out;
}

function rgbToHex(rgb: string): string {
  if (rgb.startsWith('#')) return rgb;
  const m = rgb.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/i);
  if (!m) return rgb;
  const toHex = (n: number) => n.toString(16).padStart(2, '0');
  return '#' + toHex(+m[1]) + toHex(+m[2]) + toHex(+m[3]);
}

export default function RichTextEditor({ initialText, onConfirm, onCancel }: Props) {
  const editorRef = useRef<HTMLDivElement>(null);
  const [colorPresets, setColorPresets] = useState<ColorPreset[]>([]);

  useEffect(() => {
    fetch('/colorPresets.json').then((r) => r.json()).then(setColorPresets).catch(() => {});
  }, []);

  useEffect(() => {
    if (editorRef.current) {
      editorRef.current.innerHTML = tagsToHtml(initialText);
      editorRef.current.focus();
    }
  }, [initialText]);

  const applyColor = (color: string) => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (range.collapsed) return; // 没选中范围
    // 用 execCommand 简单实现(虽然 deprecated,但 contenteditable 场景仍 work)
    document.execCommand('foreColor', false, color);
    editorRef.current?.focus();
  };

  const toggleBold = () => {
    document.execCommand('bold');
    editorRef.current?.focus();
  };

  const clearFormat = () => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    document.execCommand('removeFormat');
    editorRef.current?.focus();
  };

  const handleConfirm = () => {
    if (!editorRef.current) return;
    const text = htmlToTags(editorRef.current);
    onConfirm(text);
  };

  return (
    <>
      {/* 遮罩 */}
      <div
        className="fixed inset-0 bg-black/50"
        style={{ zIndex: 9999 }}
        onClick={onCancel}
        onPointerDown={(e) => e.stopPropagation()}
      />
      {/* 弹窗 */}
      <div
        className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-[#1e1e2e] border border-[#45475a] rounded shadow-xl"
        style={{ width: 520, maxWidth: '90vw', zIndex: 10000 }}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="px-3 py-2 border-b border-[#313244] text-[13px] text-[#cdd6f4] flex items-center justify-between">
          <span>编辑富文本</span>
          <button onClick={onCancel} className="text-[#6c7086] hover:text-[#f38ba8]">✕</button>
        </div>

        {/* 颜色工具栏 */}
        <div className="px-3 py-2 border-b border-[#313244] flex items-center gap-1 flex-wrap">
          <button
            onClick={toggleBold}
            onMouseDown={(e) => e.preventDefault()}
            className="px-2 text-[13px] font-bold text-[#cdd6f4] hover:bg-[#313244] rounded"
            title="加粗（Ctrl+B）"
          >B</button>
          <span className="mx-1 w-px h-4 bg-[#45475a]" />
          <span className="text-[11px] text-[#6c7086] mr-1">选中文本后点色</span>
          {colorPresets.map((c) => (
            <button
              key={c.color}
              title={`${c.label} ${c.color}`}
              className="w-5 h-5 rounded border border-[#45475a] hover:scale-110 transition-transform"
              style={{ backgroundColor: c.color }}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => applyColor(c.color)}
            />
          ))}
          <input
            type="color"
            className="w-5 h-5 p-0 border-none cursor-pointer ml-1"
            title="自定义颜色"
            onChange={(e) => applyColor(e.target.value)}
            onMouseDown={(e) => e.preventDefault()}
          />
          <span className="mx-1 w-px h-4 bg-[#45475a]" />
          <button
            onClick={clearFormat}
            onMouseDown={(e) => e.preventDefault()}
            className="px-2 text-[11px] text-[#f38ba8] hover:bg-[#313244] rounded"
            title="清除选区颜色"
          >清除</button>
        </div>

        {/* 编辑区 */}
        <div
          ref={editorRef}
          contentEditable
          suppressContentEditableWarning
          className="px-3 py-2 text-[13px] text-[#cdd6f4] outline-none"
          style={{
            minHeight: 100,
            maxHeight: 240,
            overflowY: 'auto',
            background: '#11111b',
            margin: 12,
            borderRadius: 4,
            border: '1px solid #313244',
          }}
        />

        {/* 底部按钮 */}
        <div className="px-3 py-2 border-t border-[#313244] flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-3 py-1 text-[12px] text-[#a6adc8] bg-[#313244] hover:bg-[#45475a] rounded"
          >取消</button>
          <button
            onClick={handleConfirm}
            className="px-3 py-1 text-[12px] text-[#1e1e2e] bg-[#89b4fa] hover:bg-[#74c7ec] rounded"
          >确定</button>
        </div>
      </div>
    </>
  );
}

/** 工具：把 [color=...] / [b] 标签格式渲染为 React 元素（预览用） */
export function renderTaggedText(text: string): React.ReactNode[] {
  // 简单的递归解析：先按 color 标签切片,内部再处理 b
  return renderColorThenBold(text, 0);
}

function renderColorThenBold(text: string, baseKey: number): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /\[color=(#[0-9a-fA-F]{3,8})\](.*?)\[\/color\]/gs;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = baseKey;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(...renderBold(text.slice(last, m.index), key)), key += 100;
    out.push(<span key={key++} style={{ color: m[1] }}>{renderBold(m[2], key + 200)}</span>);
    last = re.lastIndex;
  }
  if (last < text.length) {
    out.push(...renderBold(text.slice(last), key));
  }
  return out;
}

function renderBold(text: string, baseKey: number): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /\[b\](.*?)\[\/b\]/gs;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = baseKey;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(<span key={key++}>{text.slice(last, m.index)}</span>);
    out.push(<strong key={key++}>{m[1]}</strong>);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(<span key={key++}>{text.slice(last)}</span>);
  return out;
}

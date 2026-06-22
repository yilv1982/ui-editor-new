import { useRef, useEffect, useState, useCallback } from 'react';
import { useEditorStore } from '../../stores/editorStore';
import { getAdaptedAbsolutePosition } from '../../utils/anchorAdapt';

interface ColorPreset { color: string; label: string; desc: string }

export default function TextInlineEditor({ nodeId }: { nodeId: string }) {
  const node = useEditorStore((s) => s.nodes[nodeId]);
  const canvasX = useEditorStore((s) => s.canvasX);
  const canvasY = useEditorStore((s) => s.canvasY);
  const canvasScale = useEditorStore((s) => s.canvasScale);
  const previewWidth = useEditorStore((s) => s.previewWidth);
  const previewHeight = useEditorStore((s) => s.previewHeight);
  const nodes = useEditorStore((s) => s.nodes);
  const setEditingTextId = useEditorStore((s) => s.setEditingTextId);
  const updateNode = useEditorStore((s) => s.updateNode);
  const pushHistory = useEditorStore((s) => s.pushHistory);

  const taRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const historyPushed = useRef(false);
  const [colorPresets, setColorPresets] = useState<ColorPreset[]>([]);

  // 当前 active 画板的 (x, y) 偏移（用于把节点本地坐标转为屏幕坐标）
  const activePageId = useEditorStore((s) => s.activePageId);
  const activeArtboardId = useEditorStore((s) => s.activeArtboardId);
  const pages = useEditorStore((s) => s.pages);
  const activeArtboard = pages.find((p) => p.id === activePageId)?.artboards.find((a) => a.id === activeArtboardId);
  const offX = activeArtboard?.x ?? 0;
  const offY = activeArtboard?.y ?? 0;

  useEffect(() => {
    fetch('/colorPresets.json').then(r => r.json()).then(setColorPresets).catch(() => {});
  }, []);

  useEffect(() => {
    setTimeout(() => taRef.current?.focus(), 50);
  }, []);

  // 点击外部关闭
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setEditingTextId(null);
      }
    };
    document.addEventListener('mousedown', handler, true);
    return () => document.removeEventListener('mousedown', handler, true);
  }, [setEditingTextId]);

  const close = useCallback(() => setEditingTextId(null), [setEditingTextId]);

  if (!node) { close(); return null; }

  const adapted = getAdaptedAbsolutePosition(nodeId, nodes, previewWidth, previewHeight);
  const screenX = canvasX + (offX + adapted.x) * canvasScale;
  const screenY = canvasY + (offY + adapted.y) * canvasScale;
  const screenW = adapted.width * canvasScale;
  const screenH = adapted.height * canvasScale;

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    if (!historyPushed.current) {
      pushHistory();
      historyPushed.current = true;
    }
    updateNode(nodeId, { text: e.target.value });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { close(); e.stopPropagation(); }
  };

  const applyColor = (color: string) => {
    const ta = taRef.current;
    if (!ta) return;
    const s = ta.selectionStart, end = ta.selectionEnd;
    if (s === end) return;
    const txt = node.text || '';
    const selected = txt.slice(s, end);
    const wrapped = `<color=${color}>${selected}</color>`;
    const newText = txt.slice(0, s) + wrapped + txt.slice(end);
    if (!historyPushed.current) { pushHistory(); historyPushed.current = true; }
    updateNode(nodeId, { text: newText, richText: true });
    setTimeout(() => { ta.focus(); ta.selectionStart = ta.selectionEnd = s + wrapped.length; }, 0);
  };

  const wrapTag = (tag: string) => {
    const ta = taRef.current;
    if (!ta) return;
    const s = ta.selectionStart, end = ta.selectionEnd;
    if (s === end) return;
    const txt = node.text || '';
    const wrapped = `<${tag}>${txt.slice(s, end)}</${tag}>`;
    const newText = txt.slice(0, s) + wrapped + txt.slice(end);
    if (!historyPushed.current) { pushHistory(); historyPushed.current = true; }
    updateNode(nodeId, { text: newText, richText: true });
    setTimeout(() => { ta.focus(); ta.selectionStart = ta.selectionEnd = s + wrapped.length; }, 0);
  };

  const clearTags = () => {
    const ta = taRef.current;
    if (!ta) return;
    const s = ta.selectionStart, end = ta.selectionEnd;
    const txt = node.text || '';
    const region = s === end ? txt : txt.slice(s, end);
    const cleaned = region.replace(/<\/?(?:color=[^>]*|color|b|i)>/g, '');
    const newText = s === end ? cleaned : txt.slice(0, s) + cleaned + txt.slice(end);
    if (!historyPushed.current) { pushHistory(); historyPushed.current = true; }
    updateNode(nodeId, { text: newText, richText: newText.includes('<') });
    setTimeout(() => { ta.focus(); ta.selectionStart = s; ta.selectionEnd = s + cleaned.length; }, 0);
  };

  const minW = Math.max(screenW, 120);
  const minH = Math.max(screenH, 60);

  return (
    <div ref={containerRef} style={{ position: 'absolute', left: screenX, top: screenY - 28, zIndex: 30 }}
      className="pointer-events-auto">
      {/* 调色工具栏 */}
      <div className="flex items-center gap-1 px-2 py-1 rounded-t"
        style={{ background: '#1e1e2e', borderBottom: '1px solid #45475a' }}>
        <button title="加粗 <b>" className="text-[12px] font-bold text-[#cdd6f4] hover:text-[#89b4fa] px-1 leading-none"
          onClick={() => wrapTag('b')}>B</button>
        <button title="斜体 <i>" className="text-[12px] italic text-[#cdd6f4] hover:text-[#89b4fa] px-0.5 leading-none"
          onClick={() => wrapTag('i')}>I</button>
        <span className="w-px h-3 bg-[#45475a] mx-0.5" />
        {colorPresets.slice(0, 8).map((c, i) => (
          <button key={i} title={`${c.label}: ${c.color}`}
            className="w-3.5 h-3.5 rounded border border-[#45475a] hover:scale-125 transition-transform"
            style={{ backgroundColor: c.color }}
            onClick={() => applyColor(c.color)} />
        ))}
        <input type="color" className="w-3.5 h-3.5 p-0 border-none cursor-pointer" title="自定义颜色"
          onChange={(e) => applyColor(e.target.value)} />
        <span className="w-px h-3 bg-[#45475a] mx-0.5" />
        <button title="清除所有富文本标签" className="text-[11px] text-[#f38ba8] hover:text-[#eba0ac] px-1"
          onClick={clearTags}>清除</button>
      </div>
      {/* 文本编辑区 */}
      <textarea ref={taRef} value={node.text || ''} onChange={handleChange} onKeyDown={handleKeyDown}
        className="block outline-none resize-none rounded-b"
        style={{
          width: minW, minHeight: minH,
          background: 'rgba(30,30,46,0.92)', color: '#cdd6f4',
          border: '1px solid #89b4fa', borderTop: 'none',
          padding: '4px 6px', fontSize: Math.max(12, (node.style?.fontSize || 14) * canvasScale * 0.6),
          lineHeight: 1.4, fontFamily: 'inherit',
        }} />
    </div>
  );
}

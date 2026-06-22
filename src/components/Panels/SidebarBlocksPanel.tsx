// src/components/Panels/SidebarBlocksPanel.tsx
// 页面说明栏编辑面板 — 每个画板独立一个,默认作用在 active 画板
// 编辑器在画布上画板右侧浮动显示
import { useState, useRef, useEffect } from 'react';
import { useEditorStore } from '../../stores/editorStore';
import type { SidebarBlock, SidebarBlockType, TagRole } from '../../types';
import { TAG_COLORS } from '../../types';
import RichTextEditor, { renderTaggedText } from './RichTextEditor';

const BLOCK_LABELS: Record<SidebarBlockType, string> = {
  plain: '段落',
  title: '标题',
  bullet: '项目',
  numbered: '编号',
  tag: '@标签',
  'inset-image': '嵌入截图',
};

const BLOCK_ICONS: Record<SidebarBlockType, string> = {
  plain: '¶',
  title: 'T',
  bullet: '·',
  numbered: '1.',
  tag: '@',
  'inset-image': '🖼',
};

interface Props {
  /** 指定操作哪个画板的 sidebar；不传则用 active 画板 */
  artboardId?: string;
}

export default function SidebarBlocksPanel({ artboardId: artboardIdProp }: Props = {}) {
  const activePageId = useEditorStore((s) => s.activePageId);
  const activeArtboardId = useEditorStore((s) => s.activeArtboardId);
  const pages = useEditorStore((s) => s.pages);
  const page = pages.find((p) => p.id === activePageId);
  const targetArtboardId = artboardIdProp ?? activeArtboardId;
  const artboard = page?.artboards.find((a) => a.id === targetArtboardId);
  const sidebar = artboard?.sidebar ?? [];
  const enabled = artboard?.sidebarEnabled ?? false;

  const [collapsed, setCollapsed] = useState(false);
  const [showAddMenu, setShowAddMenu] = useState(false);
  // 失焦时默认预览,聚焦时编辑
  const [previewMode, setPreviewMode] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);

  // 失焦切回预览
  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      if (containerRef.current?.contains(e.target as Node)) {
        setPreviewMode(false);
      }
    };
    const onPointerDown = (e: PointerEvent) => {
      if (containerRef.current?.contains(e.target as Node)) {
        setPreviewMode(false);
      } else {
        setPreviewMode(true);
        setShowAddMenu(false);
      }
    };
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, []);

  if (!page) return null;

  const addBlock = (type: SidebarBlockType) => {
    useEditorStore.getState().addSidebarBlock(activePageId, type, undefined, targetArtboardId);
    setShowAddMenu(false);
  };

  return (
    <div ref={containerRef} className="border-t border-[#313244] bg-[#1e1e2e] shrink-0">
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="w-full flex items-center justify-between px-3 py-2 text-[12px] text-[#a6adc8] hover:bg-[#313244]"
      >
        <span>页面说明栏 {sidebar.length > 0 && <span className="text-[#6c7086]">({sidebar.length})</span>}</span>
        <span>{collapsed ? '▶' : '▼'}</span>
      </button>
      {!collapsed && (
        <div className="px-2 pb-2">
          <div className="flex items-center gap-2 mb-2">
            <label className="flex items-center gap-2 text-[12px] text-[#a6adc8] cursor-pointer flex-1">
              <input
                type="checkbox"
                checked={enabled}
                onChange={() => useEditorStore.getState().toggleSidebarEnabled(activePageId, targetArtboardId)}
              />
              启用(导出"对接评审版"时显示)
            </label>
            <button
              onClick={() => setPreviewMode(false)}
              className="px-2 py-1 text-[11px] rounded"
              style={{
                background: previewMode ? '#313244' : '#89b4fa',
                color: previewMode ? '#cdd6f4' : '#1e1e2e',
              }}
              title="编辑（点面板外区域自动回预览）"
            >
              ✏️ 编辑
            </button>
          </div>

          {previewMode ? (
            // 预览模式：只读展示，仿 UE 评审稿样式
            <div className="bg-[#11111b] rounded p-3 text-[13px] leading-relaxed" style={{ color: '#cdd6f4' }}>
              {sidebar.length === 0 ? (
                <div className="text-[11px] text-[#6c7086] text-center py-2">还没有内容</div>
              ) : (
                sidebar.map((b) => <PreviewBlock key={b.id} block={b} />)
              )}
            </div>
          ) : (
            // 编辑模式：原有的 block 列表
            <>
              <div className="relative mb-2">
                <button
                  onClick={() => setShowAddMenu((v) => !v)}
                  className="w-full px-2 py-1 text-[12px] text-[#cdd6f4] bg-[#313244] hover:bg-[#45475a] rounded text-left"
                >
                  + 添加 ▾
                </button>
                {showAddMenu && (
                  <div className="absolute left-0 right-0 top-full mt-1 z-10 bg-[#313244] border border-[#45475a] rounded shadow-lg max-h-none">
                    {(Object.keys(BLOCK_LABELS) as SidebarBlockType[]).map((t) => (
                      <button
                        key={t}
                        onClick={() => addBlock(t)}
                        className="w-full text-left px-2 py-1 text-[12px] text-[#cdd6f4] hover:bg-[#45475a] flex items-center gap-2"
                      >
                        <span className="w-4 text-center text-[#89b4fa]">{BLOCK_ICONS[t]}</span>
                        {BLOCK_LABELS[t]}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="space-y-1">
                {sidebar.length === 0 && (
                  <div className="text-[11px] text-[#6c7086] text-center py-2">
                    还没有 block,点 + 添加
                  </div>
                )}
                {sidebar.map((b, i) => (
                  <BlockRow
                    key={b.id}
                    block={b}
                    pageId={activePageId}
                    artboardId={targetArtboardId}
                    pages={pages}
                    isFirst={i === 0}
                    isLast={i === sidebar.length - 1}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

interface BlockRowProps {
  block: SidebarBlock;
  pageId: string;
  artboardId: string;
  pages: { id: string; name: string }[];
  isFirst: boolean;
  isLast: boolean;
}

function BlockRow({ block, pageId, artboardId, pages, isFirst, isLast }: BlockRowProps) {
  const update = (patch: Partial<SidebarBlock>) =>
    useEditorStore.getState().updateSidebarBlock(pageId, block.id, patch, artboardId);
  const remove = () => useEditorStore.getState().deleteSidebarBlock(pageId, block.id, artboardId);
  const move = (dir: 'up' | 'down') =>
    useEditorStore.getState().reorderSidebarBlock(pageId, block.id, dir, artboardId);

  const [richOpen, setRichOpen] = useState(false);

  return (
    <div className="bg-[#181825] border border-[#313244] rounded p-1.5">
      <div className="flex items-center gap-1 mb-1">
        <span className="w-5 text-center text-[12px] text-[#89b4fa] shrink-0">{BLOCK_ICONS[block.type]}</span>
        <span className="text-[11px] text-[#6c7086] flex-1">{BLOCK_LABELS[block.type]}</span>
        {block.type !== 'inset-image' && (
          <button
            onClick={() => setRichOpen(true)}
            className="w-5 h-5 text-[11px] text-[#cba6f7] hover:bg-[#313244] rounded"
            title="富文本编辑（局部变色）"
          >🎨</button>
        )}
        <button
          onClick={() => move('up')}
          disabled={isFirst}
          className="w-5 h-5 text-[12px] text-[#a6adc8] hover:bg-[#313244] rounded disabled:opacity-30"
          title="上移"
        >↑</button>
        <button
          onClick={() => move('down')}
          disabled={isLast}
          className="w-5 h-5 text-[12px] text-[#a6adc8] hover:bg-[#313244] rounded disabled:opacity-30"
          title="下移"
        >↓</button>
        <button
          onClick={remove}
          className="w-5 h-5 text-[12px] text-[#f38ba8] hover:bg-[#313244] rounded"
          title="删除"
        >×</button>
      </div>
      {block.type === 'tag' && (
        <div className="flex gap-1">
          <select
            value={block.role ?? 'program'}
            onChange={(e) => update({ role: e.target.value as TagRole })}
            className="text-[12px] bg-[#313244] text-[#cdd6f4] border border-[#45475a] rounded px-1 py-0.5"
          >
            {(Object.keys(TAG_COLORS) as TagRole[]).map((r) => (
              <option key={r} value={r}>{TAG_COLORS[r].label}</option>
            ))}
          </select>
          <input
            type="text"
            value={block.text ?? ''}
            placeholder="附加文本(可选)"
            onChange={(e) => update({ text: e.target.value })}
            className="flex-1 text-[12px]"
          />
        </div>
      )}
      {block.type === 'inset-image' && (
        <select
          value={block.refPageId ?? ''}
          onChange={(e) => update({ refPageId: e.target.value || undefined })}
          className="w-full text-[12px] bg-[#313244] text-[#cdd6f4] border border-[#45475a] rounded px-1 py-0.5"
        >
          <option value="">— 选择源页面 —</option>
          {pages.filter((p) => p.id !== pageId).map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      )}
      {(block.type === 'plain' || block.type === 'title' || block.type === 'bullet' || block.type === 'numbered') && (
        <textarea
          value={block.text ?? ''}
          onChange={(e) => update({ text: e.target.value })}
          rows={block.type === 'plain' ? 2 : 1}
          className="w-full text-[12px] resize-none"
          placeholder={block.type === 'title' ? '标题' : '内容'}
        />
      )}

      {richOpen && (
        <RichTextEditor
          initialText={block.text ?? ''}
          onConfirm={(text) => { update({ text }); setRichOpen(false); }}
          onCancel={() => setRichOpen(false)}
        />
      )}
    </div>
  );
}

// ===== 预览模式 block 渲染（仿 UE 评审稿样式） =====

function PreviewBlock({ block }: { block: SidebarBlock }) {
  const base: React.CSSProperties = { whiteSpace: 'pre-wrap', wordBreak: 'break-word' };
  const text = block.text ?? '';

  if (block.type === 'title') {
    return (
      <div style={{ ...base, fontSize: 15, fontWeight: 600, color: '#89b4fa', marginTop: 10, marginBottom: 4 }}>
        {text ? renderTaggedText(text) : '（标题）'}
      </div>
    );
  }
  if (block.type === 'plain') {
    return <div style={{ ...base, marginBottom: 6 }}>{renderTaggedText(text)}</div>;
  }
  if (block.type === 'bullet') {
    return <div style={{ ...base, marginLeft: 14, marginBottom: 2 }}>・{renderTaggedText(text)}</div>;
  }
  if (block.type === 'numbered') {
    return <div style={{ ...base, marginLeft: 14, marginBottom: 2 }}>{renderTaggedText(text)}</div>;
  }
  if (block.type === 'tag') {
    const role = (block.role ?? 'program') as TagRole;
    const cfg = TAG_COLORS[role];
    return (
      <div style={{ marginBottom: 6 }}>
        <span style={{
          background: cfg?.bg ?? '#cba6f7',
          color: cfg?.fg ?? '#1e1e2e',
          padding: '2px 8px',
          borderRadius: 3,
          fontSize: 12,
          fontWeight: 600,
          marginRight: 6,
        }}>{cfg?.label ?? role}</span>
        <span>{renderTaggedText(text)}</span>
      </div>
    );
  }
  if (block.type === 'inset-image') {
    return (
      <div style={{ marginBottom: 4, fontSize: 11, color: '#6c7086' }}>
        [嵌入截图: {block.refPageId ?? '未选择'}]
      </div>
    );
  }
  return null;
}

import { useState, useCallback, useEffect, useRef } from 'react';
import { useEditorStore } from '../../stores/editorStore';
import { useShallow } from 'zustand/react/shallow';
import type { UIStyle } from '../../types';
import { anchorPresets, getAnchorPreset } from '../../types';
import { registerDropTarget } from '../../utils/customDrag';
import { FONT_LIST } from '../../config/assetPaths';
import AnnotationPropertyPanel from './AnnotationPropertyPanel';

// 字色预设类型
interface ColorPreset { color: string; label: string; desc: string; }

function NumberField({ label, value, onChange, min, max, step = 1 }: {
  label: string; value: number; onChange: (v: number) => void;
  min?: number; max?: number; step?: number;
}) {
  const rounded = Math.round(value * 100) / 100;
  const [localValue, setLocalValue] = useState(String(rounded));
  const [editing, setEditing] = useState(false);
  const prevValue = useRef(rounded);

  // 外部值变化时同步到本地（非编辑状态）
  useEffect(() => {
    if (!editing && rounded !== prevValue.current) {
      setLocalValue(String(rounded));
      prevValue.current = rounded;
    }
  }, [rounded, editing]);

  const commit = () => {
    setEditing(false);
    const num = Number(localValue);
    if (!isNaN(num)) {
      const clamped = min != null ? Math.max(min, num) : num;
      onChange(clamped);
      prevValue.current = Math.round(clamped * 100) / 100;
      setLocalValue(String(prevValue.current));
    } else {
      // 无效输入，恢复
      setLocalValue(String(rounded));
    }
  };

  return (
    <div className="flex items-center justify-between">
      <span className="text-[13px] text-[#a6adc8] w-8">{label}</span>
      <input
        type="number"
        value={localValue}
        onFocus={() => setEditing(true)}
        onChange={(e) => setLocalValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.currentTarget.blur(); } }}
        min={min}
        max={max}
        step={step}
        className="w-20 text-sm text-right"
      />
    </div>
  );
}

function ColorField({ label, value, onChange }: {
  label: string; value: string; onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[13px] text-[#a6adc8]">{label}</span>
      <div className="flex items-center gap-1">
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-6 h-6 p-0 border-none cursor-pointer"
        />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-16 text-sm"
        />
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <h4 className="text-[13px] font-medium text-[#89b4fa] mb-2 uppercase tracking-wide">{title}</h4>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

export default function PropertyPanel() {
  const selectedIds = useEditorStore((s) => s.selectedIds);
  const selectedAnnotationIds = useEditorStore((s) => s.selectedAnnotationIds);
  // 只订阅"选中节点"本身。拖动未选中节点时不会触发 re-render；
  // 拖动选中节点时这里返回新值，触发 PropertyPanel 更新 x/y 显示。
  const selectedNode = useEditorStore(useShallow((s) => {
    const id = s.selectedIds[0];
    return id ? s.nodes[id] : null;
  }));
  const updateNode = useEditorStore((s) => s.updateNode);
  const updateNodeStyle = useEditorStore((s) => s.updateNodeStyle);
  const pushHistory = useEditorStore((s) => s.pushHistory);

  // 字色预设（从 JSON 加载 + 编辑状态）
  const [colorPresets, setColorPresets] = useState<ColorPreset[]>([]);
  const [editingPresets, setEditingPresets] = useState(false);
  const [editDraft, setEditDraft] = useState<ColorPreset[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    fetch('/colorPresets.json').then(r => r.json()).then(setColorPresets).catch(() => {});
  }, []);

  const savePresets = useCallback(async (presets: ColorPreset[]) => {
    setColorPresets(presets);
    try { await fetch('/api/color-presets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(presets) }); } catch {}
  }, []);

  if (selectedAnnotationIds.length > 0) {
    return (
      <div className="w-72 bg-[#1e1e2e] border-l border-[#313244] overflow-y-auto">
        <div className="px-3 py-2 border-b border-[#313244]">
          <h3 className="text-sm font-medium text-[#cdd6f4]">属性</h3>
        </div>
        <AnnotationPropertyPanel />
      </div>
    );
  }

  if (selectedIds.length === 0) {
    return (
      <div className="w-72 bg-[#1e1e2e] border-l border-[#313244] flex items-center justify-center">
        <span className="text-sm text-[#6c7086]">选中节点以编辑属性</span>
      </div>
    );
  }

  if (selectedIds.length > 1) {
    return (
      <div className="w-72 bg-[#1e1e2e] border-l border-[#313244] flex items-center justify-center">
        <span className="text-sm text-[#6c7086]">已选中 {selectedIds.length} 个节点</span>
      </div>
    );
  }

  const node = selectedNode;
  if (!node) return null;

  // Button 是否有 Image 组件：显式标记优先，未标记时从 imageData 推断
  const btnHasImg = node.type !== 'button' || node.hasImage === true || (node.hasImage === undefined && !!node.imageData);

  const update = (field: string, value: any) => {
    pushHistory();
    const extras: Record<string, any> = {};
    if (field === 'x' || field === 'y') extras.originalAnchoredPosition = undefined;
    if (field === 'width' || field === 'height') extras.originalSizeDelta = undefined;
    updateNode(node.id, { [field]: value, ...extras });
  };

  const updateStyle = (field: keyof UIStyle, value: any) => {
    pushHistory();
    updateNodeStyle(node.id, { [field]: value });
  };

  return (
    <div className="w-72 bg-[#1e1e2e] border-l border-[#313244] overflow-y-auto">
      <div className="px-3 py-2 border-b border-[#313244]">
        <h3 className="text-sm font-medium text-[#cdd6f4]">属性</h3>
      </div>

      <div className="px-3 py-3 space-y-1">
        {/* 名称 */}
        <Section title="基本">
          <div className="flex items-center justify-between">
            <span className="text-[13px] text-[#a6adc8]">名称</span>
            <input
              type="text"
              value={node.name}
              onChange={(e) => update('name', e.target.value)}
              className="w-32 text-sm"
            />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[13px] text-[#a6adc8]">类型</span>
            <span className="text-[13px] text-[#cdd6f4]">{node.type}</span>
          </div>
          {node.type === 'component' && (
            <div className="flex items-center justify-between">
              <span className="text-[13px] text-[#a6adc8]">组件</span>
              <span className="text-[13px] text-[#89b4fa]">@{node.componentRef}</span>
            </div>
          )}
          {node.type === 'component' && (
            <div className="flex items-center justify-between">
              <span className="text-[13px] text-[#a6adc8]">置灰</span>
              <button
                onClick={() => { pushHistory(); updateNode(node.id, { interactable: node.interactable === false ? true : false }); }}
                className={`px-3 py-0.5 text-[13px] rounded ${node.interactable === false ? 'bg-[#a6e3a1] text-[#1e1e2e]' : 'bg-[#313244] text-[#a6adc8]'}`}
                title="灰化整个组件子树（参考 ImgUtil.SetButtonGray）"
              >
                {node.interactable === false ? '是' : '否'}
              </button>
            </div>
          )}
        </Section>

        {/* 位置大小 */}
        <Section title="变换">
          <div className="grid grid-cols-2 gap-2">
            <NumberField label="X" value={node.x} onChange={(v) => update('x', v)} />
            <NumberField label="Y" value={node.y} onChange={(v) => update('y', v)} />
            <NumberField label="W" value={node.width} onChange={(v) => update('width', v)} min={1} />
            <NumberField label="H" value={node.height} onChange={(v) => update('height', v)} min={1} />
          </div>
          <NumberField label="旋转" value={node.rotation} onChange={(v) => update('rotation', v)} />
        </Section>

        {/* 锚点 Anchor */}
        <Section title="锚点 Anchor">
          {/* 4x4 可视化预设网格 */}
          <div className="flex gap-3 items-start">
            {/* 预设网格 */}
            <div className="inline-grid grid-cols-4 gap-px bg-[#45475a] p-px rounded" style={{ width: 'fit-content' }}>
              {anchorPresets.map((preset) => {
                const current = getAnchorPreset(node.anchorMin, node.anchorMax);
                const isActive = current === preset.key;
                const isStretchH = preset.anchorMin.x !== preset.anchorMax.x;
                const isStretchV = preset.anchorMin.y !== preset.anchorMax.y;

                return (
                  <button
                    key={preset.key}
                    title={preset.label}
                    onClick={() => {
                      pushHistory();
                      updateNode(node.id, {
                        anchorMin: { ...preset.anchorMin },
                        anchorMax: { ...preset.anchorMax },
                        // 清除 Unity 原始值缓存，导出时会基于新锚点重新计算
                        originalAnchoredPosition: undefined,
                        originalSizeDelta: undefined,
                      });
                    }}
                    className={`w-7 h-7 flex items-center justify-center relative ${
                      isActive ? 'bg-[#89b4fa]' : 'bg-[#313244] hover:bg-[#45475a]'
                    }`}
                  >
                    {/* 锚点指示图标 */}
                    <svg width="17" height="17" viewBox="0 0 17 17">
                      {/* 外框（父节点区域） */}
                      <rect x="1" y="1" width="15" height="15" fill="none"
                        stroke={isActive ? '#1e1e2e' : '#6c7086'} strokeWidth="0.8" />
                      {/* 锚点标记 */}
                      {!isStretchH && !isStretchV && (
                        // 点锚点
                        <rect
                          x={1 + preset.anchorMin.x * 15 - 2}
                          y={1 + (1 - preset.anchorMin.y) * 15 - 2}
                          width="4" height="4"
                          fill={isActive ? '#1e1e2e' : '#f9e2af'}
                        />
                      )}
                      {isStretchH && !isStretchV && (
                        // 水平拉伸线
                        <line
                          x1="2" y1={1 + (1 - preset.anchorMin.y) * 15}
                          x2="15" y2={1 + (1 - preset.anchorMin.y) * 15}
                          stroke={isActive ? '#1e1e2e' : '#f9e2af'} strokeWidth="2"
                        />
                      )}
                      {!isStretchH && isStretchV && (
                        // 垂直拉伸线
                        <line
                          x1={1 + preset.anchorMin.x * 15} y1="2"
                          x2={1 + preset.anchorMin.x * 15} y2="15"
                          stroke={isActive ? '#1e1e2e' : '#f9e2af'} strokeWidth="2"
                        />
                      )}
                      {isStretchH && isStretchV && (
                        // 全拉伸（十字）
                        <>
                          <line x1="2" y1="8.5" x2="15" y2="8.5"
                            stroke={isActive ? '#1e1e2e' : '#f9e2af'} strokeWidth="1.5" />
                          <line x1="8.5" y1="2" x2="8.5" y2="15"
                            stroke={isActive ? '#1e1e2e' : '#f9e2af'} strokeWidth="1.5" />
                        </>
                      )}
                    </svg>
                  </button>
                );
              })}
            </div>

            {/* 右侧：当前值显示 */}
            <div className="flex-1 text-[12px] text-[#6c7086] space-y-0.5 pt-0.5">
              <div>{getAnchorPreset(node.anchorMin, node.anchorMax) === 'custom' ? '自定义' : anchorPresets.find(p => p.key === getAnchorPreset(node.anchorMin, node.anchorMax))?.label}</div>
              <div>Min ({(node.anchorMin?.x ?? 0.5).toFixed(1)}, {(node.anchorMin?.y ?? 0.5).toFixed(1)})</div>
              <div>Max ({(node.anchorMax?.x ?? 0.5).toFixed(1)}, {(node.anchorMax?.y ?? 0.5).toFixed(1)})</div>
            </div>
          </div>

          {/* Pivot */}
          <div className="flex items-center gap-2 mt-2">
            <span className="text-[12px] text-[#6c7086] w-10">Pivot</span>
            <input
              type="number" min={0} max={1} step={0.1}
              value={node.pivot?.x ?? 0.5}
              onChange={(e) => {
                pushHistory();
                const oldPx = node.pivot?.x ?? 0.5;
                const newPx = Number(e.target.value);
                // 保持 anchoredPosition 不变：调整 x 补偿 pivot 变化（与 Unity 行为一致）
                updateNode(node.id, {
                  pivot: { x: newPx, y: node.pivot?.y ?? 0.5 },
                  x: node.x + (oldPx - newPx) * node.width,
                  originalAnchoredPosition: undefined,
                });
              }}
              className="w-14 text-sm text-center"
            />
            <input
              type="number" min={0} max={1} step={0.1}
              value={node.pivot?.y ?? 0.5}
              onChange={(e) => {
                pushHistory();
                const oldPy = node.pivot?.y ?? 0.5;
                const newPy = Number(e.target.value);
                // Y 轴：编辑器 Y 朝下，Unity pivot Y 朝上
                updateNode(node.id, {
                  pivot: { x: node.pivot?.x ?? 0.5, y: newPy },
                  y: node.y + (oldPy - newPy) * node.height,
                  originalAnchoredPosition: undefined,
                });
              }}
              className="w-14 text-sm text-center"
            />
          </div>
        </Section>

        {/* 样式 */}
        {node.type !== 'component' && (
          <Section title="样式">
            <ColorField label="背景" value={node.style.backgroundColor} onChange={(v) => {
              pushHistory();
              const patch: Partial<UIStyle> = { backgroundColor: v };
              if (v && v !== 'transparent') patch.backgroundOpacity = 1;
              updateNodeStyle(node.id, patch);
            }} />
          </Section>
        )}

        {/* 文字 */}
        {node.type === 'text' && (
          <Section title="文字">
            {/* 富文本工具栏 */}
            <div className="flex items-center gap-1 mb-1">
              <button
                title="加粗选中文字 <b>"
                className="text-[12px] font-bold text-[#cdd6f4] hover:text-[#89b4fa] px-1 leading-none"
                onClick={() => {
                  const ta = textareaRef.current;
                  if (!ta) return;
                  const s = ta.selectionStart, e2 = ta.selectionEnd;
                  if (s === e2) return;
                  const txt = node.text || '';
                  const wrapped = `<b>${txt.slice(s, e2)}</b>`;
                  const newText = txt.slice(0, s) + wrapped + txt.slice(e2);
                  pushHistory();
                  updateNode(node.id, { text: newText, richText: true });
                  setTimeout(() => { ta.focus(); ta.selectionStart = ta.selectionEnd = s + wrapped.length; }, 0);
                }}
              >B</button>
              <button
                title="斜体选中文字 <i>"
                className="text-[12px] italic text-[#cdd6f4] hover:text-[#89b4fa] px-0.5 leading-none"
                onClick={() => {
                  const ta = textareaRef.current;
                  if (!ta) return;
                  const s = ta.selectionStart, e2 = ta.selectionEnd;
                  if (s === e2) return;
                  const txt = node.text || '';
                  const wrapped = `<i>${txt.slice(s, e2)}</i>`;
                  const newText = txt.slice(0, s) + wrapped + txt.slice(e2);
                  pushHistory();
                  updateNode(node.id, { text: newText, richText: true });
                  setTimeout(() => { ta.focus(); ta.selectionStart = ta.selectionEnd = s + wrapped.length; }, 0);
                }}
              >I</button>
              <span className="w-px h-3 bg-[#45475a]" />
              <span className="text-[12px] text-[#6c7086] mr-0.5">变色</span>
              {colorPresets.slice(0, 8).map((c, i) => (
                <button
                  key={i}
                  title={`${c.label}: 选中文字变 ${c.color}`}
                  className="w-4 h-4 rounded border border-[#45475a] hover:scale-125 transition-transform"
                  style={{ backgroundColor: c.color }}
                  onClick={() => {
                    const ta = textareaRef.current;
                    if (!ta) return;
                    const s = ta.selectionStart, e2 = ta.selectionEnd;
                    if (s === e2) return; // 无选区
                    const txt = node.text || '';
                    const selected = txt.slice(s, e2);
                    const wrapped = `<color=${c.color}>${selected}</color>`;
                    const newText = txt.slice(0, s) + wrapped + txt.slice(e2);
                    pushHistory();
                    updateNode(node.id, { text: newText, richText: true });
                    // 恢复光标到标签后
                    setTimeout(() => { ta.focus(); ta.selectionStart = ta.selectionEnd = s + wrapped.length; }, 0);
                  }}
                />
              ))}
              {/* 自定义颜色 */}
              <input
                type="color"
                className="w-4 h-4 p-0 border-none cursor-pointer"
                title="自定义颜色"
                onChange={(e) => {
                  const ta = textareaRef.current;
                  if (!ta) return;
                  const s = ta.selectionStart, e2 = ta.selectionEnd;
                  if (s === e2) return;
                  const txt = node.text || '';
                  const selected = txt.slice(s, e2);
                  const wrapped = `<color=${e.target.value}>${selected}</color>`;
                  const newText = txt.slice(0, s) + wrapped + txt.slice(e2);
                  pushHistory();
                  updateNode(node.id, { text: newText, richText: true });
                }}
              />
              {/* 清除颜色标签 */}
              <button
                title="清除选中区域的富文本标签"
                className="text-[12px] text-[#f38ba8] hover:text-[#eba0ac] px-1"
                onClick={() => {
                  const ta = textareaRef.current;
                  if (!ta) return;
                  const s = ta.selectionStart, e2 = ta.selectionEnd;
                  const txt = node.text || '';
                  const region = s === e2 ? txt : txt.slice(s, e2);
                  const cleaned = region.replace(/<\/?(?:color=[^>]*|color|b|i)>/g, '');
                  const newText = s === e2 ? cleaned : txt.slice(0, s) + cleaned + txt.slice(e2);
                  pushHistory();
                  updateNode(node.id, { text: newText, richText: newText.includes('<') });
                  setTimeout(() => { ta.focus(); ta.selectionStart = s; ta.selectionEnd = s + cleaned.length; }, 0);
                }}
              >
                清除
              </button>
            </div>
            <div>
              <textarea
                ref={textareaRef}
                value={node.text || ''}
                onChange={(e) => update('text', e.target.value)}
                className="w-full text-sm bg-[#313244] border border-[#45475a] text-[#cdd6f4] rounded p-2 resize-none h-16 outline-none focus:border-[#89b4fa] font-mono"
              />
            </div>
            {/* 富文本预览 */}
            {node.text && /(<color|<b>|<i>)/.test(node.text) && (
              <div
                className="w-full text-sm bg-[#11111b] border border-[#313244] rounded p-2 mt-1 break-all"
                style={{ color: node.style.fontColor }}
                dangerouslySetInnerHTML={{
                  __html: (node.text || '')
                    .replace(/</g, '&lt;').replace(/>/g, '&gt;')
                    .replace(/&lt;color=([^&]*)&gt;/g, '<span style="color:$1">')
                    .replace(/&lt;\/color&gt;/g, '</span>')
                    .replace(/&lt;b&gt;/g, '<b>').replace(/&lt;\/b&gt;/g, '</b>')
                    .replace(/&lt;i&gt;/g, '<i>').replace(/&lt;\/i&gt;/g, '</i>')
                }}
              />
            )}
            {/* 字体 */}
            <div className="flex items-center justify-between">
              <span className="text-[13px] text-[#a6adc8]">字体</span>
              <select
                value={node.fontPath || ''}
                onChange={(e) => update('fontPath', e.target.value || undefined)}
                className="w-28 text-[12px] bg-[#313244] text-[#cdd6f4] border border-[#45475a] rounded px-1 py-0.5 outline-none"
              >
                <option value="">默认</option>
                {FONT_LIST.map(f => (
                  <option key={f.path} value={f.path}>{f.label}</option>
                ))}
              </select>
            </div>
            {/* 字体样式 */}
            <div className="flex items-center justify-between">
              <span className="text-[13px] text-[#a6adc8]">样式</span>
              <div className="flex gap-1.5">
                {([
                  { value: 0, label: 'N' , title: 'Normal' },
                  { value: 1, label: 'B', title: 'Bold' },
                  { value: 2, label: 'I', title: 'Italic' },
                  { value: 3, label: 'BI', title: 'BoldItalic' },
                ] as const).map((s) => (
                  <button
                    key={s.value}
                    title={s.title}
                    onClick={() => update('fontStyle', s.value)}
                    className={`px-2.5 py-1 text-[13px] rounded ${
                      (node.fontStyle || 0) === s.value ? 'bg-[#89b4fa] text-[#1e1e2e]' : 'bg-[#313244] text-[#a6adc8]'
                    }`}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
            <NumberField label="字号" value={node.style.fontSize} onChange={(v) => updateStyle('fontSize', v)} min={8} />
            <ColorField label="字色" value={node.style.fontColor} onChange={(v) => updateStyle('fontColor', v)} />
            {/* 预设颜色 */}
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-[13px] text-[#a6adc8]">预设</span>
                <button
                  onClick={() => { setEditDraft(colorPresets.map(c => ({ ...c }))); setEditingPresets(!editingPresets); }}
                  className="text-[12px] text-[#6c7086] hover:text-[#89b4fa] transition-colors"
                >{editingPresets ? '完成' : '编辑'}</button>
              </div>
              <div className="flex gap-1 flex-wrap">
                {colorPresets.map((c, i) => (
                  <div key={i} className="relative group">
                    <button
                      title={`${c.label}${c.desc ? ' — ' + c.desc : ''}`}
                      onClick={() => { pushHistory(); updateStyle('fontColor', c.color); }}
                      className={`w-6 h-6 rounded border transition-all ${
                        node.style.fontColor === c.color ? 'border-[#89b4fa] ring-1 ring-[#89b4fa] scale-110' : 'border-[#45475a] hover:border-[#6c7086]'
                      }`}
                      style={{ backgroundColor: c.color }}
                    />
                    {/* 悬浮提示 */}
                    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover:block z-50 pointer-events-none">
                      <div className="bg-[#11111b] text-[#cdd6f4] text-[12px] px-2 py-1 rounded shadow-lg whitespace-nowrap border border-[#313244]">
                        <div className="font-medium">{c.label} {c.color}</div>
                        {c.desc && <div className="text-[#6c7086]">{c.desc}</div>}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              {/* 编辑面板 */}
              {editingPresets && (
                <div className="bg-[#11111b] rounded-lg p-2 border border-[#313244] space-y-1 mt-1">
                  <div className="text-[12px] text-[#6c7086] mb-1">团队共享预设 — 修改后自动保存</div>
                  {editDraft.map((c, i) => (
                    <div key={i} className="flex items-center gap-1">
                      <input type="color" value={c.color} onChange={(e) => {
                        const d = [...editDraft]; d[i] = { ...d[i], color: e.target.value }; setEditDraft(d);
                      }} className="w-5 h-5 p-0 border-none cursor-pointer flex-shrink-0" />
                      <input value={c.label} placeholder="名称" onChange={(e) => {
                        const d = [...editDraft]; d[i] = { ...d[i], label: e.target.value }; setEditDraft(d);
                      }} className="w-10 text-[12px] px-1 py-0.5 flex-shrink-0" />
                      <input value={c.desc} placeholder="说明" onChange={(e) => {
                        const d = [...editDraft]; d[i] = { ...d[i], desc: e.target.value }; setEditDraft(d);
                      }} className="flex-1 text-[12px] px-1 py-0.5 min-w-0" />
                      <button onClick={() => { setEditDraft(editDraft.filter((_, j) => j !== i)); }}
                        className="text-[#f38ba8] hover:text-[#eba0ac] text-[13px] flex-shrink-0 w-4 text-center">×</button>
                    </div>
                  ))}
                  <div className="flex gap-1 mt-1">
                    <button onClick={() => setEditDraft([...editDraft, { color: '#ffffff', label: '新颜色', desc: '' }])}
                      className="flex-1 text-[12px] text-[#a6adc8] bg-[#313244] hover:bg-[#45475a] rounded py-0.5">+ 添加</button>
                    <button onClick={() => { savePresets(editDraft); setEditingPresets(false); }}
                      className="flex-1 text-[12px] text-[#1e1e2e] bg-[#89b4fa] hover:bg-[#74a8fc] rounded py-0.5">保存</button>
                  </div>
                </div>
              )}
            </div>
            {/* Unity TextAnchor 对齐 3×3 网格 */}
            <div className="flex items-center justify-between">
              <span className="text-[13px] text-[#a6adc8]">对齐</span>
              <div className="grid grid-cols-3 gap-0.5">
                {([
                  { v: 0, icon: '╔' }, { v: 1, icon: '╦' }, { v: 2, icon: '╗' },
                  { v: 3, icon: '╠' }, { v: 4, icon: '╬' }, { v: 5, icon: '╣' },
                  { v: 6, icon: '╚' }, { v: 7, icon: '╩' }, { v: 8, icon: '╝' },
                ] as const).map(({ v }) => (
                  <button
                    key={v}
                    title={['左上','中上','右上','左中','居中','右中','左下','中下','右下'][v]}
                    onClick={() => {
                      pushHistory();
                      const hAlign: 'left'|'center'|'right' = ['left','center','right'][v % 3] as any;
                      updateStyle('textAlign', hAlign);
                      updateNode(node.id, { alignment: v });
                    }}
                    className={`w-7 h-7 flex items-center justify-center rounded ${
                      (node.alignment ?? 3) === v ? 'bg-[#4C7EF3] text-[#fff]' : 'bg-[#313244] text-[#6c7086] hover:text-[#a6adc8]'
                    }`}
                  >
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                      {[0,1,2].map(row => {
                        const col = v % 3;
                        const vRow = Math.floor(v / 3);
                        const yBase = vRow === 0 ? 1.5 : vRow === 1 ? 4 : 6.5;
                        const widths = [10, 7, 5.5];
                        const w = widths[row];
                        const x = col === 0 ? 2 : col === 1 ? (14 - w) / 2 : 12 - w;
                        return <rect key={row} x={x} y={yBase + row * 3} width={w} height={1.5} rx="0.4" fill="currentColor" />;
                      })}
                    </svg>
                  </button>
                ))}
              </div>
            </div>
          </Section>
        )}

        {/* 控件类型标识 */}
        {['button', 'scrollview', 'toggle', 'inputfield', 'rawimage'].includes(node.type) && (
          <Section title="Unity 控件">
            <div className="flex items-center justify-between">
              <span className="text-[13px] text-[#a6adc8]">控件</span>
              <span className="text-[13px] px-2 py-0.5 rounded" style={{
                backgroundColor: node.type === 'button' ? '#89b4fa' : node.type === 'scrollview' ? '#a6e3a1'
                  : node.type === 'toggle' ? '#f9e2af' : node.type === 'inputfield' ? '#cba6f7' : '#fab387',
                color: '#1e1e2e',
              }}>
                {node.type === 'button' ? 'Button' : node.type === 'scrollview' ? 'ScrollView'
                  : node.type === 'toggle' ? 'Toggle' : node.type === 'inputfield' ? 'InputField' : 'RawImage'}
              </span>
            </div>

            {node.type === 'button' && (
              <div className="flex items-center justify-between">
                <span className="text-[13px] text-[#a6adc8]">可交互</span>
                <button
                  onClick={() => { pushHistory(); updateNode(node.id, { interactable: !node.interactable }); }}
                  className={`px-3 py-0.5 text-[13px] rounded ${node.interactable !== false ? 'bg-[#a6e3a1] text-[#1e1e2e]' : 'bg-[#313244] text-[#a6adc8]'}`}
                >
                  {node.interactable !== false ? '是' : '否'}
                </button>
              </div>
            )}

            {node.type === 'button' && (
              <div className="flex items-center justify-between">
                <span className="text-[13px] text-[#a6adc8]">Image组件</span>
                <button
                  onClick={() => {
                    pushHistory();
                    const next = node.hasImage === false;
                    updateNode(node.id, {
                      hasImage: next || undefined,
                      ...(!next ? { imageData: undefined, sliceEnabled: false, imageType: undefined, imageColor: undefined } as any : {}),
                    });
                  }}
                  className={`px-3 py-0.5 text-[13px] rounded ${btnHasImg ? 'bg-[#a6e3a1] text-[#1e1e2e]' : 'bg-[#313244] text-[#a6adc8]'}`}
                >
                  {btnHasImg ? '有' : '无'}
                </button>
              </div>
            )}

            {node.type === 'scrollview' && (
              <div className="flex items-center justify-between">
                <span className="text-[13px] text-[#a6adc8]">方向</span>
                <div className="flex gap-1">
                  {(['vertical', 'horizontal', 'both'] as const).map((d) => (
                    <button key={d} onClick={() => { pushHistory(); updateNode(node.id, { scrollDirection: d }); }}
                      className={`px-2 py-0.5 text-[12px] rounded ${node.scrollDirection === d ? 'bg-[#a6e3a1] text-[#1e1e2e]' : 'bg-[#313244] text-[#a6adc8]'}`}
                    >
                      {d === 'vertical' ? '垂直' : d === 'horizontal' ? '水平' : '双向'}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {node.type === 'toggle' && (
              <div className="flex items-center justify-between">
                <span className="text-[13px] text-[#a6adc8]">初始值</span>
                <button
                  onClick={() => { pushHistory(); updateNode(node.id, { isOn: !node.isOn }); }}
                  className={`px-3 py-0.5 text-[13px] rounded ${node.isOn ? 'bg-[#a6e3a1] text-[#1e1e2e]' : 'bg-[#313244] text-[#a6adc8]'}`}
                >
                  {node.isOn ? 'ON' : 'OFF'}
                </button>
              </div>
            )}
          </Section>
        )}

        {/* 图片资源 */}
        {(['image', 'button', 'toggle', 'rawimage'] as const).includes(node.type as any) && btnHasImg && (
          <Section title="图片资源">
            <ImagePicker
              imageData={node.imageData}
              onChange={(path, sliceBorder) => {
                pushHistory();
                const updates: Record<string, any> = { imageData: path };
                if (sliceBorder) {
                  updates.sliceEnabled = true;
                  updates.sliceBorder = sliceBorder;
                  updates.imageType = 'Sliced';
                }
                updateNode(node.id, updates);
              }}
              onClear={() => {
                pushHistory();
                updateNode(node.id, { imageData: undefined, sliceEnabled: false } as any);
              }}
            />
          </Section>
        )}

        {/* Image 属性 */}
        {(['image', 'button', 'toggle', 'rawimage'] as const).includes(node.type as any) && btnHasImg && (
          <Section title="Image 属性">
            {/* Color (imageColor #RRGGBBAA) */}
            <div className="flex items-center justify-between">
              <span className="text-[13px] text-[#a6adc8]">Color</span>
              <div className="flex items-center gap-1">
                <input
                  type="color"
                  value={(node.imageColor || '#ffffff').slice(0, 7)}
                  onChange={(e) => {
                    pushHistory();
                    const alpha = node.imageColor && node.imageColor.length === 9 ? node.imageColor.slice(7, 9) : 'ff';
                    updateNode(node.id, { imageColor: e.target.value + alpha });
                  }}
                  className="w-6 h-6 p-0 border-none cursor-pointer"
                />
                <input
                  type="text"
                  value={node.imageColor || '#ffffffff'}
                  onChange={(e) => { pushHistory(); updateNode(node.id, { imageColor: e.target.value }); }}
                  className="w-[72px] text-[12px]"
                  placeholder="#RRGGBBAA"
                />
              </div>
            </div>
            {/* Alpha slider */}
            <div className="flex items-center justify-between">
              <span className="text-[13px] text-[#a6adc8]">Alpha</span>
              <div className="flex items-center gap-1">
                <input
                  type="range"
                  min={0} max={255} step={1}
                  value={node.imageColor && node.imageColor.length === 9 ? parseInt(node.imageColor.slice(7, 9), 16) : 255}
                  onChange={(e) => {
                    pushHistory();
                    const hex = (node.imageColor || '#ffffff').slice(0, 7);
                    const alpha = parseInt(e.target.value).toString(16).padStart(2, '0');
                    updateNode(node.id, { imageColor: hex + alpha });
                  }}
                  className="w-16 h-1 accent-[#89b4fa]"
                />
                <span className="text-[12px] text-[#a6adc8] w-7 text-right">
                  {node.imageColor && node.imageColor.length === 9 ? parseInt(node.imageColor.slice(7, 9), 16) : 255}
                </span>
              </div>
            </div>

            {/* Image Enabled — Image 组件显隐（不影响节点本身） */}
            <div className="flex items-center justify-between">
              <span className="text-[13px] text-[#a6adc8]">显示图像</span>
              <button
                onClick={() => { pushHistory(); updateNode(node.id, { imageEnabled: node.imageEnabled === false ? true : false }); }}
                className={`px-3 py-0.5 text-[13px] rounded ${node.imageEnabled !== false ? 'bg-[#a6e3a1] text-[#1e1e2e]' : 'bg-[#313244] text-[#a6adc8]'}`}
              >
                {node.imageEnabled !== false ? '✓' : '✗'}
              </button>
            </div>

            {/* Raycast Target */}
            <div className="flex items-center justify-between">
              <span className="text-[13px] text-[#a6adc8]">Raycast Target</span>
              <button
                onClick={() => { pushHistory(); updateNode(node.id, { imageRaycastTarget: node.imageRaycastTarget === false ? true : false }); }}
                className={`px-3 py-0.5 text-[13px] rounded ${node.imageRaycastTarget !== false ? 'bg-[#a6e3a1] text-[#1e1e2e]' : 'bg-[#313244] text-[#a6adc8]'}`}
              >
                {node.imageRaycastTarget !== false ? '✓' : '✗'}
              </button>
            </div>

            {/* Image Type */}
            {node.type !== 'rawimage' && (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-[13px] text-[#a6adc8]">Image Type</span>
                  <div className="flex gap-1">
                    {(['Simple', 'Sliced', 'Tiled', 'Filled'] as const).map((t) => (
                      <button key={t} onClick={() => {
                        pushHistory();
                        updateNode(node.id, {
                          imageType: t,
                          sliceEnabled: t === 'Sliced',
                          sliceBorder: t === 'Sliced' ? (node.sliceBorder || { left: 10, right: 10, top: 10, bottom: 10 }) : node.sliceBorder,
                        });
                      }}
                        className={`px-1.5 py-0.5 text-[11px] rounded ${(node.imageType || 'Simple') === t ? 'bg-[#89b4fa] text-[#1e1e2e]' : 'bg-[#313244] text-[#a6adc8]'}`}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Fill Center (Sliced / Tiled) */}
                {((node.imageType || 'Simple') === 'Sliced' || (node.imageType || 'Simple') === 'Tiled') && (
                  <div className="flex items-center justify-between">
                    <span className="text-[13px] text-[#a6adc8]">Fill Center</span>
                    <button
                      onClick={() => { pushHistory(); updateNode(node.id, { fillCenter: node.fillCenter === false ? true : false }); }}
                      className={`px-3 py-0.5 text-[13px] rounded ${node.fillCenter !== false ? 'bg-[#89b4fa] text-[#1e1e2e]' : 'bg-[#313244] text-[#a6adc8]'}`}
                    >
                      {node.fillCenter !== false ? '✓' : '✗'}
                    </button>
                  </div>
                )}

                {/* Filled sub-properties */}
                {(node.imageType || 'Simple') === 'Filled' && (
                  <>
                    <div className="flex items-center justify-between">
                      <span className="text-[13px] text-[#a6adc8]">Fill Method</span>
                      <select
                        value={node.fillMethod ?? 0}
                        onChange={(e) => { pushHistory(); updateNode(node.id, { fillMethod: parseInt(e.target.value), fillOrigin: 0 }); }}
                        className="text-[12px] bg-[#313244] text-[#cdd6f4] rounded px-1 py-0.5 border-none"
                      >
                        <option value={0}>Horizontal</option>
                        <option value={1}>Vertical</option>
                        <option value={2}>Radial 90</option>
                        <option value={3}>Radial 180</option>
                        <option value={4}>Radial 360</option>
                      </select>
                    </div>

                    <div className="flex items-center justify-between">
                      <span className="text-[13px] text-[#a6adc8]">Fill Origin</span>
                      <select
                        value={node.fillOrigin ?? 0}
                        onChange={(e) => { pushHistory(); updateNode(node.id, { fillOrigin: parseInt(e.target.value) }); }}
                        className="text-[12px] bg-[#313244] text-[#cdd6f4] rounded px-1 py-0.5 border-none"
                      >
                        {(node.fillMethod ?? 0) <= 1 ? (
                          // Horizontal: Left(0)/Right(1), Vertical: Bottom(0)/Top(1)
                          <>
                            <option value={0}>{(node.fillMethod ?? 0) === 0 ? 'Left' : 'Bottom'}</option>
                            <option value={1}>{(node.fillMethod ?? 0) === 0 ? 'Right' : 'Top'}</option>
                          </>
                        ) : (node.fillMethod ?? 0) === 2 ? (
                          // Radial90: BottomLeft(0)/TopLeft(1)/TopRight(2)/BottomRight(3)
                          <>
                            <option value={0}>Bottom Left</option>
                            <option value={1}>Top Left</option>
                            <option value={2}>Top Right</option>
                            <option value={3}>Bottom Right</option>
                          </>
                        ) : (
                          // Radial180/360: Bottom(0)/Left(1)/Top(2)/Right(3)
                          <>
                            <option value={0}>Bottom</option>
                            <option value={1}>Left</option>
                            <option value={2}>Top</option>
                            <option value={3}>Right</option>
                          </>
                        )}
                      </select>
                    </div>

                    <div className="flex items-center justify-between">
                      <span className="text-[13px] text-[#a6adc8]">Fill Amount</span>
                      <div className="flex items-center gap-1">
                        <input
                          type="range"
                          min={0} max={1} step={0.01}
                          value={node.fillAmount ?? 1}
                          onChange={(e) => { pushHistory(); updateNode(node.id, { fillAmount: parseFloat(e.target.value) }); }}
                          className="w-16 h-1 accent-[#89b4fa]"
                        />
                        <span className="text-[12px] text-[#a6adc8] w-8 text-right">
                          {((node.fillAmount ?? 1) * 100).toFixed(0)}%
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center justify-between">
                      <span className="text-[13px] text-[#a6adc8]">Clockwise</span>
                      <button
                        onClick={() => { pushHistory(); updateNode(node.id, { fillClockwise: node.fillClockwise === false ? true : false }); }}
                        className={`px-3 py-0.5 text-[13px] rounded ${node.fillClockwise !== false ? 'bg-[#89b4fa] text-[#1e1e2e]' : 'bg-[#313244] text-[#a6adc8]'}`}
                      >
                        {node.fillClockwise !== false ? '✓' : '✗'}
                      </button>
                    </div>
                  </>
                )}

                {/* Use Sprite Mesh (Simple only) */}
                {(node.imageType || 'Simple') === 'Simple' && (
                  <div className="flex items-center justify-between">
                    <span className="text-[13px] text-[#a6adc8]">Use Sprite Mesh</span>
                    <button
                      onClick={() => { pushHistory(); updateNode(node.id, { useSpriteMesh: !node.useSpriteMesh }); }}
                      className={`px-3 py-0.5 text-[13px] rounded ${node.useSpriteMesh ? 'bg-[#89b4fa] text-[#1e1e2e]' : 'bg-[#313244] text-[#a6adc8]'}`}
                    >
                      {node.useSpriteMesh ? '✓' : '✗'}
                    </button>
                  </div>
                )}
              </>
            )}

            {/* Preserve Aspect */}
            <div className="flex items-center justify-between">
              <span className="text-[13px] text-[#a6adc8]">Preserve Aspect</span>
              <button
                onClick={() => { pushHistory(); updateNode(node.id, { preserveAspect: !node.preserveAspect }); }}
                className={`px-3 py-0.5 text-[13px] rounded ${node.preserveAspect ? 'bg-[#89b4fa] text-[#1e1e2e]' : 'bg-[#313244] text-[#a6adc8]'}`}
              >
                {node.preserveAspect ? '✓' : '✗'}
              </button>
            </div>

            {/* Mirror Type */}
            <div className="flex items-center justify-between">
              <span className="text-[13px] text-[#a6adc8]">Mirror</span>
              <div className="flex gap-1">
                {([undefined, 'Horizontal', 'Vertical', 'Quarter'] as const).map((m) => (
                  <button key={m ?? 'None'} onClick={() => {
                    pushHistory();
                    updateNode(node.id, { mirrorType: m });
                  }}
                    className={`px-1.5 py-0.5 text-[11px] rounded ${node.mirrorType === m ? 'bg-[#89b4fa] text-[#1e1e2e]' : 'bg-[#313244] text-[#a6adc8]'}`}
                  >
                    {m ?? 'None'}
                  </button>
                ))}
              </div>
            </div>

            {/* Set Native Size */}
            {node.imageData && (
              <div className="flex justify-end mt-1">
                <button
                  onClick={() => {
                    const img = new Image();
                    img.onload = () => {
                      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
                        pushHistory();
                        updateNode(node.id, { width: img.naturalWidth, height: img.naturalHeight });
                      }
                    };
                    img.src = node.imageData!;
                  }}
                  className="px-3 py-1 text-[13px] rounded bg-[#313244] text-[#cdd6f4] hover:bg-[#45475a] transition-colors"
                >
                  Set Native Size
                </button>
              </div>
            )}

            {/* Outline */}
            <div className="flex items-center justify-between mt-2">
              <span className="text-[13px] text-[#a6adc8]">Outline</span>
              <button
                onClick={() => {
                  pushHistory();
                  updateNode(node.id, {
                    outline: node.outline ? undefined : { color: '#000000', distance: [1, -1], useGraphicAlpha: true },
                  });
                }}
                className={`px-3 py-0.5 text-[13px] rounded ${node.outline ? 'bg-[#89b4fa] text-[#1e1e2e]' : 'bg-[#313244] text-[#a6adc8]'}`}
              >
                {node.outline ? '已开启' : '关闭'}
              </button>
            </div>
            {node.outline && (
              <>
                <ColorField label="Effect Color" value={node.outline.color} onChange={(v) => {
                  pushHistory();
                  updateNode(node.id, { outline: { ...node.outline!, color: v } });
                }} />
                <div className="flex items-center gap-2">
                  <span className="text-[12px] text-[#6c7086] w-10">距离X</span>
                  <input type="number" value={node.outline.distance[0]} step={0.5}
                    onChange={(e) => { pushHistory(); updateNode(node.id, { outline: { ...node.outline!, distance: [Number(e.target.value), node.outline!.distance[1]] } }); }}
                    className="w-14 text-sm text-center" />
                  <span className="text-[12px] text-[#6c7086] w-3">Y</span>
                  <input type="number" value={node.outline.distance[1]} step={0.5}
                    onChange={(e) => { pushHistory(); updateNode(node.id, { outline: { ...node.outline!, distance: [node.outline!.distance[0], Number(e.target.value)] } }); }}
                    className="w-14 text-sm text-center" />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[13px] text-[#a6adc8]">Use Graphic Alpha</span>
                  <button
                    onClick={() => { pushHistory(); updateNode(node.id, { outline: { ...node.outline!, useGraphicAlpha: !node.outline!.useGraphicAlpha } }); }}
                    className={`px-3 py-0.5 text-[13px] rounded ${node.outline.useGraphicAlpha !== false ? 'bg-[#89b4fa] text-[#1e1e2e]' : 'bg-[#313244] text-[#a6adc8]'}`}
                  >
                    {node.outline.useGraphicAlpha !== false ? '✓' : '✗'}
                  </button>
                </div>
              </>
            )}
          </Section>
        )}

        {/* 遮罩 */}
        <Section title="遮罩">
          <div className="flex items-center justify-between">
            <span className="text-[13px] text-[#a6adc8]">Mask</span>
            <button
              onClick={() => {
                pushHistory();
                updateNode(node.id, {
                  isMask: !node.isMask,
                  maskType: node.maskType || 'RectMask2D',
                });
              }}
              className={`px-3 py-0.5 text-[13px] rounded ${node.isMask ? 'bg-[#f5c2e7] text-[#1e1e2e]' : 'bg-[#313244] text-[#a6adc8]'}`}
            >
              {node.isMask ? '已开启' : '关闭'}
            </button>
          </div>
          {node.isMask && (
            <div className="flex items-center justify-between">
              <span className="text-[13px] text-[#a6adc8]">类型</span>
              <div className="flex gap-1">
                {(['Mask', 'RectMask2D'] as const).map((t) => (
                  <button key={t} onClick={() => { pushHistory(); updateNode(node.id, { maskType: t }); }}
                    className={`px-2 py-0.5 text-[12px] rounded ${node.maskType === t ? 'bg-[#f5c2e7] text-[#1e1e2e]' : 'bg-[#313244] text-[#a6adc8]'}`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
          )}
        </Section>

        {/* 布局组 LayoutGroup */}
        <Section title="布局组 LayoutGroup">
          <div className="flex items-center justify-between">
            <span className="text-[13px] text-[#a6adc8]">启用</span>
            <button
              onClick={() => {
                pushHistory();
                if (node.layoutGroup?.enabled) {
                  updateNode(node.id, { layoutGroup: { ...node.layoutGroup, enabled: false } });
                } else {
                  updateNode(node.id, {
                    layoutGroup: {
                      isHorizontal: true,
                      spacing: 0,
                      padLeft: 0, padRight: 0, padTop: 0, padBottom: 0,
                      childAlignment: 0,
                      childControlWidth: false, childControlHeight: false,
                      childForceExpandWidth: false, childForceExpandHeight: false,
                      ...(node.layoutGroup || {}),
                      enabled: true,
                    },
                  });
                }
              }}
              className={`px-3 py-0.5 text-[13px] rounded ${node.layoutGroup?.enabled ? 'bg-[#a6e3a1] text-[#1e1e2e]' : 'bg-[#313244] text-[#a6adc8]'}`}
            >
              {node.layoutGroup?.enabled ? '已开启' : '关闭'}
            </button>
          </div>

          {node.layoutGroup?.enabled && (() => {
            const lg = node.layoutGroup;
            const updateLG = (patch: Record<string, any>) => {
              pushHistory();
              updateNode(node.id, { layoutGroup: { ...lg, ...patch } });
            };
            const currentType = lg.layoutType || (lg.isHorizontal ? 'Horizontal' : 'Vertical');
            const isGrid = currentType === 'Grid';
            return (
              <>
                {/* 布局类型 */}
                <div className="flex items-center justify-between">
                  <span className="text-[13px] text-[#a6adc8]">类型</span>
                  <div className="flex gap-1">
                    {(['Horizontal', 'Vertical', 'Grid'] as const).map((t) => (
                      <button key={t} onClick={() => updateLG({
                        layoutType: t,
                        isHorizontal: t === 'Horizontal',
                        ...(t === 'Grid' ? { cellSizeX: lg.cellSizeX ?? 100, cellSizeY: lg.cellSizeY ?? 100, spacingY: lg.spacingY ?? 0, startCorner: lg.startCorner ?? 0, startAxis: lg.startAxis ?? 0, constraint: lg.constraint ?? 0, constraintCount: lg.constraintCount ?? 2 } : {}),
                      })}
                        className={`px-2 py-0.5 text-[12px] rounded ${currentType === t ? 'bg-[#a6e3a1] text-[#1e1e2e]' : 'bg-[#313244] text-[#a6adc8]'}`}
                      >
                        {t === 'Horizontal' ? '水平' : t === 'Vertical' ? '垂直' : '网格'}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Grid 专属属性 */}
                {isGrid && (
                  <>
                    <div className="text-[12px] text-[#6c7086] mt-1">Cell Size</div>
                    <div className="grid grid-cols-2 gap-1">
                      <NumberField label="X" value={lg.cellSizeX ?? 100} onChange={(v) => updateLG({ cellSizeX: v })} min={1} />
                      <NumberField label="Y" value={lg.cellSizeY ?? 100} onChange={(v) => updateLG({ cellSizeY: v })} min={1} />
                    </div>
                    <div className="text-[12px] text-[#6c7086] mt-1">Spacing</div>
                    <div className="grid grid-cols-2 gap-1">
                      <NumberField label="X" value={lg.spacing} onChange={(v) => updateLG({ spacing: v })} min={0} />
                      <NumberField label="Y" value={lg.spacingY ?? 0} onChange={(v) => updateLG({ spacingY: v })} min={0} />
                    </div>
                  </>
                )}

                {/* H/V Spacing */}
                {!isGrid && (
                  <NumberField label="间距" value={lg.spacing} onChange={(v) => updateLG({ spacing: v })} min={0} />
                )}

                {/* Padding — Unity 风格排列 */}
                <div className="text-[12px] text-[#6c7086] mt-1">Padding</div>
                <div className="flex flex-col items-center gap-0.5">
                  <NumberField label="上" value={lg.padTop} onChange={(v) => updateLG({ padTop: v })} min={0} />
                  <div className="grid grid-cols-2 gap-1 w-full">
                    <NumberField label="左" value={lg.padLeft} onChange={(v) => updateLG({ padLeft: v })} min={0} />
                    <NumberField label="右" value={lg.padRight} onChange={(v) => updateLG({ padRight: v })} min={0} />
                  </div>
                  <NumberField label="下" value={lg.padBottom} onChange={(v) => updateLG({ padBottom: v })} min={0} />
                </div>
                {!isGrid && (lg.padRight > 0 || lg.padBottom > 0) && !lg.childForceExpandWidth && !lg.childForceExpandHeight && !lg.childControlWidth && !lg.childControlHeight && (
                  <div className="text-[11px] text-[#f9e2af] mt-0.5">提示: 右/下 padding 需开启下方 Control 或 Force Expand 才有可见效果</div>
                )}

                {/* Grid 专属: Start Corner / Start Axis / Constraint */}
                {isGrid && (
                  <>
                    <div className="flex items-center justify-between mt-1">
                      <span className="text-[13px] text-[#a6adc8]">起始角</span>
                      <select value={lg.startCorner ?? 0} onChange={(e) => updateLG({ startCorner: Number(e.target.value) })}
                        className="w-28 text-[12px] bg-[#313244] text-[#cdd6f4] border border-[#45475a] rounded px-1 py-0.5">
                        <option value={0}>左上</option>
                        <option value={1}>右上</option>
                        <option value={2}>左下</option>
                        <option value={3}>右下</option>
                      </select>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-[13px] text-[#a6adc8]">排列轴</span>
                      <select value={lg.startAxis ?? 0} onChange={(e) => updateLG({ startAxis: Number(e.target.value) })}
                        className="w-28 text-[12px] bg-[#313244] text-[#cdd6f4] border border-[#45475a] rounded px-1 py-0.5">
                        <option value={0}>水平</option>
                        <option value={1}>垂直</option>
                      </select>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-[13px] text-[#a6adc8]">约束</span>
                      <select value={lg.constraint ?? 0} onChange={(e) => updateLG({ constraint: Number(e.target.value) })}
                        className="w-28 text-[12px] bg-[#313244] text-[#cdd6f4] border border-[#45475a] rounded px-1 py-0.5">
                        <option value={0}>自由</option>
                        <option value={1}>固定列数</option>
                        <option value={2}>固定行数</option>
                      </select>
                    </div>
                    {(lg.constraint ?? 0) > 0 && (
                      <NumberField label="约束数量" value={lg.constraintCount ?? 2} onChange={(v) => updateLG({ constraintCount: v })} min={1} />
                    )}
                  </>
                )}

                {/* Child Alignment */}
                <div className="flex items-center justify-between mt-1">
                  <span className="text-[13px] text-[#a6adc8]">对齐</span>
                  <select
                    value={lg.childAlignment}
                    onChange={(e) => updateLG({ childAlignment: Number(e.target.value) })}
                    className="w-24 text-[12px] bg-[#313244] text-[#cdd6f4] border border-[#45475a] rounded px-1 py-0.5"
                  >
                    <option value={0}>左上</option>
                    <option value={1}>中上</option>
                    <option value={2}>右上</option>
                    <option value={3}>左中</option>
                    <option value={4}>居中</option>
                    <option value={5}>右中</option>
                    <option value={6}>左下</option>
                    <option value={7}>中下</option>
                    <option value={8}>右下</option>
                  </select>
                </div>

                {/* Control & ForceExpand — 仅 H/V */}
                {!isGrid && (
                  <>
                    <div className="text-[12px] text-[#6c7086] mt-1">子节点控制</div>
                    {([
                      ['childControlWidth', 'Control Width'],
                      ['childControlHeight', 'Control Height'],
                      ['childForceExpandWidth', 'Force Expand W'],
                      ['childForceExpandHeight', 'Force Expand H'],
                    ] as const).map(([key, label]) => (
                      <div key={key} className="flex items-center justify-between">
                        <span className="text-[12px] text-[#a6adc8]">{label}</span>
                        <button
                          onClick={() => updateLG({ [key]: !(lg as any)[key] })}
                          className={`px-2 py-0.5 text-[12px] rounded ${(lg as any)[key] ? 'bg-[#89b4fa] text-[#1e1e2e]' : 'bg-[#313244] text-[#a6adc8]'}`}
                        >
                          {(lg as any)[key] ? 'ON' : 'OFF'}
                        </button>
                      </div>
                    ))}
                  </>
                )}
              </>
            );
          })()}
        </Section>

        {/* ContentSizeFitter */}
        <Section title="ContentSizeFitter">
          <div className="flex items-center justify-between">
            <span className="text-[13px] text-[#a6adc8]">启用</span>
            <button
              onClick={() => {
                pushHistory();
                if (node.contentSizeFitter?.enabled) {
                  updateNode(node.id, { contentSizeFitter: { ...node.contentSizeFitter, enabled: false } });
                } else {
                  updateNode(node.id, {
                    contentSizeFitter: {
                      horizontalFit: 0,
                      verticalFit: 0,
                      ...(node.contentSizeFitter || {}),
                      enabled: true,
                    },
                  });
                }
              }}
              className={`px-3 py-0.5 text-[13px] rounded ${node.contentSizeFitter?.enabled ? 'bg-[#a6e3a1] text-[#1e1e2e]' : 'bg-[#313244] text-[#a6adc8]'}`}
            >
              {node.contentSizeFitter?.enabled ? '已开启' : '关闭'}
            </button>
          </div>
          {node.contentSizeFitter?.enabled && (() => {
            const csf = node.contentSizeFitter;
            const updateCSF = (patch: Record<string, any>) => {
              pushHistory();
              updateNode(node.id, { contentSizeFitter: { ...csf, ...patch } });
            };
            const fitOptions = [
              { value: 0, label: 'Unconstrained' },
              { value: 1, label: 'MinSize' },
              { value: 2, label: 'PreferredSize' },
            ];
            return (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-[13px] text-[#a6adc8]">水平</span>
                  <select value={csf.horizontalFit} onChange={(e) => updateCSF({ horizontalFit: Number(e.target.value) })}
                    className="w-28 text-[12px] bg-[#313244] text-[#cdd6f4] border border-[#45475a] rounded px-1 py-0.5">
                    {fitOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[13px] text-[#a6adc8]">垂直</span>
                  <select value={csf.verticalFit} onChange={(e) => updateCSF({ verticalFit: Number(e.target.value) })}
                    className="w-28 text-[12px] bg-[#313244] text-[#cdd6f4] border border-[#45475a] rounded px-1 py-0.5">
                    {fitOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
              </>
            );
          })()}
        </Section>

        {/* 文字效果 */}
        {node.type === 'text' && (
          <Section title="文字效果">
            {/* Outline */}
            <div className="flex items-center justify-between">
              <span className="text-[13px] text-[#a6adc8]">描边</span>
              <button
                onClick={() => {
                  pushHistory();
                  updateNode(node.id, {
                    textOutline: node.textOutline ? undefined : { color: '#000000', distance: [1, -1] },
                  });
                }}
                className={`px-3 py-0.5 text-[13px] rounded ${node.textOutline ? 'bg-[#89b4fa] text-[#1e1e2e]' : 'bg-[#313244] text-[#a6adc8]'}`}
              >
                {node.textOutline ? '已开启' : '关闭'}
              </button>
            </div>
            {node.textOutline && (
              <>
                <ColorField label="描边色" value={node.textOutline.color} onChange={(v) => {
                  pushHistory();
                  updateNode(node.id, { textOutline: { ...node.textOutline!, color: v } });
                }} />
                <div className="flex items-center gap-2">
                  <span className="text-[12px] text-[#6c7086] w-10">距离X</span>
                  <input type="number" value={node.textOutline.distance[0]} step={0.5}
                    onChange={(e) => { pushHistory(); updateNode(node.id, { textOutline: { ...node.textOutline!, distance: [Number(e.target.value), node.textOutline!.distance[1]] } }); }}
                    className="w-14 text-sm text-center" />
                  <span className="text-[12px] text-[#6c7086] w-3">Y</span>
                  <input type="number" value={node.textOutline.distance[1]} step={0.5}
                    onChange={(e) => { pushHistory(); updateNode(node.id, { textOutline: { ...node.textOutline!, distance: [node.textOutline!.distance[0], Number(e.target.value)] } }); }}
                    className="w-14 text-sm text-center" />
                </div>
              </>
            )}

            {/* Shadow */}
            <div className="flex items-center justify-between mt-2">
              <span className="text-[13px] text-[#a6adc8]">阴影</span>
              <button
                onClick={() => {
                  pushHistory();
                  updateNode(node.id, {
                    textShadow: node.textShadow ? undefined : { color: '#000000', distance: [1, -1] },
                  });
                }}
                className={`px-3 py-0.5 text-[13px] rounded ${node.textShadow ? 'bg-[#89b4fa] text-[#1e1e2e]' : 'bg-[#313244] text-[#a6adc8]'}`}
              >
                {node.textShadow ? '已开启' : '关闭'}
              </button>
            </div>
            {node.textShadow && (
              <>
                <ColorField label="阴影色" value={node.textShadow.color} onChange={(v) => {
                  pushHistory();
                  updateNode(node.id, { textShadow: { ...node.textShadow!, color: v } });
                }} />
                <div className="flex items-center gap-2">
                  <span className="text-[12px] text-[#6c7086] w-10">距离X</span>
                  <input type="number" value={node.textShadow.distance[0]} step={0.5}
                    onChange={(e) => { pushHistory(); updateNode(node.id, { textShadow: { ...node.textShadow!, distance: [Number(e.target.value), node.textShadow!.distance[1]] } }); }}
                    className="w-14 text-sm text-center" />
                  <span className="text-[12px] text-[#6c7086] w-3">Y</span>
                  <input type="number" value={node.textShadow.distance[1]} step={0.5}
                    onChange={(e) => { pushHistory(); updateNode(node.id, { textShadow: { ...node.textShadow!, distance: [node.textShadow!.distance[0], Number(e.target.value)] } }); }}
                    className="w-14 text-sm text-center" />
                </div>
              </>
            )}
            {/* Gradient */}
            <div className="flex items-center justify-between mt-2">
              <span className="text-[13px] text-[#a6adc8]">渐变</span>
              <button
                onClick={() => {
                  pushHistory();
                  updateNode(node.id, {
                    textGradient: node.textGradient ? undefined : { direction: 'Vertical' as const, color1: '#ffffff', color2: '#888888' },
                  });
                }}
                className={`px-3 py-0.5 text-[13px] rounded ${node.textGradient ? 'bg-[#89b4fa] text-[#1e1e2e]' : 'bg-[#313244] text-[#a6adc8]'}`}
              >
                {node.textGradient ? '已开启' : '关闭'}
              </button>
            </div>
            {node.textGradient && (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-[13px] text-[#a6adc8]">方向</span>
                  <div className="flex gap-1">
                    {(['Vertical', 'Horizontal'] as const).map((d) => (
                      <button key={d} onClick={() => { pushHistory(); updateNode(node.id, { textGradient: { ...node.textGradient!, direction: d } }); }}
                        className={`px-2 py-0.5 text-[12px] rounded ${node.textGradient!.direction === d ? 'bg-[#89b4fa] text-[#1e1e2e]' : 'bg-[#313244] text-[#a6adc8]'}`}
                      >
                        {d === 'Vertical' ? '↕ 上下' : '↔ 左右'}
                      </button>
                    ))}
                  </div>
                </div>
                <ColorField label="颜色1" value={node.textGradient.color1} onChange={(v) => {
                  pushHistory(); updateNode(node.id, { textGradient: { ...node.textGradient!, color1: v } });
                }} />
                <ColorField label="颜色2" value={node.textGradient.color2} onChange={(v) => {
                  pushHistory(); updateNode(node.id, { textGradient: { ...node.textGradient!, color2: v } });
                }} />
                {/* 预览条 */}
                <div className="h-4 rounded mt-1" style={{
                  background: node.textGradient.direction === 'Horizontal'
                    ? `linear-gradient(to right, ${node.textGradient.color1}, ${node.textGradient.color2})`
                    : `linear-gradient(to bottom, ${node.textGradient.color1}, ${node.textGradient.color2})`,
                }} />
              </>
            )}
          </Section>
        )}

        {/* 九宫格 - image/button 类型 */}
        {(node.type === 'image' || (node.type === 'button' && btnHasImg)) && (
          <Section title="九宫格 (Sliced)">
            <div className="flex items-center justify-between">
              <span className="text-[13px] text-[#a6adc8]">启用</span>
              <button
                onClick={() => {
                  pushHistory();
                  const enabling = !node.sliceEnabled;
                  updateNode(node.id, {
                    sliceEnabled: enabling,
                    sliceBorder: node.sliceBorder || { left: 10, right: 10, top: 10, bottom: 10 },
                    imageType: enabling ? 'Sliced' : 'Simple',
                  });
                }}
                className={`px-3 py-0.5 text-[13px] rounded ${
                  node.sliceEnabled ? 'bg-[#89b4fa] text-[#1e1e2e]' : 'bg-[#313244] text-[#a6adc8]'
                }`}
              >
                {node.sliceEnabled ? '已开启' : '关闭'}
              </button>
            </div>

            {node.sliceEnabled && (
              <>
                {/* 可视化预览 */}
                <div className="relative w-full aspect-square bg-[#313244] rounded overflow-hidden my-2">
                  {node.imageData && (
                    <img src={node.imageData} alt="" className="w-full h-full object-contain opacity-40" />
                  )}
                  {/* 九宫格线 */}
                  <div className="absolute inset-0">
                    {/* 左线 */}
                    <div
                      className="absolute top-0 bottom-0 border-l border-dashed border-[#f38ba8]"
                      style={{ left: `${((node.sliceBorder?.left || 0) / node.width) * 100}%` }}
                    />
                    {/* 右线 */}
                    <div
                      className="absolute top-0 bottom-0 border-r border-dashed border-[#f38ba8]"
                      style={{ right: `${((node.sliceBorder?.right || 0) / node.width) * 100}%` }}
                    />
                    {/* 上线 */}
                    <div
                      className="absolute left-0 right-0 border-t border-dashed border-[#89b4fa]"
                      style={{ top: `${((node.sliceBorder?.top || 0) / node.height) * 100}%` }}
                    />
                    {/* 下线 */}
                    <div
                      className="absolute left-0 right-0 border-b border-dashed border-[#89b4fa]"
                      style={{ bottom: `${((node.sliceBorder?.bottom || 0) / node.height) * 100}%` }}
                    />
                  </div>
                </div>

                {/* 数值输入 - 上 */}
                <div className="flex items-center justify-center gap-1">
                  <span className="text-[12px] text-[#6c7086] w-5 text-right">上</span>
                  <input
                    type="number"
                    min={0}
                    value={node.sliceBorder?.top ?? 10}
                    onChange={(e) => {
                      pushHistory();
                      updateNode(node.id, {
                        sliceBorder: { ...node.sliceBorder!, top: Number(e.target.value) },
                      });
                    }}
                    className="w-14 text-sm text-center"
                  />
                </div>

                {/* 数值输入 - 左 右 */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1">
                    <span className="text-[12px] text-[#6c7086] w-5 text-right">左</span>
                    <input
                      type="number"
                      min={0}
                      value={node.sliceBorder?.left ?? 10}
                      onChange={(e) => {
                        pushHistory();
                        updateNode(node.id, {
                          sliceBorder: { ...node.sliceBorder!, left: Number(e.target.value) },
                        });
                      }}
                      className="w-14 text-sm text-center"
                    />
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="text-[12px] text-[#6c7086] w-5 text-right">右</span>
                    <input
                      type="number"
                      min={0}
                      value={node.sliceBorder?.right ?? 10}
                      onChange={(e) => {
                        pushHistory();
                        updateNode(node.id, {
                          sliceBorder: { ...node.sliceBorder!, right: Number(e.target.value) },
                        });
                      }}
                      className="w-14 text-sm text-center"
                    />
                  </div>
                </div>

                {/* 数值输入 - 下 */}
                <div className="flex items-center justify-center gap-1">
                  <span className="text-[12px] text-[#6c7086] w-5 text-right">下</span>
                  <input
                    type="number"
                    min={0}
                    value={node.sliceBorder?.bottom ?? 10}
                    onChange={(e) => {
                      pushHistory();
                      updateNode(node.id, {
                        sliceBorder: { ...node.sliceBorder!, bottom: Number(e.target.value) },
                      });
                    }}
                    className="w-14 text-sm text-center"
                  />
                </div>
              </>
            )}
          </Section>
        )}
      </div>
    </div>
  );
}

// 图片选择器：支持搜索 Atlas 图片并替换
function ImagePicker({ imageData, onChange, onClear }: {
  imageData?: string;
  onChange: (path: string, sliceBorder?: { left: number; right: number; top: number; bottom: number }) => void;
  onClear: () => void;
}) {
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<{ name: string; path: string; sliceBorder?: { left: number; right: number; top: number; bottom: number } }[]>([]);
  const [loading, setLoading] = useState(false);
  const timerRef = useState<number>(0);

  // 从 imageData 提取显示名
  const displayName = imageData
    ? imageData.replace(/^\/atlas-file\/|^\/texture-file\/|^Assets\/HotRes\/UI\/(Atlas|Texture)\//g, '').replace(/\.[^.]+$/, '')
    : '';

  const doSearch = useCallback((q: string) => {
    setQuery(q);
    if (q.length < 2) { setResults([]); return; }
    clearTimeout(timerRef[0]);
    timerRef[0] = window.setTimeout(() => {
      setLoading(true);
      fetch(`/api/atlas/search?q=${encodeURIComponent(q)}`)
        .then((r) => r.json())
        .then((data) => setResults(data))
        .catch(() => setResults([]))
        .finally(() => setLoading(false));
    }, 300) as unknown as number;
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const atlasData = e.dataTransfer.getData('application/atlas-image');
    if (atlasData) {
      const img = JSON.parse(atlasData);
      onChange(img.path, img.sliceBorder || undefined);
    }
  }, [onChange]);

  // 自定义拖拽 drop target（图集库鼠标拖拽）
  const dropRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = dropRef.current;
    if (!el) return;
    return registerDropTarget({
      element: el,
      onDrop: (type, data) => {
        if (type === 'application/atlas-image') {
          onChange(data.path, data.sliceBorder || undefined);
        }
      },
    });
  }, [onChange]);

  if (searching) {
    return (
      <div className="flex flex-col gap-1.5">
        <input
          autoFocus
          type="text"
          placeholder="搜索图片名称..."
          value={query}
          onChange={(e) => doSearch(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Escape') setSearching(false); }}
          className="w-full text-[13px] px-2 py-1 bg-[#313244] border border-[#45475a] rounded text-[#cdd6f4] placeholder-[#6c7086] outline-none focus:border-[#89b4fa]"
        />
        <div className="max-h-40 overflow-y-auto rounded bg-[#181825]">
          {loading && <div className="text-[12px] text-[#6c7086] text-center py-2">搜索中...</div>}
          {!loading && results.length === 0 && query.length >= 2 && (
            <div className="text-[12px] text-[#6c7086] text-center py-2">未找到</div>
          )}
          {results.map((img) => (
            <button
              key={img.path}
              className="w-full flex items-center gap-1.5 px-2 py-1 text-left hover:bg-[#313244] transition-colors"
              onClick={() => {
                onChange(img.path, img.sliceBorder || undefined);
                setSearching(false);
                setQuery('');
                setResults([]);
              }}
            >
              <div className="w-5 h-5 shrink-0 bg-[#313244] rounded overflow-hidden flex items-center justify-center">
                <img src={img.path} alt="" className="max-w-full max-h-full object-contain" loading="lazy"
                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
              </div>
              <span className="text-[12px] text-[#a6adc8] truncate">{img.name}</span>
            </button>
          ))}
        </div>
        <button onClick={() => { setSearching(false); setQuery(''); setResults([]); }}
          className="text-[12px] text-[#6c7086] hover:text-[#cdd6f4]">
          取消
        </button>
      </div>
    );
  }

  const setLocateImagePath = useEditorStore((s) => s.setLocateImagePath);

  return (
    <div className="flex flex-col gap-1.5">
      {/* 当前图片预览 */}
      <div
        ref={dropRef}
        className={`relative w-full h-16 bg-[#181825] rounded border border-dashed border-[#45475a] flex items-center justify-center overflow-hidden ${imageData ? 'cursor-pointer hover:border-[#89b4fa]' : ''}`}
        onDragOver={(e) => e.preventDefault()}
        onDrop={handleDrop}
        onClick={() => { if (imageData) setLocateImagePath(imageData); }}
        title={imageData ? '点击定位到图片库' : undefined}
      >
        {imageData ? (
          <>
            <img src={imageData} alt="" className="max-w-full max-h-full object-contain" />
            <button
              onClick={(e) => { e.stopPropagation(); onClear(); }}
              className="absolute top-0.5 right-0.5 w-4 h-4 bg-[#f38ba8] text-[#1e1e2e] rounded-full text-[12px] leading-none flex items-center justify-center hover:bg-[#eba0ac]"
              title="清除图片"
            >x</button>
          </>
        ) : (
          <span className="text-[12px] text-[#6c7086]">拖入图片或点击搜索</span>
        )}
      </div>
      {/* 图片名 */}
      {displayName && (
        <div className="text-[12px] text-[#6c7086] truncate" title={imageData}>{displayName}</div>
      )}
      {/* 操作按钮 */}
      <button
        onClick={() => setSearching(true)}
        className="w-full px-2 py-1 text-[13px] bg-[#313244] text-[#cdd6f4] rounded hover:bg-[#45475a] transition-colors"
      >
        搜索替换
      </button>
    </div>
  );
}

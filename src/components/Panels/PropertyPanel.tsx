import { useState, useCallback, useEffect, useRef } from 'react';
import { useEditorStore } from '../../stores/editorStore';
import { useShallow } from 'zustand/react/shallow';
import { anchorPresets, getAnchorPreset } from '../../types';
import { registerDropTarget } from '../../utils/customDrag';
import { FONT_LIST } from '../../config/assetPaths';
import AnnotationPropertyPanel from './AnnotationPropertyPanel';
import {
  moveNodeOnBridge,
  renameNodeOnBridge,
  resizeNodeOnBridge,
  setImageOnBridge,
  setRectTransformFieldsOnBridge,
  setTextContentOnBridge,
  setTextStyleOnBridge,
  syncNodeVisualDelta,
} from '../../services/BridgeArtboardStore';

// 字色预设类型
interface ColorPreset { color: string; label: string; desc: string; }

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ');
}

function NumberField({ label, value, onChange, min, max, step = 1, live = false }: {
  label: string; value: number; onChange: (v: number) => void;
  min?: number; max?: number; step?: number; live?: boolean;
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

  const clamp = (num: number) => {
    let next = min != null ? Math.max(min, num) : num;
    next = max != null ? Math.min(max, next) : next;
    return next;
  };

  const commitValue = (rawValue: string, options: { finishEditing: boolean; normalizeInput: boolean }) => {
    if (options.finishEditing) setEditing(false);
    const num = Number(rawValue);
    if (!isNaN(num)) {
      const clamped = clamp(num);
      onChange(clamped);
      prevValue.current = Math.round(clamped * 100) / 100;
      if (options.normalizeInput) setLocalValue(String(prevValue.current));
    } else {
      if (options.normalizeInput) setLocalValue(String(rounded));
    }
  };

  return (
    <div className="property-field">
      <span className="property-label">{label}</span>
      <input
        type="number"
        value={localValue}
        onFocus={() => setEditing(true)}
        onChange={(e) => {
          const next = e.target.value;
          setLocalValue(next);
          if (live && next.trim() !== '') {
            commitValue(next, { finishEditing: false, normalizeInput: false });
          }
        }}
        onBlur={() => commitValue(localValue, { finishEditing: true, normalizeInput: true })}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.currentTarget.blur(); } }}
        min={min}
        max={max}
        step={step}
        className="property-number-input"
      />
    </div>
  );
}

function ColorField({ label, value, onChange }: {
  label: string; value: string; onChange: (v: string) => void;
}) {
  return (
    <div className="property-field">
      <span className="property-label">{label}</span>
      <div className="flex min-w-0 flex-1 items-center justify-end gap-1.5">
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="property-color-swatch"
        />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="property-color-input"
        />
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="property-section">
      <h4 className="property-section-title">{title}</h4>
      <div className="property-section-body">{children}</div>
    </div>
  );
}

function FieldRow({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cx('property-field', className)}>
      <span className="property-label">{label}</span>
      <div className="property-control">{children}</div>
    </div>
  );
}

function ValueText({ children, accent = false }: { children: React.ReactNode; accent?: boolean }) {
  return <span className={cx('property-value', accent && 'property-value-accent')}>{children}</span>;
}

function ToggleButton({
  active,
  onClick,
  activeText = '是',
  inactiveText = '否',
  title,
  tone = 'green',
}: {
  active: boolean;
  onClick: () => void;
  activeText?: string;
  inactiveText?: string;
  title?: string;
  tone?: 'green' | 'blue' | 'pink';
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cx('property-toggle', active && `property-toggle-active-${tone}`)}
    >
      {active ? activeText : inactiveText}
    </button>
  );
}

function SelectField({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string | number;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  return (
    <FieldRow label={label}>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="property-select">
        {children}
      </select>
    </FieldRow>
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
  // 字色预设（从 JSON 加载 + 编辑状态）
  const [colorPresets, setColorPresets] = useState<ColorPreset[]>([]);
  const [editingPresets, setEditingPresets] = useState(false);
  const [editDraft, setEditDraft] = useState<ColorPreset[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const textCommitTimerRef = useRef<number | null>(null);
  const textLastCommittedRef = useRef({ nodeId: '', text: '', richText: false });
  const skipNameCommitRef = useRef(false);
  const [nameDraft, setNameDraft] = useState('');
  const [textDraft, setTextDraft] = useState('');
  const [richTextDraft, setRichTextDraft] = useState(false);

  useEffect(() => {
    fetch('/colorPresets.json').then(r => r.json()).then(setColorPresets).catch(() => {});
  }, []);

  useEffect(() => {
    setNameDraft(selectedNode?.name ?? '');
  }, [selectedNode?.id, selectedNode?.name]);

  useEffect(() => {
    const id = selectedNode?.id ?? '';
    const text = selectedNode?.text ?? '';
    const richText = !!selectedNode?.richText;
    textLastCommittedRef.current = { nodeId: id, text, richText };
    setTextDraft(text);
    setRichTextDraft(richText);
    if (textCommitTimerRef.current) {
      window.clearTimeout(textCommitTimerRef.current);
      textCommitTimerRef.current = null;
    }
  }, [selectedNode?.id]);

  useEffect(() => {
    return () => {
      if (textCommitTimerRef.current) {
        window.clearTimeout(textCommitTimerRef.current);
        textCommitTimerRef.current = null;
      }
    };
  }, []);

  const savePresets = useCallback(async (presets: ColorPreset[]) => {
    setColorPresets(presets);
    try { await fetch('/api/color-presets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(presets) }); } catch {}
  }, []);

  if (selectedAnnotationIds.length > 0) {
    return (
      <div className="property-panel w-full h-full bg-[#1e1e2e] overflow-y-auto">
        <div className="px-3 py-2 border-b border-[#313244]">
          <h3 className="text-sm font-medium text-[#cdd6f4]">属性</h3>
        </div>
        <AnnotationPropertyPanel />
      </div>
    );
  }

  if (selectedIds.length === 0) {
    return (
      <div className="property-panel w-full h-full bg-[#1e1e2e] flex items-center justify-center">
        <span className="text-sm text-[#6c7086]">选中节点以编辑属性</span>
      </div>
    );
  }

  if (selectedIds.length > 1) {
    return (
      <div className="property-panel w-full h-full bg-[#1e1e2e] flex items-center justify-center">
        <span className="text-sm text-[#6c7086]">已选中 {selectedIds.length} 个节点</span>
      </div>
    );
  }

  const node = selectedNode;
  if (!node) return null;

  if (node.locked) {
    return (
      <div className="property-panel w-full h-full bg-[#1e1e2e] overflow-y-auto">
        <div className="px-3 py-2 border-b border-[#313244]">
          <h3 className="text-sm font-medium text-[#cdd6f4]">属性</h3>
        </div>
        <div className="px-3 py-3 space-y-3">
          <div className="rounded border border-[#f38ba8]/40 bg-[#f38ba8]/10 px-3 py-2">
            <div className="text-[13px] font-medium text-[#f38ba8]">节点已锁定</div>
            <div className="mt-1 text-[12px] leading-5 text-[#a6adc8]">
              锁定节点不会写入 Unity，也不会响应属性修改。请先在图层面板解锁后再编辑。
            </div>
          </div>
          <Section title="基本">
            <FieldRow label="名称"><ValueText>{node.name}</ValueText></FieldRow>
            <FieldRow label="类型"><ValueText>{node.type}</ValueText></FieldRow>
          </Section>
        </div>
      </div>
    );
  }

  // Button 是否有 Image 组件：显式标记优先，未标记时从 imageData 推断
  const btnHasImg = node.type !== 'button' || node.hasImage === true || (node.hasImage === undefined && !!node.imageData);
  const reportBridgeError = (err: unknown) => console.warn('Failed to sync property to Bridge:', err);
  const patchNodeOnBridge = (patch: Partial<typeof node>) => {
    void syncNodeVisualDelta(node, { ...node, ...patch }).catch(reportBridgeError);
  };
  const patchTextStyleOnBridge = (patch: { fontSize?: number; color?: string; fontPath?: string }) => {
    void setTextStyleOnBridge(node.id, patch).catch(reportBridgeError);
  };
  const patchRectTransformOnBridge = (patch: Parameters<typeof setRectTransformFieldsOnBridge>[1]) => {
    void setRectTransformFieldsOnBridge(node.id, patch).catch(reportBridgeError);
  };
  const commitTextOnBridge = (text: string, richText: boolean) => {
    const last = textLastCommittedRef.current;
    if (last.nodeId === node.id && last.text === text && last.richText === richText) return;
    textLastCommittedRef.current = { nodeId: node.id, text, richText };
    void setTextContentOnBridge(node.id, text, richText).catch(reportBridgeError);
  };
  const scheduleTextCommit = (text: string, richText: boolean, delay = 250) => {
    if (textCommitTimerRef.current) window.clearTimeout(textCommitTimerRef.current);
    textCommitTimerRef.current = window.setTimeout(() => {
      textCommitTimerRef.current = null;
      commitTextOnBridge(text, richText);
    }, delay);
  };
  const updateTextDraft = (text: string, richText = richTextDraft, delay = 250) => {
    setTextDraft(text);
    setRichTextDraft(richText);
    scheduleTextCommit(text, richText, delay);
  };
  const flushTextDraft = () => {
    if (textCommitTimerRef.current) {
      window.clearTimeout(textCommitTimerRef.current);
      textCommitTimerRef.current = null;
    }
    commitTextOnBridge(textDraft, richTextDraft);
  };
  const commitNameDraft = () => {
    if (skipNameCommitRef.current) {
      skipNameCommitRef.current = false;
      return;
    }
    const nextName = nameDraft.trim();
    if (!nextName) {
      setNameDraft(node.name);
      return;
    }
    if (nextName === node.name) {
      setNameDraft(nextName);
      return;
    }
    void renameNodeOnBridge(node.id, nextName).catch(reportBridgeError);
  };

  const updateTransform = (field: 'x' | 'y' | 'width' | 'height' | 'rotation', value: number) => {
    if (node.locked) return;
    if (field === 'x' || field === 'y') {
      const x = field === 'x' ? value : node.x;
      const y = field === 'y' ? value : node.y;
      void moveNodeOnBridge(node.id, x, y, false).catch(reportBridgeError);
      return;
    }
    if (field === 'width' || field === 'height') {
      const width = field === 'width' ? value : node.width;
      const height = field === 'height' ? value : node.height;
      void resizeNodeOnBridge(node.id, width, height, false).catch(reportBridgeError);
      return;
    }
    void syncNodeVisualDelta(node, { ...node, rotation: value }).catch(reportBridgeError);
  };

  return (
    <div className="property-panel w-full h-full bg-[#1e1e2e] overflow-y-auto">
      <div className="px-3 py-2 border-b border-[#313244]">
        <h3 className="text-sm font-medium text-[#cdd6f4]">属性</h3>
      </div>

      <div className="px-3 py-3 space-y-3">
        {/* 名称 */}
        <Section title="基本">
          <FieldRow label="名称">
            <input
              type="text"
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={commitNameDraft}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
                if (e.key === 'Escape') {
                  skipNameCommitRef.current = true;
                  setNameDraft(node.name);
                  e.currentTarget.blur();
                }
              }}
              className="w-full min-w-0 text-sm"
            />
          </FieldRow>
          <FieldRow label="类型"><ValueText>{node.type}</ValueText></FieldRow>
          {node.type === 'component' && (
            <FieldRow label="组件"><ValueText accent>@{node.componentRef}</ValueText></FieldRow>
          )}
          {node.type === 'component' && (
            <FieldRow label="置灰">
              <ToggleButton
                active={node.interactable === false}
                onClick={() => patchNodeOnBridge({ interactable: node.interactable === false ? true : false })}
                activeText="是"
                inactiveText="否"
                title="灰化整个组件子树（参考 ImgUtil.SetButtonGray）"
              />
            </FieldRow>
          )}
        </Section>

        {/* 位置大小 */}
        <Section title="变换">
          <div className="grid grid-cols-2 gap-2">
            <NumberField label="X" value={node.x} onChange={(v) => updateTransform('x', v)} live />
            <NumberField label="Y" value={node.y} onChange={(v) => updateTransform('y', v)} live />
            <NumberField label="W" value={node.width} onChange={(v) => updateTransform('width', v)} min={1} live />
            <NumberField label="H" value={node.height} onChange={(v) => updateTransform('height', v)} min={1} live />
          </div>
          <NumberField label="旋转" value={node.rotation} onChange={(v) => updateTransform('rotation', v)} />
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
                    onClick={() => patchRectTransformOnBridge({
                        anchorMin: { ...preset.anchorMin },
                        anchorMax: { ...preset.anchorMax },
                    })}
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
          <FieldRow label="Pivot" className="mt-2">
            <div className="property-dual-inputs">
              <input
                type="number" min={0} max={1} step={0.1}
                value={node.pivot?.x ?? 0.5}
                onChange={(e) => {
                  const oldPx = node.pivot?.x ?? 0.5;
                  const newPx = Number(e.target.value);
                  patchRectTransformOnBridge({
                    pivot: { x: newPx, y: node.pivot?.y ?? 0.5 },
                    anchoredPosition: { x: node.x + (oldPx - newPx) * node.width, y: node.y },
                  });
                }}
                className="property-inline-number"
              />
              <input
                type="number" min={0} max={1} step={0.1}
                value={node.pivot?.y ?? 0.5}
                onChange={(e) => {
                  const oldPy = node.pivot?.y ?? 0.5;
                  const newPy = Number(e.target.value);
                  patchRectTransformOnBridge({
                    pivot: { x: node.pivot?.x ?? 0.5, y: newPy },
                    anchoredPosition: { x: node.x, y: node.y + (oldPy - newPy) * node.height },
                  });
                }}
                className="property-inline-number"
              />
            </div>
          </FieldRow>
        </Section>

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
                  const txt = textDraft;
                  const wrapped = `<b>${txt.slice(s, e2)}</b>`;
                  const newText = txt.slice(0, s) + wrapped + txt.slice(e2);
                  updateTextDraft(newText, true, 0);
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
                  const txt = textDraft;
                  const wrapped = `<i>${txt.slice(s, e2)}</i>`;
                  const newText = txt.slice(0, s) + wrapped + txt.slice(e2);
                  updateTextDraft(newText, true, 0);
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
                    const txt = textDraft;
                    const selected = txt.slice(s, e2);
                    const wrapped = `<color=${c.color}>${selected}</color>`;
                    const newText = txt.slice(0, s) + wrapped + txt.slice(e2);
                    updateTextDraft(newText, true, 0);
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
                  const txt = textDraft;
                  const selected = txt.slice(s, e2);
                  const wrapped = `<color=${e.target.value}>${selected}</color>`;
                  const newText = txt.slice(0, s) + wrapped + txt.slice(e2);
                  updateTextDraft(newText, true, 0);
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
                  const txt = textDraft;
                  const region = s === e2 ? txt : txt.slice(s, e2);
                  const cleaned = region.replace(/<\/?(?:color=[^>]*|color|b|i)>/g, '');
                  const newText = s === e2 ? cleaned : txt.slice(0, s) + cleaned + txt.slice(e2);
                  updateTextDraft(newText, newText.includes('<'), 0);
                  setTimeout(() => { ta.focus(); ta.selectionStart = s; ta.selectionEnd = s + cleaned.length; }, 0);
                }}
              >
                清除
              </button>
            </div>
            <div>
              <textarea
                ref={textareaRef}
                value={textDraft}
                onChange={(e) => updateTextDraft(e.target.value)}
                onBlur={flushTextDraft}
                className="w-full text-sm bg-[#313244] border border-[#45475a] text-[#cdd6f4] rounded p-2 resize-none h-16 outline-none focus:border-[#89b4fa] font-mono"
              />
            </div>
            {/* 富文本预览 */}
            {textDraft && /(<color|<b>|<i>)/.test(textDraft) && (
              <div
                className="w-full text-sm bg-[#11111b] border border-[#313244] rounded p-2 mt-1 break-all"
                style={{ color: node.style.fontColor }}
                dangerouslySetInnerHTML={{
                  __html: textDraft
                    .replace(/</g, '&lt;').replace(/>/g, '&gt;')
                    .replace(/&lt;color=([^&]*)&gt;/g, '<span style="color:$1">')
                    .replace(/&lt;\/color&gt;/g, '</span>')
                    .replace(/&lt;b&gt;/g, '<b>').replace(/&lt;\/b&gt;/g, '</b>')
                    .replace(/&lt;i&gt;/g, '<i>').replace(/&lt;\/i&gt;/g, '</i>')
                }}
              />
            )}
            {/* 字体 */}
            <SelectField
              label="字体"
              value={node.fontPath || ''}
              onChange={(fontPath) => {
                if (fontPath) patchTextStyleOnBridge({ fontPath });
              }}
            >
                <option value="">默认</option>
                {FONT_LIST.map(f => (
                  <option key={f.path} value={f.path}>{f.label}</option>
                ))}
            </SelectField>
            {/* 字体样式 */}
            <FieldRow label="样式">
              <div className="property-segment-row">
                {([
                  { value: 0, label: 'N' , title: 'Normal' },
                  { value: 1, label: 'B', title: 'Bold' },
                  { value: 2, label: 'I', title: 'Italic' },
                  { value: 3, label: 'BI', title: 'BoldItalic' },
                ] as const).map((s) => (
                  <button
                    key={s.value}
                    title={s.title}
                    onClick={() => patchNodeOnBridge({ fontStyle: s.value })}
                    className={cx('property-segment-button', (node.fontStyle || 0) === s.value && 'property-segment-button-active-blue')}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </FieldRow>
            <NumberField label="字号" value={node.style.fontSize} onChange={(v) => patchTextStyleOnBridge({ fontSize: v })} min={8} />
            <ColorField label="字色" value={node.style.fontColor} onChange={(v) => patchTextStyleOnBridge({ color: v })} />
            {/* 预设颜色 */}
            <div className="space-y-1">
              <FieldRow label="预设">
                <button
                  onClick={() => { setEditDraft(colorPresets.map(c => ({ ...c }))); setEditingPresets(!editingPresets); }}
                  className="text-[12px] text-[#6c7086] hover:text-[#89b4fa] transition-colors"
                >{editingPresets ? '完成' : '编辑'}</button>
              </FieldRow>
              <div className="flex gap-1 flex-wrap">
                {colorPresets.map((c, i) => (
                  <div key={i} className="relative group">
                    <button
                      title={`${c.label}${c.desc ? ' — ' + c.desc : ''}`}
                      onClick={() => patchTextStyleOnBridge({ color: c.color })}
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
            <FieldRow label="对齐">
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
                      const hAlign: 'left'|'center'|'right' = ['left','center','right'][v % 3] as any;
                      patchNodeOnBridge({ alignment: v, style: { ...node.style, textAlign: hAlign } });
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
            </FieldRow>
          </Section>
        )}

        {/* 控件类型标识 */}
        {['button', 'scrollview', 'toggle', 'inputfield', 'rawimage'].includes(node.type) && (
          <Section title="Unity 控件">
            <FieldRow label="控件">
              <span className="property-toggle" style={{
                backgroundColor: node.type === 'button' ? '#89b4fa' : node.type === 'scrollview' ? '#a6e3a1'
                  : node.type === 'toggle' ? '#f9e2af' : node.type === 'inputfield' ? '#cba6f7' : '#fab387',
                color: '#1e1e2e',
              }}>
                {node.type === 'button' ? 'Button' : node.type === 'scrollview' ? 'ScrollView'
                  : node.type === 'toggle' ? 'Toggle' : node.type === 'inputfield' ? 'InputField' : 'RawImage'}
              </span>
            </FieldRow>

            {node.type === 'button' && (
              <FieldRow label="可交互">
                <ToggleButton
                  active={node.interactable !== false}
                  onClick={() => patchNodeOnBridge({ interactable: !node.interactable })}
                />
              </FieldRow>
            )}

            {node.type === 'button' && (
              <FieldRow label="Image组件">
                <span className={cx('property-toggle', btnHasImg && 'property-toggle-active-green')}>
                  {btnHasImg ? '有' : '无'}
                </span>
              </FieldRow>
            )}

            {node.type === 'scrollview' && (
              <FieldRow label="方向">
                <div className="property-segment-row">
                  {(['vertical', 'horizontal', 'both'] as const).map((d) => (
                    <button key={d} onClick={() => patchNodeOnBridge({ scrollDirection: d })}
                      className={cx('property-segment-button', node.scrollDirection === d && 'property-segment-button-active-green')}
                    >
                      {d === 'vertical' ? '垂直' : d === 'horizontal' ? '水平' : '双向'}
                    </button>
                  ))}
                </div>
              </FieldRow>
            )}

            {node.type === 'toggle' && (
              <FieldRow label="初始值">
                <ToggleButton
                  active={!!node.isOn}
                  onClick={() => patchNodeOnBridge({ isOn: !node.isOn })}
                  activeText="ON"
                  inactiveText="OFF"
                />
              </FieldRow>
            )}
          </Section>
        )}

        {/* 图片资源 */}
        {(['image', 'button', 'toggle', 'rawimage'] as const).includes(node.type as any) && btnHasImg && (
          <Section title="图片资源">
            <ImagePicker
              imageData={node.imageData}
              onChange={(path) => {
                patchNodeOnBridge({ imageData: path });
              }}
              onClear={() => {
                void setImageOnBridge(node.id, '').catch(reportBridgeError);
              }}
            />
          </Section>
        )}

        {/* Image 属性 */}
        {(['image', 'button', 'toggle', 'rawimage'] as const).includes(node.type as any) && btnHasImg && (
          <Section title="Image 属性">
            {/* Color (imageColor #RRGGBBAA) */}
            <FieldRow label="Color">
              <div className="flex min-w-0 flex-1 items-center justify-end gap-1.5">
                <input
                  type="color"
                  value={(node.imageColor || '#ffffff').slice(0, 7)}
                  onChange={(e) => {
                    const alpha = node.imageColor && node.imageColor.length === 9 ? node.imageColor.slice(7, 9) : 'ff';
                    patchNodeOnBridge({ imageColor: e.target.value + alpha });
                  }}
                  className="property-color-swatch"
                />
                <input
                  type="text"
                  value={node.imageColor || '#ffffffff'}
                  onChange={(e) => patchNodeOnBridge({ imageColor: e.target.value })}
                  className="property-color-input"
                  placeholder="#RRGGBBAA"
                />
              </div>
            </FieldRow>
            {/* Alpha slider */}
            <FieldRow label="Alpha">
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <input
                  type="range"
                  min={0} max={255} step={1}
                  value={node.imageColor && node.imageColor.length === 9 ? parseInt(node.imageColor.slice(7, 9), 16) : 255}
                  onChange={(e) => {
                    const hex = (node.imageColor || '#ffffff').slice(0, 7);
                    const alpha = parseInt(e.target.value).toString(16).padStart(2, '0');
                    patchNodeOnBridge({ imageColor: hex + alpha });
                  }}
                  className="property-slider"
                />
                <span className="text-[12px] text-[#a6adc8] w-7 text-right">
                  {node.imageColor && node.imageColor.length === 9 ? parseInt(node.imageColor.slice(7, 9), 16) : 255}
                </span>
              </div>
            </FieldRow>

            {/* Image Enabled — Image 组件显隐（不影响节点本身） */}
            <FieldRow label="显示图像">
              <ToggleButton
                active={node.imageEnabled !== false}
                onClick={() => patchNodeOnBridge({ imageEnabled: node.imageEnabled === false ? true : false })}
                activeText="✓"
                inactiveText="✗"
              />
            </FieldRow>

            {/* Raycast Target */}
            <FieldRow label="Raycast Target">
              <ToggleButton
                active={node.imageRaycastTarget !== false}
                onClick={() => patchNodeOnBridge({ imageRaycastTarget: node.imageRaycastTarget === false ? true : false })}
                activeText="✓"
                inactiveText="✗"
              />
            </FieldRow>

            {/* Image Type */}
            {node.type !== 'rawimage' && (
              <>
                <FieldRow label="Image Type">
                  <div className="property-segment-row">
                    {(['Simple', 'Sliced', 'Tiled', 'Filled'] as const).map((t) => (
                      <button key={t} onClick={() => {
                        patchNodeOnBridge({
                          imageType: t,
                        });
                      }}
                        className={cx('property-segment-button', (node.imageType || 'Simple') === t && 'property-segment-button-active-blue')}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                </FieldRow>

                {/* Fill Center (Sliced / Tiled) */}
                {((node.imageType || 'Simple') === 'Sliced' || (node.imageType || 'Simple') === 'Tiled') && (
                  <FieldRow label="Fill Center">
                    <ToggleButton
                      active={node.fillCenter !== false}
                      onClick={() => patchNodeOnBridge({ fillCenter: node.fillCenter === false ? true : false })}
                      activeText="✓"
                      inactiveText="✗"
                      tone="blue"
                    />
                  </FieldRow>
                )}

                {/* Filled sub-properties */}
                {(node.imageType || 'Simple') === 'Filled' && (
                  <>
                    <SelectField
                      label="Fill Method"
                      value={node.fillMethod ?? 0}
                      onChange={(value) => patchNodeOnBridge({ fillMethod: parseInt(value), fillOrigin: 0 })}
                    >
                        <option value={0}>Horizontal</option>
                        <option value={1}>Vertical</option>
                        <option value={2}>Radial 90</option>
                        <option value={3}>Radial 180</option>
                        <option value={4}>Radial 360</option>
                    </SelectField>

                    <SelectField
                      label="Fill Origin"
                      value={node.fillOrigin ?? 0}
                      onChange={(value) => patchNodeOnBridge({ fillOrigin: parseInt(value) })}
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
                    </SelectField>

                    <FieldRow label="Fill Amount">
                      <div className="flex min-w-0 flex-1 items-center gap-2">
                        <input
                          type="range"
                          min={0} max={1} step={0.01}
                          value={node.fillAmount ?? 1}
                          onChange={(e) => patchNodeOnBridge({ fillAmount: parseFloat(e.target.value) })}
                          className="property-slider"
                        />
                        <span className="text-[12px] text-[#a6adc8] w-8 text-right">
                          {((node.fillAmount ?? 1) * 100).toFixed(0)}%
                        </span>
                      </div>
                    </FieldRow>

                    <FieldRow label="Clockwise">
                      <ToggleButton
                        active={node.fillClockwise !== false}
                        onClick={() => patchNodeOnBridge({ fillClockwise: node.fillClockwise === false ? true : false })}
                        activeText="✓"
                        inactiveText="✗"
                        tone="blue"
                      />
                    </FieldRow>
                  </>
                )}

                {/* Use Sprite Mesh (Simple only) */}
                {(node.imageType || 'Simple') === 'Simple' && (
                  <FieldRow label="Use Sprite Mesh">
                    <ToggleButton
                      active={!!node.useSpriteMesh}
                      onClick={() => patchNodeOnBridge({ useSpriteMesh: !node.useSpriteMesh })}
                      activeText="✓"
                      inactiveText="✗"
                      tone="blue"
                    />
                  </FieldRow>
                )}
              </>
            )}

            {/* Preserve Aspect */}
            <FieldRow label="Preserve Aspect">
              <ToggleButton
                active={!!node.preserveAspect}
                onClick={() => patchNodeOnBridge({ preserveAspect: !node.preserveAspect })}
                activeText="✓"
                inactiveText="✗"
                tone="blue"
              />
            </FieldRow>

            {/* Set Native Size */}
            {node.imageData && (
              <div className="flex justify-end mt-1">
                <button
                  onClick={() => {
                    const img = new Image();
                    img.onload = () => {
                      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
                        void resizeNodeOnBridge(node.id, img.naturalWidth, img.naturalHeight, false).catch(reportBridgeError);
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
            <FieldRow label="Outline" className="mt-2">
              <ToggleButton
                active={!!node.outline}
                onClick={() => {
                  patchNodeOnBridge({
                    outline: node.outline ? undefined : { color: '#000000', distance: [1, -1], useGraphicAlpha: true },
                  });
                }}
                activeText="已开启"
                inactiveText="关闭"
                tone="blue"
              />
            </FieldRow>
            {node.outline && (
              <>
                <ColorField label="Effect Color" value={node.outline.color} onChange={(v) => {
                  patchNodeOnBridge({ outline: { ...node.outline!, color: v } });
                }} />
                <FieldRow label="距离">
                  <div className="property-dual-inputs">
                    <input type="number" value={node.outline.distance[0]} step={0.5}
                      onChange={(e) => patchNodeOnBridge({ outline: { ...node.outline!, distance: [Number(e.target.value), node.outline!.distance[1]] } })}
                      className="property-inline-number" />
                    <input type="number" value={node.outline.distance[1]} step={0.5}
                      onChange={(e) => patchNodeOnBridge({ outline: { ...node.outline!, distance: [node.outline!.distance[0], Number(e.target.value)] } })}
                      className="property-inline-number" />
                  </div>
                </FieldRow>
                <FieldRow label="Use Graphic Alpha">
                  <ToggleButton
                    active={node.outline.useGraphicAlpha !== false}
                    onClick={() => patchNodeOnBridge({ outline: { ...node.outline!, useGraphicAlpha: !node.outline!.useGraphicAlpha } })}
                    activeText="✓"
                    inactiveText="✗"
                    tone="blue"
                  />
                </FieldRow>
              </>
            )}
          </Section>
        )}

        {/* 遮罩 */}
        <Section title="遮罩">
          <FieldRow label="Mask">
            <ToggleButton
              active={!!node.isMask}
              onClick={() => {
                patchNodeOnBridge({
                  isMask: !node.isMask,
                  maskType: node.maskType || 'RectMask2D',
                });
              }}
              activeText="已开启"
              inactiveText="关闭"
              tone="pink"
            />
          </FieldRow>
          {node.isMask && (
            <FieldRow label="类型">
              <div className="property-segment-row">
                {(['Mask', 'RectMask2D'] as const).map((t) => (
                  <button key={t} onClick={() => patchNodeOnBridge({ maskType: t })}
                    className={cx('property-segment-button', node.maskType === t && 'property-segment-button-active-pink')}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </FieldRow>
          )}
        </Section>

        {/* 布局组 LayoutGroup */}
        <Section title="布局组 LayoutGroup">
          <FieldRow label="启用">
            <ToggleButton
              active={!!node.layoutGroup?.enabled}
              onClick={() => {
                if (node.layoutGroup?.enabled) {
                  patchNodeOnBridge({ layoutGroup: { ...node.layoutGroup, enabled: false } });
                } else {
                  patchNodeOnBridge({
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
              activeText="已开启"
              inactiveText="关闭"
            />
          </FieldRow>

          {node.layoutGroup?.enabled && (() => {
            const lg = node.layoutGroup;
            const updateLG = (patch: Record<string, any>) => {
              patchNodeOnBridge({ layoutGroup: { ...lg, ...patch } });
            };
            const currentType = lg.layoutType || (lg.isHorizontal ? 'Horizontal' : 'Vertical');
            const isGrid = currentType === 'Grid';
            return (
              <>
                {/* 布局类型 */}
                <FieldRow label="类型">
                  <div className="property-segment-row">
                    {(['Horizontal', 'Vertical', 'Grid'] as const).map((t) => (
                      <button key={t} onClick={() => updateLG({
                        layoutType: t,
                        isHorizontal: t === 'Horizontal',
                        ...(t === 'Grid' ? { cellSizeX: lg.cellSizeX ?? 100, cellSizeY: lg.cellSizeY ?? 100, spacingY: lg.spacingY ?? 0, startCorner: lg.startCorner ?? 0, startAxis: lg.startAxis ?? 0, constraint: lg.constraint ?? 0, constraintCount: lg.constraintCount ?? 2 } : {}),
                      })}
                        className={cx('property-segment-button', currentType === t && 'property-segment-button-active-green')}
                      >
                        {t === 'Horizontal' ? '水平' : t === 'Vertical' ? '垂直' : '网格'}
                      </button>
                    ))}
                  </div>
                </FieldRow>

                {/* Grid 专属属性 */}
                {isGrid && (
                  <>
                    <div className="property-subtitle">Cell Size</div>
                    <div className="grid grid-cols-2 gap-1">
                      <NumberField label="X" value={lg.cellSizeX ?? 100} onChange={(v) => updateLG({ cellSizeX: v })} min={1} />
                      <NumberField label="Y" value={lg.cellSizeY ?? 100} onChange={(v) => updateLG({ cellSizeY: v })} min={1} />
                    </div>
                    <div className="property-subtitle">Spacing</div>
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
                <div className="property-subtitle">Padding</div>
                <div className="flex flex-col items-center gap-0.5">
                  <NumberField label="上" value={lg.padTop} onChange={(v) => updateLG({ padTop: v })} min={0} />
                  <div className="grid grid-cols-2 gap-1 w-full">
                    <NumberField label="左" value={lg.padLeft} onChange={(v) => updateLG({ padLeft: v })} min={0} />
                    <NumberField label="右" value={lg.padRight} onChange={(v) => updateLG({ padRight: v })} min={0} />
                  </div>
                  <NumberField label="下" value={lg.padBottom} onChange={(v) => updateLG({ padBottom: v })} min={0} />
                </div>
                {!isGrid && (lg.padRight > 0 || lg.padBottom > 0) && !lg.childForceExpandWidth && !lg.childForceExpandHeight && !lg.childControlWidth && !lg.childControlHeight && (
                  <div className="property-small-note">提示: 右/下 padding 需开启下方 Control 或 Force Expand 才有可见效果</div>
                )}

                {/* Grid 专属: Start Corner / Start Axis / Constraint */}
                {isGrid && (
                  <>
                    <SelectField label="起始角" value={lg.startCorner ?? 0} onChange={(value) => updateLG({ startCorner: Number(value) })}>
                        <option value={0}>左上</option>
                        <option value={1}>右上</option>
                        <option value={2}>左下</option>
                        <option value={3}>右下</option>
                    </SelectField>
                    <SelectField label="排列轴" value={lg.startAxis ?? 0} onChange={(value) => updateLG({ startAxis: Number(value) })}>
                        <option value={0}>水平</option>
                        <option value={1}>垂直</option>
                    </SelectField>
                    <SelectField label="约束" value={lg.constraint ?? 0} onChange={(value) => updateLG({ constraint: Number(value) })}>
                        <option value={0}>自由</option>
                        <option value={1}>固定列数</option>
                        <option value={2}>固定行数</option>
                    </SelectField>
                    {(lg.constraint ?? 0) > 0 && (
                      <NumberField label="约束数量" value={lg.constraintCount ?? 2} onChange={(v) => updateLG({ constraintCount: v })} min={1} />
                    )}
                  </>
                )}

                {/* Child Alignment */}
                <SelectField label="对齐" value={lg.childAlignment} onChange={(value) => updateLG({ childAlignment: Number(value) })}>
                    <option value={0}>左上</option>
                    <option value={1}>中上</option>
                    <option value={2}>右上</option>
                    <option value={3}>左中</option>
                    <option value={4}>居中</option>
                    <option value={5}>右中</option>
                    <option value={6}>左下</option>
                    <option value={7}>中下</option>
                    <option value={8}>右下</option>
                </SelectField>

                {/* Control & ForceExpand — 仅 H/V */}
                {!isGrid && (
                  <>
                    <div className="property-subtitle">子节点控制</div>
                    {([
                      ['childControlWidth', 'Control Width'],
                      ['childControlHeight', 'Control Height'],
                      ['childForceExpandWidth', 'Force Expand W'],
                      ['childForceExpandHeight', 'Force Expand H'],
                    ] as const).map(([key, label]) => (
                      <FieldRow key={key} label={label}>
                        <ToggleButton
                          active={!!(lg as any)[key]}
                          onClick={() => updateLG({ [key]: !(lg as any)[key] })}
                          activeText="ON"
                          inactiveText="OFF"
                          tone="blue"
                        />
                      </FieldRow>
                    ))}
                  </>
                )}
              </>
            );
          })()}
        </Section>

        {/* ContentSizeFitter */}
        <Section title="ContentSizeFitter">
          <FieldRow label="启用">
            <ToggleButton
              active={!!node.contentSizeFitter?.enabled}
              onClick={() => {
                if (node.contentSizeFitter?.enabled) {
                  patchNodeOnBridge({ contentSizeFitter: { ...node.contentSizeFitter, enabled: false } });
                } else {
                  patchNodeOnBridge({
                    contentSizeFitter: {
                      horizontalFit: 0,
                      verticalFit: 0,
                      ...(node.contentSizeFitter || {}),
                      enabled: true,
                    },
                  });
                }
              }}
              activeText="已开启"
              inactiveText="关闭"
            />
          </FieldRow>
          {node.contentSizeFitter?.enabled && (() => {
            const csf = node.contentSizeFitter;
            const updateCSF = (patch: Record<string, any>) => {
              patchNodeOnBridge({ contentSizeFitter: { ...csf, ...patch } });
            };
            const fitOptions = [
              { value: 0, label: 'Unconstrained' },
              { value: 1, label: 'MinSize' },
              { value: 2, label: 'PreferredSize' },
            ];
            return (
              <>
                <SelectField label="水平" value={csf.horizontalFit} onChange={(value) => updateCSF({ horizontalFit: Number(value) })}>
                    {fitOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </SelectField>
                <SelectField label="垂直" value={csf.verticalFit} onChange={(value) => updateCSF({ verticalFit: Number(value) })}>
                    {fitOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </SelectField>
              </>
            );
          })()}
        </Section>

        {/* 文字效果 */}
        {node.type === 'text' && (
          <Section title="文字效果">
            {/* Outline */}
            <FieldRow label="描边">
              <ToggleButton
                active={!!node.textOutline}
                onClick={() => {
                  patchNodeOnBridge({
                    textOutline: node.textOutline ? undefined : { color: '#000000', distance: [1, -1] },
                  });
                }}
                activeText="已开启"
                inactiveText="关闭"
                tone="blue"
              />
            </FieldRow>
            {node.textOutline && (
              <>
                <ColorField label="描边色" value={node.textOutline.color} onChange={(v) => {
                  patchNodeOnBridge({ textOutline: { ...node.textOutline!, color: v } });
                }} />
                <FieldRow label="距离">
                  <div className="property-dual-inputs">
                    <input type="number" value={node.textOutline.distance[0]} step={0.5}
                      onChange={(e) => patchNodeOnBridge({ textOutline: { ...node.textOutline!, distance: [Number(e.target.value), node.textOutline!.distance[1]] } })}
                      className="property-inline-number" />
                    <input type="number" value={node.textOutline.distance[1]} step={0.5}
                      onChange={(e) => patchNodeOnBridge({ textOutline: { ...node.textOutline!, distance: [node.textOutline!.distance[0], Number(e.target.value)] } })}
                      className="property-inline-number" />
                  </div>
                </FieldRow>
              </>
            )}

            {/* Shadow */}
            <FieldRow label="阴影" className="mt-2">
              <ToggleButton
                active={!!node.textShadow}
                onClick={() => {
                  patchNodeOnBridge({
                    textShadow: node.textShadow ? undefined : { color: '#000000', distance: [1, -1] },
                  });
                }}
                activeText="已开启"
                inactiveText="关闭"
                tone="blue"
              />
            </FieldRow>
            {node.textShadow && (
              <>
                <ColorField label="阴影色" value={node.textShadow.color} onChange={(v) => {
                  patchNodeOnBridge({ textShadow: { ...node.textShadow!, color: v } });
                }} />
                <FieldRow label="距离">
                  <div className="property-dual-inputs">
                    <input type="number" value={node.textShadow.distance[0]} step={0.5}
                      onChange={(e) => patchNodeOnBridge({ textShadow: { ...node.textShadow!, distance: [Number(e.target.value), node.textShadow!.distance[1]] } })}
                      className="property-inline-number" />
                    <input type="number" value={node.textShadow.distance[1]} step={0.5}
                      onChange={(e) => patchNodeOnBridge({ textShadow: { ...node.textShadow!, distance: [node.textShadow!.distance[0], Number(e.target.value)] } })}
                      className="property-inline-number" />
                  </div>
                </FieldRow>
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
  onChange: (path: string) => void;
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
      onChange(img.path);
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
          onChange(data.path);
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
                onChange(img.path);
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

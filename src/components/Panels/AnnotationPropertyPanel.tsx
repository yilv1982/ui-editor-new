// src/components/Panels/AnnotationPropertyPanel.tsx
import { useRef } from 'react';
import { useEditorStore } from '../../stores/editorStore';

export default function AnnotationPropertyPanel() {
  const ids = useEditorStore((s) => s.selectedAnnotationIds);
  const annotations = useEditorStore((s) => s.annotations);
  // 同一字段连续编辑(拖滑块/连续敲键)只入一条历史 — 失焦后才允许下一次入栈
  const focusedRef = useRef(false);
  if (ids.length === 0) return null;
  const a = annotations[ids[0]];
  if (!a) return null;

  const update = (patch: Partial<typeof a>) =>
    useEditorStore.getState().updateAnnotation(a.id, patch);

  const onEditFocus = () => {
    if (focusedRef.current) return;
    focusedRef.current = true;
    useEditorStore.getState().pushHistory();
  };
  const onEditBlur = () => { focusedRef.current = false; };
  const editProps = { onFocus: onEditFocus, onBlur: onEditBlur };

  return (
    <div className="p-3 text-[13px] text-[#cdd6f4]">
      <div className="text-[#a6adc8] mb-2">批注 · {a.type}</div>

      <label className="flex items-center gap-2 mb-2">
        <span className="text-[#6c7086] text-[12px] w-12 shrink-0">颜色</span>
        <input
          type="color"
          value={a.color}
          onChange={(e) => update({ color: e.target.value })}
          {...editProps}
          className="w-10 h-6 cursor-pointer"
        />
        <input
          type="text"
          value={a.color}
          onChange={(e) => update({ color: e.target.value })}
          {...editProps}
          className="flex-1"
        />
      </label>

      <label className="flex items-center gap-2 mb-2">
        <span className="text-[#6c7086] text-[12px] w-12 shrink-0">线宽</span>
        <input
          type="number"
          value={a.strokeWidth}
          min={1}
          max={10}
          step={0.5}
          onChange={(e) => update({ strokeWidth: parseFloat(e.target.value) || 1 })}
          {...editProps}
          className="w-16"
        />
      </label>

      {(a.type === 'text' || a.type === 'number' || a.type === 'dimension') && (
        <label className="flex items-center gap-2 mb-2">
          <span className="text-[#6c7086] text-[12px] w-12 shrink-0">字号</span>
          <input
            type="number"
            value={a.fontSize ?? 18}
            min={8}
            max={64}
            onChange={(e) => update({ fontSize: parseInt(e.target.value, 10) || 18 })}
            {...editProps}
            className="w-16"
          />
        </label>
      )}

      {(a.type === 'text' || a.type === 'dimension') && (
        <label className="flex items-center gap-2 mb-2">
          <span className="text-[#6c7086] text-[12px] w-12 shrink-0">文字</span>
          <input
            type="text"
            value={a.text ?? ''}
            onChange={(e) => update({ text: e.target.value })}
            {...editProps}
            className="flex-1"
          />
        </label>
      )}

      {a.type === 'number' && (
        <label className="flex items-center gap-2 mb-2">
          <span className="text-[#6c7086] text-[12px] w-12 shrink-0">编号</span>
          <input
            type="number"
            value={a.badgeNumber ?? 1}
            onChange={(e) => update({ badgeNumber: parseInt(e.target.value, 10) || 1 })}
            {...editProps}
            className="w-16"
          />
        </label>
      )}

      {(a.type === 'arrow' || a.type === 'flow-line' || a.type === 'dimension') && (
        <label className="flex items-center gap-2 mb-2">
          <span className="text-[#6c7086] text-[12px] w-12 shrink-0">箭头</span>
          <select
            value={a.arrowEnd ?? 'end'}
            onChange={(e) => {
              useEditorStore.getState().pushHistory();
              update({ arrowEnd: e.target.value as 'none' | 'end' | 'both' });
            }}
          >
            <option value="none">无</option>
            <option value="end">单端</option>
            <option value="both">双端</option>
          </select>
        </label>
      )}

      <button
        onClick={() => useEditorStore.getState().deleteAnnotation(a.id)}
        className="mt-2 px-2 py-1 text-[12px] text-[#f38ba8] hover:bg-[#313244] rounded"
      >
        删除批注
      </button>
    </div>
  );
}

// src/components/Panels/AnnotationListDialog.tsx
// 批注列表调试面板:列出当前页所有批注,可定位/删除
import { useEffect } from 'react';
import { useEditorStore } from '../../stores/editorStore';

interface Props { onClose: () => void }

export default function AnnotationListDialog({ onClose }: Props) {
  const annotations = useEditorStore((s) => s.annotations);
  const annotationRootIds = useEditorStore((s) => s.annotationRootIds);
  const previewWidth = useEditorStore((s) => s.previewWidth);
  const previewHeight = useEditorStore((s) => s.previewHeight);
  const list = annotationRootIds.map((id) => annotations[id]).filter(Boolean);

  useEffect(() => {
    if (list.length === 0) onClose();
  }, [list.length, onClose]);

  if (list.length === 0) return null;

  return (
    <div className="fixed inset-0 z-[100] bg-black/50 flex items-center justify-center" onClick={onClose}>
      <div
        className="bg-[#1e1e2e] border border-[#313244] rounded-lg p-4 min-w-[600px] max-h-[80vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-[#cdd6f4] text-base font-medium">当前页所有批注 ({list.length})</h3>
          <div className="flex items-center gap-2">
            {list.length > 0 && (
              <button
                onClick={() => {
                  if (window.confirm(`确定清除当前页全部 ${list.length} 个批注?此操作可撤销 (Ctrl+Z)`)) {
                    useEditorStore.getState().clearAllAnnotations();
                  }
                }}
                className="px-2 py-0.5 text-[12px] text-[#f38ba8] hover:bg-[#313244] rounded border border-[#f38ba8]/40"
              >清除全部</button>
            )}
            <button onClick={onClose} className="text-[#a6adc8] hover:text-[#cdd6f4]">×</button>
          </div>
        </div>
        {list.length === 0 ? (
          <div className="text-[#6c7086] text-center py-6">没有批注</div>
        ) : (
          <table className="w-full text-[12px] text-[#cdd6f4]">
            <thead className="text-[#6c7086] border-b border-[#313244]">
              <tr>
                <th className="text-left py-1 px-2">#</th>
                <th className="text-left py-1 px-2">类型</th>
                <th className="text-right py-1 px-2">x</th>
                <th className="text-right py-1 px-2">y</th>
                <th className="text-right py-1 px-2">w</th>
                <th className="text-right py-1 px-2">h</th>
                <th className="text-left py-1 px-2">画布外?</th>
                <th className="text-left py-1 px-2">内容</th>
                <th className="py-1 px-2"></th>
              </tr>
            </thead>
            <tbody>
              {list.map((a, i) => {
                const outside =
                  a.x < 0 || a.y < 0 ||
                  a.x + a.width > previewWidth || a.y + a.height > previewHeight;
                const desc = a.type === 'number'
                  ? `№${a.badgeNumber ?? '?'}`
                  : a.type === 'flow-line'
                    ? `→ ${a.refNodeId?.slice(0, 6) ?? ''}…`
                    : (a.text ?? '').slice(0, 20);
                return (
                  <tr key={a.id} className="border-b border-[#313244]/50 hover:bg-[#313244]/30">
                    <td className="py-1 px-2 text-[#6c7086]">{i + 1}</td>
                    <td className="py-1 px-2">{a.type}</td>
                    <td className="py-1 px-2 text-right">{Math.round(a.x)}</td>
                    <td className="py-1 px-2 text-right">{Math.round(a.y)}</td>
                    <td className="py-1 px-2 text-right">{Math.round(a.width)}</td>
                    <td className="py-1 px-2 text-right">{Math.round(a.height)}</td>
                    <td className="py-1 px-2">{outside ? <span className="text-[#f38ba8]">⚠ 是</span> : ''}</td>
                    <td className="py-1 px-2 text-[#a6adc8]">{desc}</td>
                    <td className="py-1 px-2 flex gap-1 justify-end">
                      <button
                        onClick={() => {
                          useEditorStore.getState().setSelectedAnnotationIds([a.id]);
                          // 居中画布到该批注
                          const st = useEditorStore.getState();
                          const cx = a.x + a.width / 2;
                          const cy = a.y + a.height / 2;
                          const c = document.querySelector('#unity-canvas') as HTMLCanvasElement | null;
                          const rect = c?.getBoundingClientRect();
                          if (rect) {
                            const newX = rect.width / 2 - cx * st.canvasScale;
                            const newY = rect.height / 2 - cy * st.canvasScale;
                            st.setCanvasTransform(newX, newY, st.canvasScale);
                          }
                        }}
                        className="px-2 py-0.5 text-[11px] text-[#89b4fa] hover:bg-[#313244] rounded"
                      >定位</button>
                      <button
                        onClick={() => {
                          if (window.confirm(`删除这个 ${a.type} 批注?`)) {
                            useEditorStore.getState().deleteAnnotation(a.id);
                          }
                        }}
                        className="px-2 py-0.5 text-[11px] text-[#f38ba8] hover:bg-[#313244] rounded"
                      >删除</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

import { useEditorStore } from '../../stores/editorStore';
import type { AnnotationType } from '../../types';

const TOOLS: { type: AnnotationType; icon: string; label: string }[] = [
  { type: 'arrow', icon: '→', label: '箭头' },
  { type: 'flow-line', icon: '⤴', label: '流程线' },
  { type: 'text', icon: 'T', label: '文本' },
  { type: 'number', icon: '①', label: '编号' },
  { type: 'rect', icon: '▢', label: '高亮' },
  { type: 'dimension', icon: '↔', label: '尺寸' },
];

function getHintText(
  tool: AnnotationType,
  hasFlowLineSrc: boolean,
): string {
  switch (tool) {
    case 'arrow':
    case 'dimension':
      return '拖拽以绘制';
    case 'rect':
      return '拖拽以绘制高亮框';
    case 'flow-line':
      return hasFlowLineSrc ? '再点终点节点(可跨页)' : '先点起点节点';
    case 'text':
      return '点击画布以放置文本';
    case 'number':
      return '点击画布以放置编号';
  }
}

export default function AnnotationModeBar() {
  const tool = useEditorStore((s) => s.annotationTool);
  const hint = useEditorStore((s) => s.annotationHint);
  const flowLineSrcId = useEditorStore((s) => s.flowLineDraftSrcId);
  const setTool = useEditorStore((s) => s.setAnnotationTool);

  if (!tool) return null;

  const baseHint = getHintText(tool, !!flowLineSrcId);

  const currentLabel = TOOLS.find((t) => t.type === tool)?.label;

  return (
    <div
      className="absolute z-[60] bg-[#1e1e2e]/95 border border-[#313244] rounded-lg shadow-lg backdrop-blur-sm select-none whitespace-nowrap"
      style={{ pointerEvents: 'auto', top: 'calc(100% + 6px)', right: 0 }}
    >
      {/* 工具行 */}
      <div className="flex items-center gap-1.5 px-3 py-1.5">
        <span className="text-[13px] text-[#cba6f7] font-medium mr-1 whitespace-nowrap">📌 批注</span>
        {TOOLS.map((t) => {
          const active = tool === t.type;
          return (
            <button
              key={t.type}
              onClick={() => setTool(active ? null : t.type)}
              className={`px-2.5 py-1 text-[13px] rounded transition-colors flex items-center gap-1 whitespace-nowrap ${
                active
                  ? 'bg-[#f38ba8] text-[#1e1e2e]'
                  : 'text-[#a6adc8] hover:bg-[#313244]'
              }`}
              title={t.label}
            >
              <span className="text-base leading-none">{t.icon}</span>
              <span>{t.label}</span>
            </button>
          );
        })}
        <button
          onClick={() => setTool(null)}
          className="ml-1 w-7 h-7 flex items-center justify-center text-[#a6adc8] hover:text-[#f38ba8] hover:bg-[#313244] rounded text-lg"
          title="退出批注模式 (Esc)"
        >
          ×
        </button>
      </div>

      {/* 提示行 */}
      <div className="flex items-center gap-2 px-3 py-1 text-[12px] border-t border-[#313244]/50 min-h-[24px]">
        <span className="text-[#6c7086]">当前批注 {currentLabel},</span>
        {hint ? (
          <span className="text-[#f38ba8]">⚠ {hint}</span>
        ) : (
          <span className="text-[#a6adc8]">{baseHint}</span>
        )}
      </div>
    </div>
  );
}

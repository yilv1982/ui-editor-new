/**
 * SceneToolbar — 左侧统一工具栏
 * 上半部分：场景工具 (Hand/Move/Rotate/Scale/Rect/Transform)
 * 下半部分：对齐工具 (仅选中时显示)
 */
import { useEditorStore } from '../../stores/editorStore';
import type { SceneTool } from '../../types';

const I = 16;
const s = { width: I, height: I, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

const SCENE_TOOLS: ({ key: SceneTool; label: string; shortcut: string; icon: React.ReactNode } | 'div')[] = [
  { key: 'hand', label: '抓手', shortcut: 'Q',
    icon: <svg {...s}><path d="M8 2v7M5.5 4.5V3a1 1 0 0 0-2 0v6M10.5 4.5V3a1 1 0 0 1 2 0v5.5" /><path d="M5.5 9.5a3.5 3.5 0 0 0 0-3V3M8 2a1 1 0 0 0-2 0v2M8 2a1 1 0 0 1 2 0v2.5M10.5 4.5a1 1 0 0 1 2 0M12.5 8.5c0 3-2 4.5-4.5 4.5S4 13 3.5 10.5" /></svg> },
  'div',
  { key: 'move', label: '移动', shortcut: 'W',
    icon: <svg {...s}><path d="M8 2v12M2 8h12M8 2l-2.5 2.5M8 2l2.5 2.5M8 14l-2.5-2.5M8 14l2.5-2.5M2 8l2.5-2.5M2 8l2.5 2.5M14 8l-2.5-2.5M14 8l-2.5 2.5" /></svg> },
  { key: 'rotate', label: '旋转', shortcut: 'E',
    icon: <svg {...s}><path d="M13 8a5 5 0 1 1-1.5-3.5" /><path d="M13 2v3h-3" /></svg> },
  { key: 'scale', label: '缩放', shortcut: 'R',
    icon: <svg {...s}><path d="M3 3h3M3 3v3M3 3l4.5 4.5M13 13h-3M13 13v-3M13 13L8.5 8.5" /><rect x="6.5" y="6.5" width="3" height="3" rx=".5" /></svg> },
  { key: 'rect', label: '矩形变换', shortcut: 'T',
    icon: <svg {...s}><rect x="3" y="3" width="10" height="10" rx="0.5" /><circle cx="3" cy="3" r="1.2" fill="currentColor" stroke="none" /><circle cx="13" cy="3" r="1.2" fill="currentColor" stroke="none" /><circle cx="3" cy="13" r="1.2" fill="currentColor" stroke="none" /><circle cx="13" cy="13" r="1.2" fill="currentColor" stroke="none" /></svg> },
  { key: 'transform', label: '综合变换', shortcut: 'Y',
    icon: <svg {...s}><path d="M8 2v12M2 8h12" /><path d="M8 2l-1.5 1.5M8 2l1.5 1.5M8 14l-1.5-1.5M8 14l1.5-1.5M2 8l1.5-1.5M2 8l1.5 1.5M14 8l-1.5-1.5M14 8l-1.5 1.5" /><circle cx="8" cy="8" r="3" strokeDasharray="2 2" /></svg> },
];

// 对齐图标（14x14）
const A = {
  left: <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 2v10M4 4h6v2H4zM4 8h4v2H4z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  centerH: <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 2v10M4 4h6v2H4zM5 8h4v2H5z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  right: <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M12 2v10M4 4h6v2H4zM6 8h4v2H6z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  top: <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 2h10M4 4h2v6H4zM8 4h2v4H8z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  centerV: <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 7h10M4 4h2v6H4zM8 5h2v4H8z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  bottom: <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 12h10M4 4h2v6H4zM8 6h2v4H8z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  distH: <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2 3v8M12 3v8M5 5h1v4H5zM8 5h1v4H8z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>,
  distV: <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 2h8M3 12h8M5 5h4v1H5zM5 8h4v1H5z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>,
};

interface Props {
  onAlign: (mode: 'left' | 'right' | 'top' | 'bottom' | 'center-h' | 'center-v' | 'distribute-h' | 'distribute-v') => void;
}

export default function SceneToolbar({ onAlign }: Props) {
  const sceneTool = useEditorStore((s) => s.sceneTool);
  const setSceneTool = useEditorStore((s) => s.setSceneTool);
  const selectedCount = useEditorStore((s) => s.selectedIds.length);

  const btn = (active: boolean) =>
    `w-7 h-7 flex items-center justify-center rounded transition-colors ${
      active ? 'bg-[#4C7EF3] text-[#fff]' : 'text-[#a6adc8] hover:bg-[#313244] hover:text-[#cdd6f4]'
    }`;
  const alignBtn = 'w-7 h-7 flex items-center justify-center text-[#a6adc8] hover:bg-[#45475a] hover:text-[#cdd6f4] rounded transition-colors';
  const divider = <span className="w-5 h-px bg-[#45475a] my-0.5" />;

  return (
    <div
      className="absolute z-20 flex flex-col items-center gap-0.5 bg-[#1e1e2e]/90 backdrop-blur rounded-lg p-1 border border-[#313244]"
      style={{ left: 32, top: '50%', transform: 'translateY(-50%)' }}
    >
      {/* ---- 场景工具 ---- */}
      {SCENE_TOOLS.map((item, i) => {
        if (item === 'div') return <span key={`d${i}`} className="w-5 h-px bg-[#45475a] my-0.5" />;
        return (
          <button key={item.key} onClick={() => setSceneTool(item.key)}
            title={`${item.label} (${item.shortcut})`} className={btn(sceneTool === item.key)}>
            {item.icon}
          </button>
        );
      })}

      {/* ---- 对齐工具（选中时显示） ---- */}
      {selectedCount > 0 && (
        <>
          {divider}
          <button className={alignBtn} title="左对齐 (Alt+A)" onClick={() => onAlign('left')}>{A.left}</button>
          <button className={alignBtn} title="水平居中 (Alt+H)" onClick={() => onAlign('center-h')}>{A.centerH}</button>
          <button className={alignBtn} title="右对齐 (Alt+D)" onClick={() => onAlign('right')}>{A.right}</button>
          {divider}
          <button className={alignBtn} title="顶对齐 (Alt+W)" onClick={() => onAlign('top')}>{A.top}</button>
          <button className={alignBtn} title="垂直居中 (Alt+V)" onClick={() => onAlign('center-v')}>{A.centerV}</button>
          <button className={alignBtn} title="底对齐 (Alt+S)" onClick={() => onAlign('bottom')}>{A.bottom}</button>
          {selectedCount >= 3 && (
            <>
              {divider}
              <button className={alignBtn} title="水平等距 (Ctrl+Alt+H)" onClick={() => onAlign('distribute-h')}>{A.distH}</button>
              <button className={alignBtn} title="垂直等距 (Ctrl+Alt+V)" onClick={() => onAlign('distribute-v')}>{A.distV}</button>
            </>
          )}
        </>
      )}
    </div>
  );
}

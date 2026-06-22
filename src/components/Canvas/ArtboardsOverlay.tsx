/**
 * ArtboardsOverlay — 在画布上绘制每个画板的边框、标题栏；接受标题栏拖动。
 *
 * 设计坐标 → 屏幕坐标公式（注意：画板坐标=画布世界坐标系，节点坐标=画板内本地坐标系）：
 *   屏幕 X = canvasX + artboard.x * canvasScale
 *   屏幕 Y = canvasY + artboard.y * canvasScale
 *   屏幕宽 = previewWidth * canvasScale
 *   屏幕高 = previewHeight * canvasScale
 */
import { useRef, useState } from 'react';
import { useEditorStore } from '../../stores/editorStore';

const TITLE_BAR_H = 24; // 标题栏在画板上方外侧，单位 px 屏幕坐标（不缩放）

export default function ArtboardsOverlay() {
  const pages = useEditorStore((s) => s.pages);
  const activePageId = useEditorStore((s) => s.activePageId);
  const activeArtboardId = useEditorStore((s) => s.activeArtboardId);
  const selectedArtboardId = useEditorStore((s) => s.selectedArtboardId);
  const canvasX = useEditorStore((s) => s.canvasX);
  const canvasY = useEditorStore((s) => s.canvasY);
  const canvasScale = useEditorStore((s) => s.canvasScale);
  const previewWidth = useEditorStore((s) => s.previewWidth);
  const previewHeight = useEditorStore((s) => s.previewHeight);
  const setActiveArtboard = useEditorStore((s) => s.setActiveArtboard);
  const setSelectedArtboardId = useEditorStore((s) => s.setSelectedArtboardId);
  const updateArtboard = useEditorStore((s) => s.updateArtboard);
  const renameArtboard = useEditorStore((s) => s.renameArtboard);

  const page = pages.find((p) => p.id === activePageId);
  const dragRef = useRef<{ artboardId: string; startClientX: number; startClientY: number; startX: number; startY: number } | null>(null);
  // 拖动期间的视觉偏移：只让 overlay 跟手,不写 store
  // 拖完一次性 updateArtboard,避免每帧重建 Unity 节点树
  const [dragOffset, setDragOffset] = useState<{ artboardId: string; dx: number; dy: number } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renamingValue, setRenamingValue] = useState('');

  if (!page || !page.artboards || page.artboards.length === 0) {
    return null;
  }

  const startRename = (id: string, name: string) => {
    setRenamingId(id);
    setRenamingValue(name);
  };
  const finishRename = () => {
    if (renamingId && renamingValue.trim()) renameArtboard(renamingId, renamingValue.trim());
    setRenamingId(null);
  };

  const handleTitlePointerDown = (e: React.PointerEvent, artboardId: string, startX: number, startY: number) => {
    if (renamingId === artboardId) return;
    e.stopPropagation();
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setActiveArtboard(artboardId);
    setSelectedArtboardId(artboardId);
    dragRef.current = {
      artboardId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startX,
      startY,
    };
    setDragOffset({ artboardId, dx: 0, dy: 0 });
  };

  const handleTitlePointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const d = dragRef.current;
    const dx = (e.clientX - d.startClientX) / canvasScale;
    const dy = (e.clientY - d.startClientY) / canvasScale;
    setDragOffset({ artboardId: d.artboardId, dx, dy });
  };

  const handleTitlePointerUp = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    const d = dragRef.current;
    const off = dragOffset;
    // 拖动距离 > 0 才写 store（避免单纯点击也触发更新）
    if (off && (Math.abs(off.dx) > 0.5 || Math.abs(off.dy) > 0.5)) {
      updateArtboard(d.artboardId, { x: d.startX + off.dx, y: d.startY + off.dy });
    }
    dragRef.current = null;
    setDragOffset(null);
  };

  return (
    <>
      {page.artboards.map((a) => {
        // 拖动期间用临时偏移,不写 store,避免每帧触发 Unity 全量重建
        const dragDx = dragOffset?.artboardId === a.id ? dragOffset.dx : 0;
        const dragDy = dragOffset?.artboardId === a.id ? dragOffset.dy : 0;
        const effX = a.x + dragDx;
        const effY = a.y + dragDy;
        // 画板显示尺寸 = 当前预览分辨率（所有画板共享分辨率,跟着切换变化）
        // 而非 a.width / a.height (这些是数据字段,首期保持 1920x1080 不变)
        const screenX = canvasX + effX * canvasScale;
        const screenY = canvasY + effY * canvasScale;
        const screenW = previewWidth * canvasScale;
        const screenH = previewHeight * canvasScale;
        const isActive = a.id === activeArtboardId;
        const isSelected = a.id === selectedArtboardId;
        const borderColor = isActive
          ? 'rgba(137, 180, 250, 0.85)'
          : 'rgba(108, 112, 134, 0.45)';
        const titleColor = isActive ? '#cdd6f4' : '#a6adc8';
        const titleBg = isSelected
          ? 'rgba(137, 180, 250, 0.40)'
          : (isActive ? 'rgba(49, 50, 68, 0.95)' : 'rgba(30, 30, 46, 0.92)');

        return (
          <div key={a.id} className="absolute" style={{ inset: 0, pointerEvents: 'none', zIndex: 5 }}>
            {/* 画板边框 */}
            <div
              className="absolute"
              style={{
                left: screenX,
                top: screenY,
                width: screenW,
                height: screenH,
                outline: `${isActive ? 2 : 1}px solid ${borderColor}`,
                boxSizing: 'border-box',
                pointerEvents: 'none',
              }}
            />
            {/* 标题栏（位于画板上方外侧） */}
            <div
              className="absolute select-none flex items-center px-2 text-xs"
              style={{
                left: screenX,
                top: screenY - TITLE_BAR_H,
                width: screenW,
                height: TITLE_BAR_H,
                background: titleBg,
                color: titleColor,
                fontWeight: isActive ? 600 : 400,
                cursor: renamingId === a.id ? 'text' : 'move',
                pointerEvents: 'auto',
                borderRadius: '4px 4px 0 0',
                border: `1px solid ${borderColor}`,
                borderBottom: 'none',
              }}
              onPointerDown={(e) => handleTitlePointerDown(e, a.id, a.x, a.y)}
              onPointerMove={handleTitlePointerMove}
              onPointerUp={handleTitlePointerUp}
              onPointerCancel={handleTitlePointerUp}
              onDoubleClick={(e) => {
                e.stopPropagation();
                startRename(a.id, a.name);
              }}
              data-artboard-title={a.id}
            >
              {renamingId === a.id ? (
                <input
                  autoFocus
                  className="flex-1 min-w-0 text-xs bg-transparent border-b border-[#89b4fa] text-inherit outline-none"
                  style={{ font: 'inherit' }}
                  value={renamingValue}
                  onChange={(e) => setRenamingValue(e.target.value)}
                  onBlur={finishRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') finishRename();
                    if (e.key === 'Escape') setRenamingId(null);
                    e.stopPropagation();
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                />
              ) : (
                <span className="truncate flex-1">{a.name}</span>
              )}
              <span className="text-[10px] opacity-60 ml-2">{previewWidth}×{previewHeight}</span>
              {/* 说明栏开关 */}
              <button
                title={a.sidebarEnabled ? '关闭 UE 说明栏' : '打开 UE 说明栏'}
                className="ml-2 px-1 rounded text-[11px]"
                style={{
                  color: a.sidebarEnabled ? '#a6e3a1' : '#6c7086',
                  background: a.sidebarEnabled ? 'rgba(166,227,161,0.15)' : 'transparent',
                  pointerEvents: 'auto',
                  cursor: 'pointer',
                }}
                onPointerDownCapture={(e) => {
                  // 拦截在 capture 阶段,防止父容器 onPointerDown 启动拖拽
                  e.stopPropagation();
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  // 切换该画板的 sidebarEnabled (任意画板都能开关,不只是 active)
                  useEditorStore.getState().toggleSidebarEnabled(activePageId, a.id);
                  // 顺手把 active 切到这个画板,让说明栏面板出现在它边上
                  if (a.id !== activeArtboardId) {
                    setActiveArtboard(a.id);
                  }
                }}
              >📝</button>
            </div>
          </div>
        );
      })}
    </>
  );
}

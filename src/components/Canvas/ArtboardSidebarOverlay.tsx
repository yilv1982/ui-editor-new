/**
 * ArtboardSidebarOverlay — 为每个 sidebarEnabled 的画板在其右侧浮动一份 SidebarBlocksPanel。
 * 每个面板编辑各自画板的 sidebar 数据(独立)。
 */
import { useEditorStore } from '../../stores/editorStore';
import SidebarBlocksPanel from '../Panels/SidebarBlocksPanel';

const SIDEBAR_GAP = 80; // 与画板右边缘的间距(屏幕像素)
const PANEL_WIDTH = 480; // 面板逻辑宽度
const PANEL_BOOST = 1.6; // 整体放大倍数(让说明栏比左侧面板更醒目)

export default function ArtboardSidebarOverlay() {
  const pages = useEditorStore((s) => s.pages);
  const activePageId = useEditorStore((s) => s.activePageId);
  const canvasX = useEditorStore((s) => s.canvasX);
  const canvasY = useEditorStore((s) => s.canvasY);
  const canvasScale = useEditorStore((s) => s.canvasScale);
  const previewWidth = useEditorStore((s) => s.previewWidth);

  const page = pages.find((p) => p.id === activePageId);
  if (!page) return null;

  return (
    <>
      {page.artboards.map((a) => {
        if (!a.sidebarEnabled) return null;
        // 总缩放因子 = canvasScale × PANEL_BOOST(让面板比常规 UI 更大,贴近 UE 评审稿密度)
        const finalScale = canvasScale * PANEL_BOOST;
        const screenX = canvasX + a.x * canvasScale + previewWidth * canvasScale + SIDEBAR_GAP * canvasScale;
        const screenY = canvasY + a.y * canvasScale;

        return (
          <div
            key={a.id}
            className="absolute"
            style={{
              left: screenX,
              top: screenY,
              width: PANEL_WIDTH * finalScale,
              pointerEvents: 'auto',
              zIndex: 9,
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onWheel={(e) => e.stopPropagation()}
          >
            <div
              style={{
                width: PANEL_WIDTH,
                transform: `scale(${finalScale})`,
                transformOrigin: 'top left',
              }}
            >
              <SidebarBlocksPanel artboardId={a.id} />
            </div>
          </div>
        );
      })}
    </>
  );
}

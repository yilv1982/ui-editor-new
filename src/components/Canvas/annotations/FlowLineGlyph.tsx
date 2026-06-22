import type { GlyphProps } from './types';

export default function FlowLineGlyph({ ann, sx, sy, scale, selected, onPointerDown, onDoubleClick }: GlyphProps) {
  // points 由 AnnotationOverlay 的 resolveFlowLine 计算(已含绕画板外侧的折线)
  const pts = ann.points ?? [{ x: 0, y: 0 }, { x: ann.width, y: 0 }];
  const path = pts.map((p) => `${sx + p.x * scale},${sy + p.y * scale}`).join(' ');
  const stroke = ann.color;
  const hitWidth = Math.max(12, ann.strokeWidth * scale);
  return (
    <g style={{ cursor: 'move' }} onPointerDown={onPointerDown} onDoubleClick={onDoubleClick}>
      {/* 透明命中线 */}
      <polyline
        points={path}
        fill="none"
        stroke="transparent"
        strokeWidth={hitWidth}
        pointerEvents="stroke"
      />
      {/* 可见虚线 */}
      <polyline
        points={path}
        fill="none"
        stroke={stroke}
        strokeWidth={ann.strokeWidth * scale}
        strokeDasharray={`${6 * scale} ${4 * scale}`}
        markerEnd="url(#ann-arrow-end)"
        pointerEvents="none"
      />
      {/* 端点 handle:只在两端显示 */}
      {selected && (
        <>
          <circle cx={sx + pts[0].x * scale} cy={sy + pts[0].y * scale} r={5} fill="#fff" stroke={stroke} strokeWidth={1.5} pointerEvents="none" />
          <circle cx={sx + pts[pts.length - 1].x * scale} cy={sy + pts[pts.length - 1].y * scale} r={5} fill="#fff" stroke={stroke} strokeWidth={1.5} pointerEvents="none" />
        </>
      )}
    </g>
  );
}

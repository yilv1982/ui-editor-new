import type { GlyphProps } from './types';

export default function DimensionGlyph({ ann, sx, sy, scale, selected, onPointerDown, onDoubleClick }: GlyphProps) {
  const pts = ann.points ?? [{ x: 0, y: 0 }, { x: ann.width, y: 0 }];
  const p1 = { x: sx + pts[0].x * scale, y: sy + pts[0].y * scale };
  const p2 = { x: sx + pts[1].x * scale, y: sy + pts[1].y * scale };
  const dx = pts[1].x - pts[0].x;
  const dy = pts[1].y - pts[0].y;
  const lengthDesign = Math.round(Math.sqrt(dx * dx + dy * dy));
  const label = ann.text && ann.text.length > 0 ? ann.text : `${lengthDesign}px`;
  const mx = (p1.x + p2.x) / 2;
  const my = (p1.y + p2.y) / 2;
  const stroke = ann.color;
  const hitWidth = Math.max(12, ann.strokeWidth * scale);
  return (
    <g style={{ cursor: 'move' }} onPointerDown={onPointerDown} onDoubleClick={onDoubleClick}>
      {/* 透明命中线 */}
      <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y}
        stroke="transparent" strokeWidth={hitWidth} pointerEvents="stroke" />
      {/* 可见线 */}
      <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y}
        stroke={stroke} strokeWidth={ann.strokeWidth * scale}
        markerStart="url(#ann-arrow-end)" markerEnd="url(#ann-arrow-end)"
        pointerEvents="none" />
      <text x={mx} y={my - 6 * scale} textAnchor="middle" fill={stroke} fontSize={(ann.fontSize ?? 18) * scale} fontWeight="bold" pointerEvents="none">
        {label}
      </text>
      {selected && pts.map((p, i) => (
        <circle key={i} cx={sx + p.x * scale} cy={sy + p.y * scale} r={5} fill="#fff" stroke={stroke} strokeWidth={1.5} pointerEvents="none" />
      ))}
    </g>
  );
}

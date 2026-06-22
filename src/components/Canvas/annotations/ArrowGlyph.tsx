import type { GlyphProps } from './types';

export default function ArrowGlyph({ ann, sx, sy, scale, selected, onPointerDown, onDoubleClick }: GlyphProps) {
  const pts = ann.points ?? [{ x: 0, y: 0 }, { x: ann.width, y: 0 }];
  const path = pts.map((p) => `${sx + p.x * scale},${sy + p.y * scale}`).join(' ');
  const stroke = ann.color;
  const hitWidth = Math.max(12, ann.strokeWidth * scale);
  return (
    <g style={{ cursor: 'move' }} onPointerDown={onPointerDown} onDoubleClick={onDoubleClick}>
      {/* 透明命中线 - 仅接 pointer 事件 */}
      <polyline
        points={path}
        fill="none"
        stroke="transparent"
        strokeWidth={hitWidth}
        pointerEvents="stroke"
      />
      {/* 可见线 */}
      <polyline
        points={path}
        fill="none"
        stroke={stroke}
        strokeWidth={ann.strokeWidth * scale}
        pointerEvents="none"
        markerEnd={ann.arrowEnd === 'end' || ann.arrowEnd === 'both' ? 'url(#ann-arrow-end)' : undefined}
        markerStart={ann.arrowEnd === 'both' ? 'url(#ann-arrow-end)' : undefined}
      />
      {selected && pts.map((p, i) => (
        <circle key={i} cx={sx + p.x * scale} cy={sy + p.y * scale} r={5} fill="#fff" stroke={stroke} strokeWidth={1.5} pointerEvents="none" />
      ))}
    </g>
  );
}

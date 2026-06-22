import type { GlyphProps } from './types';

export default function NumberBadgeGlyph({ ann, sx, sy, sw, sh, scale, selected, onPointerDown, onDoubleClick }: GlyphProps) {
  const cx = sx + sw / 2;
  const cy = sy + sh / 2;
  const r = Math.min(sw, sh) / 2;
  return (
    <g style={{ pointerEvents: 'visiblePainted', cursor: 'move' }} onPointerDown={onPointerDown} onDoubleClick={onDoubleClick}>
      <circle cx={cx} cy={cy} r={r} fill={ann.color} stroke="#fff" strokeWidth={1.5 * scale} />
      <text x={cx} y={cy} textAnchor="middle" dominantBaseline="central" fill="#1e1e2e" fontSize={(ann.fontSize ?? 18) * scale} fontWeight="bold">
        {ann.badgeNumber ?? '?'}
      </text>
      {selected && (
        <circle cx={cx} cy={cy} r={r + 3} fill="none" stroke="#89b4fa" strokeDasharray="4 2" strokeWidth={1} />
      )}
    </g>
  );
}

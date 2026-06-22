import type { GlyphProps } from './types';

export default function RectHighlightGlyph({ ann, sx, sy, sw, sh, scale, selected, onPointerDown, onDoubleClick }: GlyphProps) {
  return (
    <g style={{ pointerEvents: 'visiblePainted', cursor: 'move' }} onPointerDown={onPointerDown} onDoubleClick={onDoubleClick}>
      <rect x={sx} y={sy} width={sw} height={sh} fill={ann.color} fillOpacity={0.18} stroke={ann.color} strokeWidth={ann.strokeWidth * scale} />
      {selected && (
        <rect x={sx - 2} y={sy - 2} width={sw + 4} height={sh + 4} fill="none" stroke="#89b4fa" strokeDasharray="4 2" strokeWidth={1} />
      )}
    </g>
  );
}

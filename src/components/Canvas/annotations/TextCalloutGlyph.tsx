import type { GlyphProps } from './types';

export default function TextCalloutGlyph({ ann, sx, sy, sw, sh, scale, selected, onPointerDown, onDoubleClick }: GlyphProps) {
  return (
    <g style={{ pointerEvents: 'visiblePainted', cursor: 'move' }} onPointerDown={onPointerDown} onDoubleClick={onDoubleClick}>
      <rect x={sx} y={sy} width={sw} height={sh}
        fill="rgba(30,30,46,0.85)" stroke={ann.color} strokeWidth={ann.strokeWidth * scale} rx={4 * scale} />
      <foreignObject x={sx} y={sy} width={sw} height={sh}>
        <div style={{
          color: ann.color,
          fontSize: (ann.fontSize ?? 18) * scale,
          padding: 6 * scale,
          width: '100%',
          height: '100%',
          boxSizing: 'border-box',
          overflow: 'hidden',
          fontFamily: 'sans-serif',
          lineHeight: 1.3,
        }}>{ann.text ?? ''}</div>
      </foreignObject>
      {selected && (
        <rect x={sx - 2} y={sy - 2} width={sw + 4} height={sh + 4} fill="none" stroke="#89b4fa" strokeDasharray="4 2" strokeWidth={1} />
      )}
    </g>
  );
}

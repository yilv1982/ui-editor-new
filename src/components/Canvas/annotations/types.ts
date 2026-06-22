import type { AnnotationNode } from '../../../types';

export interface GlyphProps {
  ann: AnnotationNode;
  /** Screen coords of annotation top-left */
  sx: number;
  sy: number;
  /** Screen size of annotation */
  sw: number;
  sh: number;
  /** Total scale (designToScreen) */
  scale: number;
  selected: boolean;
  onPointerDown?: (e: React.PointerEvent) => void;
  onDoubleClick?: (e: React.MouseEvent) => void;
}

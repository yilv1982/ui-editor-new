// src/types/annotation.ts
export type AnnotationType =
  | 'arrow'
  | 'text'
  | 'number'
  | 'rect'
  | 'dimension'
  | 'flow-line';

export interface AnnotationNode {
  id: string;
  type: AnnotationType;
  // 几何 (设计画布坐标)
  x: number;
  y: number;
  width: number;
  height: number;
  // 弱引用
  refNodeId?: string;
  refPageId?: string;
  // 视觉
  color: string;
  strokeWidth: number;
  // 可选属性
  text?: string;
  fontSize?: number;
  arrowEnd?: 'none' | 'end' | 'both';
  points?: { x: number; y: number }[];   // 相对 (ann.x, ann.y) 的偏移点; arrow / flow-line / dimension 用
  badgeNumber?: number;
}

export const DEFAULT_ANNOTATION_COLOR = '#f38ba8';
export const DEFAULT_ANNOTATION_STROKE = 3.5;
export const DEFAULT_ANNOTATION_FONT_SIZE = 18;

export function createAnnotation(
  type: AnnotationType,
  id: string,
  x: number,
  y: number,
  partial?: Partial<AnnotationNode>
): AnnotationNode {
  const base: AnnotationNode = {
    id,
    type,
    x,
    y,
    width: 100,
    height: 40,
    color: DEFAULT_ANNOTATION_COLOR,
    strokeWidth: DEFAULT_ANNOTATION_STROKE,
    fontSize: DEFAULT_ANNOTATION_FONT_SIZE,
  };
  if (type === 'arrow' || type === 'flow-line') {
    base.arrowEnd = 'end';
    base.points = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
  }
  if (type === 'text') {
    base.text = '说明';
    base.width = 120;
    base.height = 40;
  }
  if (type === 'number') {
    base.badgeNumber = 1;
    base.width = 28;
    base.height = 28;
  }
  if (type === 'rect') {
    base.width = 120;
    base.height = 80;
  }
  if (type === 'dimension') {
    base.text = '';
    base.points = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
  }
  return { ...base, ...partial };
}

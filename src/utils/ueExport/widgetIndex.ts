// src/utils/ueExport/widgetIndex.ts
// 提取页面中可见的可交互/重要控件,用于导出版式 1 的"控件索引表"。
import type { UINode, NodeType } from '../../types';

export interface WidgetIndexEntry {
  id: string;
  name: string;
  type: NodeType;
  x: number; y: number; width: number; height: number;
}

const WIDGET_TYPES: NodeType[] = ['button', 'toggle', 'inputfield', 'image', 'scrollview'];

export function extractWidgetIndex(nodes: Record<string, UINode>, rootIds: string[]): WidgetIndexEntry[] {
  const out: WidgetIndexEntry[] = [];
  function recurse(id: string) {
    const n = nodes[id];
    if (!n) return;
    if (n.visible && WIDGET_TYPES.includes(n.type) && n.name) {
      out.push({ id: n.id, name: n.name, type: n.type, x: n.x, y: n.y, width: n.width, height: n.height });
    }
    n.children.forEach(recurse);
  }
  rootIds.forEach(recurse);
  return out;
}

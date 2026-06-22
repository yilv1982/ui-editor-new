import type { UINode } from '../types';
import { DESIGN_WIDTH, DESIGN_HEIGHT } from '../config/assetPaths';

/**
 * 给定节点的编辑器坐标（设计分辨率空间）和 anchor，
 * 计算在不同父容器尺寸下该节点的适配坐标。
 *
 * 逻辑：先用设计分辨率的 parentSize 算出 Unity 的 anchoredPosition/sizeDelta，
 * 再用预览分辨率的 parentSize 逆推编辑器坐标。
 */
export function adaptNodeCoords(
  node: { x: number; y: number; width: number; height: number; anchorMin?: { x: number; y: number }; anchorMax?: { x: number; y: number }; pivot?: { x: number; y: number } },
  designParentW: number,
  designParentH: number,
  previewParentW: number,
  previewParentH: number,
): { x: number; y: number; width: number; height: number } {
  if (designParentW === previewParentW && designParentH === previewParentH) {
    return { x: node.x, y: node.y, width: node.width, height: node.height };
  }

  const aMin = node.anchorMin || { x: 0.5, y: 0.5 };
  const aMax = node.anchorMax || { x: 0.5, y: 0.5 };
  const pivot = node.pivot || { x: 0.5, y: 0.5 };
  const w = node.width;
  const h = node.height;

  const stretchX = Math.abs(aMax.x - aMin.x) > 0.001;
  const stretchY = Math.abs(aMax.y - aMin.y) > 0.001;

  // ---- 正向：编辑器坐标 → Unity anchoredPosition/sizeDelta（设计分辨率）----
  let apX: number, apY: number, sdX: number, sdY: number;

  if (stretchX) {
    sdX = w - designParentW * (aMax.x - aMin.x);
    const offsetMinX = node.x - designParentW * aMin.x;
    apX = offsetMinX + sdX * pivot.x;
  } else {
    sdX = w;
    apX = node.x - aMin.x * designParentW + pivot.x * w;
  }

  if (stretchY) {
    sdY = h - designParentH * (aMax.y - aMin.y);
    const bottomEdge = designParentH - node.y - h;
    const offsetMinY = bottomEdge - designParentH * aMin.y;
    apY = offsetMinY + sdY * pivot.y;
  } else {
    sdY = h;
    apY = designParentH - node.y - (1 - pivot.y) * h - aMin.y * designParentH;
  }

  // ---- 逆向：Unity anchoredPosition/sizeDelta → 编辑器坐标（预览分辨率）----
  let nx: number, ny: number, nw: number, nh: number;

  if (stretchX) {
    nw = sdX + previewParentW * (aMax.x - aMin.x);
    const offMinX = apX - sdX * pivot.x;
    nx = offMinX + previewParentW * aMin.x;
  } else {
    nw = sdX;
    nx = apX + aMin.x * previewParentW - pivot.x * nw;
  }

  if (stretchY) {
    nh = sdY + previewParentH * (aMax.y - aMin.y);
    const offMinY = apY - sdY * pivot.y;
    const btmEdge = offMinY + previewParentH * aMin.y;
    ny = previewParentH - nh - btmEdge;
  } else {
    nh = sdY;
    ny = previewParentH - apY - (1 - pivot.y) * nh - aMin.y * previewParentH;
  }

  return { x: nx, y: ny, width: nw, height: nh };
}

/**
 * 计算节点在预览分辨率下的绝对位置（递归考虑父节点链的 anchor 适配）
 */
export function getAdaptedAbsolutePosition(
  nodeId: string,
  nodes: Record<string, UINode>,
  previewW: number,
  previewH: number,
  designW = DESIGN_WIDTH,
  designH = DESIGN_HEIGHT,
): { x: number; y: number; width: number; height: number } {
  const node = nodes[nodeId];
  if (!node) return { x: 0, y: 0, width: 0, height: 0 };

  // 构建从根到当前节点的祖先链（不含当前节点）
  const ancestors: UINode[] = [];
  let pid = node.parentId;
  while (pid && nodes[pid]) {
    ancestors.unshift(nodes[pid]);
    pid = nodes[pid].parentId;
  }

  // 自顶向下逐层计算适配后的尺寸
  let curDesignParentW = designW;
  let curDesignParentH = designH;
  let curPreviewParentW = previewW;
  let curPreviewParentH = previewH;
  let absX = 0;
  let absY = 0;

  for (const ancestor of ancestors) {
    const adapted = adaptNodeCoords(ancestor, curDesignParentW, curDesignParentH, curPreviewParentW, curPreviewParentH);
    absX += adapted.x;
    absY += adapted.y;
    // 下一层的父尺寸
    curDesignParentW = ancestor.width;
    curDesignParentH = ancestor.height;
    curPreviewParentW = adapted.width;
    curPreviewParentH = adapted.height;
  }

  // 计算目标节点本身
  const self = adaptNodeCoords(node, curDesignParentW, curDesignParentH, curPreviewParentW, curPreviewParentH);
  return {
    x: absX + self.x,
    y: absY + self.y,
    width: self.width,
    height: self.height,
  };
}

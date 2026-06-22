// src/components/Canvas/AnnotationOverlay.tsx
import { useRef, useState } from 'react';
import { useEditorStore } from '../../stores/editorStore';
import { getAdaptedAbsolutePosition } from '../../utils/anchorAdapt';
import ArrowGlyph from './annotations/ArrowGlyph';
import TextCalloutGlyph from './annotations/TextCalloutGlyph';
import NumberBadgeGlyph from './annotations/NumberBadgeGlyph';
import RectHighlightGlyph from './annotations/RectHighlightGlyph';
import DimensionGlyph from './annotations/DimensionGlyph';
import FlowLineGlyph from './annotations/FlowLineGlyph';
import type { AnnotationNode, AnnotationType } from '../../types';
import type { GlyphProps } from './annotations/types';

export interface PreviewDraft {
  type: 'arrow' | 'rect' | 'dimension' | 'flow-line' | 'text' | 'number';
  /** 拖拽起点屏幕坐标(arrow/rect/dimension 用) */
  startScreen?: { x: number; y: number };
  /** 当前鼠标屏幕坐标 */
  currentScreen: { x: number; y: number };
  /** 流程线起点节点 id */
  flowLineSrcId?: string;
  /** 流程线当前命中节点 id(目标候选高亮) */
  flowLineHoverDstId?: string;
  /** 默认色 */
  color: string;
}

interface Props {
  offsetX: number;
  offsetY: number;
  scale: number;
  effectiveW: number;
  effectiveH: number;
  previewDraft?: PreviewDraft;
}

const GLYPHS: Record<AnnotationType, React.ComponentType<GlyphProps>> = {
  arrow: ArrowGlyph,
  text: TextCalloutGlyph,
  number: NumberBadgeGlyph,
  rect: RectHighlightGlyph,
  dimension: DimensionGlyph,
  'flow-line': FlowLineGlyph,
};

export default function AnnotationOverlay({ offsetX, offsetY, scale, effectiveW, effectiveH, previewDraft }: Props) {
  const annotations = useEditorStore((s) => s.annotations);
  const annotationRootIds = useEditorStore((s) => s.annotationRootIds);
  const nodes = useEditorStore((s) => s.nodes);
  const selected = useEditorStore((s) => s.selectedAnnotationIds);
  const visible = useEditorStore((s) => s.annotationLayerVisible);
  const setSelected = useEditorStore((s) => s.setSelectedAnnotationIds);
  // 跨画板查找节点用:遍历当前 page 所有画板
  const pages = useEditorStore((s) => s.pages);
  const activePageId = useEditorStore((s) => s.activePageId);
  const activeArtboardId = useEditorStore((s) => s.activeArtboardId);
  const activePage = pages.find((p) => p.id === activePageId);

  const dragRef = useRef<{ id: string; startScreen: { x: number; y: number }; startPos: { x: number; y: number } } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  if (!visible) return null;

  /** 在当前 page 的所有画板里找节点,返回 {artboard, nodes} 用于解析坐标 */
  function findNodeArtboard(nodeId: string): { artboard: { x: number; y: number; width: number; height: number; id: string }; nodes: typeof nodes } | null {
    if (!activePage) return null;
    for (const ab of activePage.artboards) {
      // active 画板用顶层 nodes 镜像(最新);其他用 ab.nodes
      const useNodes = ab.id === activeArtboardId ? nodes : ab.nodes;
      if (useNodes[nodeId]) return { artboard: ab, nodes: useNodes };
    }
    return null;
  }

  // 解析流程线端点(根据 refNodeId / refPageId)。
  // 同页流程线: 起点是源节点中心,终点是目标节点中心(目标节点 id 暂存于 ann.text)。
  //   两端节点可能在不同画板,各自加自己画板的 (x,y) 偏移;路径绕到画板右侧外。
  // 跨页流程线: 在源页时,只显示带 "→其它页" 文字的占位,端点在源节点旁。
  function resolveFlowLine(a: AnnotationNode): AnnotationNode | null {
    if (a.type !== 'flow-line') return a;
    if (!a.refNodeId) return null;
    const srcLoc = findNodeArtboard(a.refNodeId);
    if (!srcLoc) return null;
    const sb = getAdaptedAbsolutePosition(a.refNodeId, srcLoc.nodes, effectiveW, effectiveH);
    const sxMid = srcLoc.artboard.x + sb.x + sb.width / 2;
    const syMid = srcLoc.artboard.y + sb.y + sb.height / 2;
    if (a.refPageId) {
      // 跨页: 在源节点右侧显示一个短箭头 + "→其它页" 标签
      return {
        ...a,
        x: sxMid,
        y: syMid,
        width: 60,
        height: 0,
        points: [{ x: 0, y: 0 }, { x: 60, y: 0 }],
        text: '→其它页',
      };
    }
    // 同页(可跨画板): 目标节点 id 在 a.text
    const dstId = a.text;
    if (!dstId) return null;
    const dstLoc = findNodeArtboard(dstId);
    if (!dstLoc) return null;
    const db = getAdaptedAbsolutePosition(dstId, dstLoc.nodes, effectiveW, effectiveH);
    const dxMid = dstLoc.artboard.x + db.x + db.width / 2;
    const dyMid = dstLoc.artboard.y + db.y + db.height / 2;

    // 计算绕画板外侧的正交折线路径
    const MARGIN = 20; // 拐点离画板边的距离
    const srcAb = srcLoc.artboard;
    const dstAb = dstLoc.artboard;
    // 从源节点向右伸出至源画板外侧
    const exitX = Math.max(srcAb.x + effectiveW, dstAb.x + effectiveW) + MARGIN;
    // 终点入口段:从目标节点向右出至同一外侧列
    const points: { x: number; y: number }[] = [
      { x: 0, y: 0 },                              // 源节点中心(相对自身,即 0,0)
      { x: exitX - sxMid, y: 0 },                   // 水平到外侧列
      { x: exitX - sxMid, y: dyMid - syMid },       // 垂直到目标 Y
      { x: dxMid - sxMid, y: dyMid - syMid },       // 水平进入目标
    ];
    return {
      ...a,
      x: sxMid,
      y: syMid,
      width: dxMid - sxMid,
      height: dyMid - syMid,
      points,
    };
  }

  const handleGlyphPointerDown = (id: string) => (e: React.PointerEvent) => {
    e.stopPropagation();
    const a = useEditorStore.getState().annotations[id];
    if (!a) return;
    setSelected([id]);
    // 流程线不可拖动(端点跟随节点)
    if (a.type === 'flow-line') return;
    // 拖拽起点入历史,Ctrl+Z 可撤回到拖动前的位置
    useEditorStore.getState().pushHistory();
    dragRef.current = {
      id,
      startScreen: { x: e.clientX, y: e.clientY },
      startPos: { x: a.x, y: a.y },
    };
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };

  const handleSvgPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = (e.clientX - drag.startScreen.x) / scale;
    const dy = (e.clientY - drag.startScreen.y) / scale;
    useEditorStore.getState().updateAnnotation(drag.id, {
      x: drag.startPos.x + dx,
      y: drag.startPos.y + dy,
    });
  };

  const handleSvgPointerUp = (e: React.PointerEvent) => {
    if (dragRef.current) {
      try { (e.currentTarget as Element).releasePointerCapture?.(e.pointerId); } catch { /* noop */ }
      dragRef.current = null;
    }
  };

  const handleGlyphDoubleClick = (id: string) => () => {
    const a = useEditorStore.getState().annotations[id];
    if (!a) return;
    if (a.type === 'text' || a.type === 'number' || a.type === 'dimension') {
      setEditingId(id);
    }
  };

  const editingAnn = editingId ? annotations[editingId] : null;
  const editX = editingAnn ? offsetX + editingAnn.x * scale : 0;
  const editY = editingAnn ? offsetY + editingAnn.y * scale : 0;
  const editW = editingAnn ? Math.max(80, editingAnn.width * scale) : 0;
  const editH = editingAnn ? Math.max(28, editingAnn.height * scale) : 0;

  const finishEdit = (commit: boolean, value: string) => {
    if (!editingId || !editingAnn) { setEditingId(null); return; }
    if (commit) {
      const st = useEditorStore.getState();
      if (editingAnn.type === 'number') {
        const n = parseInt(value, 10);
        const newN = isNaN(n) ? editingAnn.badgeNumber : n;
        if (newN !== editingAnn.badgeNumber) st.pushHistory();
        st.updateAnnotation(editingId, { badgeNumber: newN });
      } else {
        if (value !== (editingAnn as any).text) st.pushHistory();
        st.updateAnnotation(editingId, { text: value });
      }
    }
    setEditingId(null);
  };

  return (
    <svg
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        zIndex: 50,
      }}
      onPointerMove={handleSvgPointerMove}
      onPointerUp={handleSvgPointerUp}
    >
      <defs>
        <marker id="ann-arrow-end" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
        </marker>
      </defs>
      {annotationRootIds.map((id) => {
        const raw: AnnotationNode | undefined = annotations[id];
        if (!raw) return null;
        if (editingId === id) return null;
        const a = resolveFlowLine(raw);
        if (!a) return null;
        const sx = offsetX + a.x * scale;
        const sy = offsetY + a.y * scale;
        const sw = a.width * scale;
        const sh = a.height * scale;
        const Glyph = GLYPHS[a.type];
        return (
          <g key={id} data-annotation-glyph={id}>
            <Glyph
              ann={a}
              sx={sx} sy={sy} sw={sw} sh={sh}
              scale={scale}
              selected={selected.includes(id)}
              onPointerDown={handleGlyphPointerDown(id)}
              onDoubleClick={handleGlyphDoubleClick(id)}
            />
          </g>
        );
      })}
      {/* 实时预览 ghost */}
      {previewDraft && (() => {
        const dr = previewDraft;
        const ghostStroke = dr.color;
        const ghostOpacity = 0.5;

        // 拖拽型 ghost
        if ((dr.type === 'arrow' || dr.type === 'rect' || dr.type === 'dimension') && dr.startScreen) {
          const x1 = dr.startScreen.x;
          const y1 = dr.startScreen.y;
          const x2 = dr.currentScreen.x;
          const y2 = dr.currentScreen.y;
          if (dr.type === 'rect') {
            const left = Math.min(x1, x2);
            const top = Math.min(y1, y2);
            const w = Math.abs(x2 - x1);
            const h = Math.abs(y2 - y1);
            return (
              <rect key="preview" x={left} y={top} width={w} height={h}
                fill="none" stroke={ghostStroke} strokeWidth={2}
                strokeDasharray="4 2" opacity={ghostOpacity} pointerEvents="none" />
            );
          }
          return (
            <line key="preview" x1={x1} y1={y1} x2={x2} y2={y2}
              stroke={ghostStroke} strokeWidth={2}
              strokeDasharray="4 2" opacity={ghostOpacity}
              markerEnd={dr.type === 'arrow' ? 'url(#ann-arrow-end)' : undefined}
              pointerEvents="none" />
          );
        }

        // 流程线起点已选 - 起点节点中心 → 鼠标
        if (dr.type === 'flow-line' && dr.flowLineSrcId) {
          const src = nodes[dr.flowLineSrcId];
          if (!src) return null;
          const sb = getAdaptedAbsolutePosition(dr.flowLineSrcId, nodes, effectiveW, effectiveH);
          const sxMid = offsetX + (sb.x + sb.width / 2) * scale;
          const syMid = offsetY + (sb.y + sb.height / 2) * scale;
          const hover = dr.flowLineHoverDstId ? nodes[dr.flowLineHoverDstId] : null;
          let hoverRect = null;
          if (hover && dr.flowLineHoverDstId) {
            const hb = getAdaptedAbsolutePosition(dr.flowLineHoverDstId, nodes, effectiveW, effectiveH);
            hoverRect = (
              <rect x={offsetX + hb.x * scale} y={offsetY + hb.y * scale}
                width={hb.width * scale} height={hb.height * scale}
                fill="none" stroke="#89b4fa" strokeWidth={2}
                strokeDasharray="3 2" pointerEvents="none" />
            );
          }
          return (
            <g key="preview" pointerEvents="none">
              {hoverRect}
              <line x1={sxMid} y1={syMid} x2={dr.currentScreen.x} y2={dr.currentScreen.y}
                stroke={ghostStroke} strokeWidth={2}
                strokeDasharray="6 4" opacity={ghostOpacity}
                markerEnd="url(#ann-arrow-end)" />
            </g>
          );
        }

        // 文本/编号 - 鼠标位置 ghost 框
        if (dr.type === 'text') {
          const w = 120;
          const h = 30;
          return (
            <rect key="preview" x={dr.currentScreen.x - 60} y={dr.currentScreen.y - 14}
              width={w} height={h} fill="none" stroke={ghostStroke}
              strokeWidth={1} strokeDasharray="3 2" opacity={ghostOpacity}
              pointerEvents="none" />
          );
        }
        if (dr.type === 'number') {
          return (
            <circle key="preview" cx={dr.currentScreen.x} cy={dr.currentScreen.y}
              r={14} fill="none" stroke={ghostStroke}
              strokeWidth={1} strokeDasharray="3 2" opacity={ghostOpacity}
              pointerEvents="none" />
          );
        }

        return null;
      })()}
      {editingAnn && (
        <foreignObject x={editX} y={editY} width={editW} height={editH} style={{ pointerEvents: 'all' }}>
          <input
            autoFocus
            defaultValue={editingAnn.type === 'number' ? String(editingAnn.badgeNumber ?? '') : (editingAnn.text ?? '')}
            type={editingAnn.type === 'number' ? 'number' : 'text'}
            onBlur={(e) => finishEdit(true, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              else if (e.key === 'Escape') finishEdit(false, '');
              e.stopPropagation();
            }}
            style={{
              width: '100%', height: '100%', boxSizing: 'border-box',
              background: '#1e1e2e', color: editingAnn.color,
              border: `1px solid ${editingAnn.color}`,
              fontSize: (editingAnn.fontSize ?? 18) * scale,
              padding: 4, outline: 'none',
              fontFamily: 'sans-serif',
            }}
          />
        </foreignObject>
      )}
    </svg>
  );
}

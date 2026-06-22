// src/utils/ueExport/common.ts
// 导出公共管线: 切到目标页和目标画板 → 等 Unity 渲染 → 截画板区域 → 在 canvas 上手绘批注。
import type { AnnotationNode, Artboard, PageData } from '../../types';
import { useEditorStore } from '../../stores/editorStore';
import { cropCanvasToDesignArea } from '../../components/Canvas/UnityCanvas';
import { getAdaptedAbsolutePosition } from '../anchorAdapt';
import { DESIGN_WIDTH, DESIGN_HEIGHT } from '../../config/assetPaths';

/**
 * 截画板"干净版":只截 1920×1080 设计区,只画本画板内的批注。
 * 跨画板的流程线在此处不绘制(由上层在全局大图上统一画)。
 * 返回的 canvas 始终是 cropped 设计区大小,不会因批注外溢而扩展。
 */
export async function captureArtboardClean(
  page: PageData,
  artboard: Artboard,
  includeAnnotations: boolean,
): Promise<HTMLCanvasElement | null> {
  const state = useEditorStore.getState();
  if (state.activePageId !== page.id) state.switchPage(page.id);
  if (useEditorStore.getState().activeArtboardId !== artboard.id) {
    useEditorStore.getState().setActiveArtboard(artboard.id);
  }
  fitCanvasToArtboard(artboard);
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  await new Promise((r) => setTimeout(r, 400));

  const c = document.getElementById('unity-canvas') as HTMLCanvasElement | null;
  if (!c) return null;
  const cropped = cropCanvasToDesignArea(c);
  if (!cropped) return null;

  if (!includeAnnotations) return cropped;

  const allAnns = Object.values(useEditorStore.getState().annotations);
  const artNodes = artboard.nodes;
  const inThisArtboard = (cx: number, cy: number) =>
    cx >= artboard.x && cx < artboard.x + artboard.width &&
    cy >= artboard.y && cy < artboard.y + artboard.height;

  const annsLocal: AnnotationNode[] = [];
  for (const a of allAnns) {
    if (a.type === 'flow-line') {
      // 跨画板流程线交给上层处理;这里只画"源和目标都在本画板"的同画板流程线。
      if (!a.refNodeId || !artNodes[a.refNodeId]) continue;
      const sb = getAdaptedAbsolutePosition(a.refNodeId, artNodes, DESIGN_WIDTH, DESIGN_HEIGHT);
      const sxMid = sb.x + sb.width / 2;
      const syMid = sb.y + sb.height / 2;
      const dstId = a.text;
      if (a.refPageId || !dstId || !artNodes[dstId]) continue;
      const db = getAdaptedAbsolutePosition(dstId, artNodes, DESIGN_WIDTH, DESIGN_HEIGHT);
      const dxMid = db.x + db.width / 2;
      const dyMid = db.y + db.height / 2;
      // 全局 → 本画板局部(本画板节点坐标已是局部,起止点同样是局部)
      annsLocal.push({
        ...a,
        x: sxMid, y: syMid,
        width: dxMid - sxMid, height: dyMid - syMid,
        points: [{ x: 0, y: 0 }, { x: dxMid - sxMid, y: dyMid - syMid }],
      });
      continue;
    }
    // 其他批注的坐标是全局(Page 坐标系),按中心点判断是否在本画板内,然后转为本画板局部坐标
    const cx = a.x + a.width / 2;
    const cy = a.y + a.height / 2;
    if (!inThisArtboard(cx, cy)) continue;
    annsLocal.push({ ...a, x: a.x - artboard.x, y: a.y - artboard.y });
  }

  if (annsLocal.length === 0) return cropped;

  const ctx = cropped.getContext('2d');
  if (ctx) drawAnnotationsOnCanvas(ctx, annsLocal, cropped.width, cropped.height, 0, 0, cropped.width, cropped.height);
  return cropped;
}

/**
 * 把画布视野 fit 到一个"画布世界坐标"矩形(包围盒),保证矩形完整可见且居中。
 * 与 fitCanvasToArtboard 等价,但用于多画板的全局包围盒。
 */
export function fitCanvasToBBox(bboxX: number, bboxY: number, bboxW: number, bboxH: number) {
  const c = document.getElementById('unity-canvas') as HTMLCanvasElement | null;
  if (!c) return;
  const rect = c.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;
  const st = useEditorStore.getState();
  // 画板世界坐标已经是当前预览分辨率坐标，fit 时只使用 canvasScale。
  const canvasScale = Math.min(rect.width / bboxW, rect.height / bboxH) * 0.95;
  // bbox 中心居中
  const bcx = bboxX + bboxW / 2;
  const bcy = bboxY + bboxH / 2;
  const canvasX = rect.width / 2 - bcx * canvasScale;
  const canvasY = rect.height / 2 - bcy * canvasScale;
  st.setCanvasTransform(canvasX, canvasY, canvasScale);
}

/**
 * 一次性截取整个图层(page)所有画板的全局包围盒为一张大图。
 * Unity 同时渲染了 page 内所有画板,所以这里只 fit 一次视野 + crop 一次,不再逐画板切换。
 * 包围盒 = union(画板们) + padding。
 * 在大图上手绘所有 page 级批注(同画板内的、跨画板流程线、跨页流程线占位)。
 *
 * 返回:
 *   canvas:    大图(像素 = bbox * unitySf)
 *   bboxX/Y/W/H: 大图所代表的画布世界坐标矩形(设计像素)
 *   designToPixelRatio: 大图像素 / bbox 设计像素 的缩放比
 */
export interface LayerSnapshot {
  page: PageData;
  canvas: HTMLCanvasElement;
  bboxX: number;
  bboxY: number;
  bboxW: number;
  bboxH: number;
  designToPixelRatio: number;
  /** 每个画板在大图坐标中的位置(设计像素,相对 bboxX/Y) */
  artboardRects: { artboard: Artboard; x: number; y: number; w: number; h: number }[];
}

const BBOX_PADDING_DESIGN = 24;

/**
 * 把整个图层(page)所有画板组合成一张大图。
 *
 * Unity WebGL 的物理分辨率有限,一次性截"所有画板的全局视野"会导致每个画板分到的源像素被压缩,看起来糊。
 * 所以这里改成 **逐画板高清截图,再按全局位置拼到大图**:
 *  1. 每个画板单独 fit + crop,使用 Unity 当前物理分辨率全部用于该画板,质量最高;
 *  2. 同画板内的批注由 captureArtboardClean 直接画在画板截图上;
 *  3. 大图按所有画板的全局包围盒构建,分辨率 = bbox × supersample(基于单画板最高像素密度);
 *  4. 跨画板流程线在大图坐标系下手绘(绕画板外侧的 4 段折线,与编辑器一致)。
 *
 * 视觉效果上完全等同于"一次性截"——画板间的相对位置、空白和流程线全部保留,只是技术上是分批截图后合成。
 */
export async function captureLayerWholeShot(
  page: PageData,
  includeAnnotations: boolean,
): Promise<LayerSnapshot | null> {
  if (page.artboards.length === 0) return null;

  const state = useEditorStore.getState();
  if (state.activePageId !== page.id) state.switchPage(page.id);

  // Step 1: 逐画板高清截图(每画板独占 Unity 全部物理像素)
  const cleanMap = new Map<string, HTMLCanvasElement>();
  for (const ab of page.artboards) {
    const c = await captureArtboardClean(page, ab, includeAnnotations);
    if (c) cleanMap.set(ab.id, c);
  }
  if (cleanMap.size === 0) return null;

  // Step 2: 计算 supersample = max(cropped.width / artboard.width) over all captured artboards
  // 让单画板源像素到大图后保持 1:1(不上采样导致糊)
  let supersample = 1;
  for (const ab of page.artboards) {
    const c = cleanMap.get(ab.id);
    if (!c) continue;
    const ratio = c.width / ab.width;
    if (ratio > supersample) supersample = ratio;
  }

  // Step 3: 全局包围盒(画布世界坐标,设计像素)
  const minX = Math.min(...page.artboards.map((a) => a.x)) - BBOX_PADDING_DESIGN;
  const minY = Math.min(...page.artboards.map((a) => a.y)) - BBOX_PADDING_DESIGN;
  const maxX = Math.max(...page.artboards.map((a) => a.x + a.width)) + BBOX_PADDING_DESIGN;
  const maxY = Math.max(...page.artboards.map((a) => a.y + a.height)) + BBOX_PADDING_DESIGN;
  const bboxW = Math.max(1, maxX - minX);
  const bboxH = Math.max(1, maxY - minY);

  // Step 4: 大图(像素 = bbox * supersample)
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(bboxW * supersample));
  out.height = Math.max(1, Math.round(bboxH * supersample));
  const ctx = out.getContext('2d');
  if (!ctx) return null;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#1e1e2e';
  ctx.fillRect(0, 0, out.width, out.height);

  // Step 5: 把每个画板高清截图按全局位置摆到大图
  for (const ab of page.artboards) {
    const c = cleanMap.get(ab.id);
    if (!c) continue;
    const dx = (ab.x - minX) * supersample;
    const dy = (ab.y - minY) * supersample;
    const dw = ab.width * supersample;
    const dh = ab.height * supersample;
    ctx.drawImage(c, dx, dy, dw, dh);
  }

  // Step 6: 跨画板流程线 + 不在画板内的批注,在大图坐标系下手绘
  if (includeAnnotations) {
    const allAnns = Object.values(useEditorStore.getState().annotations);
    const drawn: AnnotationNode[] = [];
    const nodeToArtboard = new Map<string, Artboard>();
    for (const ab of page.artboards) {
      for (const nid of Object.keys(ab.nodes)) nodeToArtboard.set(nid, ab);
    }

    for (const a of allAnns) {
      if (a.type === 'flow-line') {
        if (!a.refNodeId) continue;
        const srcAb = nodeToArtboard.get(a.refNodeId);
        if (!srcAb) continue;
        const sb = getAdaptedAbsolutePosition(a.refNodeId, srcAb.nodes, DESIGN_WIDTH, DESIGN_HEIGHT);
        const sxGlobal = srcAb.x + sb.x + sb.width / 2;
        const syGlobal = srcAb.y + sb.y + sb.height / 2;

        if (a.refPageId) {
          drawn.push({
            ...a,
            x: sxGlobal - minX, y: syGlobal - minY,
            width: 60, height: 0,
            points: [{ x: 0, y: 0 }, { x: 60, y: 0 }],
          });
          continue;
        }

        const dstId = a.text;
        if (!dstId) continue;
        const dstAb = nodeToArtboard.get(dstId);
        if (!dstAb) continue;
        if (dstAb.id === srcAb.id) continue; // 同画板已在 captureArtboardClean 里画过
        const db = getAdaptedAbsolutePosition(dstId, dstAb.nodes, DESIGN_WIDTH, DESIGN_HEIGHT);
        const dxGlobal = dstAb.x + db.x + db.width / 2;
        const dyGlobal = dstAb.y + db.y + db.height / 2;

        // 与编辑器(AnnotationOverlay.resolveFlowLine)一致:绕画板右外侧的 4 段正交折线
        const MARGIN = 20;
        const exitX = Math.max(srcAb.x + srcAb.width, dstAb.x + dstAb.width) + MARGIN;
        const sxL = sxGlobal - minX;
        const syL = syGlobal - minY;
        const dxL = dxGlobal - minX;
        const dyL = dyGlobal - minY;
        drawn.push({
          ...a,
          x: sxL, y: syL,
          width: dxL - sxL, height: dyL - syL,
          points: [
            { x: 0, y: 0 },
            { x: exitX - sxGlobal, y: 0 },
            { x: exitX - sxGlobal, y: dyL - syL },
            { x: dxL - sxL, y: dyL - syL },
          ],
        });
      } else {
        // 非流程线批注的中心若在某画板内,已由 captureArtboardClean 画过,跳过
        const cx = a.x + a.width / 2;
        const cy = a.y + a.height / 2;
        const insideAny = page.artboards.some(
          (ab) => cx >= ab.x && cx < ab.x + ab.width && cy >= ab.y && cy < ab.y + ab.height,
        );
        if (insideAny) continue;
        drawn.push({ ...a, x: a.x - minX, y: a.y - minY });
      }
    }

    if (drawn.length > 0) {
      // designW/H = bboxW/H 让 s = out.width/bboxW = supersample,
      // 批注的设计坐标 → 大图像素坐标自然缩放。
      drawAnnotationsOnCanvas(ctx, drawn, out.width, out.height, 0, 0, out.width, out.height, bboxW, bboxH);
    }
  }

  return {
    page,
    canvas: out,
    bboxX: minX,
    bboxY: minY,
    bboxW,
    bboxH,
    designToPixelRatio: supersample,
    artboardRects: page.artboards.map((a) => ({
      artboard: a,
      x: a.x - minX,
      y: a.y - minY,
      w: a.width,
      h: a.height,
    })),
  };
}

export interface PageSnapshot {
  pageId: string;
  pageName: string;
  pageGroup?: string;
  artboardId: string;
  artboardName: string;
  canvas: HTMLCanvasElement;          // 已含批注 (可能是扩展后的 canvas)
  annotations: AnnotationNode[];
  designWidth: number;                // canvas 总宽
  designHeight: number;               // canvas 总高
  /** 原设计画布 1920x1080 在 canvas 中的位置 - 用于导出版式按原画布比例缩放 */
  designArea: { x: number; y: number; w: number; h: number };
}

/** 把画布视野 fit 到目标画板（居中 + 完整可见），保证 cropCanvasToDesignArea 能截到完整图。 */
function fitCanvasToArtboard(artboard: Artboard) {
  const c = document.getElementById('unity-canvas') as HTMLCanvasElement | null;
  if (!c) return;
  const rect = c.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;
  const st = useEditorStore.getState();
  // canvasScale = min(rect/preview) * 0.95 留一点边
  const canvasScale = Math.min(rect.width / st.previewWidth, rect.height / st.previewHeight) * 0.95;
  // 截图区在 CSS 像素中的尺寸
  const cssW = st.previewWidth * canvasScale;
  const cssH = st.previewHeight * canvasScale;
  // 让画板居中: canvasX + abX*canvasScale + cssW/2 = rect.w/2
  const canvasX = rect.width / 2 - artboard.x * canvasScale - cssW / 2;
  const canvasY = rect.height / 2 - artboard.y * canvasScale - cssH / 2;
  st.setCanvasTransform(canvasX, canvasY, canvasScale);
}

export async function captureArtboardWithAnnotations(
  page: PageData,
  artboard: Artboard,
  includeAnnotations: boolean,
): Promise<PageSnapshot | null> {
  const state = useEditorStore.getState();
  if (state.activePageId !== page.id) {
    state.switchPage(page.id);
  }
  if (useEditorStore.getState().activeArtboardId !== artboard.id) {
    useEditorStore.getState().setActiveArtboard(artboard.id);
  }
  // 把画布视野 fit 到目标画板
  fitCanvasToArtboard(artboard);
  // 等 Unity 渲染稳定
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  await new Promise((r) => setTimeout(r, 400));

  const c = document.getElementById('unity-canvas') as HTMLCanvasElement | null;
  if (!c) return null;
  const cropped = cropCanvasToDesignArea(c);
  if (!cropped) return null;

  // 筛选批注：只保留坐标在当前画板范围内的（避免每个画板都画全部批注）
  const allAnns = Object.values(useEditorStore.getState().annotations);
  const editorState = useEditorStore.getState();
  const currentArtboardNodes = artboard.nodes;

  const anns = allAnns.filter((a) => {
    // 流程线：只要源节点在当前画板就保留
    if (a.type === 'flow-line' && a.refNodeId && currentArtboardNodes[a.refNodeId]) {
      const sb = getAdaptedAbsolutePosition(a.refNodeId, currentArtboardNodes, DESIGN_WIDTH, DESIGN_HEIGHT);
      const sxMid = sb.x + sb.width / 2;
      const syMid = sb.y + sb.height / 2;
      return sxMid >= artboard.x && sxMid < artboard.x + artboard.width &&
             syMid >= artboard.y && syMid < artboard.y + artboard.height;
    }
    // 其他批注：中心点在画板范围内
    const cx = a.x + a.width / 2;
    const cy = a.y + a.height / 2;
    return cx >= artboard.x && cx < artboard.x + artboard.width &&
           cy >= artboard.y && cy < artboard.y + artboard.height;
  });

  // 解析流程线：计算源/目标节点的真实坐标
  const resolvedAnns: AnnotationNode[] = [];
  for (const a of anns) {
    if (a.type !== 'flow-line') {
      resolvedAnns.push(a);
      continue;
    }
    if (!a.refNodeId || !currentArtboardNodes[a.refNodeId]) continue;
    const sb = getAdaptedAbsolutePosition(a.refNodeId, currentArtboardNodes, DESIGN_WIDTH, DESIGN_HEIGHT);
    const sxMid = sb.x + sb.width / 2;
    const syMid = sb.y + sb.height / 2;

    if (a.refPageId) {
      // 跨页: 源节点旁的短箭头占位
      resolvedAnns.push({
        ...a,
        x: sxMid, y: syMid, width: 60, height: 0,
        points: [{ x: 0, y: 0 }, { x: 60, y: 0 }],
      });
      continue;
    }

    const dstId = a.text;
    if (!dstId) {
      resolvedAnns.push({
        ...a,
        x: sxMid, y: syMid, width: 60, height: 0,
        points: [{ x: 0, y: 0 }, { x: 60, y: 0 }],
      });
      continue;
    }

    // 尝试在当前画板找目标节点
    if (currentArtboardNodes[dstId]) {
      const db = getAdaptedAbsolutePosition(dstId, currentArtboardNodes, DESIGN_WIDTH, DESIGN_HEIGHT);
      const dxMid = db.x + db.width / 2;
      const dyMid = db.y + db.height / 2;
      resolvedAnns.push({
        ...a,
        x: sxMid, y: syMid,
        width: dxMid - sxMid, height: dyMid - syMid,
        points: [{ x: 0, y: 0 }, { x: dxMid - sxMid, y: dyMid - syMid }],
      });
      continue;
    }

    // 目标节点不在当前画板 — 尝试在其他画板找
    let found = false;
    for (const p of editorState.pages) {
      for (const ab of p.artboards) {
        if (ab.nodes[dstId]) {
          // 找到了 — 计算目标节点在全局坐标系的位置
          const db = getAdaptedAbsolutePosition(dstId, ab.nodes, DESIGN_WIDTH, DESIGN_HEIGHT);
          const dxMid = ab.x + db.x + db.width / 2;
          const dyMid = ab.y + db.y + db.height / 2;
          resolvedAnns.push({
            ...a,
            x: sxMid, y: syMid,
            width: dxMid - sxMid, height: dyMid - syMid,
            points: [{ x: 0, y: 0 }, { x: dxMid - sxMid, y: dyMid - syMid }],
          });
          found = true;
          break;
        }
      }
      if (found) break;
    }

    if (!found) {
      resolvedAnns.push({
        ...a,
        x: sxMid, y: syMid, width: 60, height: 0,
        points: [{ x: 0, y: 0 }, { x: 60, y: 0 }],
      });
    }
  }

  if (!includeAnnotations || resolvedAnns.length === 0) {
    return {
      pageId: page.id,
      pageName: page.name,
      pageGroup: page.pageGroup,
      artboardId: artboard.id,
      artboardName: artboard.name,
      canvas: cropped,
      annotations: resolvedAnns,
      designWidth: cropped.width,
      designHeight: cropped.height,
      designArea: { x: 0, y: 0, w: cropped.width, h: cropped.height },
    };
  }

  // 计算所有批注的 bbox(设计坐标),若有出画布的,扩展 canvas
  const designW = 1920;
  const designH = 1080;
  // 设计坐标 → cropped 像素坐标的缩放(cropped 是真实截图像素,不是 CSS 像素)
  const sf = Math.min(cropped.width / designW, cropped.height / designH);
  const bbox = computeAnnotationsBBox(resolvedAnns);  // 设计坐标

  // 判断是否有画布外批注(加 1px 容差避免浮点边界抖动)
  const bboxImgMinX = bbox.minX * sf;
  const bboxImgMinY = bbox.minY * sf;
  const bboxImgMaxX = bbox.maxX * sf;
  const bboxImgMaxY = bbox.maxY * sf;
  const hasOutsideAnn =
    bboxImgMinX < -1 || bboxImgMinY < -1 ||
    bboxImgMaxX > cropped.width + 1 || bboxImgMaxY > cropped.height + 1;

  if (!hasOutsideAnn) {
    // 所有批注都在画布内 — 直接在原截图上画,不扩展不加虚线框
    const ctx = cropped.getContext('2d');
    if (ctx) drawAnnotationsOnCanvas(ctx, resolvedAnns, cropped.width, cropped.height, 0, 0, cropped.width, cropped.height);
    return {
      pageId: page.id,
      pageName: page.name,
      pageGroup: page.pageGroup,
      artboardId: artboard.id,
      artboardName: artboard.name,
      canvas: cropped,
      annotations: resolvedAnns,
      designWidth: cropped.width,
      designHeight: cropped.height,
      designArea: { x: 0, y: 0, w: cropped.width, h: cropped.height },
    };
  }

  // 有画布外批注 — 扩展 canvas 包含所有批注,并画虚线标示原画布边界
  const imgMinX = Math.min(0, Math.floor(bboxImgMinX));
  const imgMinY = Math.min(0, Math.floor(bboxImgMinY));
  const imgMaxX = Math.max(cropped.width, Math.ceil(bboxImgMaxX));
  const imgMaxY = Math.max(cropped.height, Math.ceil(bboxImgMaxY));
  const newW = imgMaxX - imgMinX;
  const newH = imgMaxY - imgMinY;
  const margin = 16;  // 批注边缘留白
  const finalW = newW + margin * 2;
  const finalH = newH + margin * 2;
  const offX = -imgMinX + margin;     // 原画布 (0,0) 在新 canvas 上的位置
  const offY = -imgMinY + margin;

  const out = document.createElement('canvas');
  out.width = finalW;
  out.height = finalH;
  const ctx = out.getContext('2d')!;
  ctx.fillStyle = '#1e1e2e';
  ctx.fillRect(0, 0, finalW, finalH);
  ctx.drawImage(cropped, offX, offY);
  // 画布边界虚线框 — 标示原 1920×1080 设计画布范围
  ctx.save();
  ctx.strokeStyle = '#45475a';
  ctx.lineWidth = 1;
  ctx.setLineDash([6, 4]);
  ctx.strokeRect(offX, offY, cropped.width, cropped.height);
  ctx.restore();
  drawAnnotationsOnCanvas(ctx, resolvedAnns, finalW, finalH, offX, offY, cropped.width, cropped.height);

  return {
    pageId: page.id,
    pageName: page.name,
    pageGroup: page.pageGroup,
    artboardId: artboard.id,
    artboardName: artboard.name,
    canvas: out,
    annotations: resolvedAnns,
    designWidth: finalW,
    designHeight: finalH,
    designArea: { x: offX, y: offY, w: cropped.width, h: cropped.height },
  };
}

function computeAnnotationsBBox(annotations: AnnotationNode[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const a of annotations) {
    // 包含 bbox(用 x/y/w/h)
    minX = Math.min(minX, a.x);
    minY = Math.min(minY, a.y);
    maxX = Math.max(maxX, a.x + a.width);
    maxY = Math.max(maxY, a.y + a.height);
    // 如果有 points,扩展到 points 上
    if (a.points) {
      for (const p of a.points) {
        const px = a.x + p.x;
        const py = a.y + p.y;
        minX = Math.min(minX, px);
        minY = Math.min(minY, py);
        maxX = Math.max(maxX, px);
        maxY = Math.max(maxY, py);
      }
    }
  }
  if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}

/**
 * 在已截图的 canvas 上手绘批注。
 * 批注用设计坐标(1920×1080),需缩放到截图像素坐标。
 * canvasW/canvasH 是含批注外扩后的总尺寸,设计画布范围由 (offX, offY, designAreaW, designAreaH) 给出。
 */
export function drawAnnotationsOnCanvas(
  ctx: CanvasRenderingContext2D,
  annotations: AnnotationNode[],
  canvasW: number,
  canvasH: number,
  offX: number = 0,
  offY: number = 0,
  designAreaW?: number,
  designAreaH?: number,
  designW: number = 1920,
  designH: number = 1080,
) {
  // 设计坐标 → 截图像素坐标的缩放;designArea 是原画布在截图内的真实像素尺寸
  const aw = designAreaW ?? canvasW;
  const ah = designAreaH ?? canvasH;
  const s = Math.min(aw / designW, ah / designH);

  ctx.save();
  ctx.translate(offX, offY);

  for (const a of annotations) {
    ctx.save();
    ctx.strokeStyle = a.color;
    ctx.fillStyle = a.color;
    ctx.lineWidth = a.strokeWidth * s;
    ctx.font = `bold ${(a.fontSize ?? 18) * s}px sans-serif`;
    if (a.type === 'arrow' || a.type === 'flow-line') {
      const pts = a.points ?? [{ x: 0, y: 0 }, { x: a.width, y: 0 }];
      const abs = pts.map((p) => ({ x: (a.x + p.x) * s, y: (a.y + p.y) * s }));
      if (a.type === 'flow-line') ctx.setLineDash([6 * s, 4 * s]);
      ctx.beginPath();
      ctx.moveTo(abs[0].x, abs[0].y);
      for (let i = 1; i < abs.length; i++) ctx.lineTo(abs[i].x, abs[i].y);
      ctx.stroke();
      ctx.setLineDash([]);
      if (a.arrowEnd === 'end' || a.arrowEnd === 'both') drawArrowHead(ctx, abs[abs.length - 2], abs[abs.length - 1], s);
      if (a.arrowEnd === 'both') drawArrowHead(ctx, abs[1], abs[0], s);
    } else if (a.type === 'rect') {
      ctx.save();
      ctx.fillStyle = a.color;
      ctx.globalAlpha = 0.18;
      ctx.fillRect(a.x * s, a.y * s, a.width * s, a.height * s);
      ctx.restore();
      ctx.strokeRect(a.x * s, a.y * s, a.width * s, a.height * s);
    } else if (a.type === 'text') {
      ctx.fillStyle = 'rgba(30,30,46,0.85)';
      ctx.fillRect(a.x * s, a.y * s, a.width * s, a.height * s);
      ctx.strokeStyle = a.color;
      ctx.strokeRect(a.x * s, a.y * s, a.width * s, a.height * s);
      ctx.fillStyle = a.color;
      ctx.textBaseline = 'top';
      wrapText(ctx, a.text ?? '', a.x * s + 6 * s, a.y * s + 6 * s, a.width * s - 12 * s, (a.fontSize ?? 18) * 1.3 * s);
    } else if (a.type === 'number') {
      const cx = (a.x + a.width / 2) * s;
      const cy = (a.y + a.height / 2) * s;
      const r = Math.min(a.width, a.height) / 2 * s;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#1e1e2e';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(a.badgeNumber ?? '?'), cx, cy);
    } else if (a.type === 'dimension') {
      const pts = a.points ?? [{ x: 0, y: 0 }, { x: a.width, y: 0 }];
      const p1 = { x: (a.x + pts[0].x) * s, y: (a.y + pts[0].y) * s };
      const p2 = { x: (a.x + pts[1].x) * s, y: (a.y + pts[1].y) * s };
      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y); ctx.stroke();
      drawArrowHead(ctx, p2, p1, s);
      drawArrowHead(ctx, p1, p2, s);
      const dx = pts[1].x - pts[0].x, dy = pts[1].y - pts[0].y;
      const label = a.text && a.text.length > 0 ? a.text : `${Math.round(Math.sqrt(dx * dx + dy * dy))}px`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(label, (p1.x + p2.x) / 2, (p1.y + p2.y) / 2 - 4 * s);
    }
    ctx.restore();
  }
  ctx.restore();
  // canvasW/canvasH only used for sanity
  void canvasW; void canvasH;
}

function drawArrowHead(ctx: CanvasRenderingContext2D, from: { x: number; y: number }, to: { x: number; y: number }, scale: number) {
  const ang = Math.atan2(to.y - from.y, to.x - from.x);
  const size = 10 * scale;
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - size * Math.cos(ang - Math.PI / 6), to.y - size * Math.sin(ang - Math.PI / 6));
  ctx.lineTo(to.x - size * Math.cos(ang + Math.PI / 6), to.y - size * Math.sin(ang + Math.PI / 6));
  ctx.closePath();
  ctx.fill();
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxWidth: number, lineHeight: number) {
  const lines = text.split('\n');
  let cy = y;
  for (const line of lines) {
    let cur = '';
    for (const ch of line) {
      const test = cur + ch;
      if (ctx.measureText(test).width > maxWidth && cur) {
        ctx.fillText(cur, x, cy); cy += lineHeight; cur = ch;
      } else cur = test;
    }
    if (cur) { ctx.fillText(cur, x, cy); cy += lineHeight; }
  }
}

export function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function downloadCanvas(canvas: HTMLCanvasElement, filename: string) {
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }, 'image/png');
}

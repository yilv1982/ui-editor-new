import { useEffect, useRef, useState } from 'react';
import { useEditorStore } from '../../stores/editorStore';
import { defaultStyle } from '../../types';
import type { UINode } from '../../types';
import { exportToJson, flattenForUnity } from '../../utils/exportJson';
import unityBridge from '../../services/UnityBridge';
import type { PrefabTemplateNode } from '../../utils/importPrefabTemplate';

// ===== Unity 后台截图系统 =====
type ThumbnailVariant = 'canvas' | 'content';

interface ThumbRequest {
  relPath: string;
  variant: ThumbnailVariant;
}

const _thumbCache = new Map<string, string>();
const _fallbackThumbCache = new Map<string, string>();
const _listeners = new Map<string, Set<(url: string) => void>>();
let _queue: ThumbRequest[] = [];
let _processing = false;

function shouldDisableUnityThumbnailRender(): boolean {
  if (typeof window === 'undefined') return false;
  const flag = (window as typeof window & { __UIEDITOR_DISABLE_THUMBNAIL_UNITY__?: boolean }).__UIEDITOR_DISABLE_THUMBNAIL_UNITY__;
  if (flag === true) return true;
  try {
    return new URLSearchParams(window.location.search).get('uieditorVisualProbe') === '1';
  } catch {
    return false;
  }
}

function thumbKey(relPath: string, variant: ThumbnailVariant) {
  return `${variant}:${relPath}`;
}

function thumbnailUrl(relPath: string, variant: ThumbnailVariant) {
  const params = new URLSearchParams({ path: relPath });
  if (variant !== 'canvas') params.set('variant', variant);
  return `/api/prefabs/thumbnail?${params.toString()}`;
}

// 遮罩：截图时覆盖 Unity 画布，用户看不到切换
let _overlay: HTMLImageElement | null = null;
function showOverlay() {
  const canvas = document.getElementById('unity-canvas') as HTMLCanvasElement;
  if (!canvas) return;
  if (!_overlay) {
    _overlay = document.createElement('img');
    _overlay.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;z-index:10;pointer-events:none;';
    canvas.parentElement!.style.position = 'relative';
    canvas.parentElement!.appendChild(_overlay);
  }
  try { _overlay.src = canvas.toDataURL('image/jpeg', 0.92); } catch {}
  _overlay.style.display = 'block';
}
function hideOverlay() {
  if (_overlay) _overlay.style.display = 'none';
}

function buildTempNodes(data: any, canvasWidth: number, canvasHeight: number): { nodes: Record<string, UINode>; rootIds: string[] } {
  const nodes: Record<string, UINode> = {};
  const rootIds: string[] = [];

  function build(tNode: PrefabTemplateNode, parentId: string | null): string {
    const typeMap: Record<string, UINode['type']> = {
      component: 'component', text: 'text', image: 'image', frame: 'frame',
      button: 'button', scrollview: 'scrollview', toggle: 'toggle',
      inputfield: 'inputfield', rawimage: 'rawimage',
    };
    const id = crypto.randomUUID();
    const style = { ...defaultStyle, backgroundColor: 'transparent', backgroundOpacity: 0, opacity: 1 };
    if (tNode.fontSize) style.fontSize = tNode.fontSize;
    if (tNode.fontColor) style.fontColor = tNode.fontColor;
    if (tNode.textAlign) style.textAlign = tNode.textAlign as 'left' | 'center' | 'right';
    if (tNode.fontStyle === 1 || tNode.fontStyle === 3) style.fontWeight = 'bold';
    const childIds: string[] = [];
    if (tNode.children) for (const c of tNode.children) childIds.push(build(c, id));
    nodes[id] = {
      id, name: tNode.type === 'component' ? `@${tNode.componentRef}` : tNode.name,
      type: typeMap[tNode.type] || 'frame',
      x: tNode.x || 0, y: tNode.y || 0, width: tNode.width ?? 100, height: tNode.height ?? 100,
      rotation: tNode.rotation || 0, visible: tNode.active !== false,
      locked: false, children: childIds, parentId, style,
      componentRef: tNode.componentRef, text: tNode.text,
      anchorMin: tNode.anchorMin, anchorMax: tNode.anchorMax, pivot: tNode.pivot,
      originalSizeDelta: (tNode as any).originalSizeDelta,
      originalAnchoredPosition: (tNode as any).originalAnchoredPosition,
      imageData: tNode.imagePath,
      imageType: tNode.imageType as UINode['imageType'],
      sliceEnabled: tNode.sliceBorder?.some((v: number) => v > 0),
      sliceBorder: tNode.sliceBorder ? { left: tNode.sliceBorder[0], right: tNode.sliceBorder[1], top: tNode.sliceBorder[2], bottom: tNode.sliceBorder[3] } : undefined,
      imageColor: tNode.imageColor, fillCenter: tNode.fillCenter, fillMethod: tNode.fillMethod,
      fillAmount: tNode.fillAmount, fillClockwise: tNode.fillClockwise,
      fillOrigin: tNode.fillOrigin, preserveAspect: tNode.preserveAspect,
      imageRaycastTarget: tNode.imageRaycastTarget, imageEnabled: tNode.imageEnabled,
      imageHasSprite: tNode.imageHasSprite, mirrorType: tNode.mirrorType,
      fontPath: tNode.fontPath, fontStyle: tNode.fontStyle, alignment: tNode.alignment,
      richText: tNode.richText, horizontalOverflow: tNode.horizontalOverflow,
      verticalOverflow: tNode.verticalOverflow, lineSpacing: tNode.lineSpacing,
      bestFit: tNode.bestFit, bestFitMinSize: tNode.bestFitMinSize, bestFitMaxSize: tNode.bestFitMaxSize,
      raycastTarget: tNode.raycastTarget,
      textOutline: tNode.textOutline, textShadow: tNode.textShadow,
      textGradient: tNode.textGradient as UINode['textGradient'],
      buttonTransition: tNode.buttonTransition, buttonColors: tNode.buttonColors,
      isMask: tNode.isMask, maskType: tNode.maskType, maskShowGraphic: tNode.maskShowGraphic,
      scrollDirection: tNode.scrollDirection, isOn: tNode.isOn,
      interactable: tNode.interactable,
      layoutGroup: tNode.layoutGroup, contentSizeFitter: tNode.contentSizeFitter,
    } as UINode;
    return id;
  }

  const rootW = data.root.width || 800, rootH = data.root.height || 600;
  const rootId = crypto.randomUUID();
  nodes[rootId] = {
    id: rootId, name: data.name, type: 'frame',
    x: Math.max(0, (canvasWidth - rootW) / 2), y: Math.max(0, (canvasHeight - rootH) / 2),
    width: rootW, height: rootH, rotation: 0, visible: true, locked: false,
    children: [], parentId: null, style: { ...defaultStyle, backgroundColor: 'transparent', backgroundOpacity: 0 },
  } as UINode;
  rootIds.push(rootId);
  nodes[rootId].children.push(build({ ...data.root, x: 0, y: 0 }, rootId));
  return { nodes, rootIds };
}

function unityTextAlignment(alignment?: number): { textAlign: CanvasTextAlign; vertical: 'top' | 'middle' | 'bottom' } {
  if (alignment === undefined) return { textAlign: 'center', vertical: 'middle' };
  const col = alignment % 3;
  const row = Math.floor(alignment / 3);
  return {
    textAlign: col === 0 ? 'left' : col === 2 ? 'right' : 'center',
    vertical: row === 0 ? 'top' : row === 2 ? 'bottom' : 'middle',
  };
}

function renderTextThumbnail(data: any, variant: ThumbnailVariant): string | null {
  const root = data?.root;
  if (!root || root.type !== 'text' || variant !== 'content') return null;

  const width = Math.max(1, Math.round(root.width || 160));
  const height = Math.max(1, Math.round(root.height || 36));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.fillStyle = '#1e1e2e';
  ctx.fillRect(0, 0, width, height);

  const fontSize = Math.max(1, Math.round(root.fontSize || 24));
  const fontWeight = root.fontStyle === 1 || root.fontStyle === 3 ? '700' : '400';
  ctx.font = `${fontWeight} ${fontSize}px "Microsoft YaHei", Arial, sans-serif`;
  const align = unityTextAlignment(typeof root.alignment === 'number' ? root.alignment : undefined);
  ctx.textAlign = align.textAlign;
  ctx.textBaseline = 'middle';

  const rawText = String(root.text ?? root.name ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n+$/g, '');
  const lines = (rawText || root.name || '').split('\n');
  const lineHeight = fontSize * (Number(root.lineSpacing) || 1.12);
  const totalHeight = Math.max(lineHeight, lines.length * lineHeight);
  const x = align.textAlign === 'left' ? 2 : align.textAlign === 'right' ? width - 2 : width / 2;
  const firstCenterY = align.vertical === 'top'
    ? lineHeight / 2
    : align.vertical === 'bottom'
      ? height - totalHeight + lineHeight / 2
      : height / 2 - totalHeight / 2 + lineHeight / 2;

  if (root.textOutline) {
    const distance = Array.isArray(root.textOutline.distance) ? root.textOutline.distance : [1, 1];
    ctx.strokeStyle = root.textOutline.color || '#000000';
    ctx.lineWidth = Math.max(1, Math.max(Math.abs(distance[0] || 0), Math.abs(distance[1] || 0)));
    ctx.lineJoin = 'round';
    lines.forEach((line: string, index: number) => ctx.strokeText(line, x, firstCenterY + index * lineHeight));
  }

  ctx.fillStyle = root.fontColor || '#ffffff';
  lines.forEach((line: string, index: number) => ctx.fillText(line, x, firstCenterY + index * lineHeight));
  return canvas.toDataURL('image/jpeg', 0.9);
}

function loadCanvasImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    let done = false;
    const finish = (value: HTMLImageElement | null) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    img.onload = () => finish(img);
    img.onerror = () => finish(null);
    img.src = src;
    window.setTimeout(() => finish(null), 900);
  });
}

async function isBlankThumbnailSource(src: string): Promise<boolean> {
  const img = await loadCanvasImage(src);
  if (!img) return true;
  const canvas = document.createElement('canvas');
  canvas.width = 24;
  canvas.height = 24;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return false;

  try {
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let min = 255;
    let max = 0;
    let sum = 0;
    let visible = 0;

    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3];
      if (alpha < 8) continue;
      const brightness = (data[i] + data[i + 1] + data[i + 2]) / 3;
      min = Math.min(min, brightness);
      max = Math.max(max, brightness);
      sum += brightness;
      visible++;
    }

    if (visible < data.length / 16) return true;
    const avg = sum / visible;
    return max - min < 4 && avg < 45;
  } catch {
    return false;
  }
}

async function isBlankThumbnailBlob(blob: Blob): Promise<boolean> {
  const url = URL.createObjectURL(blob);
  try {
    return await isBlankThumbnailSource(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function hasRenderableColor(color?: string | null): boolean {
  if (!color) return false;
  const normalized = color.trim().toLowerCase();
  return normalized !== 'transparent' && normalized !== '#00000000' && normalized !== '#ffffff00';
}

function renderPlaceholderThumbnail(label: string): string {
  const canvas = document.createElement('canvas');
  canvas.width = 160;
  canvas.height = 120;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.fillStyle = '#1e1e2e';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#45475a';
  ctx.setLineDash([6, 4]);
  ctx.strokeRect(8, 8, canvas.width - 16, canvas.height - 16);
  ctx.setLineDash([]);
  ctx.fillStyle = '#89b4fa';
  ctx.font = '700 22px "Microsoft YaHei", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const shortName = label.replace(/\.prefab$/i, '').split(/[\\/]/).pop() || 'Prefab';
  ctx.fillText(shortName.slice(0, 10), canvas.width / 2, canvas.height / 2);
  return canvas.toDataURL('image/jpeg', 0.86);
}

async function renderTemplateThumbnail(data: any, variant: ThumbnailVariant, label: string): Promise<string | null> {
  const root = data?.root;
  if (!root || variant !== 'content') return null;

  const width = Math.max(1, Math.round(root.width || 160));
  const height = Math.max(1, Math.round(root.height || 120));
  const canvas = document.createElement('canvas');
  canvas.width = Math.min(1024, width);
  canvas.height = Math.min(1024, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const context = ctx;

  const scale = Math.min(canvas.width / width, canvas.height / height);
  context.scale(scale, scale);
  context.fillStyle = '#1e1e2e';
  context.fillRect(0, 0, width, height);

  async function drawNode(node: any, ox: number, oy: number, isRoot = false) {
    if (!node || node.active === false) return;

    const x = isRoot ? 0 : ox + Number(node.x || 0);
    const y = isRoot ? 0 : oy + Number(node.y || 0);
    const w = Math.max(1, Number(node.width || 0));
    const h = Math.max(1, Number(node.height || 0));

    if (node.imagePath) {
      const img = await loadCanvasImage(node.imagePath);
      if (img) {
        context.drawImage(img, x, y, w, h);
      } else if (hasRenderableColor(node.imageColor)) {
        context.fillStyle = node.imageColor;
        context.fillRect(x, y, w, h);
      }
    } else if (node.imageHasSprite === false || node.type === 'image' || node.type === 'button') {
      if (hasRenderableColor(node.imageColor)) {
        context.fillStyle = node.imageColor;
        context.fillRect(x, y, w, h);
      }
    }

    if (node.type === 'text') {
      const rawText = String(node.text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n+$/g, '');
      if (rawText) {
        const fontSize = Math.max(1, Math.round(node.fontSize || 24));
        const fontWeight = node.fontStyle === 1 || node.fontStyle === 3 ? '700' : '400';
        context.font = `${fontWeight} ${fontSize}px "Microsoft YaHei", Arial, sans-serif`;
        const align = unityTextAlignment(typeof node.alignment === 'number' ? node.alignment : undefined);
        context.textAlign = align.textAlign;
        context.textBaseline = 'middle';

        const lines = rawText.split('\n');
        const lineSpacing = Number(node.lineSpacing);
        const lineHeight = fontSize * (Number.isFinite(lineSpacing) && lineSpacing > 0 ? lineSpacing : 1.12);
        const totalHeight = Math.max(lineHeight, lines.length * lineHeight);
        const tx = align.textAlign === 'left' ? x + 2 : align.textAlign === 'right' ? x + w - 2 : x + w / 2;
        const firstCenterY = align.vertical === 'top'
          ? y + lineHeight / 2
          : align.vertical === 'bottom'
            ? y + h - totalHeight + lineHeight / 2
            : y + h / 2 - totalHeight / 2 + lineHeight / 2;

        if (node.textOutline) {
          const distance = Array.isArray(node.textOutline.distance) ? node.textOutline.distance : [1, 1];
          context.strokeStyle = node.textOutline.color || '#000000';
          context.lineWidth = Math.max(1, Math.max(Math.abs(distance[0] || 0), Math.abs(distance[1] || 0)));
          context.lineJoin = 'round';
          lines.forEach((line: string, index: number) => context.strokeText(line, tx, firstCenterY + index * lineHeight));
        }

        context.fillStyle = node.fontColor || '#ffffff';
        lines.forEach((line: string, index: number) => context.fillText(line, tx, firstCenterY + index * lineHeight));
      }
    }

    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        await drawNode(child, x, y);
      }
    }
  }

  try {
    await drawNode(root, 0, 0, true);
    return canvas.toDataURL('image/jpeg', 0.88);
  } catch {
    return renderPlaceholderThumbnail(label);
  }
}

async function fetchPrefabData(relPath: string): Promise<any | null> {
  const name = relPath.replace(/.*\//, '').replace(/\.prefab$/i, '');
  try {
    const res = await fetch(`/api/prefabs/parse?path=${encodeURIComponent(relPath)}&name=${encodeURIComponent(name)}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function ensureFallbackThumbnail(request: ThumbRequest) {
  const key = thumbKey(request.relPath, request.variant);
  if (_fallbackThumbCache.has(key)) {
    notifyUrl(request, _fallbackThumbCache.get(key)!);
    return;
  }

  const data = await fetchPrefabData(request.relPath);
  const textDataUrl = data ? renderTextThumbnail(data, request.variant) : null;
  const renderedUrl = textDataUrl || (data ? await renderTemplateThumbnail(data, request.variant, request.relPath) : null);
  const dataUrl = renderedUrl && !(await isBlankThumbnailSource(renderedUrl))
    ? renderedUrl
    : renderPlaceholderThumbnail(request.relPath);
  if (!dataUrl) return;
  _fallbackThumbCache.set(key, dataUrl);
  notifyUrl(request, dataUrl);
}

async function processQueue() {
  if (_processing || _queue.length === 0) return;
  _processing = true;

  // 第一轮：尝试从服务器缓存获取
  const needUnity: ThumbRequest[] = [];
  for (const request of _queue) {
    const key = thumbKey(request.relPath, request.variant);
    if (_thumbCache.has(key)) { notify(request); continue; }
    try {
      const r = await fetch(thumbnailUrl(request.relPath, request.variant));
      if (r.ok) {
        const blob = await r.blob();
        if (await isBlankThumbnailBlob(blob)) {
          await ensureFallbackThumbnail(request);
          needUnity.push(request);
          continue;
        }
        const url = URL.createObjectURL(blob);
        _thumbCache.set(key, url);
        notify(request);
        continue;
      }
    } catch {}
    await ensureFallbackThumbnail(request);
    needUnity.push(request);
  }
  _queue = [];

  // 第二轮：服务器没缓存的，用 Unity 截图生成
  if (shouldDisableUnityThumbnailRender()) {
    _processing = false;
    if (_queue.length > 0) processQueue();
    return;
  }

  if (needUnity.length > 0) {
    const ready = await unityBridge.waitUntilReady(45000);
    if (!ready) {
      _queue = [...needUnity, ..._queue];
      _processing = false;
      setTimeout(processQueue, 1000);
      return;
    }
    unityBridge.setBaseUrl(window.location.origin);
    await new Promise(r => setTimeout(r, 500));

    const store = useEditorStore.getState();
    const savedTransform = {
      x: store.canvasX,
      y: store.canvasY,
      scale: store.canvasScale,
    };
    const canvasWidth = store.previewWidth;
    const canvasHeight = store.previewHeight;
    const savedJson = flattenForUnity(exportToJson(store.nodes, store.rootIds, 'UIEditorPreview', undefined, {
      previewMode: true,
      canvasWidth,
      canvasHeight,
    }));
    showOverlay();

    let interrupted = false;
    for (let index = 0; index < needUnity.length; index++) {
      const request = needUnity[index];
      try {
        const { relPath, variant } = request;
        const data = await fetchPrefabData(relPath);
        if (!data?.root) continue;

        const textDataUrl = renderTextThumbnail(data, variant);
        if (textDataUrl) {
          _thumbCache.set(thumbKey(relPath, variant), textDataUrl);
          notify(request);
          fetch(thumbnailUrl(relPath, variant), {
            method: 'POST', body: textDataUrl,
          }).catch(() => {});
          continue;
        }

        const temp = buildTempNodes(data, canvasWidth, canvasHeight);
        if (variant === 'content') {
          const root = temp.nodes[temp.rootIds[0]];
          if (root) {
            root.style = { ...root.style, backgroundColor: '#1e1e2e', backgroundOpacity: 1 };
          }
        }
        const tempJson = flattenForUnity(exportToJson(temp.nodes, temp.rootIds, '__thumb__', undefined, {
          previewMode: true,
          canvasWidth,
          canvasHeight,
        }));
        const renderSerial = unityBridge.syncFullTree(tempJson);

        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        await new Promise(r => setTimeout(r, 500));
        if (unityBridge.getSyncSerial() !== renderSerial) {
          interrupted = true;
          _queue = [request, ...needUnity.slice(index + 1), ..._queue];
          break;
        }

        const root = temp.nodes[temp.rootIds[0]];
        if (root) {
          const canvasEl = document.getElementById('unity-canvas') as HTMLCanvasElement | null;
          const rect = canvasEl?.getBoundingClientRect();
          const padding = 12;
          const cropW = variant === 'content' ? root.width : canvasWidth;
          const cropH = variant === 'content' ? root.height : canvasHeight;
          const cropX = variant === 'content' ? root.x : 0;
          const cropY = variant === 'content' ? root.y : 0;
          if (rect && rect.width > padding * 2 && rect.height > padding * 2 && cropW > 0 && cropH > 0) {
            const fitScale = Math.min(1, (rect.width - padding * 2) / cropW, (rect.height - padding * 2) / cropH);
            useEditorStore.getState().setCanvasTransform(
              Math.round((padding - cropX * fitScale) * 100) / 100,
              Math.round((padding - cropY * fitScale) * 100) / 100,
              Math.max(0.1, fitScale),
            );
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
            await new Promise(r => setTimeout(r, 120));
            if (unityBridge.getSyncSerial() !== renderSerial) {
              interrupted = true;
              _queue = [request, ...needUnity.slice(index + 1), ..._queue];
              break;
            }
          }
        }
        const dataUrl = unityBridge.captureCanvas({
          fullCanvas: true,
          cropRect: variant === 'content' && root ? {
            x: root.x,
            y: root.y,
            width: root.width,
            height: root.height,
          } : undefined,
        });
        if (dataUrl && unityBridge.getSyncSerial() === renderSerial && !(await isBlankThumbnailSource(dataUrl))) {
          _thumbCache.set(thumbKey(relPath, variant), dataUrl);
          notify(request);
          // 上传到服务器缓存（fire & forget）
          fetch(thumbnailUrl(relPath, variant), {
            method: 'POST', body: dataUrl,
          }).catch(() => {});
        }
      } catch (e) { console.error('[thumb]', e); }
    }

    if (!interrupted) {
      unityBridge.syncFullTree(savedJson);
      useEditorStore.getState().setCanvasTransform(savedTransform.x, savedTransform.y, savedTransform.scale);
    }
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    hideOverlay();
  }

  _processing = false;
  // 处理期间可能有新请求入队
  if (_queue.length > 0) processQueue();
}

function notify(request: ThumbRequest) {
  const key = thumbKey(request.relPath, request.variant);
  const url = _thumbCache.get(key);
  if (!url) return;
  notifyUrl(request, url);
}

function notifyUrl(request: ThumbRequest, url: string) {
  const key = thumbKey(request.relPath, request.variant);
  _listeners.get(key)?.forEach(cb => cb(url));
}

function requestThumb(relPath: string, variant: ThumbnailVariant, cb: (url: string) => void) {
  const key = thumbKey(relPath, variant);
  const cached = _thumbCache.get(key);
  if (cached) { cb(cached); return; }
  const fallback = _fallbackThumbCache.get(key);
  if (fallback) cb(fallback);
  if (!_listeners.has(key)) _listeners.set(key, new Set());
  _listeners.get(key)!.add(cb);
  if (!_queue.some((item) => thumbKey(item.relPath, item.variant) === key)) {
    _queue.push({ relPath, variant });
  }
  processQueue();
}

function cancelThumb(relPath: string, variant: ThumbnailVariant, cb: (url: string) => void) {
  _listeners.get(thumbKey(relPath, variant))?.delete(cb);
}

export function clearPrefabThumbnailMemoryCache() {
  for (const url of _thumbCache.values()) {
    if (url.startsWith('blob:')) URL.revokeObjectURL(url);
  }
  _thumbCache.clear();
  _fallbackThumbCache.clear();
  _queue = [];
}

interface PrefabThumbnailProps {
  relPath: string;
  alt?: string;
  className?: string;
  imageClassName?: string;
  size?: number | 'fill';
  hoverPreview?: boolean;
  hoverSize?: number;
  variant?: ThumbnailVariant;
}

export function PrefabThumbnail({
  relPath,
  alt = '',
  className = '',
  imageClassName = '',
  size = 28,
  hoverPreview = true,
  hoverSize = 300,
  variant = 'canvas',
}: PrefabThumbnailProps) {
  const [src, setSrc] = useState(() => _thumbCache.get(thumbKey(relPath, variant)) || _fallbackThumbCache.get(thumbKey(relPath, variant)) || '');
  const [hover, setHover] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const divRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const key = thumbKey(relPath, variant);
    setSrc(_thumbCache.get(key) || _fallbackThumbCache.get(key) || '');
  }, [relPath, variant]);

  useEffect(() => {
    if (_thumbCache.has(thumbKey(relPath, variant))) return;
    const el = divRef.current;
    if (!el) return;
    const cb = (url: string) => setSrc(url);
    const obs = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      obs.disconnect();
      requestThumb(relPath, variant, cb);
    }, { rootMargin: '200px' });
    obs.observe(el);
    return () => { obs.disconnect(); cancelThumb(relPath, variant, cb); };
  }, [relPath, variant]);

  const handleMouseEnter = () => {
    if (!hoverPreview || !src || !divRef.current) return;
    const rect = divRef.current.getBoundingClientRect();
    setPos({ x: rect.right + 8, y: rect.top });
    setHover(true);
  };

  const sizeStyle = size === 'fill'
    ? undefined
    : { width: size, height: size };

  return (
    <div
      ref={divRef}
      className={`shrink-0 rounded overflow-hidden bg-[#313244] flex items-center justify-center ${className}`}
      style={sizeStyle}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={() => setHover(false)}
    >
      {src ? (
        <img src={src} alt={alt} className={`w-full h-full object-contain ${imageClassName}`} />
      ) : (
        <div className="w-4 h-4 rounded-full border border-[#6c7086] border-t-[#89b4fa] animate-spin" />
      )}
      {hover && src && hoverPreview && (
        <div style={{
          position: 'fixed', left: pos.x, top: Math.min(pos.y, window.innerHeight - hoverSize - 20),
          zIndex: 9999, pointerEvents: 'none',
        }}>
          <div style={{
            width: hoverSize, height: hoverSize, background: '#1e1e2e', border: '1px solid #45475a',
            borderRadius: 6, padding: 4, boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
          }}>
            <img src={src} alt={alt} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
          </div>
        </div>
      )}
    </div>
  );
}

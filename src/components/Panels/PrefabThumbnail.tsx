import { useEffect, useRef, useState } from 'react';
import { ASSET_PATHS } from '../../config/assetPaths';
import editorBridgeClient from '../../services/EditorBridgeClient';
import type { BboxRecord, ComponentRecord, NodeRecord, SnapshotRecord } from '../../services/EditorBridgeClient';

type ThumbnailVariant = 'canvas' | 'content';

interface ThumbRequest {
  relPath: string;
  variant: ThumbnailVariant;
}

const THUMBNAIL_SIZE = 256;
const _thumbCache = new Map<string, string>();
const _listeners = new Map<string, Set<(url: string) => void>>();
let _queue: ThumbRequest[] = [];
let _processing = false;

function thumbKey(relPath: string, variant: ThumbnailVariant) {
  return `${variant}:${normalizeThumbnailRelPath(relPath)}`;
}

function thumbnailUrl(relPath: string, variant: ThumbnailVariant) {
  const params = new URLSearchParams({ path: normalizeThumbnailRelPath(relPath) });
  if (variant !== 'canvas') params.set('variant', variant);
  return `/api/prefabs/thumbnail?${params.toString()}`;
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+/, '');
}

function isTemporaryPrefabPath(path: string): boolean {
  const normalized = normalizeSlashes(path);
  return normalized.startsWith('Assets/Temp/UIEditorNew/') ||
    normalized.startsWith('Temp/UIEditorNew/') ||
    normalized.includes('/Assets/Temp/UIEditorNew/') ||
    normalized.includes('/Temp/UIEditorNew/');
}

export function normalizeThumbnailRelPath(path: string): string {
  const normalized = normalizeSlashes(path.trim());
  const prefabRoot = normalizeSlashes(ASSET_PATHS.prefab);
  if (normalized.startsWith(`${prefabRoot}/`)) return normalized.slice(prefabRoot.length + 1);
  return normalized.replace(/^Assets\/HotRes2\/UIs\/Prefabs\//, '');
}

function toUnityPrefabPath(relPath: string): string {
  const normalized = normalizeSlashes(relPath.trim());
  if (normalized.startsWith('Assets/')) return normalized;
  return `${ASSET_PATHS.prefab}/${normalizeThumbnailRelPath(normalized)}`.replace(/\\/g, '/');
}

function setCachedUrl(key: string, url: string) {
  const previous = _thumbCache.get(key);
  if (previous?.startsWith('blob:')) URL.revokeObjectURL(previous);
  _thumbCache.set(key, url);
}

function notifyKey(key: string, url: string) {
  _listeners.get(key)?.forEach((cb) => cb(url));
}

function placeholderDataUrl(label: string): string {
  const canvas = document.createElement('canvas');
  canvas.width = THUMBNAIL_SIZE;
  canvas.height = THUMBNAIL_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.fillStyle = '#1e1e2e';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = '#45475a';
  ctx.setLineDash([6, 5]);
  ctx.strokeRect(14, 14, canvas.width - 28, canvas.height - 28);
  ctx.setLineDash([]);
  ctx.fillStyle = '#89b4fa';
  ctx.font = '700 28px "Microsoft YaHei", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const name = normalizeThumbnailRelPath(label).replace(/\.prefab$/i, '').split('/').pop() || 'Prefab';
  ctx.fillText(name.slice(0, 10), canvas.width / 2, canvas.height / 2);
  return canvas.toDataURL('image/jpeg', 0.88);
}

async function blobToImage(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  try {
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('thumbnail image failed to load'));
      img.src = url;
    });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

async function snapshotImage(snapshot: SnapshotRecord): Promise<HTMLImageElement> {
  if (snapshot.image.dataUrl) {
    const res = await fetch(snapshot.image.dataUrl);
    return blobToImage(await res.blob());
  }
  const url = await editorBridgeClient.snapshotUrl(snapshot);
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`snapshot fetch failed: ${res.status}`);
  return blobToImage(await res.blob());
}

function usableBboxes(snapshot: SnapshotRecord): BboxRecord[] {
  const boxes = (snapshot.bboxes ?? []).filter((box) => (
    box.activeInHierarchy &&
    box.width > 1 &&
    box.height > 1 &&
    Number.isFinite(box.x) &&
    Number.isFinite(box.y) &&
    Number.isFinite(box.width) &&
    Number.isFinite(box.height)
  ));
  if (boxes.length <= 1) return boxes;
  return boxes.filter((box) => {
    const nearFullWidth = box.width >= snapshot.width * 0.96;
    const nearFullHeight = box.height >= snapshot.height * 0.96;
    return !(nearFullWidth && nearFullHeight);
  });
}

function colorAlpha(summary: ComponentRecord['summary'] | undefined): number {
  const color = typeof summary?.color === 'string' ? summary.color.trim() : '';
  if (/^#[0-9a-fA-F]{8}$/.test(color)) return parseInt(color.slice(7, 9), 16) / 255;
  return 1;
}

function nonEmptyText(summary: ComponentRecord['summary'] | undefined): boolean {
  const text = typeof summary?.text === 'string' ? summary.text : '';
  return text.trim().length > 0;
}

function hasVisualComponent(node: NodeRecord | undefined): boolean {
  if (!node) return false;
  return node.components.some((component) => {
    if (!component.enabled) return false;
    const type = component.type.toLowerCase();
    if (colorAlpha(component.summary) <= 0.01) return false;
    return type === 'image' ||
      type === 'rawimage' ||
      ((type === 'text' || type.includes('textmeshpro')) && nonEmptyText(component.summary)) ||
      type === 'outline' ||
      type === 'shadow';
  });
}

function visualBboxes(snapshot: SnapshotRecord, nodes: NodeRecord[] | undefined): BboxRecord[] {
  const boxes = usableBboxes(snapshot);
  if (!nodes || nodes.length === 0) return boxes;
  const nodeById = new Map(nodes.map((node) => [node.nodeId, node]));
  const visual = boxes.filter((box) => hasVisualComponent(nodeById.get(box.nodeId)));
  return visual.length > 0 ? visual : boxes;
}

function cropForSnapshot(snapshot: SnapshotRecord, variant: ThumbnailVariant, nodes?: NodeRecord[]) {
  const boxes = variant === 'canvas' ? usableBboxes(snapshot) : visualBboxes(snapshot, nodes);
  if (variant === 'canvas' || boxes.length === 0) {
    return { x: 0, y: 0, width: snapshot.width, height: snapshot.height };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const box of boxes) {
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.width);
    maxY = Math.max(maxY, box.y + box.height);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return { x: 0, y: 0, width: snapshot.width, height: snapshot.height };
  }

  const contentW = Math.max(1, maxX - minX);
  const contentH = Math.max(1, maxY - minY);
  const padding = Math.max(8, Math.min(32, Math.max(contentW, contentH) * 0.08));
  const x = Math.max(0, Math.floor(minX - padding));
  const y = Math.max(0, Math.floor(minY - padding));
  const right = Math.min(snapshot.width, Math.ceil(maxX + padding));
  const bottom = Math.min(snapshot.height, Math.ceil(maxY + padding));
  return expandCropToSquare({
    x,
    y,
    width: Math.max(1, right - x),
    height: Math.max(1, bottom - y),
  }, snapshot.width, snapshot.height);
}

function expandCropToSquare(
  crop: { x: number; y: number; width: number; height: number },
  maxWidth: number,
  maxHeight: number,
) {
  const side = Math.min(Math.max(crop.width, crop.height), Math.max(maxWidth, maxHeight));
  const centerX = crop.x + crop.width / 2;
  const centerY = crop.y + crop.height / 2;
  let x = Math.round(centerX - side / 2);
  let y = Math.round(centerY - side / 2);
  let width = side;
  let height = side;

  if (width > maxWidth) {
    width = maxWidth;
    x = 0;
  } else {
    x = Math.max(0, Math.min(maxWidth - width, x));
  }

  if (height > maxHeight) {
    height = maxHeight;
    y = 0;
  } else {
    y = Math.max(0, Math.min(maxHeight - height, y));
  }

  return {
    x,
    y,
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
  };
}

function renderCroppedThumbnail(img: HTMLImageElement, snapshot: SnapshotRecord, variant: ThumbnailVariant, nodes?: NodeRecord[]): string {
  const crop = cropForSnapshot(snapshot, variant, nodes);
  const canvas = document.createElement('canvas');
  canvas.width = THUMBNAIL_SIZE;
  canvas.height = THUMBNAIL_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';

  ctx.fillStyle = '#1e1e2e';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const scale = Math.min(canvas.width / crop.width, canvas.height / crop.height);
  const drawW = Math.max(1, Math.round(crop.width * scale));
  const drawH = Math.max(1, Math.round(crop.height * scale));
  const dx = Math.round((canvas.width - drawW) / 2);
  const dy = Math.round((canvas.height - drawH) / 2);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, crop.x, crop.y, crop.width, crop.height, dx, dy, drawW, drawH);
  return canvas.toDataURL('image/jpeg', 0.9);
}

async function uploadThumbnail(relPath: string, variant: ThumbnailVariant, dataUrl: string) {
  await fetch(thumbnailUrl(relPath, variant), {
    method: 'POST',
    body: dataUrl,
  });
}

async function readCachedThumbnail(request: ThumbRequest): Promise<string | null> {
  try {
    const response = await fetch(thumbnailUrl(request.relPath, request.variant), { cache: 'no-store' });
    if (!response.ok) return null;
    const url = URL.createObjectURL(await response.blob());
    return url;
  } catch {
    return null;
  }
}

async function renderOfficialPrefabThumbnail(relPath: string, variant: ThumbnailVariant): Promise<string> {
  if (isTemporaryPrefabPath(relPath)) {
    throw new Error('temporary prefabs are not valid thumbnail sources');
  }
  const open = await editorBridgeClient.openPrefab(toUnityPrefabPath(relPath), 'readonly');
  try {
    const [tree, rendered] = await Promise.all([
      editorBridgeClient.exportNodeTree(open.session.sessionId).catch(() => null),
      editorBridgeClient.renderSnapshot(open.session.sessionId, undefined, { profile: false }),
    ]);
    const img = await snapshotImage(rendered.snapshot);
    return renderCroppedThumbnail(img, rendered.snapshot, variant, tree?.nodes) || placeholderDataUrl(relPath);
  } finally {
    await editorBridgeClient.closePrefab(open.session.sessionId, false).catch(() => undefined);
  }
}

async function processQueue() {
  if (_processing || _queue.length === 0) return;
  _processing = true;
  const requests = _queue;
  _queue = [];

  for (const request of requests) {
    const relPath = normalizeThumbnailRelPath(request.relPath);
    const key = thumbKey(relPath, request.variant);
    if (_thumbCache.has(key)) {
      notifyKey(key, _thumbCache.get(key)!);
      continue;
    }

    const cached = await readCachedThumbnail({ relPath, variant: request.variant });
    if (cached) {
      setCachedUrl(key, cached);
      notifyKey(key, cached);
      continue;
    }

    try {
      const dataUrl = await renderOfficialPrefabThumbnail(relPath, request.variant);
      setCachedUrl(key, dataUrl);
      notifyKey(key, dataUrl);
      await uploadThumbnail(relPath, request.variant, dataUrl).catch(() => undefined);
    } catch (err) {
      console.warn('[bridge-thumb] failed to render thumbnail', relPath, err);
      const fallback = placeholderDataUrl(relPath);
      if (fallback) {
        setCachedUrl(key, fallback);
        notifyKey(key, fallback);
      }
    }
  }

  _processing = false;
  if (_queue.length > 0) void processQueue();
}

function requestThumb(relPath: string, variant: ThumbnailVariant, cb: (url: string) => void) {
  const normalized = normalizeThumbnailRelPath(relPath);
  if (isTemporaryPrefabPath(relPath)) {
    cb(placeholderDataUrl(normalized));
    return;
  }
  const key = thumbKey(normalized, variant);
  const cached = _thumbCache.get(key);
  if (cached) {
    cb(cached);
    return;
  }
  if (!_listeners.has(key)) _listeners.set(key, new Set());
  _listeners.get(key)!.add(cb);
  if (!_queue.some((item) => thumbKey(item.relPath, item.variant) === key)) {
    _queue.push({ relPath: normalized, variant });
  }
  void processQueue();
}

function cancelThumb(relPath: string, variant: ThumbnailVariant, cb: (url: string) => void) {
  _listeners.get(thumbKey(relPath, variant))?.delete(cb);
}

export function clearPrefabThumbnailMemoryCache() {
  for (const url of _thumbCache.values()) {
    if (url.startsWith('blob:')) URL.revokeObjectURL(url);
  }
  _thumbCache.clear();
  _queue = [];
}

export async function refreshPrefabThumbnailFromBridge(prefabPath: string, variants: ThumbnailVariant[] = ['content', 'canvas']) {
  if (isTemporaryPrefabPath(prefabPath)) {
    console.warn('[bridge-thumb] skip temporary prefab thumbnail refresh', prefabPath);
    return;
  }
  const relPath = normalizeThumbnailRelPath(prefabPath);
  for (const variant of variants) {
    const key = thumbKey(relPath, variant);
    const dataUrl = await renderOfficialPrefabThumbnail(relPath, variant);
    setCachedUrl(key, dataUrl);
    notifyKey(key, dataUrl);
    await uploadThumbnail(relPath, variant, dataUrl).catch(() => undefined);
  }
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
  variant = 'content',
}: PrefabThumbnailProps) {
  const normalized = normalizeThumbnailRelPath(relPath);
  const [src, setSrc] = useState(() => _thumbCache.get(thumbKey(normalized, variant)) || '');
  const [hover, setHover] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const divRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSrc(_thumbCache.get(thumbKey(normalized, variant)) || '');
  }, [normalized, variant]);

  useEffect(() => {
    const el = divRef.current;
    if (!el) return;
    const cb = (url: string) => setSrc(url);
    const obs = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      obs.disconnect();
      requestThumb(normalized, variant, cb);
    }, { rootMargin: '200px' });
    obs.observe(el);
    return () => {
      obs.disconnect();
      cancelThumb(normalized, variant, cb);
    };
  }, [normalized, variant]);

  const handleMouseEnter = () => {
    if (!hoverPreview || !src || !divRef.current) return;
    const rect = divRef.current.getBoundingClientRect();
    setPos({ x: rect.right + 8, y: rect.top });
    setHover(true);
  };

  const sizeStyle = size === 'fill' ? undefined : { width: size, height: size };

  return (
    <div
      ref={divRef}
      className={`shrink-0 overflow-hidden rounded bg-[#313244] flex items-center justify-center ${className}`}
      style={sizeStyle}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={() => setHover(false)}
    >
      {src ? (
        <img src={src} alt={alt} className={`h-full w-full object-contain ${imageClassName}`} />
      ) : (
        <div className="h-4 w-4 animate-spin rounded-full border border-[#6c7086] border-t-[#89b4fa]" />
      )}
      {hover && src && hoverPreview && (
        <div
          style={{
            position: 'fixed',
            left: pos.x,
            top: Math.min(pos.y, window.innerHeight - hoverSize - 20),
            zIndex: 9999,
            pointerEvents: 'none',
          }}
        >
          <div
            style={{
              width: hoverSize,
              height: hoverSize,
              background: '#1e1e2e',
              border: '1px solid #45475a',
              borderRadius: 6,
              padding: 4,
              boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
            }}
          >
            <img src={src} alt={alt} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
          </div>
        </div>
      )}
    </div>
  );
}

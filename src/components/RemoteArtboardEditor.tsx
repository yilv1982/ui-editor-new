import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import editorBridgeClient, {
  type ArtboardStateResponse,
  type BboxRecord,
  type ComponentRecord,
  type HealthResponse,
  type NodeRecord,
  type OperationProfile,
  type SessionInfo,
  type SnapshotRecord,
} from '../services/EditorBridgeClient';
import { refreshPrefabThumbnailFromBridge } from './Panels/PrefabThumbnail';

const SNAPSHOT_WIDTH = 1080;
const SNAPSHOT_HEIGHT = 1920;
const STORAGE_KEY = 'uieditor_new_remote_artboards_v1';
const DEFAULT_SAVE_ROOT = 'Assets/HotRes2/UIs/Prefabs';
const SNAPSHOT_REFRESH_DELAY_MS = 60;

interface PrefabListItem {
  name: string;
  relPath: string;
  category?: string;
}

interface PersistedArtboard {
  id: string;
  name: string;
  sessionId: string;
  sourcePrefabPath: string | null;
  workingPrefabPath: string;
  targetPrefabPath: string;
  selectedNodeId: string | null;
  dirty: boolean;
}

interface RuntimeArtboard extends PersistedArtboard {
  revision: string;
  rootNodeId: string | null;
  nodes: NodeRecord[];
  snapshot: SnapshotRecord | null;
  snapshotUrl: string | null;
  undoAvailable: boolean;
  redoAvailable: boolean;
}

interface DraftState {
  x: string;
  y: string;
  width: string;
  height: string;
  text: string;
  fontSize: string;
  textColor: string;
  spritePath: string;
  visible: boolean;
}

interface DragState {
  nodeId: string;
  startClientX: number;
  startClientY: number;
  startX: number;
  startY: number;
  deltaX: number;
  deltaY: number;
}

interface VisualPerfTrace {
  id: number;
  label: string;
  start: number;
  last: number;
}

type VisualPerfLogEntry = Record<string, unknown>;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function compactPath(path: string | null | undefined): string {
  if (!path) return '-';
  if (path.length <= 42) return path;
  return `.../${path.split('/').slice(-3).join('/')}`;
}

function prefabNameFromPath(path: string): string {
  const base = path.split(/[\\/]/).pop() || path;
  return base.replace(/\.prefab$/i, '');
}

function normalizeTargetPath(value: string): string {
  let path = value.replace(/\\/g, '/').trim();
  if (!path) return '';
  if (!path.startsWith('Assets/')) path = `${DEFAULT_SAVE_ROOT}/${path.replace(/^\/+/, '')}`;
  if (!path.endsWith('.prefab')) path += '.prefab';
  return path;
}

function pickBboxAtPoint(bboxes: BboxRecord[], x: number, y: number): BboxRecord | null {
  for (let i = bboxes.length - 1; i >= 0; i -= 1) {
    const box = bboxes[i];
    if (!box.activeInHierarchy || box.width <= 1 || box.height <= 1) continue;
    if (x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height) return box;
  }
  return null;
}

function findComponent(node: NodeRecord | undefined, type: string) {
  return node?.components.find((component) => component.type === type);
}

function summaryString(node: NodeRecord | undefined, type: string, key: string): string {
  const value = findComponent(node, type)?.summary?.[key];
  return typeof value === 'string' ? value : '';
}

function summaryNumber(node: NodeRecord | undefined, type: string, key: string): string {
  const value = findComponent(node, type)?.summary?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
}

function colorInput(value: string): string {
  return value?.startsWith('#') && value.length >= 7 ? value.slice(0, 7) : '#ffffff';
}

function opaqueColor(value: string): string {
  return value.startsWith('#') && value.length === 7 ? `${value}FF` : value;
}

function defaultTargetFor(name: string): string {
  return `${DEFAULT_SAVE_ROOT}/${name || 'NewUI'}.prefab`;
}

function hasSnapshotImage(snapshot: SnapshotRecord | null | undefined): snapshot is SnapshotRecord {
  const image = snapshot?.image;
  return !!(image?.url || image?.dataUrl || image?.path);
}

function summarizeBridgeProfile(profile: OperationProfile | null | undefined) {
  if (!profile) return null;
  return {
    totalMs: Math.round(profile.totalMs * 10) / 10,
    entries: (profile.entries ?? []).map((entry) => ({
      name: entry.name,
      ms: Math.round(entry.ms * 10) / 10,
    })),
  };
}

function snapshotResourceTiming(url: string) {
  const entries = performance.getEntriesByName(url);
  const entry = entries.length > 0 ? entries[entries.length - 1] as PerformanceResourceTiming : null;
  if (!entry) return null;
  return {
    durationMs: Math.round(entry.duration * 10) / 10,
    responseMs: Math.round((entry.responseEnd - entry.responseStart) * 10) / 10,
    transferSize: entry.transferSize,
    encodedBodySize: entry.encodedBodySize,
  };
}

function writeVisualPerfLog(entry: VisualPerfLogEntry) {
  (globalThis as typeof globalThis & { __uieditorNewPerfStoresLogs?: boolean }).__uieditorNewPerfStoresLogs = true;
  console.info('[UIEditorNewPerf]', entry);
  try {
    const key = 'uieditor_new_perf_logs';
    const logs = JSON.parse(sessionStorage.getItem(key) || '[]') as VisualPerfLogEntry[];
    logs.push(entry);
    sessionStorage.setItem(key, JSON.stringify(logs.slice(-500)));
  } catch {
    // Perf logs are diagnostic only. Editing must never fail because storage is unavailable.
  }
  void editorBridgeClient.getBaseUrl()
    .then((baseUrl) => fetch(`${baseUrl}/perf-log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry),
      keepalive: true,
    }))
    .catch(() => undefined);
}

function serialize(artboards: RuntimeArtboard[]): PersistedArtboard[] {
  return artboards
    .filter((artboard) => artboard.workingPrefabPath)
    .map((artboard) => ({
      id: artboard.id,
      name: artboard.name,
      sessionId: artboard.sessionId,
      sourcePrefabPath: artboard.sourcePrefabPath,
      workingPrefabPath: artboard.workingPrefabPath,
      targetPrefabPath: artboard.targetPrefabPath,
      selectedNodeId: artboard.selectedNodeId,
      dirty: artboard.dirty,
    }));
}

function findVisibleNode(snapshot: SnapshotRecord | null, rootNodeId: string | null): string | null {
  const visible = snapshot?.bboxes.find((box) => (
    box.activeInHierarchy &&
    box.width > 4 &&
    box.height > 4 &&
    box.width < SNAPSHOT_WIDTH * 0.98 &&
    box.height < SNAPSHOT_HEIGHT * 0.98
  ));
  return visible?.nodeId ?? rootNodeId;
}

function replaceNode(artboard: RuntimeArtboard, nodeId: string, mapper: (node: NodeRecord) => NodeRecord): RuntimeArtboard {
  let changed = false;
  const nodes = artboard.nodes.map((node) => {
    if (node.nodeId !== nodeId) return node;
    changed = true;
    return mapper(node);
  });
  return changed ? { ...artboard, nodes, dirty: true } : { ...artboard, dirty: true };
}

function patchSnapshotBbox(artboard: RuntimeArtboard, nodeId: string, mapper: (box: BboxRecord) => BboxRecord): RuntimeArtboard {
  if (!artboard.snapshot) return artboard;
  const bboxes = artboard.snapshot.bboxes.map((box) => (box.nodeId === nodeId ? mapper(box) : box));
  return {
    ...artboard,
    snapshot: { ...artboard.snapshot, bboxes },
  };
}

function patchComponentSummary(component: ComponentRecord, patch: Record<string, string | number | boolean>): ComponentRecord {
  return {
    ...component,
    summary: {
      ...(component.summary ?? {}),
      ...patch,
    },
  };
}

function optimisticMove(artboard: RuntimeArtboard, nodeId: string, x: number, y: number): RuntimeArtboard {
  const node = artboard.nodes.find((item) => item.nodeId === nodeId);
  const oldX = node?.rectTransform?.anchoredPosition?.[0] ?? x;
  const oldY = node?.rectTransform?.anchoredPosition?.[1] ?? y;
  const moved = replaceNode(artboard, nodeId, (item) => item.rectTransform ? {
    ...item,
    rectTransform: {
      ...item.rectTransform,
      anchoredPosition: [x, y],
    },
  } : item);
  return patchSnapshotBbox(moved, nodeId, (box) => ({
    ...box,
    x: box.x + (x - oldX),
    y: box.y - (y - oldY),
  }));
}

function optimisticResize(artboard: RuntimeArtboard, nodeId: string, width: number, height: number): RuntimeArtboard {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const node = artboard.nodes.find((item) => item.nodeId === nodeId);
  const oldWidth = node?.rectTransform?.sizeDelta?.[0] ?? safeWidth;
  const oldHeight = node?.rectTransform?.sizeDelta?.[1] ?? safeHeight;
  const pivotX = node?.rectTransform?.pivot?.[0] ?? 0.5;
  const pivotY = node?.rectTransform?.pivot?.[1] ?? 0.5;
  const resized = replaceNode(artboard, nodeId, (item) => item.rectTransform ? {
    ...item,
    rectTransform: {
      ...item.rectTransform,
      sizeDelta: [safeWidth, safeHeight],
    },
  } : item);
  return patchSnapshotBbox(resized, nodeId, (box) => ({
    ...box,
    x: box.x - (safeWidth - oldWidth) * pivotX,
    y: box.y - (safeHeight - oldHeight) * (1 - pivotY),
    width: safeWidth,
    height: safeHeight,
  }));
}

function optimisticVisible(artboard: RuntimeArtboard, nodeId: string, visible: boolean): RuntimeArtboard {
  const next = replaceNode(artboard, nodeId, (node) => ({
    ...node,
    activeSelf: visible,
    activeInHierarchy: visible,
  }));
  return patchSnapshotBbox(next, nodeId, (box) => ({ ...box, activeInHierarchy: visible }));
}

function optimisticText(artboard: RuntimeArtboard, nodeId: string, text: string): RuntimeArtboard {
  return replaceNode(artboard, nodeId, (node) => ({
    ...node,
    components: node.components.map((component) => (
      component.type === 'Text' ? patchComponentSummary(component, { text }) : component
    )),
  }));
}

function optimisticTextStyle(artboard: RuntimeArtboard, nodeId: string, params: { fontSize?: number; color?: string }): RuntimeArtboard {
  const patch: Record<string, string | number | boolean> = {};
  if (typeof params.fontSize === 'number' && Number.isFinite(params.fontSize)) patch.fontSize = params.fontSize;
  if (params.color) patch.color = params.color;
  return replaceNode(artboard, nodeId, (node) => ({
    ...node,
    components: node.components.map((component) => (
      component.type === 'Text' ? patchComponentSummary(component, patch) : component
    )),
  }));
}

function optimisticImage(artboard: RuntimeArtboard, nodeId: string, spritePath: string): RuntimeArtboard {
  return replaceNode(artboard, nodeId, (node) => ({
    ...node,
    components: node.components.map((component) => (
      component.type === 'Image' ? patchComponentSummary(component, { spritePath }) : component
    )),
  }));
}

function optimisticDelete(artboard: RuntimeArtboard, nodeId: string): RuntimeArtboard {
  const nodeById = new Map(artboard.nodes.map((node) => [node.nodeId, node]));
  const removed = new Set<string>();
  const visit = (id: string) => {
    if (removed.has(id)) return;
    removed.add(id);
    nodeById.get(id)?.children.forEach(visit);
  };
  visit(nodeId);
  const deletedNode = nodeById.get(nodeId);
  const nodes = artboard.nodes
    .filter((node) => !removed.has(node.nodeId))
    .map((node) => ({ ...node, children: node.children.filter((childId) => !removed.has(childId)) }));
  const snapshot = artboard.snapshot
    ? { ...artboard.snapshot, bboxes: artboard.snapshot.bboxes.filter((box) => !removed.has(box.nodeId)) }
    : artboard.snapshot;
  return {
    ...artboard,
    nodes,
    snapshot,
    dirty: true,
    selectedNodeId: deletedNode?.parentId ?? artboard.rootNodeId,
  };
}

export default function RemoteArtboardEditor() {
  const frameRef = useRef<HTMLDivElement>(null);
  const bootStartedRef = useRef(false);
  const operationSeq = useRef(0);
  const artboardsRef = useRef<RuntimeArtboard[]>([]);
  const activeIdRef = useRef<string | null>(null);
  const operationQueueRef = useRef<Promise<void>>(Promise.resolve());
  const snapshotRefreshTimerRef = useRef<number | null>(null);
  const snapshotRefreshSeq = useRef(0);
  const dragInFlight = useRef(false);
  const lastDragSendAt = useRef(0);
  const perfSeq = useRef(0);
  const pendingImagePerfByUrl = useRef(new Map<string, VisualPerfTrace>());

  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [prefabs, setPrefabs] = useState<PrefabListItem[]>([]);
  const [search, setSearch] = useState('');
  const [artboards, setArtboards] = useState<RuntimeArtboard[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [syncingCount, setSyncingCount] = useState(0);
  const [status, setStatus] = useState('正在连接 Unity Editor Bridge...');
  const [error, setError] = useState<string | null>(null);
  const [frameRect, setFrameRect] = useState({ width: 0, height: 0 });
  const [drag, setDrag] = useState<DragState | null>(null);
  const [draft, setDraft] = useState<DraftState>({
    x: '',
    y: '',
    width: '',
    height: '',
    text: '',
    fontSize: '',
    textColor: '#ffffff',
    spritePath: '',
    visible: true,
  });

  const activeArtboard = useMemo(
    () => artboards.find((artboard) => artboard.id === activeId) ?? artboards[0] ?? null,
    [activeId, artboards],
  );
  const nodeById = useMemo(() => new Map(activeArtboard?.nodes.map((node) => [node.nodeId, node]) ?? []), [activeArtboard]);
  const selectedNode = activeArtboard?.selectedNodeId ? nodeById.get(activeArtboard.selectedNodeId) : undefined;
  const activeBboxes = useMemo(
    () => activeArtboard?.snapshot?.bboxes.filter((box) => box.activeInHierarchy && box.width > 1 && box.height > 1) ?? [],
    [activeArtboard],
  );
  const displayScale = useMemo(() => {
    if (frameRect.width <= 0 || frameRect.height <= 0) return 0.4;
    return Math.min(frameRect.width / SNAPSHOT_WIDTH, frameRect.height / SNAPSHOT_HEIGHT, 1.1);
  }, [frameRect]);
  const filteredPrefabs = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    const list = keyword
      ? prefabs.filter((item) => item.name.toLowerCase().includes(keyword) || item.relPath.toLowerCase().includes(keyword))
      : prefabs;
    return list.slice(0, 160);
  }, [prefabs, search]);

  function startVisualPerf(label: string): VisualPerfTrace {
    const now = performance.now();
    const trace = { id: ++perfSeq.current, label, start: now, last: now };
    writeVisualPerfLog({
      id: trace.id,
      label: trace.label,
      stage: 'operationStart',
      totalMs: 0,
      deltaMs: 0,
    });
    return trace;
  }

  function markVisualPerf(trace: VisualPerfTrace | null | undefined, stage: string, extra?: Record<string, unknown>) {
    if (!trace) return;
    const now = performance.now();
    writeVisualPerfLog({
      id: trace.id,
      label: trace.label,
      stage,
      totalMs: Math.round((now - trace.start) * 10) / 10,
      deltaMs: Math.round((now - trace.last) * 10) / 10,
      ...(extra ?? {}),
    });
    trace.last = now;
  }

  useEffect(() => {
    artboardsRef.current = artboards;
  }, [artboards]);

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  useEffect(() => () => {
    if (snapshotRefreshTimerRef.current !== null) {
      window.clearTimeout(snapshotRefreshTimerRef.current);
    }
  }, []);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const update = () => {
      const rect = frame.getBoundingClientRect();
      setFrameRect({ width: Math.max(0, rect.width - 48), height: Math.max(0, rect.height - 48) });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (bootStartedRef.current) return;
    bootStartedRef.current = true;
    let cancelled = false;
    async function boot() {
      try {
        const bridgeHealth = await editorBridgeClient.health();
        if (cancelled) return;
        setHealth(bridgeHealth);
        setStatus(`Bridge ${bridgeHealth.version} 已连接`);
        const restored = await restoreArtboards();
        if (!cancelled && restored.length === 0) {
          await createBlankArtboard('NewUI');
        }
      } catch (err) {
        if (!cancelled) {
          setError(errorText(err));
          setStatus('Unity Editor Bridge 未连接');
        }
      }
    }
    void boot();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/prefabs/list')
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        const list = (data.prefabs || data || []) as PrefabListItem[];
        setPrefabs(list.filter((item) => item.relPath));
      })
      .catch(() => setPrefabs([]));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (artboards.length === 0) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ activeId, artboards: serialize(artboards) }));
  }, [activeId, artboards]);

  useEffect(() => {
    const rect = selectedNode?.rectTransform;
    setDraft({
      x: rect?.anchoredPosition?.length ? String(Math.round(rect.anchoredPosition[0])) : '',
      y: rect?.anchoredPosition?.length ? String(Math.round(rect.anchoredPosition[1])) : '',
      width: rect?.sizeDelta?.length ? String(Math.round(rect.sizeDelta[0])) : '',
      height: rect?.sizeDelta?.length ? String(Math.round(rect.sizeDelta[1])) : '',
      text: summaryString(selectedNode, 'Text', 'text'),
      fontSize: summaryNumber(selectedNode, 'Text', 'fontSize'),
      textColor: colorInput(summaryString(selectedNode, 'Text', 'color')),
      spritePath: summaryString(selectedNode, 'Image', 'spritePath'),
      visible: selectedNode?.activeSelf ?? true,
    });
  }, [selectedNode]);

  async function stateFromSession(session: SessionInfo, selectedNodeId?: string | null): Promise<RuntimeArtboard> {
    const tree = await editorBridgeClient.exportNodeTree(session.sessionId);
    const image = await editorBridgeClient.renderSnapshot(session.sessionId);
    const snapshotUrl = await editorBridgeClient.snapshotUrl(image.snapshot);
    const name = prefabNameFromPath(session.sourcePrefabPath || session.workingPrefabPath || 'NewUI');
    return {
      id: globalThis.crypto?.randomUUID?.() ?? `artboard-${Date.now()}`,
      name,
      sessionId: session.sessionId,
      sourcePrefabPath: session.sourcePrefabPath || null,
      workingPrefabPath: session.workingPrefabPath,
      targetPrefabPath: session.sourcePrefabPath || defaultTargetFor(name),
      selectedNodeId: selectedNodeId ?? findVisibleNode(image.snapshot, tree.rootNodeId),
      dirty: false,
      revision: image.revision,
      rootNodeId: tree.rootNodeId,
      nodes: tree.nodes,
      snapshot: image.snapshot,
      snapshotUrl,
      undoAvailable: false,
      redoAvailable: false,
    };
  }

  async function fromStateResponse(response: ArtboardStateResponse, previous?: RuntimeArtboard | null, trace?: VisualPerfTrace): Promise<RuntimeArtboard> {
    const responseSnapshot = hasSnapshotImage(response.snapshot) ? response.snapshot : null;
    const snapshot = responseSnapshot ?? previous?.snapshot ?? null;
    let snapshotUrl = previous?.snapshotUrl ?? null;
    if (responseSnapshot) {
      markVisualPerf(trace, 'snapshotUrlStart', { snapshotId: responseSnapshot.snapshotId });
      snapshotUrl = await editorBridgeClient.snapshotUrl(responseSnapshot);
      pendingImagePerfByUrl.current.set(snapshotUrl, trace ?? {
        id: 0,
        label: 'unknown',
        start: performance.now(),
        last: performance.now(),
      });
      markVisualPerf(trace, 'snapshotUrlReady', { snapshotId: responseSnapshot.snapshotId });
    }
    const fallbackName = prefabNameFromPath(response.session.sourcePrefabPath || response.session.workingPrefabPath || 'NewUI');
    return {
      id: previous?.id ?? globalThis.crypto?.randomUUID?.() ?? `artboard-${Date.now()}`,
      name: previous?.name ?? fallbackName,
      sessionId: response.session.sessionId,
      sourcePrefabPath: response.session.sourcePrefabPath || previous?.sourcePrefabPath || null,
      workingPrefabPath: response.session.workingPrefabPath,
      targetPrefabPath: previous?.targetPrefabPath || response.session.sourcePrefabPath || defaultTargetFor(fallbackName),
      selectedNodeId: response.selectedNodeId || previous?.selectedNodeId || findVisibleNode(snapshot, response.rootNodeId),
      dirty: response.dirty,
      revision: response.revision,
      rootNodeId: response.rootNodeId,
      nodes: response.nodes,
      snapshot,
      snapshotUrl,
      undoAvailable: response.undoAvailable,
      redoAvailable: response.redoAvailable,
    };
  }

  async function restoreArtboards(): Promise<RuntimeArtboard[]> {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const data = JSON.parse(raw) as { activeId?: string; artboards?: PersistedArtboard[] };
    const restored: RuntimeArtboard[] = [];
    for (const item of data.artboards ?? []) {
      try {
        const response = await editorBridgeClient.resumeSession({
          workingPrefabPath: item.workingPrefabPath,
          sourcePrefabPath: item.sourcePrefabPath,
          selectedNodeId: item.selectedNodeId,
        });
        const artboard = await fromStateResponse(response, {
          ...item,
          revision: response.revision,
          rootNodeId: response.rootNodeId,
          nodes: [],
          snapshot: null,
          snapshotUrl: null,
          undoAvailable: false,
          redoAvailable: false,
        });
        restored.push(artboard);
      } catch (err) {
        setStatus(`画板恢复跳过: ${item.name} (${errorText(err)})`);
      }
    }
    if (restored.length > 0) {
      artboardsRef.current = restored;
      setArtboards(restored);
      const restoredActiveId = restored.some((item) => item.id === data.activeId) ? data.activeId ?? restored[0].id : restored[0].id;
      activeIdRef.current = restoredActiveId;
      setActiveId(restoredActiveId);
      setStatus(`已恢复 ${restored.length} 个画板`);
    }
    return restored;
  }

  function updateArtboard(next: RuntimeArtboard, activate = true) {
    artboardsRef.current = artboardsRef.current.map((item) => (item.id === next.id ? next : item));
    setArtboards(artboardsRef.current);
    if (activate) {
      activeIdRef.current = next.id;
      setActiveId(next.id);
    }
  }

  async function run(label: string, action: () => Promise<void>) {
    setBusy(label);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(errorText(err));
      setStatus(`${label}失败`);
    } finally {
      setBusy(null);
    }
  }

  async function createBlankArtboard(name = `NewUI_${artboards.length + 1}`) {
    await run('新建画板', async () => {
      const response = await editorBridgeClient.createBlankArtboard(name);
      const artboard = await fromStateResponse(response, null);
      artboard.name = name;
      artboard.targetPrefabPath = defaultTargetFor(name);
      artboardsRef.current = [...artboardsRef.current, artboard];
      setArtboards(artboardsRef.current);
      activeIdRef.current = artboard.id;
      setActiveId(artboard.id);
      setStatus(`已新建画板: ${name}`);
    });
  }

  async function openPrefabAsArtboard(prefabPath: string) {
    await run('打开 UI', async () => {
      const opened = await editorBridgeClient.openPrefab(prefabPath, 'temp-copy');
      const artboard = await stateFromSession(opened.session);
      artboardsRef.current = [...artboardsRef.current, artboard];
      setArtboards(artboardsRef.current);
      activeIdRef.current = artboard.id;
      setActiveId(artboard.id);
      setStatus(`已打开 UI: ${opened.session.sourcePrefabPath}`);
    });
  }

  function enqueueBridgeTask(task: () => Promise<void>): Promise<void> {
    const next = operationQueueRef.current.catch(() => undefined).then(task);
    operationQueueRef.current = next.catch(() => undefined);
    return next;
  }

  async function waitForPendingOperations() {
    await operationQueueRef.current.catch(() => undefined);
  }

  async function refreshArtboardSnapshot(artboardId: string, sessionId: string, seq: number, trace?: VisualPerfTrace) {
    try {
      markVisualPerf(trace, 'snapshotRefreshRequestStart', { seq });
      const image = await editorBridgeClient.renderSnapshot(sessionId, undefined, { profile: true });
      markVisualPerf(trace, 'snapshotRefreshResponse', {
        seq,
        snapshotId: image.snapshot.snapshotId,
        serverProfile: image.serverProfile ?? null,
        bridgeProfile: summarizeBridgeProfile(image.profile),
      });
      if (seq !== snapshotRefreshSeq.current) return;
      markVisualPerf(trace, 'snapshotUrlStart', { snapshotId: image.snapshot.snapshotId });
      const snapshotUrl = await editorBridgeClient.snapshotUrl(image.snapshot);
      pendingImagePerfByUrl.current.set(snapshotUrl, trace ?? {
        id: 0,
        label: 'snapshotRefresh',
        start: performance.now(),
        last: performance.now(),
      });
      markVisualPerf(trace, 'snapshotUrlReady', { snapshotId: image.snapshot.snapshotId });
      const previous = artboardsRef.current.find((item) => item.id === artboardId);
      if (!previous) return;
      updateArtboard({
        ...previous,
        revision: image.revision,
        snapshot: image.snapshot,
        snapshotUrl,
      }, false);
      markVisualPerf(trace, 'stateUpdatedWithSnapshot', { seq });
      if (activeIdRef.current === artboardId) setStatus(`${previous.name} 画面已刷新`);
    } catch {
      if (seq === snapshotRefreshSeq.current && activeIdRef.current === artboardId) {
        setStatus('画面刷新稍后重试');
      }
    }
  }

  function scheduleSnapshotRefresh(artboardId: string, sessionId: string, trace?: VisualPerfTrace) {
    const seq = ++snapshotRefreshSeq.current;
    markVisualPerf(trace, 'snapshotRefreshScheduled', { seq, delayMs: SNAPSHOT_REFRESH_DELAY_MS });
    if (snapshotRefreshTimerRef.current !== null) {
      window.clearTimeout(snapshotRefreshTimerRef.current);
    }
    snapshotRefreshTimerRef.current = window.setTimeout(() => {
      snapshotRefreshTimerRef.current = null;
      void enqueueBridgeTask(async () => {
        if (seq !== snapshotRefreshSeq.current) return;
        await refreshArtboardSnapshot(artboardId, sessionId, seq, trace);
      });
    }, SNAPSHOT_REFRESH_DELAY_MS);
  }

  async function applyStateResponse(artboardId: string, response: ArtboardStateResponse, nextStatus?: string, refreshSnapshot = true, trace?: VisualPerfTrace) {
    markVisualPerf(trace, 'stateApplyStart', { hasSnapshot: hasSnapshotImage(response.snapshot) });
    const previous = artboardsRef.current.find((item) => item.id === artboardId);
    if (!previous) return;
    const next = await fromStateResponse(response, previous, trace);
    updateArtboard(next, false);
    markVisualPerf(trace, 'stateUpdated', { hasSnapshotUrl: !!next.snapshotUrl });
    if (nextStatus && activeIdRef.current === artboardId) setStatus(nextStatus);
    if (!hasSnapshotImage(response.snapshot) && refreshSnapshot) scheduleSnapshotRefresh(next.id, next.sessionId, trace);
  }

  function runNodeOperation(label: string, action: (artboard: RuntimeArtboard) => Promise<ArtboardStateResponse>, optimistic?: (artboard: RuntimeArtboard) => RuntimeArtboard) {
    if (!activeArtboard) return;
    const trace = startVisualPerf(label);
    operationSeq.current += 1;
    const artboard = activeArtboard;
    const optimisticArtboard = optimistic ? optimistic(artboard) : { ...artboard, dirty: true };
    updateArtboard(optimisticArtboard);
    markVisualPerf(trace, 'optimisticStateUpdated', { hasOptimistic: !!optimistic });
    setError(null);
    setStatus(`${label}已提交，Unity 同步中`);
    setSyncingCount((count) => count + 1);
    markVisualPerf(trace, 'queueEnqueued');
    void enqueueBridgeTask(async () => {
      try {
        markVisualPerf(trace, 'queueStarted');
        const latest = artboardsRef.current.find((item) => item.id === artboard.id) ?? artboard;
        markVisualPerf(trace, 'bridgeRequestStart');
        const response = await action(latest);
        markVisualPerf(trace, 'bridgeResponse', {
          hasSnapshot: hasSnapshotImage(response.snapshot),
          nodeCount: response.nodes?.length ?? 0,
          serverProfile: response.serverProfile ?? null,
          bridgeProfile: summarizeBridgeProfile(response.profile),
        });
        await applyStateResponse(artboard.id, response, `${label}已同步: ${latest.name}`, true, trace);
        markVisualPerf(trace, 'operationSettled');
      } catch (err) {
        markVisualPerf(trace, 'operationError', { error: errorText(err) });
        setError(errorText(err));
        setStatus(`${label}失败`);
      } finally {
        setSyncingCount((count) => Math.max(0, count - 1));
      }
    });
  }

  function selectNode(nodeId: string | null) {
    if (!activeArtboard) return;
    updateArtboard({ ...activeArtboard, selectedNodeId: nodeId });
  }

  function pointInSnapshot(event: React.PointerEvent | React.DragEvent): { x: number; y: number } | null {
    const frame = frameRef.current?.querySelector('[data-remote-snapshot-frame]') as HTMLElement | null;
    if (!frame || displayScale <= 0) return null;
    const rect = frame.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) / displayScale,
      y: (event.clientY - rect.top) / displayScale,
    };
  }

  function maybeSendDragMove(nextDrag: DragState) {
    if (dragInFlight.current || Date.now() - lastDragSendAt.current < 140 || !selectedNode || !activeArtboard) return;
    dragInFlight.current = true;
    lastDragSendAt.current = Date.now();
    const artboard = activeArtboard;
    const x = Math.round(nextDrag.startX + nextDrag.deltaX);
    const y = Math.round(nextDrag.startY - nextDrag.deltaY);
    void enqueueBridgeTask(async () => {
      await editorBridgeClient.moveNode(artboard.sessionId, nextDrag.nodeId, x, y, { skipSnapshot: true });
    }).finally(() => {
      dragInFlight.current = false;
    });
  }

  function onSnapshotPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (!activeArtboard?.snapshot || busy) return;
    const point = pointInSnapshot(event);
    if (!point) return;
    const hit = pickBboxAtPoint(activeBboxes, point.x, point.y);
    if (!hit) {
      selectNode(null);
      return;
    }
    const node = nodeById.get(hit.nodeId);
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    updateArtboard({ ...activeArtboard, selectedNodeId: hit.nodeId });
    setDrag({
      nodeId: hit.nodeId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: node?.rectTransform?.anchoredPosition?.[0] ?? 0,
      startY: node?.rectTransform?.anchoredPosition?.[1] ?? 0,
      deltaX: 0,
      deltaY: 0,
    });
  }

  function onSnapshotPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!drag) return;
    const nextDrag = {
      ...drag,
      deltaX: (event.clientX - drag.startClientX) / displayScale,
      deltaY: (event.clientY - drag.startClientY) / displayScale,
    };
    setDrag(nextDrag);
    maybeSendDragMove(nextDrag);
  }

  function onSnapshotPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    if (!drag) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    const x = Math.round(drag.startX + drag.deltaX);
    const y = Math.round(drag.startY - drag.deltaY);
    const nodeId = drag.nodeId;
    setDrag(null);
    runNodeOperation(
      '移动节点',
      (artboard) => editorBridgeClient.moveNode(artboard.sessionId, nodeId, x, y, { skipSnapshot: false }),
      (artboard) => optimisticMove(artboard, nodeId, x, y),
    );
  }

  function prefabDragData(event: React.DragEvent): string {
    return event.dataTransfer.getData('application/x-uieditor-prefab') || event.dataTransfer.getData('text/plain');
  }

  function onPrefabDragStart(event: React.DragEvent, item: PrefabListItem) {
    event.dataTransfer.setData('application/x-uieditor-prefab', item.relPath);
    event.dataTransfer.setData('text/plain', item.relPath);
    event.dataTransfer.effectAllowed = 'copy';
  }

  function onArtboardStripDrop(event: React.DragEvent) {
    event.preventDefault();
    const prefabPath = prefabDragData(event);
    if (prefabPath) void openPrefabAsArtboard(prefabPath);
  }

  function onCanvasDrop(event: React.DragEvent) {
    event.preventDefault();
    if (!activeArtboard) return;
    const prefabPath = prefabDragData(event);
    const point = pointInSnapshot(event);
    if (!prefabPath || !point) return;
    const parentId = activeArtboard.selectedNodeId || activeArtboard.rootNodeId || null;
    runNodeOperation('插入 UI', (artboard) => editorBridgeClient.insertPrefab(artboard.sessionId, prefabPath, {
      parentId,
      x: Math.round(point.x - SNAPSHOT_WIDTH / 2),
      y: Math.round(SNAPSHOT_HEIGHT / 2 - point.y),
    }, { skipSnapshot: false }));
  }

  async function saveActive() {
    if (!activeArtboard) return;
    await run('保存 UI', async () => {
      await waitForPendingOperations();
      const current = artboardsRef.current.find((item) => item.id === activeArtboard.id) ?? activeArtboard;
      const target = current.sourcePrefabPath ? null : normalizeTargetPath(current.targetPrefabPath);
      const result = await editorBridgeClient.saveArtboard(current.sessionId, target);
      updateArtboard({
        ...current,
        sourcePrefabPath: result.sourcePrefabPath,
        targetPrefabPath: result.sourcePrefabPath,
        dirty: false,
      });
      setStatus(`已保存 UI: ${result.savedPath}，正在更新预览图...`);
      await refreshPrefabThumbnailFromBridge(result.savedPath, ['content', 'canvas']);
      setStatus(`已保存 UI: ${result.savedPath}`);
    });
  }

  async function closeActive() {
    if (!activeArtboard) return;
    if (activeArtboard.dirty && !window.confirm('当前画板有未保存修改，关闭后会丢弃。确认关闭？')) return;
    await run('关闭画板', async () => {
      snapshotRefreshSeq.current += 1;
      if (snapshotRefreshTimerRef.current !== null) {
        window.clearTimeout(snapshotRefreshTimerRef.current);
        snapshotRefreshTimerRef.current = null;
      }
      await waitForPendingOperations();
      const current = artboardsRef.current.find((item) => item.id === activeArtboard.id) ?? activeArtboard;
      await editorBridgeClient.closePrefab(current.sessionId, true);
      const rest = artboardsRef.current.filter((item) => item.id !== current.id);
      artboardsRef.current = rest;
      const nextActive = rest[0]?.id ?? null;
      activeIdRef.current = nextActive;
      setActiveId(nextActive);
      if (rest.length === 0) localStorage.removeItem(STORAGE_KEY);
      setArtboards(rest);
      setStatus(`已关闭画板: ${current.name}`);
    });
  }

  function updateActivePatch(patch: Partial<RuntimeArtboard>) {
    if (!activeArtboard) return;
    updateArtboard({ ...activeArtboard, ...patch });
  }

  function onSnapshotImageLoad(event: React.SyntheticEvent<HTMLImageElement>) {
    const src = event.currentTarget.currentSrc || event.currentTarget.src;
    const trace = pendingImagePerfByUrl.current.get(src) || (activeArtboard?.snapshotUrl ? pendingImagePerfByUrl.current.get(activeArtboard.snapshotUrl) : undefined);
    markVisualPerf(trace, 'imageLoaded', { imageResource: snapshotResourceTiming(src) });
    if (trace) {
      writeVisualPerfLog({
        id: trace.id,
        label: trace.label,
        stage: 'visualComplete',
        totalMs: Math.round((performance.now() - trace.start) * 10) / 10,
      });
    }
    pendingImagePerfByUrl.current.delete(src);
    if (activeArtboard?.snapshotUrl) pendingImagePerfByUrl.current.delete(activeArtboard.snapshotUrl);
  }

  const snapshotStyle = {
    width: SNAPSHOT_WIDTH * displayScale,
    height: SNAPSHOT_HEIGHT * displayScale,
  };

  return (
    <div className="flex h-full w-full flex-col bg-[#11111b] text-[#cdd6f4]">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[#313244] bg-[#1e1e2e] px-3">
        <button data-testid="remote-new-artboard" onClick={() => void createBlankArtboard()} disabled={!!busy} className="rounded bg-[#89b4fa] px-3 py-1 text-xs font-semibold text-[#11111b] disabled:bg-[#45475a]">
          新建画板
        </button>
        <button data-testid="remote-save-artboard" onClick={() => void saveActive()} disabled={!activeArtboard || !!busy} className="rounded bg-[#a6e3a1] px-3 py-1 text-xs font-semibold text-[#11111b] disabled:bg-[#45475a]">
          保存 UI
        </button>
        <button data-testid="remote-close-artboard" onClick={() => void closeActive()} disabled={!activeArtboard || !!busy} className="rounded bg-[#313244] px-3 py-1 text-xs text-[#cdd6f4] disabled:text-[#6c7086]">
          关闭画板
        </button>
        <div className="h-5 w-px bg-[#45475a]" />
        <button onClick={() => runNodeOperation('新增文字', (artboard) => editorBridgeClient.createTextNode(artboard.sessionId, { parentId: artboard.selectedNodeId || artboard.rootNodeId, x: 0, y: 0 }, { skipSnapshot: false }))} disabled={!activeArtboard || !!busy} className="rounded bg-[#313244] px-2 py-1 text-xs text-[#cdd6f4] disabled:text-[#6c7086]">
          文字
        </button>
        <button onClick={() => runNodeOperation('新增图片', (artboard) => editorBridgeClient.createImageNode(artboard.sessionId, { parentId: artboard.selectedNodeId || artboard.rootNodeId, x: 0, y: 0 }, { skipSnapshot: false }))} disabled={!activeArtboard || !!busy} className="rounded bg-[#313244] px-2 py-1 text-xs text-[#cdd6f4] disabled:text-[#6c7086]">
          图片
        </button>
        <button onClick={() => runNodeOperation('撤销', (artboard) => editorBridgeClient.undoArtboard(artboard.sessionId, { skipSnapshot: false }))} disabled={!activeArtboard?.undoAvailable || !!busy} className="rounded bg-[#313244] px-2 py-1 text-xs text-[#cdd6f4] disabled:text-[#6c7086]">
          撤销
        </button>
        <button onClick={() => runNodeOperation('重做', (artboard) => editorBridgeClient.redoArtboard(artboard.sessionId, { skipSnapshot: false }))} disabled={!activeArtboard?.redoAvailable || !!busy} className="rounded bg-[#313244] px-2 py-1 text-xs text-[#cdd6f4] disabled:text-[#6c7086]">
          重做
        </button>
        <div data-testid="remote-status" className="min-w-0 flex-1 truncate text-xs text-[#a6adc8]" title={error || status}>
          {busy ? `${busy}...` : error || `${status}${syncingCount > 0 ? ` · 同步中 ${syncingCount}` : ''}`}
        </div>
        <div className={`h-2 w-2 rounded-full ${health ? 'bg-[#a6e3a1]' : 'bg-[#f38ba8]'}`} />
      </div>

      <div className="flex min-h-0 flex-1">
        <aside className="flex w-64 shrink-0 flex-col border-r border-[#313244] bg-[#1e1e2e]">
          <div className="border-b border-[#313244] p-3">
            <input data-testid="remote-prefab-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索项目 UI..." className="w-full rounded border border-[#45475a] bg-[#313244] px-2 py-1.5 text-sm outline-none focus:border-[#89b4fa]" />
            <div className="mt-2 text-xs text-[#6c7086]">拖到画板栏打开；拖到编辑区插入为子节点</div>
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            {filteredPrefabs.map((item) => (
              <div key={item.relPath} draggable onDragStart={(event) => onPrefabDragStart(event, item)} className="group mb-1 flex items-center gap-2 rounded px-2 py-1 hover:bg-[#313244]" title={item.relPath}>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{item.name}</div>
                  <div className="truncate text-[11px] text-[#6c7086]">{item.category || compactPath(item.relPath)}</div>
                </div>
                <button data-testid={`remote-open-${item.name}`} onClick={() => void openPrefabAsArtboard(item.relPath)} className="rounded bg-[#45475a] px-2 py-0.5 text-[11px] text-[#cdd6f4] opacity-0 group-hover:opacity-100">
                  打开
                </button>
              </div>
            ))}
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          <div data-testid="remote-artboard-strip" onDragOver={(event) => event.preventDefault()} onDrop={onArtboardStripDrop} className="flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b border-[#313244] bg-[#181825] px-2">
            {artboards.map((artboard) => (
              <button key={artboard.id} onClick={() => {
                activeIdRef.current = artboard.id;
                setActiveId(artboard.id);
              }} className={`max-w-[220px] truncate rounded px-3 py-1 text-xs ${artboard.id === activeArtboard?.id ? 'bg-[#89b4fa] text-[#11111b]' : 'bg-[#313244] text-[#a6adc8]'}`} title={artboard.workingPrefabPath}>
                {artboard.dirty ? '* ' : ''}{artboard.name}
              </button>
            ))}
            <span className="px-2 text-xs text-[#6c7086]">拖 UI 到这里打开为新画板</span>
          </div>
          <div ref={frameRef} className="relative min-h-0 flex-1 overflow-hidden bg-[#11111b] p-4" onDragOver={(event) => event.preventDefault()} onDrop={onCanvasDrop}>
            {activeArtboard?.snapshotUrl ? (
              <div data-remote-snapshot-frame data-testid="remote-snapshot-frame" className="relative mx-auto overflow-hidden border border-[#313244] bg-[#162d3f] shadow-2xl" style={snapshotStyle} onPointerDown={onSnapshotPointerDown} onPointerMove={onSnapshotPointerMove} onPointerUp={onSnapshotPointerUp} onPointerCancel={onSnapshotPointerUp}>
                <img src={activeArtboard.snapshotUrl} alt="" draggable={false} onLoad={onSnapshotImageLoad} className="absolute inset-0 h-full w-full select-none" />
                {activeBboxes.map((box) => {
                  const selected = box.nodeId === activeArtboard.selectedNodeId;
                  const dx = drag?.nodeId === box.nodeId ? drag.deltaX * displayScale : 0;
                  const dy = drag?.nodeId === box.nodeId ? drag.deltaY * displayScale : 0;
                  return (
                    <button
                      key={`${box.nodeId}-${box.path}`}
                      data-testid="remote-bbox"
                      className="absolute border bg-transparent"
                      style={{
                        left: box.x * displayScale + dx,
                        top: box.y * displayScale + dy,
                        width: box.width * displayScale,
                        height: box.height * displayScale,
                        borderColor: selected ? '#f9e2af' : 'rgba(137, 180, 250, 0.55)',
                        borderWidth: selected ? 2 : 1,
                      }}
                      title={box.path}
                      onClick={(event) => {
                        event.stopPropagation();
                        selectNode(box.nodeId);
                      }}
                    />
                  );
                })}
              </div>
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-[#6c7086]">等待画板渲染</div>
            )}
          </div>
        </main>

        <aside className="flex w-[340px] shrink-0 flex-col border-l border-[#313244] bg-[#1e1e2e]">
          <div className="border-b border-[#313244] p-3">
            <div className="mb-2 text-xs text-[#6c7086]">保存目标</div>
            <input
              data-testid="remote-save-target"
              value={activeArtboard?.targetPrefabPath ?? ''}
              readOnly={!!activeArtboard?.sourcePrefabPath}
              onChange={(event) => updateActivePatch({ targetPrefabPath: event.target.value })}
              className="w-full rounded border border-[#45475a] bg-[#313244] px-2 py-1 text-xs outline-none focus:border-[#89b4fa]"
            />
            <div className="mt-2 truncate text-[11px] text-[#6c7086]" title={activeArtboard?.workingPrefabPath}>工作副本: {compactPath(activeArtboard?.workingPrefabPath)}</div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            <section className="border-b border-[#313244] p-3">
              <div className="mb-2 text-xs font-semibold text-[#a6adc8]">图层</div>
              <LayerTree nodes={activeArtboard?.nodes ?? []} rootNodeId={activeArtboard?.rootNodeId ?? null} selectedNodeId={activeArtboard?.selectedNodeId ?? null} onSelect={selectNode} />
            </section>

            <section data-testid="remote-property-panel" className="p-3">
              <div className="mb-2 truncate text-xs font-semibold text-[#a6adc8]" title={selectedNode?.path}>{selectedNode?.path ?? '未选择节点'}</div>
              {selectedNode && (
                <div className="space-y-3 text-xs">
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={draft.visible} onChange={(event) => {
                      const visible = event.target.checked;
                      setDraft((cur) => ({ ...cur, visible }));
                      runNodeOperation(
                        '显隐',
                        (artboard) => editorBridgeClient.setVisible(artboard.sessionId, selectedNode.nodeId, visible, { skipSnapshot: false }),
                        (artboard) => optimisticVisible(artboard, selectedNode.nodeId, visible),
                      );
                    }} />
                    显示
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <Field testId="remote-x-input" label="X" value={draft.x} onChange={(value) => setDraft((cur) => ({ ...cur, x: value }))} />
                    <Field testId="remote-y-input" label="Y" value={draft.y} onChange={(value) => setDraft((cur) => ({ ...cur, y: value }))} />
                  </div>
                  <button data-testid="remote-apply-position" onClick={() => {
                    const x = Number(draft.x);
                    const y = Number(draft.y);
                    runNodeOperation(
                      '位置',
                      (artboard) => editorBridgeClient.moveNode(artboard.sessionId, selectedNode.nodeId, x, y, { skipSnapshot: false }),
                      (artboard) => optimisticMove(artboard, selectedNode.nodeId, x, y),
                    );
                  }} className="w-full rounded bg-[#313244] py-1 text-[#cdd6f4]">
                    应用位置
                  </button>
                  <div className="grid grid-cols-2 gap-2">
                    <Field testId="remote-width-input" label="W" value={draft.width} onChange={(value) => setDraft((cur) => ({ ...cur, width: value }))} />
                    <Field testId="remote-height-input" label="H" value={draft.height} onChange={(value) => setDraft((cur) => ({ ...cur, height: value }))} />
                  </div>
                  <button data-testid="remote-apply-size" onClick={() => {
                    const width = Number(draft.width);
                    const height = Number(draft.height);
                    runNodeOperation(
                      '尺寸',
                      (artboard) => editorBridgeClient.resizeNode(artboard.sessionId, selectedNode.nodeId, width, height, { skipSnapshot: false }),
                      (artboard) => optimisticResize(artboard, selectedNode.nodeId, width, height),
                    );
                  }} className="w-full rounded bg-[#313244] py-1 text-[#cdd6f4]">
                    应用尺寸
                  </button>

                  {findComponent(selectedNode, 'Text') && (
                    <div className="space-y-2 border-t border-[#313244] pt-3">
                      <textarea data-testid="remote-text-input" value={draft.text} onChange={(event) => setDraft((cur) => ({ ...cur, text: event.target.value }))} className="h-16 w-full rounded border border-[#45475a] bg-[#313244] p-2 outline-none" />
                      <button data-testid="remote-apply-text" onClick={() => runNodeOperation(
                        '文本',
                        (artboard) => editorBridgeClient.setText(artboard.sessionId, selectedNode.nodeId, draft.text, { skipSnapshot: false }),
                        (artboard) => optimisticText(artboard, selectedNode.nodeId, draft.text),
                      )} className="w-full rounded bg-[#313244] py-1 text-[#cdd6f4]">
                        应用文本
                      </button>
                      <div className="grid grid-cols-[1fr_44px] gap-2">
                        <Field testId="remote-font-size-input" label="字号" value={draft.fontSize} onChange={(value) => setDraft((cur) => ({ ...cur, fontSize: value }))} />
                        <input data-testid="remote-text-color" type="color" value={draft.textColor} onChange={(event) => setDraft((cur) => ({ ...cur, textColor: event.target.value }))} className="h-[30px] w-11 rounded border border-[#45475a] bg-[#313244]" />
                      </div>
                      <button data-testid="remote-apply-text-style" onClick={() => {
                        const fontSize = Number(draft.fontSize);
                        const color = opaqueColor(draft.textColor);
                        runNodeOperation(
                          '文字样式',
                          (artboard) => editorBridgeClient.setTextStyle(artboard.sessionId, selectedNode.nodeId, { fontSize, color }, { skipSnapshot: false }),
                          (artboard) => optimisticTextStyle(artboard, selectedNode.nodeId, { fontSize, color }),
                        );
                      }} className="w-full rounded bg-[#313244] py-1 text-[#cdd6f4]">
                        应用文字样式
                      </button>
                    </div>
                  )}

                  {findComponent(selectedNode, 'Image') && (
                    <div className="space-y-2 border-t border-[#313244] pt-3">
                      <input data-testid="remote-sprite-input" value={draft.spritePath} onChange={(event) => setDraft((cur) => ({ ...cur, spritePath: event.target.value }))} placeholder="Assets/.../sprite.png" className="w-full rounded border border-[#45475a] bg-[#313244] px-2 py-1 outline-none" />
                      <button data-testid="remote-apply-sprite" onClick={() => runNodeOperation(
                        '图片',
                        (artboard) => editorBridgeClient.setImage(artboard.sessionId, selectedNode.nodeId, draft.spritePath, { skipSnapshot: false }),
                        (artboard) => optimisticImage(artboard, selectedNode.nodeId, draft.spritePath),
                      )} className="w-full rounded bg-[#313244] py-1 text-[#cdd6f4]">
                        应用图片
                      </button>
                    </div>
                  )}

                  <button data-testid="remote-delete-node" onClick={() => runNodeOperation(
                    '删除节点',
                    (artboard) => editorBridgeClient.deleteNode(artboard.sessionId, selectedNode.nodeId, { skipSnapshot: false }),
                    (artboard) => optimisticDelete(artboard, selectedNode.nodeId),
                  )} className="w-full rounded bg-[#f38ba8] py-1 font-semibold text-[#11111b]">
                    删除节点
                  </button>
                </div>
              )}
            </section>
          </div>
        </aside>
      </div>
    </div>
  );
}

function Field({ label, value, onChange, testId }: { label: string; value: string; onChange: (value: string) => void; testId?: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] text-[#6c7086]">{label}</span>
      <input data-testid={testId} value={value} onChange={(event) => onChange(event.target.value)} className="w-full rounded border border-[#45475a] bg-[#313244] px-2 py-1 outline-none focus:border-[#89b4fa]" />
    </label>
  );
}

function LayerTree({ nodes, rootNodeId, selectedNodeId, onSelect }: {
  nodes: NodeRecord[];
  rootNodeId: string | null;
  selectedNodeId: string | null;
  onSelect: (nodeId: string) => void;
}) {
  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.nodeId, node])), [nodes]);
  const renderNode = (nodeId: string, depth: number): ReactNode => {
    const node = nodeById.get(nodeId);
    if (!node) return null;
    return (
      <div key={node.nodeId}>
        <button onClick={() => onSelect(node.nodeId)} className={`w-full truncate rounded px-2 py-0.5 text-left text-xs ${selectedNodeId === node.nodeId ? 'bg-[#89b4fa] text-[#11111b]' : 'text-[#a6adc8] hover:bg-[#313244]'}`} style={{ paddingLeft: 8 + depth * 14 }} title={node.path}>
          {node.activeSelf ? '' : '○ '}{node.name}
        </button>
        {node.children.map((childId) => renderNode(childId, depth + 1))}
      </div>
    );
  };
  return <div className="max-h-72 overflow-y-auto">{rootNodeId ? renderNode(rootNodeId, 0) : <div className="text-xs text-[#6c7086]">无节点</div>}</div>;
}

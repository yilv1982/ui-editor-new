import { debugLog } from '../utils/debugLog';

const DEFAULT_EDITOR_BRIDGE_URL = 'http://127.0.0.1:18082';

export interface BridgeErrorInfo {
  code: string;
  message: string;
}

export interface BridgeServerProfile {
  path: string;
  requestReadMs: number;
  mainThreadQueueMs: number;
  mainThreadHandleMs: number;
  workerWaitMs: number;
  responseJsonBytes: number;
}

export interface BridgeBaseResponse {
  ok: boolean;
  error?: BridgeErrorInfo;
  serverProfile?: BridgeServerProfile;
}

export interface HealthResponse extends BridgeBaseResponse {
  name: string;
  version: string;
  loadId?: string;
  loadedAtUtc?: string;
  unityVersion?: string;
  projectPath: string;
  editor?: {
    isCompiling?: boolean;
    isUpdating?: boolean;
    isPlaying?: boolean;
    isPlayingOrWillChangePlaymode?: boolean;
    timeSinceStartup?: number;
  };
  capabilities: string[];
}

export interface SessionInfo {
  sessionId: string;
  sourcePrefabPath: string;
  workingPrefabPath: string;
  mode: 'readonly' | 'temp-copy' | 'source' | string;
  framework?: 'ugui' | 'ngui' | 'unknown' | string;
  revision: string;
}

export interface OpenPrefabResponse extends BridgeBaseResponse {
  session: SessionInfo;
}

export interface RectTransformRecord {
  anchorMin: number[];
  anchorMax: number[];
  pivot: number[];
  anchoredPosition: number[];
  sizeDelta: number[];
  localScale: number[];
  localEulerAngles: number[];
}

export interface ComponentRecord {
  type: string;
  enabled: boolean;
  summary?: Record<string, string | number | boolean | null | undefined>;
}

export interface BboxRecord {
  nodeId: string;
  path: string;
  x: number;
  y: number;
  width: number;
  height: number;
  activeInHierarchy: boolean;
  space?: string;
  contributesToBounds?: boolean;
}

export interface NodeRecord {
  nodeId: string;
  unityFileId?: string;
  path: string;
  name: string;
  framework?: 'ugui' | 'ngui' | 'mixed' | 'unknown' | string;
  parentId?: string;
  siblingIndex: number;
  children: string[];
  activeSelf: boolean;
  activeInHierarchy: boolean;
  rectTransform?: RectTransformRecord;
  components: ComponentRecord[];
  editableFields: string[];
  protectedFields: string[];
  bbox?: BboxRecord;
}

export interface ExportNodeTreeResponse extends BridgeBaseResponse {
  revision: string;
  rootNodeId: string;
  nodes: NodeRecord[];
}

export interface SnapshotImage {
  format: 'png' | string;
  mode: 'file' | 'base64' | string;
  path?: string;
  url?: string;
  dataUrl?: string;
}

export interface SnapshotRecord {
  snapshotId: string;
  width: number;
  height: number;
  coordinateSpace: string;
  image: SnapshotImage;
  bboxes: BboxRecord[];
  viewport?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface RenderSnapshotResponse extends BridgeBaseResponse {
  revision: string;
  snapshot: SnapshotRecord;
  profile?: OperationProfile | null;
}

export interface OperationProfileEntry {
  name: string;
  ms: number;
}

export interface OperationProfile {
  totalMs: number;
  entries: OperationProfileEntry[];
}

export interface ArtboardStateResponse extends BridgeBaseResponse {
  session: SessionInfo;
  revision: string;
  rootNodeId: string;
  nodes: NodeRecord[];
  snapshot?: SnapshotRecord | null;
  selectedNodeId?: string;
  dirty: boolean;
  undoAvailable: boolean;
  redoAvailable: boolean;
  profile?: OperationProfile | null;
}

export interface VisualPatchOperation {
  op: 'set' | 'delta';
  nodeId: string;
  field: string;
  value?: number[];
  stringValue?: string;
  boolValue?: boolean;
  numberValue?: number;
  source?: {
    kind: string;
    screenDelta?: number[];
  };
}

export interface VisualPatch {
  patchId: string;
  baseRevision: string;
  operations: VisualPatchOperation[];
}

export interface PatchChange {
  nodeId: string;
  field: string;
  before: string;
  after: string;
}

export interface PatchReject {
  nodeId: string;
  field: string;
  reason: string;
}

export interface DiffChange {
  nodeId: string;
  field: string;
  before: string;
  after: string;
  line: number;
}

export interface DiffSummary {
  allowedCount: number;
  protectedCount: number;
}

export interface ProtectedDiffResult {
  ok: boolean;
  validationId?: string;
  allowedChanges: DiffChange[];
  protectedChanges: DiffChange[];
  summary: DiffSummary;
}

export interface ApplyVisualPatchResponse extends BridgeBaseResponse {
  revision: string;
  applied: PatchChange[];
  rejected: PatchReject[];
  protectedDiff: ProtectedDiffResult;
  snapshot?: SnapshotRecord;
  profile?: OperationProfile | null;
}

export interface ValidateProtectedDiffResponse extends BridgeBaseResponse {
  validationId: string;
  allowedChanges: DiffChange[];
  protectedChanges: DiffChange[];
  summary: DiffSummary;
}

export interface SavePrefabResponse extends BridgeBaseResponse {
  savedPath: string;
  sourcePrefabPath: string;
  revision: string;
}

export interface SaveArtboardResponse extends BridgeBaseResponse {
  savedPath: string;
  sourcePrefabPath: string;
  workingPrefabPath: string;
  revision: string;
  protectedDiff?: ProtectedDiffResult;
}

interface UnityConfigResponse {
  editorBridgeUrl?: string;
}

interface StateResponseOptions {
  skipSnapshot?: boolean;
  profile?: boolean;
}

export class EditorBridgeRequestError extends Error {
  readonly code: string;
  readonly response?: BridgeBaseResponse;

  constructor(code: string, message: string, response?: BridgeBaseResponse) {
    super(message);
    this.name = 'EditorBridgeRequestError';
    this.code = code;
    this.response = response;
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function createPatchId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `patch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function stateResponseOptions(options: StateResponseOptions = {}): Required<StateResponseOptions> {
  const skipSnapshot = !!options.skipSnapshot;
  return {
    skipSnapshot,
    profile: options.profile ?? !skipSnapshot,
  };
}

export class EditorBridgeClient {
  private baseUrlPromise: Promise<string> | null = null;

  async getBaseUrl(): Promise<string> {
    if (!this.baseUrlPromise) {
      this.baseUrlPromise = this.loadBaseUrl();
    }
    return this.baseUrlPromise;
  }

  async health(): Promise<HealthResponse> {
    return this.get<HealthResponse>('/health');
  }

  async openPrefab(prefabPath: string, mode: 'readonly' | 'temp-copy' = 'temp-copy', options: { width?: number; height?: number } = {}): Promise<OpenPrefabResponse> {
    return this.post<OpenPrefabResponse>('/open-prefab', {
      prefabPath,
      mode,
      width: options.width && options.width > 0 ? Math.round(options.width) : 1080,
      height: options.height && options.height > 0 ? Math.round(options.height) : 1920,
      backgroundColor: '#162D3FFF',
    });
  }

  async createBlankArtboard(name: string): Promise<ArtboardStateResponse> {
    return this.post<ArtboardStateResponse>('/create-blank-artboard', {
      name,
      width: 1080,
      height: 1920,
      profile: true,
    });
  }

  async resumeSession(params: {
    workingPrefabPath: string;
    sourcePrefabPath?: string | null;
    selectedNodeId?: string | null;
  }): Promise<ArtboardStateResponse> {
    return this.post<ArtboardStateResponse>('/resume-session', params);
  }

  async exportNodeTree(sessionId: string): Promise<ExportNodeTreeResponse> {
    return this.post<ExportNodeTreeResponse>('/export-node-tree', {
      sessionId,
      includeInactive: true,
      includeComponents: true,
      includeProtectedFields: true,
    });
  }

  async renderSnapshot(sessionId: string, targetNodeIds?: string[], options: { profile?: boolean; width?: number; height?: number } = {}): Promise<RenderSnapshotResponse> {
    return this.post<RenderSnapshotResponse>('/render-snapshot', {
      sessionId,
      width: options.width && options.width > 0 ? Math.round(options.width) : 1080,
      height: options.height && options.height > 0 ? Math.round(options.height) : 1920,
      backgroundColor: '#162D3FFF',
      targetNodeIds,
      includeBboxes: true,
      imageMode: 'file',
      profile: !!options.profile,
    });
  }

  async applyDragPatch(params: {
    sessionId: string;
    baseRevision: string;
    nodeId: string;
    deltaX: number;
    deltaY: number;
  }): Promise<ApplyVisualPatchResponse> {
    const patch: VisualPatch = {
      patchId: createPatchId(),
      baseRevision: params.baseRevision,
      operations: [{
        op: 'delta',
        nodeId: params.nodeId,
        field: 'rectTransform.anchoredPosition',
        value: [params.deltaX, -params.deltaY],
        source: {
          kind: 'drag-end',
          screenDelta: [params.deltaX, params.deltaY],
        },
      }],
    };
    return this.applyVisualPatch(params.sessionId, patch);
  }

  async applyVisualPatch(sessionId: string, patch: VisualPatch): Promise<ApplyVisualPatchResponse> {
    return this.post<ApplyVisualPatchResponse>('/apply-visual-patch', {
      sessionId,
      patch,
      dryRun: false,
      renderAfter: true,
      width: 1080,
      height: 1920,
      backgroundColor: '#162D3FFF',
      imageMode: 'file',
    });
  }

  createSetPatch(baseRevision: string, operation: Omit<VisualPatchOperation, 'op'>): VisualPatch {
    return {
      patchId: createPatchId(),
      baseRevision,
      operations: [{ ...operation, op: 'set' }],
    };
  }

  async validateProtectedDiff(sessionId: string, baseRevision: string, currentRevision: string): Promise<ValidateProtectedDiffResponse> {
    return this.post<ValidateProtectedDiffResponse>('/validate-protected-diff', {
      sessionId,
      baseRevision,
      currentRevision,
      includeTextDiff: true,
    });
  }

  async savePrefab(sessionId: string, validationId: string, note: string): Promise<SavePrefabResponse> {
    return this.post<SavePrefabResponse>('/save-prefab', {
      sessionId,
      mode: 'temp-copy',
      validationId,
      note,
    });
  }

  async closePrefab(sessionId: string | null | undefined, deleteTempObjects: boolean, workingPrefabPath?: string | null): Promise<BridgeBaseResponse> {
    return this.post<BridgeBaseResponse>('/close-prefab', {
      sessionId: sessionId ?? '',
      workingPrefabPath: workingPrefabPath ?? '',
      deleteTempObjects,
    });
  }

  async moveNode(sessionId: string, nodeId: string, x: number, y: number, options: StateResponseOptions = {}): Promise<ArtboardStateResponse> {
    return this.post<ArtboardStateResponse>('/move-node', { sessionId, nodeId, x, y, ...stateResponseOptions(options) });
  }

  async resizeNode(sessionId: string, nodeId: string, width: number, height: number, options: StateResponseOptions = {}): Promise<ArtboardStateResponse> {
    return this.post<ArtboardStateResponse>('/resize-node', { sessionId, nodeId, width, height, ...stateResponseOptions(options) });
  }

  async setText(sessionId: string, nodeId: string, text: string, options: StateResponseOptions = {}): Promise<ArtboardStateResponse> {
    return this.post<ArtboardStateResponse>('/set-text', { sessionId, nodeId, text, ...stateResponseOptions(options) });
  }

  async setTextStyle(sessionId: string, nodeId: string, params: { fontSize?: number; color?: string; fontPath?: string }, options: StateResponseOptions = {}): Promise<ArtboardStateResponse> {
    return this.post<ArtboardStateResponse>('/set-text-style', { sessionId, nodeId, ...params, ...stateResponseOptions(options) });
  }

  async setImage(sessionId: string, nodeId: string, spritePath: string, options: StateResponseOptions = {}): Promise<ArtboardStateResponse> {
    return this.post<ArtboardStateResponse>('/set-image', { sessionId, nodeId, spritePath, ...stateResponseOptions(options) });
  }

  async setVisible(sessionId: string, nodeId: string, visible: boolean, options: StateResponseOptions = {}): Promise<ArtboardStateResponse> {
    return this.post<ArtboardStateResponse>('/set-visible', { sessionId, nodeId, visible, ...stateResponseOptions(options) });
  }

  async reparentNode(sessionId: string, nodeId: string, parentId: string | null, index = -1, options: StateResponseOptions = {}): Promise<ArtboardStateResponse> {
    return this.post<ArtboardStateResponse>('/reparent-node', { sessionId, nodeId, parentId, index, ...stateResponseOptions(options) });
  }

  async insertPrefab(sessionId: string, prefabPath: string, params: { parentId?: string | null; x: number; y: number; index?: number }, options: StateResponseOptions = {}): Promise<ArtboardStateResponse> {
    return this.post<ArtboardStateResponse>('/insert-prefab', {
      sessionId,
      prefabPath,
      parentId: params.parentId ?? null,
      x: params.x,
      y: params.y,
      index: params.index ?? -1,
      ...stateResponseOptions(options),
    });
  }

  async createFrameNode(sessionId: string, params: { parentId?: string | null; name?: string; x: number; y: number; width?: number; height?: number }, options: StateResponseOptions = {}): Promise<ArtboardStateResponse> {
    return this.post<ArtboardStateResponse>('/create-frame-node', {
      sessionId,
      parentId: params.parentId ?? null,
      name: params.name ?? 'Frame',
      x: params.x,
      y: params.y,
      width: params.width ?? 300,
      height: params.height ?? 200,
      ...stateResponseOptions(options),
    });
  }

  async createTextNode(sessionId: string, params: { parentId?: string | null; name?: string; x: number; y: number; width?: number; height?: number; text?: string; fontSize?: number; color?: string }, options: StateResponseOptions = {}): Promise<ArtboardStateResponse> {
    return this.post<ArtboardStateResponse>('/create-text-node', {
      sessionId,
      parentId: params.parentId ?? null,
      name: params.name ?? 'Text',
      x: params.x,
      y: params.y,
      width: params.width ?? 240,
      height: params.height ?? 64,
      text: params.text ?? 'Text',
      fontSize: params.fontSize ?? 32,
      color: params.color ?? '#FFFFFFFF',
      ...stateResponseOptions(options),
    });
  }

  async createImageNode(sessionId: string, params: { parentId?: string | null; name?: string; x: number; y: number; width?: number; height?: number; spritePath?: string; color?: string }, options: StateResponseOptions = {}): Promise<ArtboardStateResponse> {
    return this.post<ArtboardStateResponse>('/create-image-node', {
      sessionId,
      parentId: params.parentId ?? null,
      name: params.name ?? 'Image',
      x: params.x,
      y: params.y,
      spritePath: params.spritePath ?? '',
      width: params.width ?? 160,
      height: params.height ?? 160,
      color: params.color ?? '#FFFFFFFF',
      ...stateResponseOptions(options),
    });
  }

  async createWidgetNode(sessionId: string, params: { parentId?: string | null; widgetType: string; name?: string; x: number; y: number; width?: number; height?: number }, options: StateResponseOptions = {}): Promise<ArtboardStateResponse> {
    return this.post<ArtboardStateResponse>('/create-widget-node', {
      sessionId,
      parentId: params.parentId ?? null,
      widgetType: params.widgetType,
      name: params.name ?? params.widgetType,
      x: params.x,
      y: params.y,
      width: params.width ?? 0,
      height: params.height ?? 0,
      ...stateResponseOptions(options),
    });
  }

  async duplicateNodes(sessionId: string, nodeIds: string[], params: { offsetX?: number; offsetY?: number } = {}, options: StateResponseOptions = {}): Promise<ArtboardStateResponse> {
    return this.post<ArtboardStateResponse>('/duplicate-nodes', {
      sessionId,
      nodeIds,
      offsetX: params.offsetX ?? 20,
      offsetY: params.offsetY ?? -20,
      ...stateResponseOptions(options),
    });
  }

  async copyNodesToSession(sourceSessionId: string, targetSessionId: string, nodeIds: string[], params: { targetParentId?: string | null; offsetX?: number; offsetY?: number } = {}, options: StateResponseOptions = {}): Promise<ArtboardStateResponse> {
    return this.post<ArtboardStateResponse>('/copy-nodes-to-session', {
      sourceSessionId,
      targetSessionId,
      nodeIds,
      targetParentId: params.targetParentId ?? null,
      offsetX: params.offsetX ?? 20,
      offsetY: params.offsetY ?? -20,
      ...stateResponseOptions(options),
    });
  }

  async groupNodes(sessionId: string, nodeIds: string[], name = 'Group', options: StateResponseOptions = {}): Promise<ArtboardStateResponse> {
    return this.post<ArtboardStateResponse>('/group-nodes', {
      sessionId,
      nodeIds,
      name,
      ...stateResponseOptions(options),
    });
  }

  async ungroupNodes(sessionId: string, nodeIds: string[], options: StateResponseOptions = {}): Promise<ArtboardStateResponse> {
    return this.post<ArtboardStateResponse>('/ungroup-nodes', {
      sessionId,
      nodeIds,
      ...stateResponseOptions(options),
    });
  }

  async deleteNode(sessionId: string, nodeId: string, options: StateResponseOptions = {}): Promise<ArtboardStateResponse> {
    return this.post<ArtboardStateResponse>('/delete-node', { sessionId, nodeId, ...stateResponseOptions(options) });
  }

  async undoArtboard(sessionId: string, options: StateResponseOptions = {}): Promise<ArtboardStateResponse> {
    return this.post<ArtboardStateResponse>('/undo-artboard', { sessionId, ...stateResponseOptions(options) });
  }

  async redoArtboard(sessionId: string, options: StateResponseOptions = {}): Promise<ArtboardStateResponse> {
    return this.post<ArtboardStateResponse>('/redo-artboard', { sessionId, ...stateResponseOptions(options) });
  }

  async saveArtboard(sessionId: string, targetPrefabPath?: string | null): Promise<SaveArtboardResponse> {
    return this.post<SaveArtboardResponse>('/save-artboard', {
      sessionId,
      targetPrefabPath: targetPrefabPath ?? '',
      note: 'UIEditor_new remote artboard save',
    });
  }

  async snapshotUrl(snapshot: SnapshotRecord): Promise<string> {
    if (snapshot.image.dataUrl) return snapshot.image.dataUrl;
    const baseUrl = await this.getBaseUrl();
    const rawUrl = snapshot.image.url || (snapshot.image.path ? `/snapshots/${snapshot.image.path.split('/').pop()}` : '');
    if (!rawUrl) {
      throw new EditorBridgeRequestError('SNAPSHOT_URL_MISSING', 'snapshot image URL is missing');
    }
    return `${baseUrl}${rawUrl.startsWith('/') ? rawUrl : `/${rawUrl}`}?v=${encodeURIComponent(snapshot.snapshotId)}`;
  }

  private async loadBaseUrl(): Promise<string> {
    try {
      const response = await fetch('/api/unity/config', { cache: 'no-store' });
      if (response.ok) {
        const data = await response.json() as UnityConfigResponse;
        if (data.editorBridgeUrl) return trimTrailingSlash(data.editorBridgeUrl);
      }
    } catch {
      // Dev server config is optional. The new bridge must still default to 18082.
    }
    return DEFAULT_EDITOR_BRIDGE_URL;
  }

  private async get<T extends BridgeBaseResponse>(path: string): Promise<T> {
    const baseUrl = await this.getBaseUrl();
    const startedAt = nowMs();
    try {
      const response = await this.fetchWithRetry(`${baseUrl}${path}`, { cache: 'no-store' });
      const status = response.status;
      const data = await this.parseResponse<T>(response);
      debugLog('bridge-http', 'get-ok', {
        path,
        status,
        elapsedMs: Math.round(nowMs() - startedAt),
        serverProfile: data.serverProfile,
      });
      return data;
    } catch (err) {
      debugLog('bridge-http', 'get-error', {
        path,
        elapsedMs: Math.round(nowMs() - startedAt),
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  private async post<T extends BridgeBaseResponse>(path: string, body: unknown): Promise<T> {
    const baseUrl = await this.getBaseUrl();
    const startedAt = nowMs();
    try {
      const response = await this.fetchWithRetry(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      });
      const status = response.status;
      const data = await this.parseResponse<T>(response);
      debugLog('bridge-http', 'post-ok', {
        path,
        status,
        elapsedMs: Math.round(nowMs() - startedAt),
        serverProfile: data.serverProfile,
        profileTotalMs: 'profile' in data && data.profile && typeof data.profile === 'object'
          ? (data.profile as { totalMs?: number }).totalMs
          : undefined,
      });
      return data;
    } catch (err) {
      debugLog('bridge-http', 'post-error', {
        path,
        elapsedMs: Math.round(nowMs() - startedAt),
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  private async fetchWithRetry(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await fetch(input, init);
      } catch (err) {
        lastError = err;
        if (attempt < 2) await delay(60 + attempt * 120);
      }
    }
    throw lastError;
  }

  private async parseResponse<T extends BridgeBaseResponse>(response: Response): Promise<T> {
    let data: BridgeBaseResponse | null = null;
    try {
      data = await response.json() as BridgeBaseResponse;
    } catch {
      data = null;
    }

    if (!response.ok) {
      throw new EditorBridgeRequestError(
        data?.error?.code || `HTTP_${response.status}`,
        data?.error?.message || `${response.status} ${response.statusText}`,
        data ?? undefined,
      );
    }

    if (!data) {
      throw new EditorBridgeRequestError('BAD_RESPONSE', 'Unity Editor Bridge returned a non-JSON response');
    }

    if (!data.ok) {
      throw new EditorBridgeRequestError(
        data.error?.code || 'BRIDGE_ERROR',
        data.error?.message || 'Unity Editor Bridge request failed',
        data,
      );
    }

    return data as T;
  }
}

export const editorBridgeClient = new EditorBridgeClient();
export default editorBridgeClient;

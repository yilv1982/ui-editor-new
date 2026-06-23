import { useEffect, useMemo, useRef, useState } from 'react';
import editorBridgeClient, {
  type BboxRecord,
  type ComponentRecord,
  type DiffSummary,
  type HealthResponse,
  type NodeRecord,
  type SavePrefabResponse,
  type SessionInfo,
  type SnapshotRecord,
  type ValidateProtectedDiffResponse,
} from '../../services/EditorBridgeClient';

const DEFAULT_PREFAB = 'UICommons/UIBlueBtn.prefab';
const SNAPSHOT_WIDTH = 1080;
const SNAPSHOT_HEIGHT = 1920;

interface PrefabListItem {
  name: string;
  relPath: string;
  category?: string;
}

interface DragState {
  nodeId: string;
  startClientX: number;
  startClientY: number;
  deltaX: number;
  deltaY: number;
}

interface VisualDraft {
  activeSelf: boolean;
  text: string;
  fontSize: string;
  textColor: string;
  imageColor: string;
  width: string;
  height: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pickBboxAtPoint(bboxes: BboxRecord[], x: number, y: number): BboxRecord | null {
  for (let i = bboxes.length - 1; i >= 0; i -= 1) {
    const bbox = bboxes[i];
    if (!bbox.activeInHierarchy || bbox.width <= 0 || bbox.height <= 0) continue;
    if (x >= bbox.x && x <= bbox.x + bbox.width && y >= bbox.y && y <= bbox.y + bbox.height) {
      return bbox;
    }
  }
  return null;
}

function compactPath(path: string): string {
  if (path.length <= 48) return path;
  return `.../${path.split('/').slice(-3).join('/')}`;
}

function getNodeSummary(node: NodeRecord | undefined): string {
  if (!node) return '未选择节点';
  const components = node.components?.map((item) => item.type).filter(Boolean).join(', ') || 'Transform';
  const pos = node.rectTransform?.anchoredPosition;
  const size = node.rectTransform?.sizeDelta;
  const posText = pos && pos.length >= 2 ? `pos ${Math.round(pos[0])}, ${Math.round(pos[1])}` : 'pos -';
  const sizeText = size && size.length >= 2 ? `size ${Math.round(size[0])} x ${Math.round(size[1])}` : 'size -';
  return `${node.name} / ${components} / ${posText} / ${sizeText}`;
}

function getSummaryText(summary: DiffSummary | undefined): string {
  if (!summary) return '未校验';
  return `allowed ${summary.allowedCount}, protected ${summary.protectedCount}`;
}

function findComponent(node: NodeRecord | undefined, type: string): ComponentRecord | undefined {
  return node?.components?.find((component) => component.type === type);
}

function summaryString(component: ComponentRecord | undefined, key: string): string {
  const value = component?.summary?.[key];
  return typeof value === 'string' ? value : '';
}

function summaryNumber(component: ComponentRecord | undefined, key: string): string {
  const value = component?.summary?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
}

function toColorInput(value: string): string {
  if (!value || !value.startsWith('#')) return '#ffffff';
  if (value.length >= 7) return value.slice(0, 7);
  return '#ffffff';
}

function withOpaqueAlpha(value: string): string {
  if (!value.startsWith('#')) return value;
  return value.length === 7 ? `${value}FF` : value;
}

function chooseDefaultSelection(rootNodeId: string, snapshot: SnapshotRecord): string | null {
  const visibleNode = snapshot.bboxes.find((bbox) => (
    bbox.activeInHierarchy &&
    bbox.width > 4 &&
    bbox.height > 4 &&
    bbox.width < snapshot.width * 0.95 &&
    bbox.height < snapshot.height * 0.95
  ));
  return visibleNode?.nodeId ?? rootNodeId ?? null;
}

export default function EditorBridgeCanvas() {
  const frameRef = useRef<HTMLDivElement>(null);
  const [bridgeHealth, setBridgeHealth] = useState<HealthResponse | null>(null);
  const [prefabInput, setPrefabInput] = useState(DEFAULT_PREFAB);
  const [prefabs, setPrefabs] = useState<PrefabListItem[]>([]);
  const [showPrefabList, setShowPrefabList] = useState(false);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [baseRevision, setBaseRevision] = useState<string | null>(null);
  const [currentRevision, setCurrentRevision] = useState<string | null>(null);
  const [nodes, setNodes] = useState<NodeRecord[]>([]);
  const [snapshot, setSnapshot] = useState<SnapshotRecord | null>(null);
  const [snapshotUrl, setSnapshotUrl] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [validation, setValidation] = useState<ValidateProtectedDiffResponse | null>(null);
  const [saved, setSaved] = useState<SavePrefabResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState('等待打开临时 Prefab');
  const [error, setError] = useState<string | null>(null);
  const [frameRect, setFrameRect] = useState({ width: 0, height: 0 });
  const [visualDraft, setVisualDraft] = useState<VisualDraft>({
    activeSelf: true,
    text: '',
    fontSize: '',
    textColor: '#ffffff',
    imageColor: '#ffffff',
    width: '',
    height: '',
  });

  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.nodeId, node])), [nodes]);
  const selectedNode = selectedNodeId ? nodeById.get(selectedNodeId) : undefined;
  const activeBboxes = useMemo(
    () => snapshot?.bboxes?.filter((bbox) => bbox.activeInHierarchy && bbox.width > 1 && bbox.height > 1) ?? [],
    [snapshot],
  );
  const displayScale = useMemo(() => {
    if (frameRect.width <= 0 || frameRect.height <= 0) return 0.4;
    return Math.min(frameRect.width / SNAPSHOT_WIDTH, frameRect.height / SNAPSHOT_HEIGHT, 1.1);
  }, [frameRect]);

  const filteredPrefabs = useMemo(() => {
    const keyword = prefabInput.trim().toLowerCase();
    if (!keyword) return prefabs.slice(0, 60);
    return prefabs
      .filter((item) => item.relPath.toLowerCase().includes(keyword) || item.name.toLowerCase().includes(keyword))
      .slice(0, 80);
  }, [prefabInput, prefabs]);

  useEffect(() => {
    const text = findComponent(selectedNode, 'Text');
    const image = findComponent(selectedNode, 'Image');
    const size = selectedNode?.rectTransform?.sizeDelta;
    setVisualDraft({
      activeSelf: selectedNode?.activeSelf ?? true,
      text: summaryString(text, 'text'),
      fontSize: summaryNumber(text, 'fontSize'),
      textColor: toColorInput(summaryString(text, 'color')),
      imageColor: toColorInput(summaryString(image, 'color')),
      width: size && size.length >= 2 ? String(Math.round(size[0])) : '',
      height: size && size.length >= 2 ? String(Math.round(size[1])) : '',
    });
  }, [selectedNode]);

  useEffect(() => {
    let cancelled = false;
    void editorBridgeClient.health()
      .then((health) => {
        if (!cancelled) {
          setBridgeHealth(health);
          setStatus(`Bridge ${health.version} 已连接`);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(errorMessage(err));
          setStatus('Unity Editor Bridge 未连接');
        }
      });
    return () => {
      cancelled = true;
    };
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
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const update = () => {
      const rect = frame.getBoundingClientRect();
      setFrameRect({ width: Math.max(0, rect.width - 32), height: Math.max(0, rect.height - 32) });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  const setSnapshotState = async (nextSnapshot: SnapshotRecord) => {
    setSnapshot(nextSnapshot);
    setSnapshotUrl(await editorBridgeClient.snapshotUrl(nextSnapshot));
  };

  const refreshTreeAndSnapshot = async (sessionId: string, nextSelectedNodeId?: string | null) => {
    const tree = await editorBridgeClient.exportNodeTree(sessionId);
    const image = await editorBridgeClient.renderSnapshot(sessionId);
    setNodes(tree.nodes);
    setCurrentRevision(image.revision);
    await setSnapshotState(image.snapshot);
    if (nextSelectedNodeId !== undefined) {
      setSelectedNodeId(nextSelectedNodeId);
    } else if (selectedNodeId && tree.nodes.some((node) => node.nodeId === selectedNodeId)) {
      setSelectedNodeId(selectedNodeId);
    } else {
      setSelectedNodeId(chooseDefaultSelection(tree.rootNodeId, image.snapshot));
    }
  };

  const runBusy = async (label: string, action: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(errorMessage(err));
      setStatus(`${label}失败`);
    } finally {
      setBusy(null);
    }
  };

  const openPrefab = () => runBusy('打开 Prefab', async () => {
    if (session) {
      await editorBridgeClient.closePrefab(session.sessionId, false).catch(() => {});
    }
    setValidation(null);
    setSaved(null);
    const opened = await editorBridgeClient.openPrefab(prefabInput.trim() || DEFAULT_PREFAB, 'temp-copy');
    setSession(opened.session);
    setBaseRevision(opened.session.revision);
    setCurrentRevision(opened.session.revision);
    await refreshTreeAndSnapshot(opened.session.sessionId);
    setStatus(`已打开临时副本: ${opened.session.workingPrefabPath}`);
  });

  const refreshSnapshot = () => runBusy('刷新截图', async () => {
    if (!session) return;
    await refreshTreeAndSnapshot(session.sessionId);
    setStatus('已刷新 Unity 真值截图');
  });

  const validateDiff = () => runBusy('保护校验', async () => {
    if (!session || !baseRevision || !currentRevision) return;
    const result = await editorBridgeClient.validateProtectedDiff(session.sessionId, baseRevision, currentRevision);
    setValidation(result);
    setStatus(`保护校验通过: ${getSummaryText(result.summary)}`);
  });

  const applyVisualField = (field: string) => runBusy('应用视觉字段', async () => {
    if (!session || !currentRevision || !selectedNode) return;

    const operation = (() => {
      if (field === 'activeSelf') {
        return {
          nodeId: selectedNode.nodeId,
          field,
          boolValue: visualDraft.activeSelf,
          source: { kind: 'property-panel' },
        };
      }
      if (field === 'Text.text') {
        return {
          nodeId: selectedNode.nodeId,
          field,
          stringValue: visualDraft.text,
          source: { kind: 'property-panel' },
        };
      }
      if (field === 'Text.fontSize') {
        return {
          nodeId: selectedNode.nodeId,
          field,
          numberValue: Number(visualDraft.fontSize),
          source: { kind: 'property-panel' },
        };
      }
      if (field === 'Text.color') {
        return {
          nodeId: selectedNode.nodeId,
          field,
          stringValue: withOpaqueAlpha(visualDraft.textColor),
          source: { kind: 'property-panel' },
        };
      }
      if (field === 'Image.color') {
        return {
          nodeId: selectedNode.nodeId,
          field,
          stringValue: withOpaqueAlpha(visualDraft.imageColor),
          source: { kind: 'property-panel' },
        };
      }
      if (field === 'rectTransform.sizeDelta') {
        return {
          nodeId: selectedNode.nodeId,
          field,
          value: [Number(visualDraft.width), Number(visualDraft.height)],
          source: { kind: 'property-panel' },
        };
      }
      return null;
    })();

    if (!operation) return;
    const result = await editorBridgeClient.applyVisualPatch(
      session.sessionId,
      editorBridgeClient.createSetPatch(currentRevision, operation),
    );
    setValidation(null);
    setSaved(null);
    setCurrentRevision(result.revision);
    if (result.snapshot) await setSnapshotState(result.snapshot);
    const tree = await editorBridgeClient.exportNodeTree(session.sessionId);
    setNodes(tree.nodes);
    setSelectedNodeId(selectedNode.nodeId);
    setStatus(`字段 patch 已回放: ${field}, applied ${result.applied.length}, rejected ${result.rejected.length}, ${getSummaryText(result.protectedDiff?.summary)}`);
  });

  const saveTempCopy = () => runBusy('保存临时副本', async () => {
    if (!session || !validation?.validationId) return;
    const result = await editorBridgeClient.savePrefab(session.sessionId, validation.validationId, 'UIEditor_new Web screenshot overlay MVP');
    setSaved(result);
    setStatus(`已保存临时副本: ${result.savedPath}`);
  });

  const closeSession = (deleteTempObjects: boolean) => runBusy('关闭 Prefab', async () => {
    if (!session) return;
    await editorBridgeClient.closePrefab(session.sessionId, deleteTempObjects);
    setSession(null);
    setBaseRevision(null);
    setCurrentRevision(null);
    setNodes([]);
    setSnapshot(null);
    setSnapshotUrl(null);
    setSelectedNodeId(null);
    setValidation(null);
    setSaved(null);
    setStatus(deleteTempObjects ? '已关闭并清理临时对象' : '已关闭，会保留临时副本资产');
  });

  const onFramePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!snapshot || busy) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - rect.left) / displayScale;
    const y = (event.clientY - rect.top) / displayScale;
    const hit = pickBboxAtPoint(activeBboxes, x, y);
    if (!hit) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setSelectedNodeId(hit.nodeId);
    setValidation(null);
    setSaved(null);
    setDrag({
      nodeId: hit.nodeId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      deltaX: 0,
      deltaY: 0,
    });
  };

  const onFramePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!snapshot) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - rect.left) / displayScale;
    const y = (event.clientY - rect.top) / displayScale;
    const hit = pickBboxAtPoint(activeBboxes, x, y);
    setHoveredNodeId(hit?.nodeId ?? null);
    if (!drag) return;
    setDrag({
      ...drag,
      deltaX: (event.clientX - drag.startClientX) / displayScale,
      deltaY: (event.clientY - drag.startClientY) / displayScale,
    });
  };

  const commitDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!drag || !session || !currentRevision) {
      setDrag(null);
      return;
    }
    event.currentTarget.releasePointerCapture(event.pointerId);
    const deltaX = Math.round(drag.deltaX);
    const deltaY = Math.round(drag.deltaY);
    setDrag(null);
    if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) return;

    void runBusy('应用视觉 patch', async () => {
      const result = await editorBridgeClient.applyDragPatch({
        sessionId: session.sessionId,
        baseRevision: currentRevision,
        nodeId: drag.nodeId,
        deltaX,
        deltaY,
      });
      setCurrentRevision(result.revision);
      if (result.snapshot) await setSnapshotState(result.snapshot);
      const tree = await editorBridgeClient.exportNodeTree(session.sessionId);
      setNodes(tree.nodes);
      setSelectedNodeId(drag.nodeId);
      const rejected = result.rejected?.length ?? 0;
      const applied = result.applied?.length ?? 0;
      setStatus(`patch 已回放: applied ${applied}, rejected ${rejected}, ${getSummaryText(result.protectedDiff?.summary)}`);
    });
  };

  const selectedBbox = selectedNodeId ? activeBboxes.find((bbox) => bbox.nodeId === selectedNodeId) : undefined;
  const bridgeReady = bridgeHealth?.name === 'UIEditorNewBridge';
  const selectedText = findComponent(selectedNode, 'Text');
  const selectedImage = findComponent(selectedNode, 'Image');
  const canEditSize = selectedNode?.editableFields?.includes('rectTransform.sizeDelta') ?? false;

  return (
    <div className="flex-1 min-w-0 flex flex-col bg-[#11111b] border-x border-[#313244]">
      <div className="shrink-0 flex flex-wrap items-center gap-2 border-b border-[#313244] bg-[#181825] px-3 py-2">
        <div className={`w-2.5 h-2.5 rounded-full ${bridgeReady ? 'bg-[#a6e3a1]' : 'bg-[#f38ba8]'}`} title={bridgeReady ? 'UIEditorNewBridge 已连接' : 'UIEditorNewBridge 未连接'} />
        <div className="text-[12px] text-[#a6adc8] min-w-[160px]">
          {bridgeReady ? `${bridgeHealth.name} ${bridgeHealth.version}` : 'Bridge offline'}
        </div>

        <div className="relative">
          <input
            data-testid="editor-bridge-prefab-input"
            value={prefabInput}
            onChange={(event) => {
              setPrefabInput(event.target.value);
              setShowPrefabList(true);
            }}
            onFocus={() => setShowPrefabList(true)}
            onBlur={() => setTimeout(() => setShowPrefabList(false), 150)}
            placeholder="UICommons/UIBlueBtn.prefab"
            className="w-[280px] text-[12px]"
          />
          {showPrefabList && filteredPrefabs.length > 0 && (
            <div className="absolute left-0 top-full z-30 mt-1 max-h-[320px] w-[360px] overflow-auto rounded border border-[#45475a] bg-[#1e1e2e] shadow-xl">
              {filteredPrefabs.map((item) => (
                <button
                  key={item.relPath}
                  type="button"
                  className="block w-full px-2 py-1.5 text-left text-[12px] hover:bg-[#313244]"
                  onMouseDown={(event) => {
                    event.preventDefault();
                    setPrefabInput(item.relPath);
                    setShowPrefabList(false);
                  }}
                >
                  <div className="text-[#cdd6f4]">{item.name}</div>
                  <div className="truncate text-[10px] text-[#6c7086]">{item.relPath}</div>
                </button>
              ))}
            </div>
          )}
        </div>

        <button data-testid="editor-bridge-open-prefab" disabled={!!busy} onClick={openPrefab} className="rounded bg-[#89b4fa] px-3 py-1 text-[12px] font-semibold text-[#11111b] disabled:cursor-wait disabled:bg-[#45475a]">
          打开临时副本
        </button>
        <button data-testid="editor-bridge-refresh-snapshot" disabled={!session || !!busy} onClick={refreshSnapshot} className="rounded bg-[#313244] px-3 py-1 text-[12px] text-[#cdd6f4] disabled:text-[#6c7086]">
          刷新截图
        </button>
        <button data-testid="editor-bridge-validate-diff" disabled={!session || !!busy} onClick={validateDiff} className="rounded bg-[#a6e3a1] px-3 py-1 text-[12px] font-semibold text-[#11111b] disabled:bg-[#45475a] disabled:text-[#6c7086]">
          保护校验
        </button>
        <button data-testid="editor-bridge-save-copy" disabled={!validation?.validationId || !!busy} onClick={saveTempCopy} className="rounded bg-[#f9e2af] px-3 py-1 text-[12px] font-semibold text-[#11111b] disabled:bg-[#45475a] disabled:text-[#6c7086]">
          保存副本
        </button>
        <button data-testid="editor-bridge-close" disabled={!session || !!busy} onClick={() => void closeSession(false)} className="rounded bg-[#313244] px-3 py-1 text-[12px] text-[#cdd6f4] disabled:text-[#6c7086]">
          关闭
        </button>
      </div>

      <div className="shrink-0 grid grid-cols-[minmax(0,1fr)_320px] gap-0 border-b border-[#313244] bg-[#181825]">
        <div data-testid="editor-bridge-status" className="min-w-0 px-3 py-2 text-[12px] text-[#a6adc8]">
          <span className="text-[#89b4fa]">{busy ?? 'Ready'}</span>
          <span className="mx-2 text-[#45475a]">/</span>
          <span>{status}</span>
          {error && <span className="ml-3 text-[#f38ba8]">{error}</span>}
        </div>
        <div className="border-l border-[#313244] px-3 py-2 text-[12px] text-[#a6adc8]">
          <div className="truncate text-[#cdd6f4]" title={selectedNode?.path}>{getNodeSummary(selectedNode)}</div>
          <div className="mt-1 flex gap-3 text-[#6c7086]">
            <span>{currentRevision ?? '-'}</span>
            <span>{nodes.length} nodes</span>
            <span>{getSummaryText(validation?.summary)}</span>
          </div>
        </div>
      </div>

      <div ref={frameRef} className="relative flex-1 overflow-hidden bg-[#11111b]">
        {!snapshotUrl && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-[460px] max-w-[80%] border border-[#313244] bg-[#181825] p-5">
              <div className="text-sm font-semibold text-[#cdd6f4]">UIEditor_new Screenshot Bridge</div>
              <div className="mt-2 text-[12px] leading-5 text-[#a6adc8]">
                打开临时 Prefab 后，这里显示 Unity Editor 渲染的真值截图。节点框来自同一次截图的 bbox，拖拽松手后只提交 RectTransform 视觉 patch。
              </div>
              <div className="mt-4 text-[12px] text-[#6c7086]">
                默认样本: {DEFAULT_PREFAB}
              </div>
            </div>
          </div>
        )}

        {snapshotUrl && snapshot && (
          <div className="absolute inset-0 flex items-center justify-center p-4">
            <div
              data-testid="editor-bridge-snapshot-frame"
              className="relative shrink-0 bg-[#162D3F] shadow-2xl ring-1 ring-[#313244]"
              style={{ width: snapshot.width * displayScale, height: snapshot.height * displayScale }}
              onPointerDown={onFramePointerDown}
              onPointerMove={onFramePointerMove}
              onPointerUp={commitDrag}
              onPointerCancel={() => setDrag(null)}
              onPointerLeave={() => setHoveredNodeId(null)}
            >
              <img
                src={snapshotUrl}
                alt="Unity Editor snapshot"
                draggable={false}
                className="absolute inset-0 h-full w-full select-none"
              />
              <div className="absolute inset-0">
                {activeBboxes.map((bbox) => {
                  const isSelected = bbox.nodeId === selectedNodeId;
                  const isHovered = bbox.nodeId === hoveredNodeId;
                  const dx = drag?.nodeId === bbox.nodeId ? drag.deltaX * displayScale : 0;
                  const dy = drag?.nodeId === bbox.nodeId ? drag.deltaY * displayScale : 0;
                  return (
                    <div
                      key={`${bbox.nodeId}-${bbox.path}`}
                      data-testid="editor-bridge-bbox"
                      data-node-id={bbox.nodeId}
                      data-node-path={bbox.path}
                      className="absolute cursor-move select-none"
                      title={bbox.path}
                      style={{
                        left: bbox.x * displayScale + dx,
                        top: bbox.y * displayScale + dy,
                        width: bbox.width * displayScale,
                        height: bbox.height * displayScale,
                        border: isSelected ? '2px solid #89b4fa' : isHovered ? '1px solid #f9e2af' : '1px solid rgba(137,180,250,0.16)',
                        background: isSelected ? 'rgba(137,180,250,0.10)' : isHovered ? 'rgba(249,226,175,0.08)' : 'transparent',
                      }}
                    >
                      {(isSelected || isHovered) && (
                        <div className="absolute left-0 top-0 -translate-y-full whitespace-nowrap bg-[#11111b] px-1.5 py-0.5 text-[10px] text-[#cdd6f4]">
                          {compactPath(bbox.path || nodeById.get(bbox.nodeId)?.path || bbox.nodeId)}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
              {selectedBbox && (
                <div
                  className="pointer-events-none absolute"
                  style={{
                    left: selectedBbox.x * displayScale - 4,
                    top: selectedBbox.y * displayScale - 4,
                    width: selectedBbox.width * displayScale + 8,
                    height: selectedBbox.height * displayScale + 8,
                    border: '1px dashed #f38ba8',
                  }}
                />
              )}
            </div>
          </div>
        )}
        {snapshotUrl && selectedNode && (
          <div data-testid="editor-bridge-property-panel" className="absolute right-3 top-3 z-30 w-[300px] border border-[#313244] bg-[#181825]/95 p-3 text-[12px] shadow-2xl backdrop-blur">
            <div data-testid="editor-bridge-selected-path" className="mb-2 truncate font-semibold text-[#cdd6f4]" title={selectedNode.path}>
              {compactPath(selectedNode.path)}
            </div>
            <div className="mb-3 flex items-center justify-between border-b border-[#313244] pb-2">
              <span className="text-[#a6adc8]">activeSelf</span>
              <label className="flex items-center gap-2 text-[#cdd6f4]">
                <input
                  data-testid="editor-bridge-active-input"
                  type="checkbox"
                  checked={visualDraft.activeSelf}
                  onChange={(event) => setVisualDraft((draft) => ({ ...draft, activeSelf: event.target.checked }))}
                />
                <button
                  data-testid="editor-bridge-apply-active"
                  type="button"
                  disabled={busy !== null || !selectedNode.editableFields.includes('activeSelf')}
                  onClick={() => applyVisualField('activeSelf')}
                  className="rounded bg-[#313244] px-2 py-1 text-[11px] text-[#cdd6f4] disabled:text-[#6c7086]"
                >
                  应用
                </button>
              </label>
            </div>

            {selectedText && (
              <div className="mb-3 border-b border-[#313244] pb-3">
                <div className="mb-2 text-[#89b4fa]">Text</div>
                <label className="mb-2 block text-[#a6adc8]">
                  text
                  <div className="mt-1 flex gap-1">
                    <input
                      data-testid="editor-bridge-text-input"
                      type="text"
                      value={visualDraft.text}
                      onChange={(event) => setVisualDraft((draft) => ({ ...draft, text: event.target.value }))}
                      className="min-w-0 flex-1 text-[12px]"
                    />
                    <button type="button" data-testid="editor-bridge-apply-text" disabled={busy !== null} onClick={() => applyVisualField('Text.text')} className="rounded bg-[#313244] px-2 text-[#cdd6f4] disabled:text-[#6c7086]">
                      应用
                    </button>
                  </div>
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <label className="text-[#a6adc8]">
                    fontSize
                    <div className="mt-1 flex gap-1">
                      <input
                        data-testid="editor-bridge-font-size-input"
                        type="number"
                        value={visualDraft.fontSize}
                        onChange={(event) => setVisualDraft((draft) => ({ ...draft, fontSize: event.target.value }))}
                        className="w-full text-[12px]"
                      />
                      <button type="button" data-testid="editor-bridge-apply-font-size" disabled={busy !== null} onClick={() => applyVisualField('Text.fontSize')} className="rounded bg-[#313244] px-2 text-[#cdd6f4] disabled:text-[#6c7086]">
                        应用
                      </button>
                    </div>
                  </label>
                  <label className="text-[#a6adc8]">
                    color
                    <div className="mt-1 flex gap-1">
                      <input
                        data-testid="editor-bridge-text-color-input"
                        type="color"
                        value={visualDraft.textColor}
                        onChange={(event) => setVisualDraft((draft) => ({ ...draft, textColor: event.target.value }))}
                        className="h-[30px] w-full p-0"
                      />
                      <button type="button" data-testid="editor-bridge-apply-text-color" disabled={busy !== null} onClick={() => applyVisualField('Text.color')} className="rounded bg-[#313244] px-2 text-[#cdd6f4] disabled:text-[#6c7086]">
                        应用
                      </button>
                    </div>
                  </label>
                </div>
              </div>
            )}

            {selectedImage && (
              <div className="mb-3 border-b border-[#313244] pb-3">
                <div className="mb-2 text-[#a6e3a1]">Image</div>
                <label className="text-[#a6adc8]">
                  color
                  <div className="mt-1 flex gap-1">
                    <input
                      data-testid="editor-bridge-image-color-input"
                      type="color"
                      value={visualDraft.imageColor}
                      onChange={(event) => setVisualDraft((draft) => ({ ...draft, imageColor: event.target.value }))}
                      className="h-[30px] w-full p-0"
                    />
                    <button type="button" data-testid="editor-bridge-apply-image-color" disabled={busy !== null} onClick={() => applyVisualField('Image.color')} className="rounded bg-[#313244] px-2 text-[#cdd6f4] disabled:text-[#6c7086]">
                      应用
                    </button>
                  </div>
                </label>
              </div>
            )}

            {canEditSize && (
              <div>
                <div className="mb-2 text-[#f9e2af]">RectTransform</div>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    data-testid="editor-bridge-size-width-input"
                    type="number"
                    value={visualDraft.width}
                    onChange={(event) => setVisualDraft((draft) => ({ ...draft, width: event.target.value }))}
                    aria-label="size width"
                    className="text-[12px]"
                  />
                  <input
                    data-testid="editor-bridge-size-height-input"
                    type="number"
                    value={visualDraft.height}
                    onChange={(event) => setVisualDraft((draft) => ({ ...draft, height: event.target.value }))}
                    aria-label="size height"
                    className="text-[12px]"
                  />
                </div>
                <button type="button" data-testid="editor-bridge-apply-size" disabled={busy !== null} onClick={() => applyVisualField('rectTransform.sizeDelta')} className="mt-2 rounded bg-[#313244] px-2 py-1 text-[#cdd6f4] disabled:text-[#6c7086]">
                  应用 sizeDelta
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="shrink-0 grid grid-cols-3 border-t border-[#313244] bg-[#181825] text-[11px] text-[#6c7086]">
        <div className="truncate px-3 py-2" title={session?.sourcePrefabPath}>source: {session?.sourcePrefabPath ?? '-'}</div>
        <div className="truncate border-x border-[#313244] px-3 py-2" title={session?.workingPrefabPath}>working: {session?.workingPrefabPath ?? '-'}</div>
        <div className="truncate px-3 py-2" title={saved?.savedPath}>saved: {saved?.savedPath ?? '-'}</div>
      </div>
    </div>
  );
}

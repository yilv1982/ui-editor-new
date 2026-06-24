import { useEffect, useState } from 'react';
import { useEditorStore } from '../../stores/editorStore';
import { ASSET_PATHS } from '../../config/assetPaths';
import {
  clearActiveBridgeArtboardChildren,
  deleteNodesOnBridge,
  redoActiveBridgeArtboard,
  saveActiveBridgeArtboard,
  undoActiveBridgeArtboard,
} from '../../services/BridgeArtboardStore';
import { refreshPrefabThumbnailFromBridge } from './PrefabThumbnail';

const DEFAULT_PREFAB_ROOT = ASSET_PATHS.prefab.replace(/\\/g, '/');

type SaveDialogMode = 'save' | 'saveAs';

interface SaveTargetDraft {
  directory: string;
  prefabName: string;
}

interface SaveDirectoryOption {
  path: string;
  label: string;
  depth: number;
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+/g, '/').trim();
}

function stripPrefabExtension(value: string): string {
  return value.trim().replace(/\.prefab$/i, '');
}

function defaultDraftFromPath(pathValue: string | null | undefined, fallbackName: string): SaveTargetDraft {
  if (!pathValue) return { directory: '', prefabName: stripPrefabExtension(fallbackName || 'NewUI') || 'NewUI' };
  const normalized = normalizeSlashes(pathValue);
  const relative = normalized.startsWith(`${DEFAULT_PREFAB_ROOT}/`)
    ? normalized.slice(DEFAULT_PREFAB_ROOT.length + 1)
    : normalized;
  const parts = relative.split('/').filter(Boolean);
  const file = parts.pop() || fallbackName || 'NewUI';
  return {
    directory: parts.join('/'),
    prefabName: stripPrefabExtension(file) || stripPrefabExtension(fallbackName || 'NewUI') || 'NewUI',
  };
}

function buildTargetPath(draft: SaveTargetDraft): string {
  const dir = normalizeSlashes(draft.directory).replace(/^\/+|\/+$/g, '');
  const name = stripPrefabExtension(draft.prefabName);
  return `${DEFAULT_PREFAB_ROOT}${dir ? `/${dir}` : ''}/${name}.prefab`;
}

function validateSaveDraft(draft: SaveTargetDraft): string | null {
  const name = stripPrefabExtension(draft.prefabName);
  const dir = normalizeSlashes(draft.directory).replace(/^\/+|\/+$/g, '');
  if (!name) return '请输入 Prefab 名字';
  if (/[<>:"|?*\x00-\x1F/\\]/.test(name)) return 'Prefab 名字不能包含 / \\ : * ? " < > |';
  if (name === '.' || name === '..') return 'Prefab 名字不合法';
  if (/^[A-Za-z]:/.test(dir) || dir.startsWith('Assets/')) return '目录只填写相对路径，不要输入 Assets 开头的完整路径';
  if (dir.split('/').some((part) => part === '..' || part === '.')) return '目录不能包含 . 或 ..';
  if (/[<>:"|?*\x00-\x1F]/.test(dir)) return '目录不能包含 : * ? " < > |';
  return null;
}

async function targetExists(targetPath: string): Promise<boolean> {
  try {
    const res = await fetch('/api/prefabs/list');
    if (!res.ok) return false;
    const data = await res.json();
    const normalizedTarget = normalizeSlashes(targetPath);
    const relativeTarget = normalizedTarget.startsWith(`${DEFAULT_PREFAB_ROOT}/`)
      ? normalizedTarget.slice(DEFAULT_PREFAB_ROOT.length + 1)
      : normalizedTarget;
    return Array.isArray(data.prefabs) && data.prefabs.some((item: any) => normalizeSlashes(item.relPath || '') === relativeTarget);
  } catch {
    return false;
  }
}

function formatBridgeSaveError(err: any): string {
  const protectedDiff = err?.response?.protectedDiff;
  const protectedChanges = Array.isArray(protectedDiff?.protectedChanges) ? protectedDiff.protectedChanges : [];
  if (protectedChanges.length === 0) return err?.message || String(err);
  const details = protectedChanges.slice(0, 3).map((change: any) => {
    const field = change?.field || 'protected';
    const before = String(change?.before ?? '').slice(0, 80);
    const after = String(change?.after ?? '').slice(0, 80);
    return `${field}: ${before} -> ${after}`;
  }).join('；');
  return `${err?.message || '保存被保护校验拦截'}（${protectedChanges.length} 项：${details}）`;
}

function directoryOptionsFromPrefabs(prefabs: any[]): SaveDirectoryOption[] {
  const dirs = new Set<string>(['']);
  for (const item of prefabs) {
    const relPath = normalizeSlashes(String(item?.relPath || ''));
    if (!relPath || !relPath.endsWith('.prefab')) continue;
    const parts = relPath.split('/').filter(Boolean);
    parts.pop();
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      dirs.add(current);
    }
  }
  return [...dirs].sort((a, b) => {
    if (a === '') return -1;
    if (b === '') return 1;
    return a.localeCompare(b);
  }).map((dir) => {
    const parts = dir ? dir.split('/') : [];
    return {
      path: dir,
      label: dir ? parts[parts.length - 1] : 'Prefabs 根目录',
      depth: Math.max(0, parts.length - 1),
    };
  });
}

async function loadPrefabDirectories(): Promise<SaveDirectoryOption[]> {
  try {
    const res = await fetch('/api/prefabs/list');
    if (!res.ok) return directoryOptionsFromPrefabs([]);
    const data = await res.json();
    return directoryOptionsFromPrefabs(Array.isArray(data.prefabs) ? data.prefabs : []);
  } catch {
    return directoryOptionsFromPrefabs([]);
  }
}

export default function Toolbar() {
  const { canvasScale, setCanvasTransform, canvasX, canvasY, selectedIds } = useEditorStore();
  const rootNodeName = useEditorStore((s) => {
    const id = s.rootIds[0];
    if (!id) return '';
    return (s.nodes[id]?.name || '').replace(/^@/, '');
  });
  const [lastSaveTime, setLastSaveTime] = useState('');
  const [saving, setSaving] = useState(false);
  const [onlineCount, setOnlineCount] = useState(0);
  const [saveDirectories, setSaveDirectories] = useState<SaveDirectoryOption[]>(() => directoryOptionsFromPrefabs([]));
  const [saveDirectoryQuery, setSaveDirectoryQuery] = useState('');
  const [saveDialog, setSaveDialog] = useState<{
    mode: SaveDialogMode;
    draft: SaveTargetDraft;
    sourcePath: string | null;
    targetPath: string;
    exists: boolean | null;
    checking: boolean;
    error: string | null;
    allowOverwrite: boolean;
  } | null>(null);

  const handleDelete = () => {
    void deleteNodesOnBridge(selectedIds);
  };

  const currentArtboard = () => {
    const state = useEditorStore.getState();
    return state.pages
      .find((page) => page.id === state.activePageId)
      ?.artboards.find((artboard) => artboard.id === state.activeArtboardId) ?? null;
  };

  const performSave = async (target: string | null, saveAs = false) => {
    setSaving(true);
    setLastSaveTime(saveAs ? '另存为...' : '保存中...');
    try {
      const result = await saveActiveBridgeArtboard(target, { saveAs });
      setLastSaveTime(`已保存: ${result.savedPath}，正在更新预览图...`);
      await refreshPrefabThumbnailFromBridge(result.savedPath, ['content', 'canvas']);
      setLastSaveTime(`已保存: ${result.savedPath}`);
    } catch (err: any) {
      setLastSaveTime(`保存失败: ${formatBridgeSaveError(err)}`);
    } finally {
      setSaving(false);
      setTimeout(() => setLastSaveTime(''), 5000);
    }
  };

  const openSaveDialog = (mode: SaveDialogMode) => {
    const active = currentArtboard();
    const sourcePath = active?.sourcePrefabPath ?? null;
    const fallbackName = active?.name || rootNodeName || 'NewUI';
    const draft = defaultDraftFromPath(mode === 'saveAs' ? (active?.bridgeTargetPrefabPath || sourcePath) : sourcePath, fallbackName);
    const targetPath = buildTargetPath(draft);
    setSaveDialog({
      mode,
      draft,
      sourcePath,
      targetPath,
      exists: null,
      checking: true,
      error: validateSaveDraft(draft),
      allowOverwrite: false,
    });
    void targetExists(targetPath).then((exists) => {
      setSaveDialog((dialog) => dialog && dialog.targetPath === targetPath ? { ...dialog, exists, checking: false } : dialog);
    });
    setSaveDirectoryQuery('');
    void loadPrefabDirectories().then(setSaveDirectories);
  };

  const updateSaveDraft = (patch: Partial<SaveTargetDraft>) => {
    setSaveDialog((dialog) => {
      if (!dialog) return dialog;
      const draft = { ...dialog.draft, ...patch };
      const targetPath = buildTargetPath(draft);
      const error = validateSaveDraft(draft);
      void targetExists(targetPath).then((exists) => {
        setSaveDialog((latest) => latest && latest.targetPath === targetPath ? { ...latest, exists, checking: false } : latest);
      });
      return {
        ...dialog,
        draft,
        targetPath,
        error,
        exists: null,
        checking: !error,
        allowOverwrite: false,
      };
    });
  };

  const submitSaveDialog = () => {
    if (!saveDialog || saveDialog.error || saveDialog.checking) return;
    const sameAsSource = !!saveDialog.sourcePath && normalizeSlashes(saveDialog.sourcePath) === saveDialog.targetPath;
    if (saveDialog.exists && !sameAsSource && !saveDialog.allowOverwrite) {
      setSaveDialog((dialog) => dialog ? { ...dialog, error: '目标 Prefab 已存在，请确认覆盖后再保存' } : dialog);
      return;
    }
    const target = saveDialog.targetPath;
    const saveAs = saveDialog.mode === 'saveAs' || !saveDialog.sourcePath;
    setSaveDialog(null);
    void performSave(target, saveAs);
  };

  const filteredDirectories = saveDirectories.filter((dir) => {
    const query = saveDirectoryQuery.trim().toLowerCase();
    if (!query) return true;
    return dir.path.toLowerCase().includes(query) || dir.label.toLowerCase().includes(query);
  });

  const handleSave = (saveAs = false) => {
    const active = currentArtboard();
    if (!active?.sourcePrefabPath || saveAs) {
      openSaveDialog(saveAs ? 'saveAs' : 'save');
      return;
    }
    void performSave(null, false);
  };

  useEffect(() => {
    const onSave = () => {
      handleSave();
    };
    const onSaveAs = () => {
      handleSave(true);
    };
    window.addEventListener('uieditor:save', onSave);
    window.addEventListener('uieditor:save-as', onSaveAs);
    return () => {
      window.removeEventListener('uieditor:save', onSave);
      window.removeEventListener('uieditor:save-as', onSaveAs);
    };
  }, [rootNodeName]);

  useEffect(() => {
    let sessionId = sessionStorage.getItem('uieditor_session_id');
    if (!sessionId) {
      sessionId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      sessionStorage.setItem('uieditor_session_id', sessionId);
    }
    const sid = sessionId;
    let cancelled = false;
    const beat = async () => {
      try {
        const res = await fetch('/api/presence/heartbeat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: sid }),
        });
        if (cancelled) return;
        if (res.ok) {
          const data = await res.json();
          setOnlineCount(data.count || 0);
        }
      } catch {
        // dev server presence is optional for editing.
      }
    };

    beat();
    const timer = setInterval(beat, 10_000);
    const onLeave = () => {
      try {
        navigator.sendBeacon?.(
          '/api/presence/leave',
          new Blob([JSON.stringify({ sessionId: sid })], { type: 'application/json' }),
        );
      } catch {
        // ignore best-effort presence cleanup
      }
    };
    window.addEventListener('beforeunload', onLeave);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener('beforeunload', onLeave);
      onLeave();
    };
  }, []);

  return (
    <div className="h-10 bg-[#1e1e2e] border-b border-[#313244] flex items-center px-3 gap-2 shrink-0">
      <span className="text-sm font-bold text-[#89b4fa] mr-3">UIEditor New</span>

      <div
        className="flex items-center gap-1 px-2 py-1 text-xs text-[#a6adc8] bg-[#313244] rounded"
        title={`当前在线 ${onlineCount} 人`}
      >
        <div className={`w-1.5 h-1.5 rounded-full ${onlineCount > 0 ? 'bg-[#a6e3a1]' : 'bg-[#6c7086]'}`} />
        <span>在线 {onlineCount}</span>
      </div>

      <div className="w-px h-5 bg-[#313244]" />

      <button onClick={() => void undoActiveBridgeArtboard()} className="px-2 py-1 text-sm text-[#a6adc8] hover:bg-[#313244] rounded" title="撤销 (Ctrl+Z)">↶</button>
      <button onClick={() => void redoActiveBridgeArtboard()} className="px-2 py-1 text-sm text-[#a6adc8] hover:bg-[#313244] rounded" title="重做 (Ctrl+Y)">↷</button>

      {selectedIds.length > 0 && (
        <button onClick={handleDelete} className="px-2 py-1 text-sm text-[#f38ba8] hover:bg-[#313244] rounded">删除</button>
      )}
      <button onClick={() => void clearActiveBridgeArtboardChildren()} className="px-2 py-1 text-sm text-[#f38ba8] hover:bg-[#313244] rounded" title="清空画板子节点">清空</button>

      <div className="w-px h-5 bg-[#313244]" />

      <button
        onClick={() => void handleSave()}
        disabled={saving}
        className={`px-3 py-1 text-sm rounded ${saving ? 'text-[#6c7086] cursor-wait' : 'text-[#a6e3a1] hover:bg-[#313244]'}`}
        title="保存 (Ctrl+S)"
      >
        保存
      </button>
      <button
        onClick={() => void handleSave(true)}
        disabled={saving}
        className={`px-3 py-1 text-sm rounded ${saving ? 'text-[#6c7086] cursor-wait' : 'text-[#f9e2af] hover:bg-[#313244]'}`}
        title="另存为 (Ctrl+Shift+S)"
      >
        另存为
      </button>

      {lastSaveTime && (
        <span className="text-[12px] text-[#a6e3a1] animate-pulse">{lastSaveTime}</span>
      )}

      <div className="flex-1" />

      <button onClick={() => setCanvasTransform(canvasX, canvasY, canvasScale / 1.2)} className="px-1.5 py-0.5 text-sm text-[#a6adc8] hover:bg-[#313244] rounded">−</button>
      <span className="text-sm text-[#6c7086] w-10 text-center">{Math.round(canvasScale * 100)}%</span>
      <button onClick={() => setCanvasTransform(canvasX, canvasY, canvasScale * 1.2)} className="px-1.5 py-0.5 text-sm text-[#a6adc8] hover:bg-[#313244] rounded">+</button>

      <div className="w-px h-5 bg-[#313244]" />

      <button
        onClick={() => window.dispatchEvent(new Event('shortcuts:open'))}
        className="px-2 py-1 text-sm text-[#a6adc8] hover:bg-[#313244] rounded"
        title="键盘快捷键 (?)"
      >
        ⌨
      </button>

      {saveDialog && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/45 pt-20">
          <div className="w-[760px] max-w-[calc(100vw-32px)] rounded border border-[#45475a] bg-[#1e1e2e] shadow-2xl">
            <div className="flex items-center justify-between border-b border-[#313244] px-4 py-3">
              <div>
                <div className="text-sm font-semibold text-[#cdd6f4]">
                  {saveDialog.mode === 'saveAs' ? '另存为 Prefab' : '保存新 UI'}
                </div>
                <div className="mt-0.5 text-[12px] text-[#6c7086]">
                  {saveDialog.mode === 'saveAs' ? '保存成功后，当前画板会切换到新 Prefab 路径。' : '首次保存需要选择目录并填写 Prefab 名。'}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSaveDialog(null)}
                className="rounded px-2 py-1 text-sm text-[#a6adc8] hover:bg-[#313244]"
                title="关闭"
              >
                ×
              </button>
            </div>

            <div className="grid grid-cols-[260px_minmax(0,1fr)] gap-4 px-4 py-4">
              <div className="min-w-0 rounded border border-[#313244] bg-[#181825]">
                <div className="border-b border-[#313244] px-3 py-2">
                  <div className="text-[12px] font-semibold text-[#cdd6f4]">选择目录</div>
                  <div className="mt-1 truncate font-mono text-[11px] text-[#6c7086]" title={DEFAULT_PREFAB_ROOT}>{DEFAULT_PREFAB_ROOT}</div>
                </div>
                <div className="p-2">
                  <input
                    value={saveDirectoryQuery}
                    onChange={(e) => setSaveDirectoryQuery(e.target.value)}
                    placeholder="搜索目录..."
                    className="mb-2 w-full text-[12px]"
                  />
                  <div className="max-h-64 overflow-y-auto rounded border border-[#313244] bg-[#11111b] py-1">
                    {filteredDirectories.map((dir) => {
                      const selected = saveDialog.draft.directory === dir.path;
                      return (
                        <button
                          key={dir.path || '__root__'}
                          type="button"
                          onClick={() => updateSaveDraft({ directory: dir.path })}
                          className={`flex w-full min-w-0 items-center gap-1 px-2 py-1.5 text-left text-[12px] ${selected ? 'bg-[#89b4fa] text-[#11111b]' : 'text-[#a6adc8] hover:bg-[#313244]'}`}
                          title={dir.path || DEFAULT_PREFAB_ROOT}
                        >
                          <span className="shrink-0 text-[#6c7086]" style={{ width: dir.depth * 12 }} />
                          <span className="shrink-0">{dir.path ? '▸' : '/'}</span>
                          <span className="min-w-0 truncate">{dir.label}</span>
                        </button>
                      );
                    })}
                    {filteredDirectories.length === 0 && (
                      <div className="px-3 py-6 text-center text-[12px] text-[#6c7086]">未找到目录</div>
                    )}
                  </div>
                </div>
              </div>

              <div className="min-w-0 space-y-3">
                {saveDialog.sourcePath && (
                  <div className="grid grid-cols-[76px_minmax(0,1fr)] items-center gap-3">
                    <span className="text-[13px] text-[#a6adc8]">当前来源</span>
                    <span className="truncate font-mono text-[12px] text-[#6c7086]" title={saveDialog.sourcePath}>
                      {saveDialog.sourcePath}
                    </span>
                  </div>
                )}

                <div className="grid grid-cols-[76px_minmax(0,1fr)] items-center gap-3">
                  <label className="text-[13px] text-[#a6adc8]" htmlFor="save-dir">相对目录</label>
                  <input
                    id="save-dir"
                    value={saveDialog.draft.directory}
                    onChange={(e) => updateSaveDraft({ directory: e.target.value })}
                    placeholder="可直接输入新目录，例如 Activity/Summer"
                    className="w-full font-mono text-[13px]"
                  />
                </div>

                <div className="grid grid-cols-[76px_minmax(0,1fr)] items-center gap-3">
                  <label className="text-[13px] text-[#a6adc8]" htmlFor="save-name">Prefab 名</label>
                  <div className="flex min-w-0 items-center gap-2">
                    <input
                      id="save-name"
                      value={saveDialog.draft.prefabName}
                      onChange={(e) => updateSaveDraft({ prefabName: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') submitSaveDialog();
                        if (e.key === 'Escape') setSaveDialog(null);
                      }}
                      className="min-w-0 flex-1 font-mono text-[13px]"
                      autoFocus
                    />
                    <span className="text-[12px] text-[#6c7086]">.prefab</span>
                  </div>
                </div>

                <div className="grid grid-cols-[76px_minmax(0,1fr)] items-start gap-3">
                  <span className="pt-1 text-[13px] text-[#a6adc8]">目标路径</span>
                  <div className="min-w-0 rounded border border-[#313244] bg-[#11111b] px-3 py-2">
                    <div className="break-all font-mono text-[12px] text-[#cdd6f4]">{saveDialog.targetPath}</div>
                    <div className="mt-1 text-[12px] text-[#6c7086]">
                      {saveDialog.checking ? '正在检查目标是否存在...' : saveDialog.exists ? '目标 Prefab 已存在' : '目标路径当前未被项目 UI 列表占用'}
                    </div>
                  </div>
                </div>

                {saveDialog.exists && (!saveDialog.sourcePath || normalizeSlashes(saveDialog.sourcePath) !== saveDialog.targetPath) && (
                  <label className="ml-[88px] flex items-center gap-2 text-[12px] text-[#f9e2af]">
                    <input
                      type="checkbox"
                      checked={saveDialog.allowOverwrite}
                      onChange={(e) => setSaveDialog((dialog) => dialog ? { ...dialog, allowOverwrite: e.target.checked, error: null } : dialog)}
                    />
                    覆盖已有 Prefab
                  </label>
                )}

                {saveDialog.error && (
                  <div className="rounded border border-[#f38ba8]/40 bg-[#f38ba8]/10 px-3 py-2 text-[12px] text-[#f38ba8]">
                    {saveDialog.error}
                  </div>
                )}
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-[#313244] px-4 py-3">
              <button
                type="button"
                onClick={() => setSaveDialog(null)}
                className="rounded border border-[#45475a] px-3 py-1.5 text-[13px] text-[#a6adc8] hover:bg-[#313244]"
              >
                取消
              </button>
              <button
                type="button"
                onClick={submitSaveDialog}
                disabled={!!saveDialog.error || saveDialog.checking || saving || (!!saveDialog.exists && (!saveDialog.sourcePath || normalizeSlashes(saveDialog.sourcePath) !== saveDialog.targetPath) && !saveDialog.allowOverwrite)}
                className="rounded bg-[#a6e3a1] px-3 py-1.5 text-[13px] font-semibold text-[#11111b] disabled:bg-[#45475a] disabled:text-[#6c7086]"
              >
                {saveDialog.mode === 'saveAs' ? '另存为' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

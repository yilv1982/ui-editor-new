import { useEffect, useState } from 'react';
import { useEditorStore } from '../../stores/editorStore';
import {
  clearActiveBridgeArtboardChildren,
  deleteNodeOnBridge,
  redoActiveBridgeArtboard,
  saveActiveBridgeArtboard,
  undoActiveBridgeArtboard,
} from '../../services/BridgeArtboardStore';
import { refreshPrefabThumbnailFromBridge } from './PrefabThumbnail';

const DEFAULT_PREFAB_ROOT = 'Assets/HotRes2/UIs/Prefabs';

function buildNewPrefabTargetPath(currentName: string): string | null {
  const rawName = window.prompt('请输入 Prefab 名字', currentName || 'NewUI');
  if (!rawName) return null;
  const prefabName = rawName.trim().replace(/\.prefab$/i, '');
  if (!prefabName) return null;
  const rawDir = window.prompt('请输入相对路径（相对于 Assets/HotRes2/UIs/Prefabs，可留空）', '');
  if (rawDir === null) return null;
  const dir = rawDir.replace(/\\/g, '/').trim().replace(/^\/+|\/+$/g, '');
  return `${DEFAULT_PREFAB_ROOT}${dir ? `/${dir}` : ''}/${prefabName}.prefab`;
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

  const handleDelete = () => {
    void (async () => {
      for (const id of selectedIds) {
        await deleteNodeOnBridge(id);
      }
    })();
  };

  const handleSave = async () => {
    setSaving(true);
    setLastSaveTime('保存中...');
    try {
      const state = useEditorStore.getState();
      const active = state.pages
        .find((page) => page.id === state.activePageId)
        ?.artboards.find((artboard) => artboard.id === state.activeArtboardId);
      const target = active?.sourcePrefabPath ? null : buildNewPrefabTargetPath(active?.name || rootNodeName || 'NewUI');
      if (!active?.sourcePrefabPath && !target) {
        setLastSaveTime('已取消保存');
        return;
      }
      const result = await saveActiveBridgeArtboard(target);
      setLastSaveTime(`已保存: ${result.savedPath}，正在更新预览图...`);
      await refreshPrefabThumbnailFromBridge(result.savedPath, ['content', 'canvas']);
      setLastSaveTime(`已保存: ${result.savedPath}`);
    } catch (err: any) {
      setLastSaveTime(`保存失败: ${err?.message || String(err)}`);
    } finally {
      setSaving(false);
      setTimeout(() => setLastSaveTime(''), 5000);
    }
  };

  useEffect(() => {
    const onSave = () => {
      void handleSave();
    };
    window.addEventListener('uieditor:save', onSave);
    return () => window.removeEventListener('uieditor:save', onSave);
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
        onClick={handleSave}
        disabled={saving}
        className={`px-3 py-1 text-sm rounded ${saving ? 'text-[#6c7086] cursor-wait' : 'text-[#a6e3a1] hover:bg-[#313244]'}`}
        title="保存 (Ctrl+S)"
      >
        保存
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
    </div>
  );
}

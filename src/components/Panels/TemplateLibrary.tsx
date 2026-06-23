import { useState, useEffect } from 'react';
import { useEditorStore } from '../../stores/editorStore';
import { startCustomDrag } from '../../utils/customDrag';
import { PrefabThumbnail, clearPrefabThumbnailMemoryCache } from './PrefabThumbnail';
import { insertPrefabIntoActiveArtboard } from '../../services/BridgeArtboardStore';

interface PrefabEntry {
  name: string;
  file: string;
  category: string;
  relPath: string;
}

interface TextureEntry { name: string; url: string }

export default function TemplateLibrary() {
  const [prefabs, setPrefabs] = useState<PrefabEntry[]>([]);
  const [textures, setTextures] = useState<Record<string, TextureEntry[]>>({});
  const [search, setSearch] = useState('');
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [expandedTex, setExpandedTex] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState<string | null>(null);

  const [clearing, setClearing] = useState(false);
  const prefabListReloadCounter = useEditorStore((s) => s.prefabListReloadCounter);

  const handleClearCache = async () => {
    setClearing(true);
    try {
      const res = await fetch('/api/prefabs/thumbnail', { method: 'DELETE' });
      const data = await res.json();
      clearPrefabThumbnailMemoryCache();
      alert(`已清除 ${data.deleted} 张缓存图片`);
    } catch { alert('清除失败'); }
    setClearing(false);
  };

  const reloadList = () => {
    return fetch('/api/prefabs/list')
      .then((r) => r.json())
      .then((data) => {
        setPrefabs(Array.isArray(data) ? data : data.prefabs || []);
        if (data.textures) setTextures(data.textures);
      })
      .catch(() => setPrefabs([]));
  };

  // 监听外部资源同步完成信号 → 重拉列表
  useEffect(() => {
    if (prefabListReloadCounter > 0) reloadList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefabListReloadCounter]);

  useEffect(() => {
    fetch('/api/prefabs/list')
      .then((r) => r.json())
      .then((data) => {
        setPrefabs(Array.isArray(data) ? data : data.prefabs || []);
        if (data.textures) setTextures(data.textures);
      })
      .catch(() => setPrefabs([]));
  }, []);

  const grouped = prefabs.reduce<Record<string, PrefabEntry[]>>((acc, p) => {
    (acc[p.category] ||= []).push(p);
    return acc;
  }, {});
  const dirNames = Object.keys(grouped).sort();

  const toggleDir = (dir: string) => {
    const next = new Set(expandedDirs);
    if (next.has(dir)) next.delete(dir); else next.add(dir);
    setExpandedDirs(next);
  };

  const toggleTex = (dir: string) => {
    const next = new Set(expandedTex);
    if (next.has(dir)) next.delete(dir); else next.add(dir);
    setExpandedTex(next);
  };

  const handleTextureDrag = (e: React.MouseEvent, tex: TextureEntry) => {
    startCustomDrag(e, 'application/atlas-image', { name: tex.name.replace(/\.\w+$/, ''), path: tex.url },
      `<img src="${tex.url}" style="width:20px;height:20px;object-fit:contain" /><span>${tex.name}</span>`);
  };

  const handleInsert = async (entry: PrefabEntry) => {
    setLoading(entry.relPath);
    try {
      await insertPrefabIntoActiveArtboard(entry.relPath, { x: 540, y: 960 });
    } catch (err) { console.error('模板加载失败:', err); }
    setLoading(null);
  };

  const filtered = search ? prefabs.filter((t) => t.name.toLowerCase().includes(search.toLowerCase())) : null;

  return (
    <div className="flex flex-col h-full bg-[#1e1e2e]">
      <div className="px-3 py-2">
        <input type="text" placeholder="搜索预制体..." value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full text-sm px-2 py-1.5 bg-[#313244] border border-[#45475a] rounded text-[#cdd6f4] placeholder-[#6c7086] outline-none focus:border-[#89b4fa]" />
      </div>
      <div className="px-3 pb-1">
        <span className="text-[12px] text-[#6c7086]">{prefabs.length} 个预制体 · {dirNames.length} 个目录</span>
      </div>
      <div className="flex-1 overflow-y-auto pb-2">
        {prefabs.length === 0 && <div className="text-center text-[#6c7086] text-sm mt-8">加载中...</div>}

        {filtered && filtered.map((t) => (
          <PrefabRow key={t.relPath} entry={t} loading={loading} onInsert={handleInsert} />
        ))}
        {filtered && filtered.length === 0 && <div className="text-center text-[#6c7086] text-sm mt-4">未找到</div>}

        {!filtered && dirNames.map((dir) => {
          const isExpanded = expandedDirs.has(dir);
          const items = grouped[dir];
          const dirTextures = textures[dir];
          const isTexExpanded = expandedTex.has(dir);
          return (
            <div key={dir}>
              {/* 一级：分类目录 */}
              <button onClick={() => toggleDir(dir)}
                className="w-full flex items-center gap-1.5 py-1 text-left hover:bg-[#313244] transition-colors"
                style={{ paddingLeft: 8 }}>
                <svg width="10" height="10" viewBox="0 0 10 10" className="shrink-0" style={{ color: '#6c7086' }}>
                  {isExpanded ? <path d="M1 3.5L5 7.5L9 3.5" stroke="currentColor" strokeWidth="1.5" fill="none" /> : <path d="M3.5 1L7.5 5L3.5 9" stroke="currentColor" strokeWidth="1.5" fill="none" />}
                </svg>
                <svg width="16" height="16" viewBox="0 0 16 16" className="shrink-0" style={{ color: '#89b4fa' }}>
                  <path fill="currentColor" d="M1.5 2A1.5 1.5 0 000 3.5v9A1.5 1.5 0 001.5 14h13a1.5 1.5 0 001.5-1.5V5a1.5 1.5 0 00-1.5-1.5H7.71l-1-1A1 1 0 006 2H1.5z" />
                </svg>
                <span className="text-sm text-[#cdd6f4] truncate flex-1">{dir}</span>
                <span className="text-[12px] text-[#6c7086] pr-2">{items.length}</span>
              </button>
              {isExpanded && (
                <div style={{ paddingLeft: 12 }} className="border-l border-[#45475a] ml-[14px]">
                  {/* 二级：Textures 子目录 */}
                  {dirTextures && (
                    <>
                      <button onClick={() => toggleTex(dir)}
                        className="w-full flex items-center gap-1.5 py-1 text-left hover:bg-[#313244] transition-colors"
                        style={{ paddingLeft: 8 }}>
                        <svg width="10" height="10" viewBox="0 0 10 10" className="shrink-0" style={{ color: '#6c7086' }}>
                          {isTexExpanded ? <path d="M1 3.5L5 7.5L9 3.5" stroke="currentColor" strokeWidth="1.5" fill="none" /> : <path d="M3.5 1L7.5 5L3.5 9" stroke="currentColor" strokeWidth="1.5" fill="none" />}
                        </svg>
                        <svg width="16" height="16" viewBox="0 0 16 16" className="shrink-0" style={{ color: '#89b4fa' }}>
                          <path fill="currentColor" d="M1.5 2A1.5 1.5 0 000 3.5v9A1.5 1.5 0 001.5 14h13a1.5 1.5 0 001.5-1.5V5a1.5 1.5 0 00-1.5-1.5H7.71l-1-1A1 1 0 006 2H1.5z" />
                        </svg>
                        <span className="text-sm text-[#cdd6f4] truncate flex-1">Textures</span>
                        <span className="text-[12px] text-[#6c7086] pr-2">{dirTextures.length}</span>
                      </button>
                      {isTexExpanded && (
                        <div style={{ paddingLeft: 12 }} className="border-l border-[#45475a] ml-[14px]">
                          {dirTextures.map((tex) => (
                            <div key={tex.url}
                              onMouseDown={(e) => handleTextureDrag(e, tex)}
                              className="flex items-center gap-2 py-0.5 hover:bg-[#45475a] cursor-grab active:cursor-grabbing transition-colors rounded"
                              style={{ paddingLeft: 8 }}
                              title={`${tex.name}\n拖拽到画布`}>
                              <div className="w-6 h-6 shrink-0 bg-[#181825] rounded flex items-center justify-center overflow-hidden">
                                <img src={tex.url} alt="" className="max-w-full max-h-full object-contain" loading="lazy" />
                              </div>
                              <span className="text-[13px] text-[#a6adc8] truncate flex-1">{tex.name}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                  {/* 二级：Prefab 列表 */}
                  {items.map((t) => (
                    <PrefabRow key={t.relPath} entry={t} loading={loading} onInsert={handleInsert} indent />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="px-3 py-2 border-t border-[#45475a]">
        <button onClick={handleClearCache} disabled={clearing}
          className="w-full text-[12px] py-1 rounded bg-[#313244] text-[#a6adc8] hover:bg-[#45475a] disabled:opacity-50 transition-colors">
          {clearing ? '清除中...' : '清除预览图缓存'}
        </button>
      </div>
    </div>
  );
}

function PrefabRow({ entry, loading, onInsert, indent }: {
  entry: PrefabEntry; loading: string | null; onInsert: (e: PrefabEntry) => void; indent?: boolean;
}) {
  const handleDrag = (event: React.MouseEvent) => {
    startCustomDrag(
      event,
      'application/uieditor-prefab',
      { relPath: entry.relPath, name: entry.name },
      `<span>${entry.name}</span>`,
    );
  };
  return (
    <div className="flex items-center gap-1.5 py-0.5 hover:bg-[#313244] transition-colors rounded"
      style={{ paddingLeft: indent ? 8 : 12, paddingRight: indent ? 0 : 0 }}
      onMouseDown={handleDrag}>
      <PrefabThumbnail relPath={entry.relPath} variant="content" />
      <span className="text-[13px] text-[#cdd6f4] truncate flex-1">{entry.name}</span>
      <button onClick={() => onInsert(entry)} disabled={loading === entry.relPath}
        className="shrink-0 px-2 py-0.5 text-[11px] bg-[#89b4fa] text-[#1e1e2e] rounded hover:bg-[#74c7ec] disabled:opacity-50 mr-2">
        {loading === entry.relPath ? '...' : '插入'}
      </button>
    </div>
  );
}

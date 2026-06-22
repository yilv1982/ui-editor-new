import { useState, useEffect } from 'react';
import { useEditorStore } from '../../stores/editorStore';
import { exportToJson, downloadJson } from '../../utils/exportJson';
import { importPsd } from '../../utils/importPsd';
import { convertImagePath, importStructNode, pendingSliceNodes, applySliceBorders } from '../../utils/importStructure';
import type { StructNode } from '../../utils/importStructure';
import AINormalizeDialog from './AINormalizeDialog';
import UnitySettingsDialog from './UnitySettingsDialog';
import unityIcon from '../../assets/unity-icon.png';
import { defaultStyle } from '../../types';
import type { UINode, ExportNode } from '../../types';
import * as UnitySync from '../../services/UnitySync';
import { certIssueDetected, onCertIssueChange } from '../../services/McpClient';

function getSavePreviewPatch(data: any): Partial<ReturnType<typeof useEditorStore.getState>> {
  const previewWidth = Number(data?.previewWidth);
  const previewHeight = Number(data?.previewHeight);
  if (!Number.isFinite(previewWidth) || !Number.isFinite(previewHeight) || previewWidth <= 0 || previewHeight <= 0) {
    return {};
  }
  return { previewWidth, previewHeight };
}

// 导入 ExportNode (来自"导出 JSON") 到编辑器
function importExportNode(
  eNode: ExportNode,
  parentId: string | null,
  addNode: ReturnType<typeof useEditorStore.getState>['addNode'],
) {
  const imageData = convertImagePath(eNode.imagePath);
  const style = { ...defaultStyle, ...eNode.style };

  const options: Partial<UINode> & Record<string, any> = {
    parentId: parentId || undefined,
    name: eNode.name,
    width: eNode.width,
    height: eNode.height,
    rotation: eNode.rotation || 0,
    visible: eNode.active !== false,
    style,
    // Image
    imageData,
    imageType: eNode.imageType || (eNode.sliceBorder ? 'Sliced' : undefined),
    imageColor: eNode.imageColor,
    sliceEnabled: !!eNode.sliceBorder,
    sliceBorder: eNode.sliceBorder,
    fillCenter: eNode.fillCenter,
    fillMethod: eNode.fillMethod,
    fillAmount: eNode.fillAmount,
    fillClockwise: eNode.fillClockwise,
    fillOrigin: eNode.fillOrigin,
    preserveAspect: eNode.preserveAspect,
    useSpriteMesh: eNode.useSpriteMesh,
    imageRaycastTarget: eNode.imageRaycastTarget,
    imageEnabled: eNode.imageEnabled,
    hasImage: eNode.hasImage,
    mirrorType: eNode.mirrorType,
    // Text
    text: eNode.text,
    fontPath: eNode.fontPath,
    fontStyle: eNode.fontStyle,
    alignment: eNode.alignment,
    richText: eNode.richText,
    horizontalOverflow: eNode.horizontalOverflow,
    verticalOverflow: eNode.verticalOverflow,
    lineSpacing: eNode.lineSpacing,
    bestFit: eNode.bestFit,
    bestFitMinSize: eNode.bestFitMinSize,
    bestFitMaxSize: eNode.bestFitMaxSize,
    raycastTarget: eNode.raycastTarget,
    textOutline: eNode.textOutline,
    textShadow: eNode.textShadow,
    textGradient: eNode.textGradient,
    outline: eNode.outline,
    // Component
    componentRef: eNode.componentRef,
    // Anchor
    anchorMin: eNode.anchorMin,
    anchorMax: eNode.anchorMax,
    pivot: eNode.pivot,
    // Button
    interactable: eNode.interactable,
    buttonTransition: eNode.buttonTransition,
    buttonColors: eNode.buttonColors,
    // Mask / ScrollView / Toggle
    isMask: eNode.isMask,
    maskType: eNode.maskType,
    scrollDirection: eNode.scrollDirection,
    isOn: eNode.isOn,
    // Layout
    layoutGroup: eNode.layoutGroup,
    contentSizeFitter: eNode.contentSizeFitter,
  };

  const nodeId = addNode(eNode.type, eNode.x, eNode.y, options);

  // 记录需要查询九宫格的节点（未自带 sliceBorder 的）
  if (imageData && !eNode.sliceBorder) {
    pendingSliceNodes.push({ nodeId, imagePath: imageData });
  }

  if (eNode.children) {
    for (const child of eNode.children) {
      importExportNode(child, nodeId, addNode);
    }
  }
  return nodeId;
}


export default function Toolbar() {
  const { undo, redo, canvasScale, setCanvasTransform, canvasX, canvasY, selectedIds, deleteNode, clearAll, saveToLocal, loadFromLocal, getSaveSlots, deleteSaveSlot } =
    useEditorStore();
  const [importing, setImporting] = useState(false);
  const [showSaveMenu, setShowSaveMenu] = useState(false);
  const [showStructImport, setShowStructImport] = useState(false);
  const [showAINormalize, setShowAINormalize] = useState(false);
  const [showUnitySettings, setShowUnitySettings] = useState(false);
  const [structJson, setStructJson] = useState('');
  const [saveName, setSaveName] = useState('');
  const [slots, setSlots] = useState<string[]>([]);
  const [lastSaveTime, setLastSaveTime] = useState('');

  // Unity 联动状态
  const [unityConnected, setUnityConnected] = useState(false);
  const [unitySyncing, setUnitySyncing] = useState(false);
  const [unityStatus, setUnityStatus] = useState('');
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [exportName, setExportName] = useState('');
  const [certIssue, setCertIssue] = useState(certIssueDetected);

  // 在线人数（基于心跳轮询）
  const [onlineCount, setOnlineCount] = useState(0);

  // 增量同步：源 prefab 路径（来自 store；可手动填写已有 UI 名）
  const sourcePrefabPath = useEditorStore((s) => s.sourcePrefabPath);
  const setSourcePrefabPath = useEditorStore((s) => s.setSourcePrefabPath);
  const [prefabInput, setPrefabInput] = useState('');
  const [showPrefabDropdown, setShowPrefabDropdown] = useState(false);
  const [allPrefabs, setAllPrefabs] = useState<{ name: string; relPath: string; category: string }[]>([]);

  // 当前图层根节点名（用作未指定 sourcePrefabPath 时的默认值）
  const rootNodeName = useEditorStore((s) => {
    const id = s.rootIds[0];
    if (!id) return '';
    return (s.nodes[id]?.name || '').replace(/^@/, '');
  });

  // 输入框与 store 中的 sourcePrefabPath 双向同步显示；未指定时回退到根节点名
  useEffect(() => {
    if (sourcePrefabPath) setPrefabInput(sourcePrefabPath);
    else setPrefabInput(rootNodeName);
  }, [sourcePrefabPath, rootNodeName]);

  // 启动时拉取 prefab 列表
  useEffect(() => {
    fetch('/api/prefabs/list')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return;
        const list: { name: string; relPath: string; category: string }[] = (data.prefabs || data || []).map(
          (p: any) => ({ name: p.name, relPath: p.relPath, category: p.category || 'Root' })
        );
        setAllPrefabs(list);
      })
      .catch(() => {});
  }, []);

  // 根据输入过滤；为空时按目录分组返回全部
  const filteredPrefabs = (() => {
    const kw = prefabInput.trim().toLowerCase();
    if (!kw) return allPrefabs;
    return allPrefabs.filter(
      (p) => p.name.toLowerCase().includes(kw) || p.relPath.toLowerCase().includes(kw)
    );
  })();

  const groupedPrefabs = (() => {
    const map: Record<string, { name: string; relPath: string; category: string }[]> = {};
    for (const p of filteredPrefabs) {
      (map[p.category] = map[p.category] || []).push(p);
    }
    return Object.entries(map).sort((a, b) => a[0].localeCompare(b[0]));
  })();

  const onPrefabInputChange = (v: string) => {
    setPrefabInput(v);
    setSourcePrefabPath(v.trim() || null);
    setShowPrefabDropdown(true);
  };

  const selectPrefab = (relPath: string) => {
    setPrefabInput(relPath);
    setSourcePrefabPath(relPath);
    setShowPrefabDropdown(false);
  };

  // 响应 certIssueDetected 变化
  useEffect(() => {
    return onCertIssueChange((v) => setCertIssue(v));
  }, []);

  // 检查 Unity 连接
  const checkUnityConnection = async () => {
    try {
      const connected = await UnitySync.checkConnection();
      setUnityConnected(connected);
      return connected;
    } catch {
      setUnityConnected(false);
      return false;
    }
  };

  // 全量同步到 Unity
  const handleUnitySync = async () => {
    setUnitySyncing(true);
    setUnityStatus('同步中...');
    try {
      const connected = await checkUnityConnection();
      if (!connected) {
        setUnityStatus('Unity 未连接');
        setTimeout(() => setUnityStatus(''), 3000);
        return;
      }

      const { nodes, rootIds } = useEditorStore.getState();
      const exportJsonStr = exportToJson(nodes, rootIds, 'UIEditorPreview');

      const result = await UnitySync.syncToUnity(exportJsonStr);
      if (result.success) {
        setUnityStatus(`已同步 ${result.nodeCount} 节点 (${result.elapsed}ms)`);
      } else {
        setUnityStatus('同步失败');
      }
    } catch (err: any) {
      setUnityStatus(`错误: ${err.message}`);
    } finally {
      setUnitySyncing(false);
      setTimeout(() => setUnityStatus(''), 5000);
    }
  };

  const handleUnitySyncIncremental = async () => {
    setUnitySyncing(true);
    setUnityStatus('增量同步中...');
    try {
      const connected = await checkUnityConnection();
      if (!connected) {
        setUnityStatus('Unity 未连接');
        setTimeout(() => setUnityStatus(''), 3000);
        return;
      }
      const state = useEditorStore.getState();
      const { nodes, rootIds } = state;
      const sourcePath = ((state as any).sourcePrefabPath as string | null) || prefabInput.trim() || null;
      if (!sourcePath) {
        setUnityStatus('请先填写 UI 名 (源 prefab)');
        setTimeout(() => setUnityStatus(''), 4000);
        return;
      }
      const exportJsonStr = exportToJson(nodes, rootIds, 'UIEditorPreview', sourcePath);
      const result = await UnitySync.syncIncrementalToUnity(exportJsonStr);
      if (result.success) {
        setUnityStatus(`增量同步 ${result.nodeCount} 节点 (${result.elapsed}ms)`);
      } else {
        setUnityStatus('增量同步失败');
      }
    } catch (err: any) {
      setUnityStatus(`错误: ${err.message}`);
    } finally {
      setUnitySyncing(false);
      setTimeout(() => setUnityStatus(''), 5000);
    }
  };

  // 启动时检查 Unity 连接（自适应轮询：在线 10s/次，离线 1s/次快速恢复）
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (cancelled) return;
      const ok = await checkUnityConnection();
      if (cancelled) return;
      timer = setTimeout(tick, ok ? 10000 : 1000);
    };
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  // 在线人数：每 10s 心跳 + 拉取人数；关闭页面时主动离线
  useEffect(() => {
    let sessionId = sessionStorage.getItem('uieditor_session_id');
    if (!sessionId) {
      sessionId = (crypto as any).randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
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
      } catch { /* dev server 不可用时静默 */ }
    };

    beat();
    const timer = setInterval(beat, 10_000);

    const onLeave = () => {
      try {
        navigator.sendBeacon?.(
          '/api/presence/leave',
          new Blob([JSON.stringify({ sessionId: sid })], { type: 'application/json' }),
        );
      } catch { /* ignore */ }
    };
    window.addEventListener('beforeunload', onLeave);

    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener('beforeunload', onLeave);
      onLeave();
    };
  }, []);

  // 加载存档列表
  const refreshSlots = () => {
    setSlots(getSaveSlots());
  };

  useEffect(() => {
    // 启动时：先把本地文件存档同步进 localStorage（仅在 localStorage 没有时回填），再尝试加载自动存档
    (async () => {
      try {
        const res = await fetch('/api/saves');
        if (res.ok) {
          const { slots } = await res.json() as { slots: string[] };
          const lsSlots: string[] = JSON.parse(localStorage.getItem('uieditor_slots') || '[]');
          const merged = Array.from(new Set([...lsSlots, ...slots]));
          for (const slot of slots) {
            const lsKey = `uieditor_save_${slot}`;
            if (localStorage.getItem(lsKey)) continue; // localStorage 已有则不覆盖（更新）
            try {
              const r = await fetch(`/api/save/${encodeURIComponent(slot)}`);
              if (r.ok) {
                const text = await r.text();
                localStorage.setItem(lsKey, text);
              }
            } catch { /* ignore */ }
          }
          localStorage.setItem('uieditor_slots', JSON.stringify(merged));
        }
      } catch { /* dev server 不可用时静默 */ }

      refreshSlots();
      if (loadFromLocal('_autosave')) {
        setLastSaveTime('已恢复自动保存');
      }
    })();
  }, []);

  // 自动保存（每 30 秒）
  useEffect(() => {
    const timer = setInterval(() => {
      const { rootIds } = useEditorStore.getState();
      if (rootIds.length > 0) {
        saveToLocal('_autosave');
      }
    }, 30000);
    return () => clearInterval(timer);
  }, []);

  const handleSave = (slotName?: string) => {
    const name = slotName || saveName.trim() || `存档_${new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`;
    saveToLocal(name);
    setLastSaveTime(`已保存: ${name}`);
    setSaveName('');
    refreshSlots();
    setTimeout(() => setLastSaveTime(''), 3000);
  };

  const handleQuickSave = () => {
    saveToLocal('_quicksave');
    setLastSaveTime('已快速保存');
    setTimeout(() => setLastSaveTime(''), 3000);
  };

  const handleQuickLoad = () => {
    if (loadFromLocal('_quicksave')) {
      setLastSaveTime('已加载快速存档');
    } else {
      setLastSaveTime('无快速存档');
    }
    setTimeout(() => setLastSaveTime(''), 3000);
  };

  const handleExport = async () => {
    const { nodes, rootIds, pages, activePageId } = useEditorStore.getState();
    const pageName = pages.find((p) => p.id === activePageId)?.name || '';
    const defaultName = (pageName || 'UI Layout').replace(/[\\/:*?"<>|]/g, '_');

    // 优先使用系统原生"另存为"对话框
    if ('showSaveFilePicker' in window) {
      try {
        const handle = await (window as any).showSaveFilePicker({
          suggestedName: `${defaultName}.json`,
          types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }],
        });
        const docName = handle.name.replace(/\.json$/i, '') || defaultName;
        const json = exportToJson(nodes, rootIds, docName);
        const writable = await handle.createWritable();
        await writable.write(json);
        await writable.close();
        return;
      } catch (e: any) {
        if (e?.name === 'AbortError') return;
      }
    }

    // 降级：弹出自定义对话框
    setExportName(defaultName);
    setShowExportDialog(true);
  };

  const doExport = async (name: string) => {
    const { nodes, rootIds } = useEditorStore.getState();
    const finalName = name.trim() || 'UI Layout';
    const json = exportToJson(nodes, rootIds, finalName);
    setShowExportDialog(false);
    await downloadJson(json, `${finalName}.json`);
  };

  const handleImport = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,.psd';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      if (file.name.toLowerCase().endsWith('.psd')) {
        setImporting(true);
        try {
          const result = await importPsd(file);
          alert(`PSD 导入成功！\n文件: ${result.name}\n图层数: ${result.layerCount}`);
        } catch (err: any) {
          alert(`PSD 导入失败: ${err.message}`);
        } finally {
          setImporting(false);
        }
        return;
      }
      const reader = new FileReader();
      reader.onload = async (ev) => {
        try {
          const data = JSON.parse(ev.target?.result as string);

          // 存档文件格式（来自"导出存档文件"）
          if (data.type === 'uieditor_save' && data.pages) {
            const { migratePages } = await import('../../utils/migratePage');
            const previewPatch = getSavePreviewPatch(data);
            const store = useEditorStore.getState();
            const migrated = migratePages(
              data.pages,
              previewPatch.previewWidth ?? store.previewWidth,
              previewPatch.previewHeight ?? store.previewHeight,
            );
            const activePage = migrated.find((p: any) => p.id === data.activePageId) || migrated[0];
            const activeArtboard = activePage.artboards.find((a: any) => a.id === activePage.activeArtboardId) ?? activePage.artboards[0];
            useEditorStore.setState({
              pages: migrated,
              activePageId: activePage.id,
              activeArtboardId: activeArtboard.id,
              nodes: { ...activeArtboard.nodes },
              rootIds: [...activeArtboard.rootIds],
              sourcePrefabPath: activeArtboard.sourcePrefabPath,
              annotations: { ...(activePage.annotations ?? {}) },
              annotationRootIds: [...(activePage.annotationRootIds ?? [])],
              canvasX: data.canvasX || 0,
              canvasY: data.canvasY || 0,
              canvasScale: data.canvasScale || 1,
              selectedIds: [],
              selectedArtboardId: null,
              selectedAnnotationIds: [],
              history: [],
              historyIndex: -1,
              ...previewPatch,
            });
            alert(`存档加载成功！${migrated.length} 个图层`);
            return;
          }

          // ExportDocument 格式（来自"导出 JSON"）
          if (data.root && data.root.children) {
            const store = useEditorStore.getState();
            store.pushHistory();
            pendingSliceNodes.length = 0;

            for (const child of data.root.children) {
              importExportNode(child, null, store.addNode);
            }

            // 批量查询九宫格
            await applySliceBorders();
            alert(`导入成功！已导入 ${data.root.children.length} 个顶层节点`);
            return;
          }

          // 结构 JSON 格式（与"导入结构"相同）
          if (data.name || data.children) {
            const store = useEditorStore.getState();
            store.pushHistory();
            pendingSliceNodes.length = 0;
            importStructNode(data as StructNode, null, store.addNode, 100, 100);
            await applySliceBorders();
            alert('导入成功');
            return;
          }

          alert('无法识别的 JSON 格式');
        } catch { alert('JSON 解析失败'); }
      };
      reader.readAsText(file);
    };
    input.click();
  };

  const handleImportPsd = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.psd';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      setImporting(true);
      try {
        const result = await importPsd(file);
        alert(`PSD 导入成功！\n文件: ${result.name}\n图层数: ${result.layerCount}`);
      } catch (err: any) {
        alert(`PSD 导入失败: ${err.message}`);
      } finally {
        setImporting(false);
      }
    };
    input.click();
  };

  const handleDelete = () => {
    selectedIds.forEach((id) => deleteNode(id));
  };

  return (
    <>
      <div className="h-10 bg-[#1e1e2e] border-b border-[#313244] flex items-center px-3 gap-2 shrink-0">
        <span className="text-sm font-bold text-[#89b4fa] mr-3">UIEditor New</span>

        {/* 在线人数 */}
        <div
          className="flex items-center gap-1 px-2 py-1 text-xs text-[#a6adc8] bg-[#313244] rounded"
          title={`当前在线 ${onlineCount} 人`}
        >
          <div className={`w-1.5 h-1.5 rounded-full ${onlineCount > 0 ? 'bg-[#a6e3a1]' : 'bg-[#6c7086]'}`} />
          <span>在线 {onlineCount}</span>
        </div>

        <div className="w-px h-5 bg-[#313244]" />

        <button onClick={undo} className="px-2 py-1 text-sm text-[#a6adc8] hover:bg-[#313244] rounded" title="撤销 (Ctrl+Z)">↶</button>
        <button onClick={redo} className="px-2 py-1 text-sm text-[#a6adc8] hover:bg-[#313244] rounded" title="重做 (Ctrl+Y)">↷</button>

        {selectedIds.length > 0 && (
          <button onClick={handleDelete} className="px-2 py-1 text-sm text-[#f38ba8] hover:bg-[#313244] rounded">删除</button>
        )}
        <button onClick={clearAll} className="px-2 py-1 text-sm text-[#f38ba8] hover:bg-[#313244] rounded" title="清空所有节点">清空</button>

        <div className="w-px h-5 bg-[#313244]" />

        {/* 保存/加载 */}
        <button onClick={handleQuickSave} className="px-3 py-1 text-sm text-[#a6e3a1] hover:bg-[#313244] rounded" title="快速保存 (Ctrl+S)">
          保存
        </button>
        <button onClick={() => { refreshSlots(); setShowSaveMenu(!showSaveMenu); }} className="px-2 py-1 text-sm text-[#a6adc8] hover:bg-[#313244] rounded relative" title="存档管理">
          存档 ▾
        </button>

        {/* 保存提示 */}
        {lastSaveTime && (
          <span className="text-[12px] text-[#a6e3a1] animate-pulse">{lastSaveTime}</span>
        )}

        <div className="flex-1" />

        <button onClick={() => setCanvasTransform(canvasX, canvasY, canvasScale / 1.2)} className="px-1.5 py-0.5 text-sm text-[#a6adc8] hover:bg-[#313244] rounded">−</button>
        <span className="text-sm text-[#6c7086] w-10 text-center">{Math.round(canvasScale * 100)}%</span>
        <button onClick={() => setCanvasTransform(canvasX, canvasY, canvasScale * 1.2)} className="px-1.5 py-0.5 text-sm text-[#a6adc8] hover:bg-[#313244] rounded">+</button>

        <div className="w-px h-5 bg-[#313244]" />

        <button onClick={handleImport} className="px-3 py-1 text-sm bg-[#94e2d5] text-[#1e1e2e] rounded hover:bg-[#a6e3a1]">导入</button>
        <button onClick={handleImportPsd} disabled={importing}
          className={`px-3 py-1 text-sm rounded ${importing ? 'bg-[#45475a] text-[#6c7086] cursor-wait' : 'bg-[#f5c2e7] text-[#1e1e2e] hover:bg-[#f5a6d8]'}`}
        >
          {importing ? '解析中...' : '导入 PSD'}
        </button>
        <button onClick={handleExport} className="px-3 py-1 text-sm bg-[#89b4fa] text-[#1e1e2e] rounded hover:bg-[#74c7ec]">导出 JSON</button>
        <button onClick={() => setShowAINormalize(true)} className="px-3 py-1 text-sm bg-[#f9e2af] text-[#1e1e2e] rounded hover:bg-[#f9e2af]/80 font-medium">AI 助手</button>

        <div className="w-px h-5 bg-[#313244]" />

        {/* Unity 联动 */}
        <div className="flex items-center gap-1.5">
          <div className={`w-2 h-2 rounded-full ${unityConnected ? 'bg-[#a6e3a1]' : 'bg-[#6c7086]'}`} title={unityConnected ? 'Unity 已连接' : 'Unity 未连接'} />
          <button
            onClick={handleUnitySync}
            disabled={unitySyncing}
            className={`px-3 py-1 text-sm rounded ${unitySyncing ? 'bg-[#45475a] text-[#6c7086] cursor-wait' : 'bg-[#cba6f7] text-[#1e1e2e] hover:bg-[#b4befe]'}`}
            title="同步到 Unity"
          >
            {unitySyncing ? '同步中...' : 'Unity 同步'}
          </button>
          <button
            onClick={handleUnitySyncIncremental}
            disabled={unitySyncing}
            className={`px-3 py-1 text-sm rounded ${unitySyncing ? 'bg-[#45475a] text-[#6c7086] cursor-wait' : 'bg-[#a6e3a1] text-[#1e1e2e] hover:bg-[#94e2d5]'}`}
            title="写回原 prefab，保留程序拖的引用"
          >
            增量同步
          </button>
          <div className="relative">
            <div className="flex items-center bg-[#313244] border border-[#45475a] rounded focus-within:border-[#a6e3a1]">
              <input
                type="text"
                value={prefabInput}
                onChange={(e) => onPrefabInputChange(e.target.value)}
                onFocus={() => setShowPrefabDropdown(true)}
                onBlur={() => setTimeout(() => setShowPrefabDropdown(false), 150)}
                placeholder="UI 名 / UICommons/UI_Xxx.prefab"
                title="增量同步的目标 prefab 相对路径（基于 Assets/HotRes2/UIs/Prefabs/）"
                className="px-2 py-1 text-[12px] w-[220px] bg-transparent text-[#cdd6f4] placeholder-[#6c7086] outline-none"
              />
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  setShowPrefabDropdown((v) => !v);
                }}
                className="px-1.5 text-[#a6adc8] hover:text-[#cdd6f4] text-[10px] border-l border-[#45475a]"
                title="展开/收起列表"
              >
                ▾
              </button>
            </div>
            {showPrefabDropdown && (
              <div className="absolute top-full left-0 mt-1 w-[320px] max-h-[360px] overflow-auto bg-[#1e1e2e] border border-[#45475a] rounded shadow-lg z-50">
                {groupedPrefabs.length === 0 ? (
                  <div className="px-2 py-2 text-[12px] text-[#6c7086]">无匹配项</div>
                ) : (
                  groupedPrefabs.map(([cat, items]) => (
                    <div key={cat}>
                      <div className="px-2 py-1 text-[10px] text-[#6c7086] bg-[#181825] sticky top-0">
                        {cat} ({items.length})
                      </div>
                      {items.map((p) => (
                        <button
                          key={p.relPath}
                          type="button"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            selectPrefab(p.relPath);
                          }}
                          className={`w-full text-left px-2 py-1 text-[12px] hover:bg-[#313244] ${
                            p.relPath === prefabInput ? 'bg-[#313244]' : ''
                          }`}
                        >
                          <div className="text-[#a6e3a1]">{p.name}</div>
                          <div className="text-[10px] text-[#6c7086] truncate">{p.relPath}</div>
                        </button>
                      ))}
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
          {unityStatus && (
            <span className="text-[12px] text-[#cba6f7] animate-pulse">{unityStatus}</span>
          )}
          {!unityConnected && certIssue && (
            <button
              onClick={() => {
                window.open('https://127.0.0.1:8081', '_blank');
                const onVisible = () => {
                  if (document.visibilityState === 'visible') {
                    document.removeEventListener('visibilitychange', onVisible);
                    checkUnityConnection();
                  }
                };
                document.addEventListener('visibilitychange', onVisible);
              }}
              className="text-[12px] text-[#fab387] hover:text-[#f9e2af] underline bg-transparent border-none cursor-pointer px-1"
              title="首次使用需在浏览器中信任 HTTPS 证书"
            >
              信任证书
            </button>
          )}
        </div>

        <div className="w-px h-5 bg-[#313244]" />

        <button
          onClick={() => setShowUnitySettings(true)}
          className="p-1 hover:bg-[#313244] rounded flex items-center justify-center"
          title="Unity 配置"
        >
          <img src={unityIcon} alt="Unity" className="w-[18px] h-[18px]" />
        </button>
        <button
          onClick={() => window.dispatchEvent(new Event('shortcuts:open'))}
          className="px-2 py-1 text-sm text-[#a6adc8] hover:bg-[#313244] rounded"
          title="键盘快捷键 (?)"
        >⌨</button>
      </div>

      {/* 导入结构弹窗 */}
      {showStructImport && (
        <>
          <div className="fixed inset-0 z-40 bg-black/30" onClick={() => setShowStructImport(false)} />
          <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 bg-[#1e1e2e] border border-[#45475a] rounded-lg shadow-2xl w-[600px] max-h-[80vh] flex flex-col">
            <div className="px-4 py-3 border-b border-[#45475a] flex items-center justify-between">
              <h3 className="text-sm font-medium text-[#cdd6f4]">导入 UI 结构 JSON</h3>
              <button onClick={() => setShowStructImport(false)} className="text-[#6c7086] hover:text-[#cdd6f4]">×</button>
            </div>
            <div className="px-4 py-3 flex-1 overflow-hidden flex flex-col">
              <div className="text-[12px] text-[#6c7086] mb-2">
                粘贴由 Claude 生成的 UI 层级结构 JSON。格式：{'{'} name, type?, width?, height?, children? {'}'}
              </div>
              <textarea
                value={structJson}
                onChange={(e) => setStructJson(e.target.value)}
                placeholder={`{
  "name": "MyPanel",
  "children": [
    { "name": "img_Bg", "width": 1920, "height": 1080 },
    { "name": "Ctn_Main", "children": [
      { "name": "txt_title", "text": "标题" },
      { "name": "btn_Close" },
      { "name": "ScrollView", "children": [
        { "name": "Cell", "children": [
          { "name": "img_icon" },
          { "name": "txt_name" }
        ]}
      ]}
    ]}
  ]
}`}
                className="flex-1 min-h-[300px] text-sm bg-[#313244] border border-[#45475a] text-[#cdd6f4] rounded p-3 font-mono resize-none outline-none focus:border-[#89b4fa]"
              />
            </div>
            <div className="px-4 py-3 border-t border-[#45475a] flex justify-end gap-2">
              <button onClick={() => setShowStructImport(false)}
                className="px-4 py-1.5 text-sm text-[#a6adc8] bg-[#313244] rounded hover:bg-[#45475a]">取消</button>
              <button
                onClick={async () => {
                  try {
                    const data = JSON.parse(structJson) as StructNode;
                    const store = useEditorStore.getState();
                    store.pushHistory();
                    pendingSliceNodes.length = 0;
                    importStructNode(data, null, store.addNode, 100, 100);
                    await applySliceBorders();
                    setShowStructImport(false);
                    setStructJson('');
                  } catch (e: any) {
                    alert('JSON 解析失败: ' + e.message);
                  }
                }}
                className="px-4 py-1.5 text-sm bg-[#a6e3a1] text-[#1e1e2e] rounded hover:bg-[#94e2d5]"
              >导入到画布</button>
            </div>
          </div>
        </>
      )}

      {/* 存档管理弹窗 */}
      {showSaveMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setShowSaveMenu(false)} />
          <div className="absolute top-10 left-48 z-50 bg-[#313244] border border-[#45475a] rounded-lg shadow-xl w-72 max-h-96 overflow-hidden">
            <div className="px-4 py-3 border-b border-[#45475a]">
              <h4 className="text-sm font-medium text-[#cdd6f4] mb-2">存档管理</h4>
              <div className="flex gap-1">
                <input
                  type="text"
                  placeholder="输入存档名..."
                  value={saveName}
                  onChange={(e) => setSaveName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { handleSave(); setShowSaveMenu(false); } }}
                  className="flex-1 text-sm px-2 py-1.5 bg-[#1e1e2e] border border-[#45475a] rounded text-[#cdd6f4] placeholder-[#6c7086] outline-none focus:border-[#89b4fa]"
                />
                <button
                  onClick={() => { handleSave(); setShowSaveMenu(false); }}
                  className="px-3 py-1.5 text-sm bg-[#a6e3a1] text-[#1e1e2e] rounded hover:bg-[#94e2d5]"
                >
                  保存
                </button>
              </div>
            </div>

            <div className="overflow-y-auto max-h-60">
              {/* 快速存档 */}
              <div className="px-4 py-2 flex items-center justify-between hover:bg-[#45475a]">
                <div>
                  <span className="text-sm text-[#cdd6f4]">快速存档</span>
                  <span className="text-[12px] text-[#6c7086] ml-2">Ctrl+S</span>
                </div>
                <div className="flex gap-1">
                  <button onClick={() => { handleQuickLoad(); setShowSaveMenu(false); }} className="px-2 py-0.5 text-[12px] bg-[#89b4fa] text-[#1e1e2e] rounded">加载</button>
                </div>
              </div>

              {/* 自动存档 */}
              {localStorage.getItem('uieditor_save__autosave') && (
                <div className="px-4 py-2 flex items-center justify-between hover:bg-[#45475a]">
                  <div>
                    <span className="text-sm text-[#cdd6f4]">自动存档</span>
                    <span className="text-[12px] text-[#6c7086] ml-2">每30秒</span>
                  </div>
                  <button onClick={() => { loadFromLocal('_autosave'); setShowSaveMenu(false); }} className="px-2 py-0.5 text-[12px] bg-[#89b4fa] text-[#1e1e2e] rounded">加载</button>
                </div>
              )}

              {slots.length > 0 && <div className="border-t border-[#45475a]" />}

              {/* 命名存档列表 */}
              {slots.filter((s) => !s.startsWith('_')).map((slot) => {
                const raw = localStorage.getItem(`uieditor_save_${slot}`);
                let savedAt = '';
                try { savedAt = raw ? JSON.parse(raw).savedAt?.replace('T', ' ').slice(0, 16) : ''; } catch {}

                return (
                  <div key={slot} className="px-4 py-2 flex items-center justify-between hover:bg-[#45475a]">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-[#cdd6f4] truncate">{slot}</div>
                      {savedAt && <div className="text-[11px] text-[#6c7086]">{savedAt}</div>}
                    </div>
                    <div className="flex gap-1 shrink-0 ml-2">
                      <button onClick={() => { loadFromLocal(slot); setShowSaveMenu(false); }} className="px-2 py-0.5 text-[12px] bg-[#89b4fa] text-[#1e1e2e] rounded">加载</button>
                      <button onClick={() => { handleSave(slot); }} className="px-2 py-0.5 text-[12px] bg-[#a6e3a1] text-[#1e1e2e] rounded">覆盖</button>
                      <button onClick={() => { deleteSaveSlot(slot); refreshSlots(); }} className="px-2 py-0.5 text-[12px] bg-[#f38ba8] text-[#1e1e2e] rounded">删</button>
                    </div>
                  </div>
                );
              })}

              {slots.filter((s) => !s.startsWith('_')).length === 0 && (
                <div className="px-4 py-4 text-center text-[12px] text-[#6c7086]">暂无手动存档</div>
              )}
            </div>

            {/* 底部：导出/导入存档文件 */}
            <div className="border-t border-[#45475a] px-4 py-3 flex gap-2">
              <button
                onClick={() => {
                  // 导出当前存档为文件 —— flush 顶层镜像到 active 画板再导出
                  const state = useEditorStore.getState();
                  const pages = state.pages.map((p) => {
                    if (p.id !== state.activePageId) return p;
                    return {
                      ...p,
                      artboards: p.artboards.map((a) => a.id === state.activeArtboardId ? {
                        ...a, nodes: { ...state.nodes }, rootIds: [...state.rootIds], sourcePrefabPath: state.sourcePrefabPath,
                      } : a),
                      annotations: { ...state.annotations },
                      annotationRootIds: [...state.annotationRootIds],
                    };
                  });
                  const data = {
                    type: 'uieditor_save',
                    pages,
                    activePageId: state.activePageId,
                    canvasX: state.canvasX,
                    canvasY: state.canvasY,
                    canvasScale: state.canvasScale,
                    savedAt: new Date().toISOString(),
                  };
                  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = `ui-editor-save_${new Date().toISOString().slice(0, 10)}.save.json`;
                  a.click();
                  URL.revokeObjectURL(url);
                  setShowSaveMenu(false);
                }}
                className="flex-1 text-[13px] py-1.5 bg-[#89b4fa] text-[#1e1e2e] rounded hover:bg-[#74c7ec]"
              >
                导出存档文件
              </button>
              <button
                onClick={() => {
                  const input = document.createElement('input');
                  input.type = 'file';
                  input.accept = '.json';
                  input.onchange = (e) => {
                    const file = (e.target as HTMLInputElement).files?.[0];
                    if (!file) return;
                    const reader = new FileReader();
                    reader.onload = async (ev) => {
                      try {
                        const data = JSON.parse(ev.target?.result as string);
                        if (data.type !== 'uieditor_save' || !data.pages) {
                          alert('不是有效的存档文件');
                          return;
                        }
                        const { migratePages } = await import('../../utils/migratePage');
                        const previewPatch = getSavePreviewPatch(data);
                        const store = useEditorStore.getState();
                        const migrated = migratePages(
                          data.pages,
                          previewPatch.previewWidth ?? store.previewWidth,
                          previewPatch.previewHeight ?? store.previewHeight,
                        );
                        const activePage = migrated.find((p: any) => p.id === data.activePageId) || migrated[0];
                        const activeArtboard = activePage.artboards.find((a: any) => a.id === activePage.activeArtboardId) ?? activePage.artboards[0];
                        useEditorStore.setState({
                          pages: migrated,
                          activePageId: activePage.id,
                          activeArtboardId: activeArtboard.id,
                          nodes: { ...activeArtboard.nodes },
                          rootIds: [...activeArtboard.rootIds],
                          sourcePrefabPath: activeArtboard.sourcePrefabPath,
                          annotations: { ...(activePage.annotations ?? {}) },
                          annotationRootIds: [...(activePage.annotationRootIds ?? [])],
                          canvasX: data.canvasX || 0,
                          canvasY: data.canvasY || 0,
                          canvasScale: data.canvasScale || 1,
                          selectedIds: [],
                          selectedArtboardId: null,
                          selectedAnnotationIds: [],
                          history: [],
                          historyIndex: -1,
                          ...previewPatch,
                        });
                        alert(`存档加载成功！${migrated.length} 个图层`);
                      } catch {
                        alert('存档文件解析失败');
                      }
                    };
                    reader.readAsText(file);
                  };
                  input.click();
                  setShowSaveMenu(false);
                }}
                className="flex-1 text-[13px] py-1.5 bg-[#313244] text-[#a6adc8] rounded hover:bg-[#45475a] border border-[#45475a]"
              >
                导入存档文件
              </button>
            </div>
          </div>
        </>
      )}

      {/* AI 规范化弹窗 */}
      <AINormalizeDialog open={showAINormalize} onClose={() => setShowAINormalize(false)} />
      <UnitySettingsDialog open={showUnitySettings} onClose={() => setShowUnitySettings(false)} />

      {/* 导出命名弹窗 */}
      {showExportDialog && (
        <>
          <div className="fixed inset-0 z-[60] bg-black/30" onClick={() => setShowExportDialog(false)} />
          <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[61] bg-[#1e1e2e] border border-[#45475a] rounded-lg shadow-2xl w-[360px]">
            <div className="px-4 py-3 border-b border-[#45475a]">
              <h3 className="text-sm font-medium text-[#cdd6f4]">导出 JSON</h3>
            </div>
            <div className="px-4 py-4">
              <label className="text-sm text-[#a6adc8] mb-1 block">文件名称</label>
              <input
                autoFocus
                type="text"
                value={exportName}
                onChange={(e) => setExportName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') doExport(exportName); if (e.key === 'Escape') setShowExportDialog(false); }}
                placeholder="例如: StrengthImprovePanel"
                className="w-full px-3 py-1.5 text-sm bg-[#313244] text-[#cdd6f4] border border-[#45475a] rounded focus:border-[#89b4fa] outline-none"
              />
            </div>
            <div className="px-4 py-3 border-t border-[#45475a] flex justify-end gap-2">
              <button onClick={() => setShowExportDialog(false)} className="px-3 py-1 text-sm text-[#a6adc8] hover:bg-[#313244] rounded">取消</button>
              <button onClick={() => doExport(exportName)} className="px-4 py-1 text-sm bg-[#89b4fa] text-[#1e1e2e] rounded hover:bg-[#74c7ec]">导出</button>
            </div>
          </div>
        </>
      )}
    </>
  );
}

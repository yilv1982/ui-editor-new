import { useState, useCallback, useEffect, useRef } from 'react';
import { useEditorStore } from '../../stores/editorStore';
import { importStructNode, pendingSliceNodes, applySliceBorders, restructureFromTree } from '../../utils/importStructure';
import type { StructNode, RestructureNode } from '../../utils/importStructure';
import { buildPanelFromAI } from '../../utils/panelTemplates';
import type { AIGenerateResult } from '../../utils/panelTemplates';
import type { NodeType } from '../../types';
import { DESIGN_WIDTH, DESIGN_HEIGHT } from '../../config/assetPaths';
import AISettingsDialog from './AISettingsDialog';
import unityBridge from '../../services/UnityBridge';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';

type DialogTab = 'normalize' | 'generate' | 'reference';

interface RenameEntry {
  id: string;
  newName: string;
  newType?: string;
  componentRef?: string;
}

interface PrefabEntry {
  name: string;
  file: string;
  category: string;
  relPath: string;
}

interface SimplifiedRefNode {
  name: string;
  type: string;
  componentRef?: string;
  children?: SimplifiedRefNode[];
}

interface Props {
  open: boolean;
  onClose: () => void;
}

/** 递归检测 AI 返回的树是否包含 origId（新重构格式） */
function hasOrigIdInTree(node: any): boolean {
  if (node.origId) return true;
  if (node.children) {
    for (const child of node.children) {
      if (hasOrigIdInTree(child)) return true;
    }
  }
  return false;
}

/** 类型图标映射 */
const typeIcons: Record<string, string> = {
  frame: '\u25A2',       // ▢
  text: 'T',
  image: '\u25A3',       // ▣
  button: '\u25C9',      // ◉
  component: '\u25C8',   // ◈
  scrollview: '\u2261',  // ≡
  toggle: '\u2713',      // ✓
  inputfield: '\u2398',  // ⎘
};

/** 类型颜色映射 */
const typeColors: Record<string, string> = {
  frame: '#a6adc8',
  text: '#f9e2af',
  image: '#89b4fa',
  button: '#a6e3a1',
  component: '#cba6f7',
  scrollview: '#94e2d5',
  toggle: '#f5c2e7',
  inputfield: '#fab387',
};

/** 重建结果的树状节点组件 */
function RebuildTreeNode({ node, depth }: { node: any; depth: number }) {
  const [collapsed, setCollapsed] = useState(depth >= 3);
  const hasChildren = node.children && node.children.length > 0;
  const type = node.type || 'frame';
  const icon = typeIcons[type] || '\u25A2';
  const color = typeColors[type] || '#a6adc8';
  const isNew = !node.origId;

  return (
    <div>
      <div
        className="flex items-center gap-1 px-2 py-0.5 hover:bg-[#45475a]/50 cursor-default select-none"
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        {/* 折叠箭头 */}
        {hasChildren ? (
          <span
            className="w-3 text-[12px] text-[#6c7086] cursor-pointer flex-shrink-0"
            onClick={() => setCollapsed(!collapsed)}
          >
            {collapsed ? '\u25B6' : '\u25BC'}
          </span>
        ) : (
          <span className="w-3 flex-shrink-0" />
        )}
        {/* 类型图标 */}
        <span className="text-[12px] flex-shrink-0 w-3 text-center" style={{ color }}>{icon}</span>
        {/* 节点名称 */}
        <span className="text-[13px] text-[#cdd6f4] truncate">{node.name}</span>
        {/* 类型标签 */}
        <span className="text-[11px] px-1 rounded flex-shrink-0" style={{ color, opacity: 0.7 }}>{type}</span>
        {/* 新容器标记 */}
        {isNew && hasChildren && (
          <span className="text-[11px] px-1 bg-[#89b4fa]/20 text-[#89b4fa] rounded flex-shrink-0">new</span>
        )}
        {/* 组件引用 */}
        {node.componentRef && (
          <span className="text-[11px] px-1 bg-[#cba6f7]/20 text-[#cba6f7] rounded flex-shrink-0">{node.componentRef}</span>
        )}
        {/* 子节点计数 */}
        {hasChildren && (
          <span className="text-[11px] text-[#6c7086] flex-shrink-0">({node.children.length})</span>
        )}
      </div>
      {/* 子节点 */}
      {hasChildren && !collapsed && node.children.map((child: any, i: number) => (
        <RebuildTreeNode key={child.origId || `${child.name}-${i}`} node={child} depth={depth + 1} />
      ))}
    </div>
  );
}

function RefTreeNode({ node, depth }: { node: SimplifiedRefNode; depth: number }) {
  const [collapsed, setCollapsed] = useState(depth >= 2);
  const hasChildren = node.children && node.children.length > 0;
  const type = node.type || 'frame';
  const icon = typeIcons[type] || '\u25A2';
  const color = typeColors[type] || '#a6adc8';

  return (
    <div>
      <div
        className="flex items-center gap-1 px-2 py-0.5 hover:bg-[#45475a]/30 cursor-default select-none"
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
      >
        {hasChildren ? (
          <span
            className="w-3 text-[11px] text-[#6c7086] cursor-pointer flex-shrink-0"
            onClick={() => setCollapsed(!collapsed)}
          >
            {collapsed ? '\u25B6' : '\u25BC'}
          </span>
        ) : (
          <span className="w-3 flex-shrink-0" />
        )}
        <span className="text-[11px] flex-shrink-0 w-3 text-center" style={{ color }}>{icon}</span>
        <span className="text-[12px] text-[#a6adc8] truncate">{node.name}</span>
        {node.componentRef && (
          <span className="text-[10px] px-1 bg-[#cba6f7]/20 text-[#cba6f7] rounded flex-shrink-0">{node.componentRef}</span>
        )}
        {hasChildren && (
          <span className="text-[10px] text-[#585b70] flex-shrink-0">({node.children!.length})</span>
        )}
      </div>
      {hasChildren && !collapsed && node.children!.map((child, i) => (
        <RefTreeNode key={`${child.name}-${i}`} node={child} depth={depth + 1} />
      ))}
    </div>
  );
}

export default function AINormalizeDialog({ open, onClose }: Props) {
  const [activeTab, setActiveTab] = useState<DialogTab>('normalize');
  const [panelName, setPanelName] = useState('MyPanel');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [renameResult, setRenameResult] = useState<RenameEntry[] | null>(null);
  const [rebuildResult, setRebuildResult] = useState<StructNode | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [prefabList, setPrefabList] = useState<PrefabEntry[]>([]);
  const [prefabSearch, setPrefabSearch] = useState('');
  const [prefabDropdownOpen, setPrefabDropdownOpen] = useState(false);
  const [selectedPrefab, setSelectedPrefab] = useState<PrefabEntry | null>(null);
  const [refStructure, setRefStructure] = useState<SimplifiedRefNode | null>(null);
  const [refLoading, setRefLoading] = useState(false);

  // 文档生成相关状态
  const [docText, setDocText] = useState('');
  const [docImages, setDocImages] = useState<Array<{ type: string; media_type: string; data: string }>>([]);
  const [docFileName, setDocFileName] = useState('');
  const [generateResult, setGenerateResult] = useState<StructNode | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 参考图生成相关状态
  const [refImages, setRefImages] = useState<Array<{ type: string; media_type: string; data: string }>>([]);
  const [refDescription, setRefDescription] = useState('');
  const [refImageResult, setRefImageResult] = useState<StructNode | null>(null);
  const refFileInputRef = useRef<HTMLInputElement>(null);

  const nodes = useEditorStore(s => s.nodes);
  const rootIds = useEditorStore(s => s.rootIds);
  const nodeCount = Object.keys(nodes).length;

  useEffect(() => {
    if (!open) return;
    fetch('/api/prefabs/list')
      .then(r => r.json())
      .then((data: PrefabEntry[]) => setPrefabList(data))
      .catch(() => setPrefabList([]));
  }, [open]);

  const simplifyTemplateNode = useCallback((node: any, depth = 0, counter = { count: 0 }): SimplifiedRefNode | null => {
    if (counter.count >= 200) return null;
    if (depth >= 8) return null;
    counter.count++;
    const result: SimplifiedRefNode = {
      name: node.name,
      type: node.type || 'frame',
    };
    if (node.componentRef) result.componentRef = node.componentRef;
    if (node.children?.length) {
      const simplified = node.children
        .map((c: any) => simplifyTemplateNode(c, depth + 1, counter))
        .filter(Boolean) as SimplifiedRefNode[];
      if (simplified.length > 0) result.children = simplified;
    }
    return result;
  }, []);

  const selectPrefab = useCallback(async (entry: PrefabEntry) => {
    setSelectedPrefab(entry);
    setPrefabDropdownOpen(false);
    setPrefabSearch('');
    setRefLoading(true);
    try {
      const res = await fetch(`/api/prefabs/parse?path=${encodeURIComponent(entry.relPath)}&name=${encodeURIComponent(entry.name)}`);
      const data = await res.json();
      if (data.root) {
        setRefStructure(simplifyTemplateNode(data.root));
      } else {
        setRefStructure(null);
      }
    } catch {
      setRefStructure(null);
    }
    setRefLoading(false);
  }, [simplifyTemplateNode]);

  const clearPrefab = useCallback(() => {
    setSelectedPrefab(null);
    setRefStructure(null);
    setPrefabSearch('');
  }, []);

  useEffect(() => {
    if (!prefabDropdownOpen) return;
    const handleClick = () => setPrefabDropdownOpen(false);
    const timer = setTimeout(() => document.addEventListener('click', handleClick), 0);
    return () => { clearTimeout(timer); document.removeEventListener('click', handleClick); };
  }, [prefabDropdownOpen]);

  const reset = useCallback(() => {
    setLoading(false);
    setError('');
    setRenameResult(null);
    setRebuildResult(null);
    setGenerateResult(null);
    setRefImageResult(null);
  }, []);

  const handleClose = useCallback(() => {
    reset();
    setSelectedPrefab(null);
    setRefStructure(null);
    setPrefabSearch('');
    setDocText('');
    setDocImages([]);
    setDocFileName('');
    setRefImages([]);
    setRefDescription('');
    onClose();
  }, [reset, onClose]);

  // 解析上传的文档文件（.docx / .xlsx / .xls）
  const handleFileUpload = useCallback(async (file: File) => {
    setDocFileName(file.name);
    const ext = file.name.toLowerCase().split('.').pop();
    try {
      const arrayBuffer = await file.arrayBuffer();

      if (ext === 'xlsx' || ext === 'xls') {
        // Excel 解析
        const workbook = XLSX.read(arrayBuffer, { type: 'array' });
        const textParts: string[] = [];
        for (const sheetName of workbook.SheetNames) {
          const sheet = workbook.Sheets[sheetName];
          const csv = XLSX.utils.sheet_to_csv(sheet);
          if (csv.trim()) {
            textParts.push(`## Sheet: ${sheetName}\n${csv}`);
          }
        }
        setDocText(textParts.join('\n\n'));
        setDocImages([]);
      } else {
        // Word 解析
        const textResult = await mammoth.extractRawText({ arrayBuffer });
        setDocText(textResult.value);

        // 提取文档中的图片
        const images: Array<{ type: string; media_type: string; data: string }> = [];
        await mammoth.convertToHtml({
          arrayBuffer,
          convertImage: mammoth.images.imgElement(async (image: any) => {
            const buffer = await image.read();
            const base64 = btoa(
              new Uint8Array(buffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
            );
            const mediaType = image.contentType || 'image/png';
            images.push({ type: 'base64', media_type: mediaType, data: base64 });
            return { src: '' };
          }),
        } as any);
        setDocImages(images);
      }
    } catch (e: any) {
      setError(`文档解析失败: ${e.message}`);
    }
  }, []);

  // 处理拖放
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file && /\.(docx|xlsx|xls)$/i.test(file.name)) {
      handleFileUpload(file);
    } else if (file) {
      setError('仅支持 .docx / .xlsx / .xls 格式文件');
    }
  }, [handleFileUpload]);

  // 处理图片粘贴
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          const m = dataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
          if (m) {
            setDocImages(prev => [...prev, { type: 'base64', media_type: m[1], data: m[2] }]);
          }
        };
        reader.readAsDataURL(file);
      }
    }
  }, []);

  // 提交文档生成
  const handleGenerate = async () => {
    reset();
    setLoading(true);
    try {
      const res = await fetch('/api/ai/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          documentText: docText,
          panelName,
          images: docImages.length > 0 ? docImages : undefined,
        }),
      });

      let data: any;
      try {
        const text = await res.text();
        data = text ? JSON.parse(text) : {};
      } catch {
        setError(`服务器返回了无效响应 (HTTP ${res.status})，请检查终端日志`);
        setLoading(false);
        return;
      }

      if (!res.ok || !data.success) {
        setError(data.error || `请求失败 (${res.status})`);
        setLoading(false);
        return;
      }

      const structure = data.result;
      if (!structure?.template || !structure?.panelName) {
        setError('AI 返回格式异常：缺少 template 或 panelName 字段');
      } else {
        setGenerateResult(structure);
      }
    } catch (e: any) {
      setError(e.message || '网络请求失败');
    }
    setLoading(false);
  };

  // 应用文档生成结果
  const applyGenerate = () => {
    if (!generateResult) return;
    if (!confirm('将根据文档生成 UI 结构并添加到画布，此操作可通过 Ctrl+Z 撤销。确定继续？')) return;
    const store = useEditorStore.getState();
    store.pushHistory();
    pendingSliceNodes.length = 0;
    const structTree = buildPanelFromAI(generateResult as unknown as AIGenerateResult);
    importStructNode(structTree, null, store.addNode, 0, 0);
    applySliceBorders();
    handleClose();
  };

  // ─── 参考图生成 ───

  const handleRefImageFile = useCallback((file: File) => {
    if (!file.type.startsWith('image/')) {
      setError('仅支持图片文件');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const m = dataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
      if (m) {
        setRefImages(prev => [...prev, { type: 'base64', media_type: m[1], data: m[2] }]);
      }
    };
    reader.readAsDataURL(file);
  }, []);

  const handleRefImageDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files);
    for (const file of files) {
      if (file.type.startsWith('image/')) handleRefImageFile(file);
    }
  }, [handleRefImageFile]);

  const handleRefImagePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) handleRefImageFile(file);
      }
    }
  }, [handleRefImageFile]);

  const handleGenerateFromImage = async () => {
    reset();
    setLoading(true);
    try {
      const res = await fetch('/api/ai/generate-from-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          images: refImages,
          panelName,
          description: refDescription || undefined,
          ...(refStructure ? { referenceStructure: refStructure } : {}),
        }),
      });

      let data: any;
      try {
        const text = await res.text();
        data = text ? JSON.parse(text) : {};
      } catch {
        setError(`服务器返回了无效响应 (HTTP ${res.status})，请检查终端日志`);
        setLoading(false);
        return;
      }

      if (!res.ok || !data.success) {
        setError(data.error || `请求失败 (${res.status})`);
        setLoading(false);
        return;
      }

      const structure = data.result;
      if (!structure?.name) {
        setError('AI 返回格式异常：缺少有效的结构');
      } else {
        if (data.autoInjectedRef) {
          console.log(`[AI] 已自动套用 ${data.autoInjectedRef} 框架结构 (mode=${data.mode || 'ref'})`);
        }
        setRefImageResult(structure);
      }
    } catch (e: any) {
      setError(e.message || '网络请求失败');
    }
    setLoading(false);
  };

  const applyRefImage = () => {
    if (!refImageResult) return;
    if (!confirm('将根据参考图生成 UI 结构并添加到画布，此操作可通过 Ctrl+Z 撤销。确定继续？')) return;
    const store = useEditorStore.getState();
    store.pushHistory();
    pendingSliceNodes.length = 0;
    importStructNode(refImageResult, null, store.addNode, 0, 0);
    applySliceBorders();
    handleClose();
  };

  // 提交 AI 分析
  const handleSubmit = async () => {
    reset();
    setLoading(true);

    // 自动从画布截取效果图
    let finalScreenshot: string | undefined;
    if (unityBridge.isReady) {
      const captured = unityBridge.captureCanvas();
      if (captured && captured.length > 100) {
        finalScreenshot = captured;
      }
    }

    try {
      const res = await fetch('/api/ai/normalize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'rebuild',
          nodes,
          rootIds,
          screenshot: finalScreenshot,
          panelName,
          ...(refStructure ? { referenceStructure: refStructure } : {}),
        }),
      });

      // 安全解析 JSON 响应
      let data: any;
      try {
        const text = await res.text();
        data = text ? JSON.parse(text) : {};
      } catch {
        setError(`服务器返回了无效响应 (HTTP ${res.status})，请检查终端日志`);
        setLoading(false);
        return;
      }

      if (!res.ok || !data.success) {
        setError(data.error || `请求失败 (${res.status})`);
        setLoading(false);
        return;
      }

      const structure = data.result;
      if (!structure?.name) {
        setError('AI 返回格式异常：缺少有效的结构');
      } else {
        setRebuildResult(structure);
      }
    } catch (e: any) {
      setError(e.message || '网络请求失败');
    }
    setLoading(false);
  };

  // 应用重命名
  const applyRenames = () => {
    if (!renameResult) return;
    const store = useEditorStore.getState();
    store.pushHistory();
    for (const r of renameResult) {
      const updates: Partial<{ name: string; type: NodeType; componentRef: string }> = { name: r.newName };
      if (r.newType) updates.type = r.newType as NodeType;
      if (r.componentRef) updates.componentRef = r.componentRef;
      store.updateNode(r.id, updates);
    }
    handleClose();
  };

  // 应用重建
  const applyRebuild = () => {
    if (!rebuildResult) return;
    if (!confirm('重建结构将替换当前画布内容，此操作可通过 Ctrl+Z 撤销。确定继续？')) return;
    const store = useEditorStore.getState();
    const originalNodes = { ...store.nodes };
    const originalRootIds = [...store.rootIds];
    const pw = store.previewWidth || DESIGN_WIDTH;
    const ph = store.previewHeight || DESIGN_HEIGHT;
    store.pushHistory();
    store.clearAll();
    pendingSliceNodes.length = 0;

    // 判断 AI 返回的是重构树（有 origId）还是旧格式 StructNode
    const isRestructureTree = hasOrigIdInTree(rebuildResult);
    if (isRestructureTree) {
      restructureFromTree(rebuildResult as RestructureNode, originalNodes, originalRootIds, store.addNode, pw, ph);
    } else {
      importStructNode(rebuildResult as StructNode, null, store.addNode, 100, 100);
    }
    applySliceBorders();
    handleClose();
  };

  if (!open) return null;

  const hasResult = renameResult || rebuildResult || generateResult || refImageResult;

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/30" />
      <div className={`fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[51] bg-[#1e1e2e] border border-[#45475a] rounded-lg shadow-2xl max-h-[85vh] flex flex-col ${hasResult ? 'w-[700px]' : 'w-[560px]'}`}>
        {/* 标题栏 */}
        <div className="px-5 py-3.5 border-b border-[#45475a] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h3 className="text-[15px] font-medium text-[#cdd6f4]">
              AI 助手{hasResult ? ' — 预览结果' : ''}
            </h3>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowSettings(true)}
              className="text-[12px] text-[#a6adc8] hover:text-[#cdd6f4] px-2 py-1 rounded hover:bg-[#313244]"
              title="AI 设置"
            >
              设置
            </button>
            <button onClick={handleClose} className="text-[#6c7086] hover:text-[#cdd6f4] text-lg leading-none">×</button>
          </div>
        </div>

        {/* Tab 切换 */}
        {!hasResult && (
          <div className="flex border-b border-[#45475a]">
            <button
              onClick={() => { reset(); setActiveTab('normalize'); }}
              className={`flex-1 px-4 py-2.5 text-[13px] font-medium transition-colors ${
                activeTab === 'normalize'
                  ? 'text-[#f9e2af] border-b-2 border-[#f9e2af] bg-[#f9e2af]/5'
                  : 'text-[#6c7086] hover:text-[#a6adc8] hover:bg-[#313244]/50'
              }`}
            >
              规范化
              <span className="ml-1.5 text-[11px] opacity-60">现有画布</span>
            </button>
            <button
              onClick={() => { reset(); setActiveTab('generate'); }}
              className={`flex-1 px-4 py-2.5 text-[13px] font-medium transition-colors ${
                activeTab === 'generate'
                  ? 'text-[#89b4fa] border-b-2 border-[#89b4fa] bg-[#89b4fa]/5'
                  : 'text-[#6c7086] hover:text-[#a6adc8] hover:bg-[#313244]/50'
              }`}
            >
              文档生成
              <span className="ml-1.5 text-[11px] opacity-60">策划文档 → UI</span>
            </button>
            <button
              onClick={() => { reset(); setActiveTab('reference'); }}
              className={`flex-1 px-4 py-2.5 text-[13px] font-medium transition-colors ${
                activeTab === 'reference'
                  ? 'text-[#a6e3a1] border-b-2 border-[#a6e3a1] bg-[#a6e3a1]/5'
                  : 'text-[#6c7086] hover:text-[#a6adc8] hover:bg-[#313244]/50'
              }`}
            >
              参考图生成
              <span className="ml-1.5 text-[11px] opacity-60">截图 → UE 稿</span>
            </button>
          </div>
        )}

        {/* 内容区 */}
        <div className="px-5 py-5 flex-1 overflow-auto flex flex-col gap-4">
          {!hasResult ? (
            <>
              {/* ═══ 规范化 Tab ═══ */}
              {activeTab === 'normalize' && (
                <>
                  <div className="text-[13px] text-[#6c7086] leading-relaxed">
                    AI 将分析当前画布中的节点，自动重组层级结构并按规范重命名，生成符合项目标准的 UI 布局。
                  </div>

                  <div className="flex items-center gap-2">
                    <span className="text-[12px] text-[#6c7086] bg-[#313244] px-2 py-0.5 rounded">{nodeCount} 个节点</span>
                  </div>

                  {/* 面板名称 */}
                  <div>
                    <label className="text-[13px] text-[#a6adc8] mb-2 block font-medium">面板名称</label>
                    <input
                      autoFocus
                      value={panelName}
                      onChange={e => setPanelName(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter' && !loading && nodeCount > 0) handleSubmit(); }}
                      className="w-full px-3 py-2 text-sm bg-[#313244] text-[#cdd6f4] border border-[#45475a] rounded-md focus:border-[#89b4fa] outline-none"
                      placeholder="例如: StrengthImprovePanel"
                    />
                  </div>

                  {/* 参考已有结构 */}
                  <div>
                    <label className="text-[13px] text-[#a6adc8] mb-2 block font-medium">参考已有结构（可选）</label>
                    {selectedPrefab ? (
                      <div className="flex items-center gap-2">
                        <div className="flex-1 px-3 py-2 text-sm bg-[#313244] text-[#cdd6f4] border border-[#45475a] rounded-md truncate">
                          {selectedPrefab.name}
                          <span className="text-[#6c7086] ml-2 text-[12px]">{selectedPrefab.category}</span>
                        </div>
                        <button
                          onClick={clearPrefab}
                          className="px-2 py-2 text-sm text-[#f38ba8] hover:bg-[#313244] rounded"
                          title="清除参考"
                        >
                          ×
                        </button>
                      </div>
                    ) : (
                      <div className="relative">
                        <input
                          value={prefabSearch}
                          onChange={e => { setPrefabSearch(e.target.value); setPrefabDropdownOpen(true); }}
                          onFocus={() => setPrefabDropdownOpen(true)}
                          className="w-full px-3 py-2 text-sm bg-[#313244] text-[#cdd6f4] border border-[#45475a] rounded-md focus:border-[#89b4fa] outline-none"
                          placeholder="搜索 prefab..."
                        />
                        {prefabDropdownOpen && Array.isArray(prefabList) && prefabList.length > 0 && (
                          <div className="absolute z-10 w-full mt-1 max-h-[200px] overflow-auto bg-[#313244] border border-[#45475a] rounded-md shadow-lg">
                            {prefabList
                              .filter(p => !prefabSearch || p.name.toLowerCase().includes(prefabSearch.toLowerCase()))
                              .slice(0, 50)
                              .map(p => (
                                <button
                                  key={p.relPath}
                                  onClick={() => selectPrefab(p)}
                                  className="w-full text-left px-3 py-1.5 text-sm text-[#cdd6f4] hover:bg-[#45475a] truncate"
                                >
                                  {p.name}
                                  <span className="text-[#6c7086] ml-2 text-[12px]">{p.category}</span>
                                </button>
                              ))
                            }
                            {prefabList.filter(p => !prefabSearch || p.name.toLowerCase().includes(prefabSearch.toLowerCase())).length === 0 && (
                              <div className="px-3 py-2 text-sm text-[#6c7086]">未找到匹配的 prefab</div>
                            )}
                          </div>
                        )}
                      </div>
                    )}

                    {/* 参考结构预览 */}
                    {refLoading && (
                      <div className="mt-2 text-[12px] text-[#6c7086]">加载参考结构中...</div>
                    )}
                    {refStructure && !refLoading && (
                      <div className="mt-2 max-h-[150px] overflow-auto border border-[#313244] rounded bg-[#313244]/50 py-1">
                        <RefTreeNode node={refStructure} depth={0} />
                      </div>
                    )}
                  </div>
                </>
              )}

              {/* ═══ 文档生成 Tab ═══ */}
              {activeTab === 'generate' && (
                <>
                  <div className="text-[13px] text-[#6c7086] leading-relaxed">
                    上传策划文档或粘贴文字描述，AI 将分析内容并生成对应的 UI 结构。支持 .docx 文件（含图片提取）和 .xlsx / .xls 表格文件。
                  </div>

                  {/* 面板名称 */}
                  <div>
                    <label className="text-[13px] text-[#a6adc8] mb-2 block font-medium">面板名称</label>
                    <input
                      value={panelName}
                      onChange={e => setPanelName(e.target.value)}
                      className="w-full px-3 py-2 text-sm bg-[#313244] text-[#cdd6f4] border border-[#45475a] rounded-md focus:border-[#89b4fa] outline-none"
                      placeholder="例如: ShopPanel"
                    />
                  </div>

                  {/* 文件上传区 */}
                  <div>
                    <label className="text-[13px] text-[#a6adc8] mb-2 block font-medium">策划文档</label>
                    <div
                      onDrop={handleDrop}
                      onDragOver={e => e.preventDefault()}
                      onClick={() => fileInputRef.current?.click()}
                      className="border-2 border-dashed border-[#45475a] rounded-lg px-4 py-3 text-center cursor-pointer hover:border-[#89b4fa] hover:bg-[#89b4fa]/5 transition-colors"
                    >
                      {docFileName ? (
                        <div className="flex items-center justify-center gap-2">
                          <span className="text-[13px] text-[#a6e3a1]">{docFileName}</span>
                          <button
                            onClick={(e) => { e.stopPropagation(); setDocFileName(''); setDocText(''); setDocImages([]); }}
                            className="text-[#f38ba8] hover:text-[#f38ba8]/80 text-sm"
                          >
                            ×
                          </button>
                        </div>
                      ) : (
                        <div className="text-[13px] text-[#6c7086]">
                          点击或拖放 .docx / .xlsx 文件到这里
                        </div>
                      )}
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept=".docx,.xlsx,.xls"
                        className="hidden"
                        onChange={e => {
                          const file = e.target.files?.[0];
                          if (file) handleFileUpload(file);
                          e.target.value = '';
                        }}
                      />
                    </div>
                  </div>

                  {/* 文字内容 */}
                  <div>
                    <label className="text-[13px] text-[#a6adc8] mb-2 block font-medium">
                      文档内容
                      <span className="font-normal text-[#6c7086] ml-2">
                        {docFileName ? '已从文件提取，可编辑修改' : '或直接粘贴文字描述'}
                      </span>
                    </label>
                    <textarea
                      value={docText}
                      onChange={e => setDocText(e.target.value)}
                      onPaste={handlePaste}
                      placeholder={`粘贴策划文档内容，例如：

商城界面：
- 顶部显示玩家货币（金币、钻石）
- 左侧 tab 切换：推荐、道具、礼包、限时
- 主区域显示商品列表，每行3个
- 每个商品卡片包含：图标、名称、价格、购买按钮
- 底部显示刷新倒计时

也可以直接粘贴截图（Ctrl+V）`}
                      className="w-full min-h-[150px] max-h-[250px] text-sm bg-[#313244] border border-[#45475a] text-[#cdd6f4] rounded-md p-3 resize-none outline-none focus:border-[#89b4fa]"
                    />
                  </div>

                  {/* 已提取图片预览 */}
                  {docImages.length > 0 && (
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <label className="text-[13px] text-[#a6adc8] font-medium">
                          附带图片 ({docImages.length})
                        </label>
                        <button
                          onClick={() => setDocImages([])}
                          className="text-[11px] text-[#f38ba8] hover:text-[#f38ba8]/80"
                        >
                          清除全部
                        </button>
                      </div>
                      <div className="flex gap-2 flex-wrap">
                        {docImages.map((img, i) => (
                          <div key={i} className="relative group">
                            <img
                              src={`data:${img.media_type};base64,${img.data}`}
                              alt={`图片 ${i + 1}`}
                              className="w-16 h-16 object-cover rounded border border-[#45475a]"
                            />
                            <button
                              onClick={() => setDocImages(prev => prev.filter((_, j) => j !== i))}
                              className="absolute -top-1 -right-1 w-4 h-4 bg-[#f38ba8] text-[#1e1e2e] rounded-full text-[10px] leading-none hidden group-hover:flex items-center justify-center"
                            >
                              ×
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}

              {/* ═══ 参考图生成 Tab ═══ */}
              {activeTab === 'reference' && (
                <>
                  <div className="text-[13px] text-[#6c7086] leading-relaxed">
                    上传游戏 UI 参考截图，AI 将自动分析视觉结构、套用 LOA 命名规范、引用项目已有图片资源和通用组件，生成可直接导入画布的 UE 稿。
                  </div>

                  {/* 面板名称 */}
                  <div>
                    <label className="text-[13px] text-[#a6adc8] mb-2 block font-medium">面板名称</label>
                    <input
                      value={panelName}
                      onChange={e => setPanelName(e.target.value)}
                      className="w-full px-3 py-2 text-sm bg-[#313244] text-[#cdd6f4] border border-[#45475a] rounded-md focus:border-[#a6e3a1] outline-none"
                      placeholder="例如: RewardPanel"
                    />
                  </div>

                  {/* 参考图上传区 */}
                  <div>
                    <label className="text-[13px] text-[#a6adc8] mb-2 block font-medium">
                      参考图
                      <span className="font-normal text-[#6c7086] ml-2">支持拖拽/点击/Ctrl+V 粘贴，可多张</span>
                    </label>
                    <div
                      onDrop={handleRefImageDrop}
                      onDragOver={e => e.preventDefault()}
                      onPaste={handleRefImagePaste}
                      onClick={() => refFileInputRef.current?.click()}
                      tabIndex={0}
                      className="border-2 border-dashed border-[#45475a] rounded-lg px-4 py-6 text-center cursor-pointer hover:border-[#a6e3a1] hover:bg-[#a6e3a1]/5 transition-colors focus:outline-none focus:border-[#a6e3a1]"
                    >
                      <div className="text-[13px] text-[#6c7086]">
                        {refImages.length > 0
                          ? `已添加 ${refImages.length} 张参考图（点击继续添加或粘贴）`
                          : '点击选择 / 拖放 / Ctrl+V 粘贴游戏 UI 截图'}
                      </div>
                      <input
                        ref={refFileInputRef}
                        type="file"
                        accept="image/*"
                        multiple
                        className="hidden"
                        onChange={e => {
                          const files = Array.from(e.target.files || []);
                          for (const f of files) handleRefImageFile(f);
                          e.target.value = '';
                        }}
                      />
                    </div>

                    {/* 缩略图预览 */}
                    {refImages.length > 0 && (
                      <div className="flex gap-2 flex-wrap mt-2">
                        {refImages.map((img, i) => (
                          <div key={i} className="relative group">
                            <img
                              src={`data:${img.media_type};base64,${img.data}`}
                              alt={`参考图 ${i + 1}`}
                              className="w-20 h-20 object-cover rounded border border-[#45475a]"
                            />
                            <button
                              onClick={() => setRefImages(prev => prev.filter((_, j) => j !== i))}
                              className="absolute -top-1 -right-1 w-5 h-5 bg-[#f38ba8] text-[#1e1e2e] rounded-full text-[11px] leading-none flex items-center justify-center opacity-0 group-hover:opacity-100"
                            >
                              ×
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* 功能描述（可选） */}
                  <div>
                    <label className="text-[13px] text-[#a6adc8] mb-2 block font-medium">
                      功能描述
                      <span className="font-normal text-[#6c7086] ml-2">可选，一句话说明用途</span>
                    </label>
                    <textarea
                      value={refDescription}
                      onChange={e => setRefDescription(e.target.value)}
                      placeholder="例如：七日登录奖励页，每天领一次，已领过的格子置灰"
                      className="w-full min-h-[60px] max-h-[120px] text-sm bg-[#313244] border border-[#45475a] text-[#cdd6f4] rounded-md p-3 resize-none outline-none focus:border-[#a6e3a1]"
                    />
                  </div>

                  {/* 参考已有结构（可选，复用 normalize Tab 的选择器） */}
                  <div>
                    <label className="text-[13px] text-[#a6adc8] mb-2 block font-medium">
                      参考已有结构
                      <span className="font-normal text-[#f9e2af] ml-2">强烈推荐：选一个相似的活动/功能 prefab，AI 会复用其布局</span>
                    </label>
                    {selectedPrefab ? (
                      <div className="flex items-center gap-2">
                        <div className="flex-1 px-3 py-2 text-sm bg-[#313244] text-[#cdd6f4] border border-[#45475a] rounded-md truncate">
                          {selectedPrefab.name}
                          <span className="text-[#6c7086] ml-2 text-[12px]">{selectedPrefab.category}</span>
                        </div>
                        <button
                          onClick={clearPrefab}
                          className="px-2 py-2 text-sm text-[#f38ba8] hover:bg-[#313244] rounded"
                          title="清除参考"
                        >
                          ×
                        </button>
                      </div>
                    ) : (
                      <div className="relative">
                        <input
                          value={prefabSearch}
                          onChange={e => { setPrefabSearch(e.target.value); setPrefabDropdownOpen(true); }}
                          onFocus={() => setPrefabDropdownOpen(true)}
                          className="w-full px-3 py-2 text-sm bg-[#313244] text-[#cdd6f4] border border-[#45475a] rounded-md focus:border-[#a6e3a1] outline-none"
                          placeholder="搜索 prefab..."
                        />
                        {prefabDropdownOpen && Array.isArray(prefabList) && prefabList.length > 0 && (
                          <div className="absolute z-10 w-full mt-1 max-h-[200px] overflow-auto bg-[#313244] border border-[#45475a] rounded-md shadow-lg">
                            {prefabList
                              .filter(p => !prefabSearch || p.name.toLowerCase().includes(prefabSearch.toLowerCase()))
                              .slice(0, 50)
                              .map(p => (
                                <button
                                  key={p.relPath}
                                  onClick={() => selectPrefab(p)}
                                  className="w-full text-left px-3 py-1.5 text-sm text-[#cdd6f4] hover:bg-[#45475a] truncate"
                                >
                                  {p.name}
                                  <span className="text-[#6c7086] ml-2 text-[12px]">{p.category}</span>
                                </button>
                              ))
                            }
                            {prefabList.filter(p => !prefabSearch || p.name.toLowerCase().includes(prefabSearch.toLowerCase())).length === 0 && (
                              <div className="px-3 py-2 text-sm text-[#6c7086]">未找到匹配的 prefab</div>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                    {refLoading && (
                      <div className="mt-2 text-[12px] text-[#6c7086]">加载参考结构中...</div>
                    )}
                    {refStructure && !refLoading && (
                      <div className="mt-2 max-h-[150px] overflow-auto border border-[#313244] rounded bg-[#313244]/50 py-1">
                        <RefTreeNode node={refStructure} depth={0} />
                      </div>
                    )}
                  </div>
                </>
              )}

              {/* 错误 */}
              {error && (
                <div className="text-sm text-[#f38ba8] bg-[#f38ba8]/10 px-3 py-2.5 rounded-md">{error}</div>
              )}
            </>
          ) : (
            <>
              {/* 重命名结果预览 */}
              {renameResult && (
                <div>
                  <div className="text-sm text-[#a6adc8] mb-2">
                    共 {renameResult.length} 个节点需要更新
                  </div>
                  <div className="max-h-[400px] overflow-auto border border-[#313244] rounded">
                    <table className="w-full text-sm">
                      <thead className="bg-[#313244] sticky top-0">
                        <tr>
                          <th className="text-left px-3 py-1.5 text-[#a6adc8]">#</th>
                          <th className="text-left px-3 py-1.5 text-[#a6adc8]">原名称</th>
                          <th className="text-left px-3 py-1.5 text-[#a6adc8]">新名称</th>
                          <th className="text-left px-3 py-1.5 text-[#a6adc8]">类型变更</th>
                        </tr>
                      </thead>
                      <tbody>
                        {renameResult.map((r, i) => {
                          const node = nodes[r.id];
                          return (
                            <tr key={r.id} className="border-t border-[#313244] hover:bg-[#313244]/50">
                              <td className="px-3 py-1.5 text-[#6c7086]">{i + 1}</td>
                              <td className="px-3 py-1.5 text-[#f38ba8]">{node?.name || '?'}</td>
                              <td className="px-3 py-1.5 text-[#a6e3a1]">{r.newName}</td>
                              <td className="px-3 py-1.5 text-[#f9e2af]">
                                {r.newType && node?.type !== r.newType ? `${node?.type} → ${r.newType}` : ''}
                                {r.componentRef ? ` (${r.componentRef})` : ''}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* 重建 / 生成结果预览 — 树状图 */}
              {(rebuildResult || generateResult || refImageResult) && (
                <div>
                  <div className="text-sm text-[#a6adc8] mb-2">生成的结构树</div>
                  <div className="max-h-[400px] overflow-auto border border-[#313244] rounded bg-[#313244]/50 py-2">
                    <RebuildTreeNode node={(rebuildResult || generateResult || refImageResult)!} depth={0} />
                  </div>
                </div>
              )}
            </>
          )}

          {/* 加载中 */}
          {loading && (
            <div className="flex items-center justify-center py-8">
              <div className="flex items-center gap-3">
                <div className="w-5 h-5 border-2 border-[#89b4fa] border-t-transparent rounded-full animate-spin" />
                <span className="text-sm text-[#a6adc8]">
                  {activeTab === 'generate' ? 'AI 正在分析文档并生成 UI 结构...' : activeTab === 'reference' ? 'AI 正在分析参考图并生成 UI 结构...' : 'AI 处理中，请稍候...'}
                </span>
              </div>
            </div>
          )}
        </div>

        {/* 底部按钮 */}
        <div className="px-5 py-4 border-t border-[#45475a] flex justify-between">
          <div>
            {hasResult && (
              <button
                onClick={reset}
                className="px-3 py-1.5 text-sm text-[#a6adc8] hover:bg-[#313244] rounded"
              >
                重新分析
              </button>
            )}
          </div>
          <div className="flex gap-3">
            <button onClick={handleClose} className="px-4 py-1.5 text-sm text-[#a6adc8] hover:bg-[#313244] rounded">
              取消
            </button>
            {!hasResult ? (
              activeTab === 'normalize' ? (
                <button
                  onClick={handleSubmit}
                  disabled={loading || nodeCount === 0}
                  className="px-5 py-1.5 text-sm bg-[#f9e2af] text-[#1e1e2e] rounded hover:bg-[#f9e2af]/80 disabled:opacity-50 font-medium"
                >
                  {loading ? 'AI 分析中...' : '开始分析'}
                </button>
              ) : activeTab === 'generate' ? (
                <button
                  onClick={handleGenerate}
                  disabled={loading || !docText.trim()}
                  className="px-5 py-1.5 text-sm bg-[#89b4fa] text-[#1e1e2e] rounded hover:bg-[#89b4fa]/80 disabled:opacity-50 font-medium"
                >
                  {loading ? '生成中...' : '生成 UI'}
                </button>
              ) : (
                <button
                  onClick={handleGenerateFromImage}
                  disabled={loading || refImages.length === 0 || !panelName.trim()}
                  className="px-5 py-1.5 text-sm bg-[#a6e3a1] text-[#1e1e2e] rounded hover:bg-[#a6e3a1]/80 disabled:opacity-50 font-medium"
                >
                  {loading ? '生成中...' : '生成 UE 稿'}
                </button>
              )
            ) : (
              <button
                onClick={renameResult ? applyRenames : (generateResult ? applyGenerate : (refImageResult ? applyRefImage : applyRebuild))}
                className="px-5 py-1.5 text-sm bg-[#a6e3a1] text-[#1e1e2e] rounded hover:bg-[#94e2d5] font-medium"
              >
                应用到画布
              </button>
            )}
          </div>
        </div>
      </div>

      {/* 设置弹窗 */}
      <AISettingsDialog open={showSettings} onClose={() => setShowSettings(false)} />
    </>
  );
}

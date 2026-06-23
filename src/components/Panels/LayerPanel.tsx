import { useState, useRef, useCallback, useEffect, createContext, useContext, memo } from 'react';
import { useEditorStore } from '../../stores/editorStore';
import { useShallow } from 'zustand/react/shallow';
import type { NodeType } from '../../types';
import {
  closeBridgeArtboardSession,
  createWidgetNodeOnBridge,
  deleteNodeOnBridge,
  duplicateBridgeArtboard,
  duplicateBridgePage,
  duplicateNodesOnBridge,
  renameNodeOnBridge,
  reparentNodesOnBridge,
  setVisibleOnBridge,
} from '../../services/BridgeArtboardStore';

// 拖拽放置位置指示
type DropPosition = 'before' | 'inside' | 'after';

interface LayerCollapseCtx {
  collapsedIds: Set<string>;
  toggleCollapse: (id: string) => void;
  setCollapsed: (id: string, value: boolean) => void;
}

const CollapseContext = createContext<LayerCollapseCtx>({
  collapsedIds: new Set(),
  toggleCollapse: () => {},
  setCollapsed: () => {},
});

const LayerItem = memo(function LayerItem({ nodeId, depth = 0 }: { nodeId: string; depth?: number }) {
  // 拖动节点会修改 x/y，但 LayerItem 渲染不依赖这些字段。
  // 用 useShallow 只在渲染相关字段变化时触发 re-render。
  const node = useEditorStore(useShallow((s) => {
    const n = s.nodes[nodeId];
    if (!n) return null;
    return {
      name: n.name,
      type: n.type,
      visible: n.visible,
      locked: n.locked,
      children: n.children,
      parentId: n.parentId,
    };
  }));
  const selectedIds = useEditorStore((s) => s.selectedIds);
  const setSelectedIds = useEditorStore((s) => s.setSelectedIds);
  const updateNode = useEditorStore((s) => s.updateNode);
  const requestRenameCounter = useEditorStore((s) => s.requestRenameCounter);

  const { collapsedIds, toggleCollapse, setCollapsed: setCollapseState } = useContext(CollapseContext);
  const collapsed = collapsedIds.has(nodeId);
  const [dropIndicator, setDropIndicator] = useState<DropPosition | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [renamingValue, setRenamingValue] = useState('');
  const rowRef = useRef<HTMLDivElement>(null);

  if (!node) return null;

  const isSelected = selectedIds.includes(nodeId);
  const hasChildren = node.children.length > 0;

  const typeIcons: Record<NodeType, string> = {
    frame: '▢',
    text: 'T',
    image: '🖼',
    component: '◈',
    button: 'B',
    scrollview: 'S',
    toggle: 'G',
    inputfield: 'I',
    rawimage: 'R',
  };
  const typeIcon = typeIcons[node.type];

  // 拖拽开始
  const handleDragStart = (e: React.DragEvent) => {
    // 如果当前节点在多选列表中，拖拽所有选中节点；否则只拖当前节点
    const dragIds = selectedIds.includes(nodeId) ? selectedIds : [nodeId];
    e.dataTransfer.setData('application/layer-node', JSON.stringify(dragIds));
    e.dataTransfer.effectAllowed = 'move';
    const ghost = document.createElement('div');
    ghost.style.position = 'absolute';
    ghost.style.top = '-9999px';
    ghost.style.padding = '2px 8px';
    ghost.style.background = '#313244';
    ghost.style.color = '#cdd6f4';
    ghost.style.fontSize = '11px';
    ghost.style.borderRadius = '4px';
    ghost.style.whiteSpace = 'nowrap';
    ghost.textContent = dragIds.length > 1 ? `${node.name} 等 ${dragIds.length} 项` : node.name;
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, 0, 0);
    requestAnimationFrame(() => document.body.removeChild(ghost));
    e.stopPropagation();
  };

  // 拖拽经过 — 判断放置位置
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = rowRef.current?.getBoundingClientRect();
    if (!rect) return;

    const y = e.clientY - rect.top;
    const h = rect.height;

    if (y < h * 0.25) {
      setDropIndicator('before');
    } else if (y > h * 0.75) {
      setDropIndicator('after');
    } else {
      setDropIndicator('inside'); // 作为子节点
    }
  };

  const handleDragLeave = () => setDropIndicator(null);

  // 放置
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const raw = e.dataTransfer.getData('application/layer-node');
    if (!raw) { setDropIndicator(null); return; }

    let dragIds: string[];
    try { dragIds = JSON.parse(raw); } catch { dragIds = [raw]; }
    // 过滤掉目标节点自身
    dragIds = dragIds.filter(id => id !== nodeId);
    if (dragIds.length === 0) { setDropIndicator(null); return; }

    // 不能把父节点拖进自己的子节点
    const isDescendant = (parentId: string, childId: string): boolean => {
      const parent = useEditorStore.getState().nodes[parentId];
      if (!parent) return false;
      if (parent.children.includes(childId)) return true;
      return parent.children.some((c) => isDescendant(c, childId));
    };
    // 过滤掉会造成循环引用的节点
    dragIds = dragIds.filter(id => !isDescendant(id, nodeId));
    if (dragIds.length === 0) { setDropIndicator(null); return; }

    const nodes = useEditorStore.getState().nodes;
    const targetNode = nodes[nodeId];
    const targetParentId = targetNode?.parentId;

    // 按原始顺序排列，保持拖拽后的相对顺序
    const allChildren = targetParentId
      ? nodes[targetParentId]?.children || []
      : useEditorStore.getState().rootIds;
    dragIds.sort((a, b) => {
      const pa = nodes[a]?.parentId;
      const pb = nodes[b]?.parentId;
      if (pa === pb) {
        const siblings = pa ? (nodes[pa]?.children || []) : useEditorStore.getState().rootIds;
        return siblings.indexOf(a) - siblings.indexOf(b);
      }
      return 0;
    });

    if (dropIndicator === 'inside') {
      void reparentNodesOnBridge(dragIds.map((id) => ({ nodeId: id, parentId: nodeId })), dragIds);
    } else if (dropIndicator === 'before') {
      const idx = allChildren.indexOf(nodeId);
      void reparentNodesOnBridge(dragIds.map((id, i) => ({ nodeId: id, parentId: targetParentId || null, index: idx + i })), dragIds);
    } else if (dropIndicator === 'after') {
      const idx = allChildren.indexOf(nodeId);
      void reparentNodesOnBridge(dragIds.map((id, i) => ({ nodeId: id, parentId: targetParentId || null, index: idx + 1 + i })), dragIds);
    }

    setDropIndicator(null);
  };

  // 右键菜单
  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY });
    // 如果当前节点不在已选中列表中，替换选中；否则保留多选
    if (!selectedIds.includes(nodeId)) {
      setSelectedIds([nodeId]);
    }
  };

  // 添加子节点
  const addChild = (type: 'frame' | 'text' | 'image') => {
    const names = { frame: 'Frame', text: 'Text', image: 'Image' };
    void createWidgetNodeOnBridge({
      widgetType: type,
      x: 0,
      y: 0,
      parentId: nodeId,
      name: names[type],
      width: type === 'text' ? 200 : 200,
      height: type === 'text' ? 40 : 150,
    });
    setCollapseState(nodeId, false);
    setContextMenu(null);
  };

  // 双击重命名
  const startRename = () => {
    setRenamingValue(node.name);
    setRenaming(true);
  };

  // 监听全局 F2 / 重命名请求：仅当本行为唯一选中项时触发
  const isOnlySelected = selectedIds.length === 1 && selectedIds[0] === nodeId;
  useEffect(() => {
    if (requestRenameCounter > 0 && isOnlySelected) startRename();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestRenameCounter]);

  // 双击定位：计算节点绝对位置并将画布居中到该节点
  const focusNode = () => {
    const store = useEditorStore.getState();
    const nodes = store.nodes;
    const realNode = nodes[nodeId];
    if (!realNode) return;
    // 计算绝对坐标
    let ax = 0, ay = 0;
    let cur = nodes[nodeId];
    while (cur) {
      ax += cur.x;
      ay += cur.y;
      cur = cur.parentId ? nodes[cur.parentId] : undefined as any;
    }
    const centerX = ax + realNode.width / 2;
    const centerY = ay + realNode.height / 2;
    // 获取画布容器大小（估算）
    const container = document.querySelector('[data-canvas-container]') as HTMLElement;
    const viewW = container?.clientWidth || 800;
    const viewH = container?.clientHeight || 600;
    // 根据节点大小计算合适的缩放
    const padFactor = 1.5;
    const fitScale = Math.min(viewW / (realNode.width * padFactor), viewH / (realNode.height * padFactor), 2);
    const scale = Math.max(0.3, Math.min(fitScale, 2));
    const cx = viewW / 2 - centerX * scale;
    const cy = viewH / 2 - centerY * scale;
    store.setCanvasTransform(cx, cy, scale);
  };

  const finishRename = () => {
    const name = renamingValue.trim();
    if (name && name !== node.name) void renameNodeOnBridge(nodeId, name);
    setRenaming(false);
  };

  // 放置位置指示样式
  const dropStyle = dropIndicator === 'before'
    ? 'border-t-2 border-[#89b4fa]'
    : dropIndicator === 'after'
      ? 'border-b-2 border-[#89b4fa]'
      : dropIndicator === 'inside'
        ? 'bg-[#89b4fa]/15'
        : '';

  return (
    <>
      <div
        ref={rowRef}
        data-layer-node-id={nodeId}
        title={node.name}
        className={`flex items-center gap-1 px-1 py-[3px] cursor-pointer text-[13px] select-none
          hover:bg-[#313244] ${isSelected ? 'bg-[#313244] text-[#89b4fa]' : 'text-[#a6adc8]'}
          ${dropStyle}`}
        style={{ paddingLeft: `${4 + depth * 14}px`, contain: 'layout style' }}
        draggable
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={(e) => {
          if (e.shiftKey) {
            // Shift+点击：范围选择（简化为追加）
            if (isSelected) {
              setSelectedIds(selectedIds.filter((id) => id !== nodeId));
            } else {
              setSelectedIds([...selectedIds, nodeId]);
            }
          } else if (e.ctrlKey || e.metaKey) {
            // Ctrl+点击：切换单个
            if (isSelected) {
              setSelectedIds(selectedIds.filter((id) => id !== nodeId));
            } else {
              setSelectedIds([...selectedIds, nodeId]);
            }
          } else {
            setSelectedIds([nodeId]);
          }
        }}
        onDoubleClick={() => { setSelectedIds([nodeId]); focusNode(); }}
        onKeyDown={(e) => { if (e.key === 'F2') { e.preventDefault(); startRename(); } }}
        tabIndex={-1}
        onContextMenu={handleContextMenu}
      >
        {/* 折叠箭头 — component 类型不显示 */}
        <span
          className={`text-[11px] w-3 text-center cursor-pointer ${hasChildren && node.type !== 'component' ? 'text-[#6c7086]' : 'opacity-0'}`}
          onClick={(e) => { e.stopPropagation(); if (hasChildren && node.type !== 'component') toggleCollapse(nodeId); }}
        >
          {hasChildren && node.type !== 'component' ? (collapsed ? '▶' : '▼') : '·'}
        </span>

        {/* 类型图标 */}
        <span className="text-[12px] opacity-50 w-3 text-center">{typeIcon}</span>

        {/* 名称 / 重命名输入框 */}
        {renaming ? (
          <input
            autoFocus
            className="flex-1 text-[13px] bg-[#45475a] border border-[#89b4fa] text-[#cdd6f4] rounded px-1 outline-none"
            value={renamingValue}
            onChange={(e) => setRenamingValue(e.target.value)}
            onBlur={finishRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') finishRename();
              if (e.key === 'Escape') setRenaming(false);
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="whitespace-nowrap flex-1">{node.name}</span>
        )}

        {/* 可见性 */}
        <button
          className={`text-[11px] px-0.5 ${node.visible ? 'text-[#6c7086] hover:text-[#a6adc8]' : 'text-[#f38ba8]'}`}
          onClick={(e) => { e.stopPropagation(); void setVisibleOnBridge(nodeId, !node.visible); }}
          title={node.visible ? '隐藏' : '显示'}
        >
          {node.visible ? '◉' : '○'}
        </button>

        {/* 锁定 */}
        <button
          className={`text-[11px] px-0.5 ${node.locked ? 'text-[#f38ba8]' : 'text-[#6c7086] hover:text-[#a6adc8]'}`}
          onClick={(e) => { e.stopPropagation(); updateNode(nodeId, { locked: !node.locked }); }}
          title={node.locked ? '解锁' : '锁定'}
        >
          {node.locked ? '🔒' : '·'}
        </button>
      </div>

      {/* 子节点 — component 类型不展示内部子节点 */}
      {node.type !== 'component' && !collapsed && node.children.map((childId) => (
        <LayerItem key={childId} nodeId={childId} depth={depth + 1} />
      ))}

      {/* 右键菜单 */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          nodeId={nodeId}
          onAddChild={addChild}
          onRename={startRename}
          onDelete={() => { void deleteNodeOnBridge(nodeId); setContextMenu(null); }}
          onDuplicate={() => {
            void duplicateNodesOnBridge([nodeId]);
            setContextMenu(null);
          }}
          onClose={() => setContextMenu(null)}
        />
      )}
    </>
  );
});

// 右键菜单组件
function ContextMenu({ x, y, nodeId, onAddChild, onRename, onDelete, onDuplicate, onClose }: {
  x: number; y: number; nodeId: string;
  onAddChild: (type: 'frame' | 'text' | 'image') => void;
  onRename: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onClose: () => void;
}) {
  const selectedIds = useEditorStore((s) => s.selectedIds);

  const multiSelected = selectedIds.length > 1;

  // 添加同级节点
  const addSibling = (type: 'frame' | 'text' | 'image') => {
    const store = useEditorStore.getState();
    const node = store.nodes[nodeId];
    if (!node) return;
    const names = { frame: 'Frame', text: 'Text', image: 'Image' };
    void createWidgetNodeOnBridge({
      widgetType: type,
      x: node.x,
      y: node.y + node.height + 10,
      parentId: node.parentId || undefined,
      name: names[type],
      width: type === 'text' ? 200 : 200,
      height: type === 'text' ? 40 : 150,
    });
    onClose();
  };

  return (
    <>
      {/* 遮罩层 */}
      <div className="fixed inset-0 z-50" onClick={onClose} />

      <div
        className="fixed z-50 bg-[#313244] border border-[#45475a] rounded shadow-lg py-1 min-w-[160px]"
        style={{ left: x, top: y }}
      >
        {/* 添加子节点 */}
        <div className="px-3 py-1 text-[12px] text-[#6c7086] uppercase tracking-wide">添加子节点</div>
        <MenuItem label="▢ Frame 容器" onClick={() => onAddChild('frame')} />
        <MenuItem label="T 文本" onClick={() => onAddChild('text')} />
        <MenuItem label="🖼 图片" onClick={() => onAddChild('image')} />

        <div className="border-t border-[#45475a] my-1" />

        {/* 添加同级 */}
        <div className="px-3 py-1 text-[12px] text-[#6c7086] uppercase tracking-wide">添加同级节点</div>
        <MenuItem label="▢ Frame 容器" onClick={() => addSibling('frame')} />
        <MenuItem label="T 文本" onClick={() => addSibling('text')} />
        <MenuItem label="🖼 图片" onClick={() => addSibling('image')} />

        <div className="border-t border-[#45475a] my-1" />

        <MenuItem label="重命名" shortcut="F2" onClick={() => { onRename(); onClose(); }} />
        <MenuItem label="复制" onClick={onDuplicate} />
        {multiSelected ? (
          <MenuItem
            label={`删除选中 (${selectedIds.length}个)`}
            className="text-[#f38ba8]"
            onClick={() => {
              void (async () => {
                for (const id of selectedIds) await deleteNodeOnBridge(id);
              })();
              onClose();
            }}
          />
        ) : (
          <MenuItem label="删除" className="text-[#f38ba8]" onClick={onDelete} />
        )}
      </div>
    </>
  );
}

function MenuItem({ label, shortcut, className = '', onClick }: {
  label: string; shortcut?: string; className?: string; onClick: () => void;
}) {
  return (
    <button
      className={`w-full text-left px-3 py-1.5 text-[13px] hover:bg-[#45475a] flex items-center justify-between ${className || 'text-[#cdd6f4]'}`}
      onClick={onClick}
    >
      <span>{label}</span>
      {shortcut && <span className="text-[#6c7086] text-[11px]">{shortcut}</span>}
    </button>
  );
}

export default function LayerPanel() {
  const rootIds = useEditorStore((s) => s.rootIds);
  const pages = useEditorStore((s) => s.pages);
  const activePageId = useEditorStore((s) => s.activePageId);
  const addPage = useEditorStore((s) => s.addPage);
  const deletePage = useEditorStore((s) => s.deletePage);
  const renamePage = useEditorStore((s) => s.renamePage);
  const switchPage = useEditorStore((s) => s.switchPage);
  const revealCounter = useEditorStore((s) => s.revealInLayerCounter);

  const [renamingPageId, setRenamingPageId] = useState<string | null>(null);
  const [renamingValue, setRenamingValue] = useState('');
  const [pageContextMenu, setPageContextMenu] = useState<{ pageId: string; x: number; y: number } | null>(null);

  const [draggingPageId, setDraggingPageId] = useState<string | null>(null);
  const [pageDropIndicator, setPageDropIndicator] = useState<{ pageId: string; position: 'before' | 'after' } | null>(null);
  const reorderPages = useEditorStore((s) => s.reorderPages);

  const handlePageDragStart = (pageId: string) => (e: React.DragEvent<HTMLDivElement>) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', pageId);
    setDraggingPageId(pageId);
  };

  const handlePageDragOver = (pageId: string) => (e: React.DragEvent<HTMLDivElement>) => {
    if (!draggingPageId || draggingPageId === pageId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = e.currentTarget.getBoundingClientRect();
    const position: 'before' | 'after' = e.clientX - rect.left < rect.width / 2 ? 'before' : 'after';
    setPageDropIndicator({ pageId, position });
  };

  const handlePageDrop = (pageId: string) => (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!draggingPageId || !pageDropIndicator) return;
    if (draggingPageId !== pageId) {
      reorderPages(draggingPageId, pageDropIndicator.pageId, pageDropIndicator.position);
    }
    setDraggingPageId(null);
    setPageDropIndicator(null);
  };

  const handlePageDragEnd = () => {
    setDraggingPageId(null);
    setPageDropIndicator(null);
  };

  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());

  const toggleCollapse = useCallback((id: string) => {
    setCollapsedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const setCollapseState = useCallback((id: string, value: boolean) => {
    setCollapsedIds(prev => {
      const has = prev.has(id);
      if (value && !has) { const next = new Set(prev); next.add(id); return next; }
      if (!value && has) { const next = new Set(prev); next.delete(id); return next; }
      return prev;
    });
  }, []);

  useEffect(() => {
    if (revealCounter === 0) return;
    const { selectedIds, nodes } = useEditorStore.getState();
    if (selectedIds.length === 0) return;

    const ancestorsToExpand = new Set<string>();
    for (const id of selectedIds) {
      let cur = nodes[id];
      while (cur?.parentId) {
        ancestorsToExpand.add(cur.parentId);
        cur = nodes[cur.parentId];
      }
    }

    if (ancestorsToExpand.size > 0) {
      setCollapsedIds(prev => {
        const next = new Set(prev);
        for (const a of ancestorsToExpand) next.delete(a);
        return next;
      });
    }

    const timer = setTimeout(() => {
      const firstSelected = useEditorStore.getState().selectedIds[0];
      if (!firstSelected) return;
      const el = document.querySelector(`[data-layer-node-id="${firstSelected}"]`);
      el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }, 50);
    return () => clearTimeout(timer);
  }, [revealCounter]);

  const collapseCtx = { collapsedIds, toggleCollapse, setCollapsed: setCollapseState };

  const addRootNode = (type: 'frame' | 'text' | 'image') => {
    const names = { frame: 'Frame', text: 'Text', image: 'Image' };
    const st = useEditorStore.getState();
    const parentId = st.selectedIds.length === 1 ? st.selectedIds[0] : undefined;
    void createWidgetNodeOnBridge({
      widgetType: type,
      x: 0,
      y: 0,
      name: names[type],
      width: type === 'text' ? 200 : 300,
      height: type === 'text' ? 40 : 200,
      parentId,
    });
  };

  const startRenamePage = (pageId: string, currentName: string) => {
    setRenamingPageId(pageId);
    setRenamingValue(currentName);
  };

  const finishRenamePage = () => {
    if (renamingPageId && renamingValue.trim()) {
      renamePage(renamingPageId, renamingValue.trim());
    }
    setRenamingPageId(null);
  };

  return (
    <div className="w-56 bg-[#1e1e2e] border-r border-[#313244] flex flex-col h-full">
      {/* 图层 Tab 栏 */}
      <div className="border-b border-[#313244] min-w-0 flex items-center px-2 py-1.5 gap-1">
        <div className="flex-1 min-w-0 flex items-center gap-1 overflow-x-auto overflow-y-hidden">
          {pages.map((page) => {
            const isDropBefore = pageDropIndicator?.pageId === page.id && pageDropIndicator.position === 'before';
            const isDropAfter = pageDropIndicator?.pageId === page.id && pageDropIndicator.position === 'after';
            return (
              <div
                key={page.id}
                data-testid="layer-page-tab"
                data-page-id={page.id}
                data-active={activePageId === page.id ? 'true' : 'false'}
                className={`shrink-0 relative ${draggingPageId === page.id ? 'opacity-50' : ''}`}
                draggable={renamingPageId !== page.id}
                onDragStart={handlePageDragStart(page.id)}
                onDragOver={handlePageDragOver(page.id)}
                onDrop={handlePageDrop(page.id)}
                onDragEnd={handlePageDragEnd}
              >
                {isDropBefore && <div className="absolute -left-0.5 top-1 bottom-1 w-0.5 bg-[#89b4fa] pointer-events-none" />}
                {isDropAfter && <div className="absolute -right-0.5 top-1 bottom-1 w-0.5 bg-[#89b4fa] pointer-events-none" />}
                <button
                  onClick={() => switchPage(page.id)}
                  onDoubleClick={() => startRenamePage(page.id, page.name)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setPageContextMenu({ pageId: page.id, x: e.clientX, y: e.clientY });
                  }}
                  className={`px-3 py-1 text-[13px] rounded transition-colors ${
                    activePageId === page.id
                      ? 'bg-[#89b4fa] text-[#1e1e2e] font-medium'
                      : 'text-[#a6adc8] hover:bg-[#313244]'
                  }`}
                >
                  {renamingPageId === page.id ? (
                    <input
                      autoFocus
                      className="w-16 text-[13px] bg-transparent border-b border-white text-inherit outline-none"
                      value={renamingValue}
                      onChange={(e) => setRenamingValue(e.target.value)}
                      onBlur={finishRenamePage}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') finishRenamePage();
                        if (e.key === 'Escape') setRenamingPageId(null);
                      }}
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <>
                      {page.pageGroup && (
                        <span className="text-[10px] opacity-70 mr-1">[{page.pageGroup}]</span>
                      )}
                      {page.name}
                    </>
                  )}
                </button>
              </div>
            );
          })}
        </div>
        <button
          onClick={() => addPage()}
          className="shrink-0 w-6 h-6 flex items-center justify-center text-[#6c7086] hover:text-[#a6adc8] hover:bg-[#313244] rounded text-sm"
          title="新建图层"
        >
          +
        </button>
      </div>

      {/* 画板列表 */}
      <ArtboardListBar />

      {/* 节点层级树 */}
      <div className="px-3 py-1.5 border-b border-[#313244]">
        <h3 className="text-sm font-medium text-[#6c7086]">节点</h3>
      </div>

      <div className="flex-1 overflow-auto layer-scroll">
        <CollapseContext.Provider value={collapseCtx}>
        {rootIds.length === 0 ? (
          <div className="text-center text-[#6c7086] text-sm mt-8">
            右键或点击下方按钮添加节点
          </div>
        ) : (
          <div className="min-w-max">
            {rootIds.map((id) => <LayerItem key={id} nodeId={id} />)}
          </div>
        )}
        </CollapseContext.Provider>
      </div>

      {/* 页面说明栏(v2) — 已搬到画布画板右侧浮动显示,不在此面板里 */}

      {/* 底部快捷添加栏 */}
      <div className="border-t border-[#313244] px-3 py-3 flex flex-col gap-2">
        <button onClick={() => addRootNode('frame')} className="w-full text-sm py-3 rounded bg-[#313244] text-[#a6adc8] hover:bg-[#45475a] transition-colors">+ ▢ Frame 容器</button>
        <button onClick={() => addRootNode('text')} className="w-full text-sm py-3 rounded bg-[#313244] text-[#a6adc8] hover:bg-[#45475a] transition-colors">+ T 文本</button>
        <button onClick={() => addRootNode('image')} className="w-full text-sm py-3 rounded bg-[#313244] text-[#a6adc8] hover:bg-[#45475a] transition-colors">+ 🖼 图片</button>
      </div>

      {/* 图层右键菜单 */}
      {pageContextMenu && (
        <>
          <div className="fixed inset-0 z-50" onClick={() => setPageContextMenu(null)} />
          <div
            data-testid="layer-page-context-menu"
            className="fixed z-50 bg-[#313244] border border-[#45475a] rounded shadow-lg py-1 min-w-[120px]"
            style={{ left: pageContextMenu.x, top: pageContextMenu.y }}
          >
            <button
              data-testid="layer-page-rename"
              className="w-full text-left px-3 py-1.5 text-[13px] text-[#cdd6f4] hover:bg-[#45475a]"
              onClick={() => {
                const page = pages.find((p) => p.id === pageContextMenu.pageId);
                if (page) startRenamePage(page.id, page.name);
                setPageContextMenu(null);
              }}
            >
              重命名
            </button>
            <button
              data-testid="layer-page-duplicate"
              className="w-full text-left px-3 py-1.5 text-[13px] text-[#cdd6f4] hover:bg-[#45475a]"
              onClick={() => {
                const pageId = pageContextMenu.pageId;
                void duplicateBridgePage(pageId).catch((err) => {
                  console.error('复制图层失败:', err);
                  window.alert(`复制图层失败: ${err instanceof Error ? err.message : String(err)}`);
                });
                setPageContextMenu(null);
              }}
            >
              复制图层
            </button>
            {pages.length > 1 && (
              <button
                data-testid="layer-page-delete"
                className="w-full text-left px-3 py-1.5 text-[13px] text-[#f38ba8] hover:bg-[#45475a]"
                onClick={() => {
                  const pageId = pageContextMenu.pageId;
                  const page = pages.find((p) => p.id === pageId);
                  void (async () => {
                    if (page) {
                      for (const artboard of page.artboards) {
                        await closeBridgeArtboardSession(artboard.id, pageId).catch(() => undefined);
                      }
                    }
                    deletePage(pageId);
                  })();
                  setPageContextMenu(null);
                }}
              >
                删除图层
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ===== 画板列表（同一页的所有画板） =====

function ArtboardListBar() {
  const pages = useEditorStore((s) => s.pages);
  const activePageId = useEditorStore((s) => s.activePageId);
  const activeArtboardId = useEditorStore((s) => s.activeArtboardId);
  const setActiveArtboard = useEditorStore((s) => s.setActiveArtboard);
  const addArtboard = useEditorStore((s) => s.addArtboard);
  const deleteArtboard = useEditorStore((s) => s.deleteArtboard);
  const renameArtboard = useEditorStore((s) => s.renameArtboard);

  const [menu, setMenu] = useState<{ artboardId: string; x: number; y: number } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renamingValue, setRenamingValue] = useState('');

  const page = pages.find((p) => p.id === activePageId);
  if (!page) return null;
  const artboards = page.artboards;

  const startRename = (id: string, name: string) => {
    setRenamingId(id);
    setRenamingValue(name);
  };
  const finishRename = () => {
    if (renamingId && renamingValue.trim()) renameArtboard(renamingId, renamingValue.trim());
    setRenamingId(null);
  };

  return (
    <div className="border-b border-[#313244] bg-[#181825]">
      <div className="px-3 py-1.5 flex items-center justify-between">
        <h3 className="text-sm font-medium text-[#6c7086]">画板 <span className="text-[#45475a]">({artboards.length})</span></h3>
        <button
          onClick={() => addArtboard()}
          className="w-5 h-5 flex items-center justify-center text-[#a6e3a1] hover:bg-[#313244] rounded text-sm leading-none"
          title="在当前页新建画板"
        >＋</button>
      </div>
      <div className="max-h-[160px] overflow-y-auto">
        {artboards.map((a) => {
          const isActive = a.id === activeArtboardId;
          return (
            <div
              key={a.id}
              data-testid="layer-artboard-row"
              data-artboard-id={a.id}
              data-active={isActive ? 'true' : 'false'}
              data-bridge-session-id={a.bridgeSessionId ?? ''}
              data-working-prefab-path={a.bridgeWorkingPrefabPath ?? ''}
              data-source-prefab-path={a.sourcePrefabPath ?? ''}
              onClick={() => setActiveArtboard(a.id)}
              onDoubleClick={() => startRename(a.id, a.name)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ artboardId: a.id, x: e.clientX, y: e.clientY });
              }}
              className={`flex items-center gap-2 px-3 py-1 cursor-pointer text-[12px] ${
                isActive
                  ? 'bg-[#313244] text-[#cdd6f4] border-l-2 border-[#89b4fa]'
                  : 'text-[#a6adc8] hover:bg-[#313244]/60 border-l-2 border-transparent'
              }`}
            >
              <span className="text-[10px] opacity-60">▢</span>
              {renamingId === a.id ? (
                <input
                  autoFocus
                  className="flex-1 min-w-0 text-[12px] bg-transparent border-b border-[#89b4fa] text-inherit outline-none"
                  value={renamingValue}
                  onChange={(e) => setRenamingValue(e.target.value)}
                  onBlur={finishRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') finishRename();
                    if (e.key === 'Escape') setRenamingId(null);
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span className="truncate flex-1">{a.name}</span>
              )}
              <span className="text-[10px] text-[#6c7086]">{Object.keys(a.nodes).length}</span>
            </div>
          );
        })}
      </div>

      {menu && (
        <>
          <div className="fixed inset-0 z-50" onClick={() => setMenu(null)} />
          <div
            data-testid="layer-artboard-context-menu"
            className="fixed z-50 bg-[#313244] border border-[#45475a] rounded shadow-lg py-1 min-w-[120px]"
            style={{ left: menu.x, top: menu.y }}
          >
            <button
              data-testid="layer-artboard-rename"
              className="w-full text-left px-3 py-1.5 text-[13px] text-[#cdd6f4] hover:bg-[#45475a]"
              onClick={() => {
                const a = artboards.find((x) => x.id === menu.artboardId);
                if (a) startRename(a.id, a.name);
                setMenu(null);
              }}
            >
              重命名
            </button>
            <button
              data-testid="layer-artboard-duplicate"
              className="w-full text-left px-3 py-1.5 text-[13px] text-[#cdd6f4] hover:bg-[#45475a]"
              onClick={() => {
                const id = menu.artboardId;
                void duplicateBridgeArtboard(id).catch((err) => {
                  console.error('复制画板失败:', err);
                  window.alert(`复制画板失败: ${err instanceof Error ? err.message : String(err)}`);
                });
                setMenu(null);
              }}
            >
              复制画板
            </button>
            {artboards.length > 1 && (
              <button
                data-testid="layer-artboard-delete"
                className="w-full text-left px-3 py-1.5 text-[13px] text-[#f38ba8] hover:bg-[#45475a]"
                onClick={() => {
                  const id = menu.artboardId;
                  void closeBridgeArtboardSession(id).finally(() => deleteArtboard(id));
                  setMenu(null);
                }}
              >
                删除画板
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

import { useEffect } from 'react';

interface Props {
  open: boolean;
  onClose: () => void;
}

interface Section {
  title: string;
  items: Array<{ keys: string; desc: string }>;
}

const SECTIONS: Section[] = [
  {
    title: '文件 / 历史',
    items: [
      { keys: 'Ctrl+Z', desc: '撤销' },
      { keys: 'Ctrl+Y / Ctrl+Shift+Z', desc: '重做' },
      { keys: 'Ctrl+S', desc: '快速保存' },
      { keys: 'Ctrl+Shift+S', desc: '另存为' },
    ],
  },
  {
    title: '选择 / 编辑',
    items: [
      { keys: 'Ctrl+A', desc: '全选所有节点' },
      { keys: 'Ctrl+D', desc: '复制并粘贴选中' },
      { keys: 'Ctrl+Shift+D', desc: '取消选中' },
      { keys: 'Ctrl+C / V / X', desc: '复制 / 粘贴 / 剪切' },
      { keys: 'Delete / Backspace', desc: '删除选中（批注优先）' },
      { keys: 'F2', desc: '重命名当前选中（单选）' },
      { keys: 'Enter', desc: '文本节点 → 进入内联编辑' },
    ],
  },
  {
    title: '编组 / 锁定 / 可见',
    items: [
      { keys: 'Ctrl+G', desc: '编组' },
      { keys: 'Ctrl+Shift+G', desc: '取消编组' },
      { keys: 'Ctrl+L', desc: '锁定 / 解锁选中' },
      { keys: '\\', desc: '切换选中可见性' },
    ],
  },
  {
    title: '层级排序',
    items: [
      { keys: 'Ctrl+]', desc: '上移一层' },
      { keys: 'Ctrl+[', desc: '下移一层' },
      { keys: 'Ctrl+Shift+]', desc: '置顶' },
      { keys: 'Ctrl+Shift+[', desc: '置底' },
    ],
  },
  {
    title: '视图 / 缩放 / 平移',
    items: [
      { keys: 'Ctrl+0', desc: '适应视图' },
      { keys: 'Ctrl+1', desc: '实际大小（100%）' },
      { keys: 'Ctrl+= / +', desc: '放大' },
      { keys: 'Ctrl+- / _', desc: '缩小' },
      { keys: 'F', desc: '聚焦选中节点' },
      { keys: 'Space（按住）', desc: '临时切手形拖动画布' },
      { keys: 'Space Space', desc: '视图回到 100% 并居中' },
    ],
  },
  {
    title: '面板 / 模式',
    items: [
      { keys: 'Tab', desc: '沉浸预览（隐藏左右面板 + Toolbar）' },
      { keys: 'Shift+Tab', desc: '仅隐藏左右面板' },
      { keys: 'Ctrl+B', desc: '折叠 / 展开图层面板' },
      { keys: 'Ctrl+R', desc: '切换标尺' },
      { keys: 'Ctrl+H', desc: '切换批注图层显隐' },
      { keys: 'Ctrl+Shift+H', desc: '切换灰度模式' },
    ],
  },
  {
    title: '页面 / 画板',
    items: [
      { keys: 'PageUp / PageDown', desc: '切换页面' },
      { keys: 'Ctrl+PageUp / Down', desc: '切换画板' },
    ],
  },
  {
    title: '移动（方向键）',
    items: [
      { keys: '↑ ↓ ← →', desc: '选中节点移动 1px' },
      { keys: 'Shift + 方向键', desc: '选中节点移动 10px' },
    ],
  },
  {
    title: '不透明度',
    items: [
      { keys: '1 – 9', desc: '不透明度 10% – 90%' },
      { keys: '0', desc: '不透明度 100%' },
    ],
  },
  {
    title: '场景工具',
    items: [
      { keys: 'Q', desc: '手形 Hand' },
      { keys: 'W', desc: '移动 Move' },
      { keys: 'E', desc: '旋转 Rotate' },
      { keys: 'R', desc: '缩放 Scale' },
      { keys: 'T', desc: '矩形 Rect' },
      { keys: 'Y', desc: '自由变换 Transform' },
    ],
  },
  {
    title: '批注工具',
    items: [
      { keys: 'A', desc: '箭头' },
      { keys: 'F', desc: '流程线（无选中时；有选中则 Focus）' },
      { keys: 'N', desc: '序号标注' },
      { keys: 'Esc', desc: '取消起点 / 退出工具' },
    ],
  },
  {
    title: '对齐 / 分布',
    items: [
      { keys: 'Alt+A / D', desc: '左 / 右对齐' },
      { keys: 'Alt+W / S', desc: '顶 / 底对齐' },
      { keys: 'Alt+H / V', desc: '水平 / 垂直居中' },
      { keys: 'Ctrl+Alt+H', desc: '水平等距分布' },
      { keys: 'Ctrl+Alt+V', desc: '垂直等距分布' },
    ],
  },
];

export default function ShortcutsDialog({ open, onClose }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === '?') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      <div className="fixed inset-0 z-[60] bg-black/40" onClick={onClose} />
      <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[61] bg-[#1e1e2e] border border-[#45475a] rounded-lg shadow-2xl w-[840px] max-h-[82vh] flex flex-col">
        <div className="px-4 py-3 border-b border-[#45475a] flex items-center justify-between">
          <h3 className="text-sm font-medium text-[#cdd6f4]">键盘快捷键</h3>
          <button onClick={onClose} className="text-[#6c7086] hover:text-[#cdd6f4] text-lg leading-none">×</button>
        </div>
        <div className="px-4 py-4 overflow-auto grid grid-cols-3 gap-x-6 gap-y-4">
          {SECTIONS.map((sec) => (
            <div key={sec.title}>
              <div className="text-[12px] font-medium text-[#f9e2af] mb-1.5 pb-1 border-b border-[#313244]">
                {sec.title}
              </div>
              <div className="flex flex-col gap-1">
                {sec.items.map((it, i) => (
                  <div key={i} className="flex items-start gap-2 text-[12px]">
                    <kbd className="px-1.5 py-0.5 bg-[#313244] text-[#cdd6f4] rounded border border-[#45475a] font-mono text-[11px] whitespace-nowrap shrink-0">
                      {it.keys}
                    </kbd>
                    <span className="text-[#a6adc8] flex-1 leading-tight pt-0.5">{it.desc}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="px-4 py-2 border-t border-[#45475a] text-[11px] text-[#6c7086] flex items-center justify-between">
          <span>提示：在输入框聚焦时大部分快捷键会被禁用</span>
          <span>按 ? 或 Esc 关闭</span>
        </div>
      </div>
    </>
  );
}

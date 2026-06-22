// src/components/Panels/UEExportDialog.tsx
import { useState } from 'react';
import { useEditorStore } from '../../stores/editorStore';
import { exportMultiSidebarLayout } from '../../utils/ueExport';

interface Props { onClose: () => void }

export default function UEExportDialog({ onClose }: Props) {
  const [scope, setScope] = useState<'current-page' | 'all-pages'>('current-page');
  const [includeAnnotations, setIncludeAnnotations] = useState(true);
  const [author, setAuthor] = useState('');
  const [busy, setBusy] = useState(false);

  const onExport = async () => {
    setBusy(true);
    try {
      const st = useEditorStore.getState();
      const pages = scope === 'current-page'
        ? st.pages.filter((p) => p.id === st.activePageId)
        : st.pages;
      await exportMultiSidebarLayout({ includeAnnotations, author, pages });
    } finally {
      setBusy(false);
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-[100] bg-black/50 flex items-center justify-center" onClick={onClose}>
      <div
        className="bg-[#1e1e2e] border border-[#313244] rounded-lg p-5 min-w-[360px]"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-[#cdd6f4] text-base font-medium mb-3">导出 UE 图</h3>

        {/* 导出范围 */}
        <div className="text-[13px] text-[#a6adc8] mb-3">
          <div className="mb-1.5 text-[#6c7086]">导出范围:</div>
          <label className="block py-0.5">
            <input
              type="radio"
              name="ue-scope"
              checked={scope === 'current-page'}
              onChange={() => setScope('current-page')}
              className="mr-2"
            />
            单图层（包含该图层下所有画板）
          </label>
          <label className="block py-0.5">
            <input
              type="radio"
              name="ue-scope"
              checked={scope === 'all-pages'}
              onChange={() => setScope('all-pages')}
              className="mr-2"
            />
            所有图层
          </label>
        </div>

        {/* 选项 */}
        <div className="text-[13px] text-[#a6adc8] mb-4">
          <label className="block mb-1">
            <input
              type="checkbox"
              checked={includeAnnotations}
              onChange={(e) => setIncludeAnnotations(e.target.checked)}
              className="mr-2"
            />
            包含批注（页面批注+页面说明栏）
          </label>
          <label className="flex items-center gap-2 mt-2">
            <span className="text-[#6c7086] shrink-0">作者</span>
            <input
              type="text"
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
              placeholder="(可选,显示在右上角)"
              className="flex-1 bg-[#313244] text-[#cdd6f4] px-2 py-1 rounded text-[13px] outline-none"
            />
          </label>
        </div>

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={busy}
            className="px-3 py-1.5 text-[13px] text-[#a6adc8] hover:bg-[#313244] rounded"
          >
            取消
          </button>
          <button
            onClick={onExport}
            disabled={busy}
            className="px-3 py-1.5 text-[13px] bg-[#89b4fa] text-[#1e1e2e] font-medium hover:bg-[#74c7ec] rounded disabled:opacity-50"
          >
            {busy ? '导出中...' : '导出 PNG'}
          </button>
        </div>
      </div>
    </div>
  );
}

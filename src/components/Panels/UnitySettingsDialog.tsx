import { useState, useEffect } from 'react';
import { resetSession } from '../../services/McpClient';

const STORAGE_KEY = 'uieditor_mcp_url';

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function UnitySettingsDialog({ open, onClose }: Props) {
  const [mcpUrl, setMcpUrl] = useState('');
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (open) {
      const local = localStorage.getItem(STORAGE_KEY);
      setMcpUrl(local || 'https://127.0.0.1:8081/mcp');
      setMessage('');
    }
  }, [open]);

  if (!open) return null;

  const handleSave = () => {
    const url = mcpUrl.trim() || 'https://127.0.0.1:8081/mcp';
    localStorage.setItem(STORAGE_KEY, url);
    resetSession(); // MCP 地址变更，清除旧 session
    setMessage('已保存到本地');
    setTimeout(() => onClose(), 600);
  };

  return (
    <>
      <div className="fixed inset-0 z-[60] bg-black/30" onClick={onClose} />
      <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[61] bg-[#1e1e2e] border border-[#45475a] rounded-lg shadow-2xl w-[520px] flex flex-col">
        <div className="px-4 py-3 border-b border-[#45475a] flex items-center justify-between">
          <h3 className="text-sm font-medium text-[#cdd6f4]">Unity 配置</h3>
          <button onClick={onClose} className="text-[#6c7086] hover:text-[#cdd6f4] text-lg">×</button>
        </div>

        <div className="px-4 py-4 flex flex-col gap-4">
          <div>
            <label className="text-sm text-[#a6adc8] mb-1 block">MCP 服务地址</label>
            <input
              type="text"
              value={mcpUrl}
              onChange={e => setMcpUrl(e.target.value)}
              placeholder="https://127.0.0.1:8081/mcp"
              className="w-full px-3 py-1.5 text-sm bg-[#313244] text-[#cdd6f4] border border-[#45475a] rounded focus:border-[#89b4fa] outline-none font-mono"
            />
            <div className="text-[12px] text-[#6c7086] mt-1">
              浏览器通过 HTTPS CORS 代理连接 Unity MCP（默认端口 8081）。
              首次同步时会自动部署代理脚本到 Unity 项目，Unity Editor 启动时自动运行。
            </div>
          </div>

          <div className="bg-[#313244] rounded p-3">
            <div className="text-[12px] text-[#fab387] font-medium mb-1">首次使用提示</div>
            <div className="text-[12px] text-[#a6adc8]">
              部署后首次连接需信任自签名证书：在浏览器中打开{' '}
              <button
                onClick={() => {
                  const base = (mcpUrl.trim() || 'https://127.0.0.1:8081/mcp').replace(/\/mcp\/?$/, '');
                  window.open(base, '_blank');
                }}
                className="text-[#89b4fa] hover:underline bg-transparent border-none cursor-pointer p-0 font-mono text-[12px]"
              >
                {(mcpUrl.trim() || 'https://127.0.0.1:8081/mcp').replace(/\/mcp\/?$/, '')}
              </button>
              {' '}并点击"高级 &rarr; 继续访问"。信任后即可正常连接。
            </div>
          </div>

          {message && (
            <div className="text-sm text-[#a6e3a1]">{message}</div>
          )}
        </div>

        <div className="px-4 py-3 border-t border-[#45475a] flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1 text-sm text-[#a6adc8] hover:bg-[#313244] rounded">
            取消
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-1 text-sm bg-[#89b4fa] text-[#1e1e2e] rounded hover:bg-[#74c7ec]"
          >
            保存
          </button>
        </div>
      </div>
    </>
  );
}

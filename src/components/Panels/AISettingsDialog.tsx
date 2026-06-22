import { useState, useEffect } from 'react';

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function AISettingsDialog({ open, onClose }: Props) {
  const [apiKey, setApiKey] = useState('');
  const [maskedKey, setMaskedKey] = useState('');
  const [model, setModel] = useState('claude-opus-4-6');
  const [customModel, setCustomModel] = useState(false);
  const [baseUrl, setBaseUrl] = useState('');
  const [httpProxy, setHttpProxy] = useState('');
  const [saving, setSaving] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (open) {
      fetch('/api/ai/config')
        .then(r => r.json())
        .then(data => {
          setMaskedKey(data.apiKey || '');
          const m = data.model || 'claude-opus-4-6';
          setModel(m);
          const knownModels = ['claude-haiku-4-5-20251001', 'claude-sonnet-4-20250514', 'claude-opus-4-6', 'claude-opus-4-7'];
          setCustomModel(!knownModels.includes(m));
          setBaseUrl(data.baseUrl || '');
          setHttpProxy(data.httpProxy || '');
          setApiKey('');
        })
        .catch(() => {});
    }
  }, [open]);

  if (!open) return null;

  const handleSave = async () => {
    setSaving(true);
    setMessage('');
    try {
      const body: any = { model, baseUrl, httpProxy };
      if (apiKey.trim()) body.apiKey = apiKey.trim();
      const res = await fetch('/api/ai/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.success) {
        setMessage('保存成功');
        setTimeout(() => onClose(), 800);
      } else {
        setMessage(data.error || '保存失败');
      }
    } catch {
      setMessage('网络错误');
    }
    setSaving(false);
  };

  return (
    <>
      <div className="fixed inset-0 z-[60] bg-black/30" onClick={onClose} />
      <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[61] bg-[#1e1e2e] border border-[#45475a] rounded-lg shadow-2xl w-[480px] flex flex-col">
        {/* 标题 */}
        <div className="px-4 py-3 border-b border-[#45475a] flex items-center justify-between">
          <h3 className="text-sm font-medium text-[#cdd6f4]">AI 设置</h3>
          <button onClick={onClose} className="text-[#6c7086] hover:text-[#cdd6f4] text-lg">×</button>
        </div>

        {/* 内容 */}
        <div className="px-4 py-4 flex flex-col gap-4">
          {/* API 地址 */}
          <div>
            <label className="text-sm text-[#a6adc8] mb-1 block">API 地址</label>
            <input
              type="text"
              value={baseUrl}
              onChange={e => setBaseUrl(e.target.value)}
              placeholder="https://api.anthropic.com"
              className="w-full px-3 py-1.5 text-sm bg-[#313244] text-[#cdd6f4] border border-[#45475a] rounded focus:border-[#89b4fa] outline-none font-mono"
            />
            <div className="text-[12px] text-[#6c7086] mt-1">
              默认 https://api.anthropic.com，可填中转地址
            </div>
          </div>

          {/* HTTP 代理 */}
          <div>
            <label className="text-sm text-[#a6adc8] mb-1 block">HTTP 代理（可选）</label>
            <input
              type="text"
              value={httpProxy}
              onChange={e => setHttpProxy(e.target.value)}
              placeholder="留空即可，无需填写"
              className="w-full px-3 py-1.5 text-sm bg-[#313244] text-[#cdd6f4] border border-[#45475a] rounded focus:border-[#89b4fa] outline-none font-mono"
            />
            <div className="text-[12px] text-[#6c7086] mt-1">
              使用中转地址时无需填写。仅在直连 api.anthropic.com + 本地代理时填，如 http://127.0.0.1:7890
            </div>
          </div>

          {/* API Key */}
          <div>
            <label className="text-sm text-[#a6adc8] mb-1 block">API Key</label>
            <div className="flex gap-2">
              <input
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                placeholder={maskedKey || 'sk-ant-api03-...'}
                className="flex-1 px-3 py-1.5 text-sm bg-[#313244] text-[#cdd6f4] border border-[#45475a] rounded focus:border-[#89b4fa] outline-none"
              />
              <button
                onClick={() => setShowKey(!showKey)}
                className="px-2 py-1 text-[12px] bg-[#313244] text-[#a6adc8] rounded hover:bg-[#45475a]"
              >
                {showKey ? '隐藏' : '显示'}
              </button>
            </div>
            {maskedKey && !apiKey && (
              <div className="text-[12px] text-[#6c7086] mt-1">当前: {maskedKey}（留空则不修改）</div>
            )}
          </div>

          {/* 模型 */}
          <div>
            <label className="text-sm text-[#a6adc8] mb-1 block">模型</label>
            {customModel ? (
              <div className="flex gap-2">
                <input
                  type="text"
                  value={model}
                  onChange={e => setModel(e.target.value)}
                  placeholder="输入模型 ID，如 claude-sonnet-4-20250514"
                  className="flex-1 px-3 py-1.5 text-sm bg-[#313244] text-[#cdd6f4] border border-[#45475a] rounded focus:border-[#89b4fa] outline-none font-mono"
                />
                <button
                  onClick={() => { setCustomModel(false); setModel('claude-sonnet-4-20250514'); }}
                  className="px-2 py-1 text-[12px] bg-[#313244] text-[#a6adc8] rounded hover:bg-[#45475a] whitespace-nowrap"
                >
                  预设
                </button>
              </div>
            ) : (
              <div className="flex gap-2">
                <select
                  value={model}
                  onChange={e => setModel(e.target.value)}
                  className="flex-1 px-3 py-1.5 text-sm bg-[#313244] text-[#cdd6f4] border border-[#45475a] rounded focus:border-[#89b4fa] outline-none"
                >
                  <option value="claude-haiku-4-5-20251001">Claude Haiku 4.5 (最快)</option>
                  <option value="claude-sonnet-4-20250514">Claude Sonnet 4 (推荐)</option>
                  <option value="claude-opus-4-6">Claude Opus 4.6 (更强)</option>
                  <option value="claude-opus-4-7">Claude Opus 4.7 (最强)</option>
                </select>
                <button
                  onClick={() => setCustomModel(true)}
                  className="px-2 py-1 text-[12px] bg-[#313244] text-[#a6adc8] rounded hover:bg-[#45475a] whitespace-nowrap"
                >
                  自定义
                </button>
              </div>
            )}
            <div className="text-[12px] text-[#6c7086] mt-1">
              中转服务可能使用不同的模型 ID，点"自定义"手动输入
            </div>
          </div>

          {/* 消息 */}
          {message && (
            <div className={`text-sm ${message.includes('成功') ? 'text-[#a6e3a1]' : 'text-[#f38ba8]'}`}>
              {message}
            </div>
          )}
        </div>

        {/* 底部 */}
        <div className="px-4 py-3 border-t border-[#45475a] flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1 text-sm text-[#a6adc8] hover:bg-[#313244] rounded">
            取消
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-1 text-sm bg-[#89b4fa] text-[#1e1e2e] rounded hover:bg-[#74c7ec] disabled:opacity-50"
          >
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
    </>
  );
}

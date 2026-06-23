import { useEffect, useRef, useState } from 'react';
import { useEditorStore } from '../../stores/editorStore';

/**
 * Jenkins 同步按钮 —— 触发 LOA-UIEditor job，轮询状态，完成后通知 TemplateLibrary 重拉列表。
 * 放在左侧面板底部，组件库/图片/项目UI 三个 tab 共用。
 */
export default function JenkinsSyncButton() {
  const requestPrefabListReload = useEditorStore((s) => s.requestPrefabListReload);

  // Jenkins 同步状态：idle / queued / building / done
  const [syncPhase, setSyncPhase] = useState<'idle' | 'queued' | 'building' | 'done'>('idle');
  const [syncProgress, setSyncProgress] = useState<number | null>(null);
  const syncing = syncPhase !== 'idle' && syncPhase !== 'done';

  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => { if (pollTimerRef.current) clearTimeout(pollTimerRef.current); };
  }, []);

  // 轮询 Jenkins 状态：直到 done / 超时 / 出错
  const pollBuildStatus = (queueUrl: string | undefined, buildUrl: string | undefined, startedAt: number) => {
    const TIMEOUT_MS = 20 * 60 * 1000;
    const INTERVAL_MS = 3000;

    const tick = async () => {
      if (Date.now() - startedAt > TIMEOUT_MS) {
        setSyncPhase('idle');
        setSyncProgress(null);
        alert('Jenkins 状态轮询超时（20 分钟）。请去 Jenkins 页面看一眼，或稍后手动刷新。');
        return;
      }
      try {
        const qs = buildUrl ? `buildUrl=${encodeURIComponent(buildUrl)}` : `queueUrl=${encodeURIComponent(queueUrl || '')}`;
        const res = await fetch(`/api/jenkins/build-status?${qs}`);
        const data = await res.json();
        if (!data.ok) {
          setSyncPhase('idle');
          setSyncProgress(null);
          alert(`查询 Jenkins 状态失败: ${data.message || '未知错误'}`);
          return;
        }
        if (data.buildUrl) buildUrl = data.buildUrl;

        if (data.phase === 'queued') {
          setSyncPhase('queued');
          setSyncProgress(null);
        } else if (data.phase === 'building') {
          setSyncPhase('building');
          setSyncProgress(typeof data.progress === 'number' ? data.progress : null);
        } else {
          // 终态：success / failure / aborted / unstable
          setSyncPhase('done');
          setSyncProgress(null);
          const ok = data.phase === 'success';
          const label = ok ? '构建成功' : `构建结束（${data.result || data.phase}）`;
          if (ok) requestPrefabListReload();
          alert(`${label}${data.number ? ` #${data.number}` : ''}${ok ? '\n预制体列表已刷新。' : '\n请到 Jenkins 看日志排查。'}`);
          pollTimerRef.current = setTimeout(() => setSyncPhase('idle'), 1500);
          return;
        }
      } catch (e: any) {
        setSyncPhase('idle');
        setSyncProgress(null);
        alert(`轮询出错: ${e?.message || e}`);
        return;
      }
      pollTimerRef.current = setTimeout(tick, INTERVAL_MS);
    };

    tick();
  };

  const handleSync = async () => {
    if (syncing) return;
    setSyncPhase('queued');
    setSyncProgress(null);
    try {
      const res = await fetch('/api/jenkins/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ params: {} }),
      });
      const data = await res.json();
      if (!data.ok) {
        setSyncPhase('idle');
        alert(`触发失败: ${data.message || '未知错误'}`);
        return;
      }
      if (!data.queueUrl) {
        setSyncPhase('idle');
        requestPrefabListReload();
        alert('Jenkins 已触发，但未拿到队列 URL，无法跟踪进度。请稍后手动刷新。');
        return;
      }
      pollBuildStatus(data.queueUrl, undefined, Date.now());
    } catch (e: any) {
      setSyncPhase('idle');
      alert(`请求失败: ${e?.message || e}`);
    }
  };

  const label = (() => {
    if (syncPhase === 'queued') return '排队中...';
    if (syncPhase === 'building') return syncProgress != null ? `构建中 ${syncProgress}%` : '构建中...';
    if (syncPhase === 'done') return '已完成';
    return '同步最新';
  })();

  return (
    <button
      onClick={handleSync}
      disabled={syncing}
      title="触发 Jenkins 同步并刷新资源列表"
      className="w-full text-[12px] py-1 rounded bg-[#313244] text-[#a6adc8] hover:bg-[#45475a] disabled:opacity-50 transition-colors flex items-center justify-center gap-1"
    >
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className={syncing ? 'animate-spin' : ''}>
        <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
        <path d="M13.5 2.5v3h-3" />
      </svg>
      {label}
    </button>
  );
}

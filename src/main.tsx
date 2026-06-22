import { createRoot } from 'react-dom/client'
import './index.css'
import './services/RuntimeDebugBridge'
import App from './App'

// ===== 防止 Unity WebGL 抢占 HTML 输入框的焦点和键盘事件 =====
//
// Unity WebGL 运行时会在每帧（requestAnimationFrame）调用 canvas.focus()，
// 导致 HTML 输入框无法保持焦点。同时 Unity 在 window/document 上注册全局
// 键盘监听，拦截所有按键。
//
// 修复方案（按优先级）：
// 1. patch HTMLCanvasElement.prototype.focus — 当 HTML 输入框已获焦时，阻止 canvas 抢走焦点
// 2. focusin 监听 — 输入框获焦时主动 blur canvas
// 3. capture 阶段 window 键盘拦截 — 阻止 Unity 的 capture 级别 keydown 监听
// 4. bubble 阶段 window 键盘拦截 — 兜底阻止 Unity 的 bubble 级别 keydown 监听

// 1. 拦截 canvas.focus()，防止 Unity 持续抢焦点
const _origCanvasFocus = HTMLCanvasElement.prototype.focus;
HTMLCanvasElement.prototype.focus = function (this: HTMLCanvasElement, options?: FocusOptions) {
  const active = document.activeElement as HTMLElement | null;
  const tag = active?.tagName ?? '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    // 输入框正在使用中，不允许 canvas 抢焦点
    return;
  }
  _origCanvasFocus.call(this, options);
};

// 2. 输入框获焦时立即 blur Unity canvas（处理初始焦点争夺）
document.addEventListener(
  'focusin',
  (e) => {
    const tag = (e.target as HTMLElement)?.tagName ?? '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      const canvas = document.getElementById('unity-canvas') as HTMLCanvasElement | null;
      if (canvas && document.activeElement === canvas) {
        HTMLElement.prototype.blur.call(canvas);
      }
    }
  },
  true
);

// 3. capture 阶段 window 键盘拦截 — 阻止 Unity 在 capture 阶段拦截键盘事件
//    注册在 window capture 阶段（早于 Unity 的 document/window capture 监听），
//    用 stopImmediatePropagation 阻止 Unity 的键盘监听器。
//    不调用 preventDefault，让浏览器照常处理键入（插入字符、光标移动等）。
const _blockUnityCaptureKey = (e: KeyboardEvent) => {
  const active = document.activeElement as HTMLElement | null;
  const tag = active?.tagName ?? '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    // Enter / Escape 键：主动 blur 以触发值提交 / 取消编辑
    if (e.type === 'keydown' && (e.key === 'Enter' || e.key === 'Escape')) {
      active?.blur();
    }
    e.stopImmediatePropagation();
  }
};
window.addEventListener('keydown', _blockUnityCaptureKey, true);   // capture 阶段
window.addEventListener('keypress', _blockUnityCaptureKey, true);
window.addEventListener('keyup', _blockUnityCaptureKey, true);

// 4. bubble 阶段兜底 — 阻止 Unity 的 bubble 级别 keydown 监听
const _blockUnityKey = (e: KeyboardEvent) => {
  const tag = (document.activeElement as HTMLElement)?.tagName ?? '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    e.stopImmediatePropagation();
  }
};
window.addEventListener('keydown', _blockUnityKey);
window.addEventListener('keypress', _blockUnityKey);
window.addEventListener('keyup', _blockUnityKey);

createRoot(document.getElementById('root')!).render(
  <App />,
)

/**
 * Unity WebGL Bridge — 封装 WebGL 加载和双向通信
 *
 * JS → Unity: unityInstance.SendMessage("BridgeReceiver", method, jsonArg)
 * Unity → JS: window.unityBridge.onXxx() 回调
 */

import { useEditorStore } from '../stores/editorStore';

// Unity WebGL createUnityInstance 返回的实例类型
interface UnityInstance {
  SendMessage(objectName: string, methodName: string, value?: string | number): void;
  Quit(): Promise<void>;
  Module: any;
}

// Unity 回传的节点屏幕坐标
export interface NodeBounds {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LastNodeBounds {
  at: string | null;
  raw: NodeBounds[];
  css: NodeBounds[];
  scale: { x: number; y: number };
  canvas: {
    cssWidth: number;
    cssHeight: number;
    bufferWidth: number;
    bufferHeight: number;
  } | null;
}

export interface LastCamera {
  at: string | null;
  x: number;
  y: number;
  zoom: number;
}

export interface UnityDebugMessage {
  seq: number;
  at: string;
  method: string;
  skipped: boolean;
  size: number;
  arg?: string;
  argPreview?: string;
  summary?: {
    version?: string;
    name?: string;
    nodeCount?: number;
    artboardCount?: number;
    inactiveCount?: number;
    imageDisabledCount?: number;
    noAssetRenderableCount?: number;
  };
}

// 回调类型
interface UnityBridgeCallbacks {
  onReady?: () => void;
  onNodeBounds?: (json: string) => void;
  onHitTestResult?: (nodeId: string) => void;
}

declare global {
  interface Window {
    unityBridge?: UnityBridgeCallbacks;
    createUnityInstance?: (
      canvas: HTMLCanvasElement,
      config: any,
      onProgress?: (progress: number) => void
    ) => Promise<UnityInstance>;
  }
}

const BRIDGE_OBJECT = 'BridgeReceiver';

class UnityBridge {
  private instance: UnityInstance | null = null;
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private hitTestResolve: ((nodeId: string) => void) | null = null;
  private _onNodeBounds: ((bounds: NodeBounds[]) => void) | null = null;
  private _onProgress: ((progress: number) => void) | null = null;
  private _canvas: HTMLCanvasElement | null = null;
  private _loaderUrl: string = '';
  private _config: any = null;
  private _reloading = false;
  private _debugSeq = 0;
  private _syncSerial = 0;
  private _debugMessages: UnityDebugMessage[] = [];
  private _lastNodeBounds: LastNodeBounds = {
    at: null,
    raw: [],
    css: [],
    scale: { x: 1, y: 1 },
    canvas: null,
  };
  private _lastCamera: LastCamera = {
    at: null,
    x: 0,
    y: 0,
    zoom: 1,
  };

  /**
   * 加载 Unity WebGL 到指定 canvas 元素
   * @param canvas HTML Canvas 元素
   * @param loaderUrl WebGL loader.js 的 URL
   * @param config WebGL 配置
   * @param onProgress 加载进度回调 (0-1)
   */
  async load(
    canvas: HTMLCanvasElement,
    loaderUrl: string,
    config: {
      dataUrl: string;
      frameworkUrl: string;
      codeUrl: string;
      streamingAssetsUrl?: string;
    },
    onProgress?: (progress: number) => void
  ): Promise<void> {
    this._onProgress = onProgress || null;
    this._canvas = canvas;
    this._loaderUrl = loaderUrl;
    this._config = config;

    // 设置 Unity→JS 回调
    this.setupCallbacks();

    // 创建 ready promise
    this.readyPromise = new Promise<void>((resolve) => {
      this.readyResolve = resolve;
    });

    // 加载 loader.js（若已加载过则跳过）
    if (!window.createUnityInstance) {
      await this.loadScript(loaderUrl);
    }

    if (!window.createUnityInstance) {
      throw new Error('createUnityInstance not found. WebGL loader failed to load.');
    }

    // 创建 Unity 实例（带活跃检测的超时：有进度更新就重置计时器，避免低配机器误判）
    let lastProgress = 0;
    let lastProgressTime = Date.now();
    const STALL_TIMEOUT = 30000; // 30 秒无任何进度才算超时

    const createPromise = window.createUnityInstance(canvas, {
      ...config,
      companyName: 'LOA',
      productName: 'UIEditorWebGL',
      productVersion: '1.0',
      webglContextAttributes: { preserveDrawingBuffer: true },
    }, (progress: number) => {
      if (progress !== lastProgress) {
        lastProgress = progress;
        lastProgressTime = Date.now();
      }
      this._onProgress?.(progress);
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      const check = setInterval(() => {
        if (Date.now() - lastProgressTime > STALL_TIMEOUT) {
          clearInterval(check);
          reject(new Error(`Unity WebGL 加载超时（${STALL_TIMEOUT / 1000}秒无进度），请检查 Build 文件是否存在`));
        }
      }, 2000);
      createPromise.then(() => clearInterval(check), () => clearInterval(check));
    });

    this.instance = await Promise.race([createPromise, timeoutPromise]);

    // 等待 Unity 发送 NotifyReady（30 秒超时，低配机器 WASM 初始化较慢）
    const readyTimeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Unity 初始化超时（30秒），NotifyReady 未收到')), 30000)
    );
    await Promise.race([this.readyPromise, readyTimeout]);
    console.log('[UnityBridge] Unity WebGL 就绪');
  }

  /**
   * 设置 dev server 基地址（供 Unity 加载精灵）
   */
  setBaseUrl(url: string): void {
    this.send('SetBaseUrl', url);
  }

  /**
   * 全量同步节点树
   */
  syncFullTree(exportJson: string): number {
    this._syncSerial += 1;
    this.send('SyncFullTree', exportJson);
    return this._syncSerial;
  }

  getSyncSerial(): number {
    return this._syncSerial;
  }

  /**
   * 增量更新单个节点
   */
  updateNode(json: string): void {
    this.send('UpdateNode', json);
  }

  /**
   * 删除节点
   */
  deleteNode(nodeId: string): void {
    this.send('DeleteNode', nodeId);
  }

  /**
   * 设置选中节点
   */
  setSelection(nodeIds: string[]): void {
    this.send('SetSelection', JSON.stringify({ ids: nodeIds }));
  }

  /**
   * 设置相机 pan/zoom
   */
  setCamera(x: number, y: number, zoom: number): void {
    this._lastCamera = {
      at: new Date().toISOString(),
      x,
      y,
      zoom,
    };
    this.send('SetCamera', JSON.stringify({ x, y, zoom }));
  }

  /**
   * 设置画布分辨率
   */
  setCanvasSize(width: number, height: number): void {
    this.send('SetCanvasSize', JSON.stringify({ width, height }));
  }

  /**
   * 点击测试：查询给定屏幕坐标下的节点
   * 返回 Promise<nodeId>，nodeId 为空字符串表示没有命中
   *
   * 注意：Unity WebGL 的渲染分辨率（canvas.width/height）可能与 CSS 显示尺寸不同
   * （例如 960×600 渲染但 CSS 为 1337×800），需要将 CSS 坐标换算到 Unity 渲染坐标系
   */
  hitTest(screenX: number, screenY: number): Promise<string> {
    // 将 CSS 像素坐标换算为 Unity 渲染像素坐标
    let ux = screenX, uy = screenY;
    const canvas = document.getElementById('unity-canvas') as HTMLCanvasElement;
    if (canvas && canvas.width > 0 && canvas.height > 0) {
      const rect = canvas.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        ux = screenX * (canvas.width / rect.width);
        uy = screenY * (canvas.height / rect.height);
      }
    }

    return new Promise((resolve) => {
      this.hitTestResolve = resolve;
      this.send('HitTest', JSON.stringify({ x: ux, y: uy }));
      // 超时兜底
      setTimeout(() => {
        if (this.hitTestResolve === resolve) {
          this.hitTestResolve = null;
          resolve('');
        }
      }, 200);
    });
  }

  /**
   * 注册节点坐标变化回调
   */
  onNodeBounds(callback: (bounds: NodeBounds[]) => void): void {
    this._onNodeBounds = callback;
  }

  getLastNodeBounds(): LastNodeBounds {
    return {
      at: this._lastNodeBounds.at,
      raw: this._lastNodeBounds.raw.map((item) => ({ ...item })),
      css: this._lastNodeBounds.css.map((item) => ({ ...item })),
      scale: { ...this._lastNodeBounds.scale },
      canvas: this._lastNodeBounds.canvas ? { ...this._lastNodeBounds.canvas } : null,
    };
  }

  getLastCamera(): LastCamera {
    return { ...this._lastCamera };
  }

  /**
   * 截取当前画布为 base64 DataURL（截当前 active 画板的区域）
   */
  captureCanvas(opts?: {
    fullCanvas?: boolean;
    cropRect?: { x: number; y: number; width: number; height: number; padding?: number };
  }): string | null {
    const canvas = document.getElementById('unity-canvas') as HTMLCanvasElement;
    if (!canvas) return null;
    try {
      // 按当前 active 画板区域裁剪
      const st = useEditorStore.getState();
      const rect = canvas.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        const sxRatio = canvas.width / rect.width;
        const syRatio = canvas.height / rect.height;
        const cropPadding = opts?.cropRect?.padding ?? 0;
        const cropX = opts?.cropRect ? opts.cropRect.x - cropPadding : null;
        const cropY = opts?.cropRect ? opts.cropRect.y - cropPadding : null;
        const cropW = opts?.cropRect ? opts.cropRect.width + cropPadding * 2 : st.previewWidth;
        const cropH = opts?.cropRect ? opts.cropRect.height + cropPadding * 2 : st.previewHeight;
        // fullCanvas=true 时画板偏移按 0 算（缩略图场景：临时 prefab 通过 syncFullTree 渲染在
        // 当前 active 画板的位置，但截图调用方已自行处理几何，强制使用画板原点）
        let abX = cropX ?? 0, abY = cropY ?? 0;
        if (!opts?.fullCanvas) {
          const page = st.pages.find((p) => p.id === st.activePageId);
          const activeAb = page?.artboards.find((a) => a.id === st.activeArtboardId);
          abX = (activeAb?.x ?? 0) + (cropX ?? 0);
          abY = (activeAb?.y ?? 0) + (cropY ?? 0);
        }
        const cssX = st.canvasX + abX * st.canvasScale;
        const cssY = st.canvasY + abY * st.canvasScale;
        const sx = Math.max(0, Math.floor(cssX * sxRatio));
        const sy = Math.max(0, Math.floor(cssY * syRatio));
        const sw = Math.min(canvas.width - sx, Math.ceil(cropW * st.canvasScale * sxRatio));
        const sh = Math.min(canvas.height - sy, Math.ceil(cropH * st.canvasScale * syRatio));
        if (sw > 0 && sh > 0) {
          const out = document.createElement('canvas');
          out.width = sw;
          out.height = sh;
          const ctx = out.getContext('2d');
          if (ctx) {
            ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
            return out.toDataURL('image/jpeg', 0.85);
          }
        }
      }
      return canvas.toDataURL('image/jpeg', 0.85);
    } catch {
      return null;
    }
  }

  /**
   * 获取 Unity 是否已就绪
   */
  get isReady(): boolean {
    return this.instance !== null && this.readyPromise !== null && this.readyResolve === null;
  }

  async waitUntilReady(timeoutMs = 30000): Promise<boolean> {
    if (this.isReady) return true;
    if (!this.readyPromise) return false;
    try {
      await Promise.race([
        this.readyPromise,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Unity ready timeout')), timeoutMs)),
      ]);
      return this.isReady;
    } catch {
      return false;
    }
  }

  /**
   * 检测 WebGL 上下文是否丢失
   */
  isContextLost(): boolean {
    if (!this._canvas) return false;
    const gl = this._canvas.getContext('webgl2') || this._canvas.getContext('webgl');
    if (!gl) return true;
    return gl.isContextLost();
  }

  /**
   * 重新加载 Unity 实例（context 丢失后恢复用）
   */
  async reload(onProgress?: (progress: number) => void): Promise<void> {
    if (this._reloading) return;
    this._reloading = true;
    try {
      if (this.instance) {
        try { await this.instance.Quit(); } catch {}
        this.instance = null;
      }
      if (window.unityBridge) delete window.unityBridge;
      this.readyPromise = null;
      this.readyResolve = null;

      if (!this._canvas || !this._config) {
        throw new Error('Cannot reload: missing canvas or config');
      }
      await this.load(this._canvas, this._loaderUrl, this._config, onProgress);
    } finally {
      this._reloading = false;
    }
  }

  get isReloading(): boolean {
    return this._reloading;
  }

  getDebugMessages(): UnityDebugMessage[] {
    return [...this._debugMessages];
  }

  clearDebugMessages(): void {
    this._debugMessages = [];
  }

  /**
   * 卸载 Unity 实例
   */
  async destroy(): Promise<void> {
    if (this.instance) {
      await this.instance.Quit();
      this.instance = null;
    }
    if (window.unityBridge) {
      delete window.unityBridge;
    }
  }

  // ======== 内部方法 ========

  private send(method: string, arg?: string): void {
    const skipped = !this.instance;
    this.recordDebugMessage(method, arg, skipped);
    if (!this.instance) {
      console.warn(`[UnityBridge] Unity 未就绪，跳过: ${method}`);
      return;
    }
    if (arg !== undefined) {
      this.instance.SendMessage(BRIDGE_OBJECT, method, arg);
    } else {
      this.instance.SendMessage(BRIDGE_OBJECT, method);
    }
  }

  private recordDebugMessage(method: string, arg: string | undefined, skipped: boolean): void {
    const size = arg ? arg.length : 0;
    const message: UnityDebugMessage = {
      seq: ++this._debugSeq,
      at: new Date().toISOString(),
      method,
      skipped,
      size,
    };
    if (arg !== undefined) {
      message.argPreview = arg.length > 500 ? `${arg.slice(0, 500)}...` : arg;
      if (method === 'SyncFullTree' || method === 'UpdateNode') {
        message.arg = arg.length <= 2_000_000 ? arg : undefined;
        message.summary = this.summarizeJsonArg(arg);
      }
    }
    this._debugMessages.push(message);
    if (this._debugMessages.length > 50) this._debugMessages.shift();
  }

  private summarizeJsonArg(arg: string): UnityDebugMessage['summary'] | undefined {
    try {
      const data = JSON.parse(arg) as Record<string, any>;
      const nodes = Array.isArray(data.nodes) ? data.nodes as Record<string, any>[] : [];
      return {
        version: typeof data.version === 'string' ? data.version : undefined,
        name: typeof data.name === 'string' ? data.name : undefined,
        nodeCount: nodes.length,
        artboardCount: Array.isArray(data.artboards) ? data.artboards.length : undefined,
        inactiveCount: nodes.filter((node) => node.active === false).length,
        imageDisabledCount: nodes.filter((node) => node.imageEnabled === false).length,
        noAssetRenderableCount: nodes.filter((node) => {
          const type = typeof node.type === 'string' ? node.type : '';
          const color = typeof node.imageColor === 'string' ? node.imageColor : '';
          const alpha = color.length === 9 && color.startsWith('#')
            ? parseInt(color.slice(7, 9), 16) / 255
            : color.length === 5 && color.startsWith('#')
              ? parseInt(color.slice(4, 5).repeat(2), 16) / 255
              : 1;
          return (type === 'image' || type === 'button' || type === 'rawimage')
            && node.imageEnabled !== false
            && node.hasImage !== false
            && alpha !== 0
            && !node.imagePath;
        }).length,
      };
    } catch {
      return undefined;
    }
  }

  private setupCallbacks(): void {
    window.unityBridge = {
      onReady: () => {
        this.readyResolve?.();
        this.readyResolve = null;
      },
      onNodeBounds: (json: string) => {
        try {
          const data = JSON.parse(json);
          // 将 Unity 渲染坐标（canvas.width×canvas.height 空间）换算为 CSS 像素坐标
          // Unity WebGL 默认渲染分辨率（如 960×600）可能与 CSS 显示尺寸（如 1337×800）不同
          const canvas = document.getElementById('unity-canvas') as HTMLCanvasElement;
          let scaleX = 1, scaleY = 1;
          if (canvas && canvas.width > 0 && canvas.height > 0) {
            const rect = canvas.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              scaleX = rect.width / canvas.width;
              scaleY = rect.height / canvas.height;
            }
          }
          const rawBounds: NodeBounds[] = data.bounds || [];
          const bounds: NodeBounds[] = rawBounds.map((b) => ({
            id: b.id,
            x: b.x * scaleX,
            y: b.y * scaleY,
            width: b.width * scaleX,
            height: b.height * scaleY,
          }));
          this._lastNodeBounds = {
            at: new Date().toISOString(),
            raw: rawBounds.map((item) => ({ ...item })),
            css: bounds.map((item) => ({ ...item })),
            scale: { x: scaleX, y: scaleY },
            canvas: canvas ? {
              cssWidth: canvas.getBoundingClientRect().width,
              cssHeight: canvas.getBoundingClientRect().height,
              bufferWidth: canvas.width,
              bufferHeight: canvas.height,
            } : null,
          };
          this._onNodeBounds?.(bounds);
        } catch (e) {
          console.error('[UnityBridge] onNodeBounds 解析失败:', e);
        }
      },
      onHitTestResult: (nodeId: string) => {
        this.hitTestResolve?.(nodeId);
        this.hitTestResolve = null;
      },
    };
  }

  private loadScript(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = url;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`Failed to load: ${url}`));
      document.head.appendChild(script);
    });
  }
}

// 单例导出
export const unityBridge = new UnityBridge();
export default unityBridge;

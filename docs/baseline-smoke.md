# UIEditor_new 基线烟测记录

更新时间：2026-06-22。

本记录用于确认 `UIEditor_new` 当前复制清理后的最小可运行状态。它不是功能验收报告，只证明当前工程可以安装依赖、构建、启动 Vite 服务，并通过现有 Prefab 解析接口和 Unity 本地代理健康检查。

## 结论

更新时间：2026-06-25。

- `npm run build` 已通过。
- Vite dev server 默认使用 `http://127.0.0.1:4105/`，端口固定为 4 开头以区别老 UIEditor。
- 当前项目 Prefab/组件解析接口可用。
- 老 UIEditor 的 Unity 本地 HTTP 代理 `http://127.0.0.1:8081/health` 可用，但只作为老工具状态，不作为 `UIEditor_new` 主链路。
- `UIEditor_new` 独立桥接服务 `http://127.0.0.1:18082/health` 可用，返回 `UIEditorNewBridge`，当前运行版本 `UIEditor_new-bridge-mvp-81`。
- Unity 侧桥接源码在 `unity/Assets/Editor/UIEditorNew/`，客户端工程通过 junction 指向该目录；`.meta` 已忽略。
- 主画布已替换为 Unity Editor Bridge 截图叠加编辑层（`BridgeMainCanvas`），不再加载旧 `/unity/Build/unity.loader.js`。
- UGUI 截图编码已改为 JPEG（质量 80），NGUI 保留 PNG 透明背景。
- NGUI 支持已完成重写第一步：改 `UIDrawCall.cs` drawcall 出生跟随 manager scene，working root 移入 session PreviewScene，桥侧删除约 55% 打地鼠代码；`DD_FP_HeroDisplay` 可正常 open/render/close。详见 `ngui-rewrite-plan.md` 与 `ngui-isolation-change.md`。
- 前端仍会出现旧 MCP 连接失败告警；当前新流程不以 MCP 告警作为 Unity 可用性判断依据。

## 命令与结果

### 构建

执行目录：`E:/Projects/Dreamland/fact-source/UIEditor_new`

```text
npm run build
```

结果：

```text
tsc -b && vite build
417 modules transformed
dist/index.html
dist/assets/index-Cs2s2B4_.css
dist/assets/index-Be5AFUG8.js
built in 367ms
```

构建过程中有两个已知警告：

- `ag-psd` 依赖的 `util` 被 Vite 外部化为浏览器兼容模块。
- 主 chunk 超过 500 kB，以及两个动态导入由于静态引用不能拆分。

这些警告不阻断当前基线确认，但后续如果继续保留 PSD/UE 导出能力，需要单独决定是否做代码拆分。

### Dev Server

执行目录：`E:/Projects/Dreamland/fact-source/UIEditor_new`

```text
npm run dev -- --host 127.0.0.1
```

启动结果：

```text
[prefabServer] 缓存: 6464 图片, 1790 预制体, 3 字体, 47 sprite特征 (9 个有歧义)
[prefabServer] 图片尺寸读取完成: 6464 个
[unityBridge] Unity Bridge Plugin v3 已加载（MCP 通信已移至前端）
[uieditor-debug] Runtime debug command bridge loaded
VITE v8.0.3 ready
Local: http://127.0.0.1:4105/
```

当前主画布不再尝试加载旧 WebGL 路径。旧浏览器内 WebGL 主画布已删除；`UnityBridge.ts` 和 `StoreSync.ts` 仅作为未清理的旧诊断/辅助路径保留，默认入口已切到 `BridgeMainCanvas`。

```text
src/App.tsx -> src/components/Canvas/BridgeMainCanvas.tsx
```

### HTTP Smoke

执行结果：

```text
200 http://127.0.0.1:4105/
200 http://127.0.0.1:4105/api/prefabs/list prefabs=1790
200 http://127.0.0.1:4105/api/components/list components=88
200 http://127.0.0.1:4105/api/prefabs/parse?path=UICommons%2FUIBlueBtn.prefab name=UIBlueBtn
200 http://127.0.0.1:8081/health name=UIEditorCorsProxy
200 http://127.0.0.1:18082/health name=UIEditorNewBridge
```

## 解释

当前工程的可用基线是“Web/Vite + Prefab 静态解析 + `UIEditor_new` 独立 Unity Editor Bridge + Web 截图叠加画布”可用，而不是“旧 WebGL 预览”可用。

后续 `UIEditor_new` 的首要改造不应围绕恢复 `/unity/Build` 目录展开，而应围绕以下替换点推进：

- 用 Unity Editor Bridge 的 `renderSnapshot` 返回截图，替代 WebGL canvas 作为视觉底图。
- 用 Unity Editor Bridge 的 `exportNodeTree` 返回节点树和 bbox，替代 WebGL runtime bounds。
- 用 `applyVisualPatch` + `validateProtectedDiff` 替代 StoreSync 的持续全量/增量 WebGL 同步。
- 保留现有 `/api/prefabs/list`、`/api/components/list`、`/api/prefabs/parse` 作为 Web 侧选择、搜索和静态导入的辅助接口。
- 新增独立 `UIEditorNew` 客户端桥接服务，默认监听 `http://127.0.0.1:18082`，不扩展老 `UIEditorCorsProxy`。

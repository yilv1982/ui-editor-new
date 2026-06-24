# 旧 WebGL 依赖地图

更新时间：2026-06-22。

本文件盘点 `UIEditor_new` 当前源码中仍然围绕 Unity WebGL 预览建立的依赖，并给出新截图式编辑链路中的处理策略。结论先行：WebGL 不再作为视觉真值，也不再作为节点编辑的实时执行环境；Web 侧只保留叠加交互、状态编辑和 patch 队列。

## 分级

- **替换**：核心链路要换成 Unity Editor Bridge HTTP API。
- **拆分复用**：保留交互或 UI 部分，但剥离 WebGL 通信。
- **保留辅助**：与 Prefab 静态解析、资源检索、缓存、保存草稿相关，可继续使用。
- **降级为旧诊断**：只服务 WebGL 对比历史问题，不进入新 MVP 主链路。
- **移除**：WebGL 专用 workaround 或旧连接噪声。

## 核心依赖清单

| 文件/模块 | 当前作用 | WebGL 依赖点 | 新流程处理 |
| --- | --- | --- | --- |
| `src/App.tsx` | 主应用直接渲染 `BridgeMainCanvas` | 第一视口编辑画布绑定 Editor Bridge 截图与 bbox | **已替换**：主画布接 Unity Editor Bridge snapshot/bbox，不再加载旧 WebGL runtime |
| 旧浏览器内 WebGL 主画布 | 已删除 | 曾读取 `/unity/Build/*.js/wasm/data`，调用 `unityBridge.load`，监听 WebGL context，旧 canvas 是视觉底图 | **已删除**：有价值的 pan/zoom、工具栏、拖放、批注/参考线逻辑已合并到 `BridgeMainCanvas` |
| `src/services/UnityBridge.ts` | 浏览器内 WebGL bridge | `createUnityInstance`、`SendMessage`、`window.unityBridge`、`SyncFullTree`、`UpdateNode`、`HitTest`、`onNodeBounds`、`captureCanvas` | **替换**：新增 HTTP `EditorBridgeClient`，方法改为 `openPrefab/exportNodeTree/renderSnapshot/applyVisualPatch/validateProtectedDiff/savePrefab` |
| `src/services/StoreSync.ts` | Zustand store 自动同步到 WebGL | store 变化后 `SyncFullTree`；拖拽期间跳过 full sync，由 overlay 发 `UpdateNode` | **替换**：取消持续同步；拖动只更新本地 overlay 和 patch draft，松手/提交时调用 `applyVisualPatch`，等待 Unity 返回新截图和 bbox |
| `src/components/Canvas/SelectionOverlay.tsx` | 选中框、移动、缩放、旋转手柄 | bounds 类型来自 `UnityBridge`；拖动时调用 `beginInteractiveSync/endInteractiveSync` 和 `unityBridge.updateNode` | **拆分复用**：保留手柄与交互；bounds 来源改成 `renderSnapshot/exportNodeTree`；拖动结束生成视觉 patch，不再每帧发 WebGL 增量 |
| `src/components/Panels/PrefabThumbnail.tsx` | 公共组件/Prefab 缩略图 | 优先读缓存；无缓存时把临时节点同步到 WebGL，再 `captureCanvas` 上传缓存 | **替换/保留辅助**：缓存与静态 fallback 保留；Unity 渲染缩略图改用 Editor Bridge `renderSnapshot`，不再依赖 WebGL ready |
| `src/services/UnitySync.ts` | 同步当前 JSON 到 Unity Editor，含 MCP 兜底 | 现有 `/sync-preview`、`/sync-incremental` 仍接收 WebGL 导出 JSON；MCP fallback 会部署 C# 脚本和执行菜单 | **降级为旧链路**：新流程不要复用这个 JSON 同步接口保存 Prefab；可临时借鉴本地代理发现逻辑 |
| `src/services/McpClient.ts` | 旧 MCP/CORS 连接客户端 | 默认已隔离到 `https://127.0.0.1:8082/mcp` 和 `uieditor_new_mcp_url`，仍保留 HTTP fallback、8080 直连 MCP | **降级为旧链路**：新流程不按 MCP 判定 Unity 可用性；MCP 告警应从默认 UI 状态中降级 |
| `src/services/RuntimeDebugBridge.ts` | 运行时视觉探针、WebGL bounds 诊断、问题队列 | 依赖 `unityBridge.getDebugMessages/getLastNodeBounds/isContextLost/setSelection` 等 WebGL runtime 状态 | **降级为旧诊断**：保留历史问题解释价值；新诊断应改为截图 bbox、protected diff 和 patch 回放结果 |
| `scripts/visual-*.mjs` | 批量视觉抽样、Unity reference 对比、WebGL bounds 分析 | 通过浏览器打开 WebGL 预览，比较 WebGL runtime 与 Unity reference | **降级/改造**：`capture-reference` 部分可复用；WebGL runtime bounds 相关判断要替换为 Editor Bridge bbox 与截图 diff |
| `src/main.tsx` | 防止 WebGL 抢占 HTML 输入焦点 | 专门处理 WebGL canvas 每帧 focus | **移除**：截图式底图不需要 WebGL focus workaround |
| `src/utils/ueExport/common.ts` | 多画板截图/导出辅助 | 旧流程从 WebGL canvas 裁剪画板 | **替换**：导出时使用当前 Bridge 截图底图和叠加层合成，或请求 Editor Bridge 按画板渲染 |
| `src/components/Panels/Toolbar.tsx` | Unity 连接检查与同步按钮 | 通过 `UnitySync` 调用 `/sync-preview`、`/sync-incremental`，并显示 MCP 证书问题 | **替换**：新流程按钮应围绕打开 Prefab、刷新截图、提交 patch、验证 diff、保存副本 |
| `src/plugins/prefabServer.ts` | Vite 端解析 Prefab、列 Prefab、列 UICommons 组件、缩略图缓存 | 不依赖 WebGL 作为数据源；只负责静态解析与缓存文件读写 | **保留辅助**：继续作为选择/搜索/静态预解析服务；权威渲染仍交给 Unity Editor Bridge |
| `src/plugins/atlasServer.ts` | 图集/贴图搜索与读取 | 不依赖 WebGL | **保留辅助** |
| `src/plugins/unityBridgePlugin.ts` | Vite 端 Unity 配置和截图文件服务 | 旧截图文件服务、旧配置名仍叫 unity bridge | **保留辅助/重命名**：配置读写可复用；截图文件服务要对齐新 `renderSnapshot` 输出 |

## 当前已知运行现象

当前 `npm run dev -- --host 127.0.0.1` 会使用 `4105` 端口启动 Web 服务和 Prefab 解析接口，但页面会报：

```text
Failed to load: /unity/Build/unity.loader.js
```

这不是新流程的阻断项，而是旧 WebGL 主画布尚未被替换的明确证据。下一步应先把主画布换成截图底图 + overlay，而不是恢复旧 WebGL build。

## 新主链路替换关系

```text
旧链路：
Zustand store -> StoreSync -> UnityBridge(WebGL SendMessage)
WebGL runtime -> onNodeBounds / HitTest / captureCanvas
UnitySync -> /sync-preview 或 /sync-incremental -> 预览或写回

新链路：
Web 选择 Prefab -> EditorBridgeClient.openPrefab
Unity Editor -> exportNodeTree + renderSnapshot
Web ScreenshotCanvas -> overlay 选择/拖拽/属性编辑 -> patch draft
Web 提交 patch -> applyVisualPatch(renderAfter=true)
Unity Editor -> 新截图 + 新 bbox + protected diff
保存前 -> validateProtectedDiff -> savePrefab(temp-copy first)
```

## 首批改造顺序

1. 新增 `EditorBridgeClient`，只封装 HTTP API，不再引用 `UnityBridge.ts`。
2. 新增截图画布组件，底图使用 `renderSnapshot` 返回的 image，overlay bounds 使用同一响应里的 bbox。
3. 从 `SelectionOverlay` 抽出 WebGL 无关的手柄和拖拽计算，拖动结束生成 patch。
4. 默认禁用 `StoreSync` 自动同步，避免修改 store 时隐式写入 Unity。
5. `Toolbar` 拆出新流程按钮：打开 Prefab、刷新截图、提交 patch、验证保护字段、保存副本。
6. 缩略图生成从 WebGL capture 改为 Editor Bridge render，保留静态 fallback。
7. `RuntimeDebugBridge` 和 `scripts/visual-*` 标记为旧 WebGL 诊断，后续按截图 diff 重新建新诊断入口。

## 不进入 MVP 的旧能力

- WebGL context 丢失自动恢复。
- 每帧/每次 store 变化自动同步完整节点树。
- MCP 自动部署 C# 脚本。
- WebGL runtime hit test 作为最终命中来源。
- WebGL canvas 裁剪作为最终导出图来源。
- 为恢复旧预览而重新提交 `/unity/Build` 构建产物。

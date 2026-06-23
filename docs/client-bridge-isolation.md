# 客户端工程桥接隔离约束

更新时间：2026-06-22。

`UIEditor_new` 和老 `UIEditor` 在客户端 Unity 工程端必须彼此隔离。尤其是本地桥接服务，不能共享脚本入口、端口、菜单、静态状态、临时文件或保存路径，避免一个工具的启动、同步、截图或保存动作影响另一条路线。

## 隔离结论

| 项目 | 老 UIEditor | UIEditor_new |
| --- | --- | --- |
| Unity Editor 脚本目录 | `Assets/Editor/UIEditor/` | `Assets/Editor/UIEditorNew/` |
| C# 类名前缀 | `UIEditor...` | `UIEditorNew...` |
| Unity 菜单前缀 | `UIEditor/...` | `UIEditorNew/...` |
| 本地 HTTP 端口 | `8081` | `8082` |
| 健康检查 name | `UIEditorCorsProxy` | `UIEditorNewBridge` |
| Web 默认桥接配置 | 旧 MCP/CORS 或旧本地代理 | `editorBridgeUrl = http://127.0.0.1:8082` |
| 同步/临时 JSON | `Assets/Editor/uieditor_*` | `Assets/Editor/UIEditorNew/uieditor_new_*`、`Library/UIEditorNew/` 或 `Assets/Temp/UIEditorNew/` |
| 临时 Prefab | 旧工具自有策略 | `Assets/Temp/UIEditorNew/` |
| 截图缓存 | 旧工具自有策略 | `Temp/UIEditorNew/Snapshots/` |

## 硬性边界

- `UIEditor_new` 不扩展、不修改、不替换 `Assets/Editor/UIEditor/UIEditorCorsProxy.cs`。
- `UIEditor_new` 不调用老桥的 `/sync-preview`、`/sync-incremental`、`/capture-reference` 作为新主链路。
- `UIEditor_new` 不复用老桥的 `LastSyncJson`、静态队列、菜单项或后台线程。
- `UIEditor_new` 不能在 `8081` 上启动服务；如果 `8082` 被占用，应明确失败并提示占用来源，不应回退到 `8081`。
- 两条路线都不应直接写正式业务 Prefab 做首轮验证；`UIEditor_new` 首轮只写 `Assets/Temp/UIEditorNew/` 下的临时副本。
- 可复制老桥中已经验证过的渲染、Prefab 归一化、Rect/BBox 计算思路，但复制后必须改名、改目录、改端口并移除对老静态状态的依赖。

## 推荐客户端脚本拆分

`UIEditor_new` 首批客户端脚本建议放在：

```text
Assets/Editor/UIEditorNew/
  UIEditorNewBridgeServer.cs
  UIEditorNewSessionStore.cs
  UIEditorNewPrefabExporter.cs
  UIEditorNewSnapshotRenderer.cs
  UIEditorNewPatchApplier.cs
  UIEditorNewProtectedDiff.cs
```

菜单项统一使用：

```text
UIEditorNew/Start Bridge
UIEditorNew/Stop Bridge
UIEditorNew/Capture Current Session
UIEditorNew/Validate Protected Diff
```

## 与老桥的关系

老桥当前能证明 Unity Editor 可以通过本地 HTTP 代理被浏览器访问，也能证明 Unity 端可以用 `AssetDatabase`、`PrefabUtility` 和 `RenderTexture` 完成截图参考。这些是实现经验，不是 `UIEditor_new` 的运行时依赖。

后续如果需要把老桥能力沉淀为共享库，只能抽出无状态、无端口、无菜单的纯工具类，例如 Prefab 路径归一化、RectTransform bbox 计算、Graphic 摘要采集。共享库不能持有 HTTP listener、session、临时文件路径或保存逻辑。

## 验收口径

- 老 UIEditor bridge 和 `UIEditor_new` bridge 可同时存在于客户端工程中，并各自启动/停止。
- 启动 `UIEditor_new` bridge 不会占用、停止或改写老 UIEditor 的 `8081` 服务。
- 调用 `UIEditor_new` 的打开、截图、patch、diff、保存接口不会写入老 UIEditor 的临时 JSON、截图或缓存位置。
- Unity 编译时不存在 `UIEditorCorsProxy`、`UIEditorBridgeSync` 等重复类名冲突。
- Git diff 能清楚区分老 UIEditor 脚本变更和 `UIEditor_new` 脚本变更。

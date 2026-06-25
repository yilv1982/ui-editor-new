# Web 远程画板烟测

更新时间：2026-06-22。

本记录确认 `UIEditor_new` 当前主流程已切到“老 UIEditor 交互壳 + Unity Editor Bridge 远程编辑临时 Prefab”的方向。Web 主入口为 `RemoteArtboardEditor`：Web 只维护画板列表、选中节点、视口、属性面板草稿和操作指令；Unity 临时 Prefab 是主编辑状态。

## 前置状态

- `UIEditor_new` Web 服务运行在 `http://127.0.0.1:4105/`。
- 新桥 `http://127.0.0.1:18082/health` 返回 `UIEditorNewBridge`。
- 老桥 `http://127.0.0.1:8081/health` 保持独立，不作为新流程依赖。
- `unity-config.json` 中 `editorBridgeUrl` 为 `http://127.0.0.1:18082`。

## 覆盖能力

- 新建空画板会在 Unity 工程中创建临时 Prefab。
- 打开现存 UI 会创建该 UI 的临时副本画板。
- 拖现存 UI 到编辑区会通过 `insert-prefab` 复制为当前画板的普通子节点。
- 浏览器只保存画板元数据和 `workingPrefabPath`；刷新后通过 `resume-session` 从 Unity 临时 Prefab 恢复截图、bbox、选中和 dirty。
- 位置、尺寸、文本、文字样式、图片引用、显隐、新增文字/图片、删除、undo/redo 均通过 Bridge 指令执行；高频节点操作先改 Unity 内存 working root，15 秒无修改后自动落盘到临时 Prefab。
- 拖动中使用 in-flight 保护和 140ms 节流，避免请求堆积；松手后 Web 先做本地乐观反馈，Bridge 操作和截图刷新进入串行队列。
- 节点编辑的用户可见反馈目标为 200ms 内；Unity 写 Prefab 和重新截图作为异步真值回填。
- 保存前 Bridge 内部执行 protected diff，用户只看到保存成功或简化失败原因。
- 关闭画板时删除对应 Unity 临时 Prefab；保存过的目标 Prefab 不会因为关闭画板被删除。

## 外部 headless 浏览器烟测

命令：

```bash
npm run smoke:bridge-web
npm run smoke:bridge-web -- --prefab UICommons/UIBlueBtn.prefab --out .cache/editor-bridge-web-smoke/uibluebtn
```

该脚本不引入 Playwright 依赖，直接启动系统 Chrome/Edge 的 headless 模式和临时 profile，通过 DevTools Protocol 操作 `http://127.0.0.1:4105/`。脚本结束后会关闭浏览器进程，只输出短摘要；详细报告和截图写入 `.cache/editor-bridge-web-smoke/`。

## 2026-06-22 实测结果

`UICommons/UIAlert2.prefab`：

```json
{
  "ok": true,
  "created": "Assets/Temp/UIEditorNew/CodexRemoteSmoke_*.prefab",
  "restoredBboxCount": 2,
  "openedPrefab": "UICommons/UIAlert2.prefab",
  "openedBboxCount": 20,
  "insertedBboxCount": 22,
  "closedTempCount": 2,
  "maxInteractionMs": 29,
  "maxUnityRoundtripMs": 874,
  "visualSha256Match": true
}
```

`UICommons/UIBlueBtn.prefab`：

```json
{
  "ok": true,
  "created": "Assets/Temp/UIEditorNew/CodexRemoteSmoke_*.prefab",
  "restoredBboxCount": 2,
  "openedPrefab": "UICommons/UIBlueBtn.prefab",
  "openedBboxCount": 2,
  "insertedBboxCount": 4,
  "closedTempCount": 2,
  "maxInteractionMs": 31,
  "maxUnityRoundtripMs": 872,
  "visualSha256Match": true
}
```

增强版 smoke 会拆分两个指标：用户交互确认 `interactionLatency` 必须不超过 200ms，Unity 后台真值动作 `unityRoundtripLatency` 仍记录打开、保存、关闭等真实耗时并设置 8000ms 上限。2026-06-22 内存 working root 改造后复测：`UIAlert2` 最大交互确认 28ms，`UIBlueBtn` 最大交互确认 30ms；直接 Bridge profile 中 `move-node(skipSnapshot)` 的 Unity 执行时间分别约 6.1ms 和 0.9ms。保存新 UI 后，脚本会重新通过 Unity Bridge 打开保存出的 Prefab，再渲染截图并和 Web 当前真值截图做 SHA-256 比对，两个样本均完全一致。

额外 Bridge 验证：

```json
{
  "setupSaveOk": true,
  "modifyOk": true,
  "saveBackOk": true,
  "savedPath": "Assets/Temp/UIEditorNew/CodexExistingSource.prefab",
  "sourcePrefabPath": "Assets/Temp/UIEditorNew/CodexExistingSource.prefab",
  "protectedOk": true,
  "protectedCount": 0,
  "sourceContainsSavedBack": true
}
```

额外验证使用临时 source Prefab，不覆盖正式 `UICommons` 样本。

## 修复记录

- Unity 2022.3.62 不再接受 `Resources.GetBuiltinResource<Font>("Arial.ttf")`，默认文字节点改用 `LegacyRuntime.ttf`。
- 新增视觉节点时，Unity YAML 会产生默认 `m_PrefabAsset`、空 `m_PersistentCalls` 和空 `m_Calls` 行；这些不是程序接线变更，已从 protected line 签名中排除。事件目标、方法、调用状态、源 Prefab 和删除组件仍保留为保护签名。
- headless smoke 现在在首个页面文档执行前清理本地画板状态，刷新恢复时保留 localStorage，避免漏建未关闭的启动画板。
- `RemoteArtboardEditor` 增加启动锁，避免 Vite/React dev 模式 effect 重放导致重复创建 Unity 临时 Prefab。
- 节点操作新增 `skipSnapshot` 快速返回：Bridge 更新 Prefab 后返回节点树，截图由 Web 队列异步刷新；Web 侧增加短重试，避免瞬时请求断开直接暴露为编辑失败。

## 已知边界

- 当前是可试点 MVP：操作队列已有基本乱序保护和短重试，但还没有完整的批量事务 UI。
- protected diff 仍是 MVP 结构签名审计，后续需要输出更细的字段级/组件级报告。
- UI 人员使用说明还需要单独写成短文档；当前文档偏工程烟测。

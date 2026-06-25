# UIEditor_new Editor Bridge 烟测记录

更新时间：2026-06-22。

本记录确认 `UIEditor_new` 在当前 DL2 客户端工程端已经具备首版独立 Unity Editor Bridge。Web 截图叠加编辑层的样本烟测见 `web-overlay-smoke.md` 与 `trial-samples.md`。

## 结论

- 客户端工程已新增独立目录 `Assets/Editor/UIEditorNew/`。
- 新桥 `UIEditorNewBridgeServer` 自动监听 `http://127.0.0.1:18082`，健康检查返回 `UIEditorNewBridge`。
- 老 UIEditor 桥 `http://127.0.0.1:8081/health` 同时可用，返回 `UIEditorCorsProxy`。
- 新桥不调用老桥的 `/sync-preview`、`/sync-incremental`、`/capture-reference`，不写 `UIEditorCorsProxy.LastSyncJson`。
- `UICommons/UIBlueBtn.prefab` 临时副本已跑通 `open -> export -> render -> patch -> validate -> save -> close`。
- `UICommons/UIAlert2.prefab` 临时副本也已跑通多节点弹窗样本，覆盖 29 个节点和 Prefab Variant modification 重排场景。
- 首轮 patch 使用 `rectTransform.anchoredPosition` 白名单字段，两个样本 `protected diff` 结果均为 `protectedCount=0`。
- `close-prefab(deleteTempObjects=true)` 会删除本轮 `Assets/Temp/UIEditorNew/` 下临时 Prefab；截图输出保留在客户端工程 `Temp/UIEditorNew/Snapshots/`，属于运行产物。

## 实测摘要

```text
GET  http://127.0.0.1:18082/health
-> {"ok":true,"name":"UIEditorNewBridge","version":"UIEditor_new-bridge-mvp-81",...}

GET  http://127.0.0.1:8081/health
-> {"ok":true,"name":"UIEditorCorsProxy"}

POST /open-prefab
-> ok=True, mode=temp-copy, working=Assets/Temp/UIEditorNew/UIBlueBtn__uieditor_new_tmp_*.prefab, revision=r1

POST /export-node-tree
-> ok=True, nodes=2, root=fileID:5836563536523210523, revision=r1

POST /render-snapshot
-> ok=True, bboxes=2, path=Temp/UIEditorNew/Snapshots/*.png

POST /apply-visual-patch
-> ok=True, revision=r2, applied=1, rejected=0, protectedDiff.summary.protectedCount=0

POST /validate-protected-diff
-> ok=True, allowed=1, protected=0

POST /save-prefab
-> ok=True, saved=Assets/Temp/UIEditorNew/UIBlueBtn__uieditor_new_tmp_*.prefab, revision=r2

POST /close-prefab
-> ok=True
```

## 当前能力边界

- 这是 MVP 桥接闭环，不是最终 protected diff 实现。当前 protected diff 已从逐行 YAML 白名单升级为结构签名校验，但字段级/组件级报告仍需继续补强。
- Web 端已有 `EditorBridgeClient` 和截图底图组件，当前默认主画布已接入 `render-snapshot` 与 `renderAfter=true` 回包。
- UI 公共组件库输入输出契约已定义，见 `component-library-io-contract.md`。

## 下一步

- 将 protected diff 从 MVP 结构签名校验继续推进到字段级、节点级和组件级报告。
- 继续补 Text/Image 属性面板样本、patch 队列和只读保护提示。

# UIEditor_new 工作项说明

## 背景

`UIEditor_new` 是从 `../UIEditor` 复制出的新实验工具工程，位于 `fact-source` 下，用于承接 UIEditor 下一阶段改造。原 UIEditor 已经可以读取 Dreamland 的 UI Prefab、贴图、字体和 UICommons 公共组件候选，也已验证过通过 Unity Editor 本地代理进行预览同步和临时 Prefab 增量写回。ai-native 仓库只记录本工具与 AI Native 路线之间的目标、边界和衔接。

现阶段需要重新收敛架构边界：浏览器内 Unity WebGL 不再作为真实 Prefab 环境和视觉真值来源。它无法直接访问 Unity Editor 的 `AssetDatabase`，也会继续带来字体、布局、Mask、图集、Shader 和运行时组件的同步差异。新的方向是让 Unity Editor Bridge 成为资产事实和视觉真值服务，Web 前端只负责编辑交互和待提交变更。

## 目标

建立一条截图式远程 UI 编辑链路：

```text
Unity Editor Bridge
  打开真实 Prefab
  导出节点元数据和屏幕包围盒
  渲染整张 Unity 真值截图
        |
        v
Web UIEditor
  显示整张截图
  叠加选择框、拖拽手柄、辅助线和属性编辑面板
  只维护画板列表、选中、视口、面板草稿和操作指令
        |
        v
Unity Editor Bridge
  以临时 Prefab 作为主编辑状态
  应用视觉字段 patch
  重新布局、重新截图、校验 diff
  按白名单保存回 Prefab
```

这条路线不在 Web 端拆分并拼接真实 UI 像素，也不再把完整 JSON 节点树作为主编辑事实。真实视觉的拆分、布局计算、渲染、Prefab 修改和保存都由 Unity Editor 完成；Web 是远程操作壳。

## 清理口径

本目录只保留新路线需要继续改造的源码、配置、脚本和当前工作项说明。复制自旧 UIEditor 的历史说明、旧 LOA 计划/规格、WebGL 构建产物、静态 `Part_*` 缩略图、临时图片、证书、本地结构样例、Jenkins 同步入口和运行日志不作为 `UIEditor_new` 的依据。

如需回看旧资料，应回到原始来源或 ai-native 的过程性盘点，而不是把旧文档重新混入此目录。当前事实入口是本文件和后续为截图式编辑链路新增的文档。

## 当前基线

更新时间：2026-06-22。详见 `docs/baseline-smoke.md`。

- `npm run build` 已通过。
- Vite dev server 默认端口已改为 `4105`，用于和老 UIEditor 的 `3000/3021/3105` 等历史端口明显区分。
- `/api/prefabs/list` 可返回 1790 个 Prefab。
- `/api/components/list` 可返回 88 个 UICommons 组件候选。
- `/api/prefabs/parse?path=UICommons%2FUIBlueBtn.prefab` 可解析 `UIBlueBtn`。
- Unity 本地代理 `http://127.0.0.1:8081/health` 可返回 `UIEditorCorsProxy`。
- 客户端工程已新增 `Assets/Editor/UIEditorNew/` 首版独立桥接脚本，`http://127.0.0.1:8082/health` 可返回 `UIEditorNewBridge`；老 `8081` 桥同时保持可用。
- 通过 HTTP API 已用 `UICommons/UIBlueBtn.prefab` 临时副本跑通 `open -> export -> render -> patch -> validate -> save -> close`，记录见 `docs/editor-bridge-smoke.md`。
- Web 主入口已切到 `RemoteArtboardEditor`，通过 `EditorBridgeClient` 连接 `http://127.0.0.1:8082`，不再默认加载已清理的旧 WebGL build。
- Web 已按“画板 = 一个 UI Prefab 编辑任务”跑通：新建空画板、打开现存 UI 为画板、拖现存 UI 到编辑区作为普通子节点、保存、关闭和刷新恢复。
- 外部 headless Chrome/Edge 烟测命令 `npm run smoke:bridge-web` 已验证 `UICommons/UIAlert2.prefab` 和 `UICommons/UIBlueBtn.prefab` 两个样本；脚本产物位于 `.cache/editor-bridge-web-smoke/latest/` 与 `.cache/editor-bridge-web-smoke/uibluebtn/`。增强版 smoke 会分别记录 200ms 内交互确认耗时和 Unity 回放耗时，并在保存后重开 Prefab 做 Unity 截图 SHA-256 一致性比对。
- 通过临时 source Prefab 验证了“已有 UI 画板 target 为空时默认保存回 source Prefab”，未覆盖正式 `UICommons` 样本。
- UI 公共组件库与 `UIEditor_new` 的输入/输出契约已形成首版，见 `docs/component-library-io-contract.md`。
- Unity 新桥 protected diff 已从逐行 YAML 白名单升级为 MVP 结构签名校验，能避免 Prefab Variant `m_Modifications` 重排造成的误报。

## 客户端工程隔离原则

详见 `docs/client-bridge-isolation.md`。

`UIEditor_new` 在 `../DreamlandProject` 中不得复用或改写老 UIEditor 的桥接服务。老 UIEditor 保留 `Assets/Editor/UIEditor/`、`UIEditor...` 类名、`UIEditor/...` 菜单和 `8081` 端口；`UIEditor_new` 必须使用独立的 `Assets/Editor/UIEditorNew/`、`UIEditorNew...` 类名、`UIEditorNew/...` 菜单和 `8082` 端口。

老桥的 `UIEditorCorsProxy`、`UIEditorBridgeSync`、`UIEditorReferenceCapture` 只能作为实现参考或可复制后改名的代码来源，不能作为 `UIEditor_new` 的运行时依赖。后续实现 `openPrefab`、`renderSnapshot`、`applyVisualPatch`、`validateProtectedDiff`、`savePrefab` 时，所有 session、临时文件、截图缓存和写回路径都必须落到 `UIEditorNew` 自己的命名空间内。

## 节点模型定义

Web 侧节点模型只表达可编辑结构，不表达真实渲染结果。首版至少包含：

- Unity 身份：`fileID`、Prefab 内路径、节点名、父子关系。
- 布局字段：anchor、pivot、anchoredPosition、sizeDelta、localScale、rotation。
- 组件摘要：Image、Text、Button、Mask、LayoutGroup、ContentSizeFitter 等存在性和关键视觉字段。
- 编辑边界：可编辑字段白名单、受保护字段、不可写原因。
- 截图定位：Unity 返回的屏幕空间 bbox，用于 Web 叠加层命中、框选和拖拽。
- Patch 状态：用户本轮修改的字段、来源操作、是否已由 Unity 回放确认。

## TODO

- [x] 复制后基线确认：在 `UIEditor_new` 中执行依赖安装和本地启动，记录当前能跑通的页面、接口和失败项。记录见 `docs/baseline-smoke.md`。
- [x] 清理旧 WebGL 核心假设：盘点 `src/components/Canvas/UnityCanvas.tsx`、`StoreSync.ts` 和相关调用，把 WebGL 预览降级为可选模式或实验开关。依赖地图见 `docs/webgl-dependency-map.md`。
- [x] 定义 Unity Editor Bridge API：`openPrefab`、`renderSnapshot`、`exportNodeTree`、`applyVisualPatch`、`savePrefab`、`validateProtectedDiff`。API 草案和首批实现 TODO 见 `docs/unity-editor-bridge-api.md`。
- [x] 明确客户端工程端桥接隔离：`UIEditor_new` 与老 UIEditor 不共用脚本目录、类名、菜单、端口、静态状态、临时文件和保存路径。约束见 `docs/client-bridge-isolation.md`。
- [x] 实现 Editor 侧节点导出：从真实 Prefab 导出层级、fileID、RectTransform、组件摘要、保护字段和屏幕 bbox。
- [x] 实现 Editor 侧整图截图：在固定 Canvas/分辨率下渲染完整 UI，返回图片和截图坐标系信息。
- [x] 实现 Web 截图画布：底层显示 Unity 截图，上层叠加节点 hover、选中框和拖拽操作。
- [x] 实现拖拽远程同步：拖动中按节流发送 `moveNode(nodeId,x,y)`，上一个请求未返回时不堆叠乱序请求，松手后先做 Web 本地乐观反馈，再异步提交最终位置并刷新截图。
- [x] 建立画板任务模型：Web 只持久化画板 id、名称、source Prefab、working Prefab、保存目标、dirty 和选中节点；刷新后通过 `resume-session` 读取 Unity 临时 Prefab。
- [~] 建立视觉字段白名单：后端首版已限制 RectTransform、Text、Image 和 Button 可视字段；Web 属性面板已接入 activeSelf、Text、TextStyle、Image.sprite、位置、尺寸和显隐的基础提交，后续需扩展更多只读提示。
- [~] 建立保护字段审计：后端 protected diff 已升级为 MVP 结构签名校验；后续需继续扩展字段级/组件级报告。
- [x] 选低风险样本 Prefab 验证：`UIBlueBtn` 与 `UIAlert2` 两个样本已跑通 Web+后端桥接闭环。
- [x] 建立轻量浏览器烟测入口：`npm run smoke:bridge-web` 使用系统 Chrome/Edge headless 和临时 profile，跑完自动退出，不依赖 Codex 内置浏览器。
- [x] 增加 200ms 交互响应策略：节点操作先本地乐观更新并返回“已提交”，Bridge 操作和截图刷新进入串行队列；高频节点操作改为 Unity 内存 working root，15 秒 idle 自动落盘；`UIAlert2` 复测最大交互确认 28ms，`UIBlueBtn` 复测最大交互确认 30ms。
- [~] 增加截图缓存和节流策略：拖动中已有 in-flight 与 140ms 节流保护；截图刷新已进入队列并取消过期刷新，后续再做更完整的缓存淘汰。
- [~] 更新使用说明：当前工作项和烟测文档已更新为 RemoteArtboardEditor 方案，后续还需要补一份面向 UI 人员的短使用说明。

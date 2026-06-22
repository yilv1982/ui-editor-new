# UIEditor-New 工作项说明

## 背景

`uieditor-new` 是从 `../UIEditor` 复制出的新实验工具工程，位于 `fact-source` 下，用于承接 UIEditor 下一阶段改造。原 UIEditor 已经可以读取 Dreamland 的 UI Prefab、贴图、字体和 UICommons 公共组件候选，也已验证过通过 Unity Editor 本地代理进行预览同步和临时 Prefab 增量写回。ai-native 仓库只记录本工具与 AI Native 路线之间的目标、边界和衔接。

现阶段需要重新收敛架构边界：浏览器内 Unity WebGL 不再作为真实 Prefab 环境和视觉真值来源。它无法直接访问 Unity Editor 的 `AssetDatabase`，也会继续带来字体、布局、Mask、图集、Shader 和运行时组件的同步差异。新的方向是让 Unity Editor Bridge 成为资产事实和视觉真值服务，Web 前端只负责编辑交互和待提交变更。

## 目标

建立一条截图式 UI 编辑链路：

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
  维护节点编辑模型和 patch
        |
        v
Unity Editor Bridge
  应用视觉字段 patch
  重新布局、重新截图、校验 diff
  按白名单保存回 Prefab
```

这条路线不在 Web 端拆分并拼接真实 UI 像素。真实视觉的拆分、布局计算、渲染和整体拼接都由 Unity Editor 完成；Web 只维护结构化编辑状态。

## 清理口径

本目录只保留新路线需要继续改造的源码、配置、脚本和当前工作项说明。复制自旧 UIEditor 的历史说明、旧 LOA 计划/规格、WebGL 构建产物、静态 `Part_*` 缩略图、临时图片、证书、本地结构样例、Jenkins 同步入口和运行日志不作为 `uieditor-new` 的依据。

如需回看旧资料，应回到原始来源或 ai-native 的过程性盘点，而不是把旧文档重新混入此目录。当前事实入口是本文件和后续为截图式编辑链路新增的文档。

## 当前基线

更新时间：2026-06-22。详见 `docs/baseline-smoke.md`。

- `npm run build` 已通过。
- Vite dev server 已在 `http://127.0.0.1:3105/` 完成烟测。
- `/api/prefabs/list` 可返回 1790 个 Prefab。
- `/api/components/list` 可返回 88 个 UICommons 组件候选。
- `/api/prefabs/parse?path=UICommons%2FUIBlueBtn.prefab` 可解析 `UIBlueBtn`。
- Unity 本地代理 `http://127.0.0.1:8081/health` 可返回 `UIEditorCorsProxy`。
- 当前页面仍会尝试加载已清理的旧 WebGL build，并报 `/unity/Build/unity.loader.js` 缺失；这是下一步替换主画布链路的输入，不应通过恢复旧 build 解决。

## 节点模型定义

Web 侧节点模型只表达可编辑结构，不表达真实渲染结果。首版至少包含：

- Unity 身份：`fileID`、Prefab 内路径、节点名、父子关系。
- 布局字段：anchor、pivot、anchoredPosition、sizeDelta、localScale、rotation。
- 组件摘要：Image、Text、Button、Mask、LayoutGroup、ContentSizeFitter 等存在性和关键视觉字段。
- 编辑边界：可编辑字段白名单、受保护字段、不可写原因。
- 截图定位：Unity 返回的屏幕空间 bbox，用于 Web 叠加层命中、框选和拖拽。
- Patch 状态：用户本轮修改的字段、来源操作、是否已由 Unity 回放确认。

## TODO

- [x] 复制后基线确认：在 `uieditor-new` 中执行依赖安装和本地启动，记录当前能跑通的页面、接口和失败项。记录见 `docs/baseline-smoke.md`。
- [x] 清理旧 WebGL 核心假设：盘点 `src/components/Canvas/UnityCanvas.tsx`、`StoreSync.ts` 和相关调用，把 WebGL 预览降级为可选模式或实验开关。依赖地图见 `docs/webgl-dependency-map.md`。
- [x] 定义 Unity Editor Bridge API：`openPrefab`、`renderSnapshot`、`exportNodeTree`、`applyVisualPatch`、`savePrefab`、`validateProtectedDiff`。API 草案和首批实现 TODO 见 `docs/unity-editor-bridge-api.md`。
- [ ] 实现 Editor 侧节点导出：从真实 Prefab 导出层级、fileID、RectTransform、组件摘要、保护字段和屏幕 bbox。
- [ ] 实现 Editor 侧整图截图：在固定 Canvas/分辨率下渲染完整 UI，返回图片和截图坐标系信息。
- [ ] 实现 Web 截图画布：底层显示 Unity 截图，上层叠加节点 hover、选中框、拖拽手柄、辅助线和多选框。
- [ ] 实现拖拽 patch 流程：拖动时先更新 Web 叠加层，松手后发送视觉字段 patch 给 Unity，等待 Unity 返回新截图和新 bbox。
- [ ] 建立视觉字段白名单：首版只允许 RectTransform、Text 视觉字段、Image sprite/color/material 视觉字段和 Button 可视状态字段。
- [ ] 建立保护字段审计：保存前确认 Lua/schema/items 绑定、脚本组件、非视觉组件、GUID/fileID 和事件接线没有被误改。
- [ ] 选低风险样本 Prefab 验证：导入、拖动、改文本、Unity 回放截图、保存副本、检查 git diff 和绑定保持。
- [ ] 增加截图缓存和节流策略：避免每次鼠标移动都请求 Unity 重渲染，只在松手或属性提交后刷新真值截图。
- [ ] 更新使用说明：说明新链路依赖 Unity Editor Bridge，不依赖浏览器内 WebGL 作为真值预览。

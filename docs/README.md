# UIEditor_new 文档入口

本目录承接 `UIEditor_new` 截图式受控视觉编辑链路的设计、接口、烟测和试点记录。工程总体说明见根目录 `README.md`。

## 文档索引

- `baseline-smoke.md`：构建、启动、接口和 Unity 本地代理基线烟测。
- `unity-editor-bridge-api.md`：Unity Editor Bridge HTTP API、数据结构、端点和 protected diff 约定。
- `client-bridge-isolation.md`：Bridge 命名空间、端口、session、临时目录和保存路径隔离约束。
- `editor-bridge-smoke.md`：独立 `18082` Unity Editor Bridge 后端闭环烟测记录。
- `web-overlay-smoke.md`：Web 截图叠加编辑层、属性面板和外部 headless 浏览器烟测记录。
- `npm run smoke:bridge-shell`：外部 Chromium/CDP 主界面烟测，覆盖画板/图层右键复制的 Bridge 临时 Prefab session 创建与清理，以及左侧工具栏 move/rect/scale/rotate 浏览器手柄拖拽后与 Unity RectTransform 导出结果一致。
- `npm run smoke:bridge-ops`：Unity Bridge API 烟测，覆盖基础控件创建、非默认 anchor/pivot 下的 move/resize/scale/rotate 几何字段、多节点 align/distribute move 顺序、Text 常用字段 patch、Image sprite/type/fill 字段、Button color block、Mask/RectMask2D、ScrollRect/Toggle、LayoutElement/HorizontalLayoutGroup/VerticalLayoutGroup/GridLayoutGroup/ContentSizeFitter 字段与子节点 Unity layout bbox 验证、Outline/Shadow 常用视觉字段 patch 与前后 Unity snapshot 像素差分、`Graphic.alpha`/`CanvasGroup.alpha` 透明度 patch、同 session 复制、跨 session 粘贴、真实 `UIAlert2.okBtn` 子树粘贴、组合、取消组合和临时 Prefab 清理；Bridge 运行到 `mvp-4` 后会强制校验复杂粘贴 protected diff、Text patch protected diff、容器透明度 protected diff、几何字段 protected diff、align/distribute protected diff 和视觉组件字段 protected diff。
- `npm run smoke:ngui-snapshot`：NGUI 截图烟测，默认样本 `DD_FP_HeroDisplay`，覆盖 NGUI profile、JPG 输出、bbox 有效性、重复渲染稳定性和 resume snapshot。
`npm run smoke:thumbnail-cache`：缩略图缓存烟测，验证临时 Prefab 路径不会被 GET/POST 缓存，避免左侧预览图被未保存编辑污染。
- `npm run smoke:thumbnail-render`：缩略图渲染烟测，直接通过 Unity Bridge readonly 渲染正式 Prefab，检查 content 裁剪框包含所有视觉 bbox、填充率足够且像素不为空白。
- `component-library-io-contract.md`：UI 公共组件库与 `UIEditor_new` 之间的输入/输出契约。
- `trial-samples.md`：试点 UI 样本的组件计划、受控编辑结果和规则沉淀。
- `ngui-rewrite-plan.md`：NGUI 支持完整重写方案（根因、常驻隔离实例生命周期、桥侧/前端改造、bbox 同源、延迟链路、实施步骤）。
- `ngui-isolation-change.md`：为根治 NGUI 渲染污染对客户端事实源 NGUI 源码（`UIDrawCall.cs`）的改动记录（原因、机制、改了哪、三重守卫、验证）。
- `ngui-interaction-todo.md`：NGUI 交互功能待办（属性面板 framework 分支、控件创建分支、拖动回填等 Step 7-8 细化清单）。

## 后续文档主题

- Unity Editor Bridge API 版本变更。
- Prefab 节点元数据、稳定 nodeId 和截图坐标系。
- Web 截图叠加编辑层交互细节。
- 视觉字段白名单与 protected diff 审计规则。
- 样本 Prefab 验证和性能记录。
- 面向 UI 使用者的短操作说明。

# UIEditor_new

`UIEditor_new` 是一个面向 Unity UI Prefab 的截图式受控视觉编辑工具。它把 Unity Editor 作为 Prefab 结构、组件字段、布局计算、截图渲染和保存校验的唯一事实来源；Web 前端负责提供画板、图层、属性面板、工具栏、拖拽手柄、标尺、辅助线、快捷键和组件入口。

用户在浏览器里看到的是可交互画板；底层实际发生的是：所有会改变 UI 的操作都会被转成 Bridge 指令，提交给 Unity Editor 中的临时 Prefab session，由 Unity 应用修改、渲染截图、导出 bbox、执行保护校验，并在保存时写回标准 Prefab 资产。

## 核心定位

本工程服务于这条 UI 编辑闭环：

```text
需求 / 组件计划
  -> 创建或打开画板
  -> Unity 创建临时 Prefab session
  -> Web 显示 Unity 截图和交互叠加层
  -> 用户或 Agent 发起受控视觉编辑
  -> Unity 回放修改并返回截图 / bbox / dirty
  -> 保存前执行 protected diff
  -> 写入目标 Prefab
  -> 沉淀样本、规则和组件使用经验
```

工程原则很明确：

- **Unity 是资产真值**：节点树、组件字段、布局结果、截图、bbox、dirty 状态和保存结果都以 Unity Editor Bridge 返回为准。
- **Web 是操作界面**：Web 负责交互体验、画板管理、面板输入和即时叠加反馈，不把本地状态当成 Prefab 内容保存。
- **Bridge 是保护边界**：任何真实修改都必须通过明确 API、字段白名单、revision 校验、操作队列和保存前 protected diff。
- **临时 Prefab 是编辑状态**：画板打开期间 Unity 侧临时工作对象持续存在；关闭画板时清理；浏览器刷新只恢复画板入口并重新读取 Unity 状态。

## 快速入口

| 入口 | 默认值 / 命令 | 用途 |
| --- | --- | --- |
| Web 开发服务 | `npm run dev` | 启动浏览器编辑界面。 |
| Web 地址 | `http://localhost:4105/` | 打开主界面。 |
| Unity Bridge | `http://127.0.0.1:18082` | Unity Editor 本地编辑服务。 |
| Bridge 健康检查 | `http://127.0.0.1:18082/health` | 确认 Unity 侧服务可用。 |
| 构建检查 | `npm run build` | TypeScript 和 Vite 构建验证。 |
| 主流程烟测 | `npm run smoke:bridge-web` | 验证 Web 与 Bridge 闭环。 |

Unity 侧 Bridge 代码位于 Unity 工程：

```text
../DreamlandProject/Assets/Editor/UIEditorNew/
```

Web 侧主界面、画布、面板、Bridge client 和画板 store 位于本工程：

```text
src/
```

## 功能范围

### 画板任务

一个画板对应一个 UI Prefab 编辑任务。

- 新建画板：创建一个新的临时 Prefab，首次保存时由用户输入 Prefab 名称和相对目录。
- 打开 Prefab：把项目 UI 拖到画板栏空白处，为现存 Prefab 创建编辑画板；同一个来源 Prefab 同时只允许打开一次，再次打开会切回已有画板并提示“已有同名 UI 被打开”。
- 插入 Prefab：把项目 UI 拖到画板栏里的某个画板根节点，或拖到编辑区的画板内，它会成为该画板里的普通子节点，不再关联原 Prefab。
- 保存与另存为：现存 UI 的“保存”默认写回当前来源路径；新建 UI 首次保存会要求输入 Prefab 名称和相对目录；“另存为”始终要求输入新路径，并把当前画板切换为新保存路径的编辑任务。
- 刷新恢复：浏览器刷新后，Web 只恢复画板列表和临时 Prefab 路径，再向 Bridge 读取最新 Unity 状态。
- 关闭画板：关闭前确认未保存修改，随后释放 session 并删除临时工作对象。

### 截图式画布

画布显示 Unity 渲染出的当前 UI 截图，并在截图上叠加 Web 交互层：

- bbox、选中框、变换手柄。
- 标尺、辅助线、测量线、批注层。
- 拖动、缩放、旋转、框选、多选。
- 视口平移、缩放和画板切换。

截图和 bbox 必须来自同一次 Unity 状态，避免用户看到的画面和可点击区域错位。

### 图层与节点操作

图层树展示 Unity 返回的节点结构，并通过 Bridge 修改真实 Prefab：

- 选中、重命名、显隐、删除。
- 调整 sibling 顺序和父子关系。
- 复制、粘贴、组合、取消组合。
- 撤销、重做和常用快捷键。

Web 可以维护锁定、选中、展开折叠等交互状态；只要会改变 Prefab，必须走 Bridge 指令。

### 属性面板

属性面板只暴露视觉编辑白名单字段：

- RectTransform：位置、尺寸、旋转、缩放。
- Text：文本内容、字号、颜色、字体引用。
- Image：图片引用、颜色、图片类型、九宫格相关引用。
- Graphic / CanvasGroup：透明度。
- GameObject：显隐状态。
- Layout / Mask / Scroll / Toggle / Button 等常用 UI 视觉组件字段。

脚本引用、事件接线、Lua/schema 绑定、业务数据字段和非白名单组件结构不作为普通编辑项暴露。

### 当前可编辑控件与字段

当前主流程面向 UGUI 常用视觉编辑，不面向程序接线编辑。

已支持创建或插入：

- Frame / 空容器。
- Text。
- Image。
- RawImage。
- Button。
- Toggle。
- ScrollView。
- InputField。
- 现有 UI Prefab / 组件 Prefab：可插入到画板或指定节点下。

已支持修改的常用字段：

- 节点：名称、显示 / 隐藏、删除、复制 / 粘贴、编组 / 解组、层级重排、改父节点。
- 变换：X、Y、W、H、旋转、缩放、锚点、Pivot。
- Text：文本、富文本、字体、字号、颜色、样式、对齐、溢出、行距、Best Fit、Raycast。
- Image：图片引用、颜色、透明度、显示图像、Raycast、Image Type、Fill、Preserve Aspect、Use Sprite Mesh、Set Native Size。
- Button：Interactable、Transition、ColorBlock 的 normal / highlighted / pressed / disabled、colorMultiplier、fadeDuration。
- Toggle：Interactable、初始 isOn。
- ScrollRect：水平 / 垂直滚动开关。
- Mask / RectMask2D：启用、类型、showGraphic。
- Layout：LayoutElement、HorizontalLayoutGroup、VerticalLayoutGroup、GridLayoutGroup、ContentSizeFitter。
- 效果：Graphic Outline、Text Outline、Text Shadow。
- 容器透明度：没有 Graphic 的容器使用 CanvasGroup alpha。

目前隐藏或只读的常用项：

- Button 上是否新增 / 移除 Image 组件：组件结构变更不在普通视觉字段契约内，当前只读。
- Image mirror 镜像类型：尚未确认 Unity 字段契约。
- Text Gradient：尚未确认项目内对应组件和字段映射。
- 九宫格 Sprite border 数值编辑：更接近图片 import 设置，不作为普通 Prefab 字段开放。
- 泛背景色：不使用 Web 式 background；必须落到具体 Image、Text、RawImage 或 CanvasGroup 字段。
- Button / Toggle / Input 等事件、LuaBehaviour、脚本字段、schema 或业务绑定字段：受保护，不在 UI 人员编辑范围内。

后续优先补强方向：

- InputField 详细字段。
- Slider。
- Dropdown。
- Animator / 特效引用。
- 项目自定义 UI 组件的安全字段白名单。

### 组件与 Prefab 入口

工程支持把基础控件、公共组件和现存 Prefab 作为编辑素材插入当前画板：

- 基础控件由 Bridge 创建 Unity 节点。
- 公共组件通过组件库契约转换成插入和 patch 指令。
- 现存 Prefab 插入后归属于当前画板，保存时只影响当前画板目标 Prefab。

### Prefab 缩略图

左侧 Prefab 预览图由 Unity Editor Bridge 只读渲染生成。

- 缩略图基于已保存 Prefab 生成，不读取临时编辑工作对象。
- 裁剪逻辑以 Unity bbox 为准，尽量展示完整可见内容，减少空白区域。
- 只有正式保存后的 Prefab 状态变化才刷新缩略图缓存。

## 底层架构

```text
Web 交互层
  画板栏、图层树、属性面板、工具栏、截图叠加层、快捷键、组件入口

Bridge 同步层
  HTTP client、画板 store、操作队列、节流、防乱序、revision、恢复入口

Unity 编辑层
  临时 Prefab session、真实组件修改、布局计算、截图渲染、bbox 导出、保存校验
```

### Web 交互层

Web 负责让用户可以高效操作：

- 管理画板列表、当前选区、视口、工具模式和面板输入草稿。
- 把拖拽、缩放、文本输入、图片选择、层级调整等动作转成明确 Bridge 命令。
- 对高频拖动提供本地叠加反馈，降低体感延迟。
- 根据 Bridge 返回的 revision、snapshot、bbox、节点摘要和 dirty 状态更新界面。

### Bridge 同步层

Bridge 同步层负责把 Web 操作变成可控、可串行、可回放的 Unity 编辑请求：

- 同一个 session 内操作串行提交，避免并发返回乱序覆盖。
- 每次响应携带 revision，Web 只接受不落后的结果。
- 高频操作支持节流和轻量返回，操作结束后再补 Unity 真值截图。
- 保存、关闭和 protected diff 前会强制 flush 临时状态。

### Unity 编辑层

Unity 侧负责所有 Prefab 事实：

- 创建、打开、恢复和关闭临时 Prefab session。
- 维护节点稳定 id、revision、dirty、undo/redo 和临时工作对象。
- 应用 move、resize、text、image、visible、reparent、insert、delete 等编辑命令。
- 渲染当前截图并导出同帧 bbox、节点树和组件摘要。
- 保存前执行 protected diff，并写入目标 Prefab。

## 关键流程

### 1. 创建或打开画板

```text
Web 发起 create-blank-artboard / open-prefab / resume-session
  -> Bridge 创建或恢复 session
  -> Unity 准备临时 Prefab working root
  -> Bridge 导出节点树、组件摘要、首帧截图和 bbox
  -> Web 建立画板状态并显示可交互画布
```

### 2. 普通编辑

```text
用户拖动、缩放、改文本、换图片、调显隐或改层级
  -> Web 生成精确指令，如 move-node / resize-node / set-text
  -> 指令进入当前画板操作队列
  -> Bridge 校验 session、nodeId、revision 和字段白名单
  -> Unity 修改临时 Prefab working root
  -> Bridge 返回 revision、dirty、bbox、节点摘要和可选截图
  -> Web 更新画面叠加层、图层树和属性面板
```

常用 Bridge 操作包括：

```text
moveNode(nodeId, x, y)
resizeNode(nodeId, width, height)
setText(nodeId, text)
setTextStyle(nodeId, style)
setImage(nodeId, spritePath)
setVisible(nodeId, visible)
reparentNode(nodeId, parentId, siblingIndex)
insertPrefab(sessionId, prefabPath, parentId)
deleteNode(nodeId)
undoArtboard(sessionId)
redoArtboard(sessionId)
saveArtboard(sessionId, targetPrefabPath)
```

### 3. 高频拖拽

```text
pointer move
  -> Web 更新本地叠加层，保证拖动手感
  -> 节流提交 move-node / resize-node，通常跳过完整截图
  -> Unity 快速更新内存 working root 并返回轻量结果
  -> Web 根据 revision 丢弃过期响应
  -> pointer up 后触发低优先级 snapshot 回填
```

这个流程把“手感反馈”和“Unity 真值截图”拆开处理。拖动时优先保证 200ms 内的体感反馈，最终画面仍由 Unity snapshot 回填闭合。

### 4. 保存

```text
用户点击保存
  -> Web 提交 saveArtboard(sessionId, targetPrefabPath)
  -> Bridge flush 临时 Prefab 状态
  -> Bridge 执行 protected diff
  -> 只包含允许字段：写入目标 Prefab
  -> 命中保护字段：拒绝保存，Web 显示简化错误，详细信息写入开发日志
  -> 保存成功后刷新画板 dirty 状态和正式 Prefab 缩略图缓存
```

新建 UI 首次保存时，用户需要输入 Prefab 名称和相对目录。默认目录为：

```text
Assets/HotRes2/UIs/Prefabs
```

另存为也使用同一套路径输入规则。另存成功后，当前画板的来源路径会变成新的 Prefab 路径，后续普通保存写回这个新路径。

### 5. 浏览器刷新恢复

```text
Web 本地保存画板列表和临时 Prefab 路径
  -> 浏览器刷新
  -> Web 对每个未关闭画板调用 resume-session
  -> Bridge 重新读取临时 Prefab
  -> Unity 导出当前截图、bbox、节点树和 dirty 状态
  -> Web 恢复画板栏、选区、视口和属性面板
```

Web 不恢复 Prefab 内部完整内容；它只恢复“这个画板对应哪个 Unity 临时工作对象”。

### 6. 关闭画板

```text
用户关闭画板
  -> Web 确认是否丢弃未保存修改
  -> Web 调用 close-prefab
  -> Bridge 释放 session 并删除临时工作对象
  -> Web 移除本地恢复入口
```

关闭画板是临时 Prefab 的生命周期边界。浏览器刷新不会清理临时 Prefab。

## 保护边界

允许保存的典型视觉字段：

- `RectTransform.anchoredPosition`
- `RectTransform.sizeDelta`
- `RectTransform.localScale`
- `RectTransform.localEulerAngles.z`
- `GameObject.activeSelf`
- `Text.text`
- `Text.fontSize`
- `Text.color`
- `Text.font`
- `Image.sprite`
- `Image.color`
- `Graphic.alpha`
- 可映射到视觉效果的常用 UI 组件字段

必须保护的内容：

- `MonoBehaviour.m_Script`
- Button、Toggle、Input 等事件接线。
- Lua/schema/items/data binding 字段。
- PrefabInstance 来源关系。
- GameObject fileID 和关键对象身份。
- 非白名单组件增删。
- 非目标节点的程序字段变更。

protected diff 对用户只暴露简化失败原因；完整差异用于开发排查。

## 工程结构

```text
UIEditor_new/
  src/
    components/        主界面、画布、面板、缩略图和工具入口
    services/          Bridge client、画板 store、同步队列和调试桥
    plugins/           Prefab、图集、Unity Bridge、保存和调试 Vite 插件
    stores/            前端交互状态
    types/             Web 与 Bridge 共享的数据类型
    utils/             坐标、截图、缓存、快捷键和导出工具
  docs/                Bridge API、组件库契约、烟测和样本记录
  scripts/             Bridge、Web shell、缩略图和视觉烟测脚本
  public/              Web 静态资源
```

## 主要源码入口

| 文件 | 作用 |
| --- | --- |
| `src/App.tsx` | 主界面、画板入口、快捷键和整体布局。 |
| `src/components/Canvas/BridgeMainCanvas.tsx` | 主画布。Unity Editor Bridge 截图底图、bbox 命中、选区、标尺、辅助线、测量和批注层。 |
| `src/components/Canvas/SceneToolbar.tsx` | 左侧画布工具栏。 |
| `src/components/Panels/LayerPanel.tsx` | 画板列表、节点树、图层操作和右键菜单。 |
| `src/components/Panels/PropertyPanel.tsx` | 白名单视觉字段编辑。 |
| `src/components/Panels/TemplateLibrary.tsx` | Prefab、基础控件和组件模板入口。 |
| `src/components/Panels/PrefabThumbnail.tsx` | Unity readonly 缩略图渲染、裁剪和缓存。 |
| `src/services/EditorBridgeClient.ts` | Unity Editor Bridge HTTP client。 |
| `src/services/BridgeArtboardStore.ts` | 画板状态、Bridge session、操作队列和刷新恢复。 |
| `src/services/RuntimeDebugBridge.ts` | 浏览器烟测和调试辅助接口。 |
| `src/plugins/prefabServer.ts` | Prefab、组件和资源查询接口。 |

## Bridge API 概览

默认地址：

```text
http://127.0.0.1:18082
```

核心端点：

| Endpoint | 用途 |
| --- | --- |
| `GET /health` | 检查 Bridge 是否可用。 |
| `POST /create-blank-artboard` | 创建新 UI 画板。 |
| `POST /open-prefab` | 打开现存 Prefab 并创建 session。 |
| `POST /resume-session` | 浏览器刷新后恢复画板 session。 |
| `POST /export-node-tree` | 导出节点树和组件摘要。 |
| `POST /render-snapshot` | 渲染 Unity 真值截图和同帧 bbox。 |
| `POST /move-node` | 设置节点位置。 |
| `POST /resize-node` | 设置节点尺寸。 |
| `POST /set-text` | 修改文本内容。 |
| `POST /set-text-style` | 修改文本样式。 |
| `POST /set-image` | 修改图片引用。 |
| `POST /set-visible` | 修改节点显隐。 |
| `POST /reparent-node` | 调整父节点或层级顺序。 |
| `POST /insert-prefab` | 将 Prefab 插入当前画板。 |
| `POST /create-text-node` | 新增文本节点。 |
| `POST /create-image-node` | 新增图片节点。 |
| `POST /create-widget-node` | 新增基础控件节点。 |
| `POST /duplicate-nodes` | 复制节点。 |
| `POST /copy-nodes-to-session` | 跨画板复制 Unity 节点子树。 |
| `POST /group-nodes` | 组合节点。 |
| `POST /ungroup-nodes` | 取消组合。 |
| `POST /delete-node` | 删除节点。 |
| `POST /undo-artboard` | 撤销。 |
| `POST /redo-artboard` | 重做。 |
| `POST /save-artboard` | 保存画板。 |
| `POST /close-prefab` | 关闭 session 并清理临时对象。 |

完整 API 见 `docs/unity-editor-bridge-api.md`。

## 本地运行

### 前置条件

- Unity 工程已打开，并能编译 `Assets/Editor/UIEditorNew/` 下的 Editor Bridge。
- Bridge 监听端口默认为 `18082`。
- Web 开发服务监听端口默认为 `4105`。
- Node 依赖已安装。
- 需要编辑或保存的 Prefab 位于 Unity 工程可访问路径下。

### 启动 Unity Bridge

在 Unity Editor 中启动 UIEditorNew Bridge。启动后检查：

```text
http://127.0.0.1:18082/health
```

### 启动 Web

```bash
npm run dev
```

默认访问：

```text
http://localhost:4105/
```

### 构建和烟测

```bash
npm run build
npm run smoke:bridge-web
npm run smoke:bridge-shell
npm run smoke:bridge-ops
npm run smoke:thumbnail-cache
npm run smoke:thumbnail-render
```

烟测职责：

- `smoke:bridge-web`：验证 Web 与 Bridge 主流程。
- `smoke:bridge-shell`：验证主界面、画板上下文、图层操作、左侧工具栏和浏览器手势。
- `smoke:bridge-ops`：验证 Bridge API、视觉字段 patch、复制粘贴、组合、撤销重做、protected diff 和临时 Prefab 清理。
- `smoke:thumbnail-cache`：验证缩略图缓存不接受临时工作路径。
- `smoke:thumbnail-render`：验证 Unity readonly 缩略图渲染、裁剪和非空内容。

## 验收口径

主流程验证应覆盖：

- 新建空画板，插入基础控件，修改位置、尺寸、文本、字体和图片，保存为新 Prefab。
- 打开现存 Prefab，修改后保存回来源路径。
- 将现存 Prefab 拖入编辑区，作为普通子节点插入当前画板。
- 拖动、缩放、旋转、框选、多选、显隐、层级调整、删除、复制、组合、撤销和重做。
- 浏览器刷新后恢复未关闭画板，并继续编辑和保存。
- 关闭画板后确认临时工作对象被清理。
- 保存后重新由 Unity Editor 渲染截图，确认视觉结果一致。
- protected diff 不允许程序字段、事件接线、绑定字段或 Prefab 来源关系被误改。
- 高频操作的用户体感反馈控制在 200ms 以内，请求不堆积、不乱序覆盖。

## 开发约束

- 任何会改变 UI Prefab 的操作都必须通过 Bridge 指令提交。
- Web 可以维护交互草稿和乐观叠加层，但不能把本地状态当作最终 Prefab 事实。
- 新增属性面板字段前，必须先确认 Unity Bridge 支持该字段，且 protected diff 白名单允许保存。
- 高频操作需要使用队列、节流、revision 校验和过期响应丢弃。
- 缩略图只从已保存 Prefab 的 readonly 渲染生成，不能被临时工作 Prefab 的实时编辑污染。
- 保存失败时，用户界面只展示可理解原因；完整差异和异常信息进入开发日志。

## 排障线索

### Web 无法连接 Bridge

- 检查 Unity Bridge 是否启动。
- 打开 `http://127.0.0.1:18082/health`，确认返回可用状态。
- 确认端口没有被其他进程占用。

### 点击操作后画面不更新

- 检查浏览器控制台中的 Bridge 请求是否返回成功。
- 检查返回 `revision` 是否小于当前画板 revision，过期响应会被 Web 丢弃。
- 检查该操作是否跳过了完整截图，高频操作结束后应触发一次 snapshot 回填。

### 保存失败

- 优先看 Web 显示的简化错误。
- 再看 Unity Editor 日志中的 protected diff 详情。
- 如果命中了保护字段，需要调整 Bridge 命令、字段映射或白名单。

### 缩略图不刷新

- 缩略图只在正式保存成功后刷新。
- 临时工作路径会被缩略图缓存拒绝。
- 如果保存成功但缩略图仍未变化，检查 readonly 渲染请求和磁盘缓存是否命中。

## 关键文档

- `docs/README.md`：文档索引。
- `docs/unity-editor-bridge-api.md`：Bridge API、数据结构、端点和 protected diff 约定。
- `docs/component-library-io-contract.md`：UI 公共组件库与编辑器之间的输入输出契约。
- `docs/client-bridge-isolation.md`：Bridge 命名空间、端口、session、临时目录和保存路径隔离约束。
- `docs/editor-bridge-smoke.md`：Unity Editor Bridge 闭环烟测记录。
- `docs/web-overlay-smoke.md`：Web 截图叠加层和属性面板烟测记录。
- `docs/trial-samples.md`：试点 UI 样本、编辑结果和规则沉淀。

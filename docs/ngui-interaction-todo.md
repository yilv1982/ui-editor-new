# NGUI 交互功能待办

更新时间：2026-06-25。

本文件是 `ngui-rewrite-plan.md` Step 7-8 的细化执行清单，聚焦 NGUI 的属性面板、控件创建和其他交互缺口。背景：桥侧（C#）NGUI 字段读写、bbox、截图、常驻渲染已基本完成；前端属性面板没有 NGUI 分支，控件创建只建 UGUI，二者错位导致 NGUI 节点选了没法改、NGUI 画板上建不出 NGUI 控件。

## 现状结论

- 桥侧 `NguiSupport.cs` 已实现 `ApplyNgui*Operation` / `ReadNgui*FieldAsString` / `BuildNgui*Summary`，覆盖 UILabel/UISprite/UIWidget/UIButton/UITexture 常用字段，field 名用 UGUI 风格（`Text.text`/`Image.sprite`/`Button.interactable`）路由。
- store 有**画板级** framework（`bridgeFramework`，来自 `session.framework`），节点级靠 `hasComponent('UILabel'/'UISprite'/...)` 判定组件类型。
- `types/index.ts` 只有 `bridgeFramework`，**没有** node 级 `framework` 字段。
- `PropertyPanel.tsx` **完全没有** framework/NGUI 分支。
- 桥侧 `CreateTextNode`/`CreateWidgetNode` 全部建 UGUI 组件（`AddComponent<Text>`/`<Image>`/`<Button>`），无 NGUI 分支。
- 缩略图/模板库/组件库不分 framework。

## P0：属性面板 NGUI 分支

### 节点级 framework 标记

- `types/index.ts`：`UINode` 增 `framework?: 'ngui' | 'ugui'`。
- `BridgeArtboardStore.mapBridgeNode`：由 `hasComponent(node, 'UIWidget'|'UILabel'|'UISprite'|'UITexture'|'UI2DSprite'|'UIPanel'|'UIRoot')` 逐节点判定 framework。工具同时支持 UGUI 和 NGUI，但同一个 prefab 不会两种混着出现，无需处理 mixed 画板。
- 注意 NGUI `UISprite.type` 多一个 `Advanced`，与 UGUI `Image.type` 语义不同。

### PropertyPanel 按框架分支

- 抽出 `<UguiPropertySections>`（现有内容平移）+ 新建 `<NguiPropertySections>`。
- Transform 区块共用，放分支之上。
- 顶层按 `node.framework` 分支：UGUI 节点显 UGUI 字段，NGUI 节点显 NGUI 字段。

### NGUI 字段 → 桥 field / 端点

复用现有 `apply-visual-patch` / `set-text` / `set-image`，不新增 HTTP 端点。桥侧 `ApplyNgui*Operation` 已用 UGUI 风格 field 名路由。

| 组件 | 字段 | 写入 field / 端点 | 桥侧 Apply | 桥侧 Read | 前端入口 |
| --- | --- | --- | --- | --- | --- |
| UIWidget | width/height | `rectTransform.sizeDelta` | ✅ | ✅ | ❌ 缺 |
| | color/alpha/enabled | `Image.color`/`Image.enabled` | ✅ | ✅ | ❌ 缺 |
| | depth ⚠️ | `Widget.depth` | ❌ 缺 | ✅ summary | ❌ 缺 |
| | pivot ⚠️ | `Widget.pivot` | ❌ 缺 | ✅ summary | ❌ 缺 |
| UISprite | spriteName | `Image.sprite`/`set-image` | ✅ | ✅ | ❌ 缺 |
| | type(含 Advanced) | `Image.type` | ✅ | ✅ | ❌ 缺 |
| | fillCenter/fillMethod/fillAmount | `Image.fillCenter`/`fillMethod`/`fillAmount` | ✅ | ✅ | ❌ 缺 |
| UILabel | text | `Text.text`/`set-text` | ✅ | ✅ | ❌ 缺 |
| | fontSize/fontStyle/alignment/color/richText | `Text.*` | ✅ | ✅ | ❌ 缺 |
| | overflow ⚠️ | `Text.overflow` | ❌ 缺 | ❌ 缺 | ❌ 缺 |
| UITexture | mainTexture/color | 只读 / `Image.color` | 部分 | 部分 | ❌ 缺 |
| UIButton | interactable/normal/hover/pressed/disabled sprite | `Button.interactable`/`Button.normalSprite` 等 | ✅ | ✅ | ❌ 缺 |

⚠️ 标记的 `Widget.depth`、`Widget.pivot`、`Text.overflow` **桥侧也还没实现 Apply（Read 也部分缺）**，不只是前端问题，需桥+前端一起补：
- `Widget.depth`：`SetReflectedProperty(widget, "depth", int)` + `MarkAsChanged`。
- `Widget.pivot`：`UIWidget.Pivot` 枚举（9 宫格→枚举）。
- `Text.overflow`：`SetReflectedEnum(label, "overflowMethod", int)`；summary 加 `overflowMethod`。

## P0：控件创建按 framework 分支

- 桥侧 `CreateTextNode` / `CreateWidgetNode` 按 `session.framework` 分支：NGUI 画板建 `UILabel`/`UISprite`/`UIButton`（需挂 UIPanel/UIRoot 上下文）。
- 或至少：NGUI 画板上禁止建 UGUI 控件，返回明确错误，避免混入破坏单路由。
- 当前 `CreateWidgetNode`（UIEditorNewBridgeCore.cs:713）和 `BuildButtonWidget`/`BuildTextGraphic` 等（:2165-2250）全是 UGUI。

## P1：拖动节流真值回填 + 防乱序（plan Step 8）

- 现状：拖动已有乐观覆盖层（`dragRef`+`setDragPreview`，BridgeMainCanvas.tsx:1062-1066），松手才拉一次真值截图；`skipSnapshot` 已贯通。
- 缺：拖动中的节流真值回填。
- 改法：
  - `onPointerMove` 更新乐观 `dragPreview` 同时，节流 120–150ms 发一次带 snapshot 的 `moveNode` 回填；松手发最终一次。
  - `ignoreNextNodeSyncRef` 沿用避免回填覆盖正在拖动的本地值；收到 ≥ 该请求 revision 的回填后清零 `dragPreview`。
  - 防乱序：`renderSnapshot`/`moveNode`/`resizeNode`（EditorBridgeClient.ts:338,421,425）增 `options.signal` 透传 `fetch(..., {signal})`；拖动每次发新回填前 `abort()` 上一个未完成请求；再加单调 `requestSeq`，处理回填时丢弃 `seq < latestSeq`。
- NGUI 常驻实例渲染成本高于 UGUI，这条对 NGUI 体感影响更大。

## P2：其他交互缺口

- **缩略图 / 模板库 / 组件库 framework 标注**：组件库标注 framework，NGUI 组件用 NGUI 方式插入；模板库预览对 NGUI Prefab 适配。当前 `PrefabThumbnail`/`TemplateLibrary`/`ComponentLibrary` 不分 framework。
- **NGUI 字段只读提示**：哪些字段受保护不可改，前端没提示。
- **depth 层级面板适配**：NGUI 用 depth 而非 sibling index 控制层叠，层级面板"上移/下移"对 NGUI 节点语义不同，需适配。

## 优先级总览

| 优先级 | 工作 | 理由 |
| --- | --- | --- |
| P0 | PropertyPanel 加 framework 分支 + NGUI 属性栏（UILabel/UISprite/UIWidget 基础字段） | 桥侧已支持，纯前端补 UI，NGUI 节点现在选了没法改 |
| P0 | 桥侧补 `Widget.depth`/`Widget.pivot`/`Text.overflow` 的 Apply + Read | NGUI 核心视觉字段，桥+前端都要补 |
| P1 | 控件创建按 framework 分支，NGUI 画板建 NGUI 控件或拒绝 UGUI | 避免在 NGUI 画板建出 UGUI 节点 |
| P1 | 拖动节流真值回填 + abort（Step 8） | NGUI 常驻渲染成本高，拖动手感差 |
| P2 | 缩略图/组件库 framework 标注 | 体验问题，不阻断编辑 |
| P2 | depth 层级面板适配、只读提示 | 已知缺口，样本未覆盖 |

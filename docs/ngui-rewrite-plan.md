# UIEditor_new NGUI 支持重写方案

更新时间：2026-06-24。

本文件是 `UIEditor_new` 针对 NGUI 支持的完整重写方案（可执行）。NGUI 隔离的源码改动单独记录在 `ngui-isolation-change.md`。

## 背景：要解决的五个问题

`UIEditor_new` 是截图式受控视觉编辑器，最初按 UGUI 设计，后续硬塞 NGUI 支持，导致：

1. **代码臃肿**：`UIEditorNewBridgeCore.NguiSupport.cs` 1678 行里约 55% 是"挂起渲染/恢复/清 drawcall/捕获恢复全局静态状态"的反复打补丁代码。
2. **渲染污染主工程**：编辑/截图 NGUI 实例污染主工程 Scene/Game View——元素叠加、拖动一个元素时主工程跟着动。
3. **bbox 逻辑错**：截图与 bbox 不是同一实例/同一相机算出来的，框线与截图错位。
4. **属性栏不兼容**：`PropertyPanel.tsx` 773–1398 行字段名、类型枚举、区块标题全写死 UGUI，NGUI 进来显示错乱或缺失。
5. **交互延迟高**：每次编辑热路径触发 `Resources.FindObjectsOfTypeAll` 三重全编辑器扫描。

## 根因（一个病根，连带多个问题）

- NGUI 的 `UIPanel/UIWidget/UICamera` 都是 `[ExecuteInEditMode]`，渲染靠全局静态表（`UIPanel.list` UIPanel.cs:21、`UIDrawCall.mActiveList` UIDrawCall.cs:20-21）+ layer 命中的任意相机驱动，与 Unity Scene 边界无关。
- working root 已被移进 session 私有 PreviewScene（UIEditorNewBridgeCore.cs:1378），但 ① NGUI 组件被全程 `enabled=false` 挂起（从不真正渲染）；② 截图时另起 `PreviewRenderUtility` 新 `Instantiate` 一份（NguiAdapter.cs:78），渲染产生的 `UIDrawCall` 是独立 new 的隐藏 GameObject（UIDrawCall.cs:997-1010），**落在 active scene**被主工程相机渲染 → 污染。
- 旧修法在 NGUI 外面打地鼠（suspend/cleanup/静态状态捕获恢复），漏一帧就闪，治不彻底，且把扫描压在热路径上 → 臃肿 + 延迟。

## 破局事实

`UIDrawCall.cs:948-973` 的 `Create` 已内建场景隔离雏形（PrefabStage 下新建 drawcall 会 `MoveGameObjectToScene` 到 stage 场景，UIDrawCall.cs:960-970，且 `dc.manager=panel` 已在 move 前赋值）。把"出生即归位"推广到"drawcall 跟随 manager 所在 scene"，即可让常驻隔离场景里的编辑实例其 drawcall 不溢出主场景——机制级根治，详见 `ngui-isolation-change.md`。

## 已定方向

1. 范围：桥侧 C# + 前端 NGUI 全链路一起重写。
2. UGUI 保留并正经支持，NGUI/UGUI 各自一套干净实现，不再互相硬套。
3. 落地：在现有 UIEditorNew 文件上原地重构，Git 历史连续。
4. 隔离强度：编辑和渲染都在用户看不到的地方，主工程一帧都不受影响。
5. 实时预览：拖动用 web 乐观覆盖层 + 节流推送真值截图回填。
6. 属性栏：NGUI 属性栏完整重做，与 UGUI 按节点组件分支。
7. NGUI 源码：改源码让 drawcall 出生即归位（不走"现成 API 事后补救"的打地鼠老路）。

## 目标生命周期（NGUI 常驻隔离实例）

```
open/resume → GetWorkingRoot:
  LoadPrefabContents → hideFlags=HideAndDontSave → MoveRootToScene(previewScene)
  [NGUI adapter.PrepareWorkingRoot] EnableAndPrimeNgui(root): 整树进 CaptureLayer(31),
     NGUI 组件全部 enabled=true, EnsureSessionNguiCamera 建常驻离屏相机, 触发首帧 LateUpdate
edit (move/resize/set-*): 直接改常驻 root 组件/transform; NGUI [ExecuteInEditMode] 自动重建
     drawcall(因源码改动落进 previewScene); AfterEditApplied → no-op
snapshot: 复用常驻 root + 常驻相机; MarkChanged + LateUpdate + camera.Render()→RT→ReadPixels;
     bbox 用同一相机同一 root 投影(同源对齐)
undo/redo: clone 后立刻 SetActive(false) 冻结(NGUI OnDisable 自动销毁 drawcall),恢复时 SetActive(true)
close: DestroyWorkingRoot + 销毁 nguiCamera + CloseSessionPreviewScene(带走场景内全部 drawcall)
```

UGUI 路径完全不动（UguiAdapter 每次截图自建临时实例渲染再销毁，不依赖任何被删的 NGUI 函数）。

## 桥侧 C# 重构

**NguiSupport.cs（1678 → 1145 行，已完成）**
- 删：静态状态捕获恢复（329-492,1187-1345）、运行时对象清理（499-1047）、suspend 机器（513-530,662-811）、`BuildRuntimeCleanupReport`（532-660）；`ForceNguiRefresh`（256-327）瘦身为 `MarkAsChanged` + 一次 `UIPanel.LateUpdate`。
- 保留并扩展：框架识别、bbox 链（132-242）、属性读写 `BuildNgui*Summary`/`ApplyNgui*Operation`/`ReadNgui*FieldAsString`（1369-1658）；原 `GetEffectiveBehaviourEnabled` 调用点改直接 `behaviour.enabled`。
- 新增：`EnsureSessionNguiCamera`（previewScene 内常驻离屏相机，cullingMask=`1<<CaptureLayer`，orthographic）、`EnableAndPrimeNgui`（整树进 CaptureLayer + NGUI 组件 enabled + 首帧 LateUpdate）。

**NguiAdapter.cs（301 → 约 120 行）**
- `PrepareWorkingRoot`：`SuspendNguiRendering` → `EnableAndPrimeNgui` + `EnsureSessionNguiCamera`。
- `AfterEditApplied`：`CleanupNguiRuntimeObjects` → no-op。
- `RenderSnapshot` 重写为复用常驻实例 + 常驻相机：删 PreviewRenderUtility/Instantiate/静态状态捕获恢复/全部 cleanup；`camera.Render()→RT→ReadPixels→EncodeToJPG`（与 UGUI 统一）；nodeId 用常驻 root 直接 `BuildNodeIdByTransform`。

**UIEditorNewBridgeCore.cs**
- `SessionState` 增 `Camera nguiCamera`；删 `suspendedNguiBehaviourStates` 及引用。
- `CloneWorkingRoot`（1383-1395）：clone 后立刻 `SetActive(false)` 冻结。
- `PopUndo`/`Redo`（955-982）+ `ReplaceWorkingRoot`（1397-1409）：恢复快照 `SetActive(true)`+`EnableAndPrimeNgui`，被替换 current `SetActive(false)` 入栈。
- `EnsureSessionNguiCamera`/`SetLayerRecursive` 只在 NGUI adapter 的 PrepareWorkingRoot 调，不提到框架无关的 `GetWorkingRoot` 主干。

**UIEditorNewBridgeServer.cs**
- 重写 `CleanupBridgeRuntimeState`：遍历 Sessions 调 `CloseSessionPreviewScene` + 销毁 `nguiCamera` + `CleanupBridgeOwnedSceneObjects` 兜底；`beforeAssemblyReload` 必须关所有 PreviewScene。
- `/cleanup-runtime-state` 改返回 PreviewScene 计数等轻量信息。

## 热路径延迟消除

`ApplyOperationsAndReturnState`/`MutatePrefabAndReturnState`/`BuildArtboardResponseJson`（1175,1205,1228）每次 `AfterEditAppliedForFramework`：NGUI 改 no-op 后，move-node 热路径不再有三次 `Resources.FindObjectsOfTypeAll`。截图从"建实例+刷新+PreviewRenderUtility new/Cleanup"降为"MarkChanged + LateUpdate + Render + ReadPixels"。

## bbox 同源对齐

- 截图与 bbox 用同一 `session.nguiCamera` + 同一常驻 `root`：bbox 走 `CollectNguiBboxes`→`CalculateNguiCaptureRect`→`CollectNguiWorldCorners`（读 `UIWidget.worldCorners`，纯 transform、不依赖相机）→`WorldToCapturePoint`（正交手算，206-222）。截图与投影同一 `aspect=(float)w/h`，必然对齐。
- 坐标体系：两边都 `coordinateSpace="top-left-pixel"`、bbox `space="snapshot-pixel"`；前端 `BridgeMainCanvas` 统一消费 box.x/y/w/h，不分框架。
- 截图格式统一 JPEG：NGUI 的 `EncodeToPNG`（NguiAdapter.cs:184）改 `EncodeToJPG`、文件名 `.jpg`、背景改不透明实色。

## 前端属性栏按框架分支

- `types/index.ts`：`UINode` 增 `framework?: 'ngui' | 'ugui'`。
- `BridgeArtboardStore.ts` `mapBridgeNode`（117-268）：由 `hasComponent(node, 'UIWidget'|'UILabel'|'UISprite'|'UITexture'|'UI2DSprite'|'UIPanel'|'UIRoot')` 判定 framework（节点级，mixed 画板逐节点正确）。注意 NGUI `UISprite.type` 多一个 `Advanced`，与 UGUI `Image.type` 语义不同。
- `PropertyPanel.tsx`：抽出 `<UguiPropertySections>`（现有内容平移）+ 新建 `<NguiPropertySections>`；Transform 区块共用放分支之上；顶层按 `node.framework` 分支。

NGUI 字段 → 桥 field/端点（复用现有 `apply-visual-patch`/`set-text`/`set-image`，不新增 HTTP 端点；桥侧 `ApplyNgui*Operation` 已用 UGUI 风格 field 名路由，1479-1525）：

| 组件 | 字段 | 写入 field / 端点 |
|---|---|---|
| UIWidget | width/height | `rectTransform.sizeDelta`（1453） |
| | color/alpha/enabled | `Image.color`/`Image.enabled`（1500,1494） |
| | depth ⚠️新增 | `Widget.depth`（`SetReflectedProperty(widget,"depth",int)`+MarkChanged） |
| | pivot ⚠️新增 | `Widget.pivot`（`UIWidget.Pivot` 枚举，9 宫格→枚举） |
| UISprite | spriteName | `Image.sprite`/`set-image`（1501） |
| | type(含 Advanced) | `Image.type`（1509） |
| | fillCenter/fillMethod/fillAmount | `Image.fillCenter`/`Image.fillMethod`/`Image.fillAmount`（1510-1512） |
| UILabel | text | `Text.text`/`set-text`（1482） |
| | fontSize/fontStyle/alignment/color/richText | `Text.fontSize`/`fontStyle`/`alignment`/`color`/`richText`（1483-1487） |
| | overflow ⚠️新增 | `Text.overflow`（`SetReflectedEnum(label,"overflowMethod",int)`；summary 加 `overflowMethod`） |
| UITexture | mainTexture/color | 只读 / `Image.color` |
| UIButton | interactable/normal/hover/pressed/disabled sprite | `Button.interactable`/`Button.normalSprite` 等（1519-1523） |

需新增的少量桥分支（在 `ApplyNgui*Operation`/`ReadNgui*FieldAsString`/`BuildNgui*Summary` 加，不新增 HTTP 端点）：`Widget.depth`、`Widget.pivot`、`Text.overflow`。

## 延迟链路：乐观覆盖 + 节流回填 + 防乱序

现状：拖动已有乐观覆盖层（`dragRef`+`setDragPreview` BridgeMainCanvas.tsx:1062-1066），松手才拉一次真值截图；`skipSnapshot` 已贯通（BridgeArtboardStore.ts:775,885；EditorBridgeClient.ts:281-283）。缺拖动中的节流真值回填。

改法：
- `onPointerMove`（1061-1066）更新乐观 `dragPreview` 同时，节流 120–150ms 发一次带 snapshot 的 `moveNode` 回填；松手发最终一次。`ignoreNextNodeSyncRef`（1106）沿用避免回填覆盖正在拖动的本地值；收到 ≥ 该请求 revision 的回填后清零 `dragPreview`。
- 防乱序：`renderSnapshot`/`moveNode`/`resizeNode`（EditorBridgeClient.ts:338,421,425）增 `options.signal` 透传 `fetch(..., {signal})`；拖动每次发新回填前 `abort()` 上一个未完成请求；再加单调 `requestSeq`，处理回填时丢弃 `seq < latestSeq`（abort + seq 双保险）。

## 实施进度

Step 1-6 已完成并提交（`536a2cf` + `72dd7f4` 等），后续 `mvp-45`~`mvp-81` 持续修复：UIDrawCall manager 归属清理、PreviewScene 隔离、UGUI/NGUI adapter 拆分、UGUI 截图改 JPEG、画板 framework 单路由、机器级 workspace 持久化、session 域重载恢复、NGUI panel 静态表清理、删除扩展截图死代码。`DD_FP_HeroDisplay` NGUI 样本 open/render/close 通过，主工程无污染，`npm run smoke:ngui-snapshot` 通过。Step 7（前端 NGUI 属性栏分支）和 Step 8（拖动节流真值回填 + Abort）待实施。

## 实施步骤（每步独立可验，Git 历史连续）

- **Step 0 基线**：跑 `npm run build`、`smoke:bridge-*`、`curl 127.0.0.1:18082/health`；对 DD_FP_HeroDisplay(NGUI)、UIBlueBtn/UIAlert2(UGUI) 各 open+截图+移动一节点，记录污染/bbox 基线。
- **Step 1 NGUI 源码 drawcall 跟随**：只改 UIDrawCall.cs（见 `ngui-isolation-change.md`）。验证隔离生效、运行时零影响、打包通过。
- **Step 2 常驻相机 + EnableAndPrimeNgui**（暂不删旧清理）：DD_FP_HeroDisplay render-snapshot 出图正确，主工程无叠层、拖一节点主工程不动。
- **Step 3 RenderSnapshot 重写复用常驻实例**：截图与 bbox 同源，前端框线与截图重合。
- **Step 4 删打地鼠 + suspend 机器**：编译通过；move-node 无 FindObjectsOfTypeAll；`/perf-logs` 看耗时下降；UGUI 三样本回归不破。
- **Step 5 undo/redo 改 SetActive 冻结**：连续编辑+undo/redo 50 步，节点不重复、无叠加、内存稳定。
- **Step 6 CleanupBridgeRuntimeState / beforeAssemblyReload**：编辑中改脚本触发重编译，域重载后无 PreviewScene 泄漏。
- **Step 7 前端 framework 分支 + NGUI 属性栏**：NGUI 节点显示 NGUI 字段可改，UGUI 仍显 UGUI 字段，`npm run build` 通过。
- **Step 8 乐观覆盖节流回填 + Abort**：拖动跟手回填、松手定格无跳变、无旧图覆盖。

### 端到端验证矩阵
- `npm run build`、`smoke:bridge-*`、`curl 127.0.0.1:18082/health`。
- 样本：DD_FP_HeroDisplay(NGUI 主路径)；UIBlueBtn + UIAlert2(UGUI 回归)。
- 污染检查：开 session 编辑/拖动时切到 Unity Game/Scene View 确认无叠层、无元素跟随移动。

## 风险点

- **R1 改 NGUI 源码**：三重守卫保运行时/打包零影响、PrefabStage 行为不变（详见 `ngui-isolation-change.md`）。
- **R2 常驻 PreviewScene 内存/泄漏**：`CloseSessionPreviewScene` 回收全部；`beforeAssemblyReload`/`Stop` 兜底关所有 scene；undo 栈 50 上限。Step6 重复开关 session+域重载验证。
- **R3 UICamera `[ExecuteInEditMode]` 副作用**：先给常驻相机挂 UICamera（关 useMouse/useTouch），异常再退"不挂"。Step2 验证。
- **R4 全局静态表常驻条目**：静态表有条目 ≠ 被渲染；若主工程编辑态有遍历 `UIPanel.list` 的全局操作受扰，退路是 close 时一次性剔除本 session 实例。
- **R5 mixed 画板**：范围内样本为纯 NGUI/纯 UGUI，mixed 作已知限制；ScreenSpace-Overlay 的 UGUI Canvas 可能不进离屏 RT。

## 关键文件

- `../fact-source/DreamlandProject/Assets/NGUI/Scripts/Internal/UIDrawCall.cs`（948-973）
- `unity/Assets/Editor/UIEditorNew/UIEditorNewBridgeCore.NguiAdapter.cs`
- `unity/Assets/Editor/UIEditorNew/UIEditorNewBridgeCore.NguiSupport.cs`
- `unity/Assets/Editor/UIEditorNew/UIEditorNewBridgeCore.cs`
- `unity/Assets/Editor/UIEditorNew/UIEditorNewBridgeServer.cs`
- `src/components/Panels/PropertyPanel.tsx`
- `src/services/BridgeArtboardStore.ts`
- `src/services/EditorBridgeClient.ts`
- `src/types/index.ts`

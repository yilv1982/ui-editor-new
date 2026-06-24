# NGUI 隔离源码改动记录

更新时间：2026-06-24。

本文件单独记录 `UIEditor_new` 为根治"NGUI 编辑/截图污染主工程 Scene View / Game View"而对客户端事实源 NGUI 源码所做的改动：为什么改、污染机制、改了哪几行、如何保证运行时与打包零影响、如何验证。配套完整重写方案见 `ngui-rewrite-plan.md`。

> 说明：被改文件是事实源受控副本 `../fact-source/DreamlandProject/Assets/NGUI/Scripts/Internal/UIDrawCall.cs`。NGUI 属于客户端工程的第三方 UI 框架定制版，任何改动都必须可审、可回归、对真机运行与打包零影响。

## 1. 为什么必须处理

`UIEditor_new` 在 Unity Editor 非播放态实例化 NGUI Prefab、渲染离屏截图、并叠加 bbox 做受控视觉编辑。实测出现两类污染主工程的现象：

1. **视觉结构改变**：Unity 场景里原 Prefab 结构发生改变，部分元素叠加成多份。
2. **元素同步异常**：拖动编辑器里的某个元素时，主工程 Game View / Scene View 中对应元素的位置也跟着改变。

这两类现象会让美术/策划在主工程里看到的界面被工具污染，是必须根治的阻塞问题。

## 2. 污染机制（根因）

NGUI 与 UGUI 的渲染机制根本不同：

- `UIPanel` / `UIWidget` / `UICamera` 都带 `[ExecuteInEditMode]`，在编辑器非播放态也会自动跑 `Update/LateUpdate`（UIPanel.cs:13、UIWidget.cs:13、UICamera.cs:40）。
- NGUI 的渲染由**全局静态表**驱动：`UIPanel.list`（UIPanel.cs:21）、`UIDrawCall.mActiveList/mInactiveList`（UIDrawCall.cs:20-21）、`UICamera.list`（UICamera.cs:127）。这套机制**与 Unity 的 Scene 边界无关**。
- 真正被渲染的是 `UIDrawCall`：它是 NGUI 在 `UIPanel` rebuild 时**独立 `new` 出来的隐藏 GameObject**（编辑器下走 `UnityEditor.EditorUtility.CreateGameObjectWithHideFlags(..., HideFlags.HideAndDontSave, typeof(UIDrawCall))`，UIDrawCall.cs:997-1010），不是 Prefab 层级子节点。
- 这个 drawcall GameObject 默认**落在当前 active scene**，layer 继承自 panel（UIDrawCall.cs:951）。**任何 cullingMask 命中该 layer 的相机都会渲染它**——包括主工程的 Game View 相机和 Scene View。

结论：即便把编辑用的 working root 移进一个隔离的 PreviewScene，NGUI rebuild 出来的 drawcall 仍然 new 在 active scene，被主工程相机画出来 → 元素叠加、拖动跟随。

之前（mvp-40~56）的修法是在 NGUI 外面"打地鼠"：截图前 `enabled=false` 挂起 NGUI 组件、渲染前临时恢复、渲染后清全局静态表、把 drawcall 事后移走。问题是 NGUI 每次 rebuild 都重新 new drawcall，事后追着移**漏一帧就闪一下**，治不彻底，且把全编辑器扫描压在编辑热路径上，造成臃肿与延迟。

## 3. 为什么改源码而不是用现成 API

NGUI 其实暴露了可用于隔离的现成口子，**不改源码也能做**：

- `UIDrawCall.MoveToScene(scene)`（UIDrawCall.cs:1125-1129）：把当前所有 drawcall 移到指定场景。
- `UIDrawCall.activeList` / `list`（UIDrawCall.cs:24/30）：枚举所有 drawcall，自行筛选本 session 的再移。
- `UIPanel.onCreateMaterial`（UIPanel.cs:176）/ `UIDrawCall.onCreateDrawCall`（UIDrawCall.cs:111）：drawcall 新建回调。

但这些都属于**事后补救**——drawcall 先在 active scene 被 new 出来（可能被渲染到一帧），再被移走；NGUI 每次 rebuild 都重新 new，需要每帧/每次刷新都补移，漏一次就闪一下，本质是打地鼠老路的"更体面版本"。

改源码是让 drawcall **出生即归位**：创建当帧就落在隔离场景，主场景一帧都不出现，机制级根治，并能把桥侧整套打地鼠（约 1600 行中的 ~55%）删掉。综合权衡后选择改源码。

## 4. 改了哪（最小 diff）

唯一改动点：`Create(string name, UIPanel pan, Material mat, Texture tex, Shader shader, bool needMatAnim)`（UIDrawCall.cs:948-973）末尾的 `#if UNITY_EDITOR && UNITY_2018_3_OR_NEWER` 分支。

**保留**原 PrefabStage 跟随逻辑不变（UIDrawCall.cs:960-970），**新增**"drawcall 跟随 manager 所在 scene"：

```csharp
#if UNITY_EDITOR && UNITY_2018_3_OR_NEWER
        // 原 PrefabStage 跟随：保持不变
        var prefabStage = UnityEditor.SceneManagement.PrefabStageUtility.GetCurrentPrefabStage();
        if (prefabStage != null && dc.manager != null)
        {
            var stage = UnityEditor.SceneManagement.StageUtility.GetStageHandle(dc.manager.gameObject);
            if (stage == prefabStage.stageHandle)
            {
                UnityEngine.SceneManagement.SceneManager.MoveGameObjectToScene(dc.gameObject, prefabStage.scene);
                return dc;
            }
        }
        // 新增：编辑器非播放态，若 manager(panel) 所在 scene 有效、已加载、且非当前 active scene
        // (= UIEditor_new 的 session PreviewScene)，让新建 drawcall 跟随该 scene，
        // 不溢出 active scene 被主工程相机渲染。
        if (!Application.isPlaying && dc.manager != null)
        {
            var mgrScene = dc.manager.gameObject.scene;
            var activeScene = UnityEngine.SceneManagement.SceneManager.GetActiveScene();
            if (mgrScene.IsValid() && mgrScene.isLoaded && mgrScene != activeScene)
                UnityEngine.SceneManagement.SceneManager.MoveGameObjectToScene(dc.gameObject, mgrScene);
        }
#endif
        return dc;
```

`dc.manager = pan` 在该函数早处（UIDrawCall.cs:957）已赋值，所以这里能拿到 panel 所在 scene。**不需要改 UIPanel.cs**：`drawCalls` 的 rebuild 走 `UIDrawCall.Create(this, ...)`（UIPanel.cs:1551），新建即经过此逻辑；`OnDisable` 销毁 drawcall（UIPanel.cs:1152-1161）也正好契合工具侧用 `SetActive(false)` 冻结 undo 快照的做法。

## 5. 为什么对运行时与打包零影响（三重守卫）

1. **`#if UNITY_EDITOR && UNITY_2018_3_OR_NEWER`**：打包产物（真机/Player）根本不编译这段，运行时代码路径完全不含改动。
2. **`!Application.isPlaying`**：编辑器里进 Play Mode 时不进入新增分支，主工程播放态 NGUI drawcall 行为与原版完全一致。
3. **`mgrScene != activeScene`**：主工程在编辑态打开的场景里，panel 都在 active scene，drawcall 默认也建在 active scene，`mgrScene == activeScene`，新增分支不触发——主工程编辑态行为不变。

只有当某个 panel 被放进一个**非 active 的、独立加载的 scene**（正是 `UIEditor_new` 的 session PreviewScene）时，新增分支才生效。PrefabStage 分支加 `return dc` 是保险（避免已归位的 drawcall 再被新增分支重复 move，虽重复 move 到同 scene 是 no-op）。

## 6. 验证方式

- **隔离生效**：在 Editor 把一个 NGUI Prefab 实例 `MoveGameObjectToScene` 到一个 `EditorSceneManager.NewPreviewScene()`，触发 rebuild 后检查其 `UIDrawCall.gameObject.scene` 是否等于该 PreviewScene；主 Scene/Game View 是否不再出现该元素。
- **运行时零影响**：进 Play Mode 跑主工程一个 NGUI 界面，确认 drawcall 仍在 active scene、渲染正常；用主工程多场景 additive 加载回归，确认主界面 drawcall 行为不变。
- **打包零影响**：build 一个 Player，确认编译通过、NGUI 界面运行正常（改动被 `#if UNITY_EDITOR` 排除）。
- **端到端**：以 `DD_FP_HeroDisplay`（NGUI 样本）走 `UIEditor_new` 的 open → render-snapshot → 拖动 → close，确认主工程 Game/Scene View 全程无叠层、无元素跟随移动。

## 7. 风险与残留

- 主工程在编辑态把某 panel 放进**非 active 的 additive scene**时，其 drawcall 会跟去那个 scene。这本就更符合"drawcall 属于 panel 所在 scene"的语义，且不影响渲染（渲染由相机 + scene + layer 决定）；需用主工程多场景加载场景实际回归确认无异常。
- 全局静态表（`UIPanel.list` / `UIDrawCall.mActiveList`）仍会登记隔离实例的 panel/drawcall——这不影响渲染（静态表有条目 ≠ 被主相机渲染），但若主工程在编辑态存在遍历 `UIPanel.list` 做全局操作的代码，可能触达隔离实例。需回归确认；必要时退路是在工具侧 close 时一次性从静态表剔除本 session 实例（不恢复热路径打地鼠）。

## 8. 调试历程与渲染卡点（2026-06-24，进行中）

常驻隔离实例（Step 2/3）落地时遇到"渲染空图"卡点，用临时诊断端点 `/ngui-diag` 逐层定位。记录关键事实与三个候选方向，便于后续判断。

逐层定位结论：
- 相机参数、`camera.scene`（绑定 preview scene，Unity 仅支持 `NewPreviewScene` 的 scene）、`orthographicSize=h/2`、cullingMask 全开——均已修对。
- working root 子树结构完整：13 个 `UIPanel`、300 个 `UIWidget` 都在。
- 但 widget 几何一个都没填充（`widgetWithGeom=0`）→ 无 drawcall（`drawCallMine=0`）→ 空图。
- 最底层根因：NGUI `UIWidget.UpdateGeometry`（UIWidget.cs:1485）填几何需 `mChanged && mIsVisibleByAlpha && finalAlpha>0.001 && shader!=null`。`mIsVisibleByAlpha` 依赖 `UIPanel` 用一个被 NGUI 识别的相机（`anchorCamera`，经 `NGUITools.FindCameraForLayer(layer)` 查找）做可见性/裁剪计算。**离屏 `LoadPrefabContents` 出来的 working root 缺一个被 NGUI 正确识别的相机，widget 被判不可见、不填几何。**
- 旁证：旧实现（基线能出图）是在 `RenderSnapshot` 里 `Instantiate` 一份新实例渲染，新实例 NGUI 生命周期/相机识别走正常路径；而常驻方案直接驱动 `LoadPrefabContents` 的 working root，这条链路没跑通。
- 帧守卫坑：`UIPanel.LateUpdate`（UIPanel.cs:1357）有 `mUpdateFrame != Time.frameCount` 守卫，编辑器非播放态同帧多次反射调用会被跳过；改为直接反射调 `UIPanel.UpdateSelf` 绕过，但这只是必要不充分——可见性链路仍未解决。

三个候选方向：
1. **修常驻实例的相机识别（已选，进行中）**：给离屏 root 配一个 NGUI 能识别的 `anchorCamera`（挂 `UICamera`、对齐 CaptureLayer），让 `UpdateGeometry` 的可见性判断通过。坚持单一常驻实例，最干净，但需再调 NGUI 内部机制。
2. **强制绕过可见性判断**：反射直接设 widget `mIsVisibleByAlpha`/`mForceVisible=true` 再 `UpdateGeometry`，跳过相机可见性链路。出图快但偏 hack，可能掩盖裁剪相关真实行为。
3. **截图用临时实例（混合）**：编辑态用常驻 root 承接数据修改（满足拖动改数据），但截图仍像旧代码 `Instantiate` 一份临时实例渲染（NGUI 生命周期正常、已验证能出图），临时实例也进 preview scene 隔离。放弃"截图复用同一实例"，nodeId 靠同结构索引仍对齐。最稳、改动小。

当前按方向 1 推进。

# UIEditor_new 交接部署集成文档

更新时间：2026-06-25。

本文件面向接手 `UIEditor_new` 的其他项目，说明工程定位、部署集成步骤、客户端工程的工程外改动、已知问题与坑、以及运行验证口径。接手前请完整阅读本文件，尤其是「工程外改动」和「已知问题」两节——这些改动不在 `UIEditor_new` 仓库内，漏配会导致截图不显示、渲染污染或编译冲突。

## 一、工程定位

`UIEditor_new` 是一个面向 Unity UI Prefab 的**截图式受控视觉编辑工具**。Unity Editor 是资产事实和视觉真值服务，Web 前端只显示 Unity 截图、叠加选择框/属性面板，把用户改动以白名单视觉字段 patch 提交回 Unity，保存前过 protected diff 拦住非视觉字段。

- 不替代 Unity Prefab 编辑器，不让 UI 人员编辑完整序列化内容。
- 只允许编辑 UI 岗位负责的视觉字段（位置/尺寸/文本/图片/显隐等），保护脚本、事件、Lua/schema 绑定、Prefab 关联等程序职责内容。
- 同时支持 UGUI 和 NGUI（Dreamland 定制版），两者在客户端工程端隔离运行。

详细架构、能力、API 见 `README.md`、`WORKITEM.md`、`docs/unity-editor-bridge-api.md`。

## 二、仓库与目录结构

`UIEditor_new` 仓库（`fact-source/UIEditor_new/`）：

```
UIEditor_new/
  src/                Web 前端（React + Vite，dev 端口 4105）
    services/         EditorBridgeClient、BridgeArtboardStore
    components/       RemoteArtboardEditor、BridgeMainCanvas、PropertyPanel、LayerPanel
    plugins/          Vite 中间件（prefab/atlas/save 等辅助接口）
  unity/Assets/Editor/UIEditorNew/   Unity 侧 Editor Bridge 源码（C#，端口 18082）
  docs/               架构、API、烟测、NGUI 方案、本交接文档
  scripts/            烟测脚本（bridge-web/shell/ops/ngui-snapshot/thumbnail）
  package.json / vite.config.ts / unity-config.json
```

**关键**：`unity/Assets/Editor/UIEditorNew/` 是 Unity 侧 Bridge 的权威源码，由本仓库维护。`.meta` 文件由 Unity 生成，已在 `.gitignore` 中忽略（`unity/**/*.meta`），不纳入版本管理。

## 三、部署集成步骤

### 1. 准备 Web 工程

```bash
cd UIEditor_new
npm install
npm run build      # 验证构建通过
npm run dev        # 启动 Web，访问 http://localhost:4105/
```

### 2. 接入客户端 Unity 工程

`UIEditor_new` 的 Unity Bridge 源码在 `unity/Assets/Editor/UIEditorNew/`，需要让客户端 Unity 工程能编译到它。有两种方式：

**方式 A（当前在用，推荐）：junction 链接**

在客户端工程的 `Assets/Editor/` 下建一个 junction 指向 `UIEditor_new/unity/Assets/Editor/UIEditorNew/`：

```powershell
# Windows（PowerShell，需管理员或开发者模式）
New-Item -ItemType Junction -Path "客户端工程\Assets\Editor\UIEditorNew" -Target "UIEditor_new\unity\Assets\Editor\UIEditorNew"
```

这样 Bridge 源码仍由 `UIEditor_new` 仓库统一提交，客户端工程不重复维护。Unity 会自动生成 `.meta`，无需管理。

**方式 B：直接复制**

把 `unity/Assets/Editor/UIEditorNew/` 整个目录复制到客户端工程 `Assets/Editor/UIEditorNew/`。后续 `UIEditor_new` 更新 Bridge 时需手动同步。

### 3. 与老 UIEditor 隔离

如果客户端工程已有老 UIEditor（`Assets/Editor/UIEditor/`、端口 8081、`UIEditor...` 类名），两者必须隔离共存，不能互相复用脚本/端口/菜单/静态状态：

| 项目 | 老 UIEditor | UIEditor_new |
| --- | --- | --- |
| Unity 脚本目录 | `Assets/Editor/UIEditor/` | `Assets/Editor/UIEditorNew/` |
| C# 类名前缀 | `UIEditor...` | `UIEditorNew...` |
| Unity 菜单前缀 | `UIEditor/...` | `UIEditorNew/...` |
| 本地 HTTP 端口 | 8081 | 18082 |
| 健康检查 name | `UIEditorCorsProxy` | `UIEditorNewBridge` |
| 临时 Prefab | 旧工具自有 | `Assets/Temp/UIEditorNew/` |
| 截图缓存 | 旧工具自有 | `Temp/UIEditorNew/Snapshots/` |

详见 `docs/client-bridge-isolation.md`。

### 4. 启动验证

1. 打开客户端 Unity 工程，等编译完成（Bridge 脚本在 `Assets/Editor/UIEditorNew/`）。
2. Unity 菜单 `UIEditorNew/Start Bridge` 启动 Bridge，或代码触发。
3. 验证健康检查：`http://127.0.0.1:18082/health` 应返回 `{"ok":true,"name":"UIEditorNewBridge","version":"UIEditor_new-bridge-mvp-81"}`。
4. 启动 Web：`npm run dev`，访问 `http://localhost:4105/`。
5. 跑烟测：`npm run smoke:bridge-web`、`npm run smoke:ngui-snapshot`。

## 四、工程外改动（重要）

以下改动**不在 `UIEditor_new` 仓库内**，是对客户端 Unity 工程的修改。接手时必须确认这些改动是否存在、是否需要保留或还原。漏配会导致功能异常。

> **⚠️ 4.1 / 4.2 改动前提说明**
>
> 这两处改动（`UIDrawCall.cs` drawcall 跟随 scene、`UnlitTransparentColored.shader` 去 LightMode 标签）很可能与本工程的特定背景有关：**一个非 URP 渲染管线的工程，导入了一批被改过以支持 URP 的 NGUI prefab**。shader 的 `LightMode=UniversalForward` 标签、NGUI drawcall 在编辑态的 scene 归属行为，都是这批 URP 化 prefab 带来的特征。
>
> **接手时不要默认照搬这两处改动**。正确做法是：**先在不改这两处的前提下，按第六节跑通 UGUI/NGUI 样本验证**——
> - 若 NGUI prefab 贴图正常显示、编辑/截图无主工程污染 → 说明接手工程的渲染管线/prefab 版本与原工程不同，**不需要这两处改动，保持原样即可**。
> - 若复现贴图不显示或渲染污染 → 再按 4.1/4.2 应用改动。
>
> 即：这两处是"对症改动"，不是"必装依赖"，先测异常再决定改不改。

### 4.1 NGUI 源码改动：`UIDrawCall.cs`（先测再改）

文件：客户端工程 `Assets/NGUI/Scripts/Internal/UIDrawCall.cs`

**目的**：根治 NGUI 编辑/截图污染主工程 Scene/Game View。

**机制**：NGUI 的 `UIDrawCall` 是独立 new 出来的隐藏 GameObject，默认落在 active scene，被主工程相机渲染 → 元素叠加、拖动跟随。改动让 drawcall **出生即跟随 manager(panel) 所在 scene**。

**改动位置**：`Create(string name, UIPanel pan, ...)` 末尾 `#if UNITY_EDITOR && UNITY_2018_3_OR_NEWER` 分支，保留原 PrefabStage 跟随逻辑，新增 drawcall 跟随 manager scene 的分支：

```csharp
if (!Application.isPlaying && dc.manager != null)
{
    var mgrScene = dc.manager.gameObject.scene;
    var activeScene = UnityEngine.SceneManagement.SceneManager.GetActiveScene();
    if (mgrScene.IsValid() && mgrScene.isLoaded && mgrScene != activeScene)
        UnityEngine.SceneManagement.SceneManager.MoveGameObjectToScene(dc.gameObject, mgrScene);
}
```

**注意**：排查贴图问题时曾临时加过 `mainTexture` setter / `ApplyMainTexture` 兜底试探，已移除。当前 `UIDrawCall.cs` 相对原版**只剩**这一处 drawcall 跟随 scene 的隔离改动，不含任何贴图相关改动。

**三重守卫保证零影响**：
1. `#if UNITY_EDITOR && UNITY_2018_3_OR_NEWER`：打包产物（真机/Player）不编译此段。
2. `!Application.isPlaying`：Play 模式不触发，运行时 NGUI 行为不变。
3. `mgrScene != activeScene`：主工程编辑态 panel 都在 active scene，不触发；只有 panel 在非 active 的独立 PreviewScene（工具的 session 场景）时才生效。

**验证**：详见 `docs/ngui-isolation-change.md`。改动记录见该文档。

### 4.2 NGUI shader 改动：`UnlitTransparentColored.shader`（先测再改）

文件：客户端工程 `Assets/HotRes/Shaders/UnlitTransparentColored.shader`

**问题**：原 shader 主 Pass 带 `Tags{"LightMode" = "UniversalForward"}`（URP 的 LightMode）。在 Prefab Stage / 内置渲染路径下，这个 Pass **不被选中渲染**，导致 UI2DSprite 的贴图画不出来（UILabel 文字正常，因为走另一套）。

**修复**：去掉该 Pass 的 `LightMode=UniversalForward` 标签，让 shader 在所有渲染路径下都能渲染。修复后需在 Unity 里重新导入 shader。

**接手确认**：先在不改 shader 的前提下验证 NGUI 贴图是否正常（见第四节开头的 ⚠️ 说明）。若贴图不显示，第一时间查这个 shader 的 Pass 标签；若贴图正常，不要改。

### 4.3 客户端工程本地环境改动（非必须，可还原）

这些是本地开发环境改动，**不应混入 UIEditor 提交**，接手时按需保留或还原：

- `Assets/CamelHybrid/GlobalBase/Scripts/Config/HybridBaseDefine.cs`：SSO 地址相关，当前文件已是正式 URL（`starlitedengame` / `finalfrontz`），无 `127.0.0.1` 本地改动。接手时确认 SSO 地址是否正确即可。
- `Packages/manifest.json`：新增 `com.coplaydev.unity-mcp`（MCP for Unity）依赖。UIEditor_new 不依赖 MCP 走主链路（走 18082 直连），该包可保留作实验或移除。
- `ProjectSettings/PackageManagerSettings.asset`：Package registry 指向 `https://packages.unity.cn`（本地环境），接手时按团队 registry 配置调整。
- `Assets/Editor/UIEditor/`（老 UIEditor 桥接脚本）：未跟踪，属老工具，UIEditor_new 不复用。

## 五、已知问题与坑

> **⚠️ 这些坑的背景说明**
>
> 本章记录的问题（anchor 畸变、贴图不显示）都源自原工程"非 URP 工程导入了 URP 化 NGUI prefab"这一特定背景。接手工程的渲染管线、NGUI 版本、prefab 来源若与原工程不同，这些问题**未必复现**。
>
> **接手时先按第六节跑验证**，只在确实复现异常时再对照本章排查，不要预先假设这些问题一定存在。

### 5.1 NGUI 编辑态域重载 anchor 畸变（NGUI 固有，不修复）

**现象**：带 NGUI anchor 链的 prefab 实例（如 `DD_FP_HeroDisplay`）放进场景后，**改任意代码触发编译（域重载）**会让 anchor widget 坐标/尺寸畸变（如 ssr 从 `(-250,-176)` 变 `(-125,-353)`，Equipment widget 塌成 `750×2`），且一直保持错误值，**必须重启 Unity 才恢复**。

**根因**：NGUI widget 的 position/size 不取序列化值，由 `OnAnchor` 运行时重算，依赖 UIRoot scale 和 parent widget 边界，有严格拓扑顺序。域重载后静态变量清零、重算顺序错乱时，child 在 parent 边界未就绪时执行 `OnAnchor` → 边界塌缩 → 尺寸塌成最小值 2 → 链式塌缩。NGUI 作者在 `UIRect.cs:456-458` 注释里也承认这个编辑态问题。

**结论**：
- 这是 NGUI 自身编辑态缺陷，**与 UIEditor_new 工具无关**（删光工具代码仍复现）。
- **不需要修复**，工具不应绕过或修补。
- 仅影响编辑态验证场景，**主工程 Play 模式不受影响**（Play 下 NGUI 按正确顺序初始化）。
- 验证场景受此影响时，重启 Unity 即可恢复。

详见 `.process/findings/2026-06-25-NGUI编辑态域重载anchor畸变.md`。

### 5.2 NGUI 贴图不显示排查顺序

遇到 NGUI prefab 贴图不显示，按以下顺序排查（别先怀疑 prefab 数据或 NGUI tick）：

1. **查 shader Pass 标签**：`Unlit/Transparent Colored` 主 Pass 是否带 `LightMode=UniversalForward`（见 4.2）。这是最常见根因。
2. **查 UIRoot.localScale**：编辑态非渲染上下文下可能是 `(0,0,0)`，但 Play 时应恢复。若 Play 也是 0，查 NGUI 是否正常 tick。
3. **查 drawcall**：用 Unity API 看 UIPanel.drawCalls 是否为空。空则 NGUI 没建 drawcall。
4. **查 sprite2D 引用**：UI2DSprite 的 sprite2D 是否 null、引用的 Sprite 资产文件是否存在。

### 5.3 NGUI 交互功能未完成项

NGUI 渲染隔离已完成（Step 1-6），但**前端交互**还有缺口（`docs/ngui-interaction-todo.md`）：

- **属性面板无 NGUI 分支**：`PropertyPanel.tsx` 没有 framework 分支，NGUI 节点选中后属性面板不显示 NGUI 字段（桥侧字段读写已支持，纯前端缺口）。
- **控件创建只建 UGUI**：`create-widget-node`/`create-text-node` 在 NGUI 画板上会建出 UGUI 节点，破坏单路由。
- **桥侧缺 `Widget.depth`/`Widget.pivot`/`Text.overflow` 的 Apply**：NGUI 核心视觉字段，桥+前端都要补。
- **拖动节流真值回填未做**（Step 8）：拖动中只有乐观覆盖层，松手才拉截图。

### 5.4 其他注意

- **临时 Prefab 未跟踪**：`Assets/Temp/UIEditorNew/` 下的临时 prefab 不入 git，浏览器刷新靠 `resume-session` 恢复。session 域重载后 Web 按 `workingPrefabPath` resume 重试。
- **画板 framework 单路由**：首个非空 Prefab 锁定画板 UGUI/NGUI，后续不一致插入被桥拒绝。
- **AI 配置敏感**：`ai-config.json` 含密钥，已在 `.gitignore`，不在仓库内；接手时本地配置，勿提交。
- **protected diff 仍是 MVP**：结构签名校验，字段级/组件级报告待补。

## 六、运行验证口径

接手后至少跑通以下闭环：

1. **UGUI 样本**：`UICommons/UIBlueBtn.prefab` 或 `UIAlert2.prefab`——打开临时副本 → 截图叠加 → 拖拽/属性 patch → protected diff → 保存临时副本。`npm run smoke:bridge-web` 验证。
2. **NGUI 样本**：`DD_FP_HeroDisplay`（在 `Assets/HotRes/Parts/HeroDisplay/`）——open → render → close，主工程无污染。`npm run smoke:ngui-snapshot` 验证。
3. **老桥共存**：若客户端有老 UIEditor，确认 8081 和 18082 可同时存在、互不影响。
4. **构建**：`npm run build` 通过。

## 七、关键文档索引

- `README.md`：工程总览、快速入口、Bridge API 概览。
- `WORKITEM.md`：工作项、当前基线、TODO。
- `docs/unity-editor-bridge-api.md`：Bridge HTTP API、数据结构、protected diff。
- `docs/client-bridge-isolation.md`：新老桥隔离约束。
- `docs/ngui-rewrite-plan.md`：NGUI 重写方案（根因、生命周期、实施步骤）。
- `docs/ngui-isolation-change.md`：`UIDrawCall.cs` 源码改动记录。
- `docs/ngui-interaction-todo.md`：NGUI 交互功能待办。
- `docs/baseline-smoke.md`：基线烟测。
- `docs/component-library-io-contract.md`：与 UI 公共组件库的 I/O 契约。

## 八、接手检查清单

- [ ] `UIEditor_new` 仓库 `npm install` + `npm run build` 通过
- [ ] 客户端工程 `Assets/Editor/UIEditorNew/` junction 或复制到位，Unity 编译无错
- [ ] 先在**不改 4.1/4.2** 的前提下跑 NGUI 样本验证：
  - [ ] NGUI 贴图正常显示 → 4.1/4.2 **不需要改**，保持原样
  - [ ] NGUI 贴图不显示或渲染污染 → 按 4.1 应用 `UIDrawCall.cs` 三重守卫改动，按 4.2 去 shader `LightMode=UniversalForward`
- [ ] `http://127.0.0.1:18082/health` 返回 `UIEditorNewBridge` mvp-81
- [ ] Web `http://localhost:4105/` 可访问
- [ ] UGUI 样本（UIBlueBtn/UIAlert2）闭环通过
- [ ] NGUI 样本（DD_FP_HeroDisplay）open/render/close 通过，主工程无污染
- [ ] 老 UIEditor（若有）8081 与新桥 18082 共存无冲突
- [ ] 确认 SSO 地址、Package registry、MCP 包按团队策略配置（4.3）

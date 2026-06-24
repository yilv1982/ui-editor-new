# Unity Editor Bridge API 草案

更新时间：2026-06-23。

本文件定义 `UIEditor_new` 截图式受控视觉编辑链路需要的 Unity Editor 本地 HTTP API。当前 Unity 工程已有老 UIEditor 的 `UIEditorCorsProxy`、`UIEditorBridgeSync`、`UIEditorReferenceCapture`，已能提供 `/health`、`/sync-preview`、`/sync-incremental`、`/capture-reference`。这些脚本只能作为实现参考；`UIEditor_new` 必须建立独立桥接服务，不能扩展、复用或改写老 UIEditor 的运行时桥接入口。

## 原则

- Unity Editor 是资产事实和视觉真值服务。
- Web 不访问 `AssetDatabase`，只通过本地 HTTP API 请求 Unity Editor 打开、导出、截图、回放、校验和保存。
- Web 不保存完整 Prefab 序列化内容，只提交白名单视觉字段 patch。
- 默认操作临时副本；正式 Prefab 保存必须经过 protected diff。
- 临时 Prefab 在 Unity 工程中仍然存在，但编辑时以内存 working root 承接高频操作；15 秒无修改后自动异步落盘，保存、校验、关闭保留画板时会先强制 flush。
- 每次 patch 都要绑定基线 revision，避免旧截图上的拖动覆盖新状态。
- API 返回的 bbox 与截图必须来自同一次 Unity 渲染，不能混用静态解析坐标和旧截图。
- `UIEditor_new` 与老 UIEditor 在客户端工程端必须隔离：独立脚本目录、类名、菜单、端口、session、临时文件和保存路径。

## 客户端桥接隔离

详见 `client-bridge-isolation.md`。API 层必须遵守以下约束：

- 老 UIEditor 继续占用 `Assets/Editor/UIEditor/`、`UIEditor...` 类名、`UIEditor/...` 菜单和 `8081` 端口。
- `UIEditor_new` 使用 `Assets/Editor/UIEditorNew/`、`UIEditorNew...` 类名、`UIEditorNew/...` 菜单和 `18082` 端口。
- `UIEditor_new` 不向 `UIEditorCorsProxy.LastSyncJson` 写数据，不调用老桥 `/sync-preview` 或 `/sync-incremental`，也不复用老桥的 HTTP listener。
- 如需复用老桥代码，只能复制无状态算法并改名；不能共享静态状态、端口、临时目录或保存逻辑。

## 现有可复用能力

| 现有端点/脚本 | 当前能力 | 新流程处理 |
| --- | --- | --- |
| `GET /health` | 老桥返回 `{"ok":true,"name":"UIEditorCorsProxy"}` | 只作为老桥可用性参考；新桥必须返回 `UIEditorNewBridge` |
| `POST /capture-reference` | 老桥加载 Prefab、实例化、渲染 PNG、返回目标 rect 和 Graphic 信息 | 只复制实现思路；新桥用独立 `renderSnapshot` |
| `POST /sync-preview` | 老桥将 Web 导出的 JSON 构造成 Unity 预览对象 | 旧链路保留；新流程禁止调用 |
| `POST /sync-incremental` | 老桥将 Web 导出的 JSON 增量写回原 Prefab | 旧链路保留；新流程禁止调用，改由 `applyVisualPatch` + `validateProtectedDiff` + `savePrefab` |
| `UIEditorReferenceCapture` | 使用 `AssetDatabase`、`PrefabUtility.InstantiatePrefab`、`RenderTexture`、Canvas/Camera 渲染 | 可复制渲染和 Graphic 收集逻辑到 `UIEditorNewSnapshotRenderer`，不能复用类名或静态状态 |
| `UIEditorBridgeSync` | 能 `LoadPrefabContents` 和 `SaveAsPrefabAsset` | 只借鉴加载/保存方式；新实现放入 `UIEditorNewPatchApplier` 和 `UIEditorNewProtectedDiff` |

## 通用约定

默认地址：

```text
http://127.0.0.1:18082
```

通用成功响应：

```json
{
  "ok": true,
  "requestId": "uuid",
  "revision": "prefab-session-revision",
  "warnings": []
}
```

通用失败响应：

```json
{
  "ok": false,
  "requestId": "uuid",
  "error": {
    "code": "PREFAB_NOT_FOUND",
    "message": "Prefab not found: Assets/HotRes2/UIs/Prefabs/..."
  }
}
```

错误码首版：

| code | 含义 |
| --- | --- |
| `BAD_REQUEST` | 请求体缺字段或字段格式不合法 |
| `PREFAB_NOT_FOUND` | Prefab 路径无法在 AssetDatabase 中找到 |
| `SESSION_NOT_FOUND` | sessionId 不存在或已关闭 |
| `REVISION_CONFLICT` | patch 的 baseRevision 不是当前 revision |
| `NODE_NOT_FOUND` | patch 指向的节点不存在 |
| `FIELD_NOT_EDITABLE` | patch 试图修改非白名单字段 |
| `PROTECTED_DIFF` | protected diff 检查失败 |
| `RENDER_FAILED` | Unity 渲染截图失败 |
| `SAVE_REJECTED` | 未通过保存前置条件 |

## 数据结构

### Prefab Session

```json
{
  "sessionId": "uuid",
  "sourcePrefabPath": "Assets/HotRes2/UIs/Prefabs/UICommons/UIBlueBtn.prefab",
  "workingPrefabPath": "Assets/Temp/UIEditorNew/UIBlueBtn__uieditor_tmp.prefab",
  "mode": "temp-copy",
  "revision": "r1",
  "openedAt": "2026-06-22T13:30:00+08:00"
}
```

`mode` 首版只允许：

- `readonly`：只打开、导出、截图，不允许 patch/save。
- `temp-copy`：复制到临时路径后 patch/save，首轮 MVP 默认使用。
- `source`：直接修改原 Prefab，首轮禁用。

### Node Identity

```json
{
  "nodeId": "fileID:123456789",
  "unityFileId": "123456789",
  "path": "Root/Content/ButtonText",
  "name": "ButtonText",
  "parentId": "fileID:987654321",
  "siblingIndex": 2
}
```

`nodeId` 优先使用 Unity local fileID。若某些运行时生成或临时节点无 fileID，才使用 `path:<transform path>` 作为 fallback，并在响应中标记 `identityStable=false`。

### Node Record

```json
{
  "nodeId": "fileID:123456789",
  "name": "ButtonText",
  "path": "Root/Content/ButtonText",
  "parentId": "fileID:987654321",
  "children": [],
  "activeSelf": true,
  "activeInHierarchy": true,
  "rectTransform": {
    "anchorMin": [0.5, 0.5],
    "anchorMax": [0.5, 0.5],
    "pivot": [0.5, 0.5],
    "anchoredPosition": [0, 0],
    "sizeDelta": [160, 44],
    "localScale": [1, 1, 1],
    "localEulerAngles": [0, 0, 0]
  },
  "components": [
    {
      "type": "Text",
      "enabled": true,
      "summary": {
        "text": "OK",
        "fontSize": 24,
        "color": "#FFFFFFFF",
        "alignment": "MiddleCenter"
      }
    }
  ],
  "editableFields": [
    "activeSelf",
    "rectTransform.anchoredPosition",
    "rectTransform.sizeDelta",
    "rectTransform.localScale",
    "rectTransform.localEulerAngles.z",
    "Text.text",
    "Text.fontSize",
    "Text.color",
    "Graphic.alpha",
    "Image.color",
    "Image.sprite"
  ],
  "protectedFields": [
    "MonoBehaviour.m_Script",
    "Button.onClick",
    "Lua/schema bindings",
    "PrefabInstance source",
    "GameObject fileID"
  ],
  "bbox": {
    "x": 420,
    "y": 860,
    "width": 160,
    "height": 44,
    "space": "snapshot-pixel"
  }
}
```

### Visual Patch

```json
{
  "patchId": "uuid",
  "baseRevision": "r1",
  "operations": [
    {
      "op": "set",
      "nodeId": "fileID:123456789",
      "field": "rectTransform.anchoredPosition",
      "value": [12, -8],
      "source": {
        "kind": "drag",
        "screenDelta": [12, 8]
      }
    }
  ]
}
```

首版 `op` 只支持：

- `set`：直接设置白名单字段。
- `delta`：基于当前 Unity 值做数值增量，主要用于拖动和缩放。

## Endpoint

### `GET /health`

用途：确认 Unity Editor 本地桥接服务可用。

响应：

```json
{
  "ok": true,
  "name": "UIEditorNewBridge",
  "version": "UIEditor_new-bridge-draft-1",
  "projectPath": "E:/Projects/Dreamland/fact-source/DreamlandProject",
  "capabilities": [
    "openPrefab",
    "createBlankArtboard",
    "resumeSession",
    "exportNodeTree",
    "renderSnapshot",
    "applyVisualPatch",
    "remotePrefabOperations",
    "createVisualNodes",
    "createWidgetNodes",
    "duplicateNodes",
    "copyNodesToSession",
    "groupNodes",
    "ungroupNodes",
    "validateProtectedDiff",
    "savePrefab",
    "saveArtboard",
    "closePrefab"
  ]
}
```

### Remote artboard operation endpoints

当前 `RemoteArtboardEditor` 主流程使用以下高层端点。每次成功操作都会返回同一类 `ArtboardStateResponse`：`session`、`revision`、`rootNodeId`、`nodes`、`snapshot`、`selectedNodeId`、`dirty`、`undoAvailable`、`redoAvailable`。

节点编辑端点支持 `skipSnapshot: true`。启用后 Bridge 只返回节点树和 session 状态，Web 先用本地乐观更新满足 200ms 内交互反馈，再用低优先级 `render-snapshot` 异步回填 Unity 真值截图。

当前实现中，`move-node`、`resize-node`、`set-text`、`set-text-style`、`set-image`、`set-visible`、`insert-prefab`、`delete-node`、`undo-artboard`、`redo-artboard` 都先修改 session 内存 working root，不在每次操作后立即 `SaveAsPrefabAsset`。`validate-protected-diff`、`save-prefab`、`save-artboard` 和关闭但不删除临时对象时会先 flush；如果 15 秒没有新修改，Bridge 也会在 Unity Editor update 中自动 flush 临时 Prefab。

| Endpoint | 用途 |
| --- | --- |
| `POST /create-blank-artboard` | 创建新 UI 的 Unity 临时 Prefab 画板。 |
| `POST /resume-session` | 浏览器刷新后根据 `workingPrefabPath` 重建 Bridge session。 |
| `POST /move-node` | 精确设置 `moveNode(nodeId,x,y)`。 |
| `POST /resize-node` | 设置 `resizeNode(nodeId,width,height)`。 |
| `POST /set-text` | 修改 `Text.text`。 |
| `POST /set-text-style` | 修改字号、颜色和字体引用。 |
| `POST /set-image` | 修改 `Image.sprite`，包含九宫格图片引用。 |
| `POST /set-visible` | 修改节点显隐。 |
| `POST /apply-visual-patch` with `Graphic.alpha` | 修改当前节点透明度；有 `Graphic` 时写自身 `Graphic.color.a`，无 `Graphic` 的 RectTransform 使用 `CanvasGroup.alpha` 作为容器透明度，不逐个改写子节点。 |
| `POST /reparent-node` | 调整父节点和 sibling index。 |
| `POST /insert-prefab` | 将现存 UI Prefab 复制到当前画板作为普通子节点。 |
| `POST /create-text-node` | 新增文字节点。 |
| `POST /create-image-node` | 新增图片节点。 |
| `POST /create-widget-node` | 新增基础控件节点。 |
| `POST /duplicate-nodes` | 同一 session 内复制节点。 |
| `POST /copy-nodes-to-session` | 跨 session 将源 Unity 节点子树克隆到当前画板。 |
| `POST /group-nodes` | 组合节点。 |
| `POST /ungroup-nodes` | 取消组合。 |
| `POST /delete-node` | 删除节点。 |
| `POST /undo-artboard` / `POST /redo-artboard` | 由 Unity Bridge 管理的画板级撤销/重做。 |
| `POST /save-artboard` | 保存画板；已有 source 默认写回 source，新 UI 使用用户指定路径。 |

### `POST /open-prefab`

用途：打开 Prefab，并按模式建立 session。首轮只允许 `readonly` 或 `temp-copy`。

请求：

```json
{
  "prefabPath": "UICommons/UIBlueBtn.prefab",
  "mode": "temp-copy",
  "tempRoot": "Assets/Temp/UIEditorNew",
  "width": 1080,
  "height": 1920,
  "backgroundColor": "#162D3FFF"
}
```

响应：

```json
{
  "ok": true,
  "session": {
    "sessionId": "uuid",
    "sourcePrefabPath": "Assets/HotRes2/UIs/Prefabs/UICommons/UIBlueBtn.prefab",
    "workingPrefabPath": "Assets/Temp/UIEditorNew/UIBlueBtn__uieditor_tmp.prefab",
    "mode": "temp-copy",
    "revision": "r1"
  }
}
```

### `POST /export-node-tree`

用途：从当前 session 的 Unity Prefab 导出节点模型。它负责“拆分”真实 Prefab 结构，但不输出真实像素。

请求：

```json
{
  "sessionId": "uuid",
  "includeInactive": true,
  "includeComponents": true,
  "includeProtectedFields": true
}
```

响应：

```json
{
  "ok": true,
  "revision": "r1",
  "rootNodeId": "fileID:100100",
  "nodes": []
}
```

首版导出内容必须覆盖：

- Transform 路径、名称、父子关系、siblingIndex。
- Unity local fileID 和 fallback identity。
- RectTransform 核心布局字段。
- Graphic/Text/Image/Button/Mask/LayoutGroup/ContentSizeFitter 摘要。
- 可编辑字段白名单和不可写原因。

### `POST /render-snapshot`

用途：在 Unity Editor 内渲染完整 UI 截图，并返回与同一帧截图对应的节点 bbox。它负责“拼接”最终整体画面。

请求：

```json
{
  "sessionId": "uuid",
  "width": 1080,
  "height": 1920,
  "backgroundColor": "#162D3FFF",
  "targetNodeIds": ["fileID:123456789"],
  "includeBboxes": true,
  "imageMode": "file"
}
```

响应：

```json
{
  "ok": true,
  "revision": "r1",
  "snapshot": {
    "snapshotId": "uuid",
    "width": 1080,
    "height": 1920,
    "coordinateSpace": "top-left-pixel",
    "image": {
      "format": "png",
      "mode": "file",
      "path": "Temp/UIEditorNew/Snapshots/uuid.png"
    },
    "bboxes": [
      {
        "nodeId": "fileID:123456789",
        "path": "Root/Content/ButtonText",
        "x": 420,
        "y": 860,
        "width": 160,
        "height": 44,
        "activeInHierarchy": true
      }
    ]
  }
}
```

`imageMode` 首版支持：

- `file`：返回本地代理可读取的临时文件路径，适合大图。
- `base64`：返回 data URL，适合小样本或调试。

### `POST /create-frame-node`

用途：在当前 session 中创建空视觉容器。

请求：

```json
{
  "sessionId": "uuid",
  "parentId": "node-id-or-null",
  "name": "Frame",
  "x": 0,
  "y": 0,
  "width": 300,
  "height": 200,
  "skipSnapshot": false
}
```

响应：`ArtboardStateResponse`。

### `POST /create-text-node`

用途：在当前 session 中创建 Text 节点。

请求：

```json
{
  "sessionId": "uuid",
  "parentId": "node-id-or-null",
  "name": "Text",
  "text": "Text",
  "x": 0,
  "y": 0,
  "width": 240,
  "height": 64,
  "fontSize": 32,
  "color": "#FFFFFFFF",
  "skipSnapshot": false
}
```

响应：`ArtboardStateResponse`。

### `POST /create-image-node`

用途：在当前 session 中创建 Image 节点，可附带 sprite 路径。

请求：

```json
{
  "sessionId": "uuid",
  "parentId": "node-id-or-null",
  "name": "Image",
  "spritePath": "Assets/...",
  "x": 0,
  "y": 0,
  "width": 160,
  "height": 160,
  "color": "#FFFFFFFF",
  "skipSnapshot": false
}
```

响应：`ArtboardStateResponse`。

### `POST /create-widget-node`

用途：创建基础 UI 控件。首版支持 `button`、`scrollview`、`toggle`、`inputfield`、`rawimage`、`image`、`text`、`frame`。

请求：

```json
{
  "sessionId": "uuid",
  "parentId": "node-id-or-null",
  "widgetType": "button",
  "name": "Button",
  "x": 0,
  "y": 0,
  "width": 160,
  "height": 72,
  "skipSnapshot": false
}
```

响应：`ArtboardStateResponse`。

### `POST /duplicate-nodes`

用途：在同一 session 内复制一个或多个节点。若同时选中父子节点，只复制最外层选中节点，避免重复复制子树。

请求：

```json
{
  "sessionId": "uuid",
  "nodeIds": ["node-id"],
  "offsetX": 20,
  "offsetY": -20,
  "skipSnapshot": false
}
```

响应：`ArtboardStateResponse`，`selectedNodeId` 指向第一个复制出的节点。

### `POST /copy-nodes-to-session`

用途：把源 session 中的 Unity 节点子树复制到目标 session。用于跨画板粘贴；源节点必须来自仍然存在的 Bridge session，目标 session 不能是 readonly。若同时传入父子节点，只复制最外层选中节点，避免重复复制子树。

请求：

```json
{
  "sourceSessionId": "source-session",
  "targetSessionId": "target-session",
  "nodeIds": ["source-node-id"],
  "targetParentId": "target-root-node-id",
  "offsetX": 20,
  "offsetY": -20,
  "skipSnapshot": false
}
```

响应：目标 session 的 `ArtboardStateResponse`，`selectedNodeId` 指向第一个粘贴出的节点。当前实现克隆 Unity GameObject 子树并重命名顶层节点为 `_copy`，不经过 Web 本地节点重建。

### `POST /group-nodes`

用途：把同父级的一组节点包进新建 Frame 组。不同父级节点会返回 `GROUP_PARENT_MISMATCH`。

请求：

```json
{
  "sessionId": "uuid",
  "nodeIds": ["node-a", "node-b"],
  "name": "Group",
  "skipSnapshot": false
}
```

响应：`ArtboardStateResponse`，`selectedNodeId` 指向新建组。

### `POST /ungroup-nodes`

用途：取消一个或多个组，将其子节点移动回原父级并删除组节点。

请求：

```json
{
  "sessionId": "uuid",
  "nodeIds": ["group-node-id"],
  "skipSnapshot": false
}
```

响应：`ArtboardStateResponse`，`selectedNodeId` 指向第一个移出的子节点。

### `POST /apply-visual-patch`

用途：应用 Web 提交的视觉字段 patch。默认不保存磁盘；可选择应用后立即渲染新截图。

请求：

```json
{
  "sessionId": "uuid",
  "patch": {
    "patchId": "uuid",
    "baseRevision": "r1",
    "operations": [
      {
        "op": "delta",
        "nodeId": "fileID:123456789",
        "field": "rectTransform.anchoredPosition",
        "value": [12, -8],
        "source": { "kind": "drag-end" }
      }
    ]
  },
  "dryRun": false,
  "renderAfter": true
}
```

响应：

```json
{
  "ok": true,
  "revision": "r2",
  "applied": [
    {
      "nodeId": "fileID:123456789",
      "field": "rectTransform.anchoredPosition",
      "before": [0, 0],
      "after": [12, -8]
    }
  ],
  "rejected": [],
  "protectedDiff": {
    "ok": true,
    "changedProtectedCount": 0
  },
  "snapshot": {}
}
```

如果 patch 包含非白名单字段，必须在 `rejected` 中返回原因，并且该字段不得被应用。

### `POST /validate-protected-diff`

用途：保存前检查本轮 session 的变更是否只触碰允许的视觉字段。

请求：

```json
{
  "sessionId": "uuid",
  "baseRevision": "r1",
  "currentRevision": "r2",
  "includeTextDiff": true
}
```

响应：

```json
{
  "ok": true,
  "validationId": "uuid",
  "allowedChanges": [
    {
      "nodeId": "fileID:123456789",
      "field": "rectTransform.anchoredPosition",
      "before": [0, 0],
      "after": [12, -8]
    }
  ],
  "protectedChanges": [],
  "summary": {
    "allowedCount": 1,
    "protectedCount": 0
  }
}
```

首版 protected diff 至少拦截：

- GameObject local fileID 改变。
- PrefabInstance source 或 nested Prefab 链接改变。
- `MonoBehaviour.m_Script` 改变。
- Lua/schema/items/data binding 字段改变。
- Button/Toggle/Input 事件接线改变。
- 非白名单组件增删。
- 非目标节点被误改。

### `POST /save-prefab`

用途：保存当前 session。首版只允许保存临时副本。

请求：

```json
{
  "sessionId": "uuid",
  "mode": "temp-copy",
  "validationId": "uuid",
  "note": "first MVP patch sample"
}
```

### `POST /save-artboard`

用途：保存当前画板。`targetPrefabPath` 为空时保存回 `sourcePrefabPath`；没有 source 的新 UI 必须传入目标路径。保存前内部执行 protected diff。

请求：

```json
{
  "sessionId": "uuid",
  "targetPrefabPath": "Assets/HotRes2/UIs/Prefabs/NewUI.prefab",
  "note": "remote artboard save"
}
```

响应：

```json
{
  "ok": true,
  "savedPath": "Assets/HotRes2/UIs/Prefabs/NewUI.prefab",
  "sourcePrefabPath": "Assets/HotRes2/UIs/Prefabs/NewUI.prefab",
  "workingPrefabPath": "Assets/Temp/UIEditorNew/NewUI__uieditor_new_blank_12345678.prefab",
  "revision": "r3",
  "protectedDiff": {
    "ok": true,
    "summary": {
      "allowedCount": 4,
      "protectedCount": 0
    }
  }
}
```

响应：

```json
{
  "ok": true,
  "savedPath": "Assets/Temp/UIEditorNew/UIBlueBtn__uieditor_tmp.prefab",
  "sourcePrefabPath": "Assets/HotRes2/UIs/Prefabs/UICommons/UIBlueBtn.prefab",
  "revision": "r2"
}
```

### `POST /close-prefab`

用途：关闭 session、卸载临时对象、释放 RenderTexture/Camera/Canvas。

请求：

```json
{
  "sessionId": "uuid",
  "deleteTempObjects": true
}
```

响应：

```json
{
  "ok": true
}
```

## 首批实现 TODO

### Unity Editor 侧

- [x] 新增独立目录 `Assets/Editor/UIEditorNew/`，不得修改 `Assets/Editor/UIEditor/` 作为新流程实现。
- [x] 新增 `UIEditorNewBridgeServer`，监听 `18082`，菜单前缀使用 `UIEditorNew/...`，健康检查返回 `UIEditorNewBridge`。
- [x] 从老 `UIEditorReferenceCapture` 复制 Prefab 归一化、实例化、Canvas/Camera/RenderTexture 渲染思路，形成独立 snapshot service。
- [x] 建立 session 管理：source prefab、working prefab、mode、revision、baseline 快照、临时对象清理。
- [x] 实现 `exportNodeTree`：导出 fileID、路径、父子关系、RectTransform、组件摘要、白名单/保护字段。
- [x] 实现 `renderSnapshot`：整图截图与节点 bbox 同帧返回，坐标系固定为 top-left pixel。
- [x] 实现 `applyVisualPatch`：只应用白名单字段，支持 dryRun 和 renderAfter。
- [~] 实现 `validateProtectedDiff`：已从逐行 YAML 白名单升级为 MVP 结构签名校验，比较对象类型、脚本引用、事件签名、组件/层级关系和非白名单 PrefabModification；后续仍需扩展字段级/组件级报告。
- [x] 实现 `savePrefab`：保留截图 MVP 的临时副本保存接口。
- [x] 实现 `saveArtboard`：新 UI 保存到用户指定路径；已有 UI 在 target 为空时写回 source Prefab，保存前执行 protected diff。
- [x] 验证老 `8081` 桥和新 `18082` 桥可同时存在，Unity 编译无重复类名冲突。

### Web 侧

- [x] 新增 `EditorBridgeClient`，替代默认主链路中的 `UnityBridge.ts`。
- [x] `EditorBridgeClient` 默认读取 `editorBridgeUrl`，目标为 `http://127.0.0.1:18082`，不连接老 `8081` 桥。
- [x] 新增截图底图组件：显示 `renderSnapshot` 图片，按 bbox 渲染 hover/selection/drag。
- [x] 新增 `RemoteArtboardEditor` 主入口：画板栏、Prefab 列表、截图叠加画布、图层树、属性面板、保存/关闭和撤销重做工具条。
- [x] 新增基础属性面板：对选中节点提交显隐、位置、尺寸、文本、字号/颜色、图片引用等白名单操作。
- [x] 新增外部 headless 浏览器烟测：`npm run smoke:bridge-web` 通过系统 Chrome/Edge DevTools Protocol 验证新建、保存、刷新恢复、打开样本、插入子 Prefab 和关闭清理，不依赖 Codex 内置浏览器。
- [x] 节点编辑接入 200ms 交互确认：Web 乐观更新属性和 bbox，Bridge 操作使用 `skipSnapshot`，截图刷新排入串行队列并取消过期刷新；外部 smoke 已拆分 `interactionLatency` 和 `unityRoundtripLatency`。
- [x] 节点编辑改为内存 working root：高频操作不再逐次 `SaveAsPrefabAsset`，15 秒 idle 自动落盘；`UIBlueBtn` / `UIAlert2` 直接 profile 中 `move-node(skipSnapshot)` 已降到约 1-6ms 的 Unity 执行时间。
- [~] 改造 `SelectionOverlay`：首版没有直接复用旧 `SelectionOverlay`，而是在 `RemoteArtboardEditor` 内独立实现 bbox 选择和拖拽；后续需要抽成通用 overlay 模型。
- [~] 改造 Toolbar：新流程 MVP 工具条暂时放在 `RemoteArtboardEditor` 内；全局 Toolbar 后续再拆掉旧同步按钮或改为调用新 session。
- [ ] 改造缩略图生成：无缓存时请求 `renderSnapshot`，不等待 WebGL ready。
- [ ] 隔离旧 MCP/WebGL 告警：不让旧链路失败影响新流程服务状态。
- [x] 建立两个低风险样本闭环：`UICommons/UIBlueBtn.prefab` 与 `UICommons/UIAlert2.prefab` 临时副本已通过 Web 完成 open -> export -> render -> drag patch -> validate -> save。

## MVP 验收

- [x] 不恢复 `/unity/Build` 也能看到 Unity 真值截图。
- [x] 不占用或修改老 UIEditor 的 `8081` 桥接服务；新桥监听 `18082`。
- [x] Web 能基于 Unity bbox 选择节点并拖动 overlay。
- [x] 松手后 Web 先乐观移动 overlay，Unity 异步应用 patch，再刷新真值截图。
- [x] Web 属性面板能提交基础视觉字段 patch，并通过 `UIAlert2/okText` 的 `Text.text` 与 `Text.color` 外部 headless 烟测。
- [x] 用户可见交互反馈低于 200ms：`UIAlert2` 复测最大 29ms，`UIBlueBtn` 复测最大 31ms。
- [~] 保存前 protected diff 能证明只改了白名单视觉字段。当前已通过 `UIBlueBtn` 与 `UIAlert2` 样本验证 `protectedCount=0`，并能避免 Prefab Variant modification 重排的行级误报；后续仍需输出更细的字段级/组件级审计报告。
- [x] 保存语义已拆分：新 UI 保存到用户指定路径；已有 UI 默认写回 source Prefab。正式样本烟测不覆盖 `UICommons`，写回 source 使用临时 source Prefab 验证。

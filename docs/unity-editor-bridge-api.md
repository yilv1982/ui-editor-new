# Unity Editor Bridge API 草案

更新时间：2026-06-22。

本文件定义 `uieditor-new` 截图式受控视觉编辑链路需要的 Unity Editor 本地 HTTP API。当前 Unity 工程已有 `UIEditorCorsProxy`、`UIEditorBridgeSync`、`UIEditorReferenceCapture` 三个候选脚本，已能提供 `/health`、`/sync-preview`、`/sync-incremental`、`/capture-reference`。新流程不直接把这些旧同步接口作为目标 API，而是在其基础上收敛出面向截图编辑、patch 回放和 protected diff 的稳定契约。

## 原则

- Unity Editor 是资产事实和视觉真值服务。
- Web 不访问 `AssetDatabase`，只通过本地 HTTP API 请求 Unity Editor 打开、导出、截图、回放、校验和保存。
- Web 不保存完整 Prefab 序列化内容，只提交白名单视觉字段 patch。
- 默认操作临时副本；正式 Prefab 保存必须经过 protected diff。
- 每次 patch 都要绑定基线 revision，避免旧截图上的拖动覆盖新状态。
- API 返回的 bbox 与截图必须来自同一次 Unity 渲染，不能混用静态解析坐标和旧截图。

## 现有可复用能力

| 现有端点/脚本 | 当前能力 | 新流程处理 |
| --- | --- | --- |
| `GET /health` | 返回 `{"ok":true,"name":"UIEditorCorsProxy"}` | 保留，增加版本和 capability 列表 |
| `POST /capture-reference` | 加载 Prefab、实例化、渲染 PNG、返回目标 rect 和 Graphic 信息 | 改造为 `renderSnapshot` 的基础实现 |
| `POST /sync-preview` | 将 Web 导出的 JSON 构造成 Unity 预览对象 | 旧链路保留，不作为新流程主 API |
| `POST /sync-incremental` | 将 Web 导出的 JSON 增量写回原 Prefab | 不作为新流程保存 API；后续由 `applyVisualPatch` + `validateProtectedDiff` + `savePrefab` 取代 |
| `UIEditorReferenceCapture` | 使用 `AssetDatabase`、`PrefabUtility.InstantiatePrefab`、`RenderTexture`、Canvas/Camera 渲染 | 复用渲染和 Graphic 收集逻辑，扩展到全节点 bbox |
| `UIEditorBridgeSync` | 能 `LoadPrefabContents` 和 `SaveAsPrefabAsset` | 只借鉴加载/保存方式，写回必须改为字段白名单和 protected diff |

## 通用约定

默认地址：

```text
http://127.0.0.1:8081
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
  "name": "UIEditorCorsProxy",
  "version": "uieditor-new-bridge-draft-1",
  "projectPath": "E:/Projects/Dreamland/fact-source/DreamlandProject",
  "capabilities": [
    "openPrefab",
    "exportNodeTree",
    "renderSnapshot",
    "applyVisualPatch",
    "validateProtectedDiff",
    "savePrefab"
  ]
}
```

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

- [ ] 扩展 `UIEditorCorsProxy` 路由，新增上述 endpoint，并保留 `/health`、`/capture-reference` 兼容入口。
- [ ] 抽出 `UIEditorReferenceCapture` 的 Prefab 归一化、实例化、Canvas/Camera/RenderTexture 渲染能力，形成可复用 snapshot service。
- [ ] 建立 session 管理：source prefab、working prefab、mode、revision、baseline 快照、临时对象清理。
- [ ] 实现 `exportNodeTree`：导出 fileID、路径、父子关系、RectTransform、组件摘要、白名单/保护字段。
- [ ] 实现 `renderSnapshot`：整图截图与节点 bbox 同帧返回，坐标系固定为 top-left pixel。
- [ ] 实现 `applyVisualPatch`：只应用白名单字段，支持 dryRun 和 renderAfter。
- [ ] 实现 `validateProtectedDiff`：保存前对比 baseline 与 current，列出 allowed/protected 变更。
- [ ] 实现 `savePrefab`：首版只保存 temp-copy，不直接覆盖正式业务 Prefab。

### Web 侧

- [ ] 新增 `EditorBridgeClient`，替代默认主链路中的 `UnityBridge.ts`。
- [ ] 新增截图底图组件：显示 `renderSnapshot` 图片，按 bbox 渲染 hover/selection/drag handle。
- [ ] 改造 `SelectionOverlay`：拖动期间只更新本地 overlay；松手后提交 patch，等待 Unity 回包刷新截图和 bbox。
- [ ] 改造 Toolbar：提供打开 Prefab、刷新截图、提交 patch、校验 diff、保存副本按钮。
- [ ] 改造缩略图生成：无缓存时请求 `renderSnapshot`，不等待 WebGL ready。
- [ ] 隔离旧 MCP/WebGL 告警：不让旧链路失败影响新流程服务状态。
- [ ] 建立一个低风险样本闭环：`UICommons/UIBlueBtn.prefab` 临时副本，完成 open -> export -> render -> patch -> validate -> save。

## MVP 验收

- [ ] 不恢复 `/unity/Build` 也能看到 Unity 真值截图。
- [ ] Web 能基于 Unity bbox 选择节点并拖动 overlay。
- [ ] 松手后 Unity 应用 patch 并返回新截图。
- [ ] 保存前 protected diff 能证明只改了白名单视觉字段。
- [ ] 首轮保存目标是临时副本，不改正式业务 Prefab。

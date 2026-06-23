# UIEditor_new 试点样本闭环记录

更新时间：2026-06-22。

本记录把 `UIEditor_new` 首轮两个试点 UI 样本按同一条流程沉淀下来：

```text
需求/组件计划 -> 截图式编辑 -> Unity 回放 -> 保护校验 -> 文档/规则沉淀
```

两个正式样本都只使用 `temp-copy`，不覆盖正式业务 Prefab。保存回 source 的语义使用 `Assets/Temp/UIEditorNew/CodexExistingSource.prefab` 临时 source 验证。

## 验收摘要

| 样本 | 需求类型 | Prefab | Web 截图编辑 | Unity 回放 | protected diff | 临时副本保存 |
| --- | --- | --- | --- | --- | --- | --- |
| S1 | 主按钮文字节点微调 | `UICommons/UIBlueBtn.prefab` | 通过 | applied 1, rejected 0 | allowed 1, protected 0 | 通过 |
| S2 | 弹窗确认按钮文字节点微调 | `UICommons/UIAlert2.prefab` | 通过 | applied 1, rejected 0 | allowed 1, protected 0 | 通过 |
| S2 属性补测 | 弹窗确认按钮文本与颜色调整 | `UICommons/UIAlert2.prefab` | 通过 | applied 2, rejected 0 | allowed 2, protected 0 | 通过 |

## RemoteArtboardEditor 复测

2026-06-22 已用外部 headless Chrome/Edge 复测当前主入口 `RemoteArtboardEditor`：

| 样本 | 打开为画板 | 新建/编辑/保存新 UI | 刷新恢复 | 插入子 Prefab | 关闭删除临时 Prefab |
| --- | --- | --- | --- | --- | --- |
| `UICommons/UIAlert2.prefab` | 20 个 bbox | 通过 | 2 个 bbox | 插入后 22 个 bbox | 2 个临时 Prefab 均删除 |
| `UICommons/UIBlueBtn.prefab` | 2 个 bbox | 通过 | 2 个 bbox | 插入后 4 个 bbox | 2 个临时 Prefab 均删除 |

同轮 smoke 覆盖了新增文字、文本修改、字号/颜色、位置、尺寸、新增图片、删除、undo、redo、保存新 UI、浏览器刷新恢复、打开现存 UI、拖入现存 UI 作为子节点、关闭画板删除临时 Prefab。

延迟与视觉一致性复测结果：

| 样本 | 最大交互确认耗时 | 高频节点操作 Unity 执行 | 最大 Unity 后台耗时 | 保存后重开截图一致性 |
| --- | --- | --- | --- | --- |
| `UICommons/UIAlert2.prefab` | 28ms | `move-node(skipSnapshot)` 约 6.1ms | 1015ms（保存新 UI） | SHA-256 完全一致 |
| `UICommons/UIBlueBtn.prefab` | 30ms | `move-node(skipSnapshot)` 约 0.9ms | 1056ms（保存新 UI） | SHA-256 完全一致 |

Unity 后台耗时包含 Bridge 打开、保存、关闭、protected diff 和截图刷新等真值动作；用户可见交互反馈以 `interactionLatency` 为准。节点编辑已改为 Unity 内存 working root 承接高频操作，15 秒无修改后自动异步落盘，保存/校验时强制 flush。

保存回 source 语义通过临时 source Prefab 验证：`targetPrefabPath` 为空时 `save-artboard` 写回 `sourcePrefabPath`，protected diff 通过且 source YAML 包含修改后的文本。

## S1: 主按钮样本

### 组件计划

```json
{
  "schemaVersion": "uieditor-new.component-plan.v1",
  "requestId": "trial-s1-primary-button",
  "source": {
    "kind": "trial-ui-requirement",
    "title": "主按钮文字节点位置微调"
  },
  "prefab": {
    "prefabPath": "UICommons/UIBlueBtn.prefab",
    "mode": "temp-copy"
  },
  "components": [
    {
      "componentId": "common.button.primary-blue",
      "displayName": "蓝色主按钮",
      "sourcePrefabPath": "UICommons/UIBlueBtn.prefab",
      "targetNodePath": "UIBlueBtn/text",
      "requirementTags": ["button", "primary-action", "text-label"],
      "editableIntent": ["rectTransform.anchoredPosition"],
      "protectedExpectations": [
        "MonoBehaviour.m_Script",
        "Button.onClick",
        "Lua/schema bindings",
        "PrefabInstance source",
        "GameObject fileID"
      ]
    }
  ],
  "validationGates": [
    "unitySnapshotRendered",
    "visualPatchApplied",
    "protectedDiffPassed",
    "tempCopySaved"
  ]
}
```

### 结果

```json
{
  "schemaVersion": "uieditor-new.controlled-result.v1",
  "requestId": "trial-s1-primary-button",
  "status": "passed",
  "session": {
    "sourcePrefabPath": "Assets/HotRes2/UIs/Prefabs/UICommons/UIBlueBtn.prefab",
    "workingPrefabPath": "Assets/Temp/UIEditorNew/UIBlueBtn__uieditor_new_tmp_65f98932.prefab",
    "mode": "temp-copy",
    "baseRevision": "r1",
    "finalRevision": "r2"
  },
  "snapshot": {
    "width": 1080,
    "height": 1920,
    "coordinateSpace": "top-left-pixel",
    "nodeCount": 2
  },
  "patchSummary": {
    "appliedCount": 1,
    "rejectedCount": 0,
    "operations": [
      {
        "path": "UIBlueBtn/text",
        "field": "rectTransform.anchoredPosition",
        "source": "drag-end"
      }
    ]
  },
  "protectedDiff": {
    "allowedCount": 1,
    "protectedCount": 0
  },
  "save": {
    "savedPath": "Assets/Temp/UIEditorNew/UIBlueBtn__uieditor_new_tmp_65f98932.prefab"
  }
}
```

## S2: 弹窗样本

### 组件计划

```json
{
  "schemaVersion": "uieditor-new.component-plan.v1",
  "requestId": "trial-s2-alert-dialog",
  "source": {
    "kind": "trial-ui-requirement",
    "title": "弹窗确认按钮文字节点位置微调"
  },
  "prefab": {
    "prefabPath": "UICommons/UIAlert2.prefab",
    "mode": "temp-copy"
  },
  "components": [
    {
      "componentId": "common.dialog.alert-two-button",
      "displayName": "双按钮提示弹窗",
      "sourcePrefabPath": "UICommons/UIAlert2.prefab",
      "targetNodePath": "UIAlert2/dl2_ui_p_btns_002/okBtn/okText",
      "requirementTags": ["dialog", "confirm-action", "button", "text-label"],
      "dataInputs": [
        {
          "name": "title",
          "type": "string",
          "targetField": "Text.text",
          "required": true
        },
        {
          "name": "message",
          "type": "string",
          "targetField": "Text.text",
          "required": true
        }
      ],
      "eventOutputs": [
        {
          "name": "onConfirm",
          "owner": "client-code",
          "protected": true
        },
        {
          "name": "onCancel",
          "owner": "client-code",
          "protected": true
        }
      ],
      "editableIntent": ["rectTransform.anchoredPosition"],
      "protectedExpectations": [
        "MonoBehaviour.m_Script",
        "Button.onClick",
        "Lua/schema bindings",
        "PrefabInstance source",
        "GameObject fileID"
      ]
    }
  ],
  "validationGates": [
    "unitySnapshotRendered",
    "visualPatchApplied",
    "protectedDiffPassed",
    "tempCopySaved"
  ]
}
```

### 结果

```json
{
  "schemaVersion": "uieditor-new.controlled-result.v1",
  "requestId": "trial-s2-alert-dialog",
  "status": "passed",
  "session": {
    "sourcePrefabPath": "Assets/HotRes2/UIs/Prefabs/UICommons/UIAlert2.prefab",
    "workingPrefabPath": "Assets/Temp/UIEditorNew/UIAlert2__uieditor_new_tmp_4df7f092.prefab",
    "mode": "temp-copy",
    "baseRevision": "r1",
    "finalRevision": "r2"
  },
  "snapshot": {
    "width": 1080,
    "height": 1920,
    "coordinateSpace": "top-left-pixel",
    "nodeCount": 29
  },
  "patchSummary": {
    "appliedCount": 1,
    "rejectedCount": 0,
    "operations": [
      {
        "path": "UIAlert2/dl2_ui_p_btns_002/okBtn/okText",
        "field": "rectTransform.anchoredPosition",
        "source": "drag-end"
      }
    ]
  },
  "protectedDiff": {
    "allowedCount": 1,
    "protectedCount": 0
  },
  "save": {
    "savedPath": "Assets/Temp/UIEditorNew/UIAlert2__uieditor_new_tmp_4df7f092.prefab"
  }
}
```

### 属性面板补测

`S2` 继续作为属性字段 patch 样本，目标节点仍为 `dl2_ui_p_btns_002/okBtn/okText`。该补测通过外部 headless Chrome/Edge 脚本执行，避免依赖 Codex 内置浏览器：

```bash
npm run smoke:bridge-web
```

结果：

```json
{
  "schemaVersion": "uieditor-new.controlled-result.v1",
  "requestId": "trial-s2-alert-dialog-property-panel",
  "status": "passed",
  "prefabPath": "UICommons/UIAlert2.prefab",
  "targetNodePath": "UIAlert2/dl2_ui_p_btns_002/okBtn/okText",
  "nodeId": "fileID:6811332041609624526",
  "patchSummary": {
    "appliedCount": 2,
    "rejectedCount": 0,
    "operations": [
      {
        "field": "Text.text",
        "value": "Pilot OK",
        "source": "property-panel"
      },
      {
        "field": "Text.color",
        "value": "#E64553FF",
        "source": "property-panel"
      }
    ]
  },
  "protectedDiff": {
    "allowedCount": 2,
    "protectedCount": 0
  },
  "save": {
    "savedPath": "Assets/Temp/UIEditorNew/UIAlert2__uieditor_new_tmp_b9cb2782.prefab"
  },
  "artifacts": {
    "reportPath": ".cache/editor-bridge-web-smoke/latest/report.json",
    "screenshotPath": ".cache/editor-bridge-web-smoke/latest/success.png"
  }
}
```

## 规则沉淀

- `UIEditor_new` 的样本输入应使用 `componentUsagePlan`，输出使用 `controlledEditResult`；契约见 `component-library-io-contract.md`。
- 首轮试点默认使用 `temp-copy`，保存结果只认 `Assets/Temp/UIEditorNew/` 下的临时副本。
- Web 叠加层只提交白名单视觉字段；当前两个基础样本使用 `rectTransform.anchoredPosition`，属性补测已覆盖 `Text.text` 和 `Text.color`。
- protected diff 不能继续使用逐行 YAML 对齐；`UIAlert2` 验证表明 Prefab Variant 保存会重排 `m_Modifications`，逐行 diff 会误报大量 protected changes。
- 当前新桥已升级为 MVP 结构签名校验：比较 Unity YAML 对象类型、脚本引用、事件签名、组件/层级关系和非白名单 PrefabModification；允许的变更来自已应用的白名单 patch。
- 后续仍需为 `Text.fontSize`、`Image.color`、`RectTransform.sizeDelta` 和 `Image.sprite` 补更多样本，并把 protected diff 的签名分类扩展到字段级报告。

# UI 公共组件库输入输出契约

更新时间：2026-06-22。

本文件定义 UI 公共组件库与 `UIEditor_new` 之间的最小可执行 I/O 契约。它服务 Phase 2 试点前的闭环验证：组件库负责把需求转成组件使用计划，`UIEditor_new` 负责在 Unity 真值截图上做受控视觉编辑、保护校验和临时副本输出。

## 边界

- 组件库不直接写 Prefab，也不依赖 `UIEditor_new` 的 React 组件或内部 store。
- `UIEditor_new` 不负责判断需求语义是否正确，只消费组件库给出的组件计划、Prefab 样本、允许编辑意图和校验 gate。
- 双方只交换结构化 JSON、Unity Bridge session 信息、patch/diff/snapshot 结果和文档回填建议。
- 首轮只允许 `temp-copy` 模式；`source` 模式仍禁用。

## 输入：Component Usage Plan

组件库给 `UIEditor_new` 的输入是 `componentUsagePlan`：

```json
{
  "schemaVersion": "uieditor-new.component-plan.v1",
  "requestId": "ui-trial-reward-card-001",
  "source": {
    "kind": "trial-ui-requirement",
    "title": "奖励展示按钮视觉微调",
    "owner": "agent",
    "evidenceRefs": []
  },
  "canvas": {
    "width": 1080,
    "height": 1920,
    "backgroundColor": "#162D3FFF"
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
      "targetNodePath": "UIBlueBtn",
      "variant": "default",
      "requirementTags": ["button", "primary-action"],
      "dataInputs": [
        {
          "name": "label",
          "type": "string",
          "targetField": "Text.text",
          "required": true
        }
      ],
      "eventOutputs": [
        {
          "name": "onClick",
          "owner": "client-code",
          "protected": true
        }
      ],
      "editableIntent": [
        "rectTransform.anchoredPosition",
        "rectTransform.sizeDelta",
        "Text.text",
        "Text.fontSize",
        "Text.color",
        "Image.color"
      ],
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

## 输出：Controlled Edit Result

`UIEditor_new` 返回给组件库/Agent 的结果是 `controlledEditResult`：

```json
{
  "schemaVersion": "uieditor-new.controlled-result.v1",
  "requestId": "ui-trial-reward-card-001",
  "status": "passed",
  "session": {
    "sourcePrefabPath": "Assets/HotRes2/UIs/Prefabs/UICommons/UIBlueBtn.prefab",
    "workingPrefabPath": "Assets/Temp/UIEditorNew/UIBlueBtn__uieditor_new_tmp_65f98932.prefab",
    "mode": "temp-copy",
    "baseRevision": "r1",
    "finalRevision": "r2"
  },
  "snapshots": [
    {
      "kind": "before",
      "snapshotId": "uuid",
      "width": 1080,
      "height": 1920,
      "coordinateSpace": "top-left-pixel"
    },
    {
      "kind": "after",
      "snapshotId": "uuid",
      "width": 1080,
      "height": 1920,
      "coordinateSpace": "top-left-pixel"
    }
  ],
  "patchSummary": {
    "appliedCount": 1,
    "rejectedCount": 0,
    "operations": [
      {
        "nodeId": "fileID:123456789",
        "path": "UIBlueBtn/text",
        "field": "rectTransform.anchoredPosition",
        "source": "drag-end"
      }
    ]
  },
  "protectedDiff": {
    "validationId": "uuid",
    "allowedCount": 1,
    "protectedCount": 0,
    "blockedFields": []
  },
  "save": {
    "savedPath": "Assets/Temp/UIEditorNew/UIBlueBtn__uieditor_new_tmp_65f98932.prefab",
    "sourcePrefabPath": "Assets/HotRes2/UIs/Prefabs/UICommons/UIBlueBtn.prefab"
  },
  "ruleBacklog": [
    {
      "target": "protected-diff",
      "kind": "upgrade-needed",
      "note": "首版仍是 YAML 行级白名单，需升级为结构化字段/组件审计。"
    }
  ]
}
```

## 状态枚举

| status | 含义 |
| --- | --- |
| `passed` | Unity 截图、patch 回放、protected diff 和临时副本保存均通过 |
| `patch-rejected` | 视觉 patch 中存在非白名单字段或节点未命中 |
| `protected-blocked` | protected diff 命中保护字段，不能保存 |
| `render-failed` | Unity 真值截图失败 |
| `manual-review` | 编辑完成但存在待人工确认的规则或视觉差异 |

## 必须保持的验证 gate

- `unitySnapshotRendered`：至少有一张来自 Unity Editor Bridge 的真值截图。
- `visualPatchApplied`：至少一个 patch 由 Unity 回放确认，或明确说明本轮无编辑动作。
- `protectedDiffPassed`：保存前必须有 `protectedCount = 0` 的校验结果。
- `tempCopySaved`：首轮只承认临时副本保存路径，不承认直接覆盖正式 Prefab。
- `ruleBacklogRecorded`：无法在当前工具内闭合的规则必须进入文档或后续 TODO，而不是静默跳过。

## 与试点样本的关系

首轮两个试点 UI 样本都应产出同一格式的 `componentUsagePlan` 和 `controlledEditResult`。当前已用 `UIBlueBtn` 覆盖单组件低风险按钮样本，用 `UIAlert2` 覆盖包含 Text/Image、多节点容器和 Prefab Variant modification 重排风险的弹窗样本；两个样本的组件计划、编辑结果和规则沉淀见 `trial-samples.md`。

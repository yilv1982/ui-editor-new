# UIEditor-New 文档入口

本目录只承接 `uieditor-new` 新截图式编辑链路的当前文档。

旧 UIEditor 复制来的 LOA 文档、历史计划、旧 WebGL/MCP 方案、UE 导出方案和视觉探针说明已清理，不再作为本分支依据。当前工作背景、目标和 TODO 见根目录 `WORKITEM.md`。

当前文档：

- `baseline-smoke.md`：复制清理后的构建、启动、接口和 Unity 本地代理基线烟测。
- `webgl-dependency-map.md`：旧 WebGL 主画布、StoreSync、UnityBridge、MCP、缩略图和视觉探针依赖的替换/保留策略。
- `unity-editor-bridge-api.md`：截图式编辑链路所需的 Unity Editor Bridge HTTP API 草案和首批实现 TODO。

后续新增文档应围绕以下主题：

- Unity Editor Bridge API。
- Prefab 节点元数据和截图坐标系。
- Web 截图叠加编辑层。
- 视觉字段白名单与 protected diff 审计。
- 样本 Prefab 验证记录。

import type { Plugin } from 'vite';
import fs from 'fs';
import path from 'path';
import { ProxyAgent } from 'undici';
import { PROJECT_ROOT, ASSET_PATHS } from '../config/unityPaths';
import { loadPrefabAsRefStructure } from './prefabRefLoader';
import { loadActivityFrameTree, mergeContentIntoFrame } from './activityFrameLoader';

// ──────── Prefab 层级提取（为 AI 提供真实项目范例） ────────

function extractPrefabHierarchy(prefabPath: string, maxDepth = 6): string | null {
  try {
    const content = fs.readFileSync(prefabPath, 'utf-8');
    const gameObjects = new Map<string, string>();
    const transforms = new Map<string, { goId: string; children: string[]; fatherId: string }>();
    const docs = content.split(/^---\s/m);
    for (const doc of docs) {
      const goMatch = doc.match(/!u!1\s+&(\d+)\n[\s\S]*?m_Name:\s*(.+)/);
      if (goMatch) gameObjects.set(goMatch[1], goMatch[2].trim());
      const rtMatch = doc.match(/!u!224\s+&(\d+)\n[\s\S]*?m_GameObject:\s*\{fileID:\s*(\d+)\}[\s\S]*?m_Children:\s*([\s\S]*?)m_Father:\s*\{fileID:\s*(\d+)\}/);
      if (rtMatch) {
        const children: string[] = [];
        for (const cm of rtMatch[3].matchAll(/fileID:\s*(\d+)/g)) children.push(cm[1]);
        transforms.set(rtMatch[1], { goId: rtMatch[2], children, fatherId: rtMatch[4] });
      }
    }
    function build(tId: string, depth: number): string | null {
      if (depth > maxDepth) return '  '.repeat(depth) + '...';
      const t = transforms.get(tId);
      if (!t) return null;
      const name = gameObjects.get(t.goId);
      if (!name) return null;
      let r = '  '.repeat(depth) + name;
      for (const c of t.children) {
        const ch = build(c, depth + 1);
        if (ch) r += '\n' + ch;
      }
      return r;
    }
    for (const [tId, t] of transforms) {
      if (t.fatherId === '0') return build(tId, 0);
    }
  } catch {}
  return null;
}

// 质量评分：规范命名的 prefab 得分高
function scorePrefabHierarchy(hier: string): number {
  let score = 0;
  if (/\bCtn_/.test(hier)) score += 3;
  if (/\bbtn_/.test(hier)) score += 2;
  if (/\btxt_/.test(hier)) score += 2;
  if (/\bimg_|\bImg_/.test(hier)) score += 1;
  if (/@Part_/.test(hier)) score += 2;
  if (/ScrollView/.test(hier)) score += 1;
  // 至少3层嵌套才算有结构
  const lines = hier.split('\n');
  const maxIndent = Math.max(...lines.map(l => (l.match(/^ */)?.[0].length || 0) / 2));
  if (maxIndent >= 3) score += 2;
  if (lines.length < 8) score -= 5; // 太简单的不要
  if (lines.length > 80) score -= 3; // 太复杂的也不要
  return score;
}

let _cachedExamples: string | null = null;
let _cacheTime = 0;
const CACHE_TTL = 10 * 60 * 1000; // 10 min

function samplePrefabExamples(count = 5): string {
  const now = Date.now();
  if (_cachedExamples && now - _cacheTime < CACHE_TTL) return _cachedExamples;

  const prefabRoot = PROJECT_ROOT + '/' + ASSET_PATHS.prefab;
  try {
    const categories = fs.readdirSync(prefabRoot, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name !== 'CommonPart' && d.name !== 'Part');
    const prefabs: string[] = [];
    for (const cat of categories) {
      try {
        const files = fs.readdirSync(path.join(prefabRoot, cat.name))
          .filter(f => f.endsWith('.prefab') && f.startsWith('UI_'));
        for (const f of files) prefabs.push(path.join(prefabRoot, cat.name, f));
      } catch {}
    }
    if (prefabs.length === 0) return '';

    // 随机抽 30 个候选，按质量评分排序，取前 count 个
    const candidates = prefabs.sort(() => Math.random() - 0.5).slice(0, Math.min(30, prefabs.length));
    const scored = candidates.map(p => {
      const hier = extractPrefabHierarchy(p);
      return { path: p, hier, score: hier ? scorePrefabHierarchy(hier) : -999 };
    }).filter(x => x.hier && x.score >= 5)
      .sort((a, b) => b.score - a.score)
      .slice(0, count);

    const examples = scored.map(s => `### ${path.basename(s.path, '.prefab')}\n\`\`\`\n${s.hier}\n\`\`\``);
    _cachedExamples = examples.join('\n\n');
    _cacheTime = now;
    return _cachedExamples;
  } catch {}
  return '';
}

const CONFIG_PATH = path.join(process.cwd(), 'ai-config.json');

interface AIConfig {
  anthropicApiKey: string;
  model: string;
  baseUrl: string;
  httpProxy: string;  // 本地代理地址，如 http://127.0.0.1:7890
}

const DEFAULT_BASE_URL = 'https://api.anthropic.com';

function readConfig(): AIConfig {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
      return { baseUrl: DEFAULT_BASE_URL, httpProxy: '', ...raw };
    }
  } catch {}
  return { anthropicApiKey: '', model: 'claude-opus-4-6', baseUrl: DEFAULT_BASE_URL, httpProxy: '' };
}

function writeConfig(config: AIConfig): void {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

// ──────── 节点简化 ────────

interface SimplifiedNode {
  id: string;
  name: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  componentRef?: string;
  text?: string;
  imagePath?: string;
  children: SimplifiedNode[];
}

interface SimplifiedRefNode {
  name: string;
  type: string;
  componentRef?: string;
  children?: SimplifiedRefNode[];
}

interface SkeletonSlot {
  id: string;
  name: string;
  type: string;
  componentRef?: string;
  isContainer: boolean;
  repeatable: boolean;
  children?: SkeletonSlot[];
}

interface SkeletonResult {
  root: SkeletonSlot;
  text: string;
  slotMap: Map<string, SkeletonSlot>;
}

function generateSkeleton(refTree: SimplifiedRefNode): SkeletonResult {
  let counter = 0;
  const slotMap = new Map<string, SkeletonSlot>();

  function walk(node: SimplifiedRefNode, parentIsScrollView: boolean): SkeletonSlot {
    counter++;
    const id = `S${counter}`;
    const isContainer = !!(node.children && node.children.length > 0);
    const nameLC = node.name.toLowerCase();
    const isScrollView = node.type === 'scrollview'
      || nameLC.startsWith('scroll')
      || nameLC.startsWith('looplist');

    const slot: SkeletonSlot = {
      id,
      name: node.name,
      type: node.type,
      componentRef: node.componentRef,
      isContainer,
      repeatable: parentIsScrollView,
    };

    if (node.children && node.children.length > 0) {
      slot.children = node.children.map(c => walk(c, isScrollView));
    }

    slotMap.set(id, slot);
    return slot;
  }

  const root = walk(refTree, false);

  function toText(slot: SkeletonSlot, indent: number): string {
    const prefix = '  '.repeat(indent);
    const repeatMark = slot.repeatable ? '*' : '';
    const containerMark = slot.isContainer ? ' {container}' : '';
    let line = `${prefix}[${slot.id}${repeatMark}] ${slot.name} (${slot.type})${containerMark}`;
    if (slot.componentRef) line += ` ref=${slot.componentRef}`;
    if (!slot.children) return line;
    return line + '\n' + slot.children.map(c => toText(c, indent + 1)).join('\n');
  }

  return { root, text: toText(root, 0), slotMap };
}

function simplifyNodes(
  nodes: Record<string, any>,
  rootIds: string[],
): SimplifiedNode[] {
  function simplify(nodeId: string): SimplifiedNode | null {
    const n = nodes[nodeId];
    if (!n) return null;
    const result: SimplifiedNode = {
      id: n.id,
      name: n.name,
      type: n.type,
      x: Math.round(n.x),
      y: Math.round(n.y),
      width: Math.round(n.width),
      height: Math.round(n.height),
      children: [],
    };
    if (n.componentRef) result.componentRef = n.componentRef;
    if (n.text) result.text = n.text.slice(0, 50);
    if (n.imageData && typeof n.imageData === 'string' && !n.imageData.startsWith('data:')) {
      result.imagePath = n.imageData;
    }
    result.children = (n.children || [])
      .map((cid: string) => simplify(cid))
      .filter(Boolean) as SimplifiedNode[];
    return result;
  }
  return rootIds.map(id => simplify(id)).filter(Boolean) as SimplifiedNode[];
}

interface FlatCanvasNode {
  id: string;
  type: string;
  absX: number;
  absY: number;
  width: number;
  height: number;
  text?: string;
  imagePath?: string;
}

// SimplifiedNode.x/y 是相对父节点的偏移量，这里递归累加得到绝对坐标
function flattenSimplified(nodes: SimplifiedNode[]): FlatCanvasNode[] {
  const result: FlatCanvasNode[] = [];
  function walk(node: SimplifiedNode, parentAbsX: number, parentAbsY: number) {
    const absX = parentAbsX + node.x;
    const absY = parentAbsY + node.y;
    result.push({
      id: node.id,
      type: node.type,
      absX: Math.round(absX),
      absY: Math.round(absY),
      width: node.width,
      height: node.height,
      text: node.text,
      imagePath: node.imagePath,
    });
    for (const child of node.children) {
      walk(child, absX, absY);
    }
  }
  for (const root of nodes) walk(root, 0, 0);
  return result;
}

function formatCanvasTable(flat: FlatCanvasNode[]): string {
  const header = 'id | type | x | y | w | h | text | imagePath';
  const separator = '---|------|---|---|---|---|------|----------';
  const rows = flat.map(n => {
    const text = n.text ? n.text.slice(0, 30) : '';
    const img = n.imagePath || '';
    return `${n.id} | ${n.type} | ${n.absX} | ${n.absY} | ${n.width} | ${n.height} | ${text} | ${img}`;
  });
  return [header, separator, ...rows].join('\n');
}

// 简化为 id+name+type+children 树（不带坐标），仅作为 AI 理解元素身份的参考
function simplifyForReference(nodes: SimplifiedNode[]): any[] {
  function walk(n: SimplifiedNode): any {
    const r: any = { id: n.id, name: n.name, type: n.type };
    if (n.children && n.children.length > 0) {
      r.children = n.children.map(walk);
    }
    return r;
  }
  return nodes.map(walk);
}

// ──────── 系统提示词 ────────

function buildSystemPrompt(): string {
  return `You are a Unity UI expert working on the LOA game project. Your task is to normalize UI node names and hierarchy to follow the project's strict naming conventions.

## Naming Conventions

Node names MUST follow these prefix rules based on their visual function:

| Prefix | Node Type | Usage | Examples |
|--------|-----------|-------|----------|
| btn_ | button | Interactive clickable elements | btn_Close, btn_Buy, btn_Confirm, btn_Tab1 |
| txt_ or text_ | text | Non-interactive text labels | txt_title, txt_desc, txt_name, txt_count |
| img_ or Img_ | image | Decorative or informational images | img_Bg, img_icon, img_arrow, img_banner |
| Ctn_ or ctn_ | frame | Containers grouping child elements | Ctn_Main, Ctn_Bottom, Ctn_Rewards, Ctn_Tabs |
| go_ | frame | Generic logical groups | go_sellOut, go_effect, go_lockItem |
| @Part_ | component | Reusable prefab components | @Part_Item, @Part_UserHead, @Part_Btn_Blue |
| ScrollView | scrollview | Scroll containers | ScrollView |
| LoopList | scrollview | Loop/virtual list | LoopList_User |
| Viewport | frame | Viewport inside ScrollView | Viewport |
| Content | frame | Content container inside Viewport | Content |
| Cell | frame | List item template | Cell |
| List_ | frame | List container | List_Reward |
| group_ | frame | Visual group | group_title |
| i# | text | Localized text key reference | i#free |

## Known Reusable Components (Part_ prefabs)

When you see elements matching these functions, suggest using the component reference:

**Buttons**: Part_Btn_Blue, Part_Btn_Blue2, Part_Btn_Blue_Cost, Part_Btn_Blue_Time, Part_Btn_Yellow, Part_Btn_Yellow2, Part_Btn_Yellow_Cost, Part_Btn_Yellow_Time, Part_Btn_Red, Part_Btn_Red2, Part_Btn_Payment, Part_Btn_Payment_Sale
**Common UI**: Part_Header (panel top bar w/ title+close), Part_CloseBg (close X button 60x60), Part_CloseBlurBg, Part_BlackUI, Part_RedPoint (notification dot 30x30), Part_Switch (toggle 80x40), Part_Guide
**Items**: Part_Item (item icon w/ quantity 100x100), Part_Equip (equipment slot), Part_EquipItem, Part_Gem, Part_RewardBox
**Characters**: Part_UserHead (player avatar 80x80), Part_UserHead_CityLv, Part_HeroCard, Part_Hero, Part_Soldier, Part_Titan, Part_TitanIcon
**Progress**: Part_Progress (progress bar 300x30), Part_Progress2, Part_Progress3, Part_Slider
**Rank**: Part_RankBg, Part_RankItem, Part_RankReward
**Other**: Part_ToggleGroup, Part_PageView, Part_PageIdx, Part_ScrollRewards, Part_AllianceFlag, Part_IconWithMask, Part_Age

## Node Types

Valid types: frame, text, image, component, button, scrollview, toggle, inputfield, rawimage

## Additional Naming Rules

1. Background images → "img_Bg" or "img_bg", placed as first child of their container. IMPORTANT: each container's background MUST be INSIDE that container, not outside as a sibling. For example, if Ctn_Tabs has a background image, it goes under Ctn_Tabs, not next to it.
2. Panel title → "txt_title", near the top
3. **DO NOT add a close button** unless one already exists in the canvas input. The Unity runtime adds Part_CloseBg automatically. Never invent @Part_CloseBg, btn_Close, or similar close-button nodes that aren't in the source data.
4. Container names must be descriptive: Ctn_Rewards, Ctn_PlayerInfo, Ctn_List (not Ctn_1, Ctn_2)
5. For list/grid patterns → ScrollView > Viewport > Content > Cell > [item contents]
6. Tab buttons → btn_Tab1, btn_Tab2... inside Ctn_Tabs
7. Row items with items + button → group inside Cell
8. Use English for all names, keep them concise and descriptive`;
}

// ──────── Claude API 调用 ────────

async function callClaude(
  config: AIConfig,
  systemPrompt: string,
  userContent: Array<{ type: string; [key: string]: any }>,
): Promise<string> {
  const apiUrl = `${config.baseUrl.replace(/\/+$/, '')}/v1/messages`;
  console.log(`[AI Normalize] Calling ${apiUrl}, model=${config.model}, proxy=${config.httpProxy || 'none'}`);

  const fetchOptions: any = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.anthropicApiKey,
      'Authorization': `Bearer ${config.anthropicApiKey}`,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 8192,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    }),
  };

  // 通过本地代理访问
  if (config.httpProxy) {
    fetchOptions.dispatcher = new ProxyAgent(config.httpProxy);
  }

  const response = await fetch(apiUrl, fetchOptions);

  if (!response.ok) {
    const err = await response.text();
    console.error(`[AI Normalize] API Error: status=${response.status}, body=${err.slice(0, 500)}`);
    if (response.status === 401) throw new Error('API Key 无效，请检查设置');
    if (response.status === 429) throw new Error('请求过于频繁，请稍后重试');
    if (response.status === 403) throw new Error(`API 访问被拒绝 (403)，请检查 API 地址和 Key 是否匹配。详情: ${err.slice(0, 200)}`);
    throw new Error(`API 错误 (${response.status}): ${err.slice(0, 200)}`);
  }

  const data = await response.json() as any;
  console.log(`[AI Normalize] Response received, stop_reason=${data.stop_reason}, usage=${JSON.stringify(data.usage || {})}`);
  const textBlock = data.content?.find((b: any) => b.type === 'text');
  if (!textBlock) throw new Error('AI 未返回有效内容');
  return textBlock.text;
}

function extractJSON(text: string): any {
  // 直接解析
  try { return JSON.parse(text); } catch {}
  // 提取 ```json ``` 代码块
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (match) {
    try { return JSON.parse(match[1].trim()); } catch {}
  }
  // 提取首尾花括号
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch {}
  }
  throw new Error('AI 返回格式异常，无法解析 JSON');
}

// ──────── 构建用户消息 ────────

function buildRenameUserContent(
  simplified: SimplifiedNode[],
  screenshot?: string,
): Array<{ type: string; [key: string]: any }> {
  const content: Array<{ type: string; [key: string]: any }> = [];

  if (screenshot) {
    // 提取 base64 媒体类型和数据
    const m = screenshot.match(/^data:(image\/\w+);base64,(.+)$/);
    if (m) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: m[1], data: m[2] },
      });
    }
  }

  content.push({
    type: 'text',
    text: `I have a UI panel with nodes already positioned correctly on the canvas. I need you to rename the nodes (and fix their types if wrong) to follow the project naming conventions. Do NOT change positions, sizes, or hierarchy.

## Current Canvas Structure

\`\`\`json
${JSON.stringify(simplified, null, 2)}
\`\`\`

${screenshot ? 'I have provided a screenshot of the UI mockup above. Use it to understand each element\'s visual purpose.' : ''}

## Instructions

1. Analyze each node's purpose based on its current name, type, position, size, and context within the hierarchy
2. For each node that needs renaming, determine the correct conventional name
3. If a node's type is wrong (e.g., a button marked as "frame"), fix the type too
4. If a node looks like a known Part_ component, suggest changing its componentRef

## Output Format

Return ONLY a valid JSON object (no markdown, no explanation):

{
  "renames": [
    { "id": "node-uuid", "newName": "btn_Close", "newType": "button" },
    { "id": "node-uuid", "newName": "txt_title" },
    { "id": "node-uuid", "newName": "@Part_Item", "newType": "component", "componentRef": "Part_Item" }
  ]
}

Only include nodes that need changes. Omit "newType" if the type is already correct. Include "componentRef" only when changing to a component type.`,
  });

  return content;
}

function buildRebuildUserContent(
  simplified: SimplifiedNode[],
  panelName: string,
  screenshot?: string,
): Array<{ type: string; [key: string]: any }> {
  const content: Array<{ type: string; [key: string]: any }> = [];

  if (screenshot) {
    const m = screenshot.match(/^data:(image\/\w+);base64,(.+)$/);
    if (m) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: m[1], data: m[2] },
      });
    }
  }

  content.push({
    type: 'text',
    text: `I have a UI panel with nodes already positioned on the canvas. I need you to **completely reorganize** the hierarchy from scratch — IGNORE the current parent-child grouping (it's just artist's rough layout), and re-group nodes purely based on VISUAL/SPATIAL containment using absolute coordinates.

## Panel Name: ${panelName}

## Canvas Nodes (absolute coordinates, flat list)

This is a flat list of ALL nodes with their absolute (x, y, width, height) on the canvas. Use these coordinates to determine which container each node should belong to. A node belongs INSIDE a container if its bounding box is mostly contained within that container's bounding box.

\`\`\`
${formatCanvasTable(flattenSimplified(simplified))}
\`\`\`

## Original Hierarchy (for reference only — DO NOT preserve this structure)

This is what the artist roughly grouped. Names and parent-child relations may be wrong. Use it only to understand element identity (e.g. an element named "btn_Help" is a help button), but FEEL FREE to move nodes to different containers.

\`\`\`json
${JSON.stringify(simplifyForReference(simplified), null, 2)}
\`\`\`

${screenshot ? 'I have provided a screenshot of the UI mockup above. Use it to understand the visual grouping and purpose of each element.' : ''}

## Reference: Real Prefab Hierarchies from This Project

**THIS IS THE MOST IMPORTANT INPUT.** Below are real, well-structured UI prefabs from the project. Your output structure MUST closely mirror these patterns:

- **Naming style** — match how containers, buttons, texts are named (Ctn_*, btn_*, txt_*, img_*, @Part_*)
- **Nesting depth** — typically 3-5 levels deep
- **Grouping logic** — top-bar elements (title + close + help + giftpack) all under one Ctn_Header or similar; tabs under Ctn_Tabs; content rows under Ctn_Content; bottom buttons under Ctn_Bottom
- **Container boundaries** — every visual region has its OWN Ctn_ wrapper; elements visually inside that region must be CHILDREN of that Ctn_, not siblings

${samplePrefabExamples(5)}

## Spatial Grouping Algorithm (you MUST follow this)

For each node in the canvas list:
1. Look at its absolute (x, y, width, height) — calculate its bounding box
2. Find the SMALLEST container (existing or new Ctn_) whose bounding box contains it
3. Place the node under that container
4. Specifically: a button at (x=1700, y=180) is INSIDE the right-side region (x=1500-1900, y=100-300) — assign it to Ctn_Right, NOT to root

## Instructions

1. Build a proper hierarchy tree following the patterns shown in the reference examples
2. Group nodes into Ctn_ containers based on SPATIAL CONTAINMENT (use absolute coords above), not the original artist grouping
3. Rename every node following the naming conventions strictly
4. For EXISTING nodes from the input, you MUST include their "origId" (the original node "id")
5. For NEW container nodes you create, omit "origId" — they will be auto-sized to fit their children
6. Set correct "type" for each node
7. Identify elements that should be known Part_ components and set "componentRef"
8. DO NOT include x, y, width, or height — positions are computed automatically
9. **NEVER add nodes that don't exist in the canvas input.** Specifically: do NOT add @Part_CloseBg, btn_Close, or any close button if one isn't in the source — the Unity runtime auto-adds these. Only output nodes that have a corresponding origId from the input (plus container Ctn_ wrappers).

## CRITICAL: ScrollView Pattern Detection

When you see REPEATED similar groups of nodes (e.g. multiple rows/cells with the same structure), they MUST be wrapped in a ScrollView:

\`\`\`
ScrollView (type: "scrollview") ← the scrollable area
  ├─ Cell (type: "frame") ← first repeated item
  ├─ Cell (type: "frame") ← second repeated item
  └─ ...
\`\`\`

**IMPORTANT**: Do NOT create Viewport or Content nodes inside ScrollView. The Unity engine automatically generates Viewport and Content when it sees a ScrollView. Just put the Cell children directly under ScrollView.

**How to detect**: If you see 2+ sibling groups with near-identical child structures (e.g. each has a background image + text + items + button), those are list cells and MUST go inside a ScrollView.

## Output Format

Return ONLY a valid JSON object (no markdown, no explanation):

{
  "name": "${panelName}",
  "children": [
    { "origId": "<id-from-input>", "name": "img_Bg", "type": "image" },
    {
      "name": "Ctn_Header", "type": "frame",
      "children": [
        { "origId": "<id>", "name": "txt_title", "type": "text" }
      ]
    },
    {
      "name": "ScrollView", "type": "scrollview",
      "children": [
        {
          "name": "Cell", "type": "frame",
          "children": [
            { "origId": "<id>", "name": "img_CellBg", "type": "image" },
            { "origId": "<id>", "name": "txt_desc", "type": "text" },
            { "origId": "<id>", "name": "@Part_Item", "type": "component", "componentRef": "Part_Item" }
          ]
        },
        {
          "name": "Cell", "type": "frame",
          "children": [ "..." ]
        }
      ]
    }
  ]
}

## Rules
- Every leaf node MUST have "origId" referencing an existing node from the input
- Container nodes that group children should NOT have "origId"
- Every node MUST have "name" and "type"
- Include "componentRef" only when the node should be a Part_ component
- Repeated similar groups → ScrollView > Cell (do NOT add Viewport/Content)
- Try to reference ALL original nodes — don't drop any unless they are clearly duplicates or garbage

## CRITICAL: Spatial Grouping — Match the Reference Patterns

Look at the reference prefab examples above. Notice how buttons (btn_), help buttons, gift buttons, etc. are ALWAYS inside their parent container — never floating at root level. Your output MUST follow the same pattern:

1. **Use bounding box containment**: If a node's position falls within a container's bounds, it belongs INSIDE that container
2. **Buttons near a container's edge** still belong to that container
3. **Never leave interactive elements orphaned at root level** — check their position and assign to the correct container
4. **When in doubt, follow the reference examples**: see how they nest btn_, img_, txt_ nodes inside Ctn_ containers

## CRITICAL: Hierarchy Separation by Visual Function

Do NOT group elements of different visual functions into the same container. Specifically:

1. **Labels/text that DESCRIBE a section** (titles, cost labels, summary text) must be SIBLINGS of the content container, NOT children inside it. For example, if "This expense: xxx" text appears above a grid of cards, the text should be a sibling next to the cards container, not inside it.

2. **Only group elements that share the same repeated pattern** into one container. A row of cards is one group; descriptive labels above/below those cards are a separate group at the same level.

3. **Common mistake to avoid**: Putting cost/expense/description labels inside Ctn_Cards or Ctn_Rewards. These labels describe the section — they belong OUTSIDE the content container, as siblings.

Correct example:
\`\`\`
Ctn_Content
  ├─ Ctn_Expense (or txt_expense labels as siblings)
  ├─ Ctn_Cards
  │    ├─ Ctn_CardRow1
  │    └─ Ctn_CardRow2
  └─ Ctn_TotalExpense
\`\`\`

Wrong example:
\`\`\`
Ctn_Cards          ← WRONG: labels mixed with cards
  ├─ txt_expense1  ← should NOT be here
  ├─ txt_expense2  ← should NOT be here
  ├─ Ctn_CardRow1
  └─ Ctn_CardRow2
\`\`\``,
  });

  return content;
}

function buildSlotMappingSystemPrompt(): string {
  return `You are a UI node mapping expert for the LOA game project. Your task is to match canvas nodes to reference structure slots based on visual appearance, position, and type.

## Naming Conventions (for unmapped nodes only)

| Prefix | Node Type | Usage | Examples |
|--------|-----------|-------|----------|
| btn_ | button | Interactive clickable elements | btn_Close, btn_Buy, btn_Confirm |
| txt_ or text_ | text | Non-interactive text labels | txt_title, txt_desc, txt_name |
| img_ or Img_ | image | Decorative or informational images | img_Bg, img_icon, img_arrow |
| Ctn_ or ctn_ | frame | Containers grouping child elements | Ctn_Main, Ctn_Bottom, Ctn_Rewards |
| go_ | frame | Generic logical groups | go_sellOut, go_effect |
| @Part_ | component | Reusable prefab components | @Part_Item, @Part_UserHead |

## Known Reusable Components (Part_ prefabs)

**Buttons**: Part_Btn_Blue, Part_Btn_Blue2, Part_Btn_Blue_Cost, Part_Btn_Blue_Time, Part_Btn_Yellow, Part_Btn_Yellow2, Part_Btn_Yellow_Cost, Part_Btn_Yellow_Time, Part_Btn_Red, Part_Btn_Red2, Part_Btn_Payment, Part_Btn_Payment_Sale
**Common UI**: Part_Header, Part_CloseBg, Part_CloseBlurBg, Part_BlackUI, Part_RedPoint, Part_Switch, Part_Guide
**Items**: Part_Item, Part_Equip, Part_EquipItem, Part_Gem, Part_RewardBox
**Characters**: Part_UserHead, Part_UserHead_CityLv, Part_HeroCard, Part_Hero, Part_Soldier, Part_Titan, Part_TitanIcon
**Progress**: Part_Progress, Part_Progress2, Part_Progress3, Part_Slider
**Rank**: Part_RankBg, Part_RankItem, Part_RankReward
**Other**: Part_ToggleGroup, Part_PageView, Part_PageIdx, Part_ScrollRewards, Part_AllianceFlag, Part_IconWithMask, Part_Age

## Node Types

Valid types: frame, text, image, component, button, scrollview, toggle, inputfield, rawimage`;
}

function buildSlotMappingUserContent(
  simplified: SimplifiedNode[],
  skeletonText: string,
  screenshot?: string,
): Array<{ type: string; [key: string]: any }> {
  const content: Array<{ type: string; [key: string]: any }> = [];

  if (screenshot) {
    const m = screenshot.match(/^data:(image\/\w+);base64,(.+)$/);
    if (m) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: m[1], data: m[2] },
      });
    }
  }

  const flat = flattenSimplified(simplified);
  const canvasTable = formatCanvasTable(flat);

  content.push({
    type: 'text',
    text: `I have a UI panel with nodes on the canvas (from an artist's rough layout) and a reference structure (from a programmer's finalized prefab). Match each canvas node to the correct slot in the reference structure.

## Reference Structure (numbered slots)

Slots marked with * are repeatable (e.g., list cells that can appear multiple times).
Slots marked with {container} are structural containers — do NOT map canvas nodes to them.
Only map canvas nodes to LEAF slots (non-container slots).

\`\`\`
${skeletonText}
\`\`\`

## Canvas Nodes

These are the artist's nodes — names are unreliable, types may be wrong. Use position, size, and visual context (screenshot) to determine what each node represents.

\`\`\`
${canvasTable}
\`\`\`

${screenshot ? 'A screenshot of the UI is provided above. Use it to understand what each canvas node looks like visually.' : ''}

## Your Task

Match canvas nodes to reference slots. For each leaf slot in the reference, find the canvas node that visually corresponds to it.

## Output Format

Return ONLY a valid JSON object:

{
  "mappings": [
    { "slot": "S2", "canvasId": "the-canvas-node-id" }
  ],
  "cells": [
    {
      "templateSlot": "S7",
      "instances": [
        { "S8": "canvas-id-1", "S9": "canvas-id-2", "S11": "canvas-id-3" },
        { "S8": "canvas-id-4", "S9": "canvas-id-5", "S11": "canvas-id-6" }
      ]
    }
  ],
  "unmapped": [
    { "canvasId": "node-id", "parentSlot": "S4", "name": "img_decor", "type": "image" }
  ],
  "emptySlots": ["S10"]
}

## Rules

1. Each canvasId can appear in AT MOST one slot (no duplicates)
2. "mappings" — for non-repeatable leaf slots: one canvas node per slot
3. "cells" — for repeatable slots (marked *): group canvas nodes into instances of the template. Each instance maps template leaf slots to canvas node IDs. If you see 3 similar rows, create 3 instances.
4. "unmapped" — canvas nodes that don't match any reference slot. Give each a proper name (btn_, txt_, img_, Ctn_, @Part_) and type, and specify which container slot (parentSlot) it belongs under.
5. "emptySlots" — reference leaf slots with no matching canvas node
6. Do NOT map canvas nodes to container slots — containers are structural only
7. Match by visual function and position, NOT by the artist's (often incorrect) names
8. Background/decorative images (large area, names containing "bg", "Bg", "gradient", "decor", or covering most of a container's area) should NEVER be placed inside a ScrollView or its Cell children. If unmapped, set their parentSlot to the ScrollView's PARENT container — they are full-area backgrounds behind content sections, not scrollable content.`,
  });

  return content;
}

interface SlotMappingResult {
  mappings: Array<{ slot: string; canvasId: string }>;
  cells?: Array<{
    templateSlot: string;
    instances: Array<Record<string, string>>;
  }>;
  unmapped?: Array<{
    canvasId: string;
    parentSlot: string;
    name: string;
    type: string;
    componentRef?: string;
  }>;
  emptySlots?: string[];
}

function validateMapping(mapping: SlotMappingResult, slotMap: Map<string, SkeletonSlot>): SlotMappingResult {
  const usedCanvasIds = new Set<string>();
  const validMappings: typeof mapping.mappings = [];

  for (const m of mapping.mappings || []) {
    if (!slotMap.has(m.slot)) continue;
    const slot = slotMap.get(m.slot)!;
    if (slot.isContainer) continue;
    if (usedCanvasIds.has(m.canvasId)) continue;
    usedCanvasIds.add(m.canvasId);
    validMappings.push(m);
  }

  const validCells: typeof mapping.cells = [];
  if (mapping.cells) {
    for (const cell of mapping.cells) {
      if (!slotMap.has(cell.templateSlot)) continue;
      const cleanInstances = cell.instances.map(inst => {
        const clean: Record<string, string> = {};
        for (const [slotId, canvasId] of Object.entries(inst)) {
          if (!slotMap.has(slotId)) continue;
          if (usedCanvasIds.has(canvasId)) continue;
          usedCanvasIds.add(canvasId);
          clean[slotId] = canvasId;
        }
        return clean;
      }).filter(inst => Object.keys(inst).length > 0);
      if (cleanInstances.length > 0) {
        validCells.push({ templateSlot: cell.templateSlot, instances: cleanInstances });
      }
    }
  }

  const validUnmapped: typeof mapping.unmapped = [];
  if (mapping.unmapped) {
    for (const u of mapping.unmapped) {
      if (usedCanvasIds.has(u.canvasId)) continue;
      if (!slotMap.has(u.parentSlot)) continue;
      if (!slotMap.get(u.parentSlot)!.isContainer) continue;
      usedCanvasIds.add(u.canvasId);
      validUnmapped.push(u);
    }
  }

  const validEmpty = (mapping.emptySlots || []).filter(s => slotMap.has(s));

  return {
    mappings: validMappings,
    cells: validCells.length > 0 ? validCells : undefined,
    unmapped: validUnmapped.length > 0 ? validUnmapped : undefined,
    emptySlots: validEmpty.length > 0 ? validEmpty : undefined,
  };
}

function assembleTreeFromMapping(
  refTree: SimplifiedRefNode,
  skeleton: SkeletonResult,
  mapping: SlotMappingResult,
): { name: string; type?: string; componentRef?: string; origId?: string; children?: any[] } {
  const emptySet = new Set(mapping.emptySlots || []);
  const slotToCanvas = new Map<string, string>();
  for (const m of mapping.mappings) {
    slotToCanvas.set(m.slot, m.canvasId);
  }

  const cellInstances = new Map<string, Array<Map<string, string>>>();
  if (mapping.cells) {
    for (const cell of mapping.cells) {
      const instances = cell.instances.map(inst => new Map(Object.entries(inst)));
      cellInstances.set(cell.templateSlot, instances);
    }
  }

  const slotParent = new Map<string, string>();
  const scrollViewSlots = new Set<string>();
  function indexSlots(slot: SkeletonSlot, parentId?: string) {
    if (parentId) slotParent.set(slot.id, parentId);
    const nameLC = slot.name.toLowerCase();
    if (slot.type === 'scrollview' || nameLC.startsWith('scroll') || nameLC.startsWith('looplist')) {
      scrollViewSlots.add(slot.id);
    }
    if (slot.children) slot.children.forEach(c => indexSlots(c, slot.id));
  }
  indexSlots(skeleton.root);

  function isInsideScrollView(slotId: string): boolean {
    let cur = slotId;
    while (cur) {
      if (scrollViewSlots.has(cur)) return true;
      cur = slotParent.get(cur) || '';
    }
    return false;
  }

  function findScrollViewParent(slotId: string): string | undefined {
    let cur = slotId;
    while (cur) {
      if (scrollViewSlots.has(cur)) return slotParent.get(cur);
      cur = slotParent.get(cur) || '';
    }
    return undefined;
  }

  const bgPattern = /bg|background|gradient|decor/i;

  const unmappedByParent = new Map<string, Array<{ canvasId: string; name: string; type: string; componentRef?: string }>>();
  if (mapping.unmapped) {
    for (const u of mapping.unmapped) {
      let parentSlot = u.parentSlot;
      if (bgPattern.test(u.name) && isInsideScrollView(parentSlot)) {
        const promoted = findScrollViewParent(parentSlot);
        if (promoted) {
          console.warn(`[AI Normalize] Promoted background "${u.name}" from ScrollView child ${parentSlot} to ${promoted}`);
          parentSlot = promoted;
        }
      }
      const list = unmappedByParent.get(parentSlot) || [];
      list.push(u);
      unmappedByParent.set(parentSlot, list);
    }
  }

  function buildNode(
    refNode: SimplifiedRefNode,
    slot: SkeletonSlot,
    canvasOverride?: Map<string, string>,
  ): any | null {
    if (emptySet.has(slot.id)) return null;

    if (!slot.isContainer) {
      const canvasId = canvasOverride?.get(slot.id) || slotToCanvas.get(slot.id);
      const node: any = {
        name: slot.name,
        type: slot.type,
      };
      if (slot.componentRef) node.componentRef = slot.componentRef;
      if (canvasId) node.origId = canvasId;
      return node;
    }

    const node: any = {
      name: slot.name,
      type: slot.type,
    };
    if (slot.componentRef) node.componentRef = slot.componentRef;
    node.children = [];

    if (slot.children && refNode.children) {
      if (slot.children.length !== refNode.children.length) {
        console.warn(`[AI Normalize] assembleTree: slot ${slot.id} (${slot.name}) has ${slot.children.length} children but refNode has ${refNode.children.length}`);
      }
      for (let i = 0; i < slot.children.length; i++) {
        const childSlot = slot.children[i];
        const childRef = refNode.children[i];
        if (!childRef) continue;

        if (childSlot.repeatable && cellInstances.has(childSlot.id)) {
          const instances = cellInstances.get(childSlot.id)!;
          for (const instanceMap of instances) {
            const cellNode = buildNode(childRef, childSlot, instanceMap);
            if (cellNode) node.children.push(cellNode);
          }
        } else {
          const childNode = buildNode(childRef, childSlot, canvasOverride);
          if (childNode) node.children.push(childNode);
        }
      }
    }

    const extras = unmappedByParent.get(slot.id);
    if (extras) {
      for (const extra of extras) {
        const extraNode: any = {
          origId: extra.canvasId,
          name: extra.name,
          type: extra.type,
        };
        if (extra.componentRef) extraNode.componentRef = extra.componentRef;
        node.children.push(extraNode);
      }
    }

    if (node.children.length === 0) delete node.children;
    return node;
  }

  const result = buildNode(refTree, skeleton.root);
  return result || { name: refTree.name, type: refTree.type };
}

// ──────── 请求体解析 ────────

const MAX_BODY_SIZE = 20 * 1024 * 1024; // 20MB (截图 base64 可能很大)

function parseRequestBody(req: import('http').IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error('请求体过大 (>20MB)'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf-8');
        resolve(JSON.parse(body));
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// ──────── AI 生成：从策划文档生成 UI 结构 ────────

function buildGenerateSystemPrompt(): string {
  return `You are a game UI analyst for the LOA mobile game. Your job is to read a game design document and output a STRUCTURED DESCRIPTION of the UI panel — NOT pixel coordinates or node trees.

The code will use your description to generate a correct UI layout from pre-built templates. You only need to extract CONTENT and choose the right TEMPLATE.

## Available Templates

### 1. "rows" — Vertical row list panel
Use for: power-up panels, attribute lists, feature comparison, any panel showing labeled data rows with optional progress bars and action buttons.
Example: "实力提升" panel with rows like "建筑实力 A 532/874 [提升]", "英雄实力 B 410/874 [提升]"

### 2. "tabs_list" — Tabs + scrollable item list
Use for: task lists, reward lists, shop panels, any panel with category tabs on top and a scrollable list of items below. Each list item can have text fields, reward items (Part_Item), and an action button.

### 3. "info" — Simple info/confirmation dialog
Use for: confirmations, announcements, simple descriptions, any popup with a text message and 1-2 buttons.

### 4. "grid" — Item/card grid
Use for: inventory, hero collection, equipment list, any panel showing a grid of items or cards.

## Panel Sizes

- "small": 820×520 — for simple popups, info dialogs, 3-5 rows
- "medium": 1000×600 — for moderate content
- "large": 1200×700 — for complex panels with tabs, long lists, grids

## Output Format

Return ONLY valid JSON matching one of these templates. Do NOT include x, y, width, height, imagePath, or any UI tree structure.

### rows template output:
\`\`\`json
{
  "panelName": "PowerUpPanel",
  "template": "rows",
  "title": "实力提升",
  "size": "small",
  "summary": {
    "lines": ["我的综合实力: 494", "推荐综合实力: 960"],
    "hasAvatar": true
  },
  "rows": [
    { "label": "建筑实力", "hasProgress": true, "progressText": "532/874", "grade": "A", "buttonText": "提升", "buttonStyle": "blue" },
    { "label": "英雄实力", "hasProgress": true, "progressText": "410/874", "grade": "B", "buttonText": "提升" },
    { "label": "战兽实力", "hasProgress": true, "progressText": "180/874", "grade": "C", "buttonText": "急需提升", "buttonStyle": "yellow" }
  ]
}
\`\`\`

### tabs_list template output:
\`\`\`json
{
  "panelName": "TaskPanel",
  "template": "tabs_list",
  "title": "每日任务",
  "size": "large",
  "tabs": ["推荐", "日常", "周常", "成就"],
  "cellFields": ["description", "reward"],
  "cellHasItems": true,
  "cellItemCount": 4,
  "cellButtonText": "前往",
  "sampleRows": [
    { "description": "完成挑战10次", "reward": "经验×500" },
    { "description": "升级建筑3次", "reward": "金币×2000" }
  ]
}
\`\`\`

### info template output:
\`\`\`json
{
  "panelName": "ConfirmPanel",
  "template": "info",
  "title": "提示",
  "size": "small",
  "description": "确定要花费 500 钻石购买此礼包吗？购买后立即生效，不可退款。",
  "buttons": [
    { "text": "确认购买", "style": "blue" },
    { "text": "取消", "style": "red" }
  ]
}
\`\`\`

### grid template output:
\`\`\`json
{
  "panelName": "BagPanel",
  "template": "grid",
  "title": "背包",
  "size": "large",
  "gridColumns": 5,
  "gridItemType": "Part_Item",
  "gridHasTabs": true,
  "gridTabs": ["全部", "装备", "道具", "材料"]
}
\`\`\`

## Rules

1. Read the document carefully and extract all relevant UI content
2. Choose the template that best matches the document's described functionality
3. Use Chinese text from the document for titles, labels, button text, descriptions
4. For "rows" template: extract each distinct data category as a row
5. For "tabs_list" template: identify tab categories and the fields shown per list item
6. For "grid" template: determine item type (Part_Item for items, Part_HeroCard for heroes, Part_Equip for equipment)
7. Choose panel size based on content amount
8. Return ONLY the JSON, no markdown fences, no explanation`;
}

// ──────── AI 生成：从参考图生成自由 StructNode 树 ────────

/**
 * 判断是否应自动套用 UI_Activity_Main 框架
 * 触发条件：
 * 1. panelName 以 UI_Activity_ 开头（但不是 UI_Activity_Main 本身）
 * 2. description 同时出现"活动"二字 + ("UI"/"ui"/"界面"/"面板"/"页面") 之一
 * 3. description 命中"活动框架"/"套框架"/"Activity"
 */
function shouldUseActivityFrame(panelName?: string, description?: string): boolean {
  const name = (panelName || '').toLowerCase();
  if (/^ui_activity_/.test(name) && !/^ui_activity_main$/.test(name)) {
    return true;
  }
  const desc = description || '';
  if (/活动框架|套框架|activity/i.test(desc)) {
    return true;
  }
  if (/活动/.test(desc) && /(ui|界面|面板|页面)/i.test(desc)) {
    return true;
  }
  return false;
}

/**
 * Merge 模式专用：告诉 AI 框架已就位，只需要生成 act_content 内的内容子树
 */
function buildActivityContentUserContent(
  images: Array<{ type: string; media_type: string; data: string }>,
  panelName: string,
  description?: string,
): Array<{ type: string; [key: string]: any }> {
  const content: Array<{ type: string; [key: string]: any }> = [];
  for (const img of images) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: img.media_type, data: img.data },
    });
  }

  content.push({
    type: 'text',
    text: `你正在为一个 LOA 活动 UI 生成**内容部分**。框架（UI_Activity_Main）已由系统加载完毕，你只需生成内容子树。

## Panel Name: ${panelName}
${description ? `\n## Functional Description\n${description}\n` : ''}

## 框架已就位（不要重复画这些）

游戏已加载标准活动框架，**这些节点会自动出现，你绝对不要在输出里包含它们**：
- 顶部标题栏（part_Header / Background）—— 包含"常规活动"标题文字 + 左上角返回按钮
- 左侧 Tab 栏（act_tabs）—— 包含 tab_item 模板，运行时根据 Tab 数量自动复制
- 主内容容器（act_content）—— 这是你要填充的容器（1920×1080 全屏拉伸）
- 背景图（img_Bg）—— 运行时动态贴图

## 你的任务

仅生成 act_content 容器**内部**的内容子树。输出根节点必须命名 \`act_content_payload\`，type 为 \`frame\`，宽 1920 高 1080。

- 如果设计图体现了多个 Tab 内容：每个 Tab 一个 \`Page_<TabName>\` 子节点（TabName 用英文，如 Reward / Rank / Detail）。第一个默认显示，其余加 \`"visible": false\`
- 如果设计图只展示一个 Tab 的内容：直接把元素放在 act_content_payload.children 下，不需要 Page_X 中间层
- Page 子节点内部：按通用 LOA 命名规范（Ctn_/btn_/txt_/img_/@Part_）描述视觉元素，复用 Part_* 组件
- **元素坐标 x/y 相对 act_content_payload，act_content_payload 自身 x=0 y=0**

## 严格禁止
- ❌ 不要在输出里画 img_Bg / 背景框（框架自带，会撞背景）
- ❌ 不要画 part_Header / Background / 返回按钮 / 顶部标题（框架自带）
- ❌ 不要画 act_tabs / tab_item / 左侧 Tab 按钮（框架自带）
- ❌ 不要包含 Ctn_Header / Ctn_Tabs 这类通用顶层容器（这是非活动 UI 的模板，不适用于此处）

## 设计图分析提示
- 设计图可能含完整活动 UI 截图（含框架），你需要**只识别 act_content 区域内**的内容元素，忽略上方标题栏和左侧 Tab
- 注意识别 act_content 内的子页签（如设计图里"活动详情/个人排名/联盟排名"这类**Tab 内子 Tab**），生成对应 Page_X

## 输出 Schema

\`\`\`typescript
interface StructNode {
  name: string;                     // 必填，遵循前缀命名
  type?: string;                    // frame / text / image / button / component / scrollview
  x?: number; y?: number;           // 相对父节点
  width?: number; height?: number;
  componentRef?: string;            // type=component 时
  text?: string;                    // type=text 时
  imagePath?: string;               // /atlas-file/... 或 /texture-file/...
  imageColor?: string;
  visible?: boolean;                // 非首 Tab 设为 false
  children?: StructNode[];
}
\`\`\`

## Output

仅返回 JSON，根节点是 \`{ "name": "act_content_payload", "type": "frame", "width": 1920, "height": 1080, "children": [...] }\`。不要加任何 markdown 围栏或解释文字，输出必须以 \`{\` 开头、以 \`}\` 结尾。`,
  });

  return content;
}

function buildGenerateFromImageSystemPrompt(): string {
  return `You are a Unity UI expert for the LOA mobile game. Given one or more reference screenshots (from this game or any other game), you generate a complete LOA-conformant UI panel structure as a StructNode tree, ready to import into the editor canvas.

## Naming Conventions (MANDATORY)

Every node name follows: PREFIX + descriptive English word(s).

| Prefix | Node Type | Usage | Examples |
|--------|-----------|-------|----------|
| btn_ | button | Interactive clickable elements | btn_Close, btn_Buy, btn_GoTo, btn_Tab1 |
| txt_ or text_ | text | Non-interactive text labels | txt_title, txt_desc, txt_count, txt_progress |
| img_ or Img_ | image | Decorative/informational images | img_Bg, img_icon, img_arrow, img_Banner |
| Ctn_ or ctn_ | frame | Containers grouping child elements | Ctn_Main, Ctn_Header, Ctn_Bottom, Ctn_Rewards |
| go_ | frame | Generic logical groups | go_sellOut, go_lockItem |
| @Part_ | component | Reusable prefab components (also set componentRef) | @Part_Item, @Part_UserHead, @Part_Btn_Blue |
| ScrollView | scrollview | Scroll container | ScrollView |
| LoopList_ | scrollview | Virtual list | LoopList_User |
| Cell | frame | List item template (direct child of ScrollView) | Cell |
| List_ | frame | List container | List_Reward |
| group_ | frame | Visual group | group_title |
| i# | text | Localized text key | i#free |

## Reusable Components (use these when a visual matches)

**Buttons**: Part_Btn_Blue (200×60), Part_Btn_Blue_Cost, Part_Btn_Blue_Time, Part_Btn_Yellow, Part_Btn_Yellow_Cost, Part_Btn_Red, Part_Btn_Payment, Part_Btn_Payment_Sale
**Common UI**: Part_Header (top bar with title+close, full width × 80), Part_CloseBg (close X 60×60), Part_BlackUI, Part_RedPoint (30×30), Part_Switch (80×40)
**Items**: Part_Item (100×100), Part_Equip (100×100), Part_EquipItem (100×120), Part_Gem (80×80), Part_RewardBox (100×100)
**Characters**: Part_UserHead (avatar 80×80), Part_UserHead_CityLv (100×100), Part_HeroCard (120×160), Part_Hero, Part_Soldier, Part_Titan, Part_TitanIcon (80×80)
**Progress**: Part_Progress (300×30), Part_Progress2, Part_Progress3, Part_Slider (300×40)
**Rank**: Part_RankBg (400×80), Part_RankItem, Part_RankReward
**Other**: Part_ToggleGroup, Part_PageView, Part_PageIdx, Part_ScrollRewards (400×120), Part_AllianceFlag (60×80), Part_IconWithMask (80×80), Part_Age (120×40)

## Image Resource Cheat Sheet (use imagePath field on image nodes)

### Panel backgrounds (Texture, large nine-slice frames)
| Visual | imagePath |
|--------|-----------|
| Generic popup frame (light rounded) | /texture-file/panel_popup_Lv3.png |
| Popup frame variant | /texture-file/panel_popup_Lv3_01.png |
| Mission/task panel frame | /texture-file/panel_popup_mission_1.png |
| Shop list background | /texture-file/panel_shop_list.png |
| Rank board background | /texture-file/panel_rank_1.png |
| Alliance join frame | /texture-file/panel_join_alliance.png |

### Buttons (common atlas, when not using Part_Btn_*)
| Visual | imagePath |
|--------|-----------|
| Blue button Lv2 | /atlas-file/common/textures/button_Lv2_blue.png |
| Yellow button Lv2 | /atlas-file/common/textures/button_Lv2_yellow.png |
| Red button Lv2 | /atlas-file/common/textures/button_Lv2_red.png |
| Blue button Lv3 (large) | /atlas-file/common/textures/button_Lv3_blue.png |
| Yellow button Lv3 | /atlas-file/common/textures/button_Lv3_yellow.png |
| Red button Lv3 | /atlas-file/common/textures/button_Lv3_red.png |
| Close X | /atlas-file/common/textures/btn_close_popup.png |
| Help (?) small | /atlas-file/common/textures/btn_help_small.png |
| Info (i) small | /atlas-file/common/textures/btn_info_small.png |
| Back small | /atlas-file/common/textures/btn_back_small.png |
| GoTo arrow | /atlas-file/common/textures/btn_goto.png |
| Share | /atlas-file/common/textures/btn_hero_share.png |

### Progress bars (common atlas)
| Visual | imagePath |
|--------|-----------|
| Progress style1 bg | /atlas-file/common/textures/progress1_bg.png |
| Progress style1 blue fill | /atlas-file/common/textures/progress1_blue.png |
| Progress style1 green fill | /atlas-file/common/textures/progress1_green.png |
| Progress style1 red fill | /atlas-file/common/textures/progress1_red.png |
| Progress style1 yellow fill | /atlas-file/common/textures/progress1_yellow.png |
| Progress style3 thin bg | /atlas-file/common/textures/progress3_bg.png |
| Progress style3 blue | /atlas-file/common/textures/progress3_blue.png |
| Progress style3 green | /atlas-file/common/textures/progress3_green.png |
| Progress style3 yellow | /atlas-file/common/textures/progress3_yellow.png |

### Generic white frames / containers (use with imageColor for tint)
| Visual | imagePath |
|--------|-----------|
| White rounded panel | /atlas-file/common/textures/white_frame_com_content_round.png |
| White content frame | /atlas-file/common/textures/white_frame_com_content.png |
| White input frame | /atlas-file/common/textures/white_frame_input_round.png |
| White flat block | /atlas-file/common/textures/white_common.png |
| White circle | /atlas-file/common/textures/white_circle.png |
| White square (no round) | /atlas-file/common/textures/white_square_01.png |
| White gradient (vertical) | /atlas-file/common/textures/white_gradient.png |
| White gradient (horizontal) | /atlas-file/common/textures/white_gradient_lr.png |
| Divider line | /atlas-file/common/textures/line_divider_white.png |

### List item backgrounds (common atlas)
| Visual | imagePath |
|--------|-----------|
| Blue list item bg | /atlas-file/common/textures/panel_list_blue.png |
| Normal list item bg | /atlas-file/common/textures/panel_list_normal.png |
| Rank list item bg | /atlas-file/common/textures/panel_rank_list.png |
| Mail list item bg | /atlas-file/common/textures/panel_mail_list.png |

### Common icons & overlays (common atlas)
| Visual | imagePath |
|--------|-----------|
| Green tick | /atlas-file/common/textures/icon_tick_white_2.png |
| White tick | /atlas-file/common/textures/icon_tick_white.png |
| Power icon | /atlas-file/common/textures/icon_hero_power.png |
| Toast bg | /atlas-file/common/textures/toast_bg.png |
| Tip frame | /atlas-file/common/textures/frame_tips.png |
| Tip frame (white) | /atlas-file/common/textures/frame_tips_wihte.png |

### Resource Reference Rules
1. Large nine-slice panel frames → /texture-file/...
2. Buttons / progress bars / icons / small ui → /atlas-file/common/textures/...
3. If a visual uses a colored solid block or tinted rounded shape → use a white_xxx.png and set imageColor like "#3B7AC4"
4. If you're not confident an image fits, OMIT the imagePath field — better empty than wrong
5. Set imagePath ONLY on image-type nodes (img_/Img_ prefix). Button/component nodes should not carry imagePath when they use @Part_*.

## Standard Panel Templates

### Popup panel
\`\`\`
PanelName (root, type frame)
├── img_Bg                  ← panel frame image (use /texture-file/panel_popup_Lv3.png by default)
├── txt_title               ← title text near top, centered
├── Ctn_Main                ← main content region
│   ├── Ctn_Header / Ctn_Tabs (optional)
│   ├── ScrollView / content area
│   └── Ctn_Bottom          ← bottom actions
\`\`\`

### List panel
\`\`\`
PanelName
├── img_Bg
├── txt_title
├── Ctn_Header              ← filters / sort
├── ScrollView
│   └── Cell                ← repeat-template
│       ├── img_bg
│       ├── img_icon (or @Part_Item)
│       ├── txt_name
│       └── btn_action
└── Ctn_Bottom
\`\`\`

### Tab panel
\`\`\`
PanelName
├── img_Bg
├── txt_title
├── Ctn_Tabs
│   ├── btn_Tab1
│   ├── btn_Tab2
│   └── btn_Tab3
├── Ctn_Page1               ← page content
└── Ctn_Page2
\`\`\`

## Design Resolution & Coordinates — LANDSCAPE ONLY

**THIS PROJECT IS A LANDSCAPE PC/TABLET GAME. THE TARGET CANVAS IS 1920×1080 (WIDE).**

The reference screenshots may come from ANY game — mobile portrait, console, web. **You MUST reinterpret the layout as a LANDSCAPE LOA panel.** Do NOT copy the portrait aspect ratio.

### Step 1: Decide panel form factor — FULL-SCREEN vs POPUP

Look at the reference image carefully:

- **FULL-SCREEN page** (default size 1920×1080) — choose this when:
  - The reference fills the entire screen (no visible window frame around the content)
  - The reference is an activity / event / feature page (not a small confirmation dialog)
  - The reference has a back button (◀) in the top-left corner (signature of a full-page activity)
  - Content is rich: multiple sections, tabs, lists, big illustrations
- **POPUP dialog** (smaller centered window) — choose this when:
  - The reference clearly shows a window frame floating over a darker background
  - Content is sparse: confirmation, info dialog, simple form

**Most "activity / event / feature" panels in this game are FULL-SCREEN (1920×1080). Default to FULL-SCREEN unless the reference is obviously a small popup.**

### Step 2: Apply size

- **Full-screen page**: panel = 1920 × 1080, x = 0, y = 0
- **Popup** sizes (pick by content density):
  - Compact: 900 × 600
  - Standard: 1200 × 720
  - Wide: 1400 × 800
- **Popup width MUST be greater than or equal to its height.** Never output a tall narrow popup.
- All x/y values are RELATIVE to the parent node (parent-relative offsets)
- Popup root is centered: x = (1920 - W) / 2, y = (1080 - H) / 2

### Common element sizes

- Buttons: 160–240 wide × 60–70 tall
- Text labels: 200–400 wide × 30–40 tall
- Icons: 60–100 square
- Top header (back btn + title): full panel width × 80–100 tall, anchored at y=0
- Tab row under header: full panel width × 80 tall, anchored at y ≈ 100
- Bottom action bar: full panel width × 100 tall, anchored at y = panelHeight - 100

### Portrait → Landscape reorganization patterns

When the reference is a portrait phone screenshot, apply ONE of these transforms:

1. **Two-column split**: vertical stack in the reference → place primary section on the left half, secondary (rewards/info/buttons) on the right half
2. **Top tabs + horizontal content**: vertical tab list → horizontal tab row across the top, content area expands wide below
3. **Header + body row**: header stays on top (back btn + title + tabs); the body fills the remaining wide area with elements laid out horizontally
4. **Group adjacency**: items stacked vertically in portrait can become a horizontal row of items in landscape

Example: a portrait phone full-screen with [Header / Tabs / BigImage / Info / Stats / ActionButton] vertically becomes a landscape FULL-SCREEN 1920×1080:

\`\`\`
[ Ctn_Header (1920 × 80, back btn left, title center) ]
[ Ctn_Tabs (1920 × 80, horizontal tab row) ]
[ Ctn_Left (≈ 1100 × 800: big image + info + stats) | Ctn_Right (≈ 700 × 800: list + buttons) ]
[ Ctn_Bottom (1920 × 100, action bar) ]
\`\`\`

## CRITICAL Rules

1. **HORIZONTAL/LANDSCAPE LAYOUT ONLY** — output panel WIDTH ≥ HEIGHT. If the reference is portrait, transform it (see Portrait→Landscape patterns above). Never output a tall narrow panel.
2. **Output ONLY a valid JSON StructNode tree** — no markdown fences, no explanation, no commentary
3. **Every node must have a "name"** following the prefix conventions above
4. **Set "type"** explicitly for clarity (frame / text / image / button / component / scrollview)
5. **Component nodes**: prefix name with @, set type="component", set componentRef="Part_XXX". Example: { "name": "@Part_Item", "type": "component", "componentRef": "Part_Item" }
6. **DO NOT add a close button** — the Unity runtime auto-injects Part_CloseBg into popup panels. Never write @Part_CloseBg or btn_Close at root level.
7. **ScrollView pattern**: place Cell children DIRECTLY under ScrollView. Do NOT write Viewport or Content nodes — the engine generates them at runtime.
8. **Reuse Part_* components** whenever a visual matches (avatars, items, buttons, progress bars, etc.)
9. **Reference images on image nodes**: if the visual matches a known atlas/texture, set imagePath. Otherwise omit.
10. **Hierarchy**: every visual region gets its OWN Ctn_ wrapper — never leave buttons / texts floating at root level inside a popup
11. **Text content**: set "text" field on text-type nodes when the screenshot shows readable text — use the actual Chinese characters if visible; otherwise use a descriptive placeholder like "标题"
12. **No overlap / no out-of-bounds** — child x/y/width/height must stay within parent bounds; siblings must not overlap unless they are intentionally layered (e.g. img_Bg behind content)

## Output Schema

\`\`\`typescript
interface StructNode {
  name: string;                     // required, follows prefix rules
  type?: string;                    // frame/text/image/button/component/scrollview
  x?: number;                       // relative to parent
  y?: number;                       // relative to parent
  width?: number;
  height?: number;
  componentRef?: string;            // for type=component
  text?: string;                    // for type=text
  imagePath?: string;               // /atlas-file/... or /texture-file/...
  imageColor?: string;              // tint hex like #3B7AC4
  children?: StructNode[];
}
\`\`\`

## Real Prefab Examples From This Project

Below are real LOA prefab hierarchies — your output structure MUST mirror this style: deep nesting (3–5 levels), descriptive Ctn_ wrappers per visual region, Part_ references for reusables.

${samplePrefabExamples(5)}`;
}

function buildGenerateFromImageUserContent(
  images: Array<{ type: string; media_type: string; data: string }>,
  panelName: string,
  description?: string,
  referenceStructure?: SimplifiedRefNode,
): Array<{ type: string; [key: string]: any }> {
  const content: Array<{ type: string; [key: string]: any }> = [];

  for (const img of images) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: img.media_type, data: img.data },
    });
  }

  let refBlock = '';
  if (referenceStructure) {
    const skeleton = generateSkeleton(referenceStructure);
    refBlock = `

## REFERENCE PREFAB — YOU MUST MIRROR THIS LAYOUT

The user picked an existing LOA project prefab as the structural blueprint for this panel. **This prefab is from a similar feature/activity already shipped in the game.** Your output MUST closely mirror this structure:

- **Same root container partitioning** (same top-level Ctn_Header / Ctn_Tabs / Ctn_Left / Ctn_Right / Ctn_Bottom / ScrollView etc.)
- **Same nesting depth** at each region
- **Same Part_* component choices** for shared elements (header style, tab style, button style, list cell style)
- **Same approximate sizing proportions** for each region (e.g. if the prefab's header is 80px tall, yours should be 80px tall too)
- **Only the leaf content adapts** to match what the reference screenshot shows — node count inside each region, text labels, icon counts

Treat the prefab as the SKELETON and the screenshot as the SKIN. If the prefab has a Ctn_Header + Ctn_Tabs + ScrollView + Ctn_Bottom structure, your output has the same four regions even if the screenshot doesn't visually emphasize one of them.

\`\`\`
${skeleton.text}
\`\`\``;
  }

  content.push({
    type: 'text',
    text: `Generate a LOA-conformant UI panel structure from the reference screenshot(s) above.

## Panel Name: ${panelName}

${description ? `## Functional Description\n\n${description}\n` : ''}
${refBlock}

## Your Task

**Reminder: this is a LANDSCAPE 1920×1080 PC game.** First decide form factor:
- **If reference fills the whole screen (no window frame) and shows a feature/activity/event page** → full-screen 1920×1080
- **If reference shows a small floating window over a darkened background** → popup (900×600 / 1200×720 / 1400×800)

If the reference is portrait-oriented, you MUST reorganize the content into a wide landscape layout. Never output a tall narrow panel.

1. Decide form factor (full-screen vs popup) and pick exact size
2. ${referenceStructure ? 'Use the **reference prefab structure** above as your skeleton — same regions, same depth, same Part_* choices. Adapt only the leaf content to match the screenshot.' : 'Decide region partitioning: Ctn_Header (back btn + title) on top, Ctn_Tabs below it if there are tabs, then main content (split left/right if needed), Ctn_Bottom action bar at the bottom.'}
3. Look at the reference screenshot(s) and identify every visual element: backgrounds, titles, buttons, text labels, icons, avatars, items, progress bars, list rows, tabs, etc.
4. Map each visual element to a StructNode with the correct prefix and type
5. Reuse Part_* components for matching visuals (avatars → @Part_UserHead, items → @Part_Item, blue buttons → @Part_Btn_Blue, etc.)
6. Set imagePath on image nodes when the visual matches an entry from the resource cheat sheet
7. Estimate reasonable x/y/width/height for each node (parent-relative). For full-screen pages: root at x=0 y=0 width=1920 height=1080. For popups: centered at x = (1920 - W) / 2, y = (1080 - H) / 2
8. Use the exact panelName "${panelName}" as the root node's name

## Self-Check Before Outputting

Before returning the JSON, verify:
- [ ] Form factor matches reference: full-screen (1920×1080) for activity/feature pages; popup only for small confirmation/info dialogs
- [ ] Root panel WIDTH ≥ HEIGHT (landscape, not portrait)
- [ ] Root panel x and y center it on the 1920×1080 canvas (or x=0 y=0 for full-screen)
- [ ] No child node extends beyond its parent's bounds
- [ ] No sibling nodes overlap (except img_Bg which sits behind content)
- [ ] No btn_Close / @Part_CloseBg added (Unity adds it automatically)
${referenceStructure ? '- [ ] Output structure mirrors the reference prefab skeleton — same top-level regions, same depth' : ''}

## Output

Return ONLY the JSON StructNode tree. No markdown fences, no surrounding text, no explanation. The output must start with { and end with }.`,
  });

  return content;
}

function buildGenerateUserContent(
  documentText: string,
  panelName: string,
  images?: Array<{ type: string; media_type: string; data: string }>,
): Array<{ type: string; [key: string]: any }> {
  const content: Array<{ type: string; [key: string]: any }> = [];

  if (images && images.length > 0) {
    for (const img of images) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: img.media_type, data: img.data },
      });
    }
  }

  content.push({
    type: 'text',
    text: `Analyze this game design document and output a structured description for UI panel generation.

## Panel Name: ${panelName}

## Design Document

${documentText}

${images && images.length > 0 ? '\nWireframe/mockup images from the document are provided above.' : ''}

## Instructions

1. Read the document and understand what UI panel it describes
2. Choose the best matching template: "rows", "tabs_list", "info", or "grid"
3. Extract all text content (titles, labels, button text, descriptions) from the document
4. Output ONLY the structured JSON description — no coordinates, no node tree
5. Use the exact panelName "${panelName}" in your output`,
  });

  return content;
}

// ──────── Vite 插件 ────────

// connect 中间件不处理 async 拒绝，手动包装确保错误被捕获
function asyncHandler(
  fn: (req: import('http').IncomingMessage, res: import('http').ServerResponse) => Promise<void>,
) {
  return (req: import('http').IncomingMessage, res: import('http').ServerResponse, _next: () => void) => {
    fn(req, res).catch((err: any) => {
      console.error('[AI Plugin] Unhandled error:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
      }
      if (!res.writableEnded) {
        res.end(JSON.stringify({ error: err?.message || '服务器内部错误' }));
      }
    });
  };
}

export function aiNormalizePlugin(): Plugin {
  return {
    name: 'ai-normalize',
    configureServer(server) {
      // GET /api/ai/config — 获取配置（key 脱敏）
      server.middlewares.use('/api/ai/config', (req, res, next) => {
        if (req.method !== 'GET') return next();
        const config = readConfig();
        const masked = config.anthropicApiKey
          ? config.anthropicApiKey.slice(0, 10) + '...' + config.anthropicApiKey.slice(-4)
          : '';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ apiKey: masked, model: config.model, baseUrl: config.baseUrl, httpProxy: config.httpProxy, hasKey: !!config.anthropicApiKey }));
      });

      // POST /api/ai/config — 保存配置
      server.middlewares.use('/api/ai/config', (req, res, next) => {
        if (req.method !== 'POST') return next();
        asyncHandler(async (_req, _res) => {
          const body = await parseRequestBody(_req);
          const config = readConfig();
          if (body.apiKey) config.anthropicApiKey = body.apiKey;
          if (body.model) config.model = body.model;
          if (body.baseUrl !== undefined) config.baseUrl = body.baseUrl || DEFAULT_BASE_URL;
          if (body.httpProxy !== undefined) config.httpProxy = body.httpProxy || '';
          writeConfig(config);
          _res.writeHead(200, { 'Content-Type': 'application/json' });
          _res.end(JSON.stringify({ success: true }));
        })(req, res, next);
      });

      // POST /api/ai/normalize — 核心：AI 规范化
      server.middlewares.use('/api/ai/normalize', (req, res, next) => {
        if (req.method !== 'POST') return next();
        asyncHandler(async (_req, _res) => {
          const body = await parseRequestBody(_req);
          const { mode, nodes, rootIds, screenshot, panelName, referenceStructure } = body;

          // 校验
          const config = readConfig();
          if (!config.anthropicApiKey) {
            _res.writeHead(400, { 'Content-Type': 'application/json' });
            _res.end(JSON.stringify({ error: '请先在设置中配置 API Key' }));
            return;
          }
          if (!nodes || !rootIds || rootIds.length === 0) {
            _res.writeHead(400, { 'Content-Type': 'application/json' });
            _res.end(JSON.stringify({ error: '画布为空，请先添加节点' }));
            return;
          }

          // 简化节点
          const simplified = simplifyNodes(nodes, rootIds);
          if (simplified.length === 0) {
            _res.writeHead(400, { 'Content-Type': 'application/json' });
            _res.end(JSON.stringify({ error: '画布节点解析为空，请检查节点数据' }));
            return;
          }

          // 构建消息并调用 Claude
          let result: any;

          if (mode === 'rename') {
            const systemPrompt = buildSystemPrompt();
            const userContent = buildRenameUserContent(simplified, screenshot);
            console.log(`[AI Normalize] Calling Claude (${config.model}), mode=rename, nodes=${rootIds.length} roots`);
            const responseText = await callClaude(config, systemPrompt, userContent);
            console.log(`[AI Normalize] Claude responded, length=${responseText.length}`);
            result = extractJSON(responseText);
          } else if (mode === 'rebuild' && referenceStructure) {
            // ── Slot-mapping flow: reference drives the structure ──
            const skeleton = generateSkeleton(referenceStructure);
            console.log(`[AI Normalize] Skeleton generated: ${skeleton.slotMap.size} slots`);

            const systemPrompt = buildSlotMappingSystemPrompt();
            const userContent = buildSlotMappingUserContent(simplified, skeleton.text, screenshot);
            console.log(`[AI Normalize] Calling Claude (${config.model}), mode=rebuild+ref, slots=${skeleton.slotMap.size}, canvasNodes=${simplified.length}`);
            const responseText = await callClaude(config, systemPrompt, userContent);
            console.log(`[AI Normalize] Claude responded, length=${responseText.length}`);

            const rawMapping = extractJSON(responseText) as SlotMappingResult;
            const mapping = validateMapping(rawMapping, skeleton.slotMap);
            console.log(`[AI Normalize] Mapping: ${mapping.mappings.length} direct, ${mapping.cells?.reduce((s, c) => s + c.instances.length, 0) || 0} cell instances, ${mapping.unmapped?.length || 0} unmapped, ${mapping.emptySlots?.length || 0} empty`);

            result = assembleTreeFromMapping(referenceStructure, skeleton, mapping);
          } else {
            // ── Original free-form rebuild (no reference) ──
            const systemPrompt = buildSystemPrompt();
            const userContent = buildRebuildUserContent(simplified, panelName || 'MyPanel', screenshot);
            console.log(`[AI Normalize] Calling Claude (${config.model}), mode=rebuild, nodes=${rootIds.length} roots`);
            const responseText = await callClaude(config, systemPrompt, userContent);
            console.log(`[AI Normalize] Claude responded, length=${responseText.length}`);
            result = extractJSON(responseText);
          }

          _res.writeHead(200, { 'Content-Type': 'application/json' });
          _res.end(JSON.stringify({ success: true, mode, result }));
        })(req, res, next);
      });

      // POST /api/ai/generate — AI 生成：从策划文档生成 UI 结构
      server.middlewares.use('/api/ai/generate', (req, res, next) => {
        if (req.method !== 'POST') return next();
        asyncHandler(async (_req, _res) => {
          const body = await parseRequestBody(_req);
          const { documentText, panelName, images } = body;

          const config = readConfig();
          if (!config.anthropicApiKey) {
            _res.writeHead(400, { 'Content-Type': 'application/json' });
            _res.end(JSON.stringify({ error: '请先在设置中配置 API Key' }));
            return;
          }
          if (!documentText || !documentText.trim()) {
            _res.writeHead(400, { 'Content-Type': 'application/json' });
            _res.end(JSON.stringify({ error: '请输入策划文档内容' }));
            return;
          }

          const systemPrompt = buildGenerateSystemPrompt();
          const userContent = buildGenerateUserContent(
            documentText,
            panelName || 'MyPanel',
            images,
          );

          console.log(`[AI Generate] Calling Claude (${config.model}), panelName=${panelName}, textLen=${documentText.length}, images=${images?.length || 0}`);
          const responseText = await callClaude(config, systemPrompt, userContent);
          console.log(`[AI Generate] Claude responded, length=${responseText.length}`);
          const result = extractJSON(responseText);

          _res.writeHead(200, { 'Content-Type': 'application/json' });
          _res.end(JSON.stringify({ success: true, result }));
        })(req, res, next);
      });

      // POST /api/ai/generate-from-image — AI 生成：从参考图生成自由 StructNode 树
      server.middlewares.use('/api/ai/generate-from-image', (req, res, next) => {
        if (req.method !== 'POST') return next();
        asyncHandler(async (_req, _res) => {
          const body = await parseRequestBody(_req);
          const { images, panelName, description, referenceStructure } = body;

          const config = readConfig();
          if (!config.anthropicApiKey) {
            _res.writeHead(400, { 'Content-Type': 'application/json' });
            _res.end(JSON.stringify({ error: '请先在设置中配置 API Key' }));
            return;
          }
          if (!Array.isArray(images) || images.length === 0) {
            _res.writeHead(400, { 'Content-Type': 'application/json' });
            _res.end(JSON.stringify({ error: '请至少上传一张参考图' }));
            return;
          }

          // 决定模式：
          //  - 用户手动传了 referenceStructure → ref 模式（与之前行为一致）
          //  - 否则若识别为活动 UI 且能加载到框架树 → merge 模式（AI 只生成 act_content 内容）
          //  - 加载失败时降级到 v2 简化骨架 ref 模式
          //  - 都不命中 → 裸生成
          let effectiveRefStructure = referenceStructure;
          let autoInjectedRef: string | undefined;
          let mode: 'ref' | 'merge' | 'plain' = referenceStructure ? 'ref' : 'plain';
          let activityFrameTree: ReturnType<typeof loadActivityFrameTree> = null;

          if (!effectiveRefStructure && shouldUseActivityFrame(panelName, description)) {
            activityFrameTree = loadActivityFrameTree();
            if (activityFrameTree) {
              mode = 'merge';
              autoInjectedRef = 'UI_Activity_Main';
              console.log(`[AI GenFromImage] Activity frame loaded, entering merge mode`);
            } else {
              // 降级：使用 v2 的简化骨架作为 referenceStructure
              const fallbackRef = loadPrefabAsRefStructure('Activity/UI_Activity_Main.prefab');
              if (fallbackRef) {
                effectiveRefStructure = fallbackRef;
                autoInjectedRef = 'UI_Activity_Main';
                mode = 'ref';
                console.log(`[AI GenFromImage] Activity frame load failed, fallback to skeleton ref mode`);
              }
            }
          }

          const systemPrompt = buildGenerateFromImageSystemPrompt();
          const userContent = mode === 'merge'
            ? buildActivityContentUserContent(images, panelName || 'MyPanel', description)
            : buildGenerateFromImageUserContent(
                images,
                panelName || 'MyPanel',
                description,
                effectiveRefStructure,
              );

          console.log(`[AI GenFromImage] Calling Claude (${config.model}), panelName=${panelName}, images=${images.length}, descLen=${description?.length || 0}, mode=${mode}, autoInjected=${!!autoInjectedRef}`);
          const responseText = await callClaude(config, systemPrompt, userContent);
          console.log(`[AI GenFromImage] Claude responded, length=${responseText.length}`);
          const aiResult = extractJSON(responseText);

          let result = aiResult;
          if (mode === 'merge' && activityFrameTree && aiResult) {
            result = mergeContentIntoFrame(activityFrameTree, aiResult);
            console.log(`[AI GenFromImage] Merged AI content into UI_Activity_Main frame`);
          }

          _res.writeHead(200, { 'Content-Type': 'application/json' });
          _res.end(JSON.stringify({ success: true, result, autoInjectedRef, mode }));
        })(req, res, next);
      });
    },
  };
}

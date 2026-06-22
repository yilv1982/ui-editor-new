/**
 * 前端 Unity 同步服务
 * 通过浏览器端 MCP 客户端直接与用户本地 Unity 通信
 */

import * as McpClient from './McpClient';
import { getMcpUrl } from './McpClient';
import { ASSET_PATHS } from '../config/assetPaths';

/** 检查 Unity MCP 连接 */
export async function checkConnection(): Promise<boolean> {
  if (await McpClient.ping()) return true;
  return checkUnityProxy();
}

/** 全量同步到 Unity */
export async function syncToUnity(exportJson: string): Promise<{ success: boolean; nodeCount: number; elapsed: number }> {
  return doSync(exportJson, 'UIEditor/Bridge Sync');
}

/** 增量同步：写回原 prefab，最大限度保留 fileID（保留程序拖的引用） */
export async function syncIncrementalToUnity(exportJson: string): Promise<{ success: boolean; nodeCount: number; elapsed: number }> {
  return doSync(exportJson, 'UIEditor/Bridge Sync Incremental');
}

async function doSync(exportJson: string, menuPath: string): Promise<{ success: boolean; nodeCount: number; elapsed: number }> {
  const start = Date.now();
  const nodeCount = (exportJson.match(/"name"/g) || []).length;

  // 1. Unity 代理直连：桥接脚本已在工程内时，不依赖 MCP 菜单执行。
  if (await syncViaUnityProxy(exportJson, menuPath)) {
    return { success: true, nodeCount, elapsed: Date.now() - start };
  }

  // 2. 确保 C# 桥接脚本存在（需要 Unity MCP）
  await ensureBridgeScript();

  // 脚本部署后再试一次直连代理，新版代理会直接触发同步。
  if (await syncViaUnityProxy(exportJson, menuPath)) {
    return { success: true, nodeCount, elapsed: Date.now() - start };
  }

  // 3. 旧链路：传递同步 JSON，再通过 MCP 执行菜单
  const proxyBase = getMcpUrl().replace(/\/mcp$/, '');
  let syncViaProxy = false;
  try {
    const res = await fetch(proxyBase + '/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: exportJson,
    });
    if (res.ok) syncViaProxy = true;
  } catch {}

  if (!syncViaProxy) {
    await McpClient.callTool('write_file', {
      path: ASSET_PATHS.syncJson,
      content: exportJson,
    });
  }

  // 4. 触发 Unity 菜单执行同步
  await McpClient.callTool('execute_menu_item', {
    menu_path: menuPath,
  });

  const elapsed = Date.now() - start;
  return { success: true, nodeCount, elapsed };
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function getUnityProxyBases(): string[] {
  const configuredBase = getMcpUrl().replace(/\/mcp$/, '');
  return Array.from(new Set([
    configuredBase,
    configuredBase.startsWith('https://') ? configuredBase.replace('https://', 'http://') : configuredBase,
    'https://127.0.0.1:8081',
    'http://127.0.0.1:8081',
  ]));
}

async function checkUnityProxy(): Promise<boolean> {
  for (const base of getUnityProxyBases()) {
    try {
      const res = await fetchWithTimeout(base + '/', { method: 'GET' }, 1500);
      if (res.ok) return true;
    } catch {}
  }
  return false;
}

async function syncViaUnityProxy(exportJson: string, menuPath: string): Promise<boolean> {
  const endpoint = menuPath.includes('Incremental') ? '/sync-incremental' : '/sync-preview';

  for (const base of getUnityProxyBases()) {
    try {
      const res = await fetchWithTimeout(base + endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: exportJson,
      }, 2500);
      if (res.ok) return true;
    } catch {}
  }
  return false;
}

/** 触发 Unity 截图 */
export async function captureScreenshot(): Promise<void> {
  await McpClient.callTool('execute_menu_item', {
    menu_path: 'UIEditor/Bridge Screenshot',
  });
}

/** 确保 Unity 侧有桥接脚本 */
async function ensureBridgeScript(): Promise<void> {
  // 并行检查和部署两个脚本
  await Promise.all([
    deployScriptIfChanged(ASSET_PATHS.bridgeScript, generateBridgeScript()),
    deployScriptIfChanged(ASSET_PATHS.corsProxy, generateCorsProxyScript()),
  ]);
}

async function deployScriptIfChanged(path: string, content: string): Promise<void> {
  try {
    const result = await McpClient.callTool('read_file', { path });
    const existing = result?.content?.[0]?.text || '';
    if (existing === content) return;
  } catch {
    // 文件不存在，继续写入
  }

  await McpClient.callTool('write_file', { path, content });

  // 刷新 AssetDatabase
  await McpClient.callTool('refresh_unity', {});
  await waitForCompilation();
}

async function waitForCompilation(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    try {
      const result = await McpClient.callTool('read_console', { count: 5 });
      const text = result?.content?.[0]?.text || '';
      if (!text.includes('Compiling') && !text.includes('compiling')) {
        return;
      }
    } catch { /* keep waiting */ }
  }
}

// ===== C# 桥接脚本内容 =====

function generateBridgeScript(): string {
  return `using UnityEngine;
using UnityEngine.UI;
using UnityEditor;
using System.IO;
using System.Collections.Generic;
using System.Reflection;

/// <summary>
/// Web UI Editor 实时同步桥接 — 自包含版本
/// </summary>
public static class UIEditorBridgeSync
{
    private const string PREVIEW_NAME = "__UIEditorPreview__";
    private const string COMMON_PART_FOLDER = "${ASSET_PATHS.commonPart}/";

    static string ReadSyncJson()
    {
        string json = UIEditorCorsProxy.LastSyncJson;
        if (string.IsNullOrEmpty(json))
        {
            string filePath = Path.Combine(Application.dataPath, "Editor/uieditor_sync.json");
            if (File.Exists(filePath))
            {
                json = File.ReadAllText(filePath);
                File.Delete(filePath);
            }
        }
        if (string.IsNullOrEmpty(json))
        {
            Debug.LogError("[UIEditorBridge] 没有同步数据，请先在浏览器中点击同步");
            return null;
        }
        return json;
    }

    static SyncDocument ReadSyncDocument()
    {
        string json = ReadSyncJson();
        if (string.IsNullOrEmpty(json)) return null;

        var doc = JsonUtility.FromJson<SyncDocument>(json);
        if (doc == null || doc.root == null)
        {
            Debug.LogError("[UIEditorBridge] JSON 解析失败");
            return null;
        }
        return doc;
    }

    [MenuItem("UIEditor/Bridge Sync")]
    public static void SyncFromJson()
    {
        var doc = ReadSyncDocument();
        if (doc == null) return;

        // 删除旧预览
        var existing = GameObject.Find(PREVIEW_NAME);
        if (existing != null) Object.DestroyImmediate(existing);
        _scrollContentMap.Clear();
        _scrollPendingResolve.Clear();

        // 创建 Canvas
        var canvasGo = new GameObject(PREVIEW_NAME);
        var canvas = canvasGo.AddComponent<Canvas>();
        canvas.renderMode = RenderMode.ScreenSpaceOverlay;
        canvas.sortingOrder = 100;
        var scaler = canvasGo.AddComponent<CanvasScaler>();
        scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
        scaler.referenceResolution = new Vector2(doc.canvasWidth, doc.canvasHeight);
        scaler.matchWidthOrHeight = 0.5f;
        canvasGo.AddComponent<GraphicRaycaster>();

        int count = 0;
        if (doc.root.children != null)
        {
            foreach (var child in doc.root.children)
                BuildNode(child, canvasGo.GetComponent<RectTransform>(), doc.canvasWidth, doc.canvasHeight, ref count);
        }

        ResolveScrollViewBindings();

        Debug.Log("[UIEditorBridge] 同步完成: " + count + " 个节点");
        Selection.activeGameObject = canvasGo;
        SceneView.RepaintAll();
    }

    [MenuItem("UIEditor/Bridge Sync Incremental")]
    public static void SyncIncrementalFromJson()
    {
        var doc = ReadSyncDocument();
        if (doc == null) return;

        if (string.IsNullOrEmpty(doc.sourcePrefabPath))
        {
            Debug.LogError("[UIEditorBridge] 缺少 sourcePrefabPath，无法写回原 prefab");
            return;
        }

        string prefabPath = NormalizePrefabPath(doc.sourcePrefabPath);
        if (!File.Exists(prefabPath.Replace("Assets/", Application.dataPath + "/")))
        {
            Debug.LogError("[UIEditorBridge] 目标 prefab 不存在: " + prefabPath);
            return;
        }

        GameObject prefabRoot = null;
        try
        {
            prefabRoot = PrefabUtility.LoadPrefabContents(prefabPath);
            if (prefabRoot == null)
            {
                Debug.LogError("[UIEditorBridge] 无法加载 prefab: " + prefabPath);
                return;
            }

            var byFileId = BuildRectTransformFileIdMap(prefabRoot);
            var byName = BuildRectTransformNameMap(prefabRoot);
            int changed = 0;
            int skipped = 0;

            if (doc.root.children != null)
            {
                var rootRect = prefabRoot.GetComponent<RectTransform>();
                foreach (var child in doc.root.children)
                {
                    if (rootRect != null && (doc.root.children.Length == 1 || child.name == prefabRoot.name))
                    {
                        ApplyExistingNode(rootRect, child, doc.canvasWidth, doc.canvasHeight);
                        changed++;
                        if (child.children != null)
                        {
                            foreach (var grandChild in child.children)
                                ApplyNodeRecursive(grandChild, rootRect, byFileId, byName, ref changed, ref skipped);
                        }
                    }
                    else
                    {
                        ApplyNodeRecursive(child, rootRect, byFileId, byName, ref changed, ref skipped);
                    }
                }
            }

            PrefabUtility.SaveAsPrefabAsset(prefabRoot, prefabPath);
            Debug.Log("[UIEditorBridge] 增量写回完成: " + prefabPath + ", 更新 " + changed + " 个节点, 跳过 " + skipped + " 个节点");
        }
        finally
        {
            if (prefabRoot != null) PrefabUtility.UnloadPrefabContents(prefabRoot);
            AssetDatabase.Refresh();
        }
    }

    static string NormalizePrefabPath(string sourcePrefabPath)
    {
        string prefabPath = sourcePrefabPath.Replace("\\\\", "/").Trim();
        if (!prefabPath.StartsWith("Assets/"))
            prefabPath = "${ASSET_PATHS.prefab}/" + prefabPath.TrimStart('/');
        if (!prefabPath.EndsWith(".prefab"))
            prefabPath += ".prefab";
        return prefabPath;
    }

    static Dictionary<string, RectTransform> BuildRectTransformFileIdMap(GameObject root)
    {
        var map = new Dictionary<string, RectTransform>();
        foreach (var rect in root.GetComponentsInChildren<RectTransform>(true))
        {
            string guid;
            long localId;
            if (AssetDatabase.TryGetGUIDAndLocalFileIdentifier(rect, out guid, out localId))
                map[localId.ToString()] = rect;
            if (AssetDatabase.TryGetGUIDAndLocalFileIdentifier(rect.gameObject, out guid, out localId))
                map[localId.ToString()] = rect;
        }
        return map;
    }

    static Dictionary<string, List<RectTransform>> BuildRectTransformNameMap(GameObject root)
    {
        var map = new Dictionary<string, List<RectTransform>>(System.StringComparer.Ordinal);
        foreach (var rect in root.GetComponentsInChildren<RectTransform>(true))
        {
            if (!map.TryGetValue(rect.gameObject.name, out var list))
            {
                list = new List<RectTransform>();
                map[rect.gameObject.name] = list;
            }
            list.Add(rect);
        }
        return map;
    }

    static bool IsChildOf(Transform child, Transform parent)
    {
        if (child == null || parent == null) return false;
        var t = child;
        while (t != null)
        {
            if (t == parent) return true;
            t = t.parent;
        }
        return false;
    }

    static RectTransform ResolveTarget(SyncNode node, RectTransform parent, Dictionary<string, RectTransform> byFileId, Dictionary<string, List<RectTransform>> byName)
    {
        if (!string.IsNullOrEmpty(node.unityFileId) && byFileId.TryGetValue(node.unityFileId, out var byId))
            return byId;

        var targetName = node.name;
        if (!string.IsNullOrEmpty(targetName) && targetName.StartsWith("@")) targetName = targetName.Substring(1);
        if (!string.IsNullOrEmpty(targetName) && byName.TryGetValue(targetName, out var list))
        {
            if (list.Count == 1) return list[0];
            foreach (var rect in list)
                if (parent == null || IsChildOf(rect.transform, parent))
                    return rect;
        }
        return null;
    }

    static void ApplyNodeRecursive(SyncNode node, RectTransform parent, Dictionary<string, RectTransform> byFileId, Dictionary<string, List<RectTransform>> byName, ref int changed, ref int skipped)
    {
        var target = ResolveTarget(node, parent, byFileId, byName);
        if (target != null)
        {
            ApplyExistingNode(target, node, parent != null ? parent.rect.width : 0, parent != null ? parent.rect.height : 0);
            changed++;
            parent = target;
        }
        else
        {
            skipped++;
        }

        if (node.children != null)
        {
            foreach (var child in node.children)
                ApplyNodeRecursive(child, parent, byFileId, byName, ref changed, ref skipped);
        }
    }

    static void ApplyExistingNode(RectTransform rect, SyncNode node, float parentW, float parentH)
    {
        var go = rect.gameObject;
        if (!string.IsNullOrEmpty(node.name))
            go.name = node.name.StartsWith("@") ? node.name.Substring(1) : node.name;
        go.SetActive(node.active);
        SetRect(rect, node, parentW, parentH);

        var text = go.GetComponent<Text>();
        if (text != null) ApplyTextProperties(text, node);

        var image = go.GetComponent<Image>();
        if (image != null) ApplyImageProperties(go, image, node);

        var button = go.GetComponent<Button>();
        if (button != null) ApplyButtonProperties(button, node);
    }

    static void ApplyTextProperties(Text txt, SyncNode node)
    {
        if (node.text != null) txt.text = node.text;
        if (!string.IsNullOrEmpty(node.fontPath)) txt.font = LoadFont(node.fontPath);
        if (node.style != null && node.style.fontSize > 0) txt.fontSize = Mathf.RoundToInt(node.style.fontSize);
        txt.fontStyle = (FontStyle)(node.fontStyle);
        txt.alignment = (TextAnchor)(node.alignment);
        txt.horizontalOverflow = (HorizontalWrapMode)node.horizontalOverflow;
        txt.verticalOverflow = (VerticalWrapMode)node.verticalOverflow;
        txt.lineSpacing = node.lineSpacing > 0 ? node.lineSpacing : 1f;
        txt.supportRichText = node.richText;
        txt.resizeTextForBestFit = node.bestFit;
        txt.resizeTextMinSize = node.bestFitMinSize > 0 ? node.bestFitMinSize : 2;
        txt.resizeTextMaxSize = node.bestFitMaxSize > 0 ? node.bestFitMaxSize : 300;
        txt.raycastTarget = node.raycastTarget;
        if (node.style != null && !string.IsNullOrEmpty(node.style.fontColor))
            txt.color = ParseColor(node.style.fontColor, txt.color);
    }

    static void ApplyImageProperties(GameObject go, Image img, SyncNode node)
    {
        img.enabled = node.imageEnabled;
        if (!string.IsNullOrEmpty(node.imagePath))
            img.sprite = LoadSprite(node.imagePath);
        if (!string.IsNullOrEmpty(node.imageColor))
            img.color = ParseColor(node.imageColor, img.color);
        img.raycastTarget = node.imageRaycastTarget;
        switch (node.imageType)
        {
            case "Sliced": img.type = Image.Type.Sliced; break;
            case "Tiled": img.type = Image.Type.Tiled; break;
            case "Filled":
                img.type = Image.Type.Filled;
                img.fillMethod = (Image.FillMethod)node.fillMethod;
                img.fillAmount = node.fillAmount > 0 ? node.fillAmount : 1f;
                img.fillClockwise = node.fillClockwise;
                img.fillOrigin = node.fillOrigin;
                break;
            case "Simple": img.type = Image.Type.Simple; break;
        }
        img.preserveAspect = node.preserveAspect;
        ApplyMirror(go, node.mirrorType);
    }

    static void ApplyButtonProperties(Button btn, SyncNode node)
    {
        btn.interactable = node.interactable;
    }

    static System.Type FindType(params string[] names)
    {
        foreach (var name in names)
        {
            var type = System.Type.GetType(name);
            if (type != null) return type;
            foreach (var asm in System.AppDomain.CurrentDomain.GetAssemblies())
            {
                try
                {
                    type = asm.GetType(name);
                    if (type != null) return type;
                }
                catch {}
            }
        }
        return null;
    }

    static void ApplyGradient(GameObject go, SyncGradient gradient)
    {
        if (gradient == null || string.IsNullOrEmpty(gradient.color1)) return;
        var gradientType = FindType("UnityEngine.UI.UIGradient", "UIGradient", "Coffee.UIEffects.UIGradient");
        if (gradientType == null)
        {
            Debug.LogWarning("[UIEditorBridge] 当前工程未找到 UIGradient 类型，跳过渐变");
            return;
        }

        var comp = go.GetComponent(gradientType);
        if (comp == null) comp = go.AddComponent(gradientType);

        var color1 = ParseColor(gradient.color1, Color.white);
        var color2 = ParseColor(gradient.color2, Color.gray);
        var flags = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;

        var p1 = gradientType.GetProperty("color1", flags);
        if (p1 != null && p1.CanWrite) p1.SetValue(comp, color1, null);
        var p2 = gradientType.GetProperty("color2", flags);
        if (p2 != null && p2.CanWrite) p2.SetValue(comp, color2, null);

        var gradientField = gradientType.GetField("_gradient", flags);
        if (gradientField != null && gradientField.FieldType == typeof(Gradient))
        {
            var g = new Gradient();
            g.SetKeys(
                new[] { new GradientColorKey(color1, 0f), new GradientColorKey(color2, 1f) },
                new[] { new GradientAlphaKey(color1.a, 0f), new GradientAlphaKey(color2.a, 1f) }
            );
            gradientField.SetValue(comp, g);
        }

        var directionName = gradient.direction == "Horizontal" ? "Horizontal" : "Vertical";
        var dirProp = gradientType.GetProperty("direction", flags);
        if (dirProp != null && dirProp.CanWrite && dirProp.PropertyType.IsEnum)
            dirProp.SetValue(comp, System.Enum.Parse(dirProp.PropertyType, directionName), null);
        var dirField = gradientType.GetField("_dir", flags);
        if (dirField != null && dirField.FieldType.IsEnum)
            dirField.SetValue(comp, System.Enum.Parse(dirField.FieldType, directionName));
    }

    static void ApplyMirror(GameObject go, string mirrorType)
    {
        if (string.IsNullOrEmpty(mirrorType)) return;
        var mirrorImageType = FindType("MirrorImage");
        if (mirrorImageType == null)
        {
            Debug.LogWarning("[UIEditorBridge] 当前工程未找到 MirrorImage 类型，跳过镜像");
            return;
        }

        var comp = go.GetComponent(mirrorImageType);
        if (comp == null) comp = go.AddComponent(mirrorImageType);

        var prop = mirrorImageType.GetProperty("mirrorType", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
        if (prop != null && prop.CanWrite && prop.PropertyType.IsEnum)
            prop.SetValue(comp, System.Enum.Parse(prop.PropertyType, mirrorType), null);
    }

    static void BuildNode(SyncNode node, RectTransform parent, float parentW, float parentH, ref int count)
    {
        count++;

        // CommonPart 组件替换
        if (node.type == "component" && !string.IsNullOrEmpty(node.componentRef))
        {
            string prefabPath = COMMON_PART_FOLDER + node.componentRef + ".prefab";
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(prefabPath);
            if (prefab != null)
            {
                var instance = (GameObject)PrefabUtility.InstantiatePrefab(prefab, parent);
                instance.name = string.IsNullOrEmpty(node.name) ? node.componentRef : node.name;
                var rect = instance.GetComponent<RectTransform>();
                if (rect != null) SetRect(rect, node, parentW, parentH);
                return;
            }
        }

        var go = new GameObject(node.name ?? "Node");
        go.transform.SetParent(parent, false);
        var goRect = go.AddComponent<RectTransform>();
        SetRect(goRect, node, parentW, parentH);

        switch (node.type)
        {
            case "text": BuildText(go, node); break;
            case "image": BuildImage(go, node); break;
            case "button": BuildButton(go, node); break;
            case "rawimage": go.AddComponent<RawImage>(); break;
            case "scrollview": BuildScrollView(go, node); break;
            case "toggle": BuildToggle(go, node); break;
            case "inputfield": BuildInputField(go, node); break;
        }

        // Mask
        if (node.isMask)
        {
            if (node.maskType == "RectMask2D") go.AddComponent<RectMask2D>();
            else
            {
                go.AddComponent<Mask>().showMaskGraphic = true;
                if (go.GetComponent<Graphic>() == null)
                    go.AddComponent<Image>().color = new Color(1, 1, 1, 0.01f);
            }
        }

        // LayoutElement
        if (node.layoutElement != null && node.layoutElement._exists)
        {
            var le = go.AddComponent<LayoutElement>();
            le.ignoreLayout = node.layoutElement.ignoreLayout;
            le.minWidth = node.layoutElement.minWidth;
            le.minHeight = node.layoutElement.minHeight;
            le.preferredWidth = node.layoutElement.preferredWidth;
            le.preferredHeight = node.layoutElement.preferredHeight;
            le.flexibleWidth = node.layoutElement.flexibleWidth;
            le.flexibleHeight = node.layoutElement.flexibleHeight;
        }

        // LayoutGroup
        if (node.layoutGroup != null && node.layoutGroup._exists)
        {
            var lgPad = new RectOffset(
                Mathf.RoundToInt(node.layoutGroup.padLeft),
                Mathf.RoundToInt(node.layoutGroup.padRight),
                Mathf.RoundToInt(node.layoutGroup.padTop),
                Mathf.RoundToInt(node.layoutGroup.padBottom));

            if (node.layoutGroup.layoutType == "Grid")
            {
                var glg = go.AddComponent<GridLayoutGroup>();
                glg.enabled = node.layoutGroup.enabled;
                glg.padding = lgPad;
                glg.cellSize = new Vector2(node.layoutGroup.cellSizeX, node.layoutGroup.cellSizeY);
                glg.spacing = new Vector2(node.layoutGroup.spacing, node.layoutGroup.spacingY);
                glg.startCorner = (GridLayoutGroup.Corner)node.layoutGroup.startCorner;
                glg.startAxis = (GridLayoutGroup.Axis)node.layoutGroup.startAxis;
                glg.childAlignment = (TextAnchor)node.layoutGroup.childAlignment;
                glg.constraint = (GridLayoutGroup.Constraint)node.layoutGroup.constraint;
                glg.constraintCount = Mathf.Max(1, node.layoutGroup.constraintCount);
            }
            else if (node.layoutGroup.isHorizontal)
            {
                var hlg = go.AddComponent<HorizontalLayoutGroup>();
                hlg.enabled = node.layoutGroup.enabled;
                hlg.spacing = node.layoutGroup.spacing;
                hlg.padding = lgPad;
                hlg.childAlignment = (TextAnchor)node.layoutGroup.childAlignment;
                hlg.childControlWidth = node.layoutGroup.childControlWidth;
                hlg.childControlHeight = node.layoutGroup.childControlHeight;
                hlg.childForceExpandWidth = node.layoutGroup.childForceExpandWidth;
                hlg.childForceExpandHeight = node.layoutGroup.childForceExpandHeight;
                hlg.reverseArrangement = node.layoutGroup.reverseArrangement;
            }
            else
            {
                var vlg = go.AddComponent<VerticalLayoutGroup>();
                vlg.enabled = node.layoutGroup.enabled;
                vlg.spacing = node.layoutGroup.spacing;
                vlg.padding = lgPad;
                vlg.childAlignment = (TextAnchor)node.layoutGroup.childAlignment;
                vlg.childControlWidth = node.layoutGroup.childControlWidth;
                vlg.childControlHeight = node.layoutGroup.childControlHeight;
                vlg.childForceExpandWidth = node.layoutGroup.childForceExpandWidth;
                vlg.childForceExpandHeight = node.layoutGroup.childForceExpandHeight;
                vlg.reverseArrangement = node.layoutGroup.reverseArrangement;
            }
        }

        // ContentSizeFitter
        if (node.contentSizeFitter != null && node.contentSizeFitter._exists)
        {
            var csf = go.AddComponent<ContentSizeFitter>();
            csf.enabled = node.contentSizeFitter.enabled;
            csf.horizontalFit = (ContentSizeFitter.FitMode)node.contentSizeFitter.horizontalFit;
            csf.verticalFit = (ContentSizeFitter.FitMode)node.contentSizeFitter.verticalFit;
        }

        // 递归子节点（scrollview 的子节点挂到 Content 下）
        if (node.children != null)
        {
            RectTransform childParent = goRect;
            if (_scrollContentMap.TryGetValue(go, out var contentRect2))
                childParent = contentRect2;

            bool hasLayoutGroup = node.layoutGroup != null && node.layoutGroup._exists && node.layoutGroup.enabled;

            foreach (var child in node.children)
            {
                BuildNode(child, childParent, node.width, node.height, ref count);

                if (hasLayoutGroup)
                {
                    var childGo = childParent.GetChild(childParent.childCount - 1);
                    var childRect = childGo.GetComponent<RectTransform>();
                    if (childRect != null)
                    {
                        childRect.anchorMin = new Vector2(0, 1);
                        childRect.anchorMax = new Vector2(0, 1);
                        childRect.pivot = new Vector2(0, 1);
                    }
                }
            }

            if (hasLayoutGroup)
                LayoutRebuilder.ForceRebuildLayoutImmediate(goRect);
        }

        // 隐藏节点：SetActive(false) 放在最后，确保子节点构建完成
        if (!node.active) go.SetActive(false);
    }

    static void SetRect(RectTransform rect, SyncNode node, float parentW, float parentH)
    {
        if (node.anchorMin != null) rect.anchorMin = new Vector2(node.anchorMin.x, node.anchorMin.y);
        if (node.anchorMax != null) rect.anchorMax = new Vector2(node.anchorMax.x, node.anchorMax.y);
        if (node.pivot != null) rect.pivot = new Vector2(node.pivot.x, node.pivot.y);
        if (node.anchoredPosition != null) rect.anchoredPosition = new Vector2(node.anchoredPosition.x, node.anchoredPosition.y);
        if (node.sizeDelta != null) rect.sizeDelta = new Vector2(node.sizeDelta.x, node.sizeDelta.y);
        if (node.localScale != null) rect.localScale = new Vector3(node.localScale.x, node.localScale.y, 1);
        rect.localRotation = Quaternion.Euler(0, 0, -node.rotation);
    }

    static Sprite LoadSprite(string assetPath)
    {
        if (string.IsNullOrEmpty(assetPath)) return null;
        // 移除扩展名中可能的 .png 尝试加载
        var sprite = AssetDatabase.LoadAssetAtPath<Sprite>(assetPath);
        if (sprite == null)
        {
            // 尝试作为子资产（atlas 中的 sprite）
            var objs = AssetDatabase.LoadAllAssetsAtPath(assetPath);
            foreach (var o in objs)
                if (o is Sprite s) return s;
        }
        return sprite;
    }

    static Color ParseColor(string hex, Color fallback)
    {
        if (string.IsNullOrEmpty(hex)) return fallback;
        if (hex.StartsWith("#")) hex = hex.Substring(1);
        if (hex.Length >= 6)
        {
            float r = int.Parse(hex.Substring(0, 2), System.Globalization.NumberStyles.HexNumber) / 255f;
            float g = int.Parse(hex.Substring(2, 2), System.Globalization.NumberStyles.HexNumber) / 255f;
            float b = int.Parse(hex.Substring(4, 2), System.Globalization.NumberStyles.HexNumber) / 255f;
            float a = hex.Length >= 8 ? int.Parse(hex.Substring(6, 2), System.Globalization.NumberStyles.HexNumber) / 255f : 1f;
            return new Color(r, g, b, a);
        }
        return fallback;
    }

    static Font LoadFont(string fontPath)
    {
        if (string.IsNullOrEmpty(fontPath)) return Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
        var font = AssetDatabase.LoadAssetAtPath<Font>(fontPath);
        return font ?? Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
    }

    static void BuildText(GameObject go, SyncNode node)
    {
        var txt = go.AddComponent<Text>();
        txt.text = node.text ?? "";
        txt.font = LoadFont(node.fontPath);
        txt.fontSize = node.style != null ? Mathf.RoundToInt(node.style.fontSize) : 24;
        txt.fontStyle = (FontStyle)(node.fontStyle);
        txt.alignment = (TextAnchor)(node.alignment);
        txt.horizontalOverflow = (HorizontalWrapMode)node.horizontalOverflow;
        txt.verticalOverflow = (VerticalWrapMode)node.verticalOverflow;
        txt.lineSpacing = node.lineSpacing > 0 ? node.lineSpacing : 1f;
        txt.supportRichText = node.richText;
        txt.resizeTextForBestFit = node.bestFit;
        txt.resizeTextMinSize = node.bestFitMinSize > 0 ? node.bestFitMinSize : 2;
        txt.resizeTextMaxSize = node.bestFitMaxSize > 0 ? node.bestFitMaxSize : 300;
        txt.raycastTarget = node.raycastTarget;
        if (node.style != null && !string.IsNullOrEmpty(node.style.fontColor))
            txt.color = ParseColor(node.style.fontColor, Color.white);

        ApplyTextEffect(go, node.textOutline, true);
        ApplyTextEffect(go, node.textShadow, false);

        // Gradient
        if (node.textGradient != null && !string.IsNullOrEmpty(node.textGradient.color1))
        {
            try
            {
                ApplyGradient(go, node.textGradient);
            }
            catch (System.Exception ex) { Debug.LogWarning("[UIEditorBridge] UIGradient 失败: " + ex.Message); }
        }
    }

    static void ApplyTextEffect(GameObject go, SyncTextEffect effect, bool outline)
    {
        if (effect == null || string.IsNullOrEmpty(effect.color)) return;
        var distance = EffectDistance(effect, outline ? new Vector2(1f, 1f) : new Vector2(1f, -1f));
        var color = ParseColor(effect.color, Color.black);

        if (effect.source == "UIShadow" || effect.style > 0)
        {
            int defaultStyle = outline ? 2 : 1;
            if (ApplyUIShadow(go, effect, color, distance, effect.style > 0 ? effect.style : defaultStyle))
                return;
        }

        if (outline)
        {
            var comp = go.AddComponent<Outline>();
            comp.effectColor = color;
            comp.effectDistance = distance;
            comp.useGraphicAlpha = effect.useGraphicAlpha;
        }
        else
        {
            var comp = go.AddComponent<Shadow>();
            comp.effectColor = color;
            comp.effectDistance = distance;
            comp.useGraphicAlpha = effect.useGraphicAlpha;
        }
    }

    static Vector2 EffectDistance(SyncTextEffect effect, Vector2 fallback)
    {
        return effect.distance != null && effect.distance.Length >= 2
            ? new Vector2(effect.distance[0], effect.distance[1])
            : fallback;
    }

    static bool ApplyUIShadow(GameObject go, SyncTextEffect effect, Color color, Vector2 distance, int style)
    {
        var shadowType = FindType("Camel.UIEffects.UIShadow");
        if (shadowType == null) return false;

        var comp = go.AddComponent(shadowType);
        var flags = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;
        SetMember(shadowType, comp, flags, "effectColor", color);
        SetMember(shadowType, comp, flags, "effectDistance", distance);
        SetMember(shadowType, comp, flags, "useGraphicAlpha", effect.useGraphicAlpha);
        SetEnumMember(shadowType, comp, flags, "style", style);
        return true;
    }

    static void SetMember(System.Type type, Component comp, BindingFlags flags, string name, object value)
    {
        var prop = type.GetProperty(name, flags);
        if (prop != null && prop.CanWrite) { prop.SetValue(comp, value, null); return; }
        var field = type.GetField(name, flags);
        if (field != null) field.SetValue(comp, value);
    }

    static void SetEnumMember(System.Type type, Component comp, BindingFlags flags, string name, int value)
    {
        var prop = type.GetProperty(name, flags);
        if (prop != null && prop.CanWrite && prop.PropertyType.IsEnum)
        {
            prop.SetValue(comp, System.Enum.ToObject(prop.PropertyType, value), null);
            return;
        }
        var field = type.GetField(name, flags);
        if (field != null && field.FieldType.IsEnum)
            field.SetValue(comp, System.Enum.ToObject(field.FieldType, value));
    }

    static void BuildImage(GameObject go, SyncNode node)
    {
        var img = go.AddComponent<Image>();
        img.enabled = node.imageEnabled;
        img.sprite = LoadSprite(node.imagePath);
        if (!string.IsNullOrEmpty(node.imageColor))
            img.color = ParseColor(node.imageColor, Color.white);
        img.raycastTarget = node.imageRaycastTarget;

        if (!string.IsNullOrEmpty(node.imageType))
        {
            switch (node.imageType)
            {
                case "Sliced": img.type = Image.Type.Sliced; break;
                case "Tiled": img.type = Image.Type.Tiled; break;
                case "Filled":
                    img.type = Image.Type.Filled;
                    img.fillMethod = (Image.FillMethod)node.fillMethod;
                    img.fillAmount = node.fillAmount > 0 ? node.fillAmount : 1f;
                    img.fillClockwise = node.fillClockwise;
                    img.fillOrigin = node.fillOrigin;
                    break;
                default: img.type = Image.Type.Simple; break;
            }
        }
        img.preserveAspect = node.preserveAspect;

        // Outline 组件
        if (node.outline != null && !string.IsNullOrEmpty(node.outline.color))
        {
            var outline = go.AddComponent<Outline>();
            outline.effectColor = ParseColor(node.outline.color, Color.black);
            if (node.outline.distance != null && node.outline.distance.Length >= 2)
                outline.effectDistance = new Vector2(node.outline.distance[0], node.outline.distance[1]);
            outline.useGraphicAlpha = node.outline.useGraphicAlpha;
        }

        // MirrorImage 镜像
        if (!string.IsNullOrEmpty(node.mirrorType))
        {
            ApplyMirror(go, node.mirrorType);
        }
    }

    static void BuildButton(GameObject go, SyncNode node)
    {
        if (node.hasImage) BuildImage(go, node);
        var btn = go.AddComponent<Button>();
        btn.interactable = node.interactable;
    }

    static Dictionary<GameObject, RectTransform> _scrollContentMap = new Dictionary<GameObject, RectTransform>();
    static List<GameObject> _scrollPendingResolve = new List<GameObject>();

    static void BuildScrollView(GameObject go, SyncNode node)
    {
        var img = go.AddComponent<Image>();
        img.color = !string.IsNullOrEmpty(node.imagePath) || !string.IsNullOrEmpty(node.imageColor)
            ? Color.white
            : new Color(1, 1, 1, 0.01f);
        ApplyImageProperties(go, img, node);

        var scroll = go.AddComponent<ScrollRect>();
        scroll.horizontal = node.scrollDirection == "horizontal" || node.scrollDirection == "both";
        scroll.vertical = node.scrollDirection != "horizontal";

        // 数据已含 Viewport 子节点：复用，子节点直接挂到 ScrollView 下，构建完成后再绑定 scroll.viewport/content
        bool hasDataViewport = false;
        if (node.children != null)
        {
            foreach (var c in node.children)
            {
                if (c != null && c.name == "Viewport") { hasDataViewport = true; break; }
            }
        }
        if (hasDataViewport)
        {
            _scrollPendingResolve.Add(go);
            return;
        }

        var viewportGo = new GameObject("Viewport");
        viewportGo.transform.SetParent(go.transform, false);
        var viewportRect = viewportGo.AddComponent<RectTransform>();
        viewportRect.anchorMin = Vector2.zero;
        viewportRect.anchorMax = Vector2.one;
        viewportRect.sizeDelta = Vector2.zero;
        viewportRect.anchoredPosition = Vector2.zero;
        viewportGo.AddComponent<Image>().color = new Color(1, 1, 1, 0.01f);
        viewportGo.AddComponent<Mask>().showMaskGraphic = false;

        var contentGo = new GameObject("Content");
        contentGo.transform.SetParent(viewportGo.transform, false);
        var contentRect = contentGo.AddComponent<RectTransform>();
        if (scroll.vertical)
        {
            contentRect.anchorMin = new Vector2(0, 1);
            contentRect.anchorMax = Vector2.one;
            contentRect.pivot = new Vector2(0.5f, 1f);
        }
        else
        {
            contentRect.anchorMin = Vector2.zero;
            contentRect.anchorMax = new Vector2(0, 1);
            contentRect.pivot = new Vector2(0f, 0.5f);
        }
        contentRect.sizeDelta = new Vector2(scroll.horizontal ? node.width * 2 : 0, scroll.vertical ? node.height * 2 : 0);
        contentRect.anchoredPosition = Vector2.zero;

        scroll.viewport = viewportRect;
        scroll.content = contentRect;
        _scrollContentMap[go] = contentRect;
    }

    // 数据已含 Viewport 时延迟绑定 scroll.viewport/content（子节点构建完后）
    static void ResolveScrollViewBindings()
    {
        foreach (var go in _scrollPendingResolve)
        {
            if (go == null) continue;
            var scroll = go.GetComponent<ScrollRect>();
            if (scroll == null) continue;

            Transform viewportT = go.transform.Find("Viewport");
            if (viewportT != null)
            {
                scroll.viewport = viewportT as RectTransform;
                Transform contentT = viewportT.Find("Content");
                if (contentT != null) scroll.content = contentT as RectTransform;
            }
        }
        _scrollPendingResolve.Clear();
    }

    static void BuildToggle(GameObject go, SyncNode node)
    {
        go.AddComponent<Image>().color = new Color(1, 1, 1, 0.01f);
        var toggle = go.AddComponent<Toggle>();
        toggle.isOn = node.isOn;
    }

    static void BuildInputField(GameObject go, SyncNode node)
    {
        go.AddComponent<Image>().color = new Color(1, 1, 1, 0.1f);
        go.AddComponent<InputField>();
    }

    // ===== JSON 数据结构 =====
    [System.Serializable] public class SyncDocument { public string version; public string name; public string sourcePrefabPath; public int canvasWidth; public int canvasHeight; public SyncNode root; }
    [System.Serializable] public class SyncNode
    {
        public string name, type, componentRef, text, imagePath, imageType, imageColor, fontPath, maskType, scrollDirection, mirrorType;
        public float x, y, width, height, rotation, lineSpacing = 1f, fillAmount = 1f;
        public int fontStyle, alignment, horizontalOverflow, verticalOverflow, bestFitMinSize = 2, bestFitMaxSize = 300, fillMethod, fillOrigin;
        public bool richText = true, bestFit, raycastTarget = true, isMask, interactable = true, isOn, fillCenter = true, fillClockwise = true, preserveAspect, imageRaycastTarget = true, imageEnabled = true, hasImage = true, active = true;
        public SyncStyleData style;
        public SyncVec2 anchorMin, anchorMax, pivot, anchoredPosition, sizeDelta, localScale;
        public SyncSliceBorder sliceBorder;
        public SyncTextEffect textOutline, textShadow;
        public SyncGradient textGradient;
        public SyncOutline outline;
        public SyncLayoutElement layoutElement;
        public SyncLayoutGroup layoutGroup;
        public SyncCSF contentSizeFitter;
        public SyncNode[] children;
    }
    [System.Serializable] public class SyncStyleData { public string backgroundColor, borderColor, fontColor, fontWeight, textAlign; public float backgroundOpacity=1, borderWidth, borderRadius, fontSize, opacity=1; }
    [System.Serializable] public class SyncVec2 { public float x, y; }
    [System.Serializable] public class SyncSliceBorder { public int left, right, top, bottom; }
    [System.Serializable] public class SyncTextEffect { public string color, source; public float[] distance; public int style; public bool useGraphicAlpha = true; }
    [System.Serializable] public class SyncOutline { public string color; public float[] distance; public bool useGraphicAlpha = true; }
    [System.Serializable] public class SyncGradient { public string direction, color1, color2; }
    [System.Serializable] public class SyncLayoutElement { public bool _exists, ignoreLayout; public float minWidth=-1, minHeight=-1, preferredWidth=-1, preferredHeight=-1, flexibleWidth=-1, flexibleHeight=-1; }
    [System.Serializable] public class SyncLayoutGroup { public bool _exists, enabled=true, isHorizontal, childControlWidth, childControlHeight, childForceExpandWidth, childForceExpandHeight, reverseArrangement; public float spacing, padLeft, padRight, padTop, padBottom, cellSizeX=100, cellSizeY=100, spacingY; public int childAlignment, startCorner, startAxis, constraint, constraintCount=2; public string layoutType; }
    [System.Serializable] public class SyncCSF { public bool _exists, enabled=true; public int horizontalFit, verticalFit; }

    // ===== 截图功能 =====
    [MenuItem("UIEditor/Bridge Screenshot")]
    public static void CaptureScreenshot()
    {
        string screenshotPath = Path.Combine(Application.dataPath, "..", "Assets/Editor/uieditor_screenshot.png");

        // 确保预览 Canvas 存在
        var canvas = GameObject.Find("__UIEditorPreview__");
        if (canvas == null) { Debug.LogError("[UIEditorBridge] 预览 Canvas 不存在，请先同步"); return; }

        // 强制刷新
        UnityEngine.Canvas.ForceUpdateCanvases();

        // 打开 Game View 确保可以截图
        var gameViewType = System.Type.GetType("UnityEditor.GameView,UnityEditor");
        if (gameViewType != null)
        {
            var gameView = EditorWindow.GetWindow(gameViewType, false, null, true);
            gameView.Repaint();
        }

        // 延迟一帧确保渲染完成
        EditorApplication.delayCall += () =>
        {
            ScreenCapture.CaptureScreenshot(screenshotPath, 1);
            Debug.Log("[UIEditorBridge] 截图指令已发送: " + screenshotPath);

            // 再延迟等文件写完
            EditorApplication.delayCall += () =>
            {
                EditorApplication.delayCall += () =>
                {
                    if (File.Exists(screenshotPath))
                        Debug.Log("[UIEditorBridge] 截图完成 (" + new FileInfo(screenshotPath).Length / 1024 + "KB)");
                    else
                        Debug.LogWarning("[UIEditorBridge] 截图文件未生成，可能需要在 Play 模式下截图");
                };
            };
        };
    }
}
`;
}

function generateCorsProxyScript(): string {
  const PFX_BASE64 = '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';
  return `using UnityEngine;
using UnityEditor;
using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Authentication;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Threading;

/// <summary>
/// HTTPS CORS 代理 — 让部署在远程 HTTPS 服务器上的编辑器跨域访问本地 MCP 服务
/// 使用 TcpListener + SslStream 提供 HTTPS，无需管理员权限
/// 监听 8081 端口，转发请求到 MCP 的 8080 端口并添加 CORS 头
/// Unity Editor 启动时自动运行
/// 首次使用需在浏览器中访问 https://127.0.0.1:8081 并接受自签名证书
/// </summary>
[InitializeOnLoad]
public static class UIEditorCorsProxy
{
    private const int PROXY_PORT = 8081;
    private const string MCP_TARGET = "http://127.0.0.1:8080";
    private const string PFX_PASSWORD = "uieditor";

    /// <summary>浏览器通过 /sync 端点直接推送的 JSON 数据，桥接脚本从这里读取</summary>
    public static string LastSyncJson;

    // 嵌入的自签名证书 (SAN: 127.0.0.1 + localhost, 有效期 10 年)
    private const string PFX_BASE64 = "${PFX_BASE64}";

    private static TcpListener _listener;
    private static Thread _thread;
    private static bool _running;
    private static X509Certificate2 _cert;
    private static SynchronizationContext _mainContext;
    private static readonly object PendingLock = new object();
    private static readonly Queue<PendingSync> PendingSyncs = new Queue<PendingSync>();

    static UIEditorCorsProxy()
    {
        _mainContext = SynchronizationContext.Current;
        EditorApplication.update += ProcessPendingSyncs;
        Start();
        EditorApplication.quitting += Stop;
        AssemblyReloadEvents.beforeAssemblyReload += Stop;
    }

    static void Start()
    {
        if (_running) return;

        try
        {
            byte[] pfxBytes = Convert.FromBase64String(PFX_BASE64);
            _cert = new X509Certificate2(pfxBytes, PFX_PASSWORD);

            _listener = new TcpListener(IPAddress.Loopback, PROXY_PORT);
            _listener.Start();
            _running = true;

            _thread = new Thread(AcceptLoop) { IsBackground = true, Name = "UIEditorCorsProxy" };
            _thread.Start();

            Debug.Log($"[UIEditorCorsProxy] HTTPS CORS 代理已启动: https://127.0.0.1:{PROXY_PORT} -> {MCP_TARGET}");
            Debug.Log($"[UIEditorCorsProxy] 首次使用请在浏览器中访问 https://127.0.0.1:{PROXY_PORT} 并信任证书");
        }
        catch (Exception ex)
        {
            Debug.LogWarning($"[UIEditorCorsProxy] 启动失败: {ex.Message}");
        }
    }

    static void Stop()
    {
        _running = false;
        try { _listener?.Stop(); } catch { }
        try { _listener?.Server?.Close(); } catch { }
        _listener = null;
        try { if (_thread != null && _thread.IsAlive) _thread.Join(1500); } catch { }
        try { if (_thread != null && _thread.IsAlive) _thread.Interrupt(); } catch { }
        _thread = null;
    }

    static void AcceptLoop()
    {
        while (_running)
        {
            try
            {
                var client = _listener.AcceptTcpClient();
                ThreadPool.QueueUserWorkItem(_ => HandleClient(client));
            }
            catch (SocketException) { break; }
            catch (ObjectDisposedException) { break; }
            catch { }
        }
    }

    static void HandleClient(TcpClient client)
    {
        SslStream ssl = null;
        try
        {
            // Socket 级超时 (TcpClient.ReceiveTimeout 在某些实现里不会传到 SslStream 握手)
            client.Client.ReceiveTimeout = 5000;
            client.Client.SendTimeout = 5000;
            client.ReceiveTimeout = 5000;
            client.SendTimeout = 5000;

            ssl = new SslStream(client.GetStream(), false);

            // SSL 握手必须有超时 — 半开连接(浏览器 mixed-content 拦截)会让 AuthenticateAsServer
            // 永久阻塞，吃光线程池
            var authTask = ssl.BeginAuthenticateAsServer(_cert, false, SslProtocols.Tls12, false, null, null);
            if (!authTask.AsyncWaitHandle.WaitOne(5000))
            {
                try { ssl.Close(); } catch { }
                try { client.Close(); } catch { }
                return;
            }
            try { ssl.EndAuthenticateAsServer(authTask); }
            catch { return; }

            // 握手后恢复正常的读写超时
            client.Client.ReceiveTimeout = 30000;
            client.Client.SendTimeout = 30000;

            // 读取 HTTP 请求
            string method, path;
            Dictionary<string, string> headers;
            byte[] body;
            if (!ReadHttpRequest(ssl, out method, out path, out headers, out body))
                return;

            // CORS 头
            var corsHeaders = new StringBuilder();
            corsHeaders.Append("Access-Control-Allow-Origin: *\\r\\n");
            corsHeaders.Append("Access-Control-Allow-Methods: GET, POST, OPTIONS\\r\\n");
            corsHeaders.Append("Access-Control-Allow-Headers: Content-Type, Accept, Mcp-Session-Id, Access-Control-Request-Private-Network\\r\\n");
            corsHeaders.Append("Access-Control-Expose-Headers: Mcp-Session-Id\\r\\n");
            corsHeaders.Append("Access-Control-Allow-Private-Network: true\\r\\n");

            // OPTIONS 预检
            if (method == "OPTIONS")
            {
                WriteResponse(ssl, 204, "No Content", corsHeaders.ToString(), null);
                return;
            }

            // GET / — 证书信任确认页
            if (method == "GET" && (path == "/" || path == ""))
            {
                string html = "<html><body style='font-family:sans-serif;text-align:center;padding:60px'>" +
                    "<h2>LOA UIEditor CORS Proxy</h2>" +
                    "<p style='color:green;font-size:18px'>HTTPS 代理运行中，证书已信任！</p>" +
                    "<p>现在可以关闭此页面，回到编辑器使用。</p></body></html>";
                byte[] htmlBytes = Encoding.UTF8.GetBytes(html);
                WriteResponse(ssl, 200, "OK",
                    corsHeaders.ToString() + "Content-Type: text/html; charset=utf-8\\r\\n" +
                    $"Content-Length: {htmlBytes.Length}\\r\\n",
                    htmlBytes);
                return;
            }

            // POST /sync* — 浏览器直接推送同步 JSON 到内存。
            // /sync-preview 与 /sync-incremental 会在 Unity 主线程直接触发同步，绕开 MCP 菜单执行。
            if (method == "POST" && (path == "/sync" || path == "/sync-preview" || path == "/sync-incremental"))
            {
                string json = body != null && body.Length > 0 ? Encoding.UTF8.GetString(body) : "";
                if (body != null && body.Length > 0)
                {
                    Debug.Log($"[UIEditorCorsProxy] 收到同步数据: {body.Length} bytes");
                }
                if (path == "/sync")
                {
                    LastSyncJson = json;
                }
                else
                {
                    EnqueueSync(path, json);
                }
                byte[] ok = Encoding.UTF8.GetBytes("{\\"ok\\":true}");
                WriteResponse(ssl, 200, "OK",
                    corsHeaders.ToString() + "Content-Type: application/json\\r\\n" +
                    $"Content-Length: {ok.Length}\\r\\n", ok);
                return;
            }

            // 转发到 MCP
            var targetUrl = MCP_TARGET + path;
            var proxyReq = (HttpWebRequest)WebRequest.Create(targetUrl);
            proxyReq.Method = method;
            proxyReq.Timeout = 60000;
            proxyReq.ReadWriteTimeout = 60000;

            // 转发关键头
            string val;
            if (headers.TryGetValue("content-type", out val))
                proxyReq.ContentType = val;
            if (headers.TryGetValue("mcp-session-id", out val))
                proxyReq.Headers["Mcp-Session-Id"] = val;
            if (headers.TryGetValue("accept", out val))
                proxyReq.Accept = val;

            // 转发请求体
            if (body != null && body.Length > 0)
            {
                proxyReq.ContentLength = body.Length;
                using (var s = proxyReq.GetRequestStream())
                    s.Write(body, 0, body.Length);
            }

            // 获取 MCP 响应并转发
            using (var proxyRes = (HttpWebResponse)proxyReq.GetResponse())
            {
                var resHeaders = new StringBuilder(corsHeaders.ToString());

                // 转发 Content-Type
                if (!string.IsNullOrEmpty(proxyRes.ContentType))
                    resHeaders.Append($"Content-Type: {proxyRes.ContentType}\\r\\n");

                // 转发 Mcp-Session-Id
                var sid = proxyRes.Headers["Mcp-Session-Id"];
                if (!string.IsNullOrEmpty(sid))
                    resHeaders.Append($"Mcp-Session-Id: {sid}\\r\\n");

                bool isSSE = proxyRes.ContentType != null &&
                    proxyRes.ContentType.Contains("text/event-stream");

                using (var proxyStream = proxyRes.GetResponseStream())
                {
                    if (isSSE)
                    {
                        // SSE 流式响应：用 chunked transfer encoding
                        resHeaders.Append("Transfer-Encoding: chunked\\r\\n");
                        string statusLine = $"HTTP/1.1 {(int)proxyRes.StatusCode} {proxyRes.StatusDescription}\\r\\n";
                        byte[] headerData = Encoding.ASCII.GetBytes(statusLine + resHeaders.ToString() + "\\r\\n");
                        ssl.Write(headerData);
                        ssl.Flush();

                        // 流式转发
                        byte[] buf = new byte[4096];
                        int n;
                        while ((n = proxyStream.Read(buf, 0, buf.Length)) > 0)
                        {
                            // HTTP chunked: size\\r\\n data\\r\\n
                            byte[] chunkHeader = Encoding.ASCII.GetBytes(n.ToString("X") + "\\r\\n");
                            ssl.Write(chunkHeader);
                            ssl.Write(buf, 0, n);
                            ssl.Write(Encoding.ASCII.GetBytes("\\r\\n"));
                            ssl.Flush();
                        }
                        // 终止块
                        ssl.Write(Encoding.ASCII.GetBytes("0\\r\\n\\r\\n"));
                        ssl.Flush();
                    }
                    else
                    {
                        // 普通响应：读完再发
                        using (var ms = new MemoryStream())
                        {
                            proxyStream.CopyTo(ms);
                            byte[] resBody = ms.ToArray();
                            resHeaders.Append($"Content-Length: {resBody.Length}\\r\\n");
                            WriteResponse(ssl, (int)proxyRes.StatusCode,
                                proxyRes.StatusDescription, resHeaders.ToString(), resBody);
                        }
                    }
                }
            }
        }
        catch (WebException wex)
        {
            try
            {
                if (ssl != null)
                {
                    string errJson;
                    int code = 502;
                    if (wex.Response is HttpWebResponse httpErr)
                    {
                        code = (int)httpErr.StatusCode;
                        using (var s = httpErr.GetResponseStream())
                        using (var r = new StreamReader(s))
                            errJson = r.ReadToEnd();
                    }
                    else
                    {
                        errJson = "{\\"error\\": \\"" + wex.Message.Replace("\\"", "'") + "\\"}";
                    }
                    byte[] errBytes = Encoding.UTF8.GetBytes(errJson);
                    WriteResponse(ssl, code, "Error",
                        "Access-Control-Allow-Origin: *\\r\\nContent-Type: application/json\\r\\n" +
                        $"Content-Length: {errBytes.Length}\\r\\n", errBytes);
                }
            }
            catch { }
        }
        catch { }
        finally
        {
            try { ssl?.Close(); } catch { }
            try { client?.Close(); } catch { }
        }
    }

    static bool ReadHttpRequest(SslStream ssl, out string method, out string path,
        out Dictionary<string, string> headers, out byte[] body)
    {
        method = null; path = null;
        headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        body = null;

        // 读取头部（逐字节直到 \\r\\n\\r\\n）
        var headerBuf = new List<byte>(4096);
        int prev2 = 0, prev1 = 0;
        while (true)
        {
            int b = ssl.ReadByte();
            if (b < 0) return false;
            headerBuf.Add((byte)b);
            // 检测 \\r\\n\\r\\n (连续两个 CRLF 表示头部结束)
            if (prev2 == '\\n' && prev1 == '\\r' && b == '\\n')
                break;
            prev2 = prev1; prev1 = b;
            if (headerBuf.Count > 65536) return false; // 头部过大
        }

        string headerText = Encoding.ASCII.GetString(headerBuf.ToArray());
        string[] lines = headerText.Split(new[] { "\\r\\n" }, StringSplitOptions.None);
        if (lines.Length < 1) return false;

        // 解析请求行: METHOD PATH HTTP/1.1
        string[] parts = lines[0].Split(' ');
        if (parts.Length < 2) return false;
        method = parts[0].ToUpper();
        path = parts[1];

        // 解析头部
        for (int i = 1; i < lines.Length; i++)
        {
            int sep = lines[i].IndexOf(':');
            if (sep > 0)
                headers[lines[i].Substring(0, sep).Trim()] = lines[i].Substring(sep + 1).Trim();
        }

        // 读取 body
        string clStr;
        if (headers.TryGetValue("content-length", out clStr))
        {
            int cl;
            if (int.TryParse(clStr, out cl) && cl > 0)
            {
                body = new byte[cl];
                int offset = 0;
                while (offset < cl)
                {
                    int n = ssl.Read(body, offset, cl - offset);
                    if (n <= 0) break;
                    offset += n;
                }
            }
        }

        return true;
    }

    static void WriteResponse(SslStream ssl, int statusCode, string statusText,
        string extraHeaders, byte[] body)
    {
        var sb = new StringBuilder();
        sb.Append($"HTTP/1.1 {statusCode} {statusText}\\r\\n");
        sb.Append("Connection: close\\r\\n");
        if (!string.IsNullOrEmpty(extraHeaders))
            sb.Append(extraHeaders);
        sb.Append("\\r\\n");

        byte[] headerData = Encoding.ASCII.GetBytes(sb.ToString());
        ssl.Write(headerData);
        if (body != null && body.Length > 0)
            ssl.Write(body);
        ssl.Flush();
    }

    static void EnqueueSync(string path, string json)
    {
        lock (PendingLock)
        {
            PendingSyncs.Enqueue(new PendingSync { Path = path, Json = json });
        }
        _mainContext?.Post(_ => ProcessPendingSyncs(), null);
    }

    static void ProcessPendingSyncs()
    {
        while (true)
        {
            PendingSync sync = null;
            lock (PendingLock)
            {
                if (PendingSyncs.Count == 0) return;
                sync = PendingSyncs.Dequeue();
            }

            LastSyncJson = sync.Json;
            if (sync.Path == "/sync-preview")
            {
                UIEditorBridgeSync.SyncFromJson();
            }
            else if (sync.Path == "/sync-incremental")
            {
                UIEditorBridgeSync.SyncIncrementalFromJson();
            }
        }
    }

    class PendingSync
    {
        public string Path;
        public string Json;
    }
}
`;
}

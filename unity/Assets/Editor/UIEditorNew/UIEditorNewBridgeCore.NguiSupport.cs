using UnityEditor;
using UnityEngine;
using UnityEngine.SceneManagement;
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Reflection;

public static partial class UIEditorNewBridgeCore
{
    private static RectTransformRecord ToNguiRectRecord(Transform transform, SessionState rootSession = null)
    {
        if (transform == null || !HasNguiRect(transform)) return null;

        Vector2 pivot = new Vector2(0.5f, 0.5f);
        float width = 0f;
        float height = 0f;

        Component widget = GetNguiWidgetComponent(transform.gameObject);
        if (widget != null)
        {
            pivot = ReadReflectedVector2(widget, "pivotOffset", pivot);
            width = Mathf.Max(0f, ReadReflectedInt(widget, "width", 0));
            height = Mathf.Max(0f, ReadReflectedInt(widget, "height", 0));
        }
        else if (rootSession != null)
        {
            width = Mathf.Max(0f, rootSession.snapshotWidth > 0 ? rootSession.snapshotWidth : 1080);
            height = Mathf.Max(0f, rootSession.snapshotHeight > 0 ? rootSession.snapshotHeight : 1920);
        }

        Vector3 euler = transform.localEulerAngles;
        Vector3 local = transform.localPosition;
        return new RectTransformRecord
        {
            anchorMin = Floats(0.5f, 0.5f),
            anchorMax = Floats(0.5f, 0.5f),
            pivot = Floats(pivot.x, pivot.y),
            anchoredPosition = Floats(local.x, local.y),
            sizeDelta = Floats(width, height),
            localScale = Floats(transform.localScale.x, transform.localScale.y, transform.localScale.z),
            localEulerAngles = Floats(euler.x, euler.y, euler.z)
        };
    }

    private static bool ShouldRenderAsNgui(SessionState session, GameObject prefab)
    {
        if (session == null) return false;
        if (string.IsNullOrEmpty(session.framework) || session.framework == FrameworkUnknown)
            session.framework = DetectFramework(prefab);
        if (session.framework == FrameworkNGUI) return true;
        return session.framework == FrameworkMixed && HasNguiRootOrPanel(prefab);
    }

    private static bool HasNguiRootOrPanel(GameObject root)
    {
        if (root == null) return false;
        Component[] components = root.GetComponentsInChildren<Component>(true);
        for (int i = 0; i < components.Length; i++)
        {
            Component component = components[i];
            if (component == null) continue;
            Type type = component.GetType();
            if (IsTypeOrBaseName(type, "UIRoot") || IsTypeOrBaseName(type, "UIPanel"))
                return true;
        }
        return false;
    }

    private static bool IsNguiComponent(Component component)
    {
        if (component == null) return false;
        Type type = component.GetType();
        string assemblyName = type.Assembly != null ? type.Assembly.GetName().Name : "";
        if (!string.IsNullOrEmpty(assemblyName) && assemblyName.IndexOf("NGUI", StringComparison.OrdinalIgnoreCase) >= 0)
            return true;
        return IsTypeOrBaseName(type, "UIRect") ||
            IsTypeOrBaseName(type, "UIWidget") ||
            IsTypeOrBaseName(type, "UIPanel") ||
            IsTypeOrBaseName(type, "UIRoot") ||
            IsTypeOrBaseName(type, "UICamera") ||
            IsTypeOrBaseName(type, "UIWidgetContainer") ||
            IsTypeOrBaseName(type, "UIButtonColor");
    }

    private static Component GetNguiWidgetComponent(GameObject go)
    {
        if (go == null) return null;
        Component[] components = go.GetComponents<Component>();
        for (int i = 0; i < components.Length; i++)
        {
            Component component = components[i];
            if (component != null && IsTypeOrBaseName(component.GetType(), "UIWidget"))
                return component;
        }
        return null;
    }

    private static Component GetNguiSpriteComponent(GameObject go)
    {
        if (go == null) return null;
        Component[] components = go.GetComponents<Component>();
        for (int i = 0; i < components.Length; i++)
        {
            Component component = components[i];
            if (component == null) continue;
            Type type = component.GetType();
            if (IsTypeOrBaseName(type, "UIBasicSprite") || IsTypeOrBaseName(type, "UISprite") || IsTypeOrBaseName(type, "UITexture") || IsTypeOrBaseName(type, "UI2DSprite"))
                return component;
        }
        return null;
    }

    private static bool HasNguiRect(Transform transform)
    {
        if (transform == null) return false;
        Component[] components = transform.GetComponents<Component>();
        for (int i = 0; i < components.Length; i++)
        {
            Component component = components[i];
            if (component == null) continue;
            Type type = component.GetType();
            if (IsTypeOrBaseName(type, "UIRect") || IsTypeOrBaseName(type, "UIWidget") || IsTypeOrBaseName(type, "UIPanel"))
                return true;
        }
        foreach (Transform child in transform)
            if (HasNguiRect(child)) return true;
        return false;
    }

    private static void CollectNguiBboxes(Transform root, Transform current, Camera camera, int width, int height, string[] targetNodeIds, List<BboxRecord> bboxes, Dictionary<Transform, string> nodeIdByTransform)
    {
        string path = GetTransformPath(root, current);
        string nodeId = ResolveCloneNodeId(root, current, nodeIdByTransform);
        if (ShouldIncludeNguiBbox(nodeId, targetNodeIds))
        {
            CaptureRect rect = CalculateNguiCaptureRect(current, camera, width, height);
            bool contributesToBounds = IsNguiDrawableBoundsSource(current);
            bboxes.Add(new BboxRecord
            {
                nodeId = nodeId,
                path = path,
                x = rect.x,
                y = rect.y,
                width = rect.width,
                height = rect.height,
                activeInHierarchy = current.gameObject.activeInHierarchy,
                space = "snapshot-pixel",
                contributesToBounds = contributesToBounds
            });
        }
        foreach (Transform child in current)
            CollectNguiBboxes(root, child, camera, width, height, targetNodeIds, bboxes, nodeIdByTransform);
    }

    private static bool ShouldIncludeNguiBbox(string nodeId, string[] targetNodeIds)
    {
        if (targetNodeIds == null || targetNodeIds.Length == 0) return true;
        for (int i = 0; i < targetNodeIds.Length; i++)
            if (targetNodeIds[i] == nodeId) return true;
        return false;
    }

    private static bool IsNguiDrawableBoundsSource(Transform transform)
    {
        if (transform == null) return false;
        Component widget = GetNguiWidgetComponent(transform.gameObject);
        if (widget == null) return false;
        Behaviour behaviour = widget as Behaviour;
        if (behaviour != null && !behaviour.enabled) return false;
        return true;
    }

    private static CaptureRect CalculateNguiCaptureRect(Transform target, Camera camera, int width, int height)
    {
        List<Vector3> corners = new List<Vector3>();
        CollectNguiWorldCorners(target, target, corners);
        if (corners.Count == 0)
        {
            Vector3 point = camera != null ? WorldToCapturePoint(camera, target.position, width, height) : Vector3.zero;
            return new CaptureRect { x = point.x, y = height - point.y, width = 0f, height = 0f };
        }

        float minX = float.PositiveInfinity;
        float minY = float.PositiveInfinity;
        float maxX = float.NegativeInfinity;
        float maxY = float.NegativeInfinity;
        for (int i = 0; i < corners.Count; i++)
        {
            Vector3 screen = WorldToCapturePoint(camera, corners[i], width, height);
            minX = Mathf.Min(minX, screen.x);
            minY = Mathf.Min(minY, screen.y);
            maxX = Mathf.Max(maxX, screen.x);
            maxY = Mathf.Max(maxY, screen.y);
        }
        return new CaptureRect
        {
            x = minX,
            y = height - maxY,
            width = Mathf.Max(0f, maxX - minX),
            height = Mathf.Max(0f, maxY - minY)
        };
    }

    private static Vector3 WorldToCapturePoint(Camera camera, Vector3 worldPosition, int width, int height)
    {
        if (camera == null || height <= 0) return Vector3.zero;
        if (!camera.orthographic)
        {
            // 透视相机极少用于 NGUI 截图，保底走原 API。
            Vector3 vp = camera.WorldToViewportPoint(worldPosition);
            return new Vector3(vp.x * width, vp.y * height, vp.z);
        }
        Vector3 local = camera.transform.InverseTransformPoint(worldPosition);
        float halfH = camera.orthographicSize;
        float aspect = (float)width / height;
        float halfW = halfH * aspect;
        float vx = 0.5f + (halfW > 0f ? local.x / (2f * halfW) : 0f);
        float vy = 0.5f + (halfH > 0f ? local.y / (2f * halfH) : 0f);
        return new Vector3(vx * width, vy * height, local.z);
    }

    private static void CollectNguiWorldCorners(Transform target, Transform current, List<Vector3> corners)
    {
        Component[] components = current.GetComponents<Component>();
        for (int i = 0; i < components.Length; i++)
        {
            Component component = components[i];
            if (component == null) continue;
            Type type = component.GetType();
            if (!IsTypeOrBaseName(type, "UIRect") && !IsTypeOrBaseName(type, "UIWidget") && !IsTypeOrBaseName(type, "UIPanel")) continue;
            Vector3[] values;
            if (!TryReadVector3ArrayProperty(component, "worldCorners", out values)) continue;
            for (int j = 0; j < values.Length; j++)
                corners.Add(values[j]);
        }

        if (corners.Count > 0 && current == target) return;
        foreach (Transform child in current)
            CollectNguiWorldCorners(target, child, corners);
    }

    private static void InitializeNguiSnapshotScale(SessionState session, GameObject prefab)
    {
        if (session == null || prefab == null || session.snapshotPixelsPerWorld > 0f) return;
        if (!ShouldRenderAsNgui(session, prefab)) return;

        Camera camera = FindBestCaptureCamera(prefab);
        if (camera == null || !camera.orthographic) return;

        int referenceHeight = session.snapshotHeight > 0 ? session.snapshotHeight : 1920;
        session.snapshotPixelsPerWorld = referenceHeight / Mathf.Max(0.0001f, 2f * camera.orthographicSize);
    }

    private static void ForceNguiRefresh(GameObject instance, bool updateLayout = true, bool initializeComponents = true)
    {
        if (instance == null) return;
        Component[] components = instance.GetComponentsInChildren<Component>(true);
        if (initializeComponents)
        {
            for (int i = 0; i < components.Length; i++)
            {
                Component component = components[i];
                if (component == null || !IsNguiComponent(component)) continue;
                InvokeReflectedMethod(component, "Start");
            }
        }
        if (updateLayout)
        {
            for (int i = 0; i < components.Length; i++)
            {
                Component component = components[i];
                if (component == null) continue;
                Type type = component.GetType();
                if (!IsTypeOrBaseName(type, "UIRoot") &&
                    !IsTypeOrBaseName(type, "UIRect") &&
                    !IsTypeOrBaseName(type, "UIAnchor"))
                    continue;
                InvokeReflectedMethod(component, "ResetAnchors");
                InvokeReflectedMethod(component, "Update");
                InvokeReflectedMethod(component, "UpdateAnchors");
            }
            for (int i = 0; i < components.Length; i++)
            {
                Component component = components[i];
                if (component == null) continue;
                Type type = component.GetType();
                if (!IsTypeOrBaseName(type, "UITable") && !IsTypeOrBaseName(type, "UIGrid")) continue;
                InvokeReflectedMethod(component, "Reposition");
            }
            for (int i = 0; i < components.Length; i++)
            {
                Component component = components[i];
                if (component == null) continue;
                if (!IsTypeOrBaseName(component.GetType(), "UIRect") &&
                    !IsTypeOrBaseName(component.GetType(), "UIAnchor"))
                    continue;
                InvokeReflectedMethod(component, "LateUpdate");
            }
        }
        if (initializeComponents)
        {
            for (int i = 0; i < components.Length; i++)
            {
                Component component = components[i];
                if (component == null || !IsTypeOrBaseName(component.GetType(), "UIPanel")) continue;
                InvokeReflectedMethod(component, "OnInit");
                InvokeReflectedMethod(component, "OnStart");
            }
        }
        for (int i = 0; i < components.Length; i++)
        {
            Component component = components[i];
            if (component == null) continue;
            if (IsTypeOrBaseName(component.GetType(), "UIWidget"))
                InvokeReflectedMethod(component, "MarkAsChanged");
        }
        for (int i = 0; i < components.Length; i++)
        {
            Component component = components[i];
            if (component == null || !IsTypeOrBaseName(component.GetType(), "UIPanel")) continue;
            InvokeReflectedMethod(component, "RebuildAllDrawCalls");
            InvokeReflectedMethod(component, "Refresh");
            InvokeReflectedMethod(component, "LateUpdate");
        }
    }

    // ===== NGUI 常驻隔离渲染（Step 2/3 重写核心）=====
    // 设计：working root 常驻 session 私有 previewScene 内、NGUI 组件全程 enabled=true 实时运行。
    // NGUI [ExecuteInEditMode] 自动构建 drawcall，drawcall 因 UIDrawCall.Create 源码改动（跟随 manager
    // 所在非 active scene）落进 previewScene，不溢出主工程 Game/Scene View。截图与 bbox 复用同一常驻
    // root + 同一常驻相机，nodeId 与 export-node-tree 同源（都走 BuildNodeId 的结构索引），天然对齐。

    // 让 working root（或 undo 恢复出的 root）在隔离场景里"活起来"：进 CaptureLayer、enable 所有 NGUI 组件、
    // 完整初始化并构建首帧几何。幂等，可重复调用。
    private static void EnableAndPrimeNgui(SessionState session, GameObject root)
    {
        if (root == null) return;
        SetLayerRecursive(root, CaptureLayer);

        Component[] components = root.GetComponentsInChildren<Component>(true);
        for (int i = 0; i < components.Length; i++)
        {
            Behaviour behaviour = components[i] as Behaviour;
            if (behaviour == null) continue;
            if (IsNguiComponent(behaviour) && !behaviour.enabled)
                behaviour.enabled = true;
        }
        if (session != null) session.suspendedNguiBehaviourStates.Clear();

        // 离屏 root 在编辑器非播放态不会被 Unity 自动 tick / Start，必须显式驱动 NGUI 生命周期。
        // PrimeNguiFrame 内部按序：Start panel/widget → widget.CreatePanel 关联 → anchors → MarkAsChanged
        // → panel.UpdateSelf 填几何建 drawcall。
        PrimeNguiFrame(root);
    }

    // 触发一帧 NGUI 几何重建：先确保 panel/widget 已 Start（mStarted）并完成 widget→panel 关联，
    // 再 anchors 更新、MarkAsChanged、panel.UpdateSelf。截图前调用。
    private static void PrimeNguiFrame(GameObject root)
    {
        if (root == null) return;
        Component[] components = root.GetComponentsInChildren<Component>(true);

        // 1. 先 Start 所有 UIPanel（设 mStarted，使后续 widget CreatePanel 能 UIPanel.Find 到）。
        for (int i = 0; i < components.Length; i++)
        {
            Component component = components[i];
            if (component != null && IsTypeOrBaseName(component.GetType(), "UIPanel"))
                InvokeReflectedMethod(component, "Start");
        }
        // 2. Start 所有 UIWidget 并显式 CreatePanel，建立 widget→panel 关联。
        //    离屏 LoadPrefabContents root 的 widget 不会被 Unity 自动 Start，panel 始终为 null、不填几何。
        for (int i = 0; i < components.Length; i++)
        {
            Component component = components[i];
            if (component == null || !IsTypeOrBaseName(component.GetType(), "UIWidget")) continue;
            InvokeReflectedMethod(component, "Start");
            InvokeReflectedMethod(component, "CreatePanel");
        }
        // 3. anchors / 布局更新。
        for (int i = 0; i < components.Length; i++)
        {
            Component component = components[i];
            if (component == null) continue;
            Type type = component.GetType();
            if (IsTypeOrBaseName(type, "UIRoot") || IsTypeOrBaseName(type, "UIRect") || IsTypeOrBaseName(type, "UIAnchor"))
            {
                InvokeReflectedMethod(component, "ResetAnchors");
                InvokeReflectedMethod(component, "Update");
                InvokeReflectedMethod(component, "UpdateAnchors");
            }
        }
        for (int i = 0; i < components.Length; i++)
        {
            Component component = components[i];
            if (component == null) continue;
            Type type = component.GetType();
            if (IsTypeOrBaseName(type, "UITable") || IsTypeOrBaseName(type, "UIGrid"))
                InvokeReflectedMethod(component, "Reposition");
        }
        // 4. 标记 widget 几何变更。
        for (int i = 0; i < components.Length; i++)
        {
            Component component = components[i];
            if (component != null && IsTypeOrBaseName(component.GetType(), "UIWidget"))
                InvokeReflectedMethod(component, "MarkAsChanged");
        }
        // 5. 驱动 panel 填充 widget 几何并建 drawcall（UpdateSelf 绕过 LateUpdate 帧守卫）。
        for (int i = 0; i < components.Length; i++)
        {
            Component component = components[i];
            if (component != null && IsTypeOrBaseName(component.GetType(), "UIPanel"))
                InvokeReflectedMethod(component, "UpdateSelf");
        }
    }

    // 在 session 的 previewScene 内建一台常驻离屏相机；参数取自 prefab 自带相机（= Game View 相机口径），
    // 没有则按画板尺寸构造正交相机。只渲染 CaptureLayer，截图与 bbox 投影共用它。
    private static Camera EnsureSessionNguiCamera(SessionState session, GameObject root)
    {
        if (session == null) return null;
        if (session.nguiCamera != null) return session.nguiCamera;

        Scene scene = EnsureSessionPreviewScene(session);
        GameObject cameraGo = new GameObject("__UIEditorNew_NguiCam__");
        cameraGo.hideFlags = HideFlags.HideAndDontSave;
        if (scene.IsValid() && scene.isLoaded)
            SceneManager.MoveGameObjectToScene(cameraGo, scene);

        Camera camera = cameraGo.AddComponent<Camera>();
        camera.enabled = false; // 只在 RenderSnapshot 手动 Render，不参与任何自动渲染循环
        // 关键：把相机绑定到 session 私有 preview scene。Camera.scene 不为 null 时相机只渲染该 scene 的内容
        // （Unity 仅支持 NewPreviewScene 创建的 scene）。这让普通 camera.Render() 能拍到 preview scene 里的
        // NGUI drawcall，同时该相机对主工程 Game/Scene View 完全不可见，达成物理隔离 + 可渲染。
        if (scene.IsValid() && scene.isLoaded)
            camera.scene = scene;
        camera.clearFlags = CameraClearFlags.SolidColor;
        // camera.scene 已把渲染限定在 previewScene 内，无需再靠 layer 区分；用 everything 兜底
        // 避免 drawcall layer 与 CaptureLayer 不一致时漏拍。
        camera.cullingMask = ~0;
        camera.allowHDR = false;
        camera.allowMSAA = false;
        camera.nearClipPlane = 0.01f;
        camera.farClipPlane = 3000f;

        // NGUI 正交相机：UIRoot 把内容归一到像素尺度（1 世界单位 ≈ 1 像素），内容以原点为中心。
        // 因此正交相机看向 -Z、orthographicSize = 画板高度/2 即可与 Game View 取景一致。
        // 不直接复制 prefab 自带相机的 orthographicSize（NGUI 场景相机常为 size=1，会导致取景缩成一点）。
        int h = session.snapshotHeight > 0 ? session.snapshotHeight : 1920;
        camera.orthographic = true;
        camera.orthographicSize = h / 2f;
        camera.transform.position = new Vector3(0f, 0f, -1000f);
        camera.transform.rotation = Quaternion.identity;

        session.nguiCamera = camera;
        return camera;
    }

    private static void DestroySessionNguiCamera(SessionState session)
    {
        if (session == null || session.nguiCamera == null) return;
        UnityEngine.Object.DestroyImmediate(session.nguiCamera.gameObject);
        session.nguiCamera = null;
    }


    private static NguiStaticStateSnapshot CaptureNguiStaticState()
    {
        NguiStaticStateSnapshot snapshot = new NguiStaticStateSnapshot();
        CaptureNguiStaticCollection(snapshot, "UIPanel", "list");
        CaptureNguiStaticCollection(snapshot, "UIRoot", "list");
        CaptureNguiStaticCollection(snapshot, "UICamera", "list");
        CaptureNguiStaticCollection(snapshot, "UIDrawCall", "mActiveList");
        CaptureNguiStaticCollection(snapshot, "UIDrawCall", "mInactiveList");
        CaptureNguiStaticCollection(snapshot, "UIKeyNavigation", "list");
        CaptureNguiStaticCollection(snapshot, "UIKeyBinding", "list");
        CaptureNguiStaticCollection(snapshot, "UIScrollView", "list");
        CaptureNguiStaticCollection(snapshot, "UIToggle", "list");
        CaptureNguiStaticCollection(snapshot, "UILabel", "mList");
        CaptureNguiStaticCollection(snapshot, "UI2DSprite", "m_TrackedTexturelessImages");
        return snapshot;
    }

    private static void CaptureNguiStaticCollection(NguiStaticStateSnapshot snapshot, string typeName, string memberName)
    {
        if (snapshot == null) return;
        Type type = FindLoadedType(typeName);
        if (type == null) return;

        const BindingFlags flags = BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic;
        object collection = null;
        FieldInfo field = type.GetField(memberName, flags);
        if (field != null)
        {
            try { collection = field.GetValue(null); }
            catch {}
        }
        if (collection == null)
        {
            PropertyInfo property = type.GetProperty(memberName, flags);
            if (property != null)
            {
                try { collection = property.GetValue(null, null); }
                catch {}
            }
        }
        if (collection == null) return;

        snapshot.collections.Add(new StaticCollectionSnapshot
        {
            collection = collection,
            items = FilterBridgeRuntimeItems(ReadCollectionItems(collection, int.MaxValue))
        });
    }

    private static List<object> FilterBridgeRuntimeItems(List<object> items)
    {
        List<object> filtered = new List<object>();
        if (items == null) return filtered;
        for (int i = 0; i < items.Count; i++)
        {
            object item = items[i];
            if (IsBridgeRuntimeStaticItem(item)) continue;
            filtered.Add(item);
        }
        return filtered;
    }

    private static bool IsBridgeRuntimeStaticItem(object item)
    {
        if (item == null) return true;
        GameObject go = item as GameObject;
        if (go != null) return IsBridgeRuntimeObject(go);

        Component component = item as Component;
        if (component != null)
        {
            if (IsTypeOrBaseName(component.GetType(), "UIDrawCall"))
                return IsBridgeRuntimeDrawCall(component, null, true);
            if (IsBridgeRuntimeObject(component.gameObject)) return true;
            Component manager = ReadReflectedProperty(component, "manager") as Component;
            if (manager != null && IsBridgeRuntimeObject(manager.gameObject)) return true;
        }
        return false;
    }

    private static void RestoreNguiStaticState(NguiStaticStateSnapshot snapshot)
    {
        if (snapshot == null || snapshot.collections == null) return;
        for (int i = 0; i < snapshot.collections.Count; i++)
        {
            StaticCollectionSnapshot collection = snapshot.collections[i];
            if (collection == null || collection.collection == null || collection.items == null) continue;
            RestoreCollectionItems(collection.collection, collection.items);
        }
    }

    private static void RestoreCollectionItems(object collection, List<object> items)
    {
        if (collection == null || items == null) return;
        if (!ClearCollection(collection)) return;
        for (int i = 0; i < items.Count; i++)
            AddCollectionItem(collection, items[i]);
    }

    private static bool ClearCollection(object collection)
    {
        if (collection == null) return false;
        System.Collections.IList list = collection as System.Collections.IList;
        if (list != null)
        {
            try
            {
                list.Clear();
                return true;
            }
            catch {}
        }

        MethodInfo clear = collection.GetType().GetMethod(
            "Clear",
            BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic,
            null,
            Type.EmptyTypes,
            null);
        if (clear != null)
        {
            try
            {
                clear.Invoke(collection, null);
                return true;
            }
            catch {}
        }
        return false;
    }

    private static bool AddCollectionItem(object collection, object item)
    {
        if (collection == null) return false;
        System.Collections.IList list = collection as System.Collections.IList;
        if (list != null)
        {
            try
            {
                list.Add(item);
                return true;
            }
            catch {}
        }

        MethodInfo[] methods = collection.GetType().GetMethods(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
        for (int i = 0; i < methods.Length; i++)
        {
            MethodInfo method = methods[i];
            if (method.Name != "Add") continue;
            ParameterInfo[] parameters = method.GetParameters();
            if (parameters.Length != 1) continue;
            Type parameterType = parameters[0].ParameterType;
            if (item != null && !parameterType.IsAssignableFrom(item.GetType())) continue;
            if (item == null && parameterType.IsValueType) continue;
            try
            {
                method.Invoke(collection, new object[] { item });
                return true;
            }
            catch {}
        }
        return false;
    }

    public static void CleanupNguiStaticState()
    {
        CleanupNguiRuntimeObjects(null);
    }

    private static void CleanupNguiRuntimeObjects(GameObject scope)
    {
        CleanupNguiPanelWidgetLists(scope);
        CleanupNguiActiveDrawCallList(scope);
        CleanupNguiStaticPanelList(scope);
    }

    public static void CleanupBridgeRuntimeState()
    {
        CleanupBridgeOwnedSceneObjects();
        SuspendAllSessionNguiRendering();
        CleanupNguiStaticState();
    }

    private static void SuspendAllSessionNguiRendering()
    {
        foreach (SessionState session in Sessions.Values)
        {
            if (session == null) continue;
            SuspendNguiRendering(session, session.workingRoot);
            if (session.undoStack != null)
            {
                for (int i = 0; i < session.undoStack.Count; i++)
                    SuspendNguiRendering(session, session.undoStack[i]);
            }
            if (session.redoStack != null)
            {
                for (int i = 0; i < session.redoStack.Count; i++)
                    SuspendNguiRendering(session, session.redoStack[i]);
            }
        }
    }

    private static RuntimeCleanupReport BuildRuntimeCleanupReport()
    {
        RuntimeCleanupReport report = new RuntimeCleanupReport();
        List<string> samples = new List<string>();
        int suspendedTotal = 0;
        foreach (SessionState s in Sessions.Values)
            if (s != null) suspendedTotal += s.suspendedNguiBehaviourStates.Count;
        report.suspendedNguiBehaviours = suspendedTotal;

        GameObject[] objects = null;
        try { objects = Resources.FindObjectsOfTypeAll<GameObject>(); }
        catch {}
        if (objects != null)
        {
            HashSet<GameObject> hiddenRoots = new HashSet<GameObject>();
            for (int i = 0; i < objects.Length; i++)
            {
                GameObject go = objects[i];
                if (go == null) continue;
                try { if (EditorUtility.IsPersistent(go)) continue; }
                catch {}
                if (!IsBridgeRuntimeObject(go)) continue;
                GameObject root = FindBridgeRuntimeRoot(go);
                if (root == null) continue;
                hiddenRoots.Add(root);
            }
            report.bridgeHiddenRoots = hiddenRoots.Count;
            foreach (GameObject root in hiddenRoots)
            {
                if (root == null) continue;
                if (IsLoadedUserScene(root.scene))
                    report.bridgeLoadedSceneRoots++;
                else
                    report.bridgePreviewRoots++;
                if (samples.Count >= 12) continue;
                samples.Add(root.name);
            }
        }

        Type panelType = FindLoadedType("UIPanel");
        if (panelType != null)
        {
            UnityEngine.Object[] panels = null;
            try { panels = Resources.FindObjectsOfTypeAll(panelType); }
            catch {}
            if (panels != null)
            {
                for (int i = 0; i < panels.Length; i++)
                {
                    Component panel = panels[i] as Component;
                    if (panel == null) continue;
                    try { if (EditorUtility.IsPersistent(panel)) continue; }
                    catch {}
                    report.nguiPanels++;
                    bool bridgePanel = IsBridgeRuntimeObject(panel.gameObject);
                    if (bridgePanel) report.bridgePanels++;

                    object widgets = ReadReflectedProperty(panel, "widgets");
                    if (widgets == null) continue;
                    HashSet<int> seenWidgets = new HashSet<int>();
                    int widgetCount = CountCollectionItems(widgets);
                    for (int j = 0; j < widgetCount; j++)
                    {
                        Component widget = ReadCollectionItem(widgets, j) as Component;
                        if (widget == null)
                        {
                            report.nullPanelWidgets++;
                            continue;
                        }
                        int widgetId = 0;
                        try { widgetId = widget.GetInstanceID(); }
                        catch {}
                        if (widgetId != 0 && seenWidgets.Contains(widgetId))
                        {
                            report.panelWidgetDuplicates++;
                            if (samples.Count < 12)
                                samples.Add(panel.gameObject.name + " duplicateWidget=" + widget.gameObject.name);
                        }
                        else if (widgetId != 0)
                        {
                            seenWidgets.Add(widgetId);
                        }
                        if (!bridgePanel && IsBridgeRuntimeObject(widget.gameObject))
                        {
                            report.bridgeWidgetsInLivePanels++;
                            if (samples.Count < 12)
                                samples.Add(panel.gameObject.name + " bridgeWidget=" + widget.gameObject.name);
                        }
                    }
                }
            }
        }

        Type drawCallType = FindLoadedType("UIDrawCall");
        if (drawCallType != null)
        {
            UnityEngine.Object[] drawCalls = null;
            try { drawCalls = Resources.FindObjectsOfTypeAll(drawCallType); }
            catch {}
            if (drawCalls != null)
            {
                for (int i = 0; i < drawCalls.Length; i++)
                {
                    Component drawCall = drawCalls[i] as Component;
                    if (drawCall == null) continue;
                    try { if (EditorUtility.IsPersistent(drawCall)) continue; }
                    catch {}
                    report.nguiDrawCalls++;
                    Component manager = ReadReflectedProperty(drawCall, "manager") as Component;
                    if (manager == null)
                    {
                        report.orphanDrawCalls++;
                    }
                    if (IsBridgeRuntimeDrawCall(drawCall, null, true))
                    {
                        report.bridgeDrawCalls++;
                        if (samples.Count < 12)
                        {
                            string managerName = manager != null && manager.gameObject != null ? manager.gameObject.name : "<null>";
                            samples.Add(drawCall.gameObject.name + " manager=" + managerName);
                        }
                    }
                }
            }
        }

        report.samples = samples.ToArray();
        return report;
    }

    private static void SuspendNguiRendering(SessionState session, GameObject instance)
    {
        if (instance == null) return;
        Dictionary<int, bool> states = session != null ? session.suspendedNguiBehaviourStates : null;
        Component[] components = instance.GetComponentsInChildren<Component>(true);
        for (int i = 0; i < components.Length; i++)
        {
            Component component = components[i];
            if (component == null || !IsNguiComponent(component)) continue;
            Behaviour behaviour = component as Behaviour;
            if (behaviour == null) continue;
            int id = 0;
            try { id = behaviour.GetInstanceID(); }
            catch { continue; }
            if (id == 0) continue;
            if (states != null && !states.ContainsKey(id))
                states[id] = behaviour.enabled;
            if (behaviour.enabled)
            {
                try { behaviour.enabled = false; }
                catch {}
            }
        }
        CleanupNguiRuntimeObjects(instance);
    }

    private static bool IsNguiRenderingSuspended(SessionState session, GameObject instance)
    {
        if (instance == null || session == null || session.suspendedNguiBehaviourStates.Count == 0) return false;
        Dictionary<int, bool> states = session.suspendedNguiBehaviourStates;
        Component[] components = instance.GetComponentsInChildren<Component>(true);
        for (int i = 0; i < components.Length; i++)
        {
            Component component = components[i];
            if (component == null || !IsNguiComponent(component)) continue;
            int id = 0;
            try { id = component.GetInstanceID(); }
            catch { continue; }
            if (id != 0 && states.ContainsKey(id))
                return true;
        }
        return false;
    }

    private static void ResumeNguiRendering(SessionState session, GameObject instance)
    {
        if (instance == null || session == null || session.suspendedNguiBehaviourStates.Count == 0) return;
        Dictionary<int, bool> states = session.suspendedNguiBehaviourStates;
        Component[] components = instance.GetComponentsInChildren<Component>(true);
        for (int i = 0; i < components.Length; i++)
        {
            Component component = components[i];
            if (component == null || !IsNguiComponent(component)) continue;
            Behaviour behaviour = component as Behaviour;
            if (behaviour == null) continue;
            int id = 0;
            try { id = behaviour.GetInstanceID(); }
            catch { continue; }
            bool enabled;
            if (id == 0 || !states.TryGetValue(id, out enabled)) continue;
            try { behaviour.enabled = enabled; }
            catch {}
            states.Remove(id);
        }
    }

    private static void RemoveSuspendedNguiState(SessionState session, GameObject instance)
    {
        if (instance == null || session == null || session.suspendedNguiBehaviourStates.Count == 0) return;
        Dictionary<int, bool> states = session.suspendedNguiBehaviourStates;
        Component[] components = instance.GetComponentsInChildren<Component>(true);
        for (int i = 0; i < components.Length; i++)
        {
            Component component = components[i];
            if (component == null) continue;
            int id = 0;
            try { id = component.GetInstanceID(); }
            catch { continue; }
            if (id != 0) states.Remove(id);
        }
    }

    private static bool TryGetSuspendedState(int id, out bool enabled)
    {
        enabled = false;
        if (id == 0) return false;
        foreach (SessionState session in Sessions.Values)
        {
            if (session == null) continue;
            if (session.suspendedNguiBehaviourStates.TryGetValue(id, out enabled))
                return true;
        }
        return false;
    }

    private static bool TrySetSuspendedState(int id, bool enabled)
    {
        if (id == 0) return false;
        foreach (SessionState session in Sessions.Values)
        {
            if (session == null) continue;
            if (session.suspendedNguiBehaviourStates.ContainsKey(id))
            {
                session.suspendedNguiBehaviourStates[id] = enabled;
                return true;
            }
        }
        return false;
    }

    private static bool GetEffectiveBehaviourEnabled(Behaviour behaviour)
    {
        if (behaviour == null) return true;
        int id = 0;
        try { id = behaviour.GetInstanceID(); }
        catch { return behaviour.enabled; }
        bool enabled;
        if (TryGetSuspendedState(id, out enabled))
            return enabled;
        return behaviour.enabled;
    }

    private static void SetEffectiveBehaviourEnabled(Behaviour behaviour, bool enabled)
    {
        if (behaviour == null) return;
        int id = 0;
        try { id = behaviour.GetInstanceID(); }
        catch { id = 0; }
        if (TrySetSuspendedState(id, enabled))
        {
            try { behaviour.enabled = false; }
            catch {}
            return;
        }
        try { behaviour.enabled = enabled; }
        catch {}
    }

    private static void DisableNguiBehaviours(GameObject instance)
    {
        if (instance == null) return;
        Component[] components = instance.GetComponentsInChildren<Component>(true);
        for (int i = 0; i < components.Length; i++)
        {
            Behaviour behaviour = components[i] as Behaviour;
            if (behaviour == null || !IsNguiComponent(behaviour)) continue;
            try { behaviour.enabled = false; }
            catch {}
        }
    }

    private static void CleanupNguiPanelWidgetLists(GameObject scope)
    {
        Type panelType = FindLoadedType("UIPanel");
        if (panelType == null) return;

        UnityEngine.Object[] panels;
        try { panels = Resources.FindObjectsOfTypeAll(panelType); }
        catch { return; }
        if (panels == null) return;

        for (int i = 0; i < panels.Length; i++)
        {
            Component panel = panels[i] as Component;
            if (panel == null) continue;
            try { if (EditorUtility.IsPersistent(panel)) continue; }
            catch {}

            object widgets = ReadReflectedProperty(panel, "widgets");
            if (widgets == null) continue;

            bool panelIsBridgeRuntime = IsBridgeRuntimeObject(panel.gameObject);
            HashSet<int> seenWidgets = new HashSet<int>();
            List<int> removeIndexes = new List<int>();
            int count = CountCollectionItems(widgets);
            for (int j = 0; j < count; j++)
            {
                Component widget = ReadCollectionItem(widgets, j) as Component;
                bool remove = widget == null;
                int widgetId = 0;
                if (!remove)
                {
                    try { widgetId = widget.GetInstanceID(); }
                    catch { remove = true; }
                }
                if (!remove && widgetId != 0)
                {
                    if (seenWidgets.Contains(widgetId))
                        remove = true;
                    else
                        seenWidgets.Add(widgetId);
                }
                if (!remove && scope != null && IsGameObjectInScope(widget.gameObject, scope))
                    remove = true;
                if (!remove && !panelIsBridgeRuntime && IsBridgeRuntimeObject(widget.gameObject))
                    remove = true;
                if (!remove) continue;
                removeIndexes.Add(j);
            }

            if (removeIndexes.Count == 0) continue;
            for (int j = removeIndexes.Count - 1; j >= 0; j--)
                RemoveCollectionAt(widgets, removeIndexes[j]);
            PruneNullCollectionItems(widgets);
            InvokeReflectedMethod(panel, "RebuildAllDrawCalls");
        }
    }

    private static void CleanupNguiStaticPanelList(GameObject scope)
    {
        Type panelType = FindLoadedType("UIPanel");
        if (panelType == null) return;

        FieldInfo listField = panelType.GetField("list", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
        if (listField == null) return;

        object list = null;
        try { list = listField.GetValue(null); }
        catch { return; }
        if (list == null) return;

        HashSet<int> scopedIds = null;
        if (scope != null)
        {
            scopedIds = new HashSet<int>();
            Component[] scopedPanels = scope.GetComponentsInChildren<Component>(true);
            for (int i = 0; i < scopedPanels.Length; i++)
            {
                Component component = scopedPanels[i];
                if (component != null && IsTypeOrBaseName(component.GetType(), "UIPanel"))
                    scopedIds.Add(component.GetInstanceID());
            }
        }

        int count = CountCollectionItems(list);
        HashSet<int> seenIds = scope == null ? new HashSet<int>() : null;
        List<int> removeIndexes = new List<int>();
        for (int i = 0; i < count; i++)
        {
            object entry = ReadCollectionItem(list, i);

            UnityEngine.Object unityObject = entry as UnityEngine.Object;
            bool remove = unityObject == null;
            int instanceId = 0;
            if (!remove)
            {
                try { instanceId = unityObject.GetInstanceID(); }
                catch { remove = true; }
            }
            if (!remove && scopedIds != null && scopedIds.Contains(instanceId))
                remove = true;
            if (!remove && scopedIds == null)
            {
                Component component = unityObject as Component;
                if (component != null && IsBridgeRuntimeObject(component.gameObject))
                    remove = true;
            }
            if (!remove && seenIds != null)
            {
                if (seenIds.Contains(instanceId))
                    remove = true;
                else
                    seenIds.Add(instanceId);
            }
            if (!remove) continue;

            removeIndexes.Add(i);
        }

        for (int i = removeIndexes.Count - 1; i >= 0; i--)
        {
            RemoveCollectionAt(list, removeIndexes[i]);
        }
    }

    private static void CleanupNguiActiveDrawCallList(GameObject scope)
    {
        Type drawCallType = FindLoadedType("UIDrawCall");
        if (drawCallType == null) return;

        CleanupNguiDrawCallCollection(drawCallType, "activeList", scope);
        CleanupNguiDrawCallCollection(drawCallType, "inactiveList", scope);
        CleanupNguiDrawCallObjects(drawCallType, scope);
    }

    private static void MoveNguiDrawCallsToScene(GameObject scope, Scene scene)
    {
        if (scope == null || !scene.IsValid() || !scene.isLoaded) return;
        Type drawCallType = FindLoadedType("UIDrawCall");
        if (drawCallType == null) return;

        UnityEngine.Object[] objects;
        try { objects = Resources.FindObjectsOfTypeAll(drawCallType); }
        catch { return; }
        if (objects == null) return;

        for (int i = 0; i < objects.Length; i++)
        {
            Component drawCall = objects[i] as Component;
            if (drawCall == null) continue;
            Component manager = ReadReflectedProperty(drawCall, "manager") as Component;
            if (manager == null || !IsGameObjectInScope(manager.gameObject, scope)) continue;
            MoveRootToScene(drawCall.gameObject, scene);
        }
    }

    private static void CleanupNguiDrawCallCollection(Type drawCallType, string propertyName, GameObject scope)
    {
        if (drawCallType == null || string.IsNullOrEmpty(propertyName)) return;

        PropertyInfo property = drawCallType.GetProperty(propertyName, BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
        object list = null;
        try { list = property != null ? property.GetValue(null, null) : null; }
        catch { return; }
        if (list == null) return;

        int count = CountCollectionItems(list);
        HashSet<int> seenIds = new HashSet<int>();
        List<int> removeIndexes = new List<int>();
        for (int i = 0; i < count; i++)
        {
            Component drawCall = ReadCollectionItem(list, i) as Component;
            bool remove = drawCall == null || IsBridgeRuntimeDrawCall(drawCall, scope, true);
            if (!remove)
            {
                int instanceId = 0;
                try { instanceId = drawCall.GetInstanceID(); }
                catch { remove = true; }
                if (seenIds.Contains(instanceId))
                    remove = true;
                else
                    seenIds.Add(instanceId);
            }
            if (!remove) continue;

            DestroyNguiDrawCallObject(drawCall);
            removeIndexes.Add(i);
        }

        for (int i = removeIndexes.Count - 1; i >= 0; i--)
        {
            RemoveCollectionAt(list, removeIndexes[i]);
        }
        PruneNullCollectionItems(list);
    }

    private static void CleanupNguiDrawCallObjects(Type drawCallType, GameObject scope)
    {
        if (drawCallType == null) return;
        UnityEngine.Object[] objects;
        try { objects = Resources.FindObjectsOfTypeAll(drawCallType); }
        catch { return; }
        if (objects == null) return;

        for (int i = 0; i < objects.Length; i++)
        {
            Component drawCall = objects[i] as Component;
            if (drawCall == null) continue;
            try { if (EditorUtility.IsPersistent(drawCall)) continue; }
            catch {}
            if (!IsBridgeRuntimeDrawCall(drawCall, scope, true)) continue;
            DestroyNguiDrawCallObject(drawCall);
        }
    }

    private static bool IsBridgeRuntimeDrawCall(Component drawCall, GameObject scope, bool removeOrphan)
    {
        if (drawCall == null) return true;
        Component manager = ReadReflectedProperty(drawCall, "manager") as Component;
        if (manager == null) return removeOrphan;
        if (scope != null && IsGameObjectInScope(manager.gameObject, scope)) return true;
        if (IsBridgeRuntimeObject(manager.gameObject)) return true;
        if (IsBridgeRuntimeObject(drawCall.gameObject)) return true;
        return false;
    }

    private static void DestroyNguiDrawCallObject(Component drawCall)
    {
        if (drawCall == null) return;
        GameObject go = null;
        try { go = drawCall.gameObject; }
        catch {}
        if (go == null) return;
        try { UnityEngine.Object.DestroyImmediate(go); }
        catch {}
    }

    private static void CleanupBridgeOwnedSceneObjects()
    {
        for (int sceneIndex = 0; sceneIndex < SceneManager.sceneCount; sceneIndex++)
        {
            Scene scene = SceneManager.GetSceneAt(sceneIndex);
            if (!scene.IsValid() || !scene.isLoaded) continue;
            GameObject[] roots = scene.GetRootGameObjects();
            for (int i = 0; i < roots.Length; i++)
            {
                GameObject root = roots[i];
                if (root == null || !IsBridgeRuntimeObject(root)) continue;
                try { UnityEngine.Object.DestroyImmediate(root); }
                catch {}
            }
        }
        CleanupBridgeOwnedHiddenObjects();
    }

    private static void CleanupBridgeOwnedHiddenObjects()
    {
        GameObject[] allObjects;
        try { allObjects = Resources.FindObjectsOfTypeAll<GameObject>(); }
        catch { return; }
        if (allObjects == null) return;

        HashSet<GameObject> roots = new HashSet<GameObject>();
        for (int i = 0; i < allObjects.Length; i++)
        {
            GameObject go = allObjects[i];
            if (go == null) continue;
            try { if (EditorUtility.IsPersistent(go)) continue; }
            catch {}
            if (!IsBridgeRuntimeObject(go)) continue;
            if (IsBridgeSessionObject(go)) continue;

            GameObject root = FindBridgeRuntimeRoot(go);
            if (root != null && !IsBridgeSessionObject(root))
                roots.Add(root);
        }

        foreach (GameObject root in roots)
        {
            if (root == null) continue;
            try { UnityEngine.Object.DestroyImmediate(root); }
            catch {}
        }
    }

    private static bool IsBridgeRuntimeObject(GameObject go)
    {
        if (go == null) return false;
        Transform current = go.transform;
        while (current != null)
        {
            GameObject currentGo = current.gameObject;
            if (currentGo != null)
            {
                if (IsBridgeRuntimeName(currentGo.name))
                    return true;
                if (IsBridgeTempObjectName(currentGo.name) && HasBridgeRuntimeHideFlags(currentGo))
                    return true;
                if (IsBridgeSessionObject(currentGo))
                    return true;
            }
            current = current.parent;
        }
        return false;
    }

    private static bool IsGameObjectInScope(GameObject go, GameObject scope)
    {
        if (go == null || scope == null) return false;
        Transform transform = go.transform;
        Transform root = scope.transform;
        return transform == root || transform.IsChildOf(root);
    }

    private static bool IsBridgeSessionObject(GameObject go)
    {
        if (go == null) return false;
        foreach (SessionState session in Sessions.Values)
        {
            if (session == null) continue;
            if (IsGameObjectInScope(go, session.workingRoot)) return true;
            if (IsGameObjectInRootList(go, session.undoStack)) return true;
            if (IsGameObjectInRootList(go, session.redoStack)) return true;
        }
        return false;
    }

    private static bool IsGameObjectInRootList(GameObject go, List<GameObject> roots)
    {
        if (go == null || roots == null) return false;
        for (int i = 0; i < roots.Count; i++)
        {
            if (IsGameObjectInScope(go, roots[i])) return true;
        }
        return false;
    }

    private static bool IsBridgeRuntimeName(string name)
    {
        if (string.IsNullOrEmpty(name)) return false;
        return name.StartsWith("__UIEditorNew", StringComparison.Ordinal);
    }

    private static bool IsBridgeTempObjectName(string name)
    {
        if (string.IsNullOrEmpty(name)) return false;
        return name.IndexOf("__uieditor_new_tmp_", StringComparison.OrdinalIgnoreCase) >= 0 ||
            name.IndexOf("__uieditor_new_blank_", StringComparison.OrdinalIgnoreCase) >= 0;
    }

    private static bool HasBridgeRuntimeHideFlags(GameObject go)
    {
        if (go == null) return false;
        HideFlags flags = go.hideFlags;
        return (flags & HideFlags.DontSaveInEditor) != 0 ||
            (flags & HideFlags.DontSaveInBuild) != 0 ||
            (flags & HideFlags.HideInHierarchy) != 0;
    }

    private static GameObject FindBridgeRuntimeRoot(GameObject go)
    {
        if (go == null) return null;
        Transform current = go.transform;
        GameObject best = null;
        while (current != null)
        {
            GameObject currentGo = current.gameObject;
            if (currentGo != null && (IsBridgeRuntimeName(currentGo.name) ||
                (IsBridgeTempObjectName(currentGo.name) && HasBridgeRuntimeHideFlags(currentGo))))
                best = currentGo;
            current = current.parent;
        }
        return best != null ? best : go;
    }

    private static int CountCollectionItems(object collection)
    {
        if (collection == null) return 0;
        System.Collections.ICollection generic = collection as System.Collections.ICollection;
        if (generic != null) return generic.Count;
        object size = ReadReflectedProperty(collection, "size");
        if (size != null)
        {
            try { return Convert.ToInt32(size, CultureInfo.InvariantCulture); }
            catch {}
        }
        return ReadCollectionItems(collection, int.MaxValue).Count;
    }

    private static List<object> ReadCollectionItems(object collection, int maxCount)
    {
        List<object> items = new List<object>();
        if (collection == null) return items;
        System.Collections.IEnumerable enumerable = collection as System.Collections.IEnumerable;
        if (enumerable != null)
        {
            foreach (object item in enumerable)
            {
                if (item != null) items.Add(item);
                if (items.Count >= maxCount) break;
            }
            return items;
        }

        Array buffer = ReadReflectedProperty(collection, "buffer") as Array;
        if (buffer == null) return items;

        int size = buffer.Length;
        object reflectedSize = ReadReflectedProperty(collection, "size");
        if (reflectedSize != null)
        {
            try { size = Mathf.Min(buffer.Length, Convert.ToInt32(reflectedSize, CultureInfo.InvariantCulture)); }
            catch {}
        }

        int count = Mathf.Min(size, maxCount);
        for (int i = 0; i < count; i++)
        {
            object item = buffer.GetValue(i);
            if (item != null) items.Add(item);
        }
        return items;
    }

    private static object ReadCollectionItem(object collection, int index)
    {
        if (collection == null || index < 0) return null;

        System.Collections.IList list = collection as System.Collections.IList;
        if (list != null)
        {
            try { return index < list.Count ? list[index] : null; }
            catch { return null; }
        }

        Array buffer = ReadReflectedProperty(collection, "buffer") as Array;
        if (buffer != null)
        {
            int size = buffer.Length;
            object reflectedSize = ReadReflectedProperty(collection, "size");
            if (reflectedSize != null)
            {
                try { size = Mathf.Min(buffer.Length, Convert.ToInt32(reflectedSize, CultureInfo.InvariantCulture)); }
                catch {}
            }
            if (index >= size) return null;
            try { return buffer.GetValue(index); }
            catch { return null; }
        }

        System.Collections.IEnumerable enumerable = collection as System.Collections.IEnumerable;
        if (enumerable != null)
        {
            int i = 0;
            foreach (object item in enumerable)
            {
                if (i == index) return item;
                i++;
            }
        }
        return null;
    }

    private static bool RemoveCollectionAt(object collection, int index)
    {
        if (collection == null || index < 0) return false;

        System.Collections.IList list = collection as System.Collections.IList;
        if (list != null)
        {
            try
            {
                if (index >= list.Count) return false;
                list.RemoveAt(index);
                return true;
            }
            catch {}
        }

        MethodInfo removeAt = collection.GetType().GetMethod(
            "RemoveAt",
            BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic,
            null,
            new[] { typeof(int) },
            null);
        if (removeAt != null)
        {
            try
            {
                removeAt.Invoke(collection, new object[] { index });
                return true;
            }
            catch {}
        }

        Array buffer = ReadReflectedProperty(collection, "buffer") as Array;
        if (buffer == null) return false;

        int size = buffer.Length;
        object reflectedSize = ReadReflectedProperty(collection, "size");
        if (reflectedSize != null)
        {
            try { size = Mathf.Min(buffer.Length, Convert.ToInt32(reflectedSize, CultureInfo.InvariantCulture)); }
            catch {}
        }
        if (index >= size) return false;

        try
        {
            for (int i = index; i < size - 1; i++)
                buffer.SetValue(buffer.GetValue(i + 1), i);
            if (!buffer.GetType().GetElementType().IsValueType)
                buffer.SetValue(null, size - 1);
            SetReflectedProperty(collection, "size", size - 1);
            return true;
        }
        catch
        {
            return false;
        }
    }

    private static void PruneNullCollectionItems(object collection)
    {
        if (collection == null) return;
        int count = CountCollectionItems(collection);
        for (int i = count - 1; i >= 0; i--)
        {
            object item = ReadCollectionItem(collection, i);
            UnityEngine.Object unityObject = item as UnityEngine.Object;
            if (item != null && unityObject != null) continue;
            RemoveCollectionAt(collection, i);
        }
    }

    private static Type FindLoadedType(string typeName)
    {
        if (string.IsNullOrEmpty(typeName)) return null;
        Assembly[] assemblies = AppDomain.CurrentDomain.GetAssemblies();
        for (int i = 0; i < assemblies.Length; i++)
        {
            Type type = null;
            try { type = assemblies[i].GetType(typeName, false); }
            catch {}
            if (type != null) return type;

            try
            {
                Type[] types = assemblies[i].GetTypes();
                for (int j = 0; j < types.Length; j++)
                    if (types[j].Name == typeName) return types[j];
            }
            catch {}
        }
        return null;
    }

    private static ComponentSummary BuildNguiWidgetSummary(Component component)
    {
        Vector2 pivot = ReadReflectedVector2(component, "pivotOffset", new Vector2(0.5f, 0.5f));
        Color color = ReadReflectedColor(component, "color", Color.white);
        Behaviour behaviour = component as Behaviour;
        return new ComponentSummary
        {
            enabled = GetEffectiveBehaviourEnabled(behaviour),
            color = ColorToHex(color),
            alpha = ReadReflectedFloat(component, "alpha", color.a),
            widgetWidth = ReadReflectedInt(component, "width", 0),
            widgetHeight = ReadReflectedInt(component, "height", 0),
            depth = ReadReflectedInt(component, "depth", 0),
            pivotX = pivot.x,
            pivotY = pivot.y
        };
    }

    private static ComponentSummary BuildNguiLabelSummary(Component component)
    {
        ComponentSummary summary = BuildNguiWidgetSummary(component);
        summary.text = ReadReflectedString(component, "text", "");
        summary.fontSize = ReadReflectedInt(component, "fontSize", 0);
        summary.fontStyle = ReadReflectedEnumInt(component, "fontStyle", 0);
        object alignment = ReadReflectedProperty(component, "alignment");
        summary.alignment = alignment != null ? alignment.ToString() : "";
        summary.alignmentValue = ReadReflectedEnumInt(component, "alignment", 0);
        summary.richText = ReadReflectedBool(component, "supportEncoding", false);
        summary.fontPath = ReadUnityObjectPath(ReadReflectedProperty(component, "trueTypeFont"));
        if (string.IsNullOrEmpty(summary.fontPath))
            summary.fontPath = ReadUnityObjectPath(ReadReflectedProperty(component, "bitmapFont"));
        return summary;
    }

    private static ComponentSummary BuildNguiSpriteSummary(Component component)
    {
        ComponentSummary summary = BuildNguiWidgetSummary(component);
        summary.sprite = ReadReflectedString(component, "spriteName", "");
        summary.spritePath = summary.sprite;
        object imageType = ReadReflectedProperty(component, "type");
        summary.imageType = imageType != null ? imageType.ToString() : "";
        summary.fillCenter = ReadReflectedBool(component, "fillCenter", true);
        summary.fillMethod = ReadReflectedEnumInt(component, "fillDirection", 0);
        summary.fillAmount = ReadReflectedFloat(component, "fillAmount", 1f);
        summary.atlasPath = ReadUnityObjectPath(ReadReflectedProperty(component, "atlas"));
        summary.materialPath = ReadUnityObjectPath(ReadReflectedProperty(component, "material"));
        summary.texturePath = ReadUnityObjectPath(ReadReflectedProperty(component, "mainTexture"));
        return summary;
    }

    private static ComponentSummary BuildNguiButtonSummary(Component component)
    {
        Behaviour behaviour = component as Behaviour;
        return new ComponentSummary
        {
            enabled = GetEffectiveBehaviourEnabled(behaviour),
            interactable = ReadReflectedBool(component, "isEnabled", GetEffectiveBehaviourEnabled(behaviour)),
            normalSprite = ReadReflectedString(component, "normalSprite", ""),
            hoverSprite = ReadReflectedString(component, "hoverSprite", ""),
            pressedSprite = ReadReflectedString(component, "pressedSprite", ""),
            disabledSprite = ReadReflectedString(component, "disabledSprite", "")
        };
    }

    private static ComponentSummary BuildNguiPanelSummary(Component component)
    {
        Behaviour behaviour = component as Behaviour;
        return new ComponentSummary
        {
            enabled = GetEffectiveBehaviourEnabled(behaviour),
            alpha = ReadReflectedFloat(component, "alpha", 1f),
            depth = ReadReflectedInt(component, "depth", 0)
        };
    }

    private static bool ApplyNguiTransformOperation(Transform target, VisualPatchOperation op)
    {
        if (target == null || op == null) return false;
        if (op.field == "rectTransform.anchoredPosition")
        {
            Vector2 current = new Vector2(target.localPosition.x, target.localPosition.y);
            Vector2 next = ApplyVector2(current, op);
            return ApplyNguiAnchoredPosition(target, current, next);
        }
        if (op.field == "rectTransform.sizeDelta")
        {
            Component widget = GetNguiWidgetComponent(target.gameObject);
            if (widget == null) return false;
            Vector2 current = new Vector2(ReadReflectedInt(widget, "width", 1), ReadReflectedInt(widget, "height", 1));
            Vector2 next = ApplyVector2(current, op);
            SetNguiWidgetDimensions(widget, Mathf.Max(1, Mathf.RoundToInt(next.x)), Mathf.Max(1, Mathf.RoundToInt(next.y)));
            return true;
        }
        if (op.field == "rectTransform.localScale")
        {
            target.localScale = ApplyVector3(target.localScale, op);
            MarkNguiObjectChanged(target.gameObject);
            return true;
        }
        if (op.field == "rectTransform.localEulerAngles.z")
        {
            Vector3 euler = target.localEulerAngles;
            euler.z = op.op == "delta" ? euler.z + ReadNumber(op, 0f) : ReadNumber(op, euler.z);
            target.localEulerAngles = euler;
            MarkNguiObjectChanged(target.gameObject);
            return true;
        }
        return false;
    }

    private static bool ApplyNguiLabelOperation(Component label, VisualPatchOperation op, out string error)
    {
        error = null;
        if (op.field == "Text.text") { SetReflectedProperty(label, "text", op.stringValue ?? ""); return true; }
        if (op.field == "Text.fontSize") { SetReflectedProperty(label, "fontSize", Mathf.RoundToInt(ReadNumber(op, ReadReflectedInt(label, "fontSize", 16)))); return true; }
        if (op.field == "Text.color") { SetReflectedProperty(label, "color", ParseColor(op.stringValue, ReadReflectedColor(label, "color", Color.white))); return true; }
        if (op.field == "Text.fontStyle") { SetReflectedEnum(label, "fontStyle", Mathf.RoundToInt(ReadNumber(op, ReadReflectedEnumInt(label, "fontStyle", 0))), null); return true; }
        if (op.field == "Text.alignment") { SetReflectedEnum(label, "alignment", Mathf.RoundToInt(ReadNumber(op, ReadReflectedEnumInt(label, "alignment", 0))), null); return true; }
        if (op.field == "Text.richText") { SetReflectedProperty(label, "supportEncoding", op.boolValue); return true; }
        return false;
    }

    private static bool ApplyNguiSpriteOperation(Component sprite, VisualPatchOperation op, out string error)
    {
        error = null;
        if (op.field == "Image.enabled")
        {
            Behaviour behaviour = sprite as Behaviour;
            SetEffectiveBehaviourEnabled(behaviour, op.boolValue);
            return true;
        }
        if (op.field == "Image.color") { SetReflectedProperty(sprite, "color", ParseColor(op.stringValue, ReadReflectedColor(sprite, "color", Color.white))); return true; }
        if (op.field == "Image.sprite")
        {
            string spriteName = op.stringValue ?? "";
            if (spriteName.IndexOf('/') >= 0 || spriteName.IndexOf('\\') >= 0)
                spriteName = Path.GetFileNameWithoutExtension(spriteName);
            SetReflectedProperty(sprite, "spriteName", spriteName);
            return true;
        }
        if (op.field == "Image.type") { SetReflectedEnum(sprite, "type", 0, op.stringValue); return true; }
        if (op.field == "Image.fillCenter") { SetReflectedProperty(sprite, "fillCenter", op.boolValue); return true; }
        if (op.field == "Image.fillMethod") { SetReflectedEnum(sprite, "fillDirection", Mathf.RoundToInt(ReadNumber(op, ReadReflectedEnumInt(sprite, "fillDirection", 0))), null); return true; }
        if (op.field == "Image.fillAmount") { SetReflectedProperty(sprite, "fillAmount", Mathf.Clamp01(ReadNumber(op, ReadReflectedFloat(sprite, "fillAmount", 1f)))); return true; }
        return false;
    }

    private static bool ApplyNguiButtonOperation(Component button, VisualPatchOperation op, out string error)
    {
        error = null;
        if (op.field == "Button.interactable") { SetReflectedProperty(button, "isEnabled", op.boolValue); return true; }
        if (op.field == "Button.normalSprite") { SetReflectedProperty(button, "normalSprite", op.stringValue ?? ""); return true; }
        if (op.field == "Button.hoverSprite") { SetReflectedProperty(button, "hoverSprite", op.stringValue ?? ""); return true; }
        if (op.field == "Button.pressedSprite") { SetReflectedProperty(button, "pressedSprite", op.stringValue ?? ""); return true; }
        if (op.field == "Button.disabledSprite") { SetReflectedProperty(button, "disabledSprite", op.stringValue ?? ""); return true; }
        return false;
    }

    private static string ReadNguiTransformFieldAsString(Transform target, string field)
    {
        if (target == null) return "";
        if (field == "rectTransform.anchoredPosition") return Vector2Text(new Vector2(target.localPosition.x, target.localPosition.y));
        if (field == "rectTransform.localScale") return Vector3Text(target.localScale);
        if (field == "rectTransform.localEulerAngles.z") return target.localEulerAngles.z.ToString(CultureInfo.InvariantCulture);
        if (field == "rectTransform.sizeDelta")
        {
            Component widget = GetNguiWidgetComponent(target.gameObject);
            if (widget != null)
                return ReadReflectedInt(widget, "width", 0).ToString(CultureInfo.InvariantCulture) + "," + ReadReflectedInt(widget, "height", 0).ToString(CultureInfo.InvariantCulture);
            RectTransformRecord record = ToNguiRectRecord(target);
            if (record != null) return (record.sizeDelta[0]).ToString(CultureInfo.InvariantCulture) + "," + (record.sizeDelta[1]).ToString(CultureInfo.InvariantCulture);
        }
        return "";
    }

    private static string ReadNguiLabelFieldAsString(Component label, string field)
    {
        if (field == "Text.text") return ReadReflectedString(label, "text", "");
        if (field == "Text.fontSize") return ReadReflectedInt(label, "fontSize", 0).ToString(CultureInfo.InvariantCulture);
        if (field == "Text.color") return ColorToHex(ReadReflectedColor(label, "color", Color.white));
        if (field == "Text.fontStyle") return ReadReflectedEnumInt(label, "fontStyle", 0).ToString(CultureInfo.InvariantCulture);
        if (field == "Text.alignment") return ReadReflectedEnumInt(label, "alignment", 0).ToString(CultureInfo.InvariantCulture);
        if (field == "Text.richText") return ReadReflectedBool(label, "supportEncoding", false).ToString();
        return "";
    }

    private static string ReadNguiSpriteFieldAsString(Component sprite, string field)
    {
        Behaviour behaviour = sprite as Behaviour;
        if (field == "Image.enabled") return GetEffectiveBehaviourEnabled(behaviour).ToString();
        if (field == "Image.color") return ColorToHex(ReadReflectedColor(sprite, "color", Color.white));
        if (field == "Image.sprite") return ReadReflectedString(sprite, "spriteName", "");
        if (field == "Image.type")
        {
            object value = ReadReflectedProperty(sprite, "type");
            return value != null ? value.ToString() : "";
        }
        if (field == "Image.fillCenter") return ReadReflectedBool(sprite, "fillCenter", true).ToString();
        if (field == "Image.fillMethod") return ReadReflectedEnumInt(sprite, "fillDirection", 0).ToString(CultureInfo.InvariantCulture);
        if (field == "Image.fillAmount") return ReadReflectedFloat(sprite, "fillAmount", 1f).ToString(CultureInfo.InvariantCulture);
        return "";
    }

    private static string ReadNguiButtonFieldAsString(Component button, string field)
    {
        if (field == "Button.interactable") return ReadReflectedBool(button, "isEnabled", true).ToString();
        if (field == "Button.normalSprite") return ReadReflectedString(button, "normalSprite", "");
        if (field == "Button.hoverSprite") return ReadReflectedString(button, "hoverSprite", "");
        if (field == "Button.pressedSprite") return ReadReflectedString(button, "pressedSprite", "");
        if (field == "Button.disabledSprite") return ReadReflectedString(button, "disabledSprite", "");
        return "";
    }

    private static void SetNguiWidgetDimensions(Component widget, int width, int height)
    {
        if (widget == null) return;
        MethodInfo method = widget.GetType().GetMethod("SetDimensions", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
        if (method != null)
            method.Invoke(widget, new object[] { width, height });
        else
        {
            SetReflectedProperty(widget, "width", width);
            SetReflectedProperty(widget, "height", height);
        }
        InvokeReflectedMethod(widget, "MarkAsChanged");
    }

    private static bool ApplyNguiAnchoredPosition(Transform target, Vector2 current, Vector2 next)
    {
        if (target == null) return false;
        Component rect = GetFirstComponentByTypeName(target.gameObject, "UIRect");
        if (rect != null && HasAnyNguiAnchorTarget(rect))
        {
            int dx = Mathf.FloorToInt(next.x - current.x + 0.5f);
            int dy = Mathf.FloorToInt(next.y - current.y + 0.5f);
            Vector3 local = target.localPosition;
            local.x = current.x + dx;
            local.y = current.y + dy;
            target.localPosition = local;

            OffsetNguiAnchorAbsolute(rect, "leftAnchor", dx);
            OffsetNguiAnchorAbsolute(rect, "rightAnchor", dx);
            OffsetNguiAnchorAbsolute(rect, "bottomAnchor", dy);
            OffsetNguiAnchorAbsolute(rect, "topAnchor", dy);
            MarkNguiObjectChanged(target.gameObject);
            return true;
        }

        Vector3 nextLocal = target.localPosition;
        nextLocal.x = next.x;
        nextLocal.y = next.y;
        target.localPosition = nextLocal;
        MarkNguiObjectChanged(target.gameObject);
        return true;
    }

    private static bool HasAnyNguiAnchorTarget(Component rect)
    {
        if (rect == null) return false;
        return HasNguiAnchorTarget(rect, "leftAnchor") ||
            HasNguiAnchorTarget(rect, "rightAnchor") ||
            HasNguiAnchorTarget(rect, "bottomAnchor") ||
            HasNguiAnchorTarget(rect, "topAnchor");
    }

    private static bool HasNguiAnchorTarget(Component rect, string anchorName)
    {
        object anchor = ReadReflectedProperty(rect, anchorName);
        if (anchor == null) return false;
        return ReadReflectedProperty(anchor, "target") as Transform != null;
    }

    private static void OffsetNguiAnchorAbsolute(Component rect, string anchorName, int delta)
    {
        if (delta == 0) return;
        object anchor = ReadReflectedProperty(rect, anchorName);
        if (anchor == null) return;
        if (ReadReflectedProperty(anchor, "target") as Transform == null) return;
        int absolute = ReadReflectedInt(anchor, "absolute", 0);
        SetReflectedProperty(anchor, "absolute", absolute + delta);
    }

    private static void MarkNguiObjectChanged(GameObject go)
    {
        if (go == null) return;
        Component widget = GetNguiWidgetComponent(go);
        if (widget != null) InvokeReflectedMethod(widget, "MarkAsChanged");
        Component panel = GetFirstComponentByTypeName(go, "UIPanel");
        if (panel != null) InvokeReflectedMethod(panel, "RebuildAllDrawCalls");
    }

    private static bool TryReadVector3ArrayProperty(object target, string propertyName, out Vector3[] values)
    {
        values = null;
        object raw = ReadReflectedProperty(target, propertyName);
        values = raw as Vector3[];
        return values != null && values.Length >= 4;
    }

    private class NguiStaticStateSnapshot
    {
        public readonly List<StaticCollectionSnapshot> collections = new List<StaticCollectionSnapshot>();
    }

    private class StaticCollectionSnapshot
    {
        public object collection;
        public List<object> items;
    }
}

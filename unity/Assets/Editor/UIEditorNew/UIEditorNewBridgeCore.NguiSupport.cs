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
        if ((string.IsNullOrEmpty(session.framework) || session.framework == FrameworkUnknown) && !IsBlankBridgeArtboard(session, prefab))
            session.framework = DetectSessionFramework(prefab);
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

    private static void ApplyNguiExpandedViewport(Camera camera, int baseWidth, int baseHeight, SnapshotViewport viewport, int imageWidth, int imageHeight)
    {
        if (camera == null || baseWidth <= 0 || baseHeight <= 0 || imageWidth <= 0 || imageHeight <= 0) return;
        if (!camera.orthographic)
        {
            camera.aspect = (float)imageWidth / imageHeight;
            camera.ResetProjectionMatrix();
            return;
        }

        float worldUnitsPerPixel = (camera.orthographicSize * 2f) / baseHeight;
        float left = -viewport.x;
        float top = -viewport.y;
        float centerX = left + imageWidth * 0.5f;
        float centerY = top + imageHeight * 0.5f;
        float localX = (centerX - baseWidth * 0.5f) * worldUnitsPerPixel;
        float localY = (baseHeight * 0.5f - centerY) * worldUnitsPerPixel;

        camera.transform.position += camera.transform.right * localX + camera.transform.up * localY;
        camera.orthographicSize = imageHeight * worldUnitsPerPixel * 0.5f;
        camera.aspect = (float)imageWidth / imageHeight;
        camera.ResetProjectionMatrix();
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
        PrepareNguiCamerasForCaptureLayer(root);

        Component[] components = root.GetComponentsInChildren<Component>(true);
        for (int i = 0; i < components.Length; i++)
        {
            Behaviour behaviour = components[i] as Behaviour;
            if (behaviour == null) continue;
            if (IsNguiComponent(behaviour) && !behaviour.enabled)
                behaviour.enabled = true;
        }

        // 离屏 root 在编辑器非播放态不会被 Unity 自动 tick / Start，必须显式驱动 NGUI 生命周期。
        // PrimeNguiFrame 内部按序：Start panel/widget → widget.CreatePanel 关联 → 显式 UIAnchor → MarkAsChanged
        // → panel.UpdateSelf 填几何建 drawcall。
        PrimeNguiFrame(root);
    }

    private static void PrepareNguiCamerasForCaptureLayer(GameObject root)
    {
        if (root == null) return;
        int captureMask = 1 << CaptureLayer;
        Camera[] cameras = root.GetComponentsInChildren<Camera>(true);
        for (int i = 0; i < cameras.Length; i++)
        {
            Camera camera = cameras[i];
            if (camera == null) continue;
            camera.cullingMask |= captureMask;
        }
    }

    // 触发一帧 NGUI 几何重建：先确保 panel/widget 已 Start（mStarted）并完成 widget→panel 关联，
    // 再更新显式 UIAnchor、MarkAsChanged、panel.UpdateSelf。截图前调用。
    private static void PrimeNguiFrame(GameObject root)
    {
        if (root == null) return;
        Component[] components = root.GetComponentsInChildren<Component>(true);

        // 1. 先启动 UIRoot，让它按 NGUI 屏幕高度把根节点缩放到相机 size=1 的坐标系。
        //    Start 内部走 UpdateScale(false)，不会广播 UpdateAnchors，避免编辑态锚点被错误上下文重算。
        for (int i = 0; i < components.Length; i++)
        {
            Component component = components[i];
            if (component == null || !IsTypeOrBaseName(component.GetType(), "UIRoot")) continue;
            InvokeReflectedMethod(component, "Awake");
            InvokeReflectedMethod(component, "Start");
        }
        List<NguiTransformSnapshot> transformSnapshots = CaptureNguiTransformSnapshots(root);
        // 2. 再 Start 所有 UIPanel（设 mStarted，使后续 widget CreatePanel 能 UIPanel.Find 到）。
        for (int i = 0; i < components.Length; i++)
        {
            Component component = components[i];
            if (component != null && IsTypeOrBaseName(component.GetType(), "UIPanel"))
                InvokeReflectedMethod(component, "Start");
        }
        // 3. Start 所有 UIWidget 并显式 CreatePanel，建立 widget→panel 关联。
        //    离屏 LoadPrefabContents root 的 widget 不会被 Unity 自动 Start，panel 始终为 null、不填几何。
        for (int i = 0; i < components.Length; i++)
        {
            Component component = components[i];
            if (component == null || !IsTypeOrBaseName(component.GetType(), "UIWidget")) continue;
            InvokeReflectedMethod(component, "Start");
            InvokeReflectedMethod(component, "CreatePanel");
        }
        // 4. 不在截图 prime 中主动刷新 UIAnchor。Prefab 已保存正确的 NGUI 锚点结果；
        // 离屏相机上下文会让部分锚点链被重新计算到错误位置。
        for (int i = 0; i < components.Length; i++)
        {
            Component component = components[i];
            if (component == null) continue;
            Type type = component.GetType();
            if (IsTypeOrBaseName(type, "UITable") || IsTypeOrBaseName(type, "UIGrid"))
                InvokeReflectedMethod(component, "Reposition");
        }
        RestoreNguiTransformSnapshots(transformSnapshots);
        // 5. 标记 widget 几何变更。
        for (int i = 0; i < components.Length; i++)
        {
            Component component = components[i];
            if (component != null && IsTypeOrBaseName(component.GetType(), "UIWidget"))
                InvokeReflectedMethod(component, "MarkAsChanged");
        }
        // 6. 驱动 panel 填充 widget 几何并建 drawcall（UpdateSelf 绕过 LateUpdate 帧守卫）。
        for (int i = 0; i < components.Length; i++)
        {
            Component component = components[i];
            if (component != null && IsTypeOrBaseName(component.GetType(), "UIPanel"))
                InvokeReflectedMethod(component, "UpdateSelf");
        }
        // 7. NGUI 正常 LateUpdate 还会调用 UIPanel.UpdateDrawCalls(sortOrder)，把 panel 的
        //    position/rotation/lossyScale 写入 UIDrawCall transform。离屏手动 prime 若少这步，
        //    mesh 已生成但 drawcall 仍是 scale=1，会被 size=1 的 NGUI 相机放大成整屏局部背景。
        UpdateNguiPanelDrawCalls(components);
    }

    private struct NguiTransformSnapshot
    {
        public Transform transform;
        public Vector3 localPosition;
        public Quaternion localRotation;
        public Vector3 localScale;
        public Component widget;
        public int widgetWidth;
        public int widgetHeight;
    }

    private static List<NguiTransformSnapshot> CaptureNguiTransformSnapshots(GameObject root)
    {
        List<NguiTransformSnapshot> snapshots = new List<NguiTransformSnapshot>();
        if (root == null) return snapshots;

        Transform[] transforms = root.GetComponentsInChildren<Transform>(true);
        for (int i = 0; i < transforms.Length; i++)
        {
            Transform transform = transforms[i];
            if (transform == null) continue;
            Component widget = GetNguiWidgetComponent(transform.gameObject);
            bool preserveWidgetSize = ShouldPreserveNguiWidgetSize(widget);
            snapshots.Add(new NguiTransformSnapshot
            {
                transform = transform,
                localPosition = transform.localPosition,
                localRotation = transform.localRotation,
                localScale = transform.localScale,
                widget = preserveWidgetSize ? widget : null,
                widgetWidth = preserveWidgetSize ? ReadReflectedInt(widget, "width", 0) : 0,
                widgetHeight = preserveWidgetSize ? ReadReflectedInt(widget, "height", 0) : 0
            });
        }
        return snapshots;
    }

    private static bool ShouldPreserveNguiWidgetSize(Component widget)
    {
        if (widget == null) return false;
        object updateAnchors = ReadReflectedProperty(widget, "updateAnchors");
        if (updateAnchors is bool) return !(bool)updateAnchors;
        if (updateAnchors != null)
        {
            try { return Convert.ToInt32(updateAnchors, CultureInfo.InvariantCulture) == 0; }
            catch {}
        }
        return false;
    }

    private static void RestoreNguiTransformSnapshots(List<NguiTransformSnapshot> snapshots)
    {
        if (snapshots == null) return;
        for (int i = 0; i < snapshots.Count; i++)
        {
            Transform transform = snapshots[i].transform;
            if (transform == null) continue;
            transform.localPosition = snapshots[i].localPosition;
            transform.localRotation = snapshots[i].localRotation;
            transform.localScale = snapshots[i].localScale;
            Component widget = snapshots[i].widget;
            if (widget == null) continue;
            SetReflectedProperty(widget, "width", snapshots[i].widgetWidth);
            SetReflectedProperty(widget, "height", snapshots[i].widgetHeight);
        }
    }

    private static void UpdateNguiPanelDrawCalls(Component[] components)
    {
        if (components == null) return;

        int nextRenderQueue = 3000;
        int sortOrder = 0;
        for (int i = 0; i < components.Length; i++)
        {
            Component panel = components[i];
            if (panel == null || !IsTypeOrBaseName(panel.GetType(), "UIPanel")) continue;

            object renderQueue = ReadReflectedProperty(panel, "renderQueue");
            string renderQueueName = renderQueue != null ? renderQueue.ToString() : "";
            if (renderQueueName == "Automatic")
            {
                SetReflectedProperty(panel, "startingRenderQueue", nextRenderQueue);
                InvokeReflectedMethod(panel, "UpdateDrawCalls", new object[] { sortOrder });
                nextRenderQueue += GetNguiPanelDrawCallCount(panel);
            }
            else if (renderQueueName == "StartAt")
            {
                int start = Mathf.Min(ReadReflectedInt(panel, "startingRenderQueue", nextRenderQueue), 4500);
                SetReflectedProperty(panel, "startingRenderQueue", start);
                InvokeReflectedMethod(panel, "UpdateDrawCalls", new object[] { sortOrder });
                if (GetNguiPanelDrawCallCount(panel) != 0)
                    nextRenderQueue = Mathf.Max(nextRenderQueue, start + GetNguiPanelDrawCallCount(panel));
            }
            else
            {
                InvokeReflectedMethod(panel, "UpdateDrawCalls", new object[] { sortOrder });
                if (GetNguiPanelDrawCallCount(panel) != 0)
                    nextRenderQueue = Mathf.Max(nextRenderQueue, ReadReflectedInt(panel, "startingRenderQueue", nextRenderQueue) + 1);
            }
            sortOrder++;
        }
    }

    private static int GetNguiPanelDrawCallCount(Component panel)
    {
        System.Collections.ICollection drawCalls = ReadReflectedProperty(panel, "drawCalls") as System.Collections.ICollection;
        return drawCalls != null ? drawCalls.Count : 0;
    }

    private static bool InvokeReflectedMethod(object target, string methodName, object[] args)
    {
        if (target == null || string.IsNullOrEmpty(methodName)) return false;
        int argCount = args != null ? args.Length : 0;
        for (Type type = target.GetType(); type != null; type = type.BaseType)
        {
            MethodInfo[] methods = type.GetMethods(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly);
            for (int i = 0; i < methods.Length; i++)
            {
                MethodInfo method = methods[i];
                if (method.Name != methodName) continue;
                if (method.GetParameters().Length != argCount) continue;
                try
                {
                    method.Invoke(target, args);
                    return true;
                }
                catch
                {
                    return false;
                }
            }
        }
        return false;
    }

    // 在 session 的 previewScene 内建一台常驻离屏相机；参数取自 prefab 自带相机（= Game View 相机口径），
    // 没有则按画板尺寸构造正交相机。只渲染 CaptureLayer，截图与 bbox 投影共用它。
    private static Camera EnsureSessionNguiCamera(SessionState session, GameObject root)
    {
        if (session == null) return null;
        if (session.nguiCamera != null)
        {
            ConfigureSessionNguiCamera(session, root, session.nguiCamera);
            return session.nguiCamera;
        }

        Scene scene = EnsureSessionPreviewScene(session);
        GameObject cameraGo = new GameObject("__UIEditorNew_NguiCam__");
        cameraGo.hideFlags = HideFlags.HideAndDontSave;
        if (scene.IsValid() && scene.isLoaded)
            SceneManager.MoveGameObjectToScene(cameraGo, scene);

        Camera camera = cameraGo.AddComponent<Camera>();
        ConfigureSessionNguiCamera(session, root, camera);
        session.nguiCamera = camera;
        return camera;
    }

    private static void ConfigureSessionNguiCamera(SessionState session, GameObject root, Camera camera)
    {
        if (session == null || camera == null) return;

        Scene scene = EnsureSessionPreviewScene(session);
        RenderTexture previousTarget = camera.targetTexture;
        Camera sourceCamera = FindBestCaptureCamera(root);
        bool copiedSourceCamera = sourceCamera != null && sourceCamera != camera;
        if (copiedSourceCamera)
        {
            camera.CopyFrom(sourceCamera);
            camera.targetTexture = previousTarget;
            camera.transform.position = sourceCamera.transform.position;
            camera.transform.rotation = sourceCamera.transform.rotation;
        }

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

        if (!copiedSourceCamera)
        {
            camera.nearClipPlane = 0.01f;
            camera.farClipPlane = 3000f;

            // 没有 prefab 自带相机时，按画板像素坐标构造兜底正交相机。
            int h = session.snapshotHeight > 0 ? session.snapshotHeight : 1920;
            camera.orthographic = true;
            camera.orthographicSize = h / 2f;
            camera.transform.position = new Vector3(0f, 0f, -1000f);
            camera.transform.rotation = Quaternion.identity;
        }
    }

    private static void DestroySessionNguiCamera(SessionState session)
    {
        if (session == null || session.nguiCamera == null) return;
        UnityEngine.Object.DestroyImmediate(session.nguiCamera.gameObject);
        session.nguiCamera = null;
    }










    public static void CleanupBridgeRuntimeState()
    {
        // 常驻隔离实例方案下，桥运行时对象（working root / undo-redo 快照 / drawcall / 相机）都活在
        // 各 session 私有 PreviewScene 内。重编译前 / Stop 时的兜底清理 = 关闭所有 session 的 PreviewScene
        // 并销毁常驻相机；CleanupBridgeOwnedSceneObjects 再兜底清理任何残留的桥隐藏对象。
        FlushAllDirtySessionsToDisk();
        try
        {
            foreach (SessionState session in Sessions.Values)
            {
                if (session == null) continue;
                DestroySessionNguiCamera(session);
                CloseSessionPreviewScene(session);
            }
        }
        catch {}
        CleanupBridgeOwnedSceneObjects();
    }









    // 常驻实例方案下无 suspend 影子状态，组件 enabled 即真实状态。保留函数名以复用既有调用点。
    private static bool GetEffectiveBehaviourEnabled(Behaviour behaviour)
    {
        return behaviour == null ? true : behaviour.enabled;
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

    private static void RemoveNguiPanelsForRootFromList(GameObject root)
    {
        if (root == null) return;

        Type panelType = FindLoadedType("UIPanel");
        if (panelType == null) return;
        FieldInfo listField = panelType.GetField("list", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
        if (listField == null) return;

        System.Collections.IList list;
        try { list = listField.GetValue(null) as System.Collections.IList; }
        catch { return; }
        if (list == null || list.Count == 0) return;

        Component[] components;
        try { components = root.GetComponentsInChildren<Component>(true); }
        catch { return; }
        if (components == null || components.Length == 0) return;

        HashSet<Component> rootPanels = new HashSet<Component>();
        for (int i = 0; i < components.Length; i++)
        {
            Component component = components[i];
            if (component != null && IsTypeOrBaseName(component.GetType(), "UIPanel"))
                rootPanels.Add(component);
        }
        if (rootPanels.Count == 0) return;

        for (int i = list.Count - 1; i >= 0; i--)
        {
            Component panel = list[i] as Component;
            if (panel != null && rootPanels.Contains(panel))
                list.RemoveAt(i);
        }
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
            if (behaviour != null) behaviour.enabled = op.boolValue;
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


}

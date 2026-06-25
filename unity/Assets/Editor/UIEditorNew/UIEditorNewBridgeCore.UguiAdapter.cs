using UnityEditor;
using UnityEngine;
using UnityEngine.UI;
using System;
using System.Collections.Generic;
using System.IO;

public static partial class UIEditorNewBridgeCore
{
    private sealed class UguiFrameworkAdapter : IUIEditorNewFrameworkAdapter
    {
        public string Framework { get { return FrameworkUGUI; } }

        public bool CanRender(SessionState session, GameObject prefab)
        {
            return true;
        }

        // UGUI 截图每次都是另起干净实例渲染（见 RenderSnapshot），working root 无需挂起任何组件，
        // 也不存在 NGUI 那种 [ExecuteInEditMode] 叠层问题。这里保持 no-op，
        // 避免对 UGUI 画板每次编辑都跑 NGUI 的全编辑器 Resources.FindObjectsOfTypeAll 扫描。
        public void PrepareWorkingRoot(SessionState session, GameObject root)
        {
        }

        public void AfterEditApplied(SessionState session, GameObject root)
        {
        }

        public bool RenderSnapshot(SessionState session, RenderSnapshotRequest request, GameObject prefab, int width, int height, string imageMode, Color background, out SnapshotRecord snapshot, out string errorCode, out string errorMessage, BridgeTiming timing)
        {
        snapshot = null;
        errorCode = null;
        errorMessage = null;

        GameObject root = null;
        Camera camera = null;
        RenderTexture previousRt = RenderTexture.active;
        Texture2D texture = null;
        try
        {
            RectTransform canvasRect = null;
            RectTransform layoutRootRect = null;
            CanvasScaler scaler = null;
            GameObject instance = null;
            List<BboxRecord> bboxes = new List<BboxRecord>();
            SnapshotViewport viewport = new SnapshotViewport { x = 0f, y = 0f, width = width, height = height };
            int renderWidth = width;
            int renderHeight = height;

            Action setupScene = () =>
            {
                root = new GameObject("__UIEditorNewSnapshot__");
                root.hideFlags = HideFlags.HideAndDontSave;

                GameObject cameraGo = new GameObject("__UIEditorNewSnapshot_Camera__");
                cameraGo.hideFlags = HideFlags.HideAndDontSave;
                cameraGo.transform.SetParent(root.transform, false);

                camera = cameraGo.AddComponent<Camera>();
                camera.transform.position = Vector3.zero;
                camera.transform.rotation = Quaternion.identity;
                camera.clearFlags = CameraClearFlags.SolidColor;
                camera.backgroundColor = background;
                camera.orthographic = true;
                camera.orthographicSize = height / 2f;
                camera.nearClipPlane = 0.01f;
                camera.farClipPlane = 1000f;
                camera.cullingMask = 1 << CaptureLayer;
                camera.allowHDR = false;
                camera.allowMSAA = false;
                if (camera.orthographic)
                {
                    if (session.snapshotPixelsPerWorld > 0f)
                    {
                        camera.orthographicSize = height / (2f * session.snapshotPixelsPerWorld);
                    }
                    else
                    {
                        session.snapshotPixelsPerWorld = height / Mathf.Max(0.0001f, 2f * camera.orthographicSize);
                    }
                }

                GameObject canvasGo = new GameObject("__UIEditorNewSnapshot_Canvas__");
                canvasGo.hideFlags = HideFlags.HideAndDontSave;
                canvasGo.layer = CaptureLayer;
                canvasGo.transform.SetParent(root.transform, false);

                canvasRect = canvasGo.AddComponent<RectTransform>();
                canvasRect.sizeDelta = new Vector2(width, height);

                Canvas canvas = canvasGo.AddComponent<Canvas>();
                canvas.renderMode = RenderMode.ScreenSpaceCamera;
                canvas.worldCamera = camera;
                canvas.planeDistance = 10f;
                canvas.sortingOrder = 0;

                scaler = canvasGo.AddComponent<CanvasScaler>();
                scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
                scaler.referenceResolution = new Vector2(width, height);
                scaler.matchWidthOrHeight = 0.5f;

                GameObject layoutRootGo = new GameObject("__UIEditorNewSnapshot_LayoutRoot__");
                layoutRootGo.hideFlags = HideFlags.HideAndDontSave;
                layoutRootGo.layer = CaptureLayer;
                layoutRootGo.transform.SetParent(canvasRect, false);
                layoutRootRect = layoutRootGo.AddComponent<RectTransform>();
                layoutRootRect.anchorMin = new Vector2(0.5f, 0.5f);
                layoutRootRect.anchorMax = new Vector2(0.5f, 0.5f);
                layoutRootRect.pivot = new Vector2(0.5f, 0.5f);
                layoutRootRect.sizeDelta = new Vector2(width, height);
                layoutRootRect.anchoredPosition = Vector2.zero;
            };
            if (timing != null) timing.Measure("snapshot.setupScene", setupScene);
            else setupScene();

            Action instantiatePrefab = () =>
            {
                instance = PrefabUtility.InstantiatePrefab(prefab, layoutRootRect) as GameObject;
                if (instance == null)
                    instance = UnityEngine.Object.Instantiate(prefab, layoutRootRect);
                if (instance == null)
                    throw new InvalidOperationException("Failed to instantiate prefab: " + session.workingPrefabPath);
                instance.name = prefab.name;
            };
            if (timing != null) timing.Measure("snapshot.instantiatePrefab", instantiatePrefab);
            else instantiatePrefab();

            Action prepareInstance = () =>
            {
                SetLayerRecursive(instance, CaptureLayer);
                DisableTransparentMeshCulling(instance);
                PrepareGraphicsForCapture(instance);
                NormalizeCollapsedRoot(instance, width, height);
            };
            if (timing != null) timing.Measure("snapshot.prepareInstance", prepareInstance);
            else prepareInstance();

            Action forceLayout = () =>
            {
                Canvas.ForceUpdateCanvases();
                LayoutRebuilder.ForceRebuildLayoutImmediate(canvasRect);
                Canvas.ForceUpdateCanvases();
            };
            if (timing != null) timing.Measure("snapshot.forceLayout", forceLayout);
            else forceLayout();

            Action collectBboxes = () =>
            {
                Dictionary<Transform, string> nodeIdByTransform = BuildNodeIdByTransform(instance.transform);
                CollectUguiBboxes(canvasRect, instance.transform, instance.transform, width, height, request != null ? request.targetNodeIds : null, bboxes, nodeIdByTransform);
            };
            if (timing != null) timing.Measure("snapshot.collectBboxes", collectBboxes);
            else collectBboxes();

            Action expandViewport = () =>
            {
                viewport = CalculateExpandedSnapshotViewport(bboxes, width, height, out renderWidth, out renderHeight);
                if (renderWidth == width && renderHeight == height && Mathf.Abs(viewport.x) < 0.001f && Mathf.Abs(viewport.y) < 0.001f) return;

                canvasRect.sizeDelta = new Vector2(renderWidth, renderHeight);
                if (scaler != null) scaler.referenceResolution = new Vector2(renderWidth, renderHeight);
                if (camera != null)
                {
                    if (session.snapshotPixelsPerWorld > 0f)
                        camera.orthographicSize = renderHeight / (2f * session.snapshotPixelsPerWorld);
                    else
                        camera.orthographicSize = renderHeight / 2f;
                }
                if (layoutRootRect != null)
                {
                    layoutRootRect.sizeDelta = new Vector2(width, height);
                    layoutRootRect.anchoredPosition = new Vector2(
                        viewport.x + width * 0.5f - renderWidth * 0.5f,
                        renderHeight * 0.5f - (viewport.y + height * 0.5f)
                    );
                }

                Canvas.ForceUpdateCanvases();
                LayoutRebuilder.ForceRebuildLayoutImmediate(canvasRect);
                Canvas.ForceUpdateCanvases();

                bboxes.Clear();
                Dictionary<Transform, string> nodeIdByTransform = BuildNodeIdByTransform(instance.transform);
                CollectUguiBboxes(canvasRect, instance.transform, instance.transform, renderWidth, renderHeight, request != null ? request.targetNodeIds : null, bboxes, nodeIdByTransform);
            };
            if (timing != null) timing.Measure("snapshot.expandViewport", expandViewport);
            else expandViewport();

            Action renderCamera = () =>
            {
                texture = RenderUguiCameraToTexture(camera, renderWidth, renderHeight, () =>
                {
                    camera.Render();
                    Canvas.ForceUpdateCanvases();
                    camera.Render();
                });
            };
            if (timing != null) timing.Measure("snapshot.renderCamera", renderCamera);
            else renderCamera();

            Action readPixels = () =>
            {
                if (texture == null)
                    throw new InvalidOperationException("UGUI render did not produce a texture");
                ForceTextureAlphaOpaque(texture);
            };
            if (timing != null) timing.Measure("snapshot.readPixels", readPixels);
            else readPixels();

            // 截图只作视觉底图，不需要无损 PNG；JPEG 编码快数倍、体积更小。
            // 渲染已 ForceTextureAlphaOpaque + 背景填充，无 alpha 需求，JPEG 不丢信息。
            byte[] imageBytes = timing != null
                ? timing.Measure("snapshot.encodePng", () => texture.EncodeToJPG(SnapshotJpegQuality))
                : texture.EncodeToJPG(SnapshotJpegQuality);

            string snapshotId = Guid.NewGuid().ToString("N");
            string fileName = snapshotId + ".jpg";
            string absolutePath = ResolveSnapshotPath(fileName);
            Action writePng = () =>
            {
                Directory.CreateDirectory(Path.GetDirectoryName(absolutePath));
                File.WriteAllBytes(absolutePath, imageBytes);
            };
            if (timing != null) timing.Measure("snapshot.writePng", writePng);
            else writePng();

            SnapshotImage image = new SnapshotImage
            {
                format = "jpg",
                mode = imageMode,
                path = (SnapshotFolder + "/" + fileName).Replace("\\", "/"),
                url = "/snapshots/" + fileName,
                dataUrl = imageMode == "base64" ? "data:image/jpeg;base64," + Convert.ToBase64String(imageBytes) : null
            };

            snapshot = new SnapshotRecord
            {
                snapshotId = snapshotId,
                width = renderWidth,
                height = renderHeight,
                coordinateSpace = "top-left-pixel",
                image = image,
                viewport = viewport,
                bboxes = bboxes.ToArray()
            };
            return true;
        }
        catch (Exception ex)
        {
            errorCode = "RENDER_FAILED";
            errorMessage = ex.Message;
            return false;
        }
        finally
        {
            Action cleanup = () =>
            {
                RenderTexture.active = previousRt;
                if (texture != null) UnityEngine.Object.DestroyImmediate(texture);
                if (camera != null) camera.targetTexture = null;
                if (root != null) UnityEngine.Object.DestroyImmediate(root);
            };
            if (timing != null) timing.Measure("snapshot.cleanup", cleanup);
            else cleanup();
        }
        }

        private static Texture2D RenderUguiCameraToTexture(Camera camera, int width, int height, Action renderAction)
        {
            if (camera == null || width <= 0 || height <= 0) return null;
            RenderTexture previousActive = RenderTexture.active;
            RenderTexture previousTarget = camera.targetTexture;
            RenderTexture rt = null;
            try
            {
                rt = new RenderTexture(width, height, 24, RenderTextureFormat.ARGB32);
                rt.name = "__UIEditorNewSnapshot_UGUI_RT";
                rt.Create();

                camera.targetTexture = rt;
                if (camera.orthographic && height > 0) camera.aspect = (float)width / height;
                if (renderAction != null) renderAction();
                else camera.Render();

                RenderTexture.active = rt;
                Texture2D texture = new Texture2D(width, height, TextureFormat.RGBA32, false);
                texture.ReadPixels(new Rect(0, 0, width, height), 0, 0);
                texture.Apply(false);
                return texture;
            }
            finally
            {
                if (camera != null) camera.targetTexture = previousTarget;
                RenderTexture.active = previousActive;
                if (rt != null)
                {
                    rt.Release();
                    UnityEngine.Object.DestroyImmediate(rt);
                }
            }
        }
    }
}

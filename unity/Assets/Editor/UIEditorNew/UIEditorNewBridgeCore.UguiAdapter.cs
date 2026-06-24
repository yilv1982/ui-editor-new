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

        public bool RenderSnapshot(SessionState session, RenderSnapshotRequest request, GameObject prefab, int width, int height, string imageMode, Color background, out SnapshotRecord snapshot, out string errorCode, out string errorMessage, BridgeTiming timing)
        {
        snapshot = null;
        errorCode = null;
        errorMessage = null;

        GameObject root = null;
        Camera camera = null;
        RenderTexture rt = null;
        RenderTexture previousRt = RenderTexture.active;
        Texture2D texture = null;
        PreviewRenderUtility previewUtility = null;
        try
        {
            RectTransform canvasRect = null;
            GameObject instance = null;
            List<BboxRecord> bboxes = new List<BboxRecord>();

            Action setupScene = () =>
            {
                previewUtility = new PreviewRenderUtility(true);
                root = new GameObject("__UIEditorNewSnapshot__");
                root.hideFlags = HideFlags.HideAndDontSave;
                previewUtility.AddSingleGO(root);

                camera = previewUtility.camera;
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

                CanvasScaler scaler = canvasGo.AddComponent<CanvasScaler>();
                scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
                scaler.referenceResolution = new Vector2(width, height);
                scaler.matchWidthOrHeight = 0.5f;
            };
            if (timing != null) timing.Measure("snapshot.setupScene", setupScene);
            else setupScene();

            Action instantiatePrefab = () =>
            {
                instance = UnityEngine.Object.Instantiate(prefab, canvasRect);
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

            Action renderCamera = () =>
            {
                texture = RenderUguiPreviewToTexture(previewUtility, camera, width, height, () =>
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
                if (texture == null && rt != null)
                {
                    RenderTexture.active = rt;
                    texture = new Texture2D(width, height, TextureFormat.RGBA32, false);
                    texture.ReadPixels(new Rect(0, 0, width, height), 0, 0);
                    texture.Apply(false);
                }
                ForceTextureAlphaOpaque(texture);
            };
            if (timing != null) timing.Measure("snapshot.readPixels", readPixels);
            else readPixels();

            byte[] png = timing != null
                ? timing.Measure("snapshot.encodePng", () => texture.EncodeToPNG())
                : texture.EncodeToPNG();

            string snapshotId = Guid.NewGuid().ToString("N");
            string fileName = snapshotId + ".png";
            string absolutePath = ResolveSnapshotPath(fileName);
            Action writePng = () =>
            {
                Directory.CreateDirectory(Path.GetDirectoryName(absolutePath));
                File.WriteAllBytes(absolutePath, png);
            };
            if (timing != null) timing.Measure("snapshot.writePng", writePng);
            else writePng();

            SnapshotImage image = new SnapshotImage
            {
                format = "png",
                mode = imageMode,
                path = (SnapshotFolder + "/" + fileName).Replace("\\", "/"),
                url = "/snapshots/" + fileName,
                dataUrl = imageMode == "base64" ? "data:image/png;base64," + Convert.ToBase64String(png) : null
            };

            snapshot = new SnapshotRecord
            {
                snapshotId = snapshotId,
                width = width,
                height = height,
                coordinateSpace = "top-left-pixel",
                image = image,
                viewport = new SnapshotViewport { x = 0f, y = 0f, width = width, height = height },
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
                if (rt != null)
                {
                    if (camera != null && camera.targetTexture == rt) camera.targetTexture = null;
                    rt.Release();
                    UnityEngine.Object.DestroyImmediate(rt);
                }
                if (root != null) UnityEngine.Object.DestroyImmediate(root);
                CleanupUguiPreviewUtility(previewUtility, camera);
            };
            if (timing != null) timing.Measure("snapshot.cleanup", cleanup);
            else cleanup();
        }
        }

        private static Texture2D RenderUguiPreviewToTexture(PreviewRenderUtility previewUtility, Camera camera, int width, int height, Action renderAction)
        {
            if (previewUtility == null || camera == null || width <= 0 || height <= 0) return null;
            RenderTexture previousActive = RenderTexture.active;
            RenderTexture temporary = null;
            bool previewOpen = false;
            try
            {
                previewUtility.BeginPreview(new Rect(0f, 0f, width, height), GUIStyle.none);
                previewOpen = true;
                if (camera.orthographic && height > 0) camera.aspect = (float)width / height;
                if (renderAction != null) renderAction();
                else camera.Render();
                Texture previewTexture = previewUtility.EndPreview();
                previewOpen = false;

                RenderTexture source = previewTexture as RenderTexture;
                if (source == null && previewTexture != null)
                {
                    temporary = RenderTexture.GetTemporary(width, height, 0, RenderTextureFormat.ARGB32);
                    Graphics.Blit(previewTexture, temporary);
                    source = temporary;
                }
                if (source == null) return null;

                RenderTexture.active = source;
                Texture2D texture = new Texture2D(width, height, TextureFormat.RGBA32, false);
                texture.ReadPixels(new Rect(0, 0, width, height), 0, 0);
                texture.Apply(false);
                return texture;
            }
            finally
            {
                if (previewOpen)
                {
                    try { previewUtility.EndPreview(); }
                    catch {}
                }
                if (camera != null) camera.targetTexture = null;
                if (previewUtility != null && previewUtility.camera != null) previewUtility.camera.targetTexture = null;
                RenderTexture.active = previousActive;
                if (temporary != null) RenderTexture.ReleaseTemporary(temporary);
            }
        }

        private static void CleanupUguiPreviewUtility(PreviewRenderUtility previewUtility, Camera renderCamera)
        {
            if (renderCamera != null) renderCamera.targetTexture = null;
            if (previewUtility == null) return;
            if (previewUtility.camera != null) previewUtility.camera.targetTexture = null;
            previewUtility.Cleanup();
        }
    }
}

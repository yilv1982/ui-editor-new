using UnityEditor;
using UnityEngine;
using UnityEngine.SceneManagement;
using System;
using System.Collections.Generic;
using System.IO;

public static partial class UIEditorNewBridgeCore
{
    private sealed class NguiFrameworkAdapter : IUIEditorNewFrameworkAdapter
    {
        public string Framework { get { return FrameworkNGUI; } }

        public bool CanRender(SessionState session, GameObject prefab)
        {
            return ShouldRenderAsNgui(session, prefab);
        }

        public bool RenderSnapshot(SessionState session, RenderSnapshotRequest request, GameObject prefab, int width, int height, string imageMode, Color background, out SnapshotRecord snapshot, out string errorCode, out string errorMessage, BridgeTiming timing)
        {

        snapshot = null;
        errorCode = null;
        errorMessage = null;

        CleanupNguiRuntimeObjects(prefab);

        GameObject root = null;
        GameObject instance = null;
        Camera camera = null;
        RenderTexture rt = null;
        RenderTexture previousRt = RenderTexture.active;
        Texture2D texture = null;
        NguiStaticStateSnapshot nguiStaticState = null;
        List<BboxRecord> bboxes = new List<BboxRecord>();
        Dictionary<Transform, string> nodeIdByTransform = null;
        Scene snapshotScene = default(Scene);
        PreviewRenderUtility previewUtility = null;
        int layoutWidth = session.snapshotWidth > 0 ? session.snapshotWidth : width;
        int layoutHeight = session.snapshotHeight > 0 ? session.snapshotHeight : height;
        int outputWidth = layoutWidth;
        int outputHeight = layoutHeight;
        SnapshotViewport viewport = new SnapshotViewport { x = 0f, y = 0f, width = width, height = height };

        try
        {
            Action setupScene = () =>
            {
                nguiStaticState = CaptureNguiStaticState();
                previewUtility = new PreviewRenderUtility(true);
                root = new GameObject("__UIEditorNewSnapshot_NGUI__");
                root.hideFlags = HideFlags.HideAndDontSave;
                previewUtility.AddSingleGO(root);
                snapshotScene = root.scene;
            };
            if (timing != null) timing.Measure("snapshot.ngui.setupScene", setupScene);
            else setupScene();

            Action instantiatePrefab = () =>
            {
                bool sourceWasSuspended = IsNguiRenderingSuspended(session, prefab);
                if (sourceWasSuspended) ResumeNguiRendering(session, prefab);
                try
                {
                    instance = UnityEngine.Object.Instantiate(prefab);
                    if (instance == null)
                        throw new InvalidOperationException("Failed to instantiate prefab: " + session.workingPrefabPath);
                    instance.name = prefab.name;
                    instance.hideFlags = HideFlags.HideAndDontSave;
                    instance.transform.SetParent(root.transform, true);
                }
                finally
                {
                    if (sourceWasSuspended) SuspendNguiRendering(session, prefab);
                }
            };
            if (timing != null) timing.Measure("snapshot.ngui.instantiatePrefab", instantiatePrefab);
            else instantiatePrefab();

            Action prepareInstance = () =>
            {
                SetLayerRecursive(instance, CaptureLayer);
                // 在 ForceNguiRefresh 重排子节点之前，按结构索引快照 clone 的 nodeId。
                nodeIdByTransform = BuildNodeIdByTransform(instance.transform);
            };
            if (timing != null) timing.Measure("snapshot.ngui.prepareInstance", prepareInstance);
            else prepareInstance();

            Action setupCamera = () =>
            {
                Camera sourceCamera = FindBestCaptureCamera(instance);
                camera = previewUtility != null ? previewUtility.camera : null;
                if (camera == null) throw new InvalidOperationException("Preview camera is unavailable");

                camera.enabled = true;
                if (sourceCamera != null)
                {
                    camera.transform.position = sourceCamera.transform.position;
                    camera.transform.rotation = sourceCamera.transform.rotation;
                    camera.orthographic = sourceCamera.orthographic;
                    camera.orthographicSize = sourceCamera.orthographicSize;
                    camera.nearClipPlane = sourceCamera.nearClipPlane;
                    camera.farClipPlane = sourceCamera.farClipPlane;
                }
                else
                {
                    camera.transform.position = new Vector3(0f, 0f, -1000f);
                    camera.transform.rotation = Quaternion.identity;
                    camera.orthographic = true;
                    camera.orthographicSize = layoutHeight / 2f;
                    camera.nearClipPlane = 0.01f;
                    camera.farClipPlane = 3000f;
                }
                camera.clearFlags = CameraClearFlags.SolidColor;
                camera.backgroundColor = new Color(background.r, background.g, background.b, 0f);
                camera.cullingMask = 1 << CaptureLayer;
                camera.allowHDR = false;
                camera.allowMSAA = false;
                // 直接沿用 prefab 相机（=Game View 相机）的 orthographicSize，不按 snapshotPixelsPerWorld 重算，
                // 否则离屏渲染的取景缩放会与 Game View 不一致。snapshotPixelsPerWorld 仅留作其它用途的换算缓存。
                if (camera.orthographic && session.snapshotPixelsPerWorld <= 0f)
                {
                    float referenceHeight = layoutHeight;
                    session.snapshotPixelsPerWorld = referenceHeight / Mathf.Max(0.0001f, 2f * camera.orthographicSize);
                }
            };
            if (timing != null) timing.Measure("snapshot.ngui.setupCamera", setupCamera);
            else setupCamera();

            Action renderCamera = () =>
            {
                texture = RenderNguiPreviewToTexture(previewUtility, camera, layoutWidth, layoutHeight, () =>
                {
                    ForceNguiRefresh(instance, true, true);
                    SetLayerRecursive(root, CaptureLayer);
                    MoveNguiDrawCallsToScene(instance, snapshotScene);
                    camera.Render();
                    ForceNguiRefresh(instance, true, false);
                    SetLayerRecursive(root, CaptureLayer);
                    MoveNguiDrawCallsToScene(instance, snapshotScene);
                    camera.Render();
                });

                // NGUI 不做画板外扩展：受控视觉编辑只需与 Game View 一致的画板区域（layoutWidth×layoutHeight）。
                // 扩展会改变相机视野/aspect，导致渲染像素与 bbox 投影错位，且违背“画板=Game View”的目标。
            };
            if (timing != null) timing.Measure("snapshot.ngui.renderCamera", renderCamera);
            else renderCamera();

            Action collectBboxes = () =>
            {
                CollectNguiBboxes(instance.transform, instance.transform, camera, outputWidth, outputHeight, request != null ? request.targetNodeIds : null, bboxes, nodeIdByTransform);
            };
            if (timing != null) timing.Measure("snapshot.ngui.collectBboxes", collectBboxes);
            else collectBboxes();

            Action readPixels = () =>
            {
                if (texture == null && rt != null)
                {
                    RenderTexture.active = rt;
                    texture = new Texture2D(outputWidth, outputHeight, TextureFormat.RGBA32, false);
                    texture.ReadPixels(new Rect(0, 0, outputWidth, outputHeight), 0, 0);
                    texture.Apply(false);
                }
            };
            if (timing != null) timing.Measure("snapshot.ngui.readPixels", readPixels);
            else readPixels();

            byte[] png = timing != null
                ? timing.Measure("snapshot.ngui.encodePng", () => texture.EncodeToPNG())
                : texture.EncodeToPNG();

            string snapshotId = Guid.NewGuid().ToString("N");
            string fileName = snapshotId + ".png";
            string absolutePath = ResolveSnapshotPath(fileName);
            Action writePng = () =>
            {
                Directory.CreateDirectory(Path.GetDirectoryName(absolutePath));
                File.WriteAllBytes(absolutePath, png);
            };
            if (timing != null) timing.Measure("snapshot.ngui.writePng", writePng);
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
                width = outputWidth,
                height = outputHeight,
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
                if (rt != null)
                {
                    if (camera != null && camera.targetTexture == rt) camera.targetTexture = null;
                    rt.Release();
                    UnityEngine.Object.DestroyImmediate(rt);
                }
                DisableNguiBehaviours(instance);
                CleanupNguiRuntimeObjects(instance);
                if (root != null) UnityEngine.Object.DestroyImmediate(root);
                RestoreNguiStaticState(nguiStaticState);
                CleanupNguiPreviewUtility(previewUtility, camera);
            };
            if (timing != null) timing.Measure("snapshot.ngui.cleanup", cleanup);
            else cleanup();
        }
        }

        private static Texture2D RenderNguiPreviewToTexture(PreviewRenderUtility previewUtility, Camera camera, int width, int height, Action renderAction)
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

        private static void CleanupNguiPreviewUtility(PreviewRenderUtility previewUtility, Camera renderCamera)
        {
            if (renderCamera != null) renderCamera.targetTexture = null;
            if (previewUtility == null) return;
            if (previewUtility.camera != null) previewUtility.camera.targetTexture = null;
            previewUtility.Cleanup();
        }
    }
}

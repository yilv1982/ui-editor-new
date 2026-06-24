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

        // 常驻隔离渲染：working root 进 CaptureLayer、NGUI 组件全程 enable、在 session 私有 previewScene
        // 内实时运行；drawcall 因 UIDrawCall 源码改动跟随 previewScene，不溢出主工程。同时建常驻离屏相机。
        public void PrepareWorkingRoot(SessionState session, GameObject root)
        {
            EnableAndPrimeNgui(session, root);
            EnsureSessionNguiCamera(session, root);
        }

        // 常开实例无需每次编辑后清理：drawcall 始终在 previewScene，session 关闭时随场景回收。
        public void AfterEditApplied(SessionState session, GameObject root)
        {
        }

        // 复用 session 常驻 working root + 常驻相机渲染。截图与 bbox 同源（同一 root、同一相机），
        // nodeId 与 export-node-tree 同源（都走 BuildNodeId 结构索引）。不再 Instantiate 新实例、
        // 不再 PreviewRenderUtility、不再捕获/恢复 NGUI 全局静态状态。
        public bool RenderSnapshot(SessionState session, RenderSnapshotRequest request, GameObject prefab, int width, int height, string imageMode, Color background, out SnapshotRecord snapshot, out string errorCode, out string errorMessage, BridgeTiming timing)
        {
            snapshot = null;
            errorCode = null;
            errorMessage = null;

            RenderTexture previousActive = RenderTexture.active;
            RenderTexture rt = null;
            Texture2D texture = null;
            int layoutWidth = session.snapshotWidth > 0 ? session.snapshotWidth : width;
            int layoutHeight = session.snapshotHeight > 0 ? session.snapshotHeight : height;
            SnapshotViewport viewport = new SnapshotViewport { x = 0f, y = 0f, width = layoutWidth, height = layoutHeight };

            try
            {
                GameObject root = prefab; // 此处 prefab 即 session 常驻 working root（见 InvokeRenderSnapshot 传参）
                if (root == null) throw new InvalidOperationException("NGUI working root is null");

                Camera camera = EnsureSessionNguiCamera(session, root);
                if (camera == null) throw new InvalidOperationException("NGUI snapshot camera is unavailable");

                Action prime = () =>
                {
                    SetLayerRecursive(root, CaptureLayer);
                    PrimeNguiFrame(root);
                };
                if (timing != null) timing.Measure("snapshot.ngui.prime", prime);
                else prime();

                // 背景：JPEG 无 alpha，用不透明实色（与 UGUI 口径一致）。
                camera.backgroundColor = new Color(background.r, background.g, background.b, 1f);

                List<BboxRecord> bboxes = new List<BboxRecord>();
                Dictionary<Transform, string> nodeIdByTransform = null;
                Action collectBboxes = () =>
                {
                    nodeIdByTransform = BuildNodeIdByTransform(root.transform);
                    CollectNguiBboxes(root.transform, root.transform, camera, layoutWidth, layoutHeight, request != null ? request.targetNodeIds : null, bboxes, nodeIdByTransform);
                };
                if (timing != null) timing.Measure("snapshot.ngui.collectBboxes", collectBboxes);
                else collectBboxes();

                Action renderCamera = () =>
                {
                    rt = new RenderTexture(layoutWidth, layoutHeight, 24, RenderTextureFormat.ARGB32);
                    rt.name = "__UIEditorNew_NguiRT";
                    rt.Create();
                    camera.targetTexture = rt;
                    if (camera.orthographic && layoutHeight > 0) camera.aspect = (float)layoutWidth / layoutHeight;
                    camera.Render();

                    RenderTexture.active = rt;
                    texture = new Texture2D(layoutWidth, layoutHeight, TextureFormat.RGBA32, false);
                    texture.ReadPixels(new Rect(0, 0, layoutWidth, layoutHeight), 0, 0);
                    texture.Apply(false);
                };
                if (timing != null) timing.Measure("snapshot.ngui.render", renderCamera);
                else renderCamera();

                ForceTextureAlphaOpaque(texture);

                byte[] imageBytes = timing != null
                    ? timing.Measure("snapshot.ngui.encodeJpg", () => texture.EncodeToJPG(SnapshotJpegQuality))
                    : texture.EncodeToJPG(SnapshotJpegQuality);

                string snapshotId = Guid.NewGuid().ToString("N");
                string fileName = snapshotId + ".jpg";
                string absolutePath = ResolveSnapshotPath(fileName);
                Action writeJpg = () =>
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(absolutePath));
                    File.WriteAllBytes(absolutePath, imageBytes);
                };
                if (timing != null) timing.Measure("snapshot.ngui.writeJpg", writeJpg);
                else writeJpg();

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
                    width = layoutWidth,
                    height = layoutHeight,
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
                    RenderTexture.active = previousActive;
                    if (session.nguiCamera != null) session.nguiCamera.targetTexture = null;
                    if (texture != null) UnityEngine.Object.DestroyImmediate(texture);
                    if (rt != null)
                    {
                        rt.Release();
                        UnityEngine.Object.DestroyImmediate(rt);
                    }
                };
                if (timing != null) timing.Measure("snapshot.ngui.cleanup", cleanup);
                else cleanup();
            }
        }
    }
}

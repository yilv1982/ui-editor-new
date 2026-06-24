using UnityEngine;
using UnityEngine.SceneManagement;
using System;
using System.Collections.Generic;
using System.IO;

public static partial class UIEditorNewBridgeCore
{
    private static string CaptureSceneGameView(string json)
    {
        OpenPrefabRequest request = JsonUtility.FromJson<OpenPrefabRequest>(json);
        if (request == null || string.IsNullOrEmpty(request.prefabPath))
            return FailJson("BAD_REQUEST", "prefabPath is required");
        string sourcePath = NormalizePrefabPath(request.prefabPath);

        // 直接在已加载场景里按 prefab 资产路径找实例
        GameObject instance = null;
        HashSet<int> seen = new HashSet<int>();
        for (int si = 0; si < SceneManager.sceneCount && instance == null; si++)
        {
            Scene scene = SceneManager.GetSceneAt(si);
            if (!scene.IsValid() || !scene.isLoaded) continue;
            GameObject[] roots = scene.GetRootGameObjects();
            for (int i = 0; i < roots.Length && instance == null; i++)
                instance = FindLoadedScenePrefabInstanceRecursive(roots[i], sourcePath, seen);
        }
        if (instance == null)
            return FailJson("SCENE_INSTANCE_NOT_FOUND", "No loaded scene instance for: " + sourcePath);

        Camera camera = FindBestCaptureCamera(instance);
        if (camera == null)
        {
            // 退而用场景里 depth 最大的启用相机（NGUI UICamera 多挂在子物体上）
            Camera[] all = UnityEngine.Object.FindObjectsOfType<Camera>();
            for (int i = 0; i < all.Length; i++)
                if (all[i] != null && all[i].enabled && (camera == null || all[i].depth >= camera.depth)) camera = all[i];
        }
        if (camera == null)
            return FailJson("CAMERA_NOT_FOUND", "No camera to render scene Game View");

        int width = request.width > 0 ? request.width : 1080;
        int height = request.height > 0 ? request.height : 1920;

        RenderTexture rt = null;
        RenderTexture prevActive = RenderTexture.active;
        RenderTexture prevTarget = camera.targetTexture;
        Texture2D tex = null;
        try
        {
            rt = RenderTexture.GetTemporary(width, height, 24, RenderTextureFormat.ARGB32);
            camera.targetTexture = rt;
            camera.Render();
            RenderTexture.active = rt;
            tex = new Texture2D(width, height, TextureFormat.RGBA32, false);
            tex.ReadPixels(new Rect(0, 0, width, height), 0, 0);
            tex.Apply(false);
            byte[] png = tex.EncodeToPNG();
            string fileName = "gameview_" + Guid.NewGuid().ToString("N") + ".png";
            string absolutePath = ResolveSnapshotPath(fileName);
            Directory.CreateDirectory(Path.GetDirectoryName(absolutePath));
            File.WriteAllBytes(absolutePath, png);
            return JsonUtility.ToJson(new CaptureSceneGameViewResponse
            {
                ok = true,
                cameraName = camera.gameObject.name,
                cameraOrthographic = camera.orthographic,
                cameraOrthographicSize = camera.orthographicSize,
                width = width,
                height = height,
                url = "/snapshots/" + fileName,
                path = (SnapshotFolder + "/" + fileName).Replace("\\", "/")
            });
        }
        catch (Exception ex)
        {
            return FailJson("CAPTURE_FAILED", ex.Message);
        }
        finally
        {
            camera.targetTexture = prevTarget;
            RenderTexture.active = prevActive;
            if (tex != null) UnityEngine.Object.DestroyImmediate(tex);
            if (rt != null) RenderTexture.ReleaseTemporary(rt);
        }
    }


}

using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;
using System;

public static partial class UIEditorNewBridgeCore
{
    private static Camera FindBestCaptureCamera(GameObject instance)
    {
        if (instance == null) return null;
        Camera[] cameras = instance.GetComponentsInChildren<Camera>(true);
        Camera fallback = null;
        for (int i = 0; i < cameras.Length; i++)
        {
            Camera cam = cameras[i];
            if (cam == null) continue;
            if (fallback == null) fallback = cam;
            if (cam.enabled && cam.gameObject.activeInHierarchy) return cam;
        }
        return fallback;
    }

    private static Scene CreateBridgePreviewScene()
    {
        try { return EditorSceneManager.NewPreviewScene(); }
        catch { return default(Scene); }
    }

    private static void CloseBridgePreviewScene(Scene scene)
    {
        if (!scene.IsValid()) return;
        try { EditorSceneManager.ClosePreviewScene(scene); }
        catch {}
    }

    private static Scene EnsureSessionPreviewScene(SessionState session)
    {
        if (session == null) return default(Scene);
        if (session.hasPreviewScene && session.previewScene.IsValid() && session.previewScene.isLoaded)
            return session.previewScene;

        session.previewScene = CreateBridgePreviewScene();
        session.hasPreviewScene = session.previewScene.IsValid() && session.previewScene.isLoaded;
        return session.previewScene;
    }

    private static void CloseSessionPreviewScene(SessionState session)
    {
        if (session == null || !session.hasPreviewScene) return;
        CloseBridgePreviewScene(session.previewScene);
        session.previewScene = default(Scene);
        session.hasPreviewScene = false;
    }

    private static void MoveRootToScene(GameObject go, Scene scene)
    {
        if (go == null || !scene.IsValid() || !scene.isLoaded) return;
        GameObject root = go.transform != null ? go.transform.root.gameObject : go;
        if (root == null) return;
        try
        {
            if (root.scene != scene)
                SceneManager.MoveGameObjectToScene(root, scene);
        }
        catch {}
    }

    private static bool SetActiveSceneIfValid(Scene scene)
    {
        if (!scene.IsValid() || !scene.isLoaded) return false;
        try { return SceneManager.SetActiveScene(scene); }
        catch { return false; }
    }

    private static void RestoreActiveScene(Scene scene)
    {
        if (!scene.IsValid() || !scene.isLoaded) return;
        try { SceneManager.SetActiveScene(scene); }
        catch {}
    }

    private static bool IsLoadedUserScene(Scene scene)
    {
        if (!scene.IsValid()) return false;
        for (int i = 0; i < SceneManager.sceneCount; i++)
        {
            if (SceneManager.GetSceneAt(i) == scene)
                return true;
        }
        return false;
    }
}

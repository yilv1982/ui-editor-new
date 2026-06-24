using UnityEngine;

public static partial class UIEditorNewBridgeCore
{
    private interface IUIEditorNewFrameworkAdapter
    {
        string Framework { get; }
        bool CanRender(SessionState session, GameObject prefab);
        bool RenderSnapshot(SessionState session, RenderSnapshotRequest request, GameObject prefab, int width, int height, string imageMode, Color background, out SnapshotRecord snapshot, out string errorCode, out string errorMessage, BridgeTiming timing);
    }

    private static readonly IUIEditorNewFrameworkAdapter[] FrameworkAdapters =
    {
        new NguiFrameworkAdapter(),
        new UguiFrameworkAdapter()
    };

    private static IUIEditorNewFrameworkAdapter ResolveFrameworkAdapter(SessionState session, GameObject prefab)
    {
        for (int i = 0; i < FrameworkAdapters.Length; i++)
        {
            IUIEditorNewFrameworkAdapter adapter = FrameworkAdapters[i];
            if (adapter != null && adapter.CanRender(session, prefab))
                return adapter;
        }
        return FrameworkAdapters[FrameworkAdapters.Length - 1];
    }
}

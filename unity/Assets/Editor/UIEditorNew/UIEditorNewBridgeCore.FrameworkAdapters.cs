using UnityEngine;

public static partial class UIEditorNewBridgeCore
{
    private interface IUIEditorNewFrameworkAdapter
    {
        string Framework { get; }
        bool CanRender(SessionState session, GameObject prefab);
        bool RenderSnapshot(SessionState session, RenderSnapshotRequest request, GameObject prefab, int width, int height, string imageMode, Color background, out SnapshotRecord snapshot, out string errorCode, out string errorMessage, BridgeTiming timing);

        // 每次编辑链路上对 working root / clone 的 framework 相关善后。
        // NGUI 在这里挂起渲染、清理运行时 drawcall/panel；UGUI 不需要，做成 no-op，
        // 避免对纯 UGUI 画板每次 move 都跑 NGUI 的全编辑器 Resources 扫描。
        void PrepareWorkingRoot(SessionState session, GameObject root);
        void AfterEditApplied(SessionState session, GameObject root);
    }

    // 编辑链路按 framework 选择善后逻辑，复用与渲染相同的 ResolveFrameworkAdapter 路由，避免分叉。
    private static void PrepareWorkingRootForFramework(SessionState session, GameObject root)
    {
        if (root == null) return;
        ResolveFrameworkAdapter(session, root).PrepareWorkingRoot(session, root);
    }

    private static void AfterEditAppliedForFramework(SessionState session, GameObject root)
    {
        if (root == null) return;
        ResolveFrameworkAdapter(session, root).AfterEditApplied(session, root);
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

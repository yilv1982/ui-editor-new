using UnityEngine;
using UnityEngine.UI;
using System.Collections.Generic;

public static partial class UIEditorNewBridgeCore
{
    private static void CollectUguiBboxes(RectTransform canvasRect, Transform root, Transform current, int width, int height, string[] targetNodeIds, List<BboxRecord> bboxes, Dictionary<Transform, string> nodeIdByTransform)
    {
        string path = GetTransformPath(root, current);
        string nodeId = ResolveCloneNodeId(root, current, nodeIdByTransform);
        if (ShouldIncludeUguiBbox(nodeId, targetNodeIds))
        {
            CaptureRect rect = CalculateUguiCaptureRect(canvasRect, current, width, height);
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
                contributesToBounds = IsUguiDrawableBoundsSource(current)
            });
        }
        foreach (Transform child in current)
            CollectUguiBboxes(canvasRect, root, child, width, height, targetNodeIds, bboxes, nodeIdByTransform);
    }

    private static bool ShouldIncludeUguiBbox(string nodeId, string[] targetNodeIds)
    {
        if (targetNodeIds == null || targetNodeIds.Length == 0) return true;
        for (int i = 0; i < targetNodeIds.Length; i++)
            if (targetNodeIds[i] == nodeId) return true;
        return false;
    }

    private static bool IsUguiDrawableBoundsSource(Transform transform)
    {
        if (transform == null) return false;
        Graphic graphic = transform.GetComponent<Graphic>();
        if (graphic == null || !graphic.enabled) return false;
        if (graphic.canvasRenderer != null && graphic.canvasRenderer.GetAlpha() <= 0.001f) return false;
        return graphic.color.a > 0.001f;
    }

    private static CaptureRect CalculateUguiCaptureRect(RectTransform canvasRect, Transform target, int width, int height)
    {
        RectTransform targetRect = target as RectTransform;
        if (targetRect != null)
        {
            Vector3[] corners = new Vector3[4];
            targetRect.GetWorldCorners(corners);
            float minX = float.PositiveInfinity;
            float minY = float.PositiveInfinity;
            float maxX = float.NegativeInfinity;
            float maxY = float.NegativeInfinity;
            for (int i = 0; i < corners.Length; i++)
            {
                Vector3 local = canvasRect.InverseTransformPoint(corners[i]);
                minX = Mathf.Min(minX, local.x);
                minY = Mathf.Min(minY, local.y);
                maxX = Mathf.Max(maxX, local.x);
                maxY = Mathf.Max(maxY, local.y);
            }
            return new CaptureRect
            {
                x = minX + width * 0.5f,
                y = height * 0.5f - maxY,
                width = Mathf.Max(0f, maxX - minX),
                height = Mathf.Max(0f, maxY - minY)
            };
        }

        Bounds bounds = RectTransformUtility.CalculateRelativeRectTransformBounds(canvasRect, target);
        return new CaptureRect
        {
            x = bounds.min.x + width * 0.5f,
            y = height * 0.5f - bounds.max.y,
            width = Mathf.Max(0f, bounds.size.x),
            height = Mathf.Max(0f, bounds.size.y)
        };
    }
}

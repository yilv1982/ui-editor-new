import { readPsd } from 'ag-psd';
import type { Layer } from 'ag-psd';
import { useEditorStore } from '../stores/editorStore';
import { defaultStyle } from '../types';

// 将 canvas 转为 base64 dataURL
function canvasToDataUrl(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL('image/png');
}

// 递归解析 PSD 图层 → 创建编辑器节点
function processLayer(
  layer: Layer,
  parentId: string | null,
  offsetX: number,
  offsetY: number,
  addNode: ReturnType<typeof useEditorStore.getState>['addNode']
) {
  const name = layer.name || 'Layer';
  const left = (layer.left ?? 0) - offsetX;
  const top = (layer.top ?? 0) - offsetY;
  const width = (layer.right ?? 0) - (layer.left ?? 0);
  const height = (layer.bottom ?? 0) - (layer.top ?? 0);
  const isHidden = layer.hidden ?? false;
  const opacity = (layer.opacity ?? 255) / 255;

  // 跳过无效图层
  if (width <= 0 || height <= 0) {
    // 可能是纯分组，检查子图层
    if (layer.children && layer.children.length > 0) {
      const groupId = addNode('frame', left, top, {
        parentId: parentId || undefined,
        name,
        width: 1,
        height: 1,
        visible: !isHidden,
        style: { ...defaultStyle, backgroundColor: 'transparent', backgroundOpacity: 0, opacity },
      });

      // 递归子图层
      for (const child of layer.children) {
        processLayer(child, groupId, layer.left ?? 0, layer.top ?? 0, addNode);
      }

      // 根据子节点计算分组大小
      recalcGroupBounds(groupId);
    }
    return;
  }

  // 判断是分组还是叶子图层
  const isGroup = layer.children && layer.children.length > 0;

  if (isGroup) {
    // 分组 → frame 节点
    const groupId = addNode('frame', left, top, {
      parentId: parentId || undefined,
      name,
      width,
      height,
      visible: !isHidden,
      style: { ...defaultStyle, backgroundColor: 'transparent', backgroundOpacity: 0, opacity },
    });

    for (const child of layer.children!) {
      processLayer(child, groupId, layer.left ?? 0, layer.top ?? 0, addNode);
    }
  } else {
    // 叶子图层 → 检查是否是文字
    if (layer.text) {
      const fontSize = layer.text.style?.fontSize ?? 24;
      const fontColor = rgbToHex(layer.text.style?.fillColor);

      addNode('text', left, top, {
        parentId: parentId || undefined,
        name,
        width,
        height,
        visible: !isHidden,
        text: layer.text.text || name,
        style: {
          ...defaultStyle,
          backgroundColor: 'transparent',
          backgroundOpacity: 0,
          opacity,
          fontSize: typeof fontSize === 'number' ? fontSize : 24,
          fontColor: fontColor || '#ffffff',
        },
      });
    } else {
      // 普通图层 → image 节点（提取像素）
      let imageData: string | undefined;
      if (layer.canvas) {
        imageData = canvasToDataUrl(layer.canvas as unknown as HTMLCanvasElement);
      }

      addNode('image', left, top, {
        parentId: parentId || undefined,
        name,
        width,
        height,
        visible: !isHidden,
        imageData,
        style: { ...defaultStyle, backgroundColor: 'transparent', backgroundOpacity: 0, opacity },
      } as any);
    }
  }
}

// 根据子节点重算分组边界
function recalcGroupBounds(groupId: string) {
  const store = useEditorStore.getState();
  const group = store.nodes[groupId];
  if (!group || group.children.length === 0) return;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  for (const childId of group.children) {
    const child = store.nodes[childId];
    if (!child) continue;
    minX = Math.min(minX, child.x);
    minY = Math.min(minY, child.y);
    maxX = Math.max(maxX, child.x + child.width);
    maxY = Math.max(maxY, child.y + child.height);
  }

  if (minX < Infinity) {
    store.updateNode(groupId, {
      width: Math.max(1, maxX - minX),
      height: Math.max(1, maxY - minY),
    });
  }
}

// 颜色对象转 hex
function rgbToHex(color: any): string {
  if (!color) return '#ffffff';
  const r = Math.round(color.r ?? 255);
  const g = Math.round(color.g ?? 255);
  const b = Math.round(color.b ?? 255);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

// 主入口：解析 PSD 文件
export async function importPsd(file: File): Promise<{ layerCount: number; name: string }> {
  const buffer = await file.arrayBuffer();

  const psd = readPsd(buffer, {
    skipCompositeImageData: false,
    skipLayerImageData: false,
    skipThumbnail: true,
  });

  const store = useEditorStore.getState();
  store.pushHistory();

  let layerCount = 0;

  // PSD 根信息
  const psdWidth = psd.width;
  const psdHeight = psd.height;
  const psdName = file.name.replace(/\.psd$/i, '');

  // 创建根容器（代表 PSD 画布）
  const rootId = store.addNode('frame', 0, 0, {
    name: psdName,
    width: psdWidth,
    height: psdHeight,
    style: { ...defaultStyle, backgroundColor: '#1e1e2e', backgroundOpacity: 1, opacity: 1 },
  });

  // 递归处理图层
  if (psd.children) {
    for (const layer of psd.children) {
      processLayer(layer, rootId, 0, 0, store.addNode);
      layerCount++;
    }
  }

  // 统计总节点数
  const countNodes = (id: string): number => {
    const node = useEditorStore.getState().nodes[id];
    if (!node) return 0;
    return 1 + node.children.reduce((sum, cid) => sum + countNodes(cid), 0);
  };
  layerCount = countNodes(rootId) - 1; // 排除根节点

  return { layerCount, name: psdName };
}

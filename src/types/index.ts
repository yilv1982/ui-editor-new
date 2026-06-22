// ========== 场景工具 ==========
export type SceneTool = 'hand' | 'move' | 'rotate' | 'scale' | 'rect' | 'transform';

import type { AnnotationNode } from './annotation';
import type { SidebarBlock } from './sidebar';

// ========== 节点类型 ==========

export type NodeType = 'frame' | 'text' | 'image' | 'component' | 'button' | 'scrollview' | 'toggle' | 'inputfield' | 'rawimage';

export interface UIStyle {
  backgroundColor: string;
  backgroundOpacity: number;
  borderColor: string;
  borderWidth: number;
  borderRadius: number;
  fontSize: number;
  fontColor: string;
  fontWeight: 'normal' | 'bold';
  textAlign: 'left' | 'center' | 'right';
  opacity: number;
}

export const defaultStyle: UIStyle = {
  backgroundColor: '#585b70',
  backgroundOpacity: 1,
  borderColor: '#6c7086',
  borderWidth: 0,
  borderRadius: 0,
  fontSize: 24,
  fontColor: '#cdd6f4',
  fontWeight: 'normal',
  textAlign: 'left',
  opacity: 1,
};

export interface UITextEffect {
  color: string;
  distance: [number, number];
  source?: 'UnityOutline' | 'UnityShadow' | 'UIShadow';
  style?: number;
  useGraphicAlpha?: boolean;
}

export interface UINode {
  id: string;
  name: string;
  type: NodeType;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  visible: boolean;
  locked: boolean;
  children: string[];       // 子节点 id 列表
  parentId: string | null;
  style: UIStyle;
  componentRef?: string;    // 关联的通用组件名，如 "Part_Btn_Blue"
  text?: string;            // type=text 时的文本内容
  imageData?: string;        // type=image 时的图片数据（base64 或 URL）
  sliceEnabled?: boolean;    // 是否启用九宫格
  sliceBorder?: SliceBorder; // 九宫格边距

  // Unity prefab 中该节点 GameObject 的 fileID（增量同步用）
  // 从 prefab 导入时填入，导出 JSON 时带回 Unity，用于精确匹配旧节点
  unityFileId?: string;

  // Unity RectTransform 锚点
  anchorMin?: { x: number; y: number };
  anchorMax?: { x: number; y: number };
  pivot?: { x: number; y: number };
  // ContentSizeFitter/LayoutGroup 节点保存原始 Unity 值，导出时优先使用
  originalSizeDelta?: { x: number; y: number };
  originalAnchoredPosition?: { x: number; y: number };
  localScale?: { x: number; y: number; z?: number };
  originalLocalScale?: { x: number; y: number; z?: number };

  // Unity Text 完整属性
  fontPath?: string;
  fontStyle?: number;
  alignment?: number;
  richText?: boolean;
  horizontalOverflow?: number;
  verticalOverflow?: number;
  lineSpacing?: number;
  bestFit?: boolean;
  bestFitMinSize?: number;
  bestFitMaxSize?: number;
  raycastTarget?: boolean;
  textOutline?: UITextEffect;
  textShadow?: UITextEffect;
  textGradient?: {
    direction: 'Horizontal' | 'Vertical' | 'Angle' | 'Diagonal';
    color1: string;
    color2: string;
  };

  // Unity Image 完整属性
  imageEnabled?: boolean;        // Image 组件是否启用（默认 true，false 则不渲染图像但保留节点）
  imageHasSprite?: boolean;      // Prefab Image 是否真的绑定了 Sprite；false 常见于运行时填图占位
  imageSpriteGuid?: string;      // Prefab Image 绑定的 Sprite guid，用于诊断未解析资源
  imageSpriteFileId?: number;    // Prefab Image 绑定的 Sprite fileID
  imageType?: 'Simple' | 'Sliced' | 'Tiled' | 'Filled';
  imageColor?: string;           // 图片着色 #RRGGBBAA
  fillCenter?: boolean;
  fillMethod?: number;           // 0=Horizontal 1=Vertical 2=Radial90 3=Radial180 4=Radial360
  fillAmount?: number;           // 0-1
  fillClockwise?: boolean;
  fillOrigin?: number;
  preserveAspect?: boolean;
  useSpriteMesh?: boolean;
  imageRaycastTarget?: boolean;
  mirrorType?: 'Horizontal' | 'Vertical' | 'Quarter';
  nativeVideoPlayer?: boolean;   // 节点挂有 UnityEngine.Video.VideoPlayer，RawImage 贴图由运行时视频注入

  // Outline 组件（可用于 Image / Button 等任何 Graphic）
  outline?: { color: string; distance: [number, number]; useGraphicAlpha?: boolean };

  // Button 是否有 Image 组件（Unity 中 Button 可以不带 Image）
  // undefined 或 true = 有Image（向后兼容），false = 无Image
  hasImage?: boolean;

  // Unity Button 属性
  interactable?: boolean;
  buttonTransition?: number;     // 0=None 1=ColorTint 2=SpriteSwap 3=Animation
  buttonColors?: {
    normalColor: string;
    highlightedColor: string;
    pressedColor: string;
    disabledColor: string;
    colorMultiplier: number;
    fadeDuration: number;
  };

  // Mask
  isMask?: boolean;
  maskType?: 'Mask' | 'RectMask2D';
  maskShowGraphic?: boolean;     // Mask.showMaskGraphic=false 时自身不显示，但仍参与遮罩
  // ScrollView
  scrollDirection?: 'horizontal' | 'vertical' | 'both';
  // Toggle
  isOn?: boolean;

  // Unity LayoutElement
  layoutElement?: {
    ignoreLayout: boolean;
    minWidth: number;
    minHeight: number;
    preferredWidth: number;
    preferredHeight: number;
    flexibleWidth: number;
    flexibleHeight: number;
  };

  // Unity LayoutGroup (HorizontalLayoutGroup / VerticalLayoutGroup / GridLayoutGroup)
  layoutGroup?: {
    enabled: boolean;
    isHorizontal: boolean;
    isGrid?: boolean;
    layoutType?: 'Horizontal' | 'Vertical' | 'Grid';
    spacing: number;
    padLeft: number;
    padRight: number;
    padTop: number;
    padBottom: number;
    childAlignment: number;
    childControlWidth: boolean;
    childControlHeight: boolean;
    childForceExpandWidth: boolean;
    childForceExpandHeight: boolean;
    reverseArrangement?: boolean;
    // Grid 专属
    cellSizeX?: number;
    cellSizeY?: number;
    spacingY?: number;
    startCorner?: number;
    startAxis?: number;
    constraint?: number;
    constraintCount?: number;
  };
  // Unity ContentSizeFitter
  contentSizeFitter?: {
    enabled: boolean;
    horizontalFit: number;  // 0=Unconstrained 1=MinSize 2=PreferredSize
    verticalFit: number;
  };
}

// Unity Anchor 预设
export type AnchorPreset =
  | 'top-left' | 'top-center' | 'top-right' | 'top-stretch'
  | 'middle-left' | 'middle-center' | 'middle-right' | 'middle-stretch'
  | 'bottom-left' | 'bottom-center' | 'bottom-right' | 'bottom-stretch'
  | 'stretch-left' | 'stretch-center' | 'stretch-right' | 'stretch-stretch'
  | 'custom';

export interface AnchorPresetDef {
  key: AnchorPreset;
  label: string;
  anchorMin: { x: number; y: number };
  anchorMax: { x: number; y: number };
}

// 4x4 预设网格（行：top/middle/bottom/stretch，列：left/center/right/stretch）
export const anchorPresets: AnchorPresetDef[] = [
  { key: 'top-left',       label: '左上', anchorMin: { x: 0, y: 1 },   anchorMax: { x: 0, y: 1 } },
  { key: 'top-center',     label: '上中', anchorMin: { x: 0.5, y: 1 }, anchorMax: { x: 0.5, y: 1 } },
  { key: 'top-right',      label: '右上', anchorMin: { x: 1, y: 1 },   anchorMax: { x: 1, y: 1 } },
  { key: 'top-stretch',    label: '上拉伸', anchorMin: { x: 0, y: 1 },   anchorMax: { x: 1, y: 1 } },

  { key: 'middle-left',    label: '左中', anchorMin: { x: 0, y: 0.5 },   anchorMax: { x: 0, y: 0.5 } },
  { key: 'middle-center',  label: '居中', anchorMin: { x: 0.5, y: 0.5 }, anchorMax: { x: 0.5, y: 0.5 } },
  { key: 'middle-right',   label: '右中', anchorMin: { x: 1, y: 0.5 },   anchorMax: { x: 1, y: 0.5 } },
  { key: 'middle-stretch', label: '中拉伸', anchorMin: { x: 0, y: 0.5 },   anchorMax: { x: 1, y: 0.5 } },

  { key: 'bottom-left',    label: '左下', anchorMin: { x: 0, y: 0 },   anchorMax: { x: 0, y: 0 } },
  { key: 'bottom-center',  label: '下中', anchorMin: { x: 0.5, y: 0 }, anchorMax: { x: 0.5, y: 0 } },
  { key: 'bottom-right',   label: '右下', anchorMin: { x: 1, y: 0 },   anchorMax: { x: 1, y: 0 } },
  { key: 'bottom-stretch', label: '下拉伸', anchorMin: { x: 0, y: 0 },   anchorMax: { x: 1, y: 0 } },

  { key: 'stretch-left',   label: '左拉伸', anchorMin: { x: 0, y: 0 },   anchorMax: { x: 0, y: 1 } },
  { key: 'stretch-center', label: '中拉伸V', anchorMin: { x: 0.5, y: 0 }, anchorMax: { x: 0.5, y: 1 } },
  { key: 'stretch-right',  label: '右拉伸', anchorMin: { x: 1, y: 0 },   anchorMax: { x: 1, y: 1 } },
  { key: 'stretch-stretch', label: '全拉伸', anchorMin: { x: 0, y: 0 },   anchorMax: { x: 1, y: 1 } },
];

export function getAnchorPreset(anchorMin?: { x: number; y: number }, anchorMax?: { x: number; y: number }): AnchorPreset {
  if (!anchorMin || !anchorMax) return 'middle-center';
  for (const p of anchorPresets) {
    if (Math.abs(p.anchorMin.x - anchorMin.x) < 0.01 &&
        Math.abs(p.anchorMin.y - anchorMin.y) < 0.01 &&
        Math.abs(p.anchorMax.x - anchorMax.x) < 0.01 &&
        Math.abs(p.anchorMax.y - anchorMax.y) < 0.01) {
      return p.key;
    }
  }
  return 'custom';
}

// 九宫格切片边距（像素）
export interface SliceBorder {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

// ========== 组件库 ==========

export interface ComponentDef {
  name: string;             // Part_Btn_Blue
  displayName: string;      // 蓝色按钮
  category: string;         // 按钮 / 头像 / 进度条 ...
  thumbnail: string;        // 截图路径
  defaultWidth: number;
  defaultHeight: number;
  relPath?: string;         // 项目 prefab 相对路径，如 UICommons/UIBlueBtn.prefab
}

// ========== 页面/图层 ==========

/**
 * 画板（Artboard）—— 同一个 Page 里可以挂多个画板，每个画板独立对应一个 prefab。
 * 节点坐标系仍以画板左上角为原点（不含 artboard.x/y）。
 */
export interface Artboard {
  id: string;
  name: string;

  // 画板在 Page 画布上的位置（绝对坐标）
  x: number;
  y: number;
  width: number;   // 默认使用 DEFAULT_PREVIEW_WIDTH
  height: number;  // 默认使用 DEFAULT_PREVIEW_HEIGHT

  // 画板私有：原 PageData 里 prefab 强相关字段
  nodes: Record<string, UINode>;
  rootIds: string[];
  // 来源 prefab 路径（增量同步用），如 Assets/HotRes/UI/Prefab/Common/UI_Common_ShowReward.prefab
  sourcePrefabPath: string | null;
  sidebar?: SidebarBlock[];
  sidebarEnabled?: boolean;
}

export interface PageData {
  id: string;
  name: string;

  // 多画板
  artboards: Artboard[];
  activeArtboardId: string;

  // 跨画板共享：批注/流程线留在 Page 层
  annotations?: Record<string, AnnotationNode>;
  annotationRootIds?: string[];

  // 状态分组(版式 3 用)
  pageGroup?: string;
}

export type { AnnotationNode, AnnotationType } from './annotation';
export type { SidebarBlock, SidebarBlockType, TagRole } from './sidebar';
export { TAG_COLORS } from './sidebar';

// ========== 导出 JSON ==========

export interface ExportNode {
  id?: string;
  editorId?: string;           // 编辑器节点持久 uuid（增量同步用）
  unityFileId?: string;        // 来源 prefab 中的 GameObject fileID（增量同步用）
  name: string;
  type: NodeType;
  active?: boolean;            // false 表示节点隐藏（Unity 端 SetActive(false)）
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  style: Partial<UIStyle>;
  componentRef?: string;
  text?: string;
  sliceBorder?: SliceBorder;
  imagePath?: string;          // Unity 资源路径，如 "Assets/HotRes/UI/Atlas/common/textures/xxx.png"
  // Unity RectTransform
  anchorMin?: { x: number; y: number };
  anchorMax?: { x: number; y: number };
  pivot?: { x: number; y: number };
  anchoredPosition?: { x: number; y: number };
  sizeDelta?: { x: number; y: number };
  localScale?: { x: number; y: number; z?: number };
  // Unity Text
  fontPath?: string;
  fontStyle?: number;
  alignment?: number;
  richText?: boolean;
  horizontalOverflow?: number;
  verticalOverflow?: number;
  lineSpacing?: number;
  bestFit?: boolean;
  bestFitMinSize?: number;
  bestFitMaxSize?: number;
  raycastTarget?: boolean;
  textOutline?: UITextEffect;
  textShadow?: UITextEffect;
  textGradient?: {
    direction: 'Horizontal' | 'Vertical' | 'Angle' | 'Diagonal';
    color1: string;
    color2: string;
  };
  // Unity Image
  imageEnabled?: boolean;
  imageHasSprite?: boolean;
  imageSpriteGuid?: string;
  imageSpriteFileId?: number;
  imageType?: 'Simple' | 'Sliced' | 'Tiled' | 'Filled';
  imageColor?: string;
  fillCenter?: boolean;
  fillMethod?: number;
  fillAmount?: number;
  fillClockwise?: boolean;
  fillOrigin?: number;
  preserveAspect?: boolean;
  useSpriteMesh?: boolean;
  imageRaycastTarget?: boolean;
  mirrorType?: 'Horizontal' | 'Vertical' | 'Quarter';
  // Outline
  outline?: { color: string; distance: [number, number]; useGraphicAlpha?: boolean };
  hasImage?: boolean;
  // Unity Button
  interactable?: boolean;
  buttonTransition?: number;
  buttonColors?: {
    normalColor: string;
    highlightedColor: string;
    pressedColor: string;
    disabledColor: string;
    colorMultiplier: number;
    fadeDuration: number;
  };
  isMask?: boolean;
  maskType?: 'Mask' | 'RectMask2D';
  maskShowGraphic?: boolean;
  scrollDirection?: 'horizontal' | 'vertical' | 'both';
  isOn?: boolean;
  layoutElement?: UINode['layoutElement'];
  layoutGroup?: UINode['layoutGroup'];
  contentSizeFitter?: UINode['contentSizeFitter'];
  children: ExportNode[];
}

export interface ExportDocument {
  version: string;
  name: string;
  canvasWidth: number;
  canvasHeight: number;
  sourcePrefabPath?: string;   // 来源 prefab 相对路径（增量同步用），如 Common/UI_Common_ShowReward.prefab
  root: ExportNode;
}

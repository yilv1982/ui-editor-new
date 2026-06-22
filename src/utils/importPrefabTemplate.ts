import { defaultStyle } from '../types';
import type { NodeType, UINode } from '../types';

export interface PrefabTemplateNode {
  name: string;
  type: string;
  active: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  text?: string;
  fontSize?: number;
  fontColor?: string;
  textAlign?: string;
  imagePath?: string;
  imageType?: string;
  sliceBorder?: number[];
  unityFileId?: string;
  componentRef?: string;
  anchorMin?: { x: number; y: number };
  anchorMax?: { x: number; y: number };
  pivot?: { x: number; y: number };
  originalSizeDelta?: { x: number; y: number };
  originalAnchoredPosition?: { x: number; y: number };
  localScale?: { x: number; y: number; z?: number };
  originalLocalScale?: { x: number; y: number; z?: number };
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
  textOutline?: UINode['textOutline'];
  textShadow?: UINode['textShadow'];
  textGradient?: { direction: string; color1: string; color2: string };
  imageEnabled?: boolean;
  imageHasSprite?: boolean;
  imageSpriteGuid?: string;
  imageSpriteFileId?: number;
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
  nativeVideoPlayer?: boolean;
  outline?: UINode['outline'];
  hasImage?: boolean;
  buttonTransition?: number;
  buttonColors?: UINode['buttonColors'];
  isMask?: boolean;
  maskType?: 'Mask' | 'RectMask2D';
  maskShowGraphic?: boolean;
  scrollDirection?: 'horizontal' | 'vertical' | 'both';
  isOn?: boolean;
  interactable?: boolean;
  layoutElement?: UINode['layoutElement'];
  layoutGroup?: UINode['layoutGroup'];
  contentSizeFitter?: UINode['contentSizeFitter'];
  children?: PrefabTemplateNode[];
}

export interface PrefabParseResult {
  name: string;
  sourcePath?: string;
  root: PrefabTemplateNode | null;
}

export type AddNodeFn = (
  type: NodeType,
  x: number,
  y: number,
  options?: Partial<UINode> & Record<string, unknown>,
) => string;

const typeMap: Record<string, NodeType> = {
  component: 'component',
  text: 'text',
  image: 'image',
  frame: 'frame',
  button: 'button',
  scrollview: 'scrollview',
  toggle: 'toggle',
  inputfield: 'inputfield',
  rawimage: 'rawimage',
};

export async function fetchPrefabTemplate(relPath: string, name?: string): Promise<PrefabParseResult> {
  const params = new URLSearchParams({ path: relPath });
  if (name) params.set('name', name);
  const res = await fetch(`/api/prefabs/parse?${params.toString()}`);
  if (!res.ok) throw new Error(`Prefab parse failed: ${res.status}`);
  return await res.json() as PrefabParseResult;
}

export function importPrefabTemplateNode(
  tNode: PrefabTemplateNode,
  parentId: string | null,
  addNode: AddNodeFn,
  override?: { x?: number; y?: number; name?: string },
): string {
  const type = typeMap[tNode.type] || 'frame';
  const hasPositionOverride = !!override
    && (Object.prototype.hasOwnProperty.call(override, 'x') || Object.prototype.hasOwnProperty.call(override, 'y'));

  const style = { ...defaultStyle };
  style.backgroundColor = 'transparent';
  style.backgroundOpacity = 0;
  style.opacity = 1;
  if (tNode.fontSize) style.fontSize = tNode.fontSize;
  if (tNode.fontColor) style.fontColor = tNode.fontColor;
  if (tNode.textAlign) style.textAlign = tNode.textAlign as 'left' | 'center' | 'right';
  if (tNode.fontStyle === 1 || tNode.fontStyle === 3) style.fontWeight = 'bold';

  const options: Partial<UINode> & Record<string, unknown> = {
    parentId: parentId || undefined,
    name: override?.name || (tNode.type === 'component' ? `@${tNode.componentRef}` : tNode.name),
    width: tNode.width ?? 100,
    height: tNode.height ?? 100,
    rotation: tNode.rotation || 0,
    visible: tNode.active !== false,
    style,
    componentRef: tNode.componentRef,
    text: tNode.text,
    anchorMin: tNode.anchorMin || undefined,
    anchorMax: tNode.anchorMax || undefined,
    pivot: tNode.pivot || undefined,
    originalSizeDelta: tNode.originalSizeDelta || undefined,
    originalAnchoredPosition: hasPositionOverride ? undefined : tNode.originalAnchoredPosition || undefined,
    localScale: tNode.localScale || undefined,
    originalLocalScale: tNode.originalLocalScale || undefined,
    imageType: tNode.imageType as UINode['imageType'],
    isMask: tNode.isMask || undefined,
    maskType: tNode.maskType || undefined,
    maskShowGraphic: tNode.maskShowGraphic,
    scrollDirection: tNode.scrollDirection || undefined,
    isOn: tNode.isOn,
    interactable: tNode.interactable,
    textOutline: tNode.textOutline || undefined,
    textShadow: tNode.textShadow || undefined,
    textGradient: tNode.textGradient as UINode['textGradient'],
    fontPath: tNode.fontPath || undefined,
    fontStyle: tNode.fontStyle,
    alignment: tNode.alignment,
    richText: tNode.richText,
    horizontalOverflow: tNode.horizontalOverflow,
    verticalOverflow: tNode.verticalOverflow,
    lineSpacing: tNode.lineSpacing,
    bestFit: tNode.bestFit,
    bestFitMinSize: tNode.bestFitMinSize,
    bestFitMaxSize: tNode.bestFitMaxSize,
    raycastTarget: tNode.raycastTarget,
    imageColor: tNode.imageColor || undefined,
    imageEnabled: tNode.imageEnabled,
    imageHasSprite: tNode.imageHasSprite,
    imageSpriteGuid: tNode.imageSpriteGuid,
    imageSpriteFileId: tNode.imageSpriteFileId,
    fillCenter: tNode.fillCenter,
    fillMethod: tNode.fillMethod,
    fillAmount: tNode.fillAmount,
    fillClockwise: tNode.fillClockwise,
    fillOrigin: tNode.fillOrigin,
    preserveAspect: tNode.preserveAspect,
    useSpriteMesh: tNode.useSpriteMesh,
    imageRaycastTarget: tNode.imageRaycastTarget,
    mirrorType: tNode.mirrorType || undefined,
    nativeVideoPlayer: tNode.nativeVideoPlayer || undefined,
    outline: tNode.outline || undefined,
    hasImage: tNode.hasImage,
    buttonTransition: tNode.buttonTransition,
    buttonColors: tNode.buttonColors || undefined,
    layoutElement: tNode.layoutElement || undefined,
    layoutGroup: tNode.layoutGroup || undefined,
    contentSizeFitter: tNode.contentSizeFitter || undefined,
  };

  if (tNode.imagePath) {
    options.imageData = tNode.imagePath;
  }
  if (tNode.unityFileId) {
    options.unityFileId = tNode.unityFileId;
  }
  if (tNode.sliceBorder && tNode.sliceBorder.some((v) => v > 0)) {
    options.sliceEnabled = true;
    options.sliceBorder = {
      left: tNode.sliceBorder[0],
      right: tNode.sliceBorder[1],
      top: tNode.sliceBorder[2],
      bottom: tNode.sliceBorder[3],
    };
  }

  const nodeId = addNode(type, override?.x ?? tNode.x ?? 0, override?.y ?? tNode.y ?? 0, options);

  if (tNode.children) {
    for (const child of tNode.children) {
      importPrefabTemplateNode(child, nodeId, addNode);
    }
  }

  return nodeId;
}

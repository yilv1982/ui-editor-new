/**
 * Unity 资源路径常量（纯常量，浏览器 / Node 均可用）
 * 这些是项目结构约定，所有人一样，不需要每人改
 */

/** Unity 资源子路径 */
export const ASSET_PATHS = {
  atlas:        'Assets/HotRes2/UIs/Textures',
  texture:      'Assets/HotRes2/Textures',
  prefab:       'Assets/HotRes2/UIs/Prefabs',
  legacyPrefabs: ['Assets/HotRes'],
  commonPart:   'Assets/HotRes2/UIs/Prefabs/UICommons',
  font:         'Assets/HotRes2/Fonts',
  bridgeScript: 'Assets/Editor/UIEditorNew/UIEditorNewBridgeSync.cs',
  corsProxy:    'Assets/Editor/UIEditorNew/UIEditorNewCorsProxy.cs',
  syncJson:     'Assets/Editor/UIEditorNew/uieditor_new_sync.json',
  screenshot:   'Assets/Editor/UIEditorNew/uieditor_new_screenshot.png',
};

/** 字体列表（属性面板下拉选项） */
export const FONT_LIST = [
  { label: 'Mikado', path: 'Assets/HotRes2/Fonts/Mikado.ttc' },
  { label: 'msyh',   path: 'Assets/HotRes2/Fonts/msyh.ttc' },
  { label: 'thai',   path: 'Assets/HotRes2/Fonts/thai.ttf' },
];

/** 默认字体路径 */
export const DEFAULT_FONT = 'Assets/HotRes2/Fonts/msyh.ttc';

/** Unity Prefab 原始设计基准分辨率（解析/导出坐标基准，不等同于编辑器默认画布） */
export const DESIGN_WIDTH = 1920;
export const DESIGN_HEIGHT = 1080;

/** 编辑器默认预览画布分辨率 */
export const DEFAULT_PREVIEW_WIDTH = 1080;
export const DEFAULT_PREVIEW_HEIGHT = 1920;

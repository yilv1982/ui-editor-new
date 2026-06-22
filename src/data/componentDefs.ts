import type { ComponentDef } from '../types';

// Legacy LOA static component definitions were removed from this fork.
// Dreamland components should come from /api/components/list, backed by current project Prefabs.
export const componentDefs: ComponentDef[] = [];

// === 基础控件（Unity UGUI）===
export const widgetDefs: { name: string; displayName: string; type: import('../types').NodeType; defaultWidth: number; defaultHeight: number; icon: string; color: string }[] = [
  { name: 'Button', displayName: '按钮', type: 'button', defaultWidth: 200, defaultHeight: 60, icon: 'BTN', color: '#89b4fa' },
  { name: 'ScrollView', displayName: '滚动视图', type: 'scrollview', defaultWidth: 400, defaultHeight: 300, icon: 'SCR', color: '#a6e3a1' },
  { name: 'Toggle', displayName: '开关', type: 'toggle', defaultWidth: 120, defaultHeight: 40, icon: 'TOG', color: '#f9e2af' },
  { name: 'InputField', displayName: '输入框', type: 'inputfield', defaultWidth: 300, defaultHeight: 50, icon: 'INP', color: '#cba6f7' },
  { name: 'RawImage', displayName: '原始图片', type: 'rawimage', defaultWidth: 200, defaultHeight: 200, icon: 'RAW', color: '#fab387' },
  { name: 'Image', displayName: '图片', type: 'image', defaultWidth: 200, defaultHeight: 200, icon: 'IMG', color: '#a6adc8' },
  { name: 'Text', displayName: '文本', type: 'text', defaultWidth: 200, defaultHeight: 40, icon: 'TXT', color: '#cdd6f4' },
  { name: 'Frame', displayName: '容器', type: 'frame', defaultWidth: 300, defaultHeight: 200, icon: 'FRM', color: '#6c7086' },
];

export const categories: string[] = [];

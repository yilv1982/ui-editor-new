// src/types/sidebar.ts
// 页面说明栏数据 — 用于"多屏侧栏型"导出版式
export type SidebarBlockType = 'plain' | 'title' | 'bullet' | 'numbered' | 'tag' | 'inset-image';

export type TagRole = 'program' | 'ui' | 'plan' | 'art' | 'fx';

export interface SidebarBlock {
  id: string;
  type: SidebarBlockType;
  text?: string;             // plain / title / bullet / numbered / tag(role 之外的扩展文本)
  role?: TagRole;            // tag 专用
  refPageId?: string;        // inset-image 专用,引用另一页 id
  refArtboardId?: string;    // inset-image 专用,可选；缺省=该 refPage 的 active 画板
}

export const TAG_COLORS: Record<TagRole, { label: string; bg: string; fg: string }> = {
  program: { label: '@程序', bg: '#74c7ec', fg: '#1e1e2e' },
  ui:      { label: '@UI',   bg: '#cba6f7', fg: '#1e1e2e' },
  plan:    { label: '@策划', bg: '#f9e2af', fg: '#1e1e2e' },
  art:     { label: '@美术', bg: '#f38ba8', fg: '#1e1e2e' },
  fx:      { label: '@特效', bg: '#a6e3a1', fg: '#1e1e2e' },
};

import { v4 as uuid } from 'uuid';
import type { PageData, Artboard, UINode, AnnotationNode, SidebarBlock } from '../types';
import { DEFAULT_PREVIEW_WIDTH, DEFAULT_PREVIEW_HEIGHT } from '../config/assetPaths';

/**
 * 旧 PageData 结构（迁移前）：顶层直接挂 nodes/rootIds/sourcePrefabPath/sidebar 等
 */
interface LegacyPageData {
  id: string;
  name: string;
  nodes?: Record<string, UINode>;
  rootIds?: string[];
  sourcePrefabPath?: string | null;
  sidebar?: SidebarBlock[];
  sidebarEnabled?: boolean;
  annotations?: Record<string, AnnotationNode>;
  annotationRootIds?: string[];
  pageGroup?: string;
}

function isLegacyPage(p: any): p is LegacyPageData {
  // 旧格式判定：有顶层 nodes 字段，没有 artboards 字段
  return p && typeof p === 'object' && p.nodes !== undefined && p.artboards === undefined;
}

function deriveArtboardName(legacy: LegacyPageData): string {
  if (legacy.sourcePrefabPath) {
    const m = legacy.sourcePrefabPath.match(/([^/\\]+?)(\.prefab)?$/i);
    if (m && m[1]) return m[1];
  }
  if (legacy.name) return legacy.name;
  return '画板 1';
}

/**
 * 把旧 PageData 迁移成新 PageData（含 artboards）。
 * 幂等：已经是新格式直接返回原对象。
 */
export function migratePage(
  page: any,
  defaultWidth = DEFAULT_PREVIEW_WIDTH,
  defaultHeight = DEFAULT_PREVIEW_HEIGHT,
): PageData {
  if (!isLegacyPage(page)) {
    return page as PageData;
  }

  const artboardId = uuid();
  const artboard: Artboard = {
    id: artboardId,
    name: deriveArtboardName(page),
    x: 0,
    y: 0,
    width: defaultWidth,
    height: defaultHeight,
    nodes: page.nodes ?? {},
    rootIds: page.rootIds ?? [],
    sourcePrefabPath: page.sourcePrefabPath ?? null,
    sidebar: page.sidebar,
    sidebarEnabled: page.sidebarEnabled,
  };

  const next: PageData = {
    id: page.id,
    name: page.name,
    artboards: [artboard],
    activeArtboardId: artboardId,
    annotations: page.annotations,
    annotationRootIds: page.annotationRootIds,
    pageGroup: page.pageGroup,
  };
  return next;
}

export function migratePages(
  pages: any[],
  defaultWidth = DEFAULT_PREVIEW_WIDTH,
  defaultHeight = DEFAULT_PREVIEW_HEIGHT,
): PageData[] {
  if (!Array.isArray(pages)) return [];
  return pages.map((page) => migratePage(page, defaultWidth, defaultHeight));
}

/**
 * 工具：在一个 PageData 里取 active 画板（若不存在则取第一个，仍不存在则抛错）。
 * 调用方应当先用 migratePage 确保 page 是新格式。
 */
export function getActiveArtboard(page: PageData): Artboard {
  const a = page.artboards.find((x) => x.id === page.activeArtboardId);
  if (a) return a;
  if (page.artboards.length > 0) return page.artboards[0];
  throw new Error(`Page ${page.id} 没有任何画板`);
}

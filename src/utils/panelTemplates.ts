import type { StructNode } from './importStructure';

// ──────── AI 结构化描述类型 ────────

export interface AIGenerateResult {
  panelName: string;
  template: 'rows' | 'tabs_list' | 'info' | 'grid';
  title: string;
  size: 'small' | 'medium' | 'large';

  // rows
  summary?: { lines: string[]; hasAvatar?: boolean };
  rows?: Array<{
    label: string;
    hasProgress?: boolean;
    progressText?: string;
    grade?: string;
    buttonText?: string;
    buttonStyle?: 'blue' | 'yellow' | 'red';
  }>;

  // tabs_list
  tabs?: string[];
  cellFields?: string[];
  cellHasItems?: boolean;
  cellItemCount?: number;
  cellButtonText?: string;
  sampleRows?: Array<Record<string, string>>;

  // info
  description?: string;
  buttons?: Array<{ text: string; style?: 'blue' | 'yellow' | 'red' }>;

  // grid
  gridColumns?: number;
  gridItemType?: string;
  gridItemCount?: number;
  gridHasTabs?: boolean;
  gridTabs?: string[];
}

// ──────── 面板尺寸 ────────

const PANEL_SIZES: Record<string, [number, number]> = {
  small:  [820, 520],
  medium: [1000, 600],
  large:  [1200, 700],
};

const MARGIN = 24;
const TAB_HEIGHT = 50;
const ROW_HEIGHT = 78;
const ROW_GAP = 6;
const CELL_HEIGHT = 160;
const TITLE_Y = 14;
const TITLE_H = 36;
const CONTENT_START_Y = 60;

// ──────── 按钮组件映射 ────────

function btnRef(style?: string): string {
  switch (style) {
    case 'yellow': return 'Part_Btn_Yellow';
    case 'red':    return 'Part_Btn_Red';
    default:       return 'Part_Btn_Blue';
  }
}

// ──────── 公共骨架 ────────

function makeSkeleton(_name: string, title: string, pw: number, ph: number): StructNode[] {
  return [
    { name: 'img_Bg', type: 'image', x: 0, y: 0, width: pw, height: ph },
    { name: 'txt_title', type: 'text', x: Math.round((pw - 300) / 2), y: TITLE_Y, width: 300, height: TITLE_H, text: title },
    { name: '@Part_CloseBg', type: 'component', componentRef: 'Part_CloseBg', x: pw - 66, y: 6, width: 60, height: 60 },
  ];
}

// ──────── rows 模板 ────────

function buildRowsPanel(r: AIGenerateResult, pw: number, ph: number): StructNode {
  const children = makeSkeleton(r.panelName, r.title, pw, ph);
  const contentW = pw - MARGIN * 2;
  let curY = CONTENT_START_Y;

  // 概要区
  if (r.summary) {
    const sumH = 100;
    const sumChildren: StructNode[] = [
      { name: 'img_summaryBg', type: 'image', x: 0, y: 0, width: contentW, height: sumH },
    ];
    let lineX = 16;
    if (r.summary.hasAvatar) {
      sumChildren.push({ name: '@Part_UserHead', type: 'component', componentRef: 'Part_UserHead', x: 16, y: 12, width: 76, height: 76 });
      lineX = 108;
    }
    r.summary.lines.forEach((text, i) => {
      sumChildren.push({ name: `txt_line${i + 1}`, type: 'text', x: lineX, y: 14 + i * 32, width: 300, height: 28, text });
    });
    children.push({ name: 'Ctn_Summary', type: 'frame', x: MARGIN, y: curY, width: contentW, height: sumH, children: sumChildren });
    curY += sumH + 12;
  }

  // 行列区
  if (r.rows && r.rows.length > 0) {
    const listH = r.rows.length * ROW_HEIGHT + (r.rows.length - 1) * ROW_GAP;
    const rowChildren: StructNode[] = [];

    r.rows.forEach((row, i) => {
      const ry = i * (ROW_HEIGHT + ROW_GAP);
      const rc: StructNode[] = [];

      rc.push({ name: 'txt_label', type: 'text', x: 0, y: 0, width: 160, height: 26, text: row.label });

      if (row.grade) {
        rc.push({ name: 'txt_grade', type: 'text', x: contentW - 160, y: 0, width: 50, height: 26, text: row.grade });
      }

      if (row.hasProgress) {
        const progressW = contentW - 180;
        rc.push({ name: 'img_progressBg', type: 'image', x: 0, y: 32, width: progressW, height: 26 });
        rc.push({ name: 'img_progressFill', type: 'image', x: 0, y: 32, width: Math.round(progressW * 0.6), height: 26 });
        rc.push({ name: 'txt_progressValue', type: 'text', x: Math.round(progressW / 2 - 60), y: 34, width: 120, height: 22, text: row.progressText || '' });
      }

      if (row.buttonText) {
        const ref = btnRef(row.buttonStyle);
        rc.push({
          name: `@${ref}`, type: 'component', componentRef: ref,
          x: contentW - 130, y: 8, width: 120, height: 50,
          text: row.buttonText,
        });
      }

      rowChildren.push({ name: `Ctn_Row_${i}`, type: 'frame', x: 0, y: ry, width: contentW, height: ROW_HEIGHT, children: rc });
    });

    children.push({ name: 'Ctn_List', type: 'frame', x: MARGIN, y: curY, width: contentW, height: listH, children: rowChildren });
  }

  return { name: r.panelName, width: pw, height: ph, children };
}

// ──────── tabs_list 模板 ────────

function buildTabsListPanel(r: AIGenerateResult, pw: number, ph: number): StructNode {
  const children = makeSkeleton(r.panelName, r.title, pw, ph);
  const tabMargin = 40;
  const contentW = pw - tabMargin * 2;

  // Tab 栏
  const tabNames = r.tabs || ['Tab1', 'Tab2'];
  const tabW = Math.round(contentW / tabNames.length);
  const tabChildren: StructNode[] = tabNames.map((name, i) => ({
    name: `btn_Tab${i + 1}`, type: 'button' as const,
    x: i * tabW, y: 0, width: tabW, height: TAB_HEIGHT,
    children: [
      { name: 'img_tabBg', type: 'image' as const, x: 0, y: 0, width: tabW, height: TAB_HEIGHT },
      { name: 'txt_tabName', type: 'text' as const, x: 12, y: 10, width: tabW - 24, height: 30, text: name },
    ],
  }));
  children.push({ name: 'Ctn_Tabs', type: 'frame', x: tabMargin, y: 80, width: contentW, height: TAB_HEIGHT, children: tabChildren });

  // ScrollView + Cell
  const svY = 80 + TAB_HEIGHT + 10;
  const svH = ph - svY - 20;
  const cellW = contentW - 20;

  const cellChildren: StructNode[] = [
    { name: 'img_cellBg', type: 'image', x: 0, y: 0, width: cellW, height: CELL_HEIGHT },
  ];

  // Cell 内的文字字段
  const fields = r.cellFields || ['description'];
  let fieldY = 10;
  fields.forEach((key) => {
    const sampleText = r.sampleRows?.[0]?.[key] || key;
    cellChildren.push({ name: `txt_${key}`, type: 'text', x: 15, y: fieldY, width: 500, height: 30, text: sampleText });
    fieldY += 35;
  });

  // Cell 内的物品列表
  if (r.cellHasItems) {
    const itemCount = r.cellItemCount || 3;
    const itemChildren: StructNode[] = [];
    for (let i = 0; i < itemCount; i++) {
      itemChildren.push({
        name: '@Part_Item', type: 'component', componentRef: 'Part_Item',
        x: i * 110, y: 0, width: 95, height: 95,
      });
    }
    cellChildren.push({ name: 'Ctn_Items', type: 'frame', x: 15, y: fieldY, width: itemCount * 110, height: 100, children: itemChildren });
  }

  // Cell 内的操作按钮
  if (r.cellButtonText) {
    cellChildren.push({
      name: '@Part_Btn_Yellow', type: 'component', componentRef: 'Part_Btn_Yellow',
      x: cellW - 180, y: CELL_HEIGHT - 70, width: 160, height: 55,
      text: r.cellButtonText,
    });
  }

  const cell: StructNode = { name: 'Cell', type: 'frame', x: 10, y: 0, width: cellW, height: CELL_HEIGHT, children: cellChildren };
  children.push({ name: 'ScrollView', type: 'scrollview', x: tabMargin, y: svY, width: contentW, height: svH, children: [cell] });

  return { name: r.panelName, width: pw, height: ph, children };
}

// ──────── info 模板 ────────

function buildInfoPanel(r: AIGenerateResult, pw: number, ph: number): StructNode {
  const children = makeSkeleton(r.panelName, r.title, pw, ph);
  const contentW = pw - MARGIN * 2;

  // 描述文本
  if (r.description) {
    const descH = Math.min(ph - 200, Math.max(80, Math.ceil(r.description.length / 20) * 30));
    children.push({ name: 'txt_desc', type: 'text', x: MARGIN, y: CONTENT_START_Y, width: contentW, height: descH, text: r.description });
  }

  // 按钮区
  const btns = r.buttons || [{ text: '确认', style: 'blue' }];
  const btnW = 200;
  const btnH = 60;
  const btnGap = 20;
  const totalBtnW = btns.length * btnW + (btns.length - 1) * btnGap;
  const btnStartX = Math.round((pw - totalBtnW) / 2);
  const btnY = ph - 90;

  const btnChildren: StructNode[] = btns.map((btn, i) => {
    const ref = btnRef(btn.style);
    return {
      name: `@${ref}`, type: 'component' as const, componentRef: ref,
      x: i * (btnW + btnGap), y: 0, width: btnW, height: btnH,
      text: btn.text,
    };
  });
  children.push({ name: 'Ctn_Buttons', type: 'frame', x: btnStartX, y: btnY, width: totalBtnW, height: btnH, children: btnChildren });

  return { name: r.panelName, width: pw, height: ph, children };
}

// ──────── grid 模板 ────────

function buildGridPanel(r: AIGenerateResult, pw: number, ph: number): StructNode {
  const children = makeSkeleton(r.panelName, r.title, pw, ph);
  const tabMargin = 40;
  const contentW = pw - tabMargin * 2;
  let svY = 80;

  // 可选 tab 栏
  if (r.gridHasTabs && r.gridTabs && r.gridTabs.length > 0) {
    const tabW = Math.round(contentW / r.gridTabs.length);
    const tabChildren: StructNode[] = r.gridTabs.map((name, i) => ({
      name: `btn_Tab${i + 1}`, type: 'button' as const,
      x: i * tabW, y: 0, width: tabW, height: TAB_HEIGHT,
      children: [
        { name: 'img_tabBg', type: 'image' as const, x: 0, y: 0, width: tabW, height: TAB_HEIGHT },
        { name: 'txt_tabName', type: 'text' as const, x: 12, y: 10, width: tabW - 24, height: 30, text: name },
      ],
    }));
    children.push({ name: 'Ctn_Tabs', type: 'frame', x: tabMargin, y: 80, width: contentW, height: TAB_HEIGHT, children: tabChildren });
    svY = 80 + TAB_HEIGHT + 10;
  }

  // ScrollView + 网格 Cell
  const svH = ph - svY - 20;
  const cols = r.gridColumns || 5;
  const itemType = r.gridItemType || 'Part_Item';

  // 根据物品类型决定尺寸
  const itemSizes: Record<string, [number, number]> = {
    Part_Item: [100, 100],
    Part_HeroCard: [120, 160],
    Part_Equip: [100, 100],
    Part_Hero: [120, 150],
  };
  const [iw, ih] = itemSizes[itemType] || [100, 100];
  const gap = 10;
  const cellW = contentW - 20;
  const cellH = ih + gap;

  // 一行 = 一个 Cell
  const cellItems: StructNode[] = [];
  for (let c = 0; c < cols; c++) {
    cellItems.push({
      name: `@${itemType}`, type: 'component', componentRef: itemType,
      x: c * (iw + gap), y: 0, width: iw, height: ih,
    });
  }
  const cell: StructNode = { name: 'Cell', type: 'frame', x: 10, y: 0, width: cellW, height: cellH, children: cellItems };
  children.push({ name: 'ScrollView', type: 'scrollview', x: tabMargin, y: svY, width: contentW, height: svH, children: [cell] });

  return { name: r.panelName, width: pw, height: ph, children };
}

// ──────── 主入口 ────────

export function buildPanelFromAI(result: AIGenerateResult): StructNode {
  const [pw, ph] = PANEL_SIZES[result.size] || PANEL_SIZES.medium;

  switch (result.template) {
    case 'rows':      return buildRowsPanel(result, pw, ph);
    case 'tabs_list': return buildTabsListPanel(result, pw, ph);
    case 'info':      return buildInfoPanel(result, pw, ph);
    case 'grid':      return buildGridPanel(result, pw, ph);
    default:          return buildRowsPanel(result, pw, ph);
  }
}

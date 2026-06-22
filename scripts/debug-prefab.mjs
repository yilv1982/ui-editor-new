// 测试脚本：详细检查单个 prefab 的解析结果
// 用法: node scripts/debug-prefab.mjs [prefab名]
// 需要先启动 dev server: npm run dev

const name = process.argv[2] || 'ActivityPanel_10006';
const BASE = 'http://localhost:3012';

try {
  const r = await fetch(`${BASE}/api/prefabs/parse?path=Activity/${name}.prefab&name=${name}`);
  const j = await r.json();

  if (!j.root) {
    console.log('解析失败:', j.error || '无 root');
    process.exit(1);
  }

  console.log(`=== ${j.name} ===`);
  console.log(`源路径: ${j.sourcePath}\n`);

  let totalNodes = 0;
  let issues = [];

  function printNode(n, depth = 0) {
    totalNodes++;
    const indent = '  '.repeat(depth);
    const size = `${n.width}x${n.height}`;
    const pos = `(${n.x},${n.y})`;
    let info = `${indent}${n.name} [${n.type}] ${pos} ${size}`;

    // 标记问题
    if (n.width <= 0 || n.height <= 0) { info += ' ⚠️宽高<=0'; issues.push(`${n.name}: 宽高异常 ${size}`); }
    if (Math.abs(n.x) > 2000 || Math.abs(n.y) > 2000) { info += ' ⚠️位置异常'; issues.push(`${n.name}: 位置异常 ${pos}`); }
    if (n.type === 'image' && !n.imagePath) { info += ' ⚠️无图片'; issues.push(`${n.name}: image类型但无imagePath`); }
    if (n.type === 'text' && n.text) info += ` "${n.text.substring(0, 20)}"`;
    if (n.type === 'image' && n.imagePath) info += ` img:${n.imagePath.split('/').pop()}`;
    if (n.type === 'component') info += ` @${n.componentRef}`;
    if (n.type === 'button') info += ' [BTN]';
    if (n.type === 'scrollview') info += ` [SCROLL:${n.scrollDirection}]`;
    if (n.isMask) info += ` [${n.maskType}]`;
    if (n.anchorMin) info += ` anchor:(${n.anchorMin.x},${n.anchorMin.y})-(${n.anchorMax.x},${n.anchorMax.y})`;

    console.log(info);

    if (n.children) {
      for (const child of n.children) {
        printNode(child, depth + 1);
      }
    }
  }

  printNode(j.root);

  console.log(`\n=== 统计 ===`);
  console.log(`总节点数: ${totalNodes}`);
  console.log(`问题数: ${issues.length}`);
  if (issues.length > 0) {
    console.log('\n=== 问题清单 ===');
    issues.forEach(i => console.log(`  - ${i}`));
  }
} catch (e) {
  console.error('请求失败 (确保 dev server 已启动):', e.message);
}

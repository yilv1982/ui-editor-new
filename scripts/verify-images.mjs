const BASE = 'http://localhost:3012';
const listRes = await fetch(`${BASE}/api/prefabs/list`);
const list = await listRes.json();

const allPaths = new Set();
const missingPaths = new Set();
let totalImg = 0, foundImg = 0;

for (const p of list) {
  const r = await fetch(`${BASE}/api/prefabs/parse?name=${encodeURIComponent(p.name)}`);
  const j = await r.json();
  if (!j.root) continue;

  function collect(n) {
    if (n.type === 'image' && n.imagePath) {
      totalImg++;
      allPaths.add(n.imagePath);
    }
    (n.children || []).forEach(collect);
  }
  collect(j.root);
}

// 检查每个路径是否能通过 atlas-file 访问到
for (const p of allPaths) {
  try {
    const r = await fetch(`${BASE}/atlas-file/${p}`, { method: 'HEAD' });
    if (r.ok) {
      foundImg++;
    } else {
      missingPaths.add(p);
    }
  } catch {
    missingPaths.add(p);
  }
}

console.log(`=== 图片资源验证 ===`);
console.log(`引用图片总数: ${totalImg}`);
console.log(`不重复路径数: ${allPaths.size}`);
console.log(`能找到: ${foundImg}/${allPaths.size}`);
console.log(`缺失: ${missingPaths.size}`);
if (missingPaths.size > 0) {
  console.log(`\n缺失列表:`);
  for (const p of missingPaths) console.log(`  ${p}`);
}

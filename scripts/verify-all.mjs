const BASE = 'http://localhost:3017';
const listRes = await fetch(`${BASE}/api/prefabs/list`);
const list = await listRes.json();
let totalImg=0, foundImg=0, totalComp=0, totalTxt=0, foundTxt=0;
for (const p of list) {
  const r = await fetch(`${BASE}/api/prefabs/parse?name=${encodeURIComponent(p.name)}`);
  const j = await r.json();
  if (!j.root) continue;
  let pComp=0;
  function check(n) {
    if (n.type === 'image') { totalImg++; if (n.imagePath) foundImg++; }
    if (n.type === 'component') { totalComp++; pComp++; }
    if (n.type === 'text') { totalTxt++; if (n.text) foundTxt++; }
    (n.children || []).forEach(check);
  }
  check(j.root);
  if (pComp > 0) console.log(`  ${p.name}: ${pComp} 个组件`);
}
console.log(`\n=== 总结 ===`);
console.log(`图片: ${foundImg}/${totalImg} (${(foundImg/totalImg*100).toFixed(1)}%)`);
console.log(`组件: ${totalComp} 个 CommonPart`);
console.log(`文本: ${foundTxt}/${totalTxt}`);

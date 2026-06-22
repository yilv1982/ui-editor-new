const BASE = 'http://localhost:3022';
const listRes = await fetch(`${BASE}/api/prefabs/list`);
const list = await listRes.json();
let issues = [];
for (const p of list) {
  const r = await fetch(`${BASE}/api/prefabs/parse?name=${encodeURIComponent(p.name)}`);
  const j = await r.json();
  if (!j.root) continue;
  let nodeIssues = [];
  function check(n, parentW = 1920, parentH = 1080) {
    const outLeft = n.x < -parentW * 0.5;
    const outRight = n.x > parentW * 1.5;
    const outTop = n.y < -parentH * 0.5;
    const outBottom = n.y > parentH * 1.5;
    const tooSmall = (n.width <= 1 || n.height <= 1) && n.type !== 'component';
    if (outLeft || outRight || outTop || outBottom || tooSmall) {
      nodeIssues.push(`${n.type} "${n.name}" x:${Math.round(n.x)} y:${Math.round(n.y)} w:${Math.round(n.width)} h:${Math.round(n.height)} [${[outLeft&&'L',outRight&&'R',outTop&&'T',outBottom&&'B',tooSmall&&'S'].filter(Boolean)}]`);
    }
    (n.children || []).forEach(c => check(c, n.width || parentW, n.height || parentH));
  }
  check(j.root);
  if (nodeIssues.length > 0) issues.push({ prefab: p.name, count: nodeIssues.length });
}
console.log(`有问题: ${issues.length}/${list.length}`);
issues.slice(0, 10).forEach(i => console.log(`  ${i.prefab}: ${i.count}`));

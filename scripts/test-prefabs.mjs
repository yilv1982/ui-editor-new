const BASE = 'http://localhost:3012';
const listRes = await fetch(`${BASE}/api/prefabs/list`);
const list = await listRes.json();

let ok = 0, fail = 0, noImgList = [], badPosList = [];

for (const p of list) {
  try {
    const r = await fetch(`${BASE}/api/prefabs/parse?name=${encodeURIComponent(p.name)}`);
    const j = await r.json();
    if (!j.root) { fail++; continue; }

    let imgCount = 0, imgOk = 0, txtCount = 0, txtOk = 0;
    let badPos = false;

    function check(n, depth = 0) {
      if (n.type === 'image') {
        imgCount++;
        if (n.imagePath) imgOk++;
      }
      if (n.type === 'text') {
        txtCount++;
        if (n.text && n.text.indexOf('\\u') === -1) txtOk++;
      }
      if (n.x < -2000 || n.y < -2000 || n.x > 3000 || n.y > 3000) badPos = true;
      (n.children || []).forEach(c => check(c, depth + 1));
    }
    check(j.root);

    const imgIssue = imgCount > 0 && imgOk === 0;
    if (imgIssue) noImgList.push(p.name);
    if (badPos) badPosList.push(p.name);

    const flag = imgIssue ? 'X' : 'V';
    console.log(`${flag} ${p.name.padEnd(40)} img:${imgOk}/${imgCount}  txt:${txtOk}/${txtCount}  pos:${badPos ? 'BAD' : 'ok'}`);
    ok++;
  } catch (e) {
    fail++;
    console.log(`! ${p.name}: ${e.message}`);
  }
}

console.log('\n=== SUMMARY ===');
console.log(`Total: ${list.length}, Parsed: ${ok}, Failed: ${fail}`);
console.log(`No image path: ${noImgList.length} → ${noImgList.slice(0, 10).join(', ')}`);
console.log(`Bad position: ${badPosList.length} → ${badPosList.slice(0, 10).join(', ')}`);

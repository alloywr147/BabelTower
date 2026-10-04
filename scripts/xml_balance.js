// 标签配平检查:node scripts/xml_balance.js <file...>
const fs = require('fs');

for (const f of process.argv.slice(2)) {
  const s = fs.readFileSync(f, 'utf8');
  // 注释里可能含字面 <HTML>(本项目就有),必须先剔除并保留换行以保住行号
  const body = s.replace(/<!--[\s\S]*?-->/g, mm => '\n'.repeat((mm.match(/\n/g) || []).length));
  const stack = [];
  let err = null;
  let errAt = -1;
  let line = 0;
  for (const m of body.matchAll(/<(\/?)([A-Za-z_][\w:-]*)([^>]*?)(\/?)>/g)) {
    if (m[4] === '/') continue;
    if (m[1] === '/') {
      const top = stack.pop();
      if (top !== m[2]) { err = '</' + m[2] + '> but open <' + top + '>'; errAt = m.index; break; }
    } else {
      stack.push(m[2]);
    }
  }
  if (err) line = s.slice(0, errAt).split('\n').length;
  console.log(f + ': ok=' + (!err && stack.length === 0) +
    (err ? '  err(line ' + line + '): ' + err : '') +
    (stack.length ? '  leftover=' + JSON.stringify(stack) : ''));
  if (err) {
    const start = Math.max(0, errAt - 200);
    console.log('  context: ' + JSON.stringify(s.slice(start, errAt + 120)));
  }
}

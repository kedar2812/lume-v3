const fs = require('fs');
const scenes = { Goals: 'goals set', Spend: 'spend set', LogCall: 'choosing how it went', Filters: 'choosing filters' };
for (const b of Object.keys(scenes)) {
  const html = fs.readFileSync(`../project/${b}.dc.html`, 'utf8').split('<script type="text/x-dc"')[0];
  const loopVars = new Set([...html.matchAll(/as="(\w+)"/g)].map((m) => m[1]).concat(['$index', 'true', 'false']));
  const holes = new Set([...html.matchAll(/\{\{\s*([\w$]+)(?:\.[\w.]+)?\s*\}\}/g)].map((m) => m[1]).filter((h) => !loopVars.has(h)));
  const { Component } = require(`./${b}.logic.js`);
  const keys = new Set(Object.keys(new Component({ theme: 'porcelain', scene: scenes[b] }).renderVals()));
  const missing = [...holes].filter((h) => !keys.has(h));
  console.log(b, missing.length ? 'MISSING ' + missing.join(' ') : 'all holes filled');
}

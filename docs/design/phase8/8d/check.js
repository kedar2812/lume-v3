const boards = { Goals: ['goals set', 'first time'], Spend: ['spend set', 'typing a new spend', 'nothing set yet'], LogCall: ['choosing how it went', 'back from a call', 'logged'], Filters: ['choosing filters', 'filters applied', 'range too long for tags'] };
for (const [b, scenes] of Object.entries(boards)) {
  const { Component } = require(`./${b}.logic.js`);
  for (const theme of ['porcelain', 'obsidian']) for (const scene of scenes) {
    const c = new Component({ theme, scene });
    let v = c.renderVals();
    // press every handler once, then render again
    const fire = (o) => { for (const [k, f] of Object.entries(o)) { if (typeof f === 'function') { try { f({ target: { value: '123456' } }); } catch (e) { console.log('HANDLER FAIL', b, scene, k, e.message); } v = c.renderVals(); } else if (Array.isArray(f)) f.slice(0, 2).forEach((x) => x && typeof x === 'object' && fire(x)); } };
    fire(v);
    const und = JSON.stringify(v, (k, x) => (x === undefined ? '__UNDEF__' : typeof x === 'number' && !Number.isFinite(x) ? '__NAN__' : x));
    if (/__UNDEF__|__NAN__|NaN|undefined/.test(und)) console.log('BAD VALUE', b, scene, (und.match(/"[^"]+":"?(__UNDEF__|__NAN__)|[^"]{0,30}(NaN|undefined)[^"]{0,20}/g) || []).slice(0, 5));
  }
  console.log('ok', b);
}

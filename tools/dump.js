'use strict';
// 生成結果を文字で確認する開発用ツール: node tools/dump.js "F G Em Am" douga 12345
const C = require('../src/composer.js');
const T = require('../src/theory.js');

const chords = process.argv[2] || 'F G Em Am';
const mood = process.argv[3] || 'douga';
const seed = +(process.argv[4] || 12345);
const r = C.compose({ chords, mood, seed });
if (r.errors) {
  console.log('errors', r.errors);
  process.exit(1);
}
console.log(r.keyName, JSON.stringify(r.metrics));
r.thoughts.forEach((t) => console.log(' -', t.k, ':', t.t));
console.log('stages', [1, 2, 3, 4, 5].map((i) => r.stages[i].length).join(' / '), 'gaps', r.gaps.length, 'breaks', r.breaks.length);
const nm = (p) => T.midiName(p);
const main = r.notes.filter((n) => n.l === 'top' && !n.h);
const bass = r.notes.filter((n) => n.l === 'bass' && !n.h);
const bs = r.barSteps;
for (let b = 0; b < Math.min(r.bars, 8); b++) {
  const inBar = (n) => n.s >= b * bs && n.s < (b + 1) * bs;
  console.log('bar', b + 1, r.regions.filter((x) => x.start >= b * bs && x.start < (b + 1) * bs).map((x) => `${x.name}(${x.scale})`).join(', '));
  console.log('  top :', main.filter(inBar).map((n) => `${n.s - b * bs}:${nm(n.p)}/${n.d}`).join(' '));
  console.log('  bass:', bass.filter(inBar).map((n) => `${n.s - b * bs}:${nm(n.p)}/${n.d}`).join(' '));
  const counts = {};
  r.notes.filter(inBar).forEach((n) => { counts[n.l] = (counts[n.l] || 0) + 1; });
  console.log('  parts', JSON.stringify(counts), 'total', r.notes.filter(inBar).length);
}

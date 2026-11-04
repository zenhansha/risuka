'use strict';
const test = require('node:test');
const assert = require('node:assert');
const T = require('../src/theory.js');
const C = require('../src/composer.js');

const PROGRESSIONS = [
  'F G Em Am',
  'Am F G C',
  'C G/B Am Em/G | F C/E Dm7 G7',
  'FM7 E7 Am7 C7 | FM7 E7 Am7 Gm7 C7',
  'Dm7 G7 CM7 A7',
  'C#m7 F#7 BM7 G#7(b9)',
  'Ebm Cb Gb Db',
  'Bm7b5 E7 Am7 D7 GM7 C#m7b5 F#7 Bm',
];

// ---------------------------------------------------------------- theory
test('コード記号の解析', () => {
  const cases = [
    ['C', [0, 4, 7]],
    ['Cm', [0, 3, 7]],
    ['C7', [0, 4, 7, 10]],
    ['CM7', [0, 4, 7, 11]],
    ['Cmaj7', [0, 4, 7, 11]],
    ['C△7', [0, 4, 7, 11]],
    ['C△', [0, 4, 7, 11]],
    ['Cm7', [0, 3, 7, 10]],
    ['CmM7', [0, 3, 7, 11]],
    ['Cm7b5', [0, 3, 6, 10]],
    ['Cm7(b5)', [0, 3, 6, 10]],
    ['Cø', [0, 3, 6, 10]],
    ['Cdim', [0, 3, 6]],
    ['Cdim7', [0, 3, 6, 9]],
    ['Caug', [0, 4, 8]],
    ['C+', [0, 4, 8]],
    ['Csus4', [0, 5, 7]],
    ['Csus2', [0, 2, 7]],
    ['C7sus4', [0, 5, 7, 10]],
    ['Cadd9', [0, 2, 4, 7]],
    ['C6', [0, 4, 7, 9]],
    ['Cm6', [0, 3, 7, 9]],
    ['C69', [0, 2, 4, 7, 9]],
    ['C9', [0, 2, 4, 7, 10]],
    ['CM9', [0, 2, 4, 7, 11]],
    ['Cm9', [0, 2, 3, 7, 10]],
    ['C7b9', [0, 1, 4, 7, 10]],
    ['C7(#9)', [0, 3, 4, 7, 10]],
    ['C7(b9,13)', [0, 1, 4, 7, 9, 10]],
    ['C7#11', [0, 4, 6, 7, 10]],
    ['C5', [0, 7]],
  ];
  for (const [sym, want] of cases) {
    const c = T.parseChord(sym);
    assert.ok(c, sym + ' を解析できない');
    assert.deepStrictEqual(c.pcs.slice().sort((a, b) => a - b), want, sym);
  }
});

test('全角やスラッシュ、変化記号も読める', () => {
  assert.strictEqual(T.parseChord('Ｆ#ｍ７').root, 6);
  assert.deepStrictEqual(T.parseChord('Ｆ#ｍ７').pcs.slice().sort((a, b) => a - b), [1, 4, 6, 9]);
  const g = T.parseChord('G/B');
  assert.strictEqual(g.bass, 11);
  assert.strictEqual(g.root, 7);
  assert.strictEqual(T.parseChord('E♭M7').root, 3);
  assert.strictEqual(T.parseChord('hoge'), null);
});

test('進行の書式(小節線・拍指定・伸ばし・繰り返し・ローマ数字)', () => {
  let p = T.parseProgression('F G Em Am');
  assert.strictEqual(p.bars, 4);
  assert.deepStrictEqual(p.regions.map((r) => r.end - r.start), [16, 16, 16, 16]);

  p = T.parseProgression('F G | Em Am');
  assert.strictEqual(p.srcBars, 2);
  assert.strictEqual(p.bars, 4, '4小節に満たないので繰り返す');
  assert.deepStrictEqual(p.regions.slice(0, 2).map((r) => r.end - r.start), [8, 8]);

  p = T.parseProgression('C:3 G:1 | Am - F -');
  assert.deepStrictEqual(p.regions.slice(0, 4).map((r) => r.end - r.start), [12, 4, 8, 8]);

  p = T.parseProgression('C | % | F | G');
  assert.strictEqual(p.regions[0].end - p.regions[0].start, 32, '同じコードは結合される');

  p = T.parseProgression('IV V iii vi', { keyHint: 0 });
  assert.deepStrictEqual(p.regions.map((r) => r.chord.name), ['F', 'G', 'Em', 'Am']);

  p = T.parseProgression('F→G→Em→Am');
  assert.strictEqual(p.regions.length, 4);

  p = T.parseProgression('C7(b9, 13) F');
  assert.strictEqual(p.errors.length, 0);
  assert.strictEqual(p.srcBars, 2);

  p = T.parseProgression('Cx7 G');
  assert.deepStrictEqual(p.errors, ['Cx7']);
});

test('キー判定', () => {
  const key = (s) => {
    const k = T.detectKey(T.parseProgression(s).regions);
    return k.tonic + ':' + k.mode;
  };
  assert.strictEqual(key('C G Am F'), '0:major');
  assert.strictEqual(key('Dm7 G7 CM7 Am7'), '0:major');
  assert.strictEqual(key('Am F C G Am'), '9:minor');
  assert.strictEqual(key('F G Em Am'), '9:minor');
  assert.strictEqual(key('Bm G D A'), '11:minor');
  assert.strictEqual(key('Eb Bb Cm Ab'), '3:major');
});

test('コードスケール: ダイアトニック', () => {
  const key = { tonic: 0, mode: 'major', scale: T.MAJOR };
  const an = (sym, next) => T.analyzeChord(T.parseChord(sym), key, T.parseChord(next || 'C'));
  assert.strictEqual(an('CM7').scaleId, 'ionian');
  assert.strictEqual(an('Dm7').scaleId, 'dorian');
  assert.strictEqual(an('Em7').scaleId, 'phrygian');
  assert.strictEqual(an('FM7').scaleId, 'lydian');
  assert.strictEqual(an('G7').scaleId, 'mixolydian');
  assert.strictEqual(an('Am7').scaleId, 'aeolian');
  assert.strictEqual(an('Bm7b5').scaleId, 'locrian');
  // アボイド: CM7 の F、G7 の C、Em7 の F と C
  assert.ok(an('CM7').avoidSet.has(5));
  assert.ok(an('G7').avoidSet.has(0));
  assert.ok(an('Em7').avoidSet.has(5));
  assert.ok(an('Em7').avoidSet.has(0));
  assert.ok(an('FM7').avoidSet.size === 0, 'リディアンにアボイドなし');
});

test('コードスケール: ノンダイアトニック', () => {
  const key = { tonic: 0, mode: 'major', scale: T.MAJOR };
  const an = (sym, next) => T.analyzeChord(T.parseChord(sym), key, T.parseChord(next || 'C'));
  assert.strictEqual(an('E7', 'Am').scaleId, 'phrygianDominant', '短調へのセカンダリードミナント');
  assert.strictEqual(an('A7', 'D').scaleId, 'mixolydian', '長調へ解決');
  assert.strictEqual(an('Db7', 'C').scaleId, 'lydianDominant', '裏コード');
  assert.strictEqual(an('Bb7', 'C').scaleId, 'lydianDominant', '解決しないドミナント');
  assert.strictEqual(an('Fm').scaleId === 'aeolian' || an('Fm').scaleId === 'dorian', true);
  assert.strictEqual(an('G7alt').scaleId, 'altered');
  assert.strictEqual(an('AbM7').scaleId, 'lydian');
  // どんなコードでも、コードトーンは必ずスケールに含まれる
  for (const s of ['C7#9', 'Bbm6', 'Ddim7', 'Faug', 'AmM7', 'G7b13', 'Csus4', 'F#m7b5', 'E7(b9)', 'Ab69']) {
    const a = an(s);
    for (const pc of T.parseChord(s).pcs) assert.ok(a.scaleSet.has(pc), s + ' のコードトーンがスケールにない');
  }
});

// ---------------------------------------------------------------- composer
function allMoodRuns() {
  const out = [];
  for (const m of C.MOODS) {
    for (const prog of PROGRESSIONS) {
      for (let seed = 1; seed <= 3; seed++) {
        out.push({ m, prog, seed, r: C.compose({ chords: prog, mood: m.id, seed }) });
      }
    }
  }
  return out;
}
const RUNS = allMoodRuns();

test('全部の雰囲気・進行で生成でき、ノートが正しい形をしている', () => {
  for (const { r, prog, m } of RUNS) {
    assert.ok(!r.errors, prog + ' ' + m.id);
    assert.ok(r.notes.length > 20, `音が少なすぎる ${prog} ${m.id}: ${r.notes.length}`);
    for (const n of r.notes) {
      assert.ok(Number.isFinite(n.s) && n.s >= 0 && n.s < r.totalSteps, '開始位置 ' + JSON.stringify(n));
      assert.ok(n.d > 0, '長さ ' + JSON.stringify(n));
      assert.ok(n.p >= 21 && n.p <= 108, 'ピアノの音域外 ' + JSON.stringify(n));
      assert.ok(n.v >= 1 && n.v <= 127, 'ベロシティ');
    }
  }
});

test('16分グリッドに揃っている(32分フラリーのみ半ステップ可)', () => {
  for (const { r } of RUNS) {
    for (const n of r.notes) {
      const onGrid = Math.abs(n.s - Math.round(n.s)) < 1e-9;
      assert.ok(onGrid || n.f === 'flurry', 'グリッド外 ' + JSON.stringify(n));
    }
  }
});

test('同じ鍵盤の音が重ならない(MIDIで事故らない)', () => {
  for (const { r } of RUNS) {
    const by = {};
    for (const n of r.notes) (by[n.p] = by[n.p] || []).push(n);
    for (const list of Object.values(by)) {
      list.sort((a, b) => a.s - b.s);
      for (let i = 0; i + 1 < list.length; i++) {
        assert.ok(list[i].s + list[i].d <= list[i + 1].s + 1e-9, '重なり ' + JSON.stringify([list[i], list[i + 1]]));
      }
    }
  }
});

test('同じ入力・同じシードなら同じ結果(再現できる)', () => {
  const a = C.compose({ chords: 'F G Em Am', mood: 'douga', seed: 42 });
  const b = C.compose({ chords: 'F G Em Am', mood: 'douga', seed: 42 });
  assert.deepStrictEqual(a.notes, b.notes);
});

test('シードが違えば旋律が変わる(毎回決まった旋律にならない)', () => {
  for (const m of C.MOODS) {
    const fps = [];
    const tops = [];
    for (let seed = 100; seed < 112; seed++) {
      const r = C.compose({ chords: 'F G Em Am', mood: m.id, seed });
      fps.push(r.fingerprint);
      tops.push(JSON.stringify(r.notes.filter((n) => n.l === 'top' && !n.h).map((n) => [n.s, n.p])));
    }
    assert.strictEqual(new Set(tops).size, tops.length, m.id + ': 同じ旋律が出た');
    let sum = 0;
    let n = 0;
    for (let i = 0; i < fps.length; i++) {
      for (let j = i + 1; j < fps.length; j++) {
        sum += C.similarity(fps[i], fps[j]);
        n++;
      }
    }
    const mean = sum / n;
    assert.ok(mean < 0.35, `${m.id}: 旋律が似すぎ 平均類似度 ${mean.toFixed(2)}`);
  }
});

test('連続で生成しても、直前の旋律から離れる。しかもシードだけで再現できる', () => {
  let mem = [];
  let last = null;
  let totalWith = 0;
  for (let i = 0; i < 8; i++) {
    const r = C.composeNovel({ chords: 'C G Am F', mood: 'douga' }, mem);
    if (last) totalWith += C.similarity(r.fingerprint, last);
    last = r.fingerprint;
    mem = mem.concat([r.fingerprint]).slice(-6);
    // 共有URLの前提: シードを渡せば記憶がなくても同じものになる
    const again = C.compose({ chords: 'C G Am F', mood: 'douga', seed: r.seed });
    assert.deepStrictEqual(again.notes, r.notes);
  }
  assert.ok(totalWith / 7 < 0.2, '平均類似度 ' + (totalWith / 7).toFixed(3));
});

test('旋律が歌える: 順次進行と3度が多く、大跳躍は少ない', () => {
  let near = 0;
  let huge = 0;
  let total = 0;
  for (const { r } of RUNS) {
    const top = r.notes.filter((n) => n.l === 'top' && !n.h);
    for (let i = 1; i < top.length; i++) {
      const iv = Math.abs(top[i].p - top[i - 1].p);
      total++;
      if (iv <= 4) near++;
      if (iv > 12) huge++;
    }
  }
  assert.ok(near / total > 0.68, '順次+3度の割合 ' + (near / total).toFixed(3));
  assert.ok(huge / total < 0.02, '8度超の跳躍 ' + (huge / total).toFixed(3));
});

test('強拍の旋律がコードから外れない(超高精度の中核)', () => {
  let total = 0;
  let stable = 0;
  let avoid = 0;
  for (const { r } of RUNS) {
    total += r.metrics.strongTotal;
    stable += r.metrics.strongStableRatio * r.metrics.strongTotal;
    avoid += r.metrics.avoidStrong;
  }
  const ratio = stable / total;
  assert.ok(ratio > 0.97, '強拍の安定音率 ' + ratio.toFixed(3));
  assert.ok(avoid / total < 0.01, 'アボイドノート率 ' + (avoid / total).toFixed(4));
});

test('事故音(短9度の持続)がほとんど残らない', () => {
  let harsh = 0;
  let notes = 0;
  for (const { r } of RUNS) {
    harsh += r.metrics.harsh;
    notes += r.notes.length;
  }
  assert.ok(harsh / notes < 0.01, '事故音率 ' + (harsh / notes).toFixed(4));
});

test('コードの変わり目でベースがルート(スラッシュならその音)を鳴らす', () => {
  for (const { r, prog } of RUNS) {
    const parsed = T.parseProgression(prog);
    const bassNotes = r.notes.filter((n) => n.l === 'bass' || n.l === 'hit');
    for (const reg of parsed.regions) {
      if (reg.chord.rest) continue;
      if ((r.breaks || []).some((b) => reg.start >= b.start && reg.start < b.end)) continue;
      const near = bassNotes.filter((n) => n.s >= reg.start - 2 && n.s <= reg.start);
      const ok = near.some((n) => T.mod12(n.p) === reg.chord.bass);
      assert.ok(ok, `${prog}: ${reg.chord.name} の頭(step ${reg.start})にベースがない`);
    }
  }
});

test('動画のベロシティ設計: 内声は外声より弱い', () => {
  for (const { r, m } of RUNS) {
    const top = r.notes.filter((n) => n.l === 'top' && !n.h);
    const inner = r.notes.filter((n) => n.l === 'inner');
    if (!top.length || !inner.length) continue;
    const mean = (a) => a.reduce((x, y) => x + y.v, 0) / a.length;
    assert.ok(mean(top) > mean(inner) + 8, `${m.id}: top ${mean(top).toFixed(1)} inner ${mean(inner).toFixed(1)}`);
  }
  const r = C.compose({ chords: 'F G Em Am', mood: 'douga', seed: 7 });
  const outer = r.notes.filter((n) => n.l === 'top' && !n.h);
  const vs = outer.map((n) => n.v);
  assert.ok(Math.min(...vs) >= 80 && Math.max(...vs) <= 118, '動画準拠のレンジ ' + Math.min(...vs) + '-' + Math.max(...vs));
});

test('動画の工程: 3で飽和し、4で隙間を開けて音が減る', () => {
  let grew = 0;
  let cut = 0;
  let n = 0;
  for (const { r } of RUNS) {
    if (r.stages[3].length > r.stages[2].length) grew++;
    if (r.stages[4].length < r.stages[3].length) cut++;
    n++;
    assert.ok(r.gaps.length >= 1, '旋律の直前の隙間が1つもない');
  }
  assert.ok(grew / n > 0.98, '3で増えない ' + grew + '/' + n);
  assert.ok(cut / n > 0.98, '4で減らない ' + cut + '/' + n);
});

test('動画のコツ: 旋律の入りの直前は本当に無音(ベース以外)', () => {
  for (const { r } of RUNS) {
    for (const g of r.gaps) {
      const before = g.s - 1;
      const sounding = r.stages[4].filter((n) => n.l !== 'bass' && n.s < g.s && n.s + n.d > before + 1e-9 && n.s >= before - 16);
      assert.strictEqual(sounding.length, 0, '隙間に音が残っている step ' + g.s + ' ' + JSON.stringify(sounding.slice(0, 3)));
    }
  }
});

test('雰囲気で音数の傾向が変わる', () => {
  const mean = (id) => {
    const rs = RUNS.filter((x) => x.m.id === id);
    return rs.reduce((a, b) => a + b.r.metrics.notesPerBar, 0) / rs.length;
  };
  assert.ok(mean('bakuhatsu') > mean('douga'), '爆発 > 動画準拠');
  assert.ok(mean('douga') > mean('setsunai'), '動画準拠 > 切ない');
});

test('雰囲気で音域が変わる(きらきらは高く、ダークは低い)', () => {
  const centre = (id) => {
    const rs = RUNS.filter((x) => x.m.id === id);
    let sum = 0;
    let n = 0;
    for (const { r } of rs) for (const x of r.notes.filter((k) => k.l === 'top' && !k.h)) { sum += x.p; n++; }
    return sum / n;
  };
  assert.ok(centre('kirakira') > centre('douga') + 2, 'きらきら');
  assert.ok(centre('dark') < centre('douga') - 2, 'ダーク');
});

test('動機が反復する(でたらめな音の羅列にならない)', () => {
  const vals = RUNS.map((x) => x.r.metrics.motifRecurrence);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  assert.ok(mean > 0.3, '反復率 ' + mean.toFixed(2));
});

test('変拍子でも破綻しない', () => {
  for (const meter of ['3/4', '5/4', '6/8', '7/8']) {
    for (let seed = 1; seed <= 5; seed++) {
      const r = C.compose({ chords: 'Am F C G', mood: 'douga', seed, meter });
      assert.ok(!r.errors);
      assert.strictEqual(r.barSteps, T.METERS[meter].barSteps);
      assert.ok(r.notes.length > 15, meter);
      for (const n of r.notes) assert.ok(n.s < r.totalSteps);
    }
  }
});

test('N.C. の間は音を出さない(ブレイクを書ける)', () => {
  const r = C.compose({ chords: 'C | N.C. | F | G', mood: 'douga', seed: 3 });
  assert.ok(!r.errors);
  const inNC = r.notes.filter((n) => n.s >= 16 && n.s < 32);
  assert.ok(inNC.length === 0, 'N.C. に音が残っている: ' + JSON.stringify(inNC.slice(0, 4)));
});

test('解析できないコードは止まらずに教えてくれる', () => {
  const r = C.compose({ chords: 'C Xyz7 F', mood: 'douga', seed: 1 });
  assert.deepStrictEqual(r.errors, ['Xyz7']);
});

test('生成は対話に十分速い', () => {
  const t0 = Date.now();
  C.compose({ chords: 'F G Em Am C G/B Am Em/G F C Dm G F G Em Am', mood: 'bakuhatsu', seed: 9 });
  const ms = Date.now() - t0;
  assert.ok(ms < 1500, ms + 'ms');
});

// ---------------------------------------------------------------- MIDI / 固定
const Midi = require('../src/midi.js');

test('MIDIが規格どおりで、ノートが欠けずに読み戻せる', () => {
  const r = C.compose({ chords: 'F G Em Am', mood: 'douga', seed: 11 });
  const bytes = Midi.writeMidi(r, { bpm: 174 });
  const m = Midi.readMidi(bytes);
  assert.strictEqual(m.format, 1);
  assert.strictEqual(m.division, 480);
  assert.strictEqual(m.ntrks, 2);
  const ons = m.tracks[1].filter((e) => e.status === 0x90);
  const offs = m.tracks[1].filter((e) => e.status === 0x80);
  assert.strictEqual(ons.length, r.notes.length);
  assert.strictEqual(offs.length, r.notes.length);
  // テンポとコードマーカー
  const tempo = m.tracks[0].find((e) => e.meta === 0x51);
  const uspq = (tempo.data[0] << 16) | (tempo.data[1] << 8) | tempo.data[2];
  assert.strictEqual(Math.round(60000000 / uspq), 174);
  const markers = m.tracks[0].filter((e) => e.meta === 0x06).map((e) => String.fromCharCode(...e.data));
  assert.deepStrictEqual(markers, ['F', 'G', 'Em', 'Am']);
  // 位置が16分グリッド(120tick)に乗っている
  const first = r.notes[0];
  assert.strictEqual(ons[0].tick, first.s * 120);
  // 各 note on に対応する note off が後ろにある
  const open = new Map();
  for (const e of m.tracks[1]) {
    if (e.status === 0x90) {
      assert.ok(!open.has(e.a), '同じ鍵盤が重なって鳴っている');
      open.set(e.a, e.tick);
    } else if (e.status === 0x80) {
      assert.ok(open.has(e.a));
      assert.ok(e.tick > open.get(e.a));
      open.delete(e.a);
    }
  }
  assert.strictEqual(open.size, 0);
});

test('パート別MIDIはパートごとにトラックが分かれ、合計が一致する', () => {
  const r = C.compose({ chords: 'F G Em Am', mood: 'bakuhatsu', seed: 11 });
  const m = Midi.readMidi(Midi.writeMidi(r, { split: true, bpm: 190 }));
  assert.ok(m.ntrks >= 4);
  let total = 0;
  m.tracks.forEach((t) => { total += t.filter((e) => e.status === 0x90).length; });
  assert.strictEqual(total, r.notes.length);
});

test('スウィングはMIDIにも反映される', () => {
  const r = C.compose({ chords: 'FM7 E7 Am7 C7', mood: 'oshare', seed: 5 });
  assert.ok(r.swing > 0);
  const m = Midi.readMidi(Midi.writeMidi(r, {}));
  const ticks = m.tracks[1].filter((e) => e.status === 0x90).map((e) => e.tick);
  assert.ok(ticks.some((t) => t % 120 !== 0), 'スウィングで裏の16分がずれるはず');
});

test('固定した小節は作り直しても変わらず、他の小節は変わる', () => {
  const a = C.compose({ chords: 'F G Em Am', mood: 'douga', seed: 1 });
  const b = C.compose({ chords: 'F G Em Am', mood: 'douga', seed: 2 });
  const merged = C.mergeLocked(a, b, [1]);
  const inBar = (n, k) => n.s >= k * 16 && n.s < (k + 1) * 16;
  const key = (n) => `${n.s}:${n.p}`;
  const mergedBar1 = merged.notes.filter((n) => inBar(n, 1)).map(key).sort();
  const aBar1 = a.notes.filter((n) => inBar(n, 1)).map(key).sort();
  assert.deepStrictEqual(mergedBar1, aBar1);
  const mergedBar2 = merged.notes.filter((n) => inBar(n, 2)).map(key).sort();
  const bBar2 = b.notes.filter((n) => inBar(n, 2)).map(key).sort();
  assert.deepStrictEqual(mergedBar2, bBar2);
  // 固定の前の小節の音が固定の小節に食い込まない
  for (const n of merged.notes.filter((x) => inBar(x, 0))) assert.ok(n.s + n.d <= 16 + 1e-9);
});

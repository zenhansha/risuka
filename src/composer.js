/* りすかメーカー — 作曲エンジン
 *
 * 井荷麻奈実さんの動画「日本一参考にならないリリースカットピアノの作り方」の手順を
 * そのまま工程にしている。
 *
 *   1. 仮ベース・仮コード … ベース音形を中心に、鳴らしたいコードを走り書き
 *   2. フレーズ           … ベース・内声・トップを打ち込む。主張させたい動きは8度/5度でハモる
 *   3. 音で埋め尽くす     … 2〜4拍の短い動機を継ぎ足して、過度にうるさいくらいまで飽和させる
 *   4. 隙間を開ける       … コードの変わり目とベースが明瞭になるよう音価を切り、
 *                           「聴こえてほしいけど聴き取りにくい旋律」の直前を一瞬無音にする
 *                           ベロシティは内声 80-90 / 外声 100-115
 *   5. 完成
 *
 * 「毎回違うのに破綻しない」ための仕組みは2つ。
 *   - 音ではなく動機(リズム+輪郭)を作り、コードに合わせて毎回実体化する
 *   - 候補を何本も作って採点し、良いものから確率的に選ぶ(生成→評価)
 */
(function (root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  const T = isNode ? require('./theory.js') : root.RisukaTheory;
  const M = isNode ? require('./moods.js') : root.RisukaMoods;
  const api = factory(T, M);
  if (isNode) module.exports = api;
  else root.RisukaComposer = api;
})(typeof self !== 'undefined' ? self : this, function (T, Moods) {
  'use strict';

  const mod12 = T.mod12;
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

  // ------------------------------------------------------------------ RNG
  function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  class Rng {
    constructor(seed) { this.a = seed >>> 0; }
    next() {
      this.a = (this.a + 0x6d2b79f5) | 0;
      let t = Math.imul(this.a ^ (this.a >>> 15), 1 | this.a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    range(a, b) { return a + (b - a) * this.next(); }
    int(a, b) { return a + Math.floor(this.next() * (b - a + 1)); }
    chance(p) { return this.next() < p; }
    pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
    weighted(map) {
      const keys = Object.keys(map);
      let sum = 0;
      for (const k of keys) sum += map[k];
      if (sum <= 0) return keys[0];
      let r = this.next() * sum;
      for (const k of keys) {
        r -= map[k];
        if (r <= 0) return k;
      }
      return keys[keys.length - 1];
    }
    fork(salt) { return new Rng(Math.imul(this.a ^ hashStr(String(salt)), 2654435761) >>> 0); }
    shuffle(arr) {
      const a = arr.slice();
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(this.next() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    }
  }

  // ------------------------------------------------------------------ pitch helpers
  function nearestPc(p, pcs) {
    let best = p;
    let bd = 99;
    for (let d = 0; d < 12; d++) {
      for (const sign of d === 0 ? [1] : [1, -1]) {
        const c = p + d * sign;
        if (pcs.includes ? pcs.includes(mod12(c)) : pcs.has(mod12(c))) {
          if (d < bd) { bd = d; best = c; }
        }
      }
      if (bd < 99) break;
    }
    return best;
  }

  function moveScale(p, n, list) {
    if (!n) return p;
    const dir = n > 0 ? 1 : -1;
    let left = Math.abs(n);
    let cur = p;
    let guard = 0;
    while (left > 0 && guard++ < 96) {
      cur += dir;
      if (list.includes(mod12(cur))) left--;
    }
    return cur;
  }

  function placeNear(pc, target, lo, hi) {
    let p = target + mod12(pc - target);
    if (p - target > 6) p -= 12;
    while (p < lo) p += 12;
    while (p > hi) p -= 12;
    return p;
  }

  function metricWeight(posInBar, meter) {
    if (posInBar === 0) return 4;
    let at = 0;
    const half = Math.floor(meter.groups.length / 2);
    for (let g = 0; g < meter.groups.length; g++) {
      const len = meter.groups[g];
      if (posInBar === at) return g === half ? 3.5 : 3;
      if (posInBar > at && posInBar < at + len) {
        const off = posInBar - at;
        return off % 2 === 0 ? 2 : 1;
      }
      at += len;
    }
    return 1;
  }

  // ------------------------------------------------------------------ preparation
  function prepare(input) {
    const meterId = input.meter && T.METERS[input.meter] ? input.meter : '4/4';
    let keyFixed = null;
    if (input.key && input.key !== 'auto') {
      const m = /^(\d+):(major|minor)$/.exec(input.key);
      if (m) {
        keyFixed = {
          tonic: +m[1] % 12,
          mode: m[2],
          confidence: 1,
          scale: m[2] === 'major' ? T.MAJOR : T.MINOR,
        };
      }
    }
    const tl = T.parseProgression(input.chords, {
      meter: meterId,
      repeat: input.repeat || 1,
      keyHint: keyFixed ? keyFixed.tonic : 0,
      minBars: input.minBars || 4,
    });
    if (tl.errors.length) return { errors: tl.errors };
    if (!tl.regions.length || tl.regions.every((r) => r.chord.rest)) return { errors: ['コードが見つかりません'] };

    const key = keyFixed || T.detectKey(tl.regions);
    const regions = tl.regions.map((r, i) => ({ ...r, idx: i }));
    regions.forEach((r, i) => {
      const next = regions[(i + 1) % regions.length];
      r.next = next;
      if (!r.chord.rest) r.info = T.analyzeChord(r.chord, key, next.chord);
    });
    const stepRegion = new Int32Array(tl.totalSteps);
    regions.forEach((r) => {
      for (let s = r.start; s < r.end; s++) stepRegion[s] = r.idx;
    });
    return { tl, key, regions, stepRegion };
  }

  function regAt(ctx, s) {
    const t = ctx.tl.totalSteps;
    const idx = ctx.stepRegion[((Math.floor(s) % t) + t) % t];
    return ctx.regions[idx];
  }

  /** 音がコードの変わり目をまたぐなら次のコードに属する(食い) */
  function harmonyFor(ctx, s, dur) {
    const r = regAt(ctx, s);
    if (r.end - s <= 2 && s + dur > r.end && r.end < ctx.tl.totalSteps) {
      const n = regAt(ctx, r.end);
      if (!n.chord.rest) return { reg: n, antic: true };
    }
    return { reg: r, antic: false };
  }

  const barOf = (ctx, s) => Math.floor(s / ctx.tl.barSteps);
  const posOf = (ctx, s) => Math.floor(s) % ctx.tl.barSteps;

  function jitterMood(base, rng, overrides) {
    const o = overrides || {};
    const dens = o.density == null ? 1 : o.density;
    const sync = o.sync == null ? 1 : o.sync;
    const wide = o.width == null ? 1 : o.width;
    const m = { ...base };
    m.notesPerBar = base.notesPerBar * rng.range(0.92, 1.08) * dens;
    m.sync = clamp(base.sync * sync + rng.range(-0.1, 0.1), 0, 1);
    m.tension = clamp(base.tension + rng.range(-0.1, 0.1), 0, 1);
    m.fillRate = clamp(base.fillRate * rng.range(0.9, 1.1) * Math.sqrt(dens), 0, 1);
    m.oct = clamp(base.oct * rng.range(0.8, 1.2) * Math.sqrt(dens), 0, 1);
    m.fifth = clamp(base.fifth * rng.range(0.8, 1.2), 0, 1);
    m.double = clamp(base.double * rng.range(0.7, 1.3) * dens, 0, 1);
    const widen = (pair) => {
      const c = (pair[0] + pair[1]) / 2;
      const h = ((pair[1] - pair[0]) / 2) * wide;
      return [Math.round(c - h), Math.round(c + h)];
    };
    m.reg = {
      top: widen(base.reg.top),
      inner: base.reg.inner.slice(),
      bass: [Math.max(24, Math.round(base.reg.bass[0] - (wide - 1) * 4)), base.reg.bass[1]],
    };
    return m;
  }

  // ------------------------------------------------------------------ note objects
  let groupCounter = 0;
  const newGroup = () => ++groupCounter;
  const mkNote = (s, d, p, l, extra) => ({ s, d, p: Math.round(p), v: 96, l, g: 0, ...extra });

  // ------------------------------------------------------------------ rhythm & contour material
  function makeRhythmCell(rng, len, durW, restP, sync, meter, offset) {
    let best = null;
    let bestScore = -1e9;
    const keys = Object.keys(durW).map(Number);
    for (let t = 0; t < 12; t++) {
      const out = [];
      let at = 0;
      while (at < len) {
        const avail = {};
        for (const k of keys) if (at + k <= len) avail[k] = durW[k];
        const d = Object.keys(avail).length ? +rng.weighted(avail) : len - at;
        out.push({ at, dur: d, rest: false });
        at += d;
      }
      for (let i = 1; i < out.length; i++) if (rng.chance(restP)) out[i].rest = true;
      let syncCount = 0;
      let run = 0;
      let maxRun = 0;
      for (const el of out) {
        const w = metricWeight((offset + el.at) % meter.barSteps, meter);
        if (w <= 1 && el.dur >= 2 && !el.rest) syncCount++;
        if (w === 2 && el.dur >= 3 && !el.rest) syncCount++;
        run = el.dur === 1 ? run + 1 : 0;
        maxRun = Math.max(maxRun, run);
      }
      const s = sync * syncCount * 1.2 - (maxRun > 5 ? 2 : 0) + rng.next() * 0.8;
      if (s > bestScore) { bestScore = s; best = out; }
    }
    return best;
  }

  function makeContour(rng, kind) {
    const out = [];
    const push = (x) => out.push(x);
    const stepSize = () => rng.pick([1, 1, 1, 1, 2]);
    switch (kind) {
      case 'rise':
        for (let i = 0; i < 16; i++) push(stepSize());
        break;
      case 'fall':
        for (let i = 0; i < 16; i++) push(-stepSize());
        break;
      case 'arch': {
        const n = rng.int(2, 5);
        for (let i = 0; i < n; i++) push(stepSize());
        for (let i = 0; i < 12; i++) push(-stepSize());
        break;
      }
      case 'valley': {
        const n = rng.int(2, 4);
        for (let i = 0; i < n; i++) push(-stepSize());
        for (let i = 0; i < 12; i++) push(stepSize());
        break;
      }
      case 'zigUp':
        for (let i = 0; i < 16; i++) push(i % 2 === 0 ? rng.pick([2, 2, 3]) : -1);
        break;
      case 'zigDown':
        for (let i = 0; i < 16; i++) push(i % 2 === 0 ? -rng.pick([2, 2, 3]) : 1);
        break;
      case 'leapDown':
        push(rng.int(3, 5));
        for (let i = 0; i < 15; i++) push(i % 4 === 3 ? 2 : -1);
        break;
      case 'leapUp':
        push(-1); push(-1); push(rng.int(4, 6));
        for (let i = 0; i < 13; i++) push(i % 4 === 3 ? rng.int(3, 4) : -1);
        break;
      case 'pedal': {
        const leap = rng.int(2, 4);
        for (let i = 0; i < 16; i++) push(i % 2 === 0 ? leap : -leap);
        break;
      }
      case 'neighbor':
      default:
        for (let i = 0; i < 16; i++) push([1, -1, -1, 1][i % 4]);
        break;
    }
    return out;
  }

  const CONTOUR_JA = {
    rise: '上行', fall: '下行', arch: '山型', valley: '谷型',
    zigUp: 'ジグザグ上行', zigDown: 'ジグザグ下行',
    leapDown: '跳躍→下行', leapUp: '助走→跳躍', pedal: '軸音との往復', neighbor: '刺繍音',
  };

  function makeCell(ctx, rng, len, offset) {
    const mood = ctx.mood;
    const kind = rng.weighted(mood.contours);
    return {
      len,
      offset,
      kind,
      rhythm: makeRhythmCell(rng, len, mood.topDur, mood.topRest, mood.sync, ctx.tl.meter, offset),
      moves: makeContour(rng, kind),
      anchor: rng.weighted({ third: 3, fifth: 3, root: 2, seventh: 1.5, tension: mood.tension * 2 }),
    };
  }

  function varyCell(ctx, rng, cell) {
    // 後半だけ変える/輪郭を反転する、のどちらか。動機の頭は残すので同じものに聞こえる
    const out = { ...cell, moves: cell.moves.slice(), rhythm: cell.rhythm.map((x) => ({ ...x })) };
    if (rng.chance(0.5)) {
      out.moves = out.moves.map((x) => -x);
      out.kind = cell.kind + '(反転)';
    } else {
      const cut = Math.max(1, Math.floor(cell.rhythm.length / 2));
      const headEnd = cell.rhythm[cut - 1].at + cell.rhythm[cut - 1].dur;
      const tailLen = cell.len - headEnd;
      if (tailLen > 0) {
        const tail = makeRhythmCell(rng, tailLen, ctx.mood.topDur, ctx.mood.topRest, ctx.mood.sync, ctx.tl.meter, cell.offset + headEnd);
        out.rhythm = cell.rhythm.slice(0, cut).concat(tail.map((x) => ({ ...x, at: x.at + headEnd })));
      }
    }
    return out;
  }

  function makeClimaxCell(ctx, rng, len, offset) {
    const type = rng.weighted(ctx.mood.climax);
    const rhythm = [];
    let moves;
    if (type === 'hits') {
      // 刻み→決め
      let at = 0;
      while (at < len) {
        const d = at + 3 <= len && rng.chance(0.5) ? 3 : Math.min(2, len - at);
        rhythm.push({ at, dur: d, rest: false });
        at += d;
      }
      moves = new Array(16).fill(0).map((_, i) => (i % 3 === 2 ? 1 : 0));
    } else if (type === 'run') {
      // 一気に駆け上がって最後に叩く
      for (let at = 0; at < len; at++) rhythm.push({ at, dur: 1, rest: false });
      moves = new Array(16).fill(1).map(() => rng.pick([1, 1, 2]));
    } else {
      // 上行して高い音を伸ばす
      const tailLen = Math.max(2, Math.min(len - 2, Math.round(len * rng.range(0.35, 0.55))));
      for (let at = 0; at < len - tailLen; at++) rhythm.push({ at, dur: 1, rest: false });
      rhythm.push({ at: len - tailLen, dur: tailLen, rest: false });
      moves = new Array(16).fill(1).map(() => rng.pick([1, 2, 2]));
    }
    return { len, offset, kind: { hits: '決めの連打', run: '駆け上がり', rise: '上行→ロングトーン' }[type], rhythm, moves, anchor: 'fifth', climax: true };
  }

  function makeTheme(ctx, rng) {
    const meter = ctx.tl.meter;
    const halfGroups = Math.ceil(meter.groups.length / 2);
    const lenA = meter.groups.slice(0, halfGroups).reduce((a, b) => a + b, 0);
    const lenB = meter.barSteps - lenA;
    const a = makeCell(ctx, rng, lenA, 0);
    const b = lenB ? makeCell(ctx, rng, lenB, lenA) : null;
    const c = makeCell(ctx, rng, lenA, 0);
    const d = lenB ? makeCell(ctx, rng, lenB, lenA) : null;
    const b2 = b ? varyCell(ctx, rng, b) : null;
    const aInv = varyCell(ctx, rng, a);
    const z = lenB ? makeClimaxCell(ctx, rng, lenB, lenA) : makeClimaxCell(ctx, rng, lenA, 0);
    const form = rng.pick(ctx.mood.forms);
    const arcKind = rng.weighted(ctx.mood.arcs);
    const arcTable = {
      rise: [0.3, 0.42, 0.55, 0.82],
      arch: [0.35, 0.62, 0.82, 0.55],
      wave: [0.52, 0.36, 0.62, 0.8],
      fall: [0.78, 0.62, 0.5, 0.42],
    };
    const arc = arcTable[arcKind].map((x) => clamp(x + rng.range(-0.06, 0.06), 0.05, 0.95));
    return { cells: { a, b, c, d, b2, aInv, z }, form, arcKind, arc, lenA, lenB };
  }

  function barCells(theme, key) {
    const { a, b, c, d, b2, aInv, z } = theme.cells;
    const seq = {
      A: [a, b],
      A2: [a, b2],
      B: [c, d],
      C: [c, z],
      D: [aInv, z],
    }[key] || [a, b];
    return seq.filter(Boolean);
  }

  // ------------------------------------------------------------------ stage 2: top line
  function anchorPc(reg, anchor, rng) {
    const c = reg.chord;
    const info = reg.info;
    if (anchor === 'third' && c.third != null) return c.third;
    if (anchor === 'fifth' && c.fifth != null) return c.fifth;
    if (anchor === 'seventh' && c.seventh != null) return c.seventh;
    if (anchor === 'tension' && info.tensionSet.size) return rng.pick([...info.tensionSet]);
    if (anchor === 'root') return c.root;
    return rng.pick(c.core);
  }

  function snapStable(p, info, tension, rng) {
    const pool = rng.chance(tension * 0.55) ? [...info.ctSet, ...info.tensionSet] : [...info.coreSet];
    return nearestPc(p, pool);
  }

  function realizeTopPhrase(ctx, ph, theme, rng, startPrev) {
    const mood = ctx.mood;
    const { barSteps, meter } = ctx.tl;
    const [lo, hi] = mood.reg.top;
    const out = [];
    let prev = startPrev;
    let pendingEntry = true;
    const form = theme.form.slice(-ph.len);
    let cellCounter = 0;
    for (let j = 0; j < ph.len; j++) {
      const barStart = (ph.start + j) * barSteps;
      const target = lo + (hi - lo) * theme.arc[(j + (4 - ph.len)) % 4] + (ph.lift || 0);
      const cells = barCells(theme, form[j]);
      for (const cell of cells) {
        const cellId = ph.start * 1000 + cellCounter++;
        let mi = 0;
        let first = true;
        for (const el of cell.rhythm) {
          const s = barStart + cell.offset + el.at;
          if (el.rest) { pendingEntry = true; continue; }
          const { reg, antic } = harmonyFor(ctx, s, el.dur);
          if (reg.chord.rest) { pendingEntry = true; continue; }
          const info = reg.info;
          const w = metricWeight(posOf(ctx, s), meter);
          const strong = w >= 3 || el.dur >= 3 || antic;
          let p;
          if (prev == null || (first && cell.offset === 0)) {
            const aim = prev == null ? target : prev * 0.4 + target * 0.6;
            p = placeNear(anchorPc(reg, cell.anchor, rng), Math.round(aim), lo, hi);
          } else {
            const mv = cell.moves[mi++ % cell.moves.length];
            const list = rng.chance(mood.penta) ? info.penta : info.safe;
            p = moveScale(prev, mv, list);
          }
          if (strong) {
            p = snapStable(p, info, mood.tension, rng);
          } else if (info.avoidSet.has(mod12(p))) {
            p = moveScale(p, 1, info.safe);
          } else if (!info.scaleSet.has(mod12(p))) {
            p = nearestPc(p, info.safe);
          }
          // 音域からはみ出たら折り返す(オクターブ単位でなく輪郭ごと)
          while (p > hi) p -= 12;
          while (p < lo) p += 12;
          out.push(mkNote(s, el.dur, p, 'top', { e: first || pendingEntry, strong, a: antic, cell: cellId, cellKind: cell.kind, bar: ph.start + j }));
          prev = p;
          first = false;
          pendingEntry = false;
        }
      }
    }
    // 半音進行(経過音)を弱拍に混ぜる
    if (mood.chromatic > 0) {
      for (let i = 0; i + 1 < out.length; i++) {
        const a = out[i];
        const b = out[i + 1];
        if (a.strong || b.s - a.s > 1) continue;
        if (rng.chance(mood.chromatic * 0.45) && Math.abs(a.p - b.p) <= 3) {
          a.p = b.p + (a.p < b.p || a.p === b.p ? -1 : 1);
          a.chrom = true;
        }
      }
    }
    return out;
  }

  function scoreTopLine(ctx, notes) {
    const mood = ctx.mood;
    const { meter } = ctx.tl;
    if (!notes.length) return -1e6;
    let s = 0;
    let repeatRun = 0;
    let prevIv = 0;
    let hi = -1;
    let lo = 999;
    let hiAt = 0;
    let stepwise = 0;
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      const reg = regAt(ctx, n.a ? n.s + n.d : n.s);
      if (reg.chord.rest) continue;
      const info = reg.info;
      const pc = mod12(n.p);
      const w = metricWeight(posOf(ctx, n.s), meter);
      if (w >= 3 || n.d >= 3) {
        if (info.coreSet.has(pc)) s += 2;
        else if (info.ctSet.has(pc)) s += 1.5;
        else if (info.tensionSet.has(pc)) s += 0.5 + mood.tension;
        else if (info.avoidSet.has(pc)) s -= 8;
        else s -= 2.5;
      }
      if (info.avoidSet.has(pc) && !n.chrom) s -= 1.5;
      if (n.p > hi) { hi = n.p; hiAt = i; }
      if (n.p < lo) lo = n.p;
      if (i > 0) {
        const iv = n.p - notes[i - 1].p;
        const abs = Math.abs(iv);
        if (abs > 0 && abs <= 2) stepwise++;
        if (abs > 12) s -= 4;
        else if (abs > 7) s -= 1;
        // 大きな跳躍の連続は「でたらめ」に聞こえる
        if (abs >= 5 && Math.abs(prevIv) >= 5) s -= 1.5;
        if (abs === 6 && mood.chromatic < 0.4) s -= 1.2;
        if (abs === 0) {
          repeatRun++;
          if (repeatRun >= 2) s -= 1.2;
        } else repeatRun = 0;
        // 跳躍のあとは反対方向の順次進行で受ける(旋律の基本)
        if (Math.abs(prevIv) >= 5) {
          if (Math.sign(iv) === -Math.sign(prevIv) && abs <= 4) s += 1.2;
          else if (Math.sign(iv) === Math.sign(prevIv)) s -= 1;
        }
        prevIv = iv;
      }
    }
    // 山は後半に来ると気持ちいい
    const hiRatio = hiAt / notes.length;
    if (hiRatio > 0.5 && hiRatio < 0.95) s += 5;
    const hiCount = notes.filter((n) => n.p === hi).length;
    if (hiCount > 3) s -= hiCount - 3;
    const range = hi - lo;
    if (range < 10) s -= (10 - range) * 1.2;
    if (range > 26) s -= (range - 26) * 0.5;
    // 終わりはコードトーンに着地する
    const last = notes[notes.length - 1];
    const lastReg = regAt(ctx, last.s);
    if (!lastReg.chord.rest && lastReg.info.coreSet.has(mod12(last.p))) s += 3;
    s = s / Math.sqrt(notes.length);
    // 順次進行が半分近くあると歌える旋律になる(リスカはアルペジオも多いので上限は緩め)
    const stepRatio = notes.length > 1 ? stepwise / (notes.length - 1) : 0;
    s += clamp(stepRatio, 0, 0.5) * 8;
    return s;
  }

  function fingerprint(notes) {
    const set = new Set();
    for (let i = 3; i < notes.length; i++) {
      const a = notes[i - 3];
      const b = notes[i - 2];
      const c = notes[i - 1];
      const d = notes[i];
      set.add(
        [b.p - a.p, c.p - b.p, d.p - c.p, Math.round(b.s - a.s), Math.round(c.s - b.s), Math.round(d.s - c.s)].join(',')
      );
    }
    return [...set];
  }

  function similarity(a, b) {
    if (!a.length || !b.length) return 0;
    const setB = new Set(b);
    let hit = 0;
    for (const x of a) if (setB.has(x)) hit++;
    return hit / Math.min(a.length, b.length);
  }

  function pickSoftmax(rng, items, temperature) {
    const best = Math.max(...items.map((x) => x.score));
    const weights = items.map((x) => Math.exp((x.score - best) / temperature));
    const sum = weights.reduce((a, b) => a + b, 0);
    let r = rng.next() * sum;
    for (let i = 0; i < items.length; i++) {
      r -= weights[i];
      if (r <= 0) return items[i];
    }
    return items[items.length - 1];
  }

  function genTopLine(ctx) {
    const all = [];
    let prev = null;
    const themes = [];
    for (const ph of ctx.phrases) {
      const reuse = ph.reuseTheme != null ? themes[ph.reuseTheme] : null;
      const pool = [];
      const count = ctx.opts.melodyCandidates;
      for (let k = 0; k < count; k++) {
        const r = ctx.rng.fork('top' + ph.idx + ':' + k);
        let theme;
        if (reuse) {
          // 同じ動機の再提示。最後の小節だけ別の結末にする
          const zNew = makeClimaxCell(ctx, r, reuse.cells.z.len, reuse.cells.z.offset);
          theme = { ...reuse, cells: { ...reuse.cells, z: zNew }, arc: reuse.arc.map((x) => clamp(x + 0.05, 0, 0.98)) };
        } else {
          theme = makeTheme(ctx, r);
        }
        const notes = realizeTopPhrase(ctx, ph, theme, r, prev);
        pool.push({ theme, notes, score: scoreTopLine(ctx, notes) });
      }
      const chosen = pickSoftmax(ctx.rng.fork('sel' + ph.idx), pool, ctx.opts.temperature);
      ph.theme = chosen.theme;
      ph.candidates = pool.length;
      ph.topScore = chosen.score;
      themes[ph.idx] = chosen.theme;
      all.push(...chosen.notes);
      if (chosen.notes.length) prev = chosen.notes[chosen.notes.length - 1].p;
    }
    return all;
  }

  // ------------------------------------------------------------------ stage 2: harmonise (8度/5度)
  function harmonize(ctx, top) {
    const mood = ctx.mood;
    const groups = new Map();
    for (const n of top) {
      if (!groups.has(n.cell)) groups.set(n.cell, []);
      groups.get(n.cell).push(n);
    }
    const out = [];
    const counts = { oct: 0, fifth: 0, double: 0, third: 0, none: 0 };
    for (const [cellId, notes] of groups) {
      const r = ctx.rng.fork('harm' + cellId);
      const e = ctx.barEnergy[notes[0].bar] || 0.8;
      const isClimax = notes.some((x) => x.d >= 4) || /駆け上がり|決め|ロング/.test(notes[0].cellKind || '');
      const boost = isClimax ? 1.35 : 1;
      let mode = 'none';
      if (r.chance(mood.double * e * boost)) mode = 'double';
      else if (r.chance(mood.fifth * e * boost)) mode = 'fifth';
      else if (r.chance(mood.oct * e * boost)) mode = 'oct';
      else if (r.chance(mood.third)) mode = 'third';
      counts[mode]++;
      if (mode === 'none') continue;
      const g = newGroup();
      for (const n of notes) {
        const reg = harmonyFor(ctx, n.s, n.d).reg;
        if (reg.chord.rest) continue;
        const info = reg.info;
        const add = (p) => {
          if (p < mood.reg.inner[0] - 2) return;
          out.push(mkNote(n.s, n.d, p, 'top', { h: mode, g, bar: n.bar, a: n.a, parent: n }));
        };
        if (mode === 'oct' || mode === 'double') add(n.p - 12);
        if (mode === 'fifth' || mode === 'double') {
          const q = moveScale(n.p, -4, info.scale);
          const iv = n.p - q;
          if (iv === 7 || iv === 5 || iv === 8) add(q);
          else if (info.scaleSet.has(mod12(n.p - 7))) add(n.p - 7);
          else if (info.scaleSet.has(mod12(n.p - 5))) add(n.p - 5);
        }
        if (mode === 'third') {
          const q = moveScale(n.p, -2, info.safe);
          const iv = n.p - q;
          if (iv >= 3 && iv <= 4) add(q);
          else add(n.p - 12);
        }
      }
    }
    ctx.harmCounts = counts;
    return out;
  }

  // ------------------------------------------------------------------ stage 1: bass
  function makeBassGroove(ctx, rng) {
    const mood = ctx.mood;
    const { barSteps, meter } = ctx.tl;
    const style = rng.weighted(mood.bass);
    const ev = [];
    if (style === 'drive') {
      const pat = rng.pick(mood.comp);
      let at = 0;
      const kinds = ['root', 'root', 'oct', 'root', 'fifth', 'oct'];
      let i = 0;
      while (at < barSteps) {
        const d = pat[i % pat.length];
        ev.push({ at, dur: Math.min(d, barSteps - at), kind: i === 0 ? 'root' : rng.chance(0.55) ? 'root' : rng.pick(kinds) });
        at += d;
        i++;
      }
    } else if (style === 'pulse') {
      for (let at = 0; at < barSteps; at += 2) {
        ev.push({ at, dur: 2, kind: at === 0 ? 'root' : (at / 2) % 2 === 1 ? (rng.chance(0.6) ? 'oct' : 'root') : 'root' });
      }
    } else if (style === 'sparse') {
      ev.push({ at: 0, dur: meter.groups[0] + 2, kind: 'root' });
      const a2 = meter.groups[0] + 2;
      if (a2 < barSteps) ev.push({ at: a2, dur: 2, kind: 'root' });
      const a3 = barSteps - rng.pick([2, 3, 4]);
      if (a3 > a2 + 1) ev.push({ at: a3, dur: barSteps - a3, kind: rng.pick(['fifth', 'oct', 'scale']), deg: rng.pick([-1, 1, 2]) });
    } else if (style === 'run') {
      const hold = Math.floor(barSteps / 2);
      ev.push({ at: 0, dur: rng.pick([3, 4, hold]), kind: 'root' });
      ev.push({ at: hold, dur: rng.pick([2, 3]), kind: rng.pick(['root', 'oct']) });
      const runStart = barSteps - rng.pick([3, 4, 5]);
      let deg = 0;
      const dir = rng.chance(0.6) ? 1 : -1;
      for (let at = Math.max(runStart, hold + 2); at < barSteps; at++) {
        deg += dir;
        ev.push({ at, dur: 1, kind: 'scale', deg: deg + rng.pick([0, 0, 1]) });
      }
    } else {
      // figure: ベース音形そのものがアイデアになるタイプ(動画の出発点)
      const rhythm = makeRhythmCell(rng, barSteps, mood.bassDur, 0.05, mood.sync, meter, 0);
      let deg = 0;
      const contour = makeContour(rng, rng.pick(['rise', 'zigUp', 'arch', 'zigDown', 'neighbor', 'leapUp']));
      rhythm.forEach((el, i) => {
        if (el.rest) return;
        if (i === 0) {
          ev.push({ at: el.at, dur: el.dur, kind: 'root' });
          return;
        }
        deg = clamp(deg + contour[i], -3, 7);
        ev.push({ at: el.at, dur: el.dur, kind: 'scale', deg });
      });
    }
    return { style, ev };
  }

  const BASS_JA = { drive: 'シンコペで押すルート刻み', pulse: '八分のオクターブ刻み', sparse: '点で支える', run: '後半で駆ける', figure: '音階で歌うベース音形' };

  function genBass(ctx) {
    const mood = ctx.mood;
    const { barSteps } = ctx.tl;
    const [lo, hi] = mood.reg.bass;
    const out = [];
    let prev = (lo + hi) / 2 - 3;
    for (const ph of ctx.phrases) {
      const r = ctx.rng.fork('bass' + ph.idx);
      const groove = makeBassGroove(ctx, r);
      const alt = makeBassGroove(ctx, r);
      ph.bassStyle = groove.style;
      for (let j = 0; j < ph.len; j++) {
        const bar = ph.start + j;
        const barStart = bar * barSteps;
        const isLast = j === ph.len - 1 && ph.len >= 2;
        // 2小節目ごとの後半に別案を差して、ループ感を崩す
        const use = isLast && r.chance(0.7) ? alt : groove;
        for (const ev of use.ev) {
          const s = barStart + ev.at;
          const { reg, antic } = harmonyFor(ctx, s, ev.dur);
          if (reg.chord.rest) continue;
          const chord = reg.chord;
          const info = reg.info;
          let p;
          const root = placeNear(chord.bass, Math.round(prev), lo, hi);
          if (ev.kind === 'root') p = root;
          else if (ev.kind === 'oct') p = root + 12 <= hi + 7 ? root + 12 : root - 12;
          else if (ev.kind === 'fifth' && chord.fifth != null) p = placeNear(chord.fifth, root, lo, hi + 5);
          else if (ev.kind === 'scale') p = moveScale(root, ev.deg || 0, info.safe);
          else p = root;
          if (p > hi + 7) p -= 12;
          if (p < lo) p += 12;
          out.push(mkNote(s, ev.dur, p, 'bass', { a: antic, kind: ev.kind, bar }));
          if (ev.kind !== 'oct') prev = p;
        }
      }
    }
    // コードの変わり目でルートが鳴っていないところを必ず埋める(ここがぶれると全部ぶれる)
    for (const reg of ctx.regions) {
      if (reg.chord.rest) continue;
      const hasNear = out.some((n) => n.s >= reg.start - 2 && n.s <= reg.start && mod12(n.p) === reg.chord.bass && (n.s === reg.start || n.a));
      if (!hasNear) {
        for (let i = out.length - 1; i >= 0; i--) if (out[i].s === reg.start) out.splice(i, 1);
        const near = out.filter((n) => n.s < reg.start).pop();
        const p = placeNear(reg.chord.bass, near ? near.p : (lo + hi) / 2, lo, hi);
        out.push(mkNote(reg.start, 2, p, 'bass', { kind: 'root', bar: barOf(ctx, reg.start) }));
      }
    }
    out.sort((a, b) => a.s - b.s);
    // 次のコードのルートへ順次進行で向かう(ベースラインが「線」に聞こえる最大の要因)
    for (let i = 0; i + 1 < out.length; i++) {
      const n = out[i];
      const nx = out[i + 1];
      const nReg = regAt(ctx, n.s);
      const xReg = regAt(ctx, nx.s);
      if (nReg === xReg || nx.s - n.s > 3 || n.a) continue;
      if (n.s === nReg.start || xReg.chord.rest || nReg.chord.rest) continue;
      const r = ctx.rng.fork('app' + i);
      const side = n.p < nx.p ? -1 : 1;
      if (r.chance(mood.chromatic * 1.4)) {
        n.p = nx.p + side;
        n.chrom = true;
      } else if (r.chance(0.65)) {
        n.p = moveScale(nx.p, side, nReg.info.safe);
      }
    }
    // 左手のオクターブ(太さ)
    const doubled = [];
    for (const n of out) {
      const r = ctx.rng.fork('boct' + n.s);
      const w = metricWeight(posOf(ctx, n.s), ctx.tl.meter);
      if ((w >= 2 || n.d >= 2) && n.kind !== 'oct' && r.chance(mood.bassOct) && n.p + 12 <= 60) {
        doubled.push(mkNote(n.s, n.d, n.p + 12, 'bass', { h: 'oct', a: n.a, bar: n.bar }));
      }
    }
    return out.concat(doubled);
  }

  // ------------------------------------------------------------------ stage 1: scribble chords
  function buildVoicings(reg, lo, hi, mood) {
    const chord = reg.chord;
    const info = reg.info;
    const guide = info.guide.length ? info.guide : chord.core.slice(0, 2);
    const pool = new Set(chord.core);
    const tens = [...info.tensionSet];
    tens.slice(0, mood.tension > 0.6 ? 3 : mood.tension > 0.3 ? 1 : 0).forEach((p) => pool.add(p));
    chord.ext.forEach((p) => pool.add(p));
    const notes = [];
    for (let m = lo; m <= hi; m++) if (pool.has(mod12(m))) notes.push(m);
    const out = [];
    const style = mood.voicing;
    const sizes = style === 'close' ? [3] : [3, 4];
    const check = (c) => {
      const pcs = new Set(c.map(mod12));
      if (!guide.every((g) => pcs.has(g))) return false;
      if (pcs.size < Math.min(3, c.length)) return false;
      for (let i = 0; i + 1 < c.length; i++) {
        const iv = c[i + 1] - c[i];
        if (iv === 1) return false;
        if (style === 'quartal' && (iv < 4 || iv > 7)) return false;
        if (style === 'close' && iv > 5) return false;
        if (style === 'open' && iv > 9) return false;
        if (style === 'rootless' && iv > 7) return false;
      }
      for (let i = 0; i < c.length; i++) {
        for (let j = i + 1; j < c.length; j++) {
          const iv = c[j] - c[i];
          if (iv === 13 || iv === 25) return false;
        }
      }
      if (style === 'rootless' && pcs.has(chord.root) && pcs.size > 3) return false;
      return true;
    };
    for (const size of sizes) {
      const idx = [];
      const rec = (start) => {
        if (idx.length === size) {
          const c = idx.map((i) => notes[i]);
          if (check(c)) out.push(c);
          return;
        }
        for (let i = start; i < notes.length; i++) {
          idx.push(i);
          rec(i + 1);
          idx.pop();
        }
      };
      rec(0);
    }
    if (!out.length) {
      // 制約が厳しすぎたときの保険
      const base = placeNear(chord.root, Math.round((lo + hi) / 2) - 6, lo, hi);
      out.push(chord.core.map((pc) => placeNear(pc, base + 4, lo, hi + 6)).sort((a, b) => a - b));
    }
    return out;
  }

  function chooseVoicing(list, prev, ceil, rng, center) {
    let best = null;
    let bs = -1e9;
    for (const v of list) {
      const top = v[v.length - 1];
      if (ceil != null && top >= ceil) continue;
      const mean = v.reduce((a, b) => a + b, 0) / v.length;
      let s = -Math.abs(mean - center) * 0.15;
      if (prev) {
        // 声部進行: 一番近い音への移動量の合計を小さく
        let cost = 0;
        for (const p of v) {
          let d = 99;
          for (const q of prev) d = Math.min(d, Math.abs(p - q));
          cost += d;
        }
        s -= cost * 0.5;
      }
      s += rng.next() * 1.5;
      if (s > bs) { bs = s; best = v; }
    }
    if (best) return best;
    // ceil 未満に収まらないとき: ceil 未満の音だけ残す
    const v0 = list[Math.floor(rng.next() * list.length)];
    return ceil != null ? v0.filter((p) => p < ceil) : v0;
  }

  function genScribble(ctx) {
    const mood = ctx.mood;
    const out = [];
    let prev = null;
    const r = ctx.rng.fork('scribble');
    const [lo, hi] = mood.reg.inner;
    const center = (lo + hi) / 2;
    for (const reg of ctx.regions) {
      if (reg.chord.rest) continue;
      const list = voicingsFor(ctx, reg, lo, hi);
      const v = chooseVoicing(list, prev, null, r, center);
      prev = v;
      const g = newGroup();
      for (const p of v) out.push(mkNote(reg.start, Math.min(reg.end - reg.start, 4), p, 'inner', { g, bar: barOf(ctx, reg.start), scribble: true }));
    }
    return out;
  }

  function voicingsFor(ctx, reg, lo, hi) {
    const key = reg.chord.name + ':' + lo + ':' + hi;
    if (!ctx.voicingCache[key]) ctx.voicingCache[key] = buildVoicings(reg, lo, hi, ctx.mood);
    return ctx.voicingCache[key];
  }

  // ------------------------------------------------------------------ stage 2: comp stabs
  function makeCompGroove(ctx, rng) {
    const mood = ctx.mood;
    const { barSteps } = ctx.tl;
    const pat = rng.pick(mood.comp);
    const onsets = [];
    let at = 0;
    let i = 0;
    while (at < barSteps) {
      const d = pat[i % pat.length];
      onsets.push({ at, gap: Math.min(d, barSteps - at) });
      at += d;
      i++;
    }
    const kept = onsets.filter((o, k) => k === 0 || rng.chance(mood.compKeep));
    return { pattern: pat.slice(), onsets: kept };
  }

  function topAt(top, s) {
    let best = null;
    for (const n of top) {
      if (n.s > s) break;
      if (n.s + n.d > s) best = n;
    }
    return best;
  }

  const TEXTURE_JA = { stab: '刻み', arp: 'アルペジオ', run: '音階の線', line: '対旋律', rest: '休み' };

  /**
   * 内声は「2拍ごとに質感を選んで継ぎ足す」。動画のロールを見ると、刻みがずっと続くのではなく
   * 刻み→上下に走る線→刻み、と短い単位で入れ替わっている。
   * さらにトップが忙しいところでは内声を落ち着かせ、トップが伸びているところで内声を走らせる。
   */
  function genTextures(ctx, top) {
    const mood = ctx.mood;
    const { barSteps, meter } = ctx.tl;
    const [lo, hi] = mood.reg.inner;
    const center = (lo + hi) / 2 + 1;
    const out = [];
    let prevV = null;
    let prevLine = null;
    const halfGroups = Math.ceil(meter.groups.length / 2);
    const lenA = meter.groups.slice(0, halfGroups).reduce((a, b) => a + b, 0);
    const slotsOf = [{ off: 0, len: lenA }, { off: lenA, len: barSteps - lenA }].filter((x) => x.len > 0);
    const mainTop = top.filter((n) => !n.h);
    const usage = {};

    for (const ph of ctx.phrases) {
      const r = ctx.rng.fork('tex' + ph.idx);
      const groove = makeCompGroove(ctx, r);
      const groove2 = r.chance(0.5) ? makeCompGroove(ctx, r) : groove;
      ph.compPattern = groove.pattern;
      // 2小節ぶんの質感の並びを決めて繰り返す(これも動機の一種)
      const plan = [];
      for (let i = 0; i < 4; i++) plan.push(r.weighted(mood.texture));
      const lineRhythm = makeRhythmCell(r, lenA, { 2: 0.5, 3: 0.3, 4: 0.2 }, 0.2, mood.sync, meter, 0);
      const runRhythm = makeRhythmCell(r, lenA, { 1: 0.72, 2: 0.28 }, 0, 0, meter, 0);
      const arpRhythm = makeRhythmCell(r, lenA, { 1: 0.5, 2: 0.42, 3: 0.08 }, 0.05, mood.sync, meter, 0);
      const arpUp = r.chance(0.68);

      for (let j = 0; j < ph.len; j++) {
        const bar = ph.start + j;
        const barStart = bar * barSteps;
        const e = ctx.barEnergy[bar] || 0.8;
        slotsOf.forEach((slot, k) => {
          const start = barStart + slot.off;
          const end = start + slot.len;
          let tx = plan[((j % 2) * 2 + k) % 4];
          const topCount = mainTop.filter((n) => n.s >= start && n.s < end).length;
          const busy = topCount / slot.len;
          if (busy >= 0.55 && (tx === 'arp' || tx === 'run') && r.chance(0.65)) tx = r.chance(0.65) ? 'stab' : 'line';
          if (busy <= 0.3 && (tx === 'rest' || tx === 'line') && r.chance(0.7)) tx = r.chance(0.7) ? 'arp' : 'run';
          if (j === ph.len - 1 && k === slotsOf.length - 1 && tx === 'rest') tx = 'run';
          usage[tx] = (usage[tx] || 0) + 1;
          if (tx === 'rest') return;
          const g = newGroup();

          if (tx === 'stab') {
            const onsets = (j % 2 === 1 ? groove2 : groove).onsets.filter((o) => o.at >= slot.off && o.at < slot.off + slot.len);
            for (const on of onsets) {
              const s = barStart + on.at;
              const { reg, antic } = harmonyFor(ctx, s, on.gap);
              if (reg.chord.rest) continue;
              const w = metricWeight(posOf(ctx, s), meter);
              const t = topAt(top, s);
              if (w <= 1 && t && t.s === s && r.chance(0.5)) continue;
              if (e < 0.75 && w <= 1 && r.chance(0.25)) continue;
              const ceil = t ? t.p - 2 : null;
              const v = chooseVoicing(voicingsFor(ctx, reg, lo, hi), prevV, ceil, r, center);
              if (!v.length) continue;
              prevV = v;
              const dur = Math.max(1, Math.min(on.gap, mood.stabLen + (r.chance(0.2) ? 1 : 0)));
              const sg = newGroup();
              for (const p of v) out.push(mkNote(s, dur, p, 'inner', { a: antic, g: sg, bar, stab: true }));
            }
          } else if (tx === 'arp' || tx === 'run') {
            const rhythm = tx === 'arp' ? arpRhythm : runRhythm;
            const rising = tx === 'run' ? r.chance(0.65) : arpUp;
            let p = null;
            for (const el of rhythm) {
              const s = start + el.at;
              if (s >= end || el.rest) continue;
              const { reg, antic } = harmonyFor(ctx, s, el.dur);
              if (reg.chord.rest) continue;
              if (p == null) {
                const from = rising ? lo + r.int(0, 5) : hi + r.int(-2, 5);
                p = nearestPc(from, reg.info.core);
              } else if (tx === 'arp') {
                p = rising ? chordToneAbove(p, reg) : chordToneBelow(p, reg);
              } else {
                p = moveScale(p, rising ? 1 : -1, reg.info.safe);
              }
              if (p > hi + 7) p -= 12;
              if (p < lo - 2) p += 12;
              const t = topAt(top, s);
              if (t && p >= t.p - 1) continue;
              out.push(mkNote(s, Math.min(el.dur, end - s), p, 'inner', { a: antic, g, bar, line: true }));
            }
          } else {
            // 対旋律: コードの導音(3rd/7th)を最短距離で結ぶ
            const contour = makeContour(r, r.pick(['arch', 'neighbor', 'rise', 'fall']));
            let mi = 0;
            for (const el of lineRhythm) {
              const s = start + el.at;
              if (s >= end || el.rest) continue;
              const { reg, antic } = harmonyFor(ctx, s, el.dur);
              if (reg.chord.rest) continue;
              const info = reg.info;
              const isChange = s === reg.start || antic;
              let p;
              if (prevLine == null || isChange) {
                const pcs = info.guide.length ? info.guide : info.core;
                p = nearestPc(prevLine == null ? center : prevLine, pcs);
              } else {
                p = moveScale(prevLine, contour[mi++ % contour.length], info.safe);
              }
              while (p > hi) p -= 12;
              while (p < lo) p += 12;
              const t = topAt(top, s);
              if (t && p >= t.p - 2) continue;
              out.push(mkNote(s, Math.min(el.dur, end - s), p, 'inner', { a: antic, g, bar, line: true }));
              prevLine = p;
            }
          }
        });
      }
    }
    ctx.textureUsage = usage;
    return out;
  }

  // ------------------------------------------------------------------ stage 2: big hit stacks
  function genHits(ctx, top) {
    const mood = ctx.mood;
    const { barSteps } = ctx.tl;
    const out = [];
    const mark = (s, r) => {
      const reg = regAt(ctx, s);
      if (reg.chord.rest) return;
      const chord = reg.chord;
      const t = topAt(top, s);
      const g = newGroup();
      const root = placeNear(chord.bass, (mood.reg.bass[0] + mood.reg.bass[1]) / 2 - 2, mood.reg.bass[0], mood.reg.bass[1]);
      const stack = [root, root + 12];
      const five = chord.fifth != null ? chord.fifth : chord.root;
      stack.push(placeNear(five, root + 19, root + 12, root + 26));
      const list = voicingsFor(ctx, reg, mood.reg.inner[0], mood.reg.inner[1]);
      const v = chooseVoicing(list, null, t ? t.p - 2 : null, r, mood.reg.inner[1] - 4);
      stack.push(...v.slice(-2));
      if (t) stack.push(t.p);
      const uniq = [...new Set(stack)].sort((a, b) => a - b);
      const d = r.pick([2, 3, 3, 4]);
      for (const p of uniq) out.push(mkNote(s, d, p, 'hit', { g, bar: barOf(ctx, s) }));
    };
    for (const ph of ctx.phrases) {
      const r = ctx.rng.fork('hit' + ph.idx);
      if (r.chance(Math.min(1, mood.hitP + 0.2))) mark(ph.start * barSteps, r);
      for (let j = 1; j < ph.len; j++) {
        const e = ctx.barEnergy[ph.start + j] || 0.8;
        if (r.chance(mood.hitP * e * 0.5)) mark((ph.start + j) * barSteps, r);
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ stage 3: fills
  const FILL_JA = {
    arp: 'アルペジオ', run: '音階ラン', zig: 'ジグザグ', brokenOct: '分散オクターブ', rep: '連打',
    turn: 'ターン', sweep: '大跳躍スウィープ', thirds: '3度ラン', echo: '動機のこだま', flurry: '32分フラリー',
  };

  function chordToneBelow(p, reg) {
    let c = p - 1;
    let guard = 0;
    while (!reg.info.ctSet.has(mod12(c)) && guard++ < 24) c--;
    return c;
  }
  function chordToneAbove(p, reg) {
    let c = p + 1;
    let guard = 0;
    while (!reg.info.ctSet.has(mod12(c)) && guard++ < 24) c++;
    return c;
  }

  function buildFill(ctx, r, type, endStep, len, landing, limit, top) {
    const out = [];
    const down = limit.lo;
    const ceil = limit.hi;
    const dirUp = landing > (down + ceil) / 2 ? r.chance(0.82) : r.chance(0.35);
    const pushBack = (s, p, d) => out.unshift({ s, d: d || 1, p });
    const validStep = (s) => {
      const reg = regAt(ctx, s);
      return reg && !reg.chord.rest && s >= 0;
    };
    let cur = landing;
    if (type === 'arp' || type === 'sweep') {
      for (let i = 1; i <= len; i++) {
        const s = endStep - i;
        if (!validStep(s)) break;
        const reg = regAt(ctx, s);
        let next = dirUp ? chordToneBelow(cur, reg) : chordToneAbove(cur, reg);
        if (type === 'sweep') next = dirUp ? chordToneBelow(next, reg) : chordToneAbove(next, reg);
        if (next < down || next > ceil) break;
        cur = next;
        pushBack(s, cur);
      }
    } else if (type === 'run' || type === 'thirds') {
      for (let i = 1; i <= len; i++) {
        const s = endStep - i;
        if (!validStep(s)) break;
        const reg = regAt(ctx, s);
        const next = moveScale(cur, dirUp ? -1 : 1, reg.info.safe);
        if (next < down || next > ceil) break;
        cur = next;
        pushBack(s, cur);
        if (type === 'thirds') {
          const q = moveScale(cur, -2, reg.info.safe);
          if (q - cur >= -4 && q >= down) out.unshift({ s, d: 1, p: q });
        }
      }
    } else if (type === 'zig') {
      for (let i = 1; i <= len; i++) {
        const s = endStep - i;
        if (!validStep(s)) break;
        const reg = regAt(ctx, s);
        const mv = i % 2 === 1 ? (dirUp ? -2 : 2) : dirUp ? 1 : -1;
        const next = moveScale(cur, mv, reg.info.safe);
        if (next < down || next > ceil) break;
        cur = next;
        pushBack(s, cur);
      }
    } else if (type === 'brokenOct') {
      let anchor = landing;
      for (let i = 1; i <= len; i++) {
        const s = endStep - i;
        if (!validStep(s)) break;
        const reg = regAt(ctx, s);
        if (i % 2 === 1) {
          anchor = dirUp ? chordToneBelow(anchor, reg) : chordToneAbove(anchor, reg);
          cur = anchor;
        } else {
          cur = anchor - 12;
        }
        if (cur < down || cur > ceil) break;
        pushBack(s, cur);
      }
    } else if (type === 'rep') {
      const reg0 = regAt(ctx, endStep - 1);
      if (!reg0.chord.rest) {
        const tone = nearestPc(landing - 3, reg0.info.core);
        for (let i = 1; i <= len; i++) {
          const s = endStep - i;
          if (!validStep(s)) break;
          const reg = regAt(ctx, s);
          if (reg !== reg0) break;
          if (tone < down) break;
          pushBack(s, tone);
          if (i % 3 === 0 && tone - 12 >= down) out.unshift({ s, d: 1, p: tone - 12 });
        }
      }
    } else if (type === 'turn') {
      const reg0 = regAt(ctx, endStep - 1);
      if (!reg0.chord.rest) {
        const up = moveScale(landing, 1, reg0.info.safe);
        const dn = moveScale(landing, -1, reg0.info.safe);
        const figure = [landing, dn, landing, up];
        for (let i = 1; i <= Math.min(len, 4); i++) {
          const s = endStep - i;
          if (!validStep(s)) break;
          pushBack(s, figure[(i - 1) % 4]);
        }
      }
    } else if (type === 'flurry') {
      // 32分のフラリー: 1拍で一気に駆け上がる
      const span = Math.min(len, 4);
      for (let i = 1; i <= span * 2; i++) {
        const s = endStep - i * 0.5;
        if (!validStep(s)) break;
        const reg = regAt(ctx, s);
        const next = moveScale(cur, dirUp ? -1 : 1, reg.info.safe);
        if (next < down || next > ceil) break;
        cur = next;
        pushBack(s, cur, 0.5);
      }
    } else if (type === 'echo') {
      // 直前の動機をオクターブ下でこだまさせる(1つの動機として聞こえる)
      const before = top.filter((n) => !n.h && n.s < endStep - len).slice(-len);
      if (before.length >= 2) {
        const shift = endStep - len - before[0].s;
        for (const n of before) {
          const s = n.s + shift;
          if (s >= endStep || !validStep(s)) continue;
          const reg = regAt(ctx, s);
          let p = n.p - 12;
          const w = metricWeight(posOf(ctx, s), ctx.tl.meter);
          if (w >= 2) p = nearestPc(p, reg.info.core);
          else if (!reg.info.safeSet.has(mod12(p))) p = nearestPc(p, reg.info.safe);
          if (p < down) p += 12;
          if (p > ceil) p -= 12;
          out.push({ s, d: Math.min(n.d, endStep - s), p });
        }
      }
    }
    return out;
  }

  function genFills(ctx, top, others) {
    const mood = ctx.mood;
    const { barSteps, totalSteps } = ctx.tl;
    const main = top.filter((n) => !n.h).sort((a, b) => a.s - b.s);
    const out = [];
    const used = {};
    const addFill = (type, r, endStep, len, landing) => {
      const limit = { lo: mood.reg.inner[0] - 2, hi: mood.reg.top[1] };
      const seq = buildFill(ctx, r, type, endStep, len, landing, limit, top);
      if (seq.length < 2) return 0;
      const g = newGroup();
      for (const n of seq) {
        out.push(mkNote(n.s, n.d, n.p, 'fill', { g, bar: barOf(ctx, n.s), fillType: type }));
      }
      used[type] = (used[type] || 0) + 1;
      return seq.length;
    };

    // 旋律の穴を、次の音へ向かう短い動機で埋める
    for (let i = 0; i < main.length; i++) {
      const a = main[i];
      const b = main[i + 1];
      const endStep = b ? b.s : totalSteps;
      const start = a.s + 1;
      const room = endStep - start;
      if (room < 2) continue;
      const r = ctx.rng.fork('fill' + a.s);
      const e = ctx.barEnergy[a.bar] || 0.8;
      if (!r.chance(mood.fillRate * (0.6 + e * 0.5))) continue;
      const landing = b ? b.p : a.p;
      const type = r.weighted(mood.fills);
      const fillLen = Math.min(room, 8, Math.max(2, Math.round(r.range(0.6, 1) * room)));
      const ok = addFill(type, r, endStep, fillLen, landing);
      if (!ok) addFill('arp', r, endStep, fillLen, landing);
    }

    // フレーズの変わり目は音域を一気につなぐ
    for (const ph of ctx.phrases) {
      const endStep = (ph.start + ph.len) * barSteps;
      const r = ctx.rng.fork('sweep' + ph.idx);
      if (!r.chance(0.65 * mood.fillRate)) continue;
      const next = main.find((n) => n.s >= endStep % totalSteps);
      const reg = regAt(ctx, Math.max(0, endStep - 1));
      if (reg.chord.rest) continue;
      const landing = next ? next.p : nearestPc(mood.reg.top[1] - 6, reg.info.core);
      addFill(r.chance(0.6) ? 'sweep' : 'run', r, endStep, r.int(4, 8), landing);
    }

    // まだ薄い2拍には、次の音へ向かう長めの線を継ぎ足す(単調な刻みで埋めるより音楽になる)
    const target = mood.notesPerBar * (barSteps / 16) * mood.saturate;
    const bars = totalSteps / barSteps;
    const lineTypes = {};
    for (const k of ['arp', 'sweep', 'run', 'zig', 'brokenOct', 'thirds']) {
      if (mood.fills[k]) lineTypes[k] = mood.fills[k];
    }
    const countIn = (a, b) => {
      const inRange = (n) => n.s >= a && n.s < b;
      return top.filter(inRange).length + out.filter(inRange).length + others.filter(inRange).length;
    };
    const halfGroups = Math.ceil(ctx.tl.meter.groups.length / 2);
    const lenA = ctx.tl.meter.groups.slice(0, halfGroups).reduce((a, b) => a + b, 0);
    for (let pass = 0; pass < 3; pass++) {
      for (let bar = 0; bar < bars; bar++) {
        for (const [off, len] of [[0, lenA], [lenA, barSteps - lenA]]) {
          if (len <= 0) continue;
          const a = bar * barSteps + off;
          const b = a + len;
          if (countIn(a, b) >= (target * len) / barSteps) continue;
          const r = ctx.rng.fork(`line${pass}:${a}`);
          const reg = regAt(ctx, Math.min(b, totalSteps - 1));
          if (reg.chord.rest) continue;
          const [lo, hi] = [mood.reg.inner[0] + 4, mood.reg.top[1] - 6];
          const landing = nearestPc(r.int(lo, hi), reg.info.core);
          const fillLen = Math.min(len, r.int(4, 8));
          addFill(r.weighted(lineTypes), r, b, fillLen, landing);
        }
      }
    }

    // 3の最後: それでも足りなければ刻みで飽和させる(過度にうるさいくらいが丁度いい)
    for (let bar = 0; bar < bars; bar++) {
      const barStart = bar * barSteps;
      let count = countIn(barStart, barStart + barSteps);
      const r = ctx.rng.fork('sat' + bar);
      if (count >= target) continue;
      const pattern = r.pick([[0, 2, 1, 2], [0, 1, 2, 1], [2, 1, 0, 1], [0, 2, 3, 2]]);
      const [lo, hi] = mood.reg.inner;
      const groupId = newGroup();
      for (let k = 0; k < barSteps && count < target; k++) {
        const s = barStart + k;
        const reg = regAt(ctx, s);
        if (reg.chord.rest) continue;
        if (k % 2 === 0 && r.chance(0.5)) continue;
        const tones = reg.info.core.map((pc) => placeNear(pc, (lo + hi) / 2 + 2, lo, hi)).sort((a, b) => a - b);
        const p = tones[pattern[k % pattern.length] % tones.length];
        out.push(mkNote(s, 1, p, 'fill', { g: groupId, bar, fillType: 'ostinato', o: true }));
        count++;
      }
    }

    ctx.fillUsed = used;
    return out;
  }

  // ------------------------------------------------------------------ stage 4: carve
  // 間引くときの優先度。動画の完成形は「線」が主役なので、刻みの塊から先に減らす
  const IMPORTANCE = { top: 10, bass: 9, hit: 7, inner: 5, fill: 5 };

  function noteImportance(n) {
    let v = IMPORTANCE[n.l] || 1;
    if (n.h) v -= 3.5;
    if (n.o) v = 0.5;
    if (n.stab) v -= 2.5;
    return v;
  }

  function carve(ctx, notesIn) {
    const mood = ctx.mood;
    const { barSteps, totalSteps, meter } = ctx.tl;
    const notes = notesIn.map((n) => ({ ...n }));
    const gaps = [];

    // A. ブレイク: フレーズ末の一瞬、ピアノ全体を切って次の頭を強調する
    const breaks = [];
    for (const ph of ctx.phrases) {
      const r = ctx.rng.fork('break' + ph.idx);
      if (!r.chance(mood.breakP)) continue;
      const endStep = (ph.start + ph.len) * barSteps;
      const k = r.pick([1, 2, 2, 3]);
      breaks.push({ start: endStep - k, end: endStep });
    }
    const removeSet = new Set();
    for (const b of breaks) {
      notes.forEach((n, i) => {
        if (n.s >= b.start && n.s < b.end) removeSet.add(i);
        else if (n.s < b.start && n.s + n.d > b.start) n.d = b.start - n.s;
      });
    }

    // B. 動画のコツ: 聴こえてほしいのに埋もれる旋律の、直前を一瞬無音にする
    const melody = notes
      .map((n, i) => ({ n, i }))
      .filter((x) => x.n.l === 'top' && !x.n.h && x.n.e && !removeSet.has(x.i));
    const scored = melody.map(({ n }) => {
      const before = n.s - 1;
      let masking = 0;
      for (let j = 0; j < notes.length; j++) {
        if (removeSet.has(j)) continue;
        const m = notes[j];
        if (m === n || m.l === 'bass') continue;
        if (m.s <= before && m.s + m.d > before && Math.abs(m.p - n.p) <= 12) masking++;
        if (m.s === n.s && Math.abs(m.p - n.p) <= 7 && m.p > n.p) masking += 2;
      }
      return { n, masking };
    });
    scored.sort((a, b) => b.masking - a.masking);
    const rGap = ctx.rng.fork('gaps');
    const bars = totalSteps / barSteps;
    const wantGaps = Math.max(1, Math.round(bars * mood.gapRate * 1.3));
    const chosen = [];
    for (const c of scored) {
      if (chosen.length >= wantGaps) break;
      if (c.masking < 1 && chosen.length >= 1) continue;
      if (c.n.s < 1) continue;
      if (chosen.some((x) => Math.abs(x.n.s - c.n.s) < 6)) continue;
      if (rGap.chance(0.85)) chosen.push(c);
    }
    for (const { n: m } of chosen) {
      const gs = m.s - 1;
      notes.forEach((n, i) => {
        if (n === m || removeSet.has(i)) return;
        // コードの頭(と、その食い)のルートは残す。ここを消すと和声が見えなくなる
        const isRootAtChange = n.l === 'bass' && !n.h && (regAt(ctx, n.s).start === n.s || n.a);
        if (n.s >= gs && n.s < m.s) {
          if (!isRootAtChange) removeSet.add(i);
        } else if (n.s < gs && n.s + n.d > gs) {
          n.d = gs - n.s;
        }
      });
      gaps.push({ s: m.s, p: m.p });
    }

    // C. コードの切り替わりを明瞭に: またぐ音を切る。低〜中音域の「次のコードに合わない音」は消す
    for (const reg of ctx.regions) {
      const B = reg.start;
      if (B === 0 || reg.chord.rest) continue;
      notes.forEach((n, i) => {
        if (removeSet.has(i)) return;
        if (n.s < B && n.s + n.d > B && !n.a) n.d = B - n.s;
        if (n.s >= B - 1 && n.s < B && !n.a && n.l !== 'top' && n.l !== 'bass') {
          if (n.p < 76 && !reg.info.safeSet.has(mod12(n.p))) removeSet.add(i);
        }
      });
    }

    // D. ベースを明瞭に: ベース音域に他パートを入れない
    const bassCeil = mood.reg.bass[1] + 1;
    notes.forEach((n, i) => {
      if (removeSet.has(i)) return;
      if (n.l === 'bass' || n.l === 'hit') return;
      if (n.p < bassCeil) {
        if (n.l === 'fill' || n.l === 'inner') removeSet.add(i);
      }
    });

    // E. 音価を短く: リリースカットは音価がそのまま音色になる
    const rShort = ctx.rng.fork('short');
    let kept = notes.filter((_, i) => !removeSet.has(i));
    kept.sort((a, b) => a.s - b.s || a.p - b.p);
    for (let i = 0; i < kept.length; i++) {
      const n = kept[i];
      // 同じレイヤーの次の音に食い込まないように
      if (n.l === 'bass' && !n.h) {
        for (let j = i + 1; j < kept.length; j++) {
          const m = kept[j];
          if (m.l === 'bass' && !m.h && m.s > n.s) {
            n.d = Math.min(n.d, m.s - n.s);
            break;
          }
        }
        // 長いベースは少し切って次を立てる
        if (n.d >= 3 && rShort.chance(0.7)) n.d -= 1;
      } else if (n.l === 'inner' && n.stab) {
        n.d = Math.min(n.d, mood.stabLen);
      } else if (n.l === 'hit') {
        n.d = Math.min(n.d, 3);
      } else if (n.l === 'fill') {
        n.d = Math.min(n.d, n.fillType === 'flurry' ? 0.5 : 1);
      } else if (n.l === 'top' && !n.h) {
        for (let j = i + 1; j < kept.length; j++) {
          const m = kept[j];
          if (m.l === 'top' && !m.h && m.s > n.s) {
            n.d = Math.min(n.d, m.s - n.s);
            break;
          }
        }
      }
    }

    // F. 目標の音数まで、大事でない「まとまり」から間引く(穴だらけのランにしないため)
    const target = mood.notesPerBar * (barSteps / 16);
    const byBar = new Map();
    for (const n of kept) {
      const b = barOf(ctx, n.s);
      if (!byBar.has(b)) byBar.set(b, []);
      byBar.get(b).push(n);
    }
    const dropGroups = new Set();
    const dropNotes = new Set();
    const rPrune = ctx.rng.fork('prune');
    for (const [b, list] of byBar) {
      let count = list.filter((n) => !dropGroups.has(n.g) && !dropNotes.has(n)).length;
      // 飽和用の刻み(オスティナート)は工程3のための足場なので、音数が足りない分だけ残す
      const ost = rPrune.shuffle(list.filter((n) => n.o));
      const floor = target * 0.85;
      for (const n of ost) {
        if (count <= floor) break;
        dropNotes.add(n);
        count--;
      }
      if (count <= target) continue;
      const groups = new Map();
      for (const n of list) {
        if (!n.g || dropGroups.has(n.g) || n.o) continue;
        if (!groups.has(n.g)) groups.set(n.g, []);
        groups.get(n.g).push(n);
      }
      const ranked = [...groups.values()]
        .filter((g) => g[0].l !== 'bass' && g[0].l !== 'hit')
        .map((g) => ({ g, imp: noteImportance(g[0]) + rPrune.next() * 1.5 - g.length * 0.02 }))
        .sort((a, b) => a.imp - b.imp);
      for (const { g } of ranked) {
        if (count <= target) break;
        dropGroups.add(g[0].g);
        count -= g.length;
      }
    }
    kept = kept.filter((n) => !dropNotes.has(n) && !(n.g && dropGroups.has(n.g)));

    return { notes: kept, gaps, breaks };
  }

  // ------------------------------------------------------------------ stage 5: finalize
  function fixClashes(ctx, notes) {
    const removed = new Set();
    const rank = (n) => {
      if (n.l === 'bass' && !n.h && (n.a || regAt(ctx, n.s).start === n.s)) return 7;
      if (n.l === 'top' && !n.h) return 6;
      if (n.l === 'bass' && !n.h) return 5;
      if (n.l === 'top') return 4;
      if (n.l === 'hit') return 3.5;
      if (n.l === 'bass') return 3;
      if (n.l === 'inner') return 2;
      return 1;
    };
    const sorted = notes.slice().sort((a, b) => a.s - b.s);
    for (let i = 0; i < sorted.length; i++) {
      const a = sorted[i];
      if (removed.has(a)) continue;
      for (let j = i + 1; j < sorted.length; j++) {
        const b = sorted[j];
        if (b.s >= a.s + a.d) break;
        if (removed.has(b)) continue;
        const iv = Math.abs(a.p - b.p);
        const m = iv % 12;
        // 短2度・短9度は事故音。ただし速いパッセージの一瞬(16分未満の重なり)は許す
        const overlap = Math.min(a.s + a.d, b.s + b.d) - Math.max(a.s, b.s);
        if (overlap < 0.75) continue;
        const reg = regAt(ctx, b.s);
        if (reg.chord.rest) continue;
        const bothChord = reg.info.ctSet.has(mod12(a.p)) && reg.info.ctSet.has(mod12(b.p));
        const harsh = m === 1 || (m === 11 && iv === 11 && !bothChord);
        const lowCluster = iv <= 2 && Math.min(a.p, b.p) < 52;
        if ((harsh && !bothChord) || lowCluster) {
          const loser = rank(a) >= rank(b) ? b : a;
          removed.add(loser);
          if (loser === a) break;
        }
      }
    }
    return notes.filter((n) => !removed.has(n));
  }

  function dedupe(notes) {
    const map = new Map();
    const rankL = { top: 4, bass: 3, hit: 2, inner: 1, fill: 0 };
    for (const n of notes) {
      const key = n.s + ':' + n.p;
      const old = map.get(key);
      if (!old) map.set(key, n);
      else {
        const keepNew = (rankL[n.l] || 0) - (n.h ? 0.5 : 0) > (rankL[old.l] || 0) - (old.h ? 0.5 : 0);
        const longer = Math.max(n.d, old.d);
        const winner = keepNew ? n : old;
        winner.d = longer;
        map.set(key, winner);
      }
    }
    const out = [...map.values()].sort((a, b) => a.s - b.s || a.p - b.p);
    // 同じ鍵盤の重なりはMIDIで事故るので必ず解消する
    const lastByPitch = new Map();
    for (const n of out) {
      const last = lastByPitch.get(n.p);
      if (last && last.s + last.d > n.s) last.d = n.s - last.s;
      lastByPitch.set(n.p, n);
    }
    return out.filter((n) => n.d > 0.01);
  }

  function assignVelocity(ctx, notes) {
    const mood = ctx.mood;
    const { meter } = ctx.tl;
    const r = ctx.rng.fork('vel');
    const [oLo, oHi] = mood.vel.outer;
    const [iLo, iHi] = mood.vel.inner;
    const sorted = notes.slice().sort((a, b) => a.s - b.s);
    for (let i = 0; i < sorted.length; i++) {
      const n = sorted[i];
      let above = false;
      let below = false;
      for (let j = Math.max(0, i - 40); j < sorted.length; j++) {
        const m = sorted[j];
        if (m === n) continue;
        if (m.s > n.s) break;
        if (m.s + m.d > n.s) {
          if (m.p > n.p) above = true;
          if (m.p < n.p) below = true;
        }
      }
      // 動画の「内声 80-90 / 外声 100-115」。基本は役割で決め、線や決めは実際の位置で決める
      let outer = !above || !below;
      if (n.l === 'top' && !n.h) outer = true;
      if (n.l === 'bass' && !n.h) outer = true;
      if (n.l === 'inner') outer = false;
      const w = metricWeight(posOf(ctx, n.s), meter);
      const e = ctx.barEnergy[barOf(ctx, n.s)] || 0.8;
      let v;
      if (outer) {
        const t = clamp((w - 1) / 3 * 0.55 + (e - 0.6) * 0.8 + r.range(-0.12, 0.12), 0, 1);
        v = oLo + (oHi - oLo) * t;
      } else {
        const t = clamp((w - 1) / 3 * 0.6 + r.range(-0.2, 0.2) + 0.2, 0, 1);
        v = iLo + (iHi - iLo) * t;
      }
      if (n.l === 'top' && !n.h && n.e) v += 3;
      n.v = Math.round(clamp(v, 1, 127));
      n.outer = outer;
    }
    return notes;
  }

  // ------------------------------------------------------------------ evaluation
  function metrics(ctx, notes) {
    const { barSteps, totalSteps, meter } = ctx.tl;
    const bars = totalSteps / barSteps;
    let avoidStrong = 0;
    let strongTotal = 0;
    let strongStable = 0;
    let harsh = 0;
    let lowMud = 0;
    const main = notes.filter((n) => n.l === 'top' && !n.h).sort((a, b) => a.s - b.s);
    for (const n of main) {
      const reg = regAt(ctx, n.a ? n.s + n.d : n.s);
      if (reg.chord.rest) continue;
      const w = metricWeight(posOf(ctx, n.s), meter);
      if (w >= 3 || n.d >= 3) {
        strongTotal++;
        const pc = mod12(n.p);
        if (reg.info.ctSet.has(pc) || reg.info.tensionSet.has(pc)) strongStable++;
        if (reg.info.avoidSet.has(pc)) avoidStrong++;
      }
    }
    const sorted = notes.slice().sort((a, b) => a.s - b.s);
    for (let i = 0; i < sorted.length; i++) {
      const a = sorted[i];
      for (let j = i + 1; j < sorted.length; j++) {
        const b = sorted[j];
        if (b.s >= a.s + a.d) break;
        const iv = Math.abs(a.p - b.p);
        const overlap = Math.min(a.s + a.d, b.s + b.d) - b.s;
        if (overlap >= 0.75) {
          const reg = regAt(ctx, b.s);
          if (reg.chord.rest) continue;
          const both = reg.info.ctSet.has(mod12(a.p)) && reg.info.ctSet.has(mod12(b.p));
          if (iv % 12 === 1 && !both) harsh++;
          if (iv > 0 && iv <= 4 && Math.min(a.p, b.p) < 48) lowMud++;
        }
      }
    }
    // 動機の反復: 小節ごとの top のリズムがどれだけ再利用されているか
    const rhythmByBar = [];
    for (let b = 0; b < bars; b++) {
      rhythmByBar.push(new Set(main.filter((n) => barOf(ctx, n.s) === b).map((n) => posOf(ctx, n.s))));
    }
    let recur = 0;
    let recurN = 0;
    for (let b = 1; b < bars; b++) {
      let bestSim = 0;
      for (let c = 0; c < b; c++) {
        const A = rhythmByBar[b];
        const B = rhythmByBar[c];
        if (!A.size || !B.size) continue;
        let hit = 0;
        for (const x of A) if (B.has(x)) hit++;
        bestSim = Math.max(bestSim, hit / Math.max(A.size, B.size));
      }
      recur += bestSim;
      recurN++;
    }
    const pitches = main.map((n) => n.p);
    return {
      noteCount: notes.length,
      notesPerBar: notes.length / bars,
      avoidStrong,
      strongTotal,
      strongStableRatio: strongTotal ? strongStable / strongTotal : 1,
      harsh,
      lowMud,
      motifRecurrence: recurN ? recur / recurN : 0,
      topRange: pitches.length ? Math.max(...pitches) - Math.min(...pitches) : 0,
      pitchMin: notes.length ? Math.min(...notes.map((n) => n.p)) : 0,
      pitchMax: notes.length ? Math.max(...notes.map((n) => n.p)) : 0,
    };
  }

  function scoreTake(ctx, take) {
    const m = metrics(ctx, take.notes);
    const target = ctx.mood.notesPerBar * (ctx.tl.barSteps / 16);
    let s = 0;
    s -= m.avoidStrong * 3;
    s -= m.harsh * 0.8;
    s -= m.lowMud * 0.4;
    s -= (Math.abs(m.notesPerBar - target) / target) * 6;
    s += Math.min(m.topRange, 22) / 5;
    s += (1 - Math.abs(m.motifRecurrence - 0.6)) * 5;
    s += m.strongStableRatio * 4;
    return { score: s, metrics: m };
  }

  // ------------------------------------------------------------------ one complete take
  function planPhrases(ctx) {
    const { bars } = ctx.tl;
    const phrases = [];
    let b = 0;
    let idx = 0;
    while (b < bars) {
      let len = Math.min(4, bars - b);
      // 1小節だけ余るなら直前と併せず単独の短いフレーズにする
      phrases.push({ idx, start: b, len });
      idx++;
      b += len;
    }
    const n = phrases.length;
    const r = ctx.rng.fork('plan');
    // 同じ動機を再提示するかどうか(AABA など)。全部新しいと聴き手が迷子になる
    const plans = { 1: [null], 2: [null, 0], 3: [null, 0, null], 4: [null, 0, null, 2] };
    const reusePlan = plans[n] || phrases.map((_, i) => (i % 2 === 1 ? i - 1 : null));
    phrases.forEach((ph, i) => {
      ph.reuseTheme = reusePlan[i] == null ? null : reusePlan[i];
      ph.lift = n > 1 ? (i / (n - 1)) * 3 : 0;
    });
    const energy = {};
    phrases.forEach((ph, i) => {
      const base = n > 1 ? 0.72 + (0.28 * i) / (n - 1) : 0.88;
      for (let j = 0; j < ph.len; j++) {
        const ramp = ph.len > 1 ? j / (ph.len - 1) : 1;
        energy[ph.start + j] = clamp(base + (ramp - 0.5) * 0.25 + r.range(-0.04, 0.04), 0.4, 1);
      }
    });
    return { phrases, energy };
  }

  function clean(n) {
    const out = { s: n.s, d: n.d, p: n.p, v: n.v, l: n.l };
    if (n.h) out.h = n.h;
    if (n.e) out.e = true;
    if (n.fillType) out.f = n.fillType;
    return out;
  }

  function composeTake(base, seed, input) {
    const rng = new Rng(seed);
    const baseMood = Moods.byId[input.mood] || Moods.MOODS[0];
    const mood = jitterMood(baseMood, rng.fork('mood'), input.overrides);
    const ctx = {
      ...base,
      mood,
      baseMood,
      rng,
      voicingCache: {},
      opts: { melodyCandidates: input.melodyCandidates || 14, temperature: input.temperature || 0.7 },
    };
    const { phrases, energy } = planPhrases(ctx);
    ctx.phrases = phrases;
    ctx.barEnergy = energy;

    // 1. 仮ベース・仮コード
    const bass = genBass(ctx);
    const scribble = genScribble(ctx);
    const stage1 = dedupe([...bass, ...scribble].map((n) => ({ ...n })));

    // 2. フレーズ
    const top = genTopLine(ctx);
    const harm = harmonize(ctx, top);
    const textures = genTextures(ctx, top);
    const hits = genHits(ctx, top);
    const stage2Raw = [...bass, ...top, ...harm, ...textures, ...hits];
    const stage2 = dedupe(stage2Raw.map((n) => ({ ...n })));

    // 3. 音で埋め尽くす
    const fills = genFills(ctx, [...top, ...harm], [...bass, ...textures, ...hits]);
    const stage3 = dedupe([...stage2Raw, ...fills].map((n) => ({ ...n })));

    // 4. 隙間を開ける
    const carved = carve(ctx, stage3);
    let stage4 = dedupe(carved.notes);
    assignVelocity(ctx, stage4);

    // 5. 完成: 事故音を除いて仕上げ
    let final = fixClashes(ctx, stage4.map((n) => ({ ...n })));
    final = dedupe(final);
    assignVelocity(ctx, final);

    return { ctx, stage1, stage2, stage3, stage4, final, gaps: carved.gaps, breaks: carved.breaks };
  }

  // ------------------------------------------------------------------ explanation
  function rhythmText(cell) {
    return cell.rhythm.map((x) => (x.rest ? '(' + x.dur + ')' : x.dur)).join('+');
  }

  function describe(take, metricsObj) {
    const ctx = take.ctx;
    const lines = [];
    const form = {};
    ctx.phrases.forEach((ph) => {
      const th = ph.theme;
      const bars = `${ph.start + 1}〜${ph.start + ph.len}小節`;
      if (ph.reuseTheme != null) {
        lines.push({ k: bars, t: `${ctx.phrases[ph.reuseTheme].start + 1}小節目からの動機を再提示。結末だけ「${th.cells.z.kind}」に変えて前に進める` });
      } else {
        const a = th.cells.a;
        lines.push({
          k: bars,
          t: `動機A は ${rhythmText(a)}(16分単位)の${CONTOUR_JA[a.kind] || a.kind}。形式 ${th.form.slice(-ph.len).join(' → ')}、結末は「${th.cells.z.kind}」。旋律候補 ${ph.candidates} 本を採点して選択`,
        });
      }
    });
    const bassStyles = [...new Set(ctx.phrases.map((p) => BASS_JA[p.bassStyle] || p.bassStyle))];
    lines.push({ k: 'ベース', t: bassStyles.join(' / ') });
    const comps = [...new Set(ctx.phrases.map((p) => p.compPattern.join('+')))];
    const tu = ctx.textureUsage || {};
    const texText = Object.keys(tu).filter((k) => k !== 'rest').sort((a, b) => tu[b] - tu[a]).map((k) => `${TEXTURE_JA[k]} ${tu[k]}`).join('・');
    lines.push({ k: '内声', t: `2拍ごとに ${texText}。刻みのリズムは ${comps.join(' / ')}` });
    const hc = ctx.harmCounts || {};
    const harmParts = [];
    if (hc.oct) harmParts.push(`8度 ${hc.oct}`);
    if (hc.fifth) harmParts.push(`5度 ${hc.fifth}`);
    if (hc.double) harmParts.push(`2重 ${hc.double}`);
    if (hc.third) harmParts.push(`3度 ${hc.third}`);
    lines.push({ k: 'ハモり', t: harmParts.length ? harmParts.join('・') + ' 動機' : 'なし' });
    const fu = ctx.fillUsed || {};
    const fillText = Object.keys(fu).map((k) => `${FILL_JA[k] || k} ${fu[k]}`).join('・');
    if (fillText) lines.push({ k: '継ぎ足し', t: fillText });
    lines.push({ k: '隙間', t: `旋律の直前の無音 ${take.gaps.length} か所、ブレイク ${take.breaks.length} か所` });
    lines.push({
      k: '仕上がり',
      t: `1小節あたり ${metricsObj.notesPerBar.toFixed(1)} 音、最高音域 ${metricsObj.topRange} 半音、強拍の安定音率 ${Math.round(metricsObj.strongStableRatio * 100)}%`,
    });
    return lines;
  }

  // ------------------------------------------------------------------ public API
  function compose(input) {
    const base = prepare(input);
    if (base.errors) return { errors: base.errors };
    const seed = (input.seed == null ? Math.floor(Math.random() * 0xffffffff) : input.seed) >>> 0;
    const takeCount = input.takes || 5;
    const master = new Rng(seed ^ hashStr(input.mood || ''));
    const pool = [];
    for (let i = 0; i < takeCount; i++) {
      const take = composeTake(base, Math.floor(master.next() * 0xffffffff), input);
      const { score, metrics: m } = scoreTake(take.ctx, { notes: take.final });
      pool.push({ take, score, metrics: m });
    }
    const chosen = pickSoftmax(master, pool, 1.2);
    const take = chosen.take;
    const ctx = take.ctx;
    const toNotes = (a) => a.map(clean).sort((x, y) => x.s - y.s || x.p - y.p);
    const topNotes = take.final.filter((n) => n.l === 'top' && !n.h).sort((a, b) => a.s - b.s);
    return {
      seed,
      moodId: ctx.baseMood.id,
      moodName: ctx.baseMood.name,
      bpm: ctx.baseMood.bpm,
      swing: ctx.baseMood.swing,
      key: base.key,
      keyName: T.keyName(base.key),
      meter: base.tl.meter,
      bars: base.tl.bars,
      barSteps: base.tl.barSteps,
      totalSteps: base.tl.totalSteps,
      regions: base.regions.map((r) => ({
        start: r.start,
        end: r.end,
        name: r.chord.name,
        rest: !!r.chord.rest,
        scale: r.info ? r.info.scaleName : '',
        avoid: r.info ? [...r.info.avoidSet].map((p) => T.pcName(p, r.chord.useFlat)) : [],
        tensions: r.info ? [...r.info.tensionSet].map((p) => T.pcName(p, r.chord.useFlat)) : [],
      })),
      stages: {
        1: toNotes(take.stage1),
        2: toNotes(take.stage2),
        3: toNotes(take.stage3),
        4: toNotes(take.stage4),
        5: toNotes(take.final),
      },
      notes: toNotes(take.final),
      gaps: take.gaps,
      breaks: take.breaks,
      score: chosen.score,
      metrics: chosen.metrics,
      fingerprint: fingerprint(topNotes),
      thoughts: describe(take, chosen.metrics),
      takesTried: pool.length,
    };
  }

  /**
   * 直前までの旋律に似ていないものを選ぶ。
   * 記憶を採点に混ぜると同じシードで再現できなくなるので、シードを選ぶ段階でだけ使う。
   * 返ってきた結果は seed だけで完全に再現できる。
   */
  function composeNovel(input, memory, tries) {
    const list = memory || [];
    let best = null;
    let bestSim = Infinity;
    const n = tries || 5;
    for (let i = 0; i < n; i++) {
      const song = compose({ ...input, seed: Math.floor(Math.random() * 0xffffffff) });
      if (song.errors) return song;
      let worst = 0;
      for (const fp of list) worst = Math.max(worst, similarity(song.fingerprint, fp));
      if (worst < bestSim) { bestSim = worst; best = song; }
      if (worst < 0.12) break;
    }
    best.novelty = 1 - bestSim;
    return best;
  }

  /**
   * 気に入った小節を固定して、残りだけ作り直す。
   * prev の固定小節と next のそれ以外をつなぎ、境界をまたぐ音は小節線で切る。
   */
  function mergeLocked(prev, next, lockedBars) {
    if (!lockedBars.length || prev.totalSteps !== next.totalSteps || prev.barSteps !== next.barSteps) return next;
    const set = new Set(lockedBars);
    const bs = next.barSteps;
    const locked = (s) => set.has(Math.floor(s / bs));
    const merge = (a, b) => {
      const keepNew = b.filter((n) => !locked(n.s)).map((n) => {
        const copy = { ...n };
        const nextBar = (Math.floor(n.s / bs) + 1) * bs;
        if (copy.s + copy.d > nextBar && locked(nextBar)) copy.d = nextBar - copy.s;
        return copy;
      });
      const keepOld = a.filter((n) => locked(n.s)).map((n) => {
        const copy = { ...n };
        const nextBar = (Math.floor(n.s / bs) + 1) * bs;
        if (copy.s + copy.d > nextBar && !locked(nextBar)) copy.d = nextBar - copy.s;
        return copy;
      });
      return dedupe([...keepNew, ...keepOld]).map(clean);
    };
    const notes = merge(prev.notes, next.notes);
    return {
      ...next,
      notes,
      stages: { ...next.stages, 4: merge(prev.stages[4], next.stages[4]), 5: notes },
      gaps: [...next.gaps.filter((g) => !locked(g.s)), ...prev.gaps.filter((g) => locked(g.s))],
      breaks: [...next.breaks.filter((g) => !locked(g.start)), ...prev.breaks.filter((g) => locked(g.start))],
    };
  }

  return {
    compose,
    composeNovel,
    mergeLocked,
    metrics,
    prepare,
    fingerprint,
    similarity,
    Rng,
    MOODS: Moods.MOODS,
  };
});

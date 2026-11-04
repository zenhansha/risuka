/* りすかメーカー — 音楽理論レイヤー
 *
 * コード文字列 → 構成音、進行全体 → キー判定、各コード → コードスケール
 * までを担当する。ここが間違うと全部が間違うので、作曲エンジンとは分離してテストしている。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RisukaTheory = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const NAMES_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const NAMES_FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  const LETTER = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const mod12 = (n) => ((n % 12) + 12) % 12;

  // ------------------------------------------------------------------ scales
  const SCALES = {
    ionian: { iv: [0, 2, 4, 5, 7, 9, 11], ja: 'アイオニアン' },
    dorian: { iv: [0, 2, 3, 5, 7, 9, 10], ja: 'ドリアン' },
    phrygian: { iv: [0, 1, 3, 5, 7, 8, 10], ja: 'フリジアン' },
    lydian: { iv: [0, 2, 4, 6, 7, 9, 11], ja: 'リディアン' },
    mixolydian: { iv: [0, 2, 4, 5, 7, 9, 10], ja: 'ミクソリディアン' },
    aeolian: { iv: [0, 2, 3, 5, 7, 8, 10], ja: 'エオリアン' },
    locrian: { iv: [0, 1, 3, 5, 6, 8, 10], ja: 'ロクリアン' },
    melodicMinor: { iv: [0, 2, 3, 5, 7, 9, 11], ja: 'メロディックマイナー' },
    harmonicMinor: { iv: [0, 2, 3, 5, 7, 8, 11], ja: 'ハーモニックマイナー' },
    phrygianDominant: { iv: [0, 1, 4, 5, 7, 8, 10], ja: 'フリジアンドミナント' },
    lydianDominant: { iv: [0, 2, 4, 6, 7, 9, 10], ja: 'リディアンドミナント' },
    mixolydianB13: { iv: [0, 2, 4, 5, 7, 8, 10], ja: 'ミクソリディアンb13' },
    altered: { iv: [0, 1, 3, 4, 6, 8, 10], ja: 'オルタード' },
    locrianNat2: { iv: [0, 2, 3, 5, 6, 8, 10], ja: 'ロクリアン♮2' },
    wholeTone: { iv: [0, 2, 4, 6, 8, 10], ja: 'ホールトーン' },
    dimWH: { iv: [0, 2, 3, 5, 6, 8, 9, 11], ja: 'ディミニッシュ(全半)' },
    dimHW: { iv: [0, 1, 3, 4, 6, 7, 9, 10], ja: 'コンビネーションディミニッシュ' },
    lydianAug: { iv: [0, 2, 4, 6, 8, 9, 11], ja: 'リディアンオーギュメント' },
  };

  // ------------------------------------------------------------------ chord symbol
  function normalizeText(s) {
    return String(s == null ? '' : s)
      .normalize('NFKC')
      .replace(/♯/g, '#')
      .replace(/♭/g, 'b')
      .replace(/[△Δ∆]7/g, 'M7')
      .replace(/[△Δ∆]9/g, 'M9')
      .replace(/[△Δ∆]/g, 'M7')
      .replace(/[øØ]7?/g, 'm7b5')
      .replace(/[°˚]/g, 'dim');
  }

  function parseQuality(q0) {
    let q = q0
      .replace(/[()\s,]/g, '')
      .replace(/maj/gi, 'M')
      .replace(/^ma(?=\d|$)/i, 'M')
      .replace(/^mi(?=\d|$)/, 'm')
      .replace(/^min/i, 'm')
      .replace(/^-(?=\d|$|M)/, 'm');

    let third = 4;
    let fifth = 7;
    let seventh = null;
    const ext = new Set();
    let kind = null;
    let rest = q;
    let m;

    if ((m = /^(dim7|o7)/.exec(rest))) {
      third = 3; fifth = 6; seventh = 9; kind = 'dim'; rest = rest.slice(m[0].length);
    } else if ((m = /^(dim|o)(?!m)/.exec(rest))) {
      third = 3; fifth = 6; kind = 'dim'; rest = rest.slice(m[0].length);
    } else if ((m = /^(m7[-b]5|mb5|m[-]5)/.exec(rest))) {
      third = 3; fifth = 6; if (/7/.test(m[0])) { seventh = 10; kind = 'hdim'; } else kind = 'dim';
      rest = rest.slice(m[0].length);
    } else if ((m = /^(aug|\+)(?=$|\d|M)/.exec(rest))) {
      fifth = 8; kind = 'aug'; rest = rest.slice(m[0].length);
    } else if (/^m(?!aj)/.test(rest)) {
      third = 3; rest = rest.slice(1);
    }

    // 7th / 拡張
    if ((m = /^M(13|11|9|7)?/.exec(rest)) && m[0]) {
      const n = m[1];
      if (n) {
        seventh = 11;
        if (n === '9') ext.add(2);
        if (n === '11') { ext.add(2); ext.add(5); }
        if (n === '13') { ext.add(2); ext.add(9); }
      } else if (third === 3) {
        // mM → mM7 扱い
        seventh = 11;
      }
      rest = rest.slice(m[0].length);
    } else if ((m = /^(13|11|9|7|69|6)/.exec(rest))) {
      const n = m[1];
      if (n === '7') seventh = 10;
      if (n === '9') { seventh = 10; ext.add(2); }
      if (n === '11') {
        seventh = 10; ext.add(2); ext.add(5);
        if (third === 4) third = null;
      }
      if (n === '13') { seventh = 10; ext.add(2); ext.add(9); }
      if (n === '6') ext.add(9);
      if (n === '69') { ext.add(9); ext.add(2); }
      rest = rest.slice(m[0].length);
    } else if (/^5(?!\d)/.test(rest)) {
      third = null; kind = 'power'; rest = rest.slice(1);
    }

    // 修飾子
    let guard = 0;
    while (rest.length && guard++ < 16) {
      if ((m = /^sus(4|2)?/.exec(rest))) {
        third = m[1] === '2' ? 2 : 5;
        kind = 'sus';
      } else if ((m = /^add(b|#)?(13|11|9|6|4|2)/.exec(rest))) {
        const base = { 2: 2, 4: 5, 6: 9, 9: 2, 11: 5, 13: 9 }[m[2]];
        if (base == null) return null;
        ext.add(mod12(base + (m[1] === 'b' ? -1 : m[1] === '#' ? 1 : 0)));
      } else if ((m = /^(omit|no)(\d)/.exec(rest))) {
        if (m[2] === '3') { third = null; if (!kind) kind = 'power'; }
        if (m[2] === '5') fifth = null;
      } else if ((m = /^alt/.exec(rest))) {
        ext.add(1); ext.add(3); ext.add(6); ext.add(8);
        fifth = null;
        kind = 'alt';
      } else if ((m = /^([b#+-])(13|11|9|5)/.exec(rest))) {
        const up = m[1] === '#' || m[1] === '+';
        const n = m[2];
        if (n === '5') fifth = up ? 8 : 6;
        else if (n === '9') ext.add(up ? 3 : 1);
        else if (n === '11') ext.add(up ? 6 : 4);
        else if (n === '13') ext.add(up ? 10 : 8);
        else return null;
      } else if ((m = /^(9|11|13)/.exec(rest))) {
        // C7(9) や CM7(13) のような括弧テンション
        ext.add({ 9: 2, 11: 5, 13: 9 }[m[1]]);
      } else {
        return null;
      }
      rest = rest.slice(m[0].length);
    }
    if (rest.length) return null;

    if (!kind) {
      if (third === 3) kind = seventh === 11 ? 'minMaj' : 'min';
      else if (third === 4) kind = seventh === 10 ? 'dom' : 'maj';
      else if (third === 5 || third === 2) kind = 'sus';
      else if (third === null) kind = seventh === 10 ? 'sus' : 'power';
      else kind = 'maj';
    }
    return { third, fifth, seventh, ext: [...ext], kind };
  }

  /** "F#m7(b5)/A" のような1トークンを解析する。解析できなければ null。 */
  function parseChord(token) {
    const t = normalizeText(token).trim();
    if (!t) return null;
    if (/^(n\.?c\.?|ノーコード)$/i.test(t)) return { rest: true, name: 'N.C.' };
    const m = /^([A-Ga-g])([#b]?)(.*)$/.exec(t);
    if (!m) return null;
    const rootLetter = m[1].toUpperCase();
    let root = mod12(LETTER[rootLetter] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0));
    let body = m[3];
    let bass = null;
    const slash = /\/([A-Ga-g])([#b]?)$/.exec(body);
    if (slash) {
      bass = mod12(LETTER[slash[1].toUpperCase()] + (slash[2] === '#' ? 1 : slash[2] === 'b' ? -1 : 0));
      body = body.slice(0, slash.index);
    }
    const q = parseQuality(body);
    if (!q) return null;
    const core = [0, q.third, q.fifth, q.seventh].filter((x) => x != null);
    const ivs = [...new Set([...core, ...q.ext])];
    const useFlat = m[2] === 'b' || [1, 3, 5, 8, 10].includes(root) && m[2] !== '#';
    return {
      name: t,
      root,
      rootName: rootLetter + m[2],
      bass: bass == null ? root : bass,
      slash: bass != null,
      kind: q.kind,
      third: q.third == null ? null : mod12(root + q.third),
      fifth: q.fifth == null ? null : mod12(root + q.fifth),
      seventh: q.seventh == null ? null : mod12(root + q.seventh),
      thirdIv: q.third,
      fifthIv: q.fifth,
      seventhIv: q.seventh,
      core: core.map((iv) => mod12(root + iv)),
      ext: q.ext.map((iv) => mod12(root + iv)),
      extIv: q.ext,
      pcs: ivs.map((iv) => mod12(root + iv)),
      useFlat,
    };
  }

  const ROMAN = { i: 0, ii: 2, iii: 4, iv: 5, v: 7, vi: 9, vii: 11 };
  /** "IVM7" "bVII" "iii7" を、与えたキー基準のコード名に変換する。ローマ数字でなければ null。 */
  function romanToChord(token, keyPc) {
    const m = /^([b#]?)(VII|VI|IV|V|III|II|I|vii|vi|iv|v|iii|ii|i)(.*)$/.exec(token);
    if (!m) return null;
    const off = ROMAN[m[2].toLowerCase()];
    const pc = mod12(keyPc + off + (m[1] === 'b' ? -1 : m[1] === '#' ? 1 : 0));
    const isMinor = m[2] === m[2].toLowerCase();
    const useFlat = m[1] === 'b' || [5, 3, 10, 8, 1].includes(keyPc);
    const name = (useFlat ? NAMES_FLAT : NAMES_SHARP)[pc];
    let body = m[3];
    if (isMinor && !/^(dim|o|m)/.test(body)) body = 'm' + body;
    return name + body;
  }

  // ------------------------------------------------------------------ progression text
  const METERS = {
    '4/4': { id: '4/4', barSteps: 16, groups: [4, 4, 4, 4], num: 4, den: 4 },
    '3/4': { id: '3/4', barSteps: 12, groups: [4, 4, 4], num: 3, den: 4 },
    '5/4': { id: '5/4', barSteps: 20, groups: [4, 4, 4, 4, 4], num: 5, den: 4 },
    '6/8': { id: '6/8', barSteps: 12, groups: [6, 6], num: 6, den: 8 },
    '7/8': { id: '7/8', barSteps: 14, groups: [4, 4, 6], num: 7, den: 8 },
  };

  function splitEvenly(total, n, grid) {
    // 拍の上に落ちるように分割する(16ステップを3分割 → 8,4,4)
    if (n === 1) return [total];
    const unit = grid || 4;
    const units = Math.floor(total / unit);
    if (units >= n) {
      const base = Math.floor(units / n);
      const out = new Array(n).fill(base * unit);
      let left = total - base * unit * n;
      for (let i = 0; left > 0; i = (i + 1) % n) {
        const add = Math.min(unit * base, left);
        out[i] += add;
        left -= add;
      }
      return out;
    }
    const out = new Array(n).fill(Math.floor(total / n));
    out[0] += total - out.reduce((a, b) => a + b, 0);
    return out;
  }

  /**
   * コード進行の文字列をタイムラインへ変換する。
   *   "F G Em Am"          → 1コード1小節
   *   "F G | Em Am"        → | で小節を区切る(中は均等割り)
   *   "C:2 G:2 | Am"       → :拍数 で長さ指定
   *   "C - G - | Am"       → - で前のコードを伸ばす
   *   "%"                  → 前の小節の繰り返し
   *   "IV V iii vi"        → ローマ数字(keyHint基準)
   */
  function parseProgression(text, opts) {
    const options = opts || {};
    const meter = METERS[options.meter || '4/4'];
    const keyHint = options.keyHint == null ? 0 : options.keyHint;
    let s = normalizeText(text);
    s = s.replace(/\(([^)]*)\)/g, (a, b) => '(' + b.replace(/[,、\s]+/g, '') + ')');
    s = s
      .replace(/\|\|:|:\|\||\|\|/g, '|')
      .replace(/→|⇒|->|、|,|・|〜|~/g, ' ');
    const hasBar = /\|/.test(s);
    s = hasBar ? s.replace(/[\r\n]+/g, ' | ') : s.replace(/[\r\n]+/g, ' ');
    const barChunks = hasBar
      ? s.split('|').map((x) => x.trim()).filter(Boolean)
      : s.trim().split(/\s+/).filter(Boolean);
    const errors = [];
    const bars = [];

    const resolve = (raw) => {
      const roman = romanToChord(raw, keyHint);
      const c = parseChord(roman || raw);
      if (!c) errors.push(raw);
      return c;
    };

    for (const chunk of barChunks) {
      if (chunk === '%') {
        if (bars.length) bars.push(bars[bars.length - 1].map((x) => ({ ...x })));
        continue;
      }
      const tokens = chunk.split(/\s+/).filter(Boolean);
      const items = [];
      for (const tk of tokens) {
        if (tk === '-' || tk === '.' || tk === 'ー' || tk === '−') {
          if (items.length) items.push({ hold: true });
          else if (bars.length) {
            const lastBar = bars[bars.length - 1];
            items.push({ chord: lastBar[lastBar.length - 1].chord });
          }
          continue;
        }
        const m = /^(.+?):(\d+(?:\.\d+)?)$/.exec(tk);
        const c = resolve(m ? m[1] : tk);
        if (!c) continue;
        items.push({ chord: c, beats: m ? parseFloat(m[2]) : null });
      }
      if (!items.length) continue;
      // hold を前のコードの伸ばしへ畳む
      const slots = [];
      for (const it of items) {
        if (it.hold) slots[slots.length - 1].weight += 1;
        else slots.push({ chord: it.chord, beats: it.beats, weight: 1 });
      }
      bars.push(slots);
    }

    if (!bars.length) return { errors, regions: [], meter, bars: 0, barSteps: meter.barSteps, totalSteps: 0, srcBars: 0 };

    const repeat = Math.max(1, options.repeat || 1);
    const minBars = options.minBars || 4;
    const srcBars = bars.length;
    let loops = repeat;
    while (srcBars * loops < minBars) loops *= 2;

    const regions = [];
    let cursor = 0;
    const emit = (slots) => {
      const barSteps = meter.barSteps;
      const explicit = slots.some((x) => x.beats != null);
      let lengths;
      if (explicit) {
        const beatSteps = meter.den === 8 ? 2 : 4;
        lengths = slots.map((x) => (x.beats == null ? 0 : Math.round(x.beats * beatSteps)));
        const used = lengths.reduce((a, b) => a + b, 0);
        const zeros = lengths.filter((x) => x === 0).length;
        if (zeros) {
          const share = Math.max(0, barSteps - used);
          let z = splitEvenly(share, zeros, 2);
          lengths = lengths.map((x) => (x === 0 ? z.shift() : x));
        } else if (used !== barSteps) {
          lengths[lengths.length - 1] += barSteps - used;
          if (lengths[lengths.length - 1] <= 0) lengths[lengths.length - 1] = Math.max(1, barSteps - used);
        }
      } else {
        const totalWeight = slots.reduce((a, b) => a + b.weight, 0);
        const unitLens = splitEvenly(barSteps, totalWeight, meter.den === 8 ? 2 : 4);
        let u = 0;
        lengths = slots.map((x) => {
          let sum = 0;
          for (let i = 0; i < x.weight; i++) sum += unitLens[u++];
          return sum;
        });
      }
      let at = cursor;
      slots.forEach((slot, i) => {
        regions.push({ start: at, end: at + lengths[i], chord: slot.chord });
        at += lengths[i];
      });
      cursor += barSteps;
    };

    for (let l = 0; l < loops; l++) for (const b of bars) emit(b);

    // 同じコードが小節線をまたいで続く場合はひとつに結合する(動機の連続性のため)
    const merged = [];
    for (const r of regions) {
      const last = merged[merged.length - 1];
      if (last && !r.chord.rest && !last.chord.rest && last.chord.name === r.chord.name) last.end = r.end;
      else merged.push({ ...r });
    }
    return {
      errors,
      regions: merged,
      meter,
      bars: cursor / meter.barSteps,
      barSteps: meter.barSteps,
      totalSteps: cursor,
      srcBars,
      loops,
    };
  }

  // ------------------------------------------------------------------ key detection
  const MAJOR = [0, 2, 4, 5, 7, 9, 11];
  const MINOR = [0, 2, 3, 5, 7, 8, 10];
  const MAJOR_TRIADS = { 0: 'maj', 2: 'min', 4: 'min', 5: 'maj', 7: 'maj', 9: 'min', 11: 'dim' };
  const MINOR_TRIADS = { 0: 'min', 2: 'dim', 3: 'maj', 5: 'min', 7: 'min', 8: 'maj', 10: 'maj' };

  const triadClass = (c) => {
    if (c.kind === 'min' || c.kind === 'minMaj') return 'min';
    if (c.kind === 'dim' || c.kind === 'hdim') return 'dim';
    if (c.kind === 'maj' || c.kind === 'dom') return 'maj';
    return null;
  };

  function detectKey(regions) {
    const chords = regions.filter((r) => !r.chord.rest);
    if (!chords.length) return { tonic: 0, mode: 'major', confidence: 0, scale: MAJOR };
    let best = null;
    const results = [];
    for (let tonic = 0; tonic < 12; tonic++) {
      for (const mode of ['major', 'minor']) {
        const ivs = mode === 'major' ? MAJOR : MINOR;
        const set = new Set(ivs.map((x) => mod12(tonic + x)));
        const triads = mode === 'major' ? MAJOR_TRIADS : MINOR_TRIADS;
        let s = 0;
        let weightSum = 0;
        chords.forEach((r, i) => {
          const c = r.chord;
          const w = (r.end - r.start) / 16;
          weightSum += w;
          const inScale = c.pcs.filter((p) => set.has(p)).length / c.pcs.length;
          s += w * inScale * inScale * 2;
          const deg = mod12(c.root - tonic);
          if (set.has(c.root)) s += 0.25 * w;
          const cls = triadClass(c);
          if (triads[deg] && cls === triads[deg]) s += 0.7 * w;
          // 短調のV(和声短音階)は加点
          if (mode === 'minor' && deg === 7 && (c.kind === 'maj' || c.kind === 'dom')) s += 0.55 * w;
          // ドミナント解決
          const next = chords[(i + 1) % chords.length].chord;
          if ((c.kind === 'dom' || c.kind === 'maj') && deg === 7 && next.root === tonic) {
            s += (c.kind === 'dom' ? 1.3 : 0.6);
          }
        });
        const first = chords[0].chord;
        const last = chords[chords.length - 1].chord;
        const tonicCls = mode === 'major' ? 'maj' : 'min';
        if (first.root === tonic && triadClass(first) === tonicCls) s += 0.8;
        if (last.root === tonic && triadClass(last) === tonicCls) s += 1.0;
        results.push({ tonic, mode, score: s });
        if (!best || s > best.score + 1e-9) best = { tonic, mode, score: s };
      }
    }
    results.sort((a, b) => b.score - a.score);
    const second = results[1];
    const conf = Math.max(0, Math.min(1, (best.score - second.score) / Math.max(1, best.score) + 0.5));
    return {
      tonic: best.tonic,
      mode: best.mode,
      confidence: conf,
      scale: best.mode === 'major' ? MAJOR : MINOR,
      score: best.score,
    };
  }

  function keyName(key) {
    const flats = key.mode === 'major' ? [5, 10, 3, 8, 1, 6] : [2, 7, 0, 5, 10, 3];
    const useFlat = flats.includes(key.tonic);
    const n = (useFlat ? NAMES_FLAT : NAMES_SHARP)[key.tonic];
    return n + (key.mode === 'major' ? 'メジャー' : 'マイナー');
  }

  // ------------------------------------------------------------------ chord scale
  function matchMode(ivs) {
    const sig = ivs.slice().sort((a, b) => a - b).join(',');
    for (const id of Object.keys(SCALES)) {
      if (SCALES[id].iv.join(',') === sig) return id;
    }
    return null;
  }

  function chooseNonDiatonicScale(chord, next, keySet) {
    const k = chord.kind;
    const has = (iv) => chord.extIv.includes(iv);
    if (k === 'alt') return 'altered';
    if (k === 'dom') {
      if (has(6)) return 'lydianDominant';
      if (chord.fifthIv === 8 && !has(1) && !has(3)) return 'wholeTone';
      if (has(1) || has(3)) return has(9) ? 'dimHW' : 'altered';
      if (has(8)) return 'mixolydianB13';
      if (next && !next.rest) {
        const down5 = mod12(chord.root - next.root) === 7;
        const downHalf = mod12(chord.root - next.root) === 1;
        if (down5) {
          const nextMinor = next.kind === 'min' || next.kind === 'minMaj' || next.kind === 'hdim';
          if (nextMinor) return 'phrygianDominant';
          return 'mixolydian';
        }
        if (downHalf) return 'lydianDominant';
      }
      return 'lydianDominant';
    }
    if (k === 'maj') {
      if (chord.seventhIv === 11 || has(6)) return 'lydian';
      if (keySet.has(mod12(chord.root + 5))) return 'ionian';
      return 'lydian';
    }
    if (k === 'minMaj') return 'melodicMinor';
    if (k === 'min') {
      if (has(9)) return 'melodicMinor';
      return keySet.has(mod12(chord.root + 8)) && !keySet.has(mod12(chord.root + 9)) ? 'aeolian' : 'dorian';
    }
    if (k === 'hdim') return has(2) ? 'locrianNat2' : 'locrian';
    if (k === 'dim') return chord.seventhIv === 9 ? 'dimWH' : 'locrian';
    if (k === 'aug') return chord.seventhIv === 11 ? 'lydianAug' : 'wholeTone';
    if (k === 'sus' || k === 'power') return 'mixolydian';
    return 'ionian';
  }

  function analyzeChord(chord, key, next) {
    const keySet = new Set(key.scale.map((x) => mod12(key.tonic + x)));
    let scaleId;
    let pcs;
    const diatonic = chord.pcs.every((p) => keySet.has(p));
    if (diatonic && chord.kind !== 'minMaj') {
      const rel = [...keySet].map((p) => mod12(p - chord.root));
      scaleId = matchMode(rel) || 'ionian';
      pcs = [...keySet];
    } else {
      scaleId = chooseNonDiatonicScale(chord, next, keySet);
      pcs = SCALES[scaleId].iv.map((iv) => mod12(chord.root + iv));
    }

    // コードトーンを必ずスケールに含める(ぶつかる隣接音は外す)
    const set = new Set(pcs);
    for (const c of chord.pcs) {
      if (!set.has(c)) {
        set.delete(mod12(c + 1));
        set.delete(mod12(c - 1));
        set.add(c);
      }
    }
    if (chord.slash) set.add(chord.bass);

    const ctSet = new Set(chord.pcs);
    if (chord.slash) ctSet.add(chord.bass);
    const avoid = new Set();
    const tension = new Set();
    for (const p of set) {
      if (ctSet.has(p)) continue;
      const above = ctSet.has(mod12(p - 1));
      let isAvoid = above;
      if (chord.kind === 'dom' || chord.kind === 'alt') {
        // ドミナントのb9/b13は緊張感として使える。4度だけがアボイド
        isAvoid = chord.third != null && mod12(p - chord.third) === 1 && mod12(p - chord.root) === 5;
      }
      if (chord.kind === 'sus') isAvoid = chord.root != null && mod12(p - chord.root) === 4;
      if (isAvoid) avoid.add(p);
      else tension.add(p);
    }
    if (chord.kind === 'sus') {
      const major3 = mod12(chord.root + 4);
      set.delete(major3);
      avoid.delete(major3);
    }

    const sorted = [...set].sort((a, b) => a - b);
    const safe = sorted.filter((p) => !avoid.has(p));
    // ペンタトニック的な「外しようのない音」集合
    const penta = safe.filter((p) => {
      if (ctSet.has(p)) return true;
      return !safe.some((q) => q !== p && ctSet.has(q) && Math.min(mod12(p - q), mod12(q - p)) === 1);
    });

    return {
      scaleId,
      scaleName: SCALES[scaleId] ? SCALES[scaleId].ja : scaleId,
      scale: sorted,
      scaleSet: set,
      safe,
      safeSet: new Set(safe),
      penta: penta.length >= 3 ? penta : safe,
      ctSet,
      core: chord.core,
      coreSet: new Set(chord.core),
      avoidSet: avoid,
      tensionSet: tension,
      guide: [chord.third, chord.seventh].filter((x) => x != null),
    };
  }

  function pcName(pc, useFlat) {
    return (useFlat ? NAMES_FLAT : NAMES_SHARP)[mod12(pc)];
  }

  /** Logic 表記(中央ド = C3)のノート名 */
  function midiName(midi, flat) {
    const octave = Math.floor(midi / 12) - 2;
    return pcName(midi, flat) + octave;
  }

  return {
    NAMES_SHARP,
    NAMES_FLAT,
    SCALES,
    METERS,
    MAJOR,
    MINOR,
    mod12,
    normalizeText,
    parseChord,
    parseProgression,
    romanToChord,
    detectKey,
    keyName,
    analyzeChord,
    pcName,
    midiName,
  };
});

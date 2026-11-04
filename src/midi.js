/* りすかメーカー — 標準MIDIファイル(SMF Type 1)書き出し
 *
 * DAW に読み込んだあと音源のリリースを 0 にすれば、そのままリリースカットピアノになる。
 * 16分音符 = 120tick(PPQ 480)。動画と同じ1トラック出力と、パート別出力を選べる。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RisukaMidi = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PPQ = 480;
  const TICKS_PER_STEP = PPQ / 4;

  function vlq(n) {
    let v = Math.max(0, Math.round(n));
    const bytes = [v & 0x7f];
    v >>= 7;
    while (v > 0) {
      bytes.unshift((v & 0x7f) | 0x80);
      v >>= 7;
    }
    return bytes;
  }

  function utf8(str) {
    if (typeof TextEncoder !== 'undefined') return Array.from(new TextEncoder().encode(str));
    return Array.from(Buffer.from(str, 'utf8'));
  }

  function meta(type, data) {
    return [0xff, type, ...vlq(data.length), ...data];
  }

  function chunk(tag, body) {
    const len = body.length;
    return [
      ...tag.split('').map((c) => c.charCodeAt(0)),
      (len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255,
      ...body,
    ];
  }

  function swingOf(step, swing) {
    if (!swing) return step;
    return Math.floor(step) % 2 === 1 ? step + swing : step;
  }

  function trackFrom(events, name) {
    // events: [{t, order, bytes}]
    const sorted = events.slice().sort((a, b) => a.t - b.t || a.order - b.order);
    const body = [];
    if (name) body.push(0, ...meta(0x03, utf8(name)));
    let cursor = 0;
    for (const ev of sorted) {
      const t = Math.max(cursor, Math.round(ev.t));
      body.push(...vlq(t - cursor), ...ev.bytes);
      cursor = t;
    }
    body.push(0, 0xff, 0x2f, 0);
    return chunk('MTrk', body);
  }

  function noteEvents(notes, channel, swing, defaultVel) {
    const out = [];
    const st = 0x90 | channel;
    const off = 0x80 | channel;
    for (const n of notes) {
      const start = swingOf(n.s, swing) * TICKS_PER_STEP;
      const end = Math.max(start + 10, (swingOf(n.s, swing) + n.d) * TICKS_PER_STEP);
      const p = Math.max(0, Math.min(127, n.p));
      const v = Math.max(1, Math.min(127, n.v || defaultVel || 96));
      // 同じtickでは note off を先に出す(前の音を切ってから次を鳴らす)
      out.push({ t: start, order: 1, bytes: [st, p, v] });
      out.push({ t: end, order: 0, bytes: [off, p, 0] });
    }
    return out;
  }

  /**
   * @param {object} song compose() の結果
   * @param {object} opt  {notes, bpm, split, drums: notes[]}
   */
  function writeMidi(song, opt) {
    const o = opt || {};
    const bpm = o.bpm || song.bpm || 120;
    const notes = o.notes || song.notes;
    const swing = song.swing || 0;
    const tracks = [];

    // テンポ・拍子・コードマーカー
    const conductor = [];
    const uspq = Math.round(60000000 / bpm);
    conductor.push({ t: 0, order: 0, bytes: meta(0x51, [(uspq >> 16) & 255, (uspq >> 8) & 255, uspq & 255]) });
    const dd = Math.round(Math.log2(song.meter.den));
    conductor.push({ t: 0, order: 0, bytes: meta(0x58, [song.meter.num, dd, 24, 8]) });
    for (const r of song.regions) {
      conductor.push({ t: r.start * TICKS_PER_STEP, order: 1, bytes: meta(0x06, utf8(r.name)) });
    }
    tracks.push(trackFrom(conductor, 'Tempo / Chords'));

    if (o.split) {
      const parts = [
        { name: 'Bass', test: (n) => n.l === 'bass' },
        { name: 'Inner', test: (n) => n.l === 'inner' || n.l === 'hit' },
        { name: 'Top', test: (n) => n.l === 'top' },
        { name: 'Fill', test: (n) => n.l === 'fill' },
      ];
      parts.forEach((part, i) => {
        const list = notes.filter(part.test);
        if (list.length) tracks.push(trackFrom(noteEvents(list, i, swing), 'Release Cut Piano - ' + part.name));
      });
    } else {
      tracks.push(trackFrom(noteEvents(notes, 0, swing), 'Release Cut Piano'));
    }

    if (o.drums && o.drums.length) {
      tracks.push(trackFrom(noteEvents(o.drums, 9, 0, 100), 'Drums (guide)'));
    }

    const header = chunk('MThd', [0, 1, 0, tracks.length, (PPQ >> 8) & 255, PPQ & 255]);
    const all = header.concat(...tracks);
    return new Uint8Array(all);
  }

  /** テスト用: SMF を読み戻す最小パーサ */
  function readMidi(bytes) {
    const b = bytes;
    let i = 0;
    const u32 = () => { const v = (b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]; i += 4; return v >>> 0; };
    const u16 = () => { const v = (b[i] << 8) | b[i + 1]; i += 2; return v; };
    const tag = () => { const s = String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]); i += 4; return s; };
    const readVlq = () => { let v = 0; let c; do { c = b[i++]; v = (v << 7) | (c & 0x7f); } while (c & 0x80); return v; };
    if (tag() !== 'MThd') throw new Error('not MIDI');
    u32();
    const format = u16();
    const ntrks = u16();
    const division = u16();
    const tracks = [];
    for (let t = 0; t < ntrks; t++) {
      if (tag() !== 'MTrk') throw new Error('bad track');
      const len = u32();
      const end = i + len;
      let tick = 0;
      let status = 0;
      const events = [];
      while (i < end) {
        tick += readVlq();
        let s = b[i];
        if (s & 0x80) { status = s; i++; } else s = status;
        if (status === 0xff) {
          const type = b[i++];
          const l = readVlq();
          events.push({ tick, meta: type, data: Array.from(b.slice(i, i + l)) });
          i += l;
        } else {
          const hi = status & 0xf0;
          const a = b[i++];
          const c = hi === 0xc0 || hi === 0xd0 ? 0 : b[i++];
          events.push({ tick, status: hi, channel: status & 15, a, b: c });
        }
      }
      tracks.push(events);
    }
    return { format, ntrks, division, tracks };
  }

  return { writeMidi, readMidi, PPQ, TICKS_PER_STEP };
});

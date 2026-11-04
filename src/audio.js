/* りすかメーカー — 音声
 *
 * 動画の「0. 音源の準備」と同じ考え方をWebAudioで再現している。
 *   - 音はサンプル(本物のピアノ)。ダンパーのない高音域も含め、ノートオフで強制的に切る
 *   - ベロシティで音量だけでなくフィルターの開きも変える(動画のパッチの Velocity→Filter Cutoff)
 * リリース時間をスライダーで変えられるので、余韻があるとどれだけ別物になるかも聴き比べられる。
 */
(function (root) {
  'use strict';

  const SAMPLE_BASE = 'https://tonejs.github.io/audio/salamander/';
  const SAMPLE_NOTES = [
    ['C1', 24], ['Ds1', 27], ['Fs1', 30], ['A1', 33],
    ['C2', 36], ['Ds2', 39], ['Fs2', 42], ['A2', 45],
    ['C3', 48], ['Ds3', 51], ['Fs3', 54], ['A3', 57],
    ['C4', 60], ['Ds4', 63], ['Fs4', 66], ['A4', 69],
    ['C5', 72], ['Ds5', 75], ['Fs5', 78], ['A5', 81],
    ['C6', 84], ['Ds6', 87], ['Fs6', 90], ['A6', 93],
    ['C7', 96], ['Ds7', 99], ['Fs7', 102], ['A7', 105],
  ];

  // ---------------------------------------------------------------- 内蔵ピアノ(オフライン用の代替音源)
  function synthPianoBuffer(ctx, midi, seconds) {
    const sr = ctx.sampleRate;
    const N = Math.floor(sr * seconds);
    const buf = ctx.createBuffer(2, N, sr);
    const L = buf.getChannelData(0);
    const R = buf.getChannelData(1);
    const f0 = 440 * Math.pow(2, (midi - 69) / 12);
    const B = 0.00035 * Math.pow(2, (midi - 60) / 26);
    const maxPartial = Math.min(36, Math.floor((0.42 * sr) / f0));
    const hammer = 0.13;
    const strings = midi < 34 ? [0] : midi < 46 ? [-0.5, 0.5] : [-0.9, 0.05, 0.75];
    const pan = Math.max(-0.45, Math.min(0.45, (midi - 60) / 60));
    const gl = Math.cos((pan + 1) * Math.PI / 4);
    const gr = Math.sin((pan + 1) * Math.PI / 4);
    for (const cents of strings) {
      const det = Math.pow(2, cents / 1200);
      for (let n = 1; n <= maxPartial; n++) {
        const fn = n * f0 * det * Math.sqrt(1 + B * n * n);
        if (fn > sr * 0.45) break;
        const comb = Math.abs(Math.sin(Math.PI * n * hammer));
        const bright = Math.exp(-n * (midi < 48 ? 0.09 : 0.13));
        const amp = (comb * bright) / Math.pow(n, 0.55) / strings.length;
        const tauFast = (0.28 + 1.2 * Math.exp(-(midi - 21) / 30)) / Math.pow(n, 0.55);
        const tauSlow = tauFast * 5.5;
        const w = (2 * Math.PI * fn) / sr;
        const c = 2 * Math.cos(w);
        let y1 = Math.sin(-w);
        let y2 = Math.sin(-2 * w);
        const kF = Math.exp(-1 / (tauFast * sr));
        const kS = Math.exp(-1 / (tauSlow * sr));
        let eF = 0.72 * amp;
        let eS = 0.28 * amp;
        for (let i = 0; i < N; i++) {
          const y = c * y1 - y2;
          y2 = y1;
          y1 = y;
          const v = y * (eF + eS);
          L[i] += v * gl;
          R[i] += v * gr;
          eF *= kF;
          eS *= kS;
          if (eF + eS < 1e-5) break;
        }
      }
    }
    // ハンマーのアタック音(短いノイズ)
    let lp = 0;
    const noiseLen = Math.floor(sr * 0.012);
    const cutoff = Math.min(0.5, (f0 * 8) / sr + 0.1);
    for (let i = 0; i < noiseLen; i++) {
      const env = 1 - i / noiseLen;
      lp += cutoff * ((Math.random() * 2 - 1) - lp);
      const v = lp * env * env * 0.22;
      L[i] += v;
      R[i] += v;
    }
    // 立ち上がりと正規化
    const atk = Math.floor(sr * 0.0012);
    let peak = 1e-6;
    for (let i = 0; i < N; i++) {
      if (i < atk) {
        const k = i / atk;
        L[i] *= k;
        R[i] *= k;
      }
      peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
    }
    const norm = 0.7 / peak;
    for (let i = 0; i < N; i++) {
      L[i] *= norm;
      R[i] *= norm;
    }
    return buf;
  }

  // ---------------------------------------------------------------- サンプルの整形
  function analyseSample(buffer) {
    const data = buffer.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
    // MP3の先頭にある無音を飛ばす。リズムのタイトさに直結する
    const th = Math.max(0.002, peak * 0.02);
    let start = 0;
    while (start < data.length && Math.abs(data[start]) < th) start++;
    start = Math.max(0, start - Math.floor(buffer.sampleRate * 0.0005));
    // アタック部分の音量を揃える(サンプル間の音量差を均す)
    const win = Math.min(data.length - start, Math.floor(buffer.sampleRate * 0.2));
    let sum = 0;
    for (let i = 0; i < win; i++) sum += data[start + i] * data[start + i];
    const rms = Math.sqrt(sum / Math.max(1, win));
    const gain = Math.max(0.5, Math.min(2.2, 0.16 / Math.max(1e-4, rms)));
    return { offset: start / buffer.sampleRate, gain };
  }

  // ---------------------------------------------------------------- 共通の音作り
  function buildGraph(ctx) {
    const input = ctx.createGain();
    input.gain.value = 0.62;

    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 32;

    const mud = ctx.createBiquadFilter();
    mud.type = 'peaking';
    mud.frequency.value = 320;
    mud.Q.value = 0.8;
    mud.gain.value = -2.5;

    const air = ctx.createBiquadFilter();
    air.type = 'highshelf';
    air.frequency.value = 4800;
    air.gain.value = 3;

    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) {
      const x = (i / 1023) * 2 - 1;
      curve[i] = Math.tanh(x * 1.25) / Math.tanh(1.25);
    }
    shaper.curve = curve;
    shaper.oversample = '2x';

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.ratio.value = 3;
    comp.attack.value = 0.004;
    comp.release.value = 0.11;
    comp.knee.value = 8;

    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -2.5;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.06;
    limiter.knee.value = 0;

    const out = ctx.createGain();
    out.gain.value = 0.92;

    input.connect(hp);
    hp.connect(mud);
    mud.connect(air);
    air.connect(shaper);
    shaper.connect(comp);
    comp.connect(limiter);
    limiter.connect(out);
    out.connect(ctx.destination);

    const drumBus = ctx.createGain();
    drumBus.gain.value = 0.5;
    drumBus.connect(comp);

    return { input, drumBus, output: out };
  }

  function velToGain(v) {
    const x = v / 127;
    return 0.1 + 1.05 * x * x;
  }

  function velToCutoff(v, midi) {
    const x = v / 127;
    const key = Math.pow(2, (midi - 60) / 24);
    return Math.min(19000, (700 + 15000 * x * x * x) * Math.max(0.6, key));
  }

  function makeNoise(ctx) {
    const len = Math.floor(ctx.sampleRate * 0.6);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  function playDrum(ctx, bus, noise, n, t) {
    const vel = (n.v || 100) / 127;
    if (n.p === 36) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.setValueAtTime(130, t);
      o.frequency.exponentialRampToValueAtTime(46, t + 0.09);
      g.gain.setValueAtTime(vel * 1.1, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.17);
      o.connect(g);
      g.connect(bus);
      o.start(t);
      o.stop(t + 0.18);
    } else if (n.p === 38) {
      const s = ctx.createBufferSource();
      s.buffer = noise;
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = 2100;
      f.Q.value = 0.6;
      const g = ctx.createGain();
      g.gain.setValueAtTime(vel * 0.8, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
      s.connect(f);
      f.connect(g);
      g.connect(bus);
      s.start(t, Math.random() * 0.3);
      s.stop(t + 0.13);
      const o = ctx.createOscillator();
      const g2 = ctx.createGain();
      o.type = 'triangle';
      o.frequency.setValueAtTime(210, t);
      g2.gain.setValueAtTime(vel * 0.45, t);
      g2.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
      o.connect(g2);
      g2.connect(bus);
      o.start(t);
      o.stop(t + 0.08);
    } else {
      const s = ctx.createBufferSource();
      s.buffer = noise;
      const f = ctx.createBiquadFilter();
      f.type = 'highpass';
      f.frequency.value = 8000;
      const g = ctx.createGain();
      g.gain.setValueAtTime(vel * 0.3, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.03);
      s.connect(f);
      f.connect(g);
      g.connect(bus);
      s.start(t, Math.random() * 0.3);
      s.stop(t + 0.04);
    }
  }

  /** ガイド用ドラム。雰囲気で変える必要はなく、ピアノのノリを確かめるためのもの */
  function makeDrumNotes(song) {
    const out = [];
    const { barSteps, bars } = song;
    const groups = song.meter.groups;
    const offs = [];
    let a = 0;
    for (const g of groups) { offs.push(a); a += g; }
    for (let b = 0; b < bars; b++) {
      const base = b * barSteps;
      offs.forEach((o, i) => {
        if (i % 2 === 1) out.push({ s: base + o, d: 1, p: 38, v: 112 });
        else out.push({ s: base + o, d: 1, p: 36, v: 118 });
      });
      if (barSteps >= 12) {
        out.push({ s: base + Math.min(barSteps - 2, offs[offs.length - 1] + 2), d: 1, p: 36, v: 96 });
      }
      for (let k = 0; k < barSteps; k += 2) out.push({ s: base + k, d: 1, p: 42, v: k % 4 === 2 ? 96 : 60 });
    }
    return out.sort((x, y) => x.s - y.s);
  }

  // ---------------------------------------------------------------- engine
  class Engine {
    constructor() {
      this.ctx = null;
      this.graph = null;
      this.samples = new Map();
      this.status = { state: 'idle', loaded: 0, total: SAMPLE_NOTES.length, source: 'none' };
      this.onStatus = () => {};
      this.onStep = () => {};
      this.onEnd = () => {};
      this.playing = false;
      this.loop = true;
      this.bpm = 170;
      this.swing = 0;
      this.release = 0.004;
      this.notes = [];
      this.total = 16;
      this.mutes = {};
      this.drums = [];
      this.drumsOn = false;
      this.timer = null;
      this.raf = null;
      this.tailVoices = new Set();
    }

    async loadSamples() {
      if (this.status.state === 'loading' || this.status.state === 'ready') return;
      this.status = { state: 'loading', loaded: 0, total: SAMPLE_NOTES.length, source: 'salamander' };
      this.onStatus(this.status);
      const decoder = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(2, 1, 44100);
      let failed = 0;
      const queue = SAMPLE_NOTES.slice().sort((a, b) => Math.abs(a[1] - 60) - Math.abs(b[1] - 60));
      const worker = async () => {
        while (queue.length) {
          const [name, midi] = queue.shift();
          try {
            const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
            const timer = controller ? setTimeout(() => controller.abort(), 15000) : null;
            const res = await fetch(SAMPLE_BASE + name + '.mp3', controller ? { signal: controller.signal } : undefined);
            if (timer) clearTimeout(timer);
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const ab = await res.arrayBuffer();
            const buffer = await decoder.decodeAudioData(ab);
            const a = analyseSample(buffer);
            this.samples.set(midi, { buffer, midi, offset: a.offset, gain: a.gain });
            this.status.loaded++;
            this.onStatus(this.status);
          } catch (e) {
            failed++;
          }
        }
      };
      await Promise.all([worker(), worker(), worker(), worker(), worker(), worker()]);
      if (this.samples.size < 6 || failed > SAMPLE_NOTES.length / 3) {
        this.samples.clear();
        await this.buildSynth();
      } else {
        this.status = { state: 'ready', loaded: this.samples.size, total: SAMPLE_NOTES.length, source: 'salamander' };
        this.onStatus(this.status);
      }
    }

    async buildSynth() {
      this.status = { state: 'loading', loaded: 0, total: SAMPLE_NOTES.length, source: 'synth' };
      this.onStatus(this.status);
      const OC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      const maker = new OC(2, 1, 44100);
      for (const [, midi] of SAMPLE_NOTES) {
        const seconds = midi < 48 ? 2.2 : midi < 72 ? 1.6 : 1.1;
        const buffer = synthPianoBuffer(maker, midi, seconds);
        this.samples.set(midi, { buffer, midi, offset: 0, gain: 1 });
        this.status.loaded++;
        this.onStatus(this.status);
        await new Promise((r) => setTimeout(r, 0));
      }
      this.status = { state: 'ready', loaded: this.samples.size, total: SAMPLE_NOTES.length, source: 'synth' };
      this.onStatus(this.status);
    }

    ensureContext() {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        this.ctx = new AC({ latencyHint: 'interactive' });
        this.graph = buildGraph(this.ctx);
        this.noise = makeNoise(this.ctx);
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return this.ctx;
    }

    sampleFor(midi) {
      let best = null;
      let bd = 1e9;
      for (const s of this.samples.values()) {
        const d = Math.abs(s.midi - midi);
        if (d < bd) { bd = d; best = s; }
      }
      return best;
    }

    voice(ctx, dest, n, t, stepDur, release) {
      const sm = this.sampleFor(n.p);
      if (!sm) return null;
      const src = ctx.createBufferSource();
      src.buffer = sm.buffer;
      src.playbackRate.value = Math.pow(2, (n.p - sm.midi) / 12);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = velToCutoff(n.v || 96, n.p);
      lp.Q.value = 0.4;
      const g = ctx.createGain();
      const amp = velToGain(n.v || 96) * sm.gain;
      const dur = Math.max(0.02, n.d * stepDur);
      const end = t + dur;
      g.gain.setValueAtTime(amp, t);
      g.gain.setValueAtTime(amp, end);
      g.gain.linearRampToValueAtTime(0.00001, end + release);
      src.connect(lp);
      lp.connect(g);
      g.connect(dest);
      src.start(t, sm.offset);
      src.stop(end + release + 0.01);
      return src;
    }

    setSong(notes, total, swing) {
      const pos = this.playing ? this.currentStep() : 0;
      this.notes = notes.slice().sort((a, b) => a.s - b.s);
      this.total = total;
      this.swing = swing || 0;
      if (this.playing) {
        // 再生を止めずに差し替える(生成ボタンを連打して聴き比べられるように)
        this.playFrom(pos);
      }
    }

    setDrums(notes) {
      this.drums = notes;
    }

    timeOf(step) {
      return Math.floor(step) % 2 === 1 ? step + this.swing : step;
    }

    stepDur() {
      return 60 / this.bpm / 4;
    }

    currentStep() {
      if (!this.playing || !this.ctx) return 0;
      const dur = this.stepDur();
      const elapsed = this.ctx.currentTime - this.startTime;
      let s = elapsed / dur;
      if (this.loop) s = ((s % this.total) + this.total) % this.total;
      return Math.max(0, Math.min(this.total, s));
    }

    playFrom(step) {
      const ctx = this.ensureContext();
      if (this.timer) clearInterval(this.timer);
      this.killVoices();
      this.playing = true;
      const dur = this.stepDur();
      this.startTime = ctx.currentTime + 0.06 - step * dur;
      this.cycle = 0;
      this.ptr = this.notes.findIndex((n) => this.timeOf(n.s) >= step - 1e-6);
      if (this.ptr < 0) this.ptr = this.notes.length;
      this.dptr = this.drums.findIndex((n) => n.s >= step - 1e-6);
      if (this.dptr < 0) this.dptr = this.drums.length;
      this.tick();
      this.timer = setInterval(() => this.tick(), 25);
      const anim = () => {
        if (!this.playing) return;
        this.onStep(this.currentStep());
        this.raf = requestAnimationFrame(anim);
      };
      anim();
    }

    killVoices() {
      for (const v of this.tailVoices) {
        try { v.stop(); } catch (e) { /* already stopped */ }
      }
      this.tailVoices.clear();
    }

    tick() {
      const ctx = this.ctx;
      if (!ctx) return;
      const horizon = ctx.currentTime + 0.14;
      const dur = this.stepDur();
      const span = this.total * dur;
      let guard = 0;
      for (;;) {
        if (guard++ > 4000) break;
        const cycleStart = this.startTime + this.cycle * span;
        const n = this.notes[this.ptr];
        const dn = this.drums[this.dptr];
        const tN = n ? cycleStart + this.timeOf(n.s) * dur : Infinity;
        const tD = dn ? cycleStart + dn.s * dur : Infinity;
        const t = Math.min(tN, tD);
        if (t === Infinity) {
          if (!this.loop) {
            if (ctx.currentTime > cycleStart + span) {
              this.stop();
              this.onEnd();
            }
            return;
          }
          if (cycleStart + span > horizon) return;
          this.cycle++;
          this.ptr = 0;
          this.dptr = 0;
          continue;
        }
        if (t > horizon) return;
        if (tN <= tD) {
          if (!this.mutes[n.l]) {
            const v = this.voice(ctx, this.graph.input, n, Math.max(t, ctx.currentTime), dur, this.release);
            if (v) {
              this.tailVoices.add(v);
              v.onended = () => this.tailVoices.delete(v);
            }
          }
          this.ptr++;
        } else {
          if (this.drumsOn) playDrum(ctx, this.graph.drumBus, this.noise, dn, Math.max(t, ctx.currentTime));
          this.dptr++;
        }
      }
    }

    stop() {
      this.playing = false;
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      if (this.raf) cancelAnimationFrame(this.raf);
      this.killVoices();
    }

    /** オフラインレンダリングして AudioBuffer を返す。WAV書き出しと音量チェックで使う */
    async render(notes, opt) {
      const o = opt || {};
      const bpm = o.bpm || this.bpm;
      const dur = 60 / bpm / 4;
      const total = o.total || this.total;
      const repeats = o.repeats || 1;
      const seconds = total * dur * repeats + 0.6;
      const OC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      const off = new OC(2, Math.ceil(seconds * 44100), 44100);
      const graph = buildGraph(off);
      const swing = o.swing == null ? this.swing : o.swing;
      const timeOf = (s) => (Math.floor(s) % 2 === 1 ? s + swing : s);
      const noise = makeNoise(off);
      for (let r = 0; r < repeats; r++) {
        const base = r * total * dur + 0.02;
        for (const n of notes) {
          this.voice(off, graph.input, n, base + timeOf(n.s) * dur, dur, o.release == null ? this.release : o.release);
        }
        if (o.drums) for (const d of o.drums) playDrum(off, graph.drumBus, noise, d, base + d.s * dur);
      }
      return off.startRendering();
    }
  }

  function encodeWav(buffer) {
    const ch = buffer.numberOfChannels;
    const n = buffer.length;
    const out = new ArrayBuffer(44 + n * ch * 2);
    const v = new DataView(out);
    const write = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    write(0, 'RIFF');
    v.setUint32(4, 36 + n * ch * 2, true);
    write(8, 'WAVEfmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, ch, true);
    v.setUint32(24, buffer.sampleRate, true);
    v.setUint32(28, buffer.sampleRate * ch * 2, true);
    v.setUint16(32, ch * 2, true);
    v.setUint16(34, 16, true);
    write(36, 'data');
    v.setUint32(40, n * ch * 2, true);
    const chans = [];
    for (let c = 0; c < ch; c++) chans.push(buffer.getChannelData(c));
    let o = 44;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < ch; c++) {
        const s = Math.max(-1, Math.min(1, chans[c][i]));
        v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        o += 2;
      }
    }
    return new Blob([out], { type: 'audio/wav' });
  }

  root.RisukaAudio = { Engine, encodeWav, makeDrumNotes, SAMPLE_BASE };
})(typeof self !== 'undefined' ? self : this);

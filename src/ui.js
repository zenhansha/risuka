/* りすかメーカー — 画面 */
(function () {
  'use strict';

  const T = window.RisukaTheory;
  const C = window.RisukaComposer;
  const Midi = window.RisukaMidi;
  const A = window.RisukaAudio;
  const $ = (id) => document.getElementById(id);

  const PRESETS = [
    { name: '王道', chords: 'F G Em Am' },
    { name: '小室', chords: 'Am F G C' },
    { name: 'カノン', chords: 'C G Am Em F C F G' },
    { name: '丸サ', chords: 'FM7 E7 Am7 C7' },
    { name: '下降', chords: 'C G/B Am Em/G | F C/E Dm7 G7' },
    { name: 'ツーファイブ', chords: 'Dm7 G7 CM7 A7' },
    { name: '短調', chords: 'Cm Ab Bb Cm' },
    { name: 'スパニッシュ', chords: 'Am G F E7' },
  ];

  const STAGES = [
    { id: 1, name: '仮ベース・仮コード', cap: 'ベース音形を出発点に、鳴らしたいコードを走り書きした状態です。' },
    { id: 2, name: 'フレーズ', cap: 'ベース・内声・トップに動機を置きました。主張させたい動きは8度や5度で重ねています。' },
    { id: 3, name: '埋め尽くす', cap: '2〜4拍の短い動機を継ぎ足して飽和させた状態です。ここでは過度にうるさいくらいで丁度いいです。' },
    { id: 4, name: '隙間', cap: 'コードの変わり目とベースが聴こえるよう音価を切りました。↓は旋律の直前の無音です。ベロシティは内声と外声で分けています。' },
    { id: 5, name: '完成', cap: 'ぶつかる音を取り除いた最終形です。MIDIにはこの状態が書き出されます。' },
  ];

  const LAYERS = [
    { id: 'bass', name: 'ベース', token: '--n-bass' },
    { id: 'inner', name: '内声', token: '--n-inner' },
    { id: 'top', name: 'トップ', token: '--n-top' },
    { id: 'fill', name: '継ぎ足し', token: '--n-fill' },
    { id: 'hit', name: '決め', token: '--n-hit' },
  ];

  const state = {
    chords: 'F G Em Am',
    mood: 'douga',
    key: 'auto',
    meter: '4/4',
    repeat: 1,
    stage: 5,
    overrides: { density: 1, sync: 1, width: 1 },
    song: null,
    history: [],
    histIndex: -1,
    memory: {},
    locked: new Set(),
    bpm: null,
    mutes: {},
  };

  const engine = new A.Engine();

  // ---------------------------------------------------------------- persistence
  function loadState() {
    const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('risuka') || '{}'); } catch (e) { saved = {}; }
    state.chords = hash.get('c') || saved.chords || state.chords;
    state.mood = hash.get('m') || saved.mood || state.mood;
    state.key = hash.get('k') || saved.key || state.key;
    state.meter = hash.get('t') || saved.meter || state.meter;
    state.repeat = +(hash.get('r') || saved.repeat || state.repeat);
    if (!C.MOODS.some((m) => m.id === state.mood)) state.mood = 'douga';
    if (!T.METERS[state.meter]) state.meter = '4/4';
    return hash.get('s') ? +hash.get('s') : null;
  }

  function saveState() {
    try {
      localStorage.setItem('risuka', JSON.stringify({
        chords: state.chords, mood: state.mood, key: state.key, meter: state.meter, repeat: state.repeat,
      }));
    } catch (e) { /* プライベートウィンドウなど。無くても動く */ }
    if (state.song) {
      const p = new URLSearchParams();
      p.set('c', state.chords);
      p.set('m', state.mood);
      p.set('s', String(state.song.seed));
      if (state.key !== 'auto') p.set('k', state.key);
      if (state.meter !== '4/4') p.set('t', state.meter);
      if (state.repeat !== 1) p.set('r', String(state.repeat));
      try { history.replaceState(null, '', '#' + p.toString()); } catch (e) { /* file:// の一部環境 */ }
    }
  }

  // ---------------------------------------------------------------- build static UI
  function buildControls() {
    const presets = $('presets');
    PRESETS.forEach((p) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = p.name;
      b.title = p.chords;
      b.addEventListener('click', () => {
        $('chords').value = p.chords;
        state.chords = p.chords;
        state.locked.clear();
        generate();
      });
      presets.appendChild(b);
    });

    const key = $('key');
    const addOpt = (value, label) => {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = label;
      key.appendChild(o);
    };
    addOpt('auto', '自動で判定');
    for (let i = 0; i < 12; i++) addOpt(i + ':major', T.keyName({ tonic: i, mode: 'major' }));
    for (let i = 0; i < 12; i++) addOpt(i + ':minor', T.keyName({ tonic: i, mode: 'minor' }));

    const moods = $('moods');
    C.MOODS.forEach((m) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'mood';
      b.setAttribute('role', 'radio');
      b.dataset.id = m.id;
      const title = document.createElement('b');
      title.textContent = m.name;
      const sub = document.createElement('small');
      sub.textContent = m.sub;
      b.append(title, sub);
      b.addEventListener('click', () => {
        if (state.mood !== m.id) state.bpm = null;
        state.mood = m.id;
        state.locked.clear();
        renderMoods();
        generate();
      });
      moods.appendChild(b);
    });

    const stages = $('stages');
    STAGES.forEach((s) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'stage';
      b.setAttribute('role', 'tab');
      b.dataset.id = s.id;
      const num = document.createElement('b');
      num.textContent = s.id;
      b.append(num, document.createTextNode(s.name));
      b.addEventListener('click', () => setStage(s.id));
      stages.appendChild(b);
    });

    const legend = $('legend');
    LAYERS.forEach((l) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('aria-pressed', 'true');
      b.title = l.name + ' のミュート切り替え';
      const i = document.createElement('i');
      i.style.background = `var(${l.token})`;
      b.append(i, document.createTextNode(l.name));
      b.addEventListener('click', () => {
        state.mutes[l.id] = !state.mutes[l.id];
        engine.mutes = state.mutes;
        b.setAttribute('aria-pressed', state.mutes[l.id] ? 'false' : 'true');
        draw();
      });
      legend.appendChild(b);
    });
  }

  function renderMoods() {
    document.querySelectorAll('.mood').forEach((b) => {
      b.setAttribute('aria-checked', b.dataset.id === state.mood ? 'true' : 'false');
    });
  }

  // ---------------------------------------------------------------- generate
  function memoryKey() {
    return state.chords + '|' + state.mood;
  }

  function generate(opts) {
    const o = opts || {};
    state.chords = $('chords').value.trim();
    state.key = $('key').value;
    state.meter = $('meter').value;
    state.repeat = +$('repeat').value;
    const key = memoryKey();
    const memory = state.memory[key] || [];
    const input = {
      chords: state.chords,
      mood: state.mood,
      key: state.key,
      meter: state.meter,
      repeat: state.repeat,
      overrides: state.overrides,
    };
    // シード指定(共有URLなど)はそのまま再現し、普段は直前までと似ていないものを選ぶ
    const song = o.seed != null ? C.compose({ ...input, seed: o.seed }) : C.composeNovel(input, memory);
    const err = $('chordError');
    if (song.errors) {
      err.hidden = false;
      err.textContent = '読めないコードがあります: ' + song.errors.join('、');
      return null;
    }
    err.hidden = true;
    const final = state.song && state.locked.size ? C.mergeLocked(state.song, song, [...state.locked]) : song;
    state.memory[key] = memory.concat([song.fingerprint]).slice(-10);
    state.history.push(final);
    if (state.history.length > 16) state.history.shift();
    state.histIndex = state.history.length - 1;
    showSong(final);
    return final;
  }

  function showSong(song) {
    const changedFrame = !state.song || state.song.totalSteps !== song.totalSteps;
    state.song = song;
    if (changedFrame) state.locked.clear();
    if (state.bpm == null) {
      $('bpm').value = song.bpm;
      engine.bpm = song.bpm;
      $('bpmOut').textContent = song.bpm;
    }
    engine.setDrums(A.makeDrumNotes(song));
    engine.setSong(song.stages[state.stage], song.totalSteps, song.swing);
    renderSummary();
    renderHistory();
    renderThoughts();
    draw();
    saveState();
  }

  function setStage(id) {
    state.stage = id;
    document.querySelectorAll('.stage').forEach((b) => {
      b.setAttribute('aria-selected', +b.dataset.id === id ? 'true' : 'false');
    });
    const s = STAGES.find((x) => x.id === id);
    $('caption').textContent = s.cap;
    if (state.song) {
      engine.setSong(state.song.stages[id], state.song.totalSteps, state.song.swing);
      draw();
    }
  }

  function renderSummary() {
    const s = state.song;
    $('sumKey').textContent = s.keyName;
    $('sumMood').textContent = `${s.moodName} / ${s.bars}小節 / ${s.stages[state.stage].length}音`;
    $('sumSeed').textContent = '#' + s.seed.toString(36);
    $('sumSeed').title = 'この番号を含むURLを開くと同じフレーズを再現できます';
  }

  function renderHistory() {
    const box = $('history');
    box.textContent = '';
    state.history.forEach((song, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = i + 1;
      b.title = `${song.moodName} #${song.seed.toString(36)}`;
      b.setAttribute('aria-current', i === state.histIndex ? 'true' : 'false');
      b.addEventListener('click', () => {
        state.histIndex = i;
        showSong(song);
      });
      box.appendChild(b);
    });
  }

  function renderThoughts() {
    const s = state.song;
    const dl = $('thoughts');
    dl.textContent = '';
    s.thoughts.forEach((t) => {
      const dt = document.createElement('dt');
      dt.textContent = t.k;
      const dd = document.createElement('dd');
      dd.textContent = t.t;
      dl.append(dt, dd);
    });
    const tbody = document.querySelector('#scales tbody');
    tbody.textContent = '';
    const seen = new Set();
    s.regions.forEach((r) => {
      if (r.rest || seen.has(r.name)) return;
      seen.add(r.name);
      const tr = document.createElement('tr');
      [r.name, r.scale, r.tensions.join(' ') || '—', r.avoid.join(' ') || '—'].forEach((v) => {
        const td = document.createElement('td');
        td.textContent = v;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
  }

  // ---------------------------------------------------------------- piano roll
  const RULER = 38;
  let layout = null;

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function noteColor(n, tokens) {
    if (n.l === 'top' && n.h) return tokens.harm;
    return tokens[n.l] || tokens.fill;
  }

  function isBlack(p) {
    return [1, 3, 6, 8, 10].includes(T.mod12(p));
  }

  function draw() {
    const song = state.song;
    if (!song) return;
    const notes = song.stages[state.stage];
    const framePitches = [];
    Object.values(song.stages).forEach((list) => list.forEach((n) => framePitches.push(n.p)));
    const pMin = Math.min(...framePitches) - 1;
    const pMax = Math.max(...framePitches) + 1;
    const range = pMax - pMin + 1;
    const scroller = $('scroller');
    // clientWidth は丸められるので、実寸を切り捨てて使う(0.5pxはみ出すとスクロールバーが出る)
    const availW = Math.max(240, Math.floor(scroller.getBoundingClientRect().width));
    const noteH = Math.max(5, Math.min(9, Math.floor(430 / range)));
    const H = RULER + range * noteH;
    const minStep = 11;
    const fits = availW / song.totalSteps >= minStep;
    const stepW = fits ? availW / song.totalSteps : minStep;
    const W = fits ? availW : Math.ceil(stepW * song.totalSteps);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const tokens = {
      bass: cssVar('--n-bass'), top: cssVar('--n-top'), harm: cssVar('--n-harm'),
      inner: cssVar('--n-inner'), hit: cssVar('--n-hit'), fill: cssVar('--n-fill'),
    };
    const colors = {
      bg: cssVar('--roll-bg'), black: cssVar('--roll-black'), line: cssVar('--roll-line'),
      beat: cssVar('--roll-beat'), bar: cssVar('--roll-bar'), text: cssVar('--text'), muted: cssVar('--muted'),
      gap: cssVar('--gap'), brk: cssVar('--break'), lock: cssVar('--lock'), accent: cssVar('--accent'),
      kw: cssVar('--key-white'), kb: cssVar('--key-black'), kt: cssVar('--key-text'), surface: cssVar('--surface'),
    };

    const grid = $('grid');
    grid.width = W * dpr;
    grid.height = H * dpr;
    grid.style.width = W + 'px';
    grid.style.height = H + 'px';
    const g = grid.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = colors.bg;
    g.fillRect(0, 0, W, H);

    const yOf = (p) => RULER + (pMax - p) * noteH;
    for (let p = pMin; p <= pMax; p++) {
      if (isBlack(p)) {
        g.fillStyle = colors.black;
        g.fillRect(0, yOf(p), W, noteH);
      }
      if (T.mod12(p) === 0 || T.mod12(p) === 5) {
        g.fillStyle = colors.line;
        g.fillRect(0, yOf(p) + noteH - 1, W, 1);
      }
    }

    const groups = song.meter.groups;
    for (let b = 0; b < song.bars; b++) {
      let at = b * song.barSteps;
      if (state.locked.has(b)) {
        g.fillStyle = colors.lock;
        g.fillRect(at * stepW, 0, song.barSteps * stepW, H);
      }
      groups.forEach((len, i) => {
        if (i > 0) {
          g.fillStyle = colors.beat;
          g.fillRect(Math.round(at * stepW), RULER, 1, H - RULER);
        }
        at += len;
      });
    }
    if (state.stage >= 4 && song.breaks) {
      g.fillStyle = colors.brk;
      song.breaks.forEach((k) => g.fillRect(k.start * stepW, RULER, (k.end - k.start) * stepW, H - RULER));
    }
    for (let b = 0; b <= song.bars; b++) {
      g.fillStyle = colors.bar;
      g.fillRect(Math.round(b * song.barSteps * stepW), 0, 1, H);
    }

    // ルーラー: 小節番号とコード
    g.fillStyle = colors.surface;
    g.fillRect(0, 0, W, RULER);
    g.fillStyle = colors.line;
    g.fillRect(0, RULER - 1, W, 1);
    g.textBaseline = 'middle';
    for (let b = 0; b < song.bars; b++) {
      const x = b * song.barSteps * stepW;
      g.fillStyle = state.locked.has(b) ? colors.accent : colors.muted;
      g.font = '600 11px "Cascadia Code", Consolas, monospace';
      g.fillText(state.locked.has(b) ? `${b + 1} 固定` : String(b + 1), x + 5, 10);
    }
    g.font = '12px "Cascadia Code", Consolas, monospace';
    song.regions.forEach((r) => {
      const x = r.start * stepW;
      const w = (r.end - r.start) * stepW;
      g.save();
      g.beginPath();
      g.rect(x, 18, w - 2, 20);
      g.clip();
      g.fillStyle = r.rest ? colors.muted : colors.text;
      g.fillText(r.name, x + 5, 28);
      g.restore();
      g.fillStyle = colors.beat;
      g.fillRect(Math.round(x), 18, 1, RULER - 18);
    });

    // ノート
    const sorted = notes.slice().sort((a, b) => (a.l === 'top' && !a.h ? 1 : 0) - (b.l === 'top' && !b.h ? 1 : 0));
    sorted.forEach((n) => {
      const muted = state.mutes[n.l];
      const x = n.s * stepW;
      const w = Math.max(2.5, n.d * stepW - 1);
      const y = yOf(n.p);
      const vel = (n.v || 96) / 127;
      g.globalAlpha = muted ? 0.1 : 0.42 + 0.58 * vel * vel;
      g.fillStyle = noteColor(n, tokens);
      g.beginPath();
      if (g.roundRect) g.roundRect(x + 0.5, y + 0.5, w, Math.max(2, noteH - 1), 1.5);
      else g.rect(x + 0.5, y + 0.5, w, Math.max(2, noteH - 1));
      g.fill();
    });
    g.globalAlpha = 1;

    // 動画の矢印: 旋律の直前の無音
    if (state.stage >= 4 && song.gaps) {
      g.fillStyle = colors.gap;
      g.strokeStyle = colors.gap;
      g.lineWidth = 1.6;
      song.gaps.forEach((gp) => {
        const x = gp.s * stepW + 2;
        const y = yOf(gp.p) - 3;
        g.beginPath();
        g.moveTo(x, y - 14);
        g.lineTo(x, y - 3);
        g.stroke();
        g.beginPath();
        g.moveTo(x - 3.5, y - 5);
        g.lineTo(x + 3.5, y - 5);
        g.lineTo(x, y);
        g.closePath();
        g.fill();
      });
    }

    // 鍵盤
    const keys = $('keys');
    keys.width = 40 * dpr;
    keys.height = H * dpr;
    keys.style.height = H + 'px';
    const k = keys.getContext('2d');
    k.setTransform(dpr, 0, 0, dpr, 0, 0);
    k.fillStyle = colors.surface;
    k.fillRect(0, 0, 40, H);
    k.textBaseline = 'middle';
    k.font = '9px "Cascadia Code", Consolas, monospace';
    for (let p = pMin; p <= pMax; p++) {
      k.fillStyle = isBlack(p) ? colors.kb : colors.kw;
      k.fillRect(0, yOf(p), isBlack(p) ? 26 : 40, noteH - (isBlack(p) ? 0 : 0.5));
      if (T.mod12(p) === 0 && noteH >= 5) {
        k.fillStyle = colors.kt;
        k.fillText(T.midiName(p), 21, yOf(p) + noteH / 2);
      }
    }

    layout = { stepW, W, H };
    $('playhead').style.height = H + 'px';
    positionPlayhead(engine.playing ? engine.currentStep() : 0);
  }

  function positionPlayhead(step) {
    if (!layout) return;
    const ph = $('playhead');
    const x = step * layout.stepW;
    ph.style.transform = `translateX(${x}px)`;
    const sc = $('scroller');
    if (engine.playing && (x < sc.scrollLeft || x > sc.scrollLeft + sc.clientWidth - 30)) {
      sc.scrollLeft = Math.max(0, x - 40);
    }
  }

  function onGridClick(ev) {
    if (!state.song || !layout) return;
    const rect = $('grid').getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    const step = x / layout.stepW;
    if (y < RULER) {
      const bar = Math.floor(step / state.song.barSteps);
      if (state.locked.has(bar)) state.locked.delete(bar);
      else state.locked.add(bar);
      draw();
      return;
    }
    const snapped = Math.floor(step / 4) * 4;
    startPlay(snapped);
  }

  // ---------------------------------------------------------------- transport
  function setPlayUI(on) {
    $('play').setAttribute('aria-pressed', on ? 'true' : 'false');
    $('playText').textContent = on ? '停止' : '再生';
    $('playIcon').setAttribute('d', on ? 'M3 3h10v10H3z' : 'M3 1.5v13l11-6.5z');
    $('playhead').hidden = !on;
  }

  function startPlay(step) {
    if (!state.song) return;
    if (engine.status.state === 'idle') engine.loadSamples();
    engine.ensureContext();
    engine.bpm = +$('bpm').value;
    engine.setSong(state.song.stages[state.stage], state.song.totalSteps, state.song.swing);
    engine.playFrom(step || 0);
    setPlayUI(true);
  }

  function togglePlay() {
    if (engine.playing) {
      engine.stop();
      setPlayUI(false);
    } else {
      startPlay(0);
    }
  }

  function onStatus(st) {
    const el = $('status');
    if (st.state === 'loading') {
      el.textContent = st.source === 'synth'
        ? `通信できないので内蔵ピアノを準備中 ${st.loaded}/${st.total}`
        : `ピアノ音源を読み込み中 ${st.loaded}/${st.total}`;
    } else if (st.state === 'ready') {
      el.textContent = st.source === 'synth'
        ? '内蔵ピアノで再生します(ネットにつなぐと本物のピアノになります)'
        : '音源の準備ができました';
      $('pianoCredit').hidden = st.source === 'synth';
    }
  }

  // ---------------------------------------------------------------- export
  function fileBase() {
    const s = state.song;
    const chords = s.regions.slice(0, 4).map((r) => r.name).join('-').replace(/[\\/:*?"<>|#]/g, '_');
    return `risuka_${s.moodName}_${chords}_${s.seed.toString(36)}`;
  }

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  function buildMidi(split) {
    const s = state.song;
    return Midi.writeMidi(s, {
      notes: s.stages[state.stage],
      bpm: +$('bpm').value,
      split,
      drums: engine.drumsOn ? engine.drums : null,
    });
  }

  function exportMidi(split) {
    if (!state.song) return;
    download(new Blob([buildMidi(split)], { type: 'audio/midi' }), fileBase() + (split ? '_parts' : '') + '.mid');
  }

  async function exportWav() {
    if (!state.song) return;
    const btn = $('wav');
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = '書き出し中…';
    try {
      if (engine.status.state === 'idle') await engine.loadSamples();
      const buf = await engine.render(state.song.stages[state.stage], {
        bpm: +$('bpm').value,
        total: state.song.totalSteps,
        swing: state.song.swing,
        drums: engine.drumsOn ? engine.drums : null,
      });
      download(A.encodeWav(buf), fileBase() + '.wav');
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  // ---------------------------------------------------------------- wiring
  function sliderLabel(v) {
    const x = +v;
    if (Math.abs(x - 1) < 0.01) return '標準';
    return (x > 1 ? '+' : '') + Math.round((x - 1) * 100) + '%';
  }

  function wire() {
    $('generate').addEventListener('click', () => generate());
    $('play').addEventListener('click', togglePlay);
    $('midi').addEventListener('click', () => exportMidi(false));
    $('midiSplit').addEventListener('click', () => exportMidi(true));
    $('wav').addEventListener('click', exportWav);
    $('grid').addEventListener('click', onGridClick);

    $('loop').addEventListener('change', (e) => { engine.loop = e.target.checked; });
    $('drums').addEventListener('change', (e) => { engine.drumsOn = e.target.checked; });
    $('bpm').addEventListener('input', (e) => {
      state.bpm = +e.target.value;
      $('bpmOut').textContent = e.target.value;
      const wasPlaying = engine.playing;
      const pos = wasPlaying ? engine.currentStep() : 0;
      engine.bpm = state.bpm;
      if (wasPlaying) engine.playFrom(pos);
    });
    $('release').addEventListener('input', (e) => {
      const ms = +e.target.value;
      engine.release = Math.max(0.004, ms / 1000);
      $('releaseOut').textContent = ms + 'ms';
    });

    ['density', 'sync', 'width'].forEach((id) => {
      $(id).addEventListener('input', (e) => {
        state.overrides[id] = +e.target.value;
        $(id + 'Out').textContent = sliderLabel(e.target.value);
      });
      $(id).addEventListener('change', () => generate());
    });

    $('chords').addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        generate();
      }
    });

    document.addEventListener('keydown', (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'textarea' || tag === 'input' || tag === 'select') return;
      if (e.code === 'Space') {
        e.preventDefault();
        togglePlay();
      } else if (e.key === 'g' || e.key === 'G') {
        generate();
      }
    });

    // ページが伸びて縦スクロールが出ると幅が変わるので、ウィンドウではなくロール自体の幅を見る
    let resizeTimer = null;
    let lastWidth = $('scroller').clientWidth;
    const onResize = () => {
      const w = $('scroller').clientWidth;
      if (w === lastWidth) return;
      lastWidth = w;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(draw, 60);
    };
    if (window.ResizeObserver) new ResizeObserver(onResize).observe($('scroller'));
    else window.addEventListener('resize', onResize);
    if (window.matchMedia) {
      window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', draw);
    }

    engine.onStatus = onStatus;
    engine.onStep = positionPlayhead;
    engine.onEnd = () => setPlayUI(false);
  }

  function init() {
    const seed = loadState();
    buildControls();
    $('chords').value = state.chords;
    $('key').value = state.key;
    $('meter').value = state.meter;
    $('repeat').value = String(state.repeat);
    renderMoods();
    wire();
    setStage(5);
    generate(seed != null ? { seed } : {});
    engine.loadSamples();
  }

  init();

  // ブラウザ検証用の入口
  window.__risuka = { state, engine, generate, setStage, buildMidi, draw };
})();

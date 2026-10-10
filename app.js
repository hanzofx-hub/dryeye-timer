/*
 * 目の休憩タイマー
 *
 * 画面ロック中でも確実に鳴らすため、JavaScript のタイマーではなく
 * 「1サイクル分（作業＋休憩）の音声トラック」をブラウザ内で生成し、
 * <audio loop> で再生し続ける方式にしている。
 *   - トラック先頭 0 秒      : 再開の合図（＝作業開始）
 *   - トラック W 秒（作業終了）: 休憩の合図
 *   - トラック末尾 W+B 秒    : ループして先頭に戻る＝再開の合図
 * 音声の再生は OS のメディア再生として扱われるため、画面オフ・ロック・
 * 他アプリへの切替中も止まらず、アラームの時刻も音声クロックで正確に保たれる。
 * 画面表示は audio.currentTime から逆算するので、表示と音が常に一致する。
 */
(() => {
  'use strict';

  const SAMPLE_RATE = 8000; // 8kHz / 8bit モノラル：20分トラックで約10MB
  const STORAGE_KEY = 'dryeye-timer-settings-v1';
  const RING_LEN = 552.92; // 2πr (r = 88)

  const DEFAULTS = {
    workMin: 20,
    breakSec: 60,
    alarmSec: 5,
    sound: 'chime',
    volume: 80,
    wakeLock: false,
  };

  const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  const OPTIONS = {
    workMin: range(1, 60),
    breakSec: [10, 15, 20, 30, 40, 45, 60, 90, 120, 180, 240, 300, 420, 600],
    alarmSec: range(2, 10),
  };

  /* ---------------- 設定 ---------------- */

  function loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      return normalize({ ...DEFAULTS, ...saved });
    } catch (_) {
      return { ...DEFAULTS };
    }
  }

  function saveSettings() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch (_) { /* 保存不可でも動作は継続 */ }
  }

  function nearest(list, v) {
    return list.reduce((best, x) => (Math.abs(x - v) < Math.abs(best - v) ? x : best), list[0]);
  }

  function normalize(s) {
    const out = { ...s };
    out.workMin = nearest(OPTIONS.workMin, Number(out.workMin) || DEFAULTS.workMin);
    out.breakSec = nearest(OPTIONS.breakSec, Number(out.breakSec) || DEFAULTS.breakSec);
    out.alarmSec = nearest(OPTIONS.alarmSec, Number(out.alarmSec) || DEFAULTS.alarmSec);
    // アラームが休憩時間より長いと2つの合図が重なるため制限
    out.alarmSec = Math.min(out.alarmSec, out.breakSec - 2);
    if (!['chime', 'beep', 'bell'].includes(out.sound)) out.sound = DEFAULTS.sound;
    out.volume = Math.min(100, Math.max(10, Number(out.volume) || DEFAULTS.volume));
    out.wakeLock = !!out.wakeLock;
    return out;
  }

  let settings = loadSettings();

  /* ---------------- 音の合成 ---------------- */

  // which: 'rest'（休憩の合図） / 'work'（再開の合図）
  // 各パターンは [フレーズ長, [開始秒, 周波数, 長さ, 減衰, 倍音[]][]]
  // 倍音はサンプリング周波数の半分（4kHz）未満に収めて折り返しノイズを防ぐ
  const PATTERNS = {
    chime: {
      rest: [1.9, [[0, 659.3, 1.3, 3, [[1, 1], [2, 0.3], [3, 0.08]]], [0.55, 523.3, 1.3, 3, [[1, 1], [2, 0.3], [3, 0.08]]]]],
      work: [1.6, [[0, 523.3, 1.0, 3.5, [[1, 1], [2, 0.25]]], [0.22, 659.3, 1.0, 3.5, [[1, 1], [2, 0.25]]], [0.44, 784, 1.1, 3.5, [[1, 1], [2, 0.25]]]]],
    },
    beep: {
      rest: [1.0, [0, 0.15, 0.3, 0.45].map((t) => [t, 2093, 0.09, 0, [[1, 1]]])],
      work: [1.0, [0, 0.2].map((t) => [t, 1568, 0.12, 0, [[1, 1]]])],
    },
    bell: {
      rest: [2.4, [[0, 523.3, 2.2, 1.6, [[1, 1], [2.76, 0.4], [5.4, 0.15]]], [1.2, 523.3, 1.2, 1.6, [[1, 1], [2.76, 0.4], [5.4, 0.15]]]]],
      work: [1.6, [[0, 784, 1.2, 2.2, [[1, 1], [2.76, 0.3]]], [0.4, 784, 1.2, 2.2, [[1, 1], [2.76, 0.3]]]]],
    },
  };

  // アラーム1回分（seconds 秒）の波形を -1..1 で返す
  function renderAlarm(sound, which, seconds, volume) {
    const n = Math.round(seconds * SAMPLE_RATE);
    const out = new Float32Array(n);
    const [phraseLen, notes] = PATTERNS[sound][which];

    for (let p = 0; p < seconds - 0.15; p += phraseLen) {
      for (const [start, freq, dur, decay, partials] of notes) {
        const n0 = Math.round((p + start) * SAMPLE_RATE);
        const len = Math.round(dur * SAMPLE_RATE);
        for (let i = 0; i < len && n0 + i < n; i++) {
          const t = i / SAMPLE_RATE;
          const attack = Math.min(1, t / 0.006);
          const release = Math.min(1, (dur - t) / 0.012);
          const env = attack * release * Math.exp(-decay * t);
          let v = 0;
          for (const [mult, w] of partials) v += w * Math.sin(2 * Math.PI * freq * mult * t);
          out[n0 + i] += env * v;
        }
      }
    }

    let peak = 0;
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
    const gain = peak > 0 ? (0.95 * volume / 100) / peak : 0;
    const fade = Math.round(0.04 * SAMPLE_RATE);
    for (let i = 0; i < n; i++) {
      const f = i > n - fade ? (n - i) / fade : 1;
      out[i] *= gain * f;
    }
    return out;
  }

  // 8bit PCM の WAV を作る（無音＝128）
  function makeWav(totalSamples, segments) {
    const buf = new ArrayBuffer(44 + totalSamples);
    const view = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF');
    view.setUint32(4, 36 + totalSamples, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);            // PCM
    view.setUint16(22, 1, true);            // モノラル
    view.setUint32(24, SAMPLE_RATE, true);
    view.setUint32(28, SAMPLE_RATE, true);  // byte rate
    view.setUint16(32, 1, true);            // block align
    view.setUint16(34, 8, true);            // bits per sample
    str(36, 'data');
    view.setUint32(40, totalSamples, true);

    const data = new Uint8Array(buf, 44);
    data.fill(128);
    for (const [offset, samples] of segments) {
      for (let i = 0; i < samples.length && offset + i < totalSamples; i++) {
        data[offset + i] = Math.max(0, Math.min(255, Math.round(128 + samples[i] * 127)));
      }
    }
    return new Blob([buf], { type: 'audio/wav' });
  }

  function buildCycleTrack(s) {
    const workSec = s.workMin * 60;
    const total = Math.round((workSec + s.breakSec) * SAMPLE_RATE);
    return makeWav(total, [
      [0, renderAlarm(s.sound, 'work', s.alarmSec, s.volume)],
      [Math.round(workSec * SAMPLE_RATE), renderAlarm(s.sound, 'rest', s.alarmSec, s.volume)],
    ]);
  }

  /* ---------------- 再生エンジン ---------------- */

  const audio = new Audio();
  audio.loop = true;
  audio.preload = 'auto';
  audio.setAttribute('playsinline', '');

  let trackUrl = null;
  let trackKey = '';
  let active = null;        // 再生中トラックの設定
  let state = 'idle';       // idle | running | paused
  let loops = 0;            // 完了したサイクル数
  let lastT = 0;
  let lastWall = 0;
  let prevPhase = null;

  const keyOf = (s) => [s.workMin, s.breakSec, s.alarmSec, s.sound, s.volume].join('|');

  function cycleOf(s) {
    const work = s.workMin * 60;
    return { work, rest: s.breakSec, total: work + s.breakSec };
  }

  function start() {
    if (state === 'paused') {
      lastWall = Date.now();
      audio.play().then(onPlaying).catch(onPlayError);
      state = 'running';
      render();
      return;
    }

    const key = keyOf(settings);
    if (key !== trackKey) {
      if (trackUrl) URL.revokeObjectURL(trackUrl);
      trackUrl = URL.createObjectURL(buildCycleTrack(settings));
      trackKey = key;
      audio.src = trackUrl;
    } else if (audio.readyState > 0) {
      audio.currentTime = 0;
    }
    active = { ...settings };
    loops = 0;
    lastT = 0;
    lastWall = Date.now();
    prevPhase = 'work';
    state = 'running';
    // iOS ではタップ処理の中で同期的に play() を呼ぶ必要がある
    audio.play().then(onPlaying).catch(onPlayError);
    render();
  }

  function pause() {
    state = 'paused';
    audio.pause();
    releaseWakeLock();
    render();
  }

  function reset() {
    state = 'idle';
    audio.pause();
    if (audio.readyState > 0) audio.currentTime = 0;
    loops = 0;
    lastT = 0;
    active = null;
    prevPhase = null;
    releaseWakeLock();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'none';
    render();
  }

  function onPlaying() {
    updateMediaSession();
    requestWakeLock();
  }

  function onPlayError(err) {
    console.warn(err);
    if (state === 'running') state = active && audio.currentTime > 0 ? 'paused' : 'idle';
    setMessage('音を再生できませんでした。もう一度ボタンを押してください。');
    render(true);
  }

  // ロック画面の操作・電話着信・他アプリの再生などによる一時停止/再開に追従
  audio.addEventListener('pause', () => {
    if (state === 'running') {
      state = 'paused';
      releaseWakeLock();
      render();
    }
    if ('mediaSession' in navigator && state !== 'idle') navigator.mediaSession.playbackState = 'paused';
  });

  audio.addEventListener('play', () => {
    if (state === 'paused' && active) {
      state = 'running';
      lastWall = Date.now();
      requestWakeLock();
      render();
    }
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
  });

  // loop が効かない環境向けの保険
  audio.addEventListener('ended', () => {
    if (state === 'running') {
      audio.currentTime = 0;
      audio.play().catch(onPlayError);
    }
  });

  /* ---------------- メディアセッション（ロック画面表示） ---------------- */

  function updateMediaSession() {
    if (!('mediaSession' in navigator) || !active) return;
    const c = cycleOf(active);
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: '目の休憩タイマー',
        artist: `作業${active.workMin}分 → 休憩${formatBreak(active.breakSec)} を繰り返し`,
        artwork: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      });
      navigator.mediaSession.playbackState = state === 'running' ? 'playing' : 'paused';
      if (navigator.mediaSession.setPositionState && isFinite(audio.currentTime)) {
        navigator.mediaSession.setPositionState({
          duration: c.total,
          playbackRate: 1,
          position: Math.min(audio.currentTime, c.total),
        });
      }
    } catch (_) { /* 非対応ブラウザは無視 */ }
  }

  if ('mediaSession' in navigator) {
    const set = (action, fn) => { try { navigator.mediaSession.setActionHandler(action, fn); } catch (_) { /* 未対応アクション */ } };
    set('play', () => start());
    set('pause', () => pause());
    set('stop', () => reset());
    ['seekbackward', 'seekforward', 'seekto', 'previoustrack', 'nexttrack'].forEach((a) => set(a, null));
  }

  /* ---------------- 画面の点灯維持 ---------------- */

  let wakeLock = null;

  async function requestWakeLock() {
    if (!settings.wakeLock || state !== 'running' || document.visibilityState !== 'visible') return;
    if (!('wakeLock' in navigator) || wakeLock) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (_) { wakeLock = null; }
  }

  function releaseWakeLock() {
    if (wakeLock) {
      wakeLock.release().catch(() => {});
      wakeLock = null;
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      requestWakeLock();
      tick();
      updateMediaSession();
    }
  });

  /* ---------------- 試聴 ---------------- */

  const preview = new Audio();
  preview.setAttribute('playsinline', '');
  let previewUrl = null;

  function playPreview(which) {
    const s = settings;
    const lead = Math.round(0.1 * SAMPLE_RATE);
    const samples = renderAlarm(s.sound, which, s.alarmSec, s.volume);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(makeWav(lead + samples.length, [[lead, samples]]));
    preview.src = previewUrl;
    preview.play().catch((e) => console.warn(e));
  }

  /* ---------------- 表示 ---------------- */

  const $ = (id) => document.getElementById(id);
  const el = {
    card: $('timer-card'),
    ring: $('ring-bar'),
    phase: $('phase-label'),
    time: $('time-label'),
    next: $('next-label'),
    message: $('message'),
    start: $('btn-start'),
    reset: $('btn-reset'),
    cycles: $('stat-cycles'),
    elapsed: $('stat-elapsed'),
    badge: $('bg-badge'),
    lockHint: $('lock-hint'),
    flash: $('flash'),
    volume: $('in-volume'),
    volumeOut: $('out-volume'),
    wakeLock: $('in-wakelock'),
    testRest: $('btn-test-rest'),
    testWork: $('btn-test-work'),
    defaults: $('btn-defaults'),
    chips: document.querySelectorAll('#sound-chips .chip'),
  };

  function formatBreak(sec) {
    if (sec < 60) return `${sec}秒`;
    const m = Math.floor(sec / 60);
    const r = sec % 60;
    return r ? `${m}分${r}秒` : `${m}分`;
  }

  function mmss(sec) {
    const s = Math.max(0, Math.ceil(sec - 0.001));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  function formatElapsed(sec) {
    const m = Math.floor(sec / 60);
    if (m < 60) return `${m}分`;
    return `${Math.floor(m / 60)}時間${m % 60}分`;
  }

  let stickyMessage = '';
  function setMessage(text) { stickyMessage = text; }

  function flash(kind) {
    el.flash.classList.remove('on', 'work');
    void el.flash.offsetWidth; // アニメーションを再始動
    if (kind === 'work') el.flash.classList.add('work');
    el.flash.classList.add('on');
    if (navigator.vibrate) {
      try { navigator.vibrate(kind === 'rest' ? [300, 150, 300, 150, 300] : [200, 100, 200]); } catch (_) { /* 無視 */ }
    }
  }

  function tick() {
    if (state === 'idle' || !active) {
      render();
      return;
    }
    const c = cycleOf(active);
    const t = audio.currentTime % c.total;

    if (state === 'running') {
      // 画面が消えていた間に何周したかを、音声の進みと実時間から推定
      const now = Date.now();
      let advanced = t - lastT;
      const wrapped = advanced < -0.5;
      if (wrapped) advanced += c.total;
      const wall = (now - lastWall) / 1000;
      const extra = Math.max(0, Math.round((wall - advanced) / c.total));
      loops += (wrapped ? 1 : 0) + extra;
      lastWall = now;
    }
    lastT = t;

    const phase = t < c.work ? 'work' : 'rest';
    if (state === 'running' && prevPhase && phase !== prevPhase && document.visibilityState === 'visible') {
      flash(phase);
      updateMediaSession();
    }
    prevPhase = phase;
    render();
  }

  function render(keepMessage) {
    const s = active || settings;
    const c = cycleOf(s);
    const idle = state === 'idle' || !active;
    const t = idle ? 0 : (audio.currentTime % c.total) || 0;
    const phase = idle ? 'idle' : (t < c.work ? 'work' : 'rest');

    el.card.dataset.phase = phase;

    let remaining;
    let progress;
    if (phase === 'rest') {
      remaining = c.total - t;
      progress = (t - c.work) / c.rest;
      el.phase.textContent = state === 'paused' ? '一時停止中（休憩）' : '休憩中';
      el.next.textContent = '終わると再開の合図';
    } else {
      remaining = c.work - t;
      progress = t / c.work;
      el.phase.textContent = idle ? '準備OK' : state === 'paused' ? '一時停止中' : '作業中';
      el.next.textContent = idle ? 'スタートで計測開始' : `次の休憩まで（休憩${formatBreak(c.rest)}）`;
    }
    el.time.textContent = mmss(remaining);
    el.ring.style.strokeDashoffset = String(RING_LEN * Math.min(1, Math.max(0, progress)));

    if (!keepMessage) {
      if (stickyMessage && state !== 'running') {
        el.message.textContent = stickyMessage;
      } else {
        stickyMessage = '';
        el.message.textContent =
          phase === 'rest' ? '画面から目を離して、遠く（6m以上先）を眺めましょう。まばたきも忘れずに。'
          : state === 'paused' ? '一時停止しています。「再開」で続きから計測します。'
          : state === 'running' ? '画面を消してもOK。時間になると音でお知らせします。'
          : `${s.workMin}分ごとに休憩の合図、${formatBreak(s.breakSec)}後に再開の合図が鳴ります。`;
      }
    } else {
      el.message.textContent = stickyMessage;
    }

    el.start.textContent = state === 'running' ? '一時停止' : state === 'paused' ? '再開' : 'スタート';
    el.reset.disabled = idle;
    el.badge.hidden = state !== 'running';

    const elapsed = idle ? 0 : loops * c.total + t;
    el.cycles.textContent = `${idle ? 0 : loops} 回`;
    el.elapsed.textContent = formatElapsed(elapsed);

    document.title = idle ? '目の休憩タイマー' : `${mmss(remaining)} ${phase === 'rest' ? '休憩中' : '作業中'} | 目の休憩タイマー`;

    renderSettings();
  }

  function renderSettings() {
    const locked = state !== 'idle';
    el.lockHint.hidden = !locked;

    document.querySelectorAll('.stepper').forEach((st) => {
      const key = st.dataset.key;
      const list = optionsFor(key);
      const v = settings[key];
      st.querySelector('output').textContent =
        key === 'workMin' ? `${v}分` : key === 'breakSec' ? formatBreak(v) : `${v}秒`;
      st.querySelector('[data-dir="-1"]').disabled = locked || v <= list[0];
      st.querySelector('[data-dir="1"]').disabled = locked || v >= list[list.length - 1];
    });

    el.chips.forEach((chip) => {
      chip.setAttribute('aria-checked', String(chip.dataset.sound === settings.sound));
      chip.disabled = locked;
    });
    el.volume.value = settings.volume;
    el.volume.disabled = locked;
    el.volumeOut.textContent = `${settings.volume}%`;
    el.wakeLock.checked = settings.wakeLock;
    el.testRest.disabled = locked;
    el.testWork.disabled = locked;
    el.defaults.disabled = locked;
  }

  function optionsFor(key) {
    if (key === 'alarmSec') return OPTIONS.alarmSec.filter((v) => v <= settings.breakSec - 2);
    return OPTIONS[key];
  }

  /* ---------------- 入力 ---------------- */

  function updateSetting(key, value) {
    if (state !== 'idle' && key !== 'wakeLock') return;
    settings = normalize({ ...settings, [key]: value });
    saveSettings();
    render();
  }

  function bump(key, dir) {
    const list = optionsFor(key);
    const i = list.indexOf(nearest(list, settings[key]));
    const next = list[Math.min(list.length - 1, Math.max(0, i + dir))];
    if (next !== settings[key]) updateSetting(key, next);
  }

  document.querySelectorAll('.stepper').forEach((st) => {
    const key = st.dataset.key;
    st.querySelectorAll('.step').forEach((btn) => {
      const dir = Number(btn.dataset.dir);
      let delay = null;
      let repeat = null;
      const stop = () => { clearTimeout(delay); clearInterval(repeat); delay = repeat = null; };

      // 押しっぱなしで連続変更
      btn.addEventListener('pointerdown', (e) => {
        if (btn.disabled) return;
        e.preventDefault();
        stop();
        bump(key, dir);
        delay = setTimeout(() => {
          repeat = setInterval(() => {
            if (btn.disabled) return stop();
            bump(key, dir);
          }, 90);
        }, 450);
      });
      ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => btn.addEventListener(ev, stop));
      // キーボード操作（Enter / Space）
      btn.addEventListener('click', (e) => { if (e.detail === 0) bump(key, dir); });
    });
  });

  el.chips.forEach((chip) => chip.addEventListener('click', () => updateSetting('sound', chip.dataset.sound)));
  el.volume.addEventListener('input', () => updateSetting('volume', Number(el.volume.value)));
  el.wakeLock.addEventListener('change', () => {
    updateSetting('wakeLock', el.wakeLock.checked);
    if (settings.wakeLock) requestWakeLock(); else releaseWakeLock();
  });
  el.testRest.addEventListener('click', () => playPreview('rest'));
  el.testWork.addEventListener('click', () => playPreview('work'));
  el.defaults.addEventListener('click', () => {
    if (state !== 'idle') return;
    settings = normalize({ ...DEFAULTS, wakeLock: settings.wakeLock });
    saveSettings();
    render();
  });

  el.start.addEventListener('click', () => {
    if (state === 'running') pause(); else start();
  });
  el.reset.addEventListener('click', reset);

  setInterval(tick, 250);
  render();

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();

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
  // スケジュールは「開始時刻（anchor）からの実時間」で決め、音声はそれに再生位置を
  // 合わせて流すだけにしている。他アプリに音を止められたり、メモリ不足で OS に
  // ページを破棄されて開き直しになっても、スケジュールはずれずに続き、
  // 再開時は本来の位置から音が鳴る。

  const RUN_KEY = 'dryeye-timer-run-v1';
  const RESTORE_LIMIT_MS = 12 * 60 * 60 * 1000; // これより古い実行状態は復元しない

  const audio = new Audio();
  audio.loop = true;
  audio.preload = 'auto';
  audio.setAttribute('playsinline', '');

  let trackUrl = null;
  let trackKey = '';
  let active = null;        // 実行中タイマーの設定
  let state = 'idle';       // idle | running | paused
  let interrupted = false;  // running なのに音が止められている（他アプリの音声・着信・ページ再読込など）
  let anchor = 0;           // 経過0秒にあたる時刻（ms）
  let pausedElapsed = 0;    // 一時停止した時点の経過秒
  let pendingSeek = false;
  let prevPhase = null;

  const keyOf = (s) => [s.workMin, s.breakSec, s.alarmSec, s.sound, s.volume].join('|');

  function cycleOf(s) {
    const work = s.workMin * 60;
    return { work, rest: s.breakSec, total: work + s.breakSec };
  }

  function elapsedSec() {
    if (state === 'running') return Math.max(0, (Date.now() - anchor) / 1000);
    if (state === 'paused') return pausedElapsed;
    return 0;
  }

  function saveRun() {
    try {
      if (state === 'idle') localStorage.removeItem(RUN_KEY);
      else localStorage.setItem(RUN_KEY, JSON.stringify({ state, anchor, pausedElapsed, active, savedAt: Date.now() }));
    } catch (_) { /* 保存不可でも動作は継続 */ }
  }

  function ensureTrack(s) {
    const key = keyOf(s);
    if (key === trackKey) return;
    if (trackUrl) URL.revokeObjectURL(trackUrl);
    trackUrl = URL.createObjectURL(buildCycleTrack(s));
    trackKey = key;
    audio.src = trackUrl;
  }

  // 音声の再生位置を実時間のスケジュールに合わせる
  function syncPosition(force) {
    if (!active || state !== 'running') return;
    if (audio.readyState === 0) {
      pendingSeek = true;
      return;
    }
    const total = cycleOf(active).total;
    const target = elapsedSec() % total;
    const d = Math.abs(audio.currentTime - target);
    if (force || Math.min(d, total - d) > 1.5) {
      try { audio.currentTime = target; } catch (_) { /* 読み込み途中は loadedmetadata で再試行 */ }
    }
  }

  audio.addEventListener('loadedmetadata', () => {
    if (pendingSeek) {
      pendingSeek = false;
      syncPosition(true);
    }
  });

  // iOS ではタップ処理の中で同期的に play() を呼ぶ必要がある
  function playAudio() {
    ensureTrack(active);
    syncPosition(true);
    audio.play().then(() => {
      interrupted = false;
      updateMediaSession();
      requestWakeLock();
      render();
    }).catch((err) => {
      console.warn(err);
      if (state === 'running') interrupted = true;
      render();
    });
  }

  function start() {
    if (state === 'idle') {
      active = { ...settings };
      anchor = Date.now();
      pausedElapsed = 0;
      prevPhase = 'work';
    } else if (state === 'paused') {
      anchor = Date.now() - pausedElapsed * 1000;
    }
    // running のときは「止められた音を戻す」だけ（スケジュールはそのまま）
    state = 'running';
    saveRun();
    playAudio();
    render();
  }

  function pause() {
    pausedElapsed = elapsedSec();
    state = 'paused';
    interrupted = false;
    audio.pause();
    releaseWakeLock();
    saveRun();
    render();
  }

  function reset() {
    state = 'idle';
    interrupted = false;
    audio.pause();
    active = null;
    pausedElapsed = 0;
    prevPhase = null;
    releaseWakeLock();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'none';
    saveRun();
    render();
  }

  // 自分で止めていないのに止まった＝他アプリの音声・着信などで止められた。
  // スケジュールは進み続け、画面に戻ったときに自動で再開を試みる。
  audio.addEventListener('pause', () => {
    if (state === 'running') {
      interrupted = true;
      releaseWakeLock();
      render();
    }
    if ('mediaSession' in navigator && state !== 'idle') navigator.mediaSession.playbackState = 'paused';
  });

  audio.addEventListener('play', () => {
    if (state === 'paused' && active) {
      start(); // ロック画面などから再開された
      return;
    }
    if (state === 'running') {
      // 着信終了後などに OS が自動で再開した場合も、止まっていた分の位置を合わせる
      interrupted = false;
      syncPosition();
      requestWakeLock();
      render();
    }
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
  });

  // loop が効かない環境向けの保険
  audio.addEventListener('ended', () => {
    if (state === 'running') {
      syncPosition(true);
      audio.play().catch(() => { interrupted = true; render(); });
    }
  });

  // ページが OS に破棄されて開き直された場合に、実行中のタイマーを引き継ぐ
  function restoreRun() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(RUN_KEY) || 'null'); } catch (_) { /* 壊れていたら無視 */ }
    if (!saved || !saved.active || !['running', 'paused'].includes(saved.state)) return;
    if (!(Date.now() - saved.savedAt < RESTORE_LIMIT_MS)) {
      try { localStorage.removeItem(RUN_KEY); } catch (_) { /* 無視 */ }
      return;
    }
    active = normalize(saved.active);
    anchor = Number(saved.anchor) || Date.now();
    pausedElapsed = Number(saved.pausedElapsed) || 0;
    state = saved.state;
    if (state === 'running') {
      interrupted = true;
      // 自動再生が許可されていればそのまま鳴り始める。だめなら「再開」ボタンで戻す
      playAudio();
    }
  }

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

  // 画面が見えていない間は表示更新を完全に止める（音声だけで動作する）。
  // 音声再生中のページはブラウザがタイマーを間引かないため、止めないと
  // 画面オフ中もずっと CPU を起こし続けてしまう。
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      prevPhase = null; // 戻った瞬間に合図の点滅を出さない
      if (state === 'running' && (interrupted || audio.paused)) playAudio();
      requestWakeLock();
      tick();
      updateMediaSession();
    } else {
      stopTicking();
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
    quit: $('btn-quit'),
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
    if (state === 'running' && active) {
      syncPosition();
      const c = cycleOf(active);
      const phase = elapsedSec() % c.total < c.work ? 'work' : 'rest';
      if (prevPhase && phase !== prevPhase) {
        flash(phase);
        updateMediaSession();
      }
      prevPhase = phase;
    }
    render();
  }

  // 表示の秒が切り替わる直後に1回だけ起きる（画面が見えていて動作中のときのみ）
  let tickTimer = null;

  function stopTicking() {
    clearTimeout(tickTimer);
    tickTimer = null;
  }

  function scheduleTick() {
    stopTicking();
    if (state !== 'running' || document.visibilityState !== 'visible') return;
    const frac = elapsedSec() % 1;
    tickTimer = setTimeout(tick, Math.round((1 - frac) * 1000) + 30);
  }

  // 値が変わったときだけ DOM に書き込む
  function setText(node, text) {
    if (node.textContent !== text) node.textContent = text;
  }

  let settingsSig = '';

  function render() {
    const s = active || settings;
    const c = cycleOf(s);
    const idle = state === 'idle' || !active;
    const elapsed = idle ? 0 : elapsedSec();
    const loops = Math.floor(elapsed / c.total);
    const t = elapsed % c.total;
    const phase = idle ? 'idle' : (t < c.work ? 'work' : 'rest');
    const silenced = state === 'running' && interrupted;

    if (el.card.dataset.phase !== phase) el.card.dataset.phase = phase;
    el.card.classList.toggle('silenced', silenced);

    let remaining;
    let progress;
    if (phase === 'rest') {
      remaining = c.total - t;
      progress = (t - c.work) / c.rest;
      setText(el.phase, state === 'paused' ? '一時停止中（休憩）' : '休憩中');
      setText(el.next, '終わると再開の合図');
    } else {
      remaining = c.work - t;
      progress = t / c.work;
      setText(el.phase, idle ? '準備OK' : state === 'paused' ? '一時停止中' : '作業中');
      setText(el.next, idle ? 'スタートで計測開始' : `次の休憩まで（休憩${formatBreak(c.rest)}）`);
    }
    setText(el.time, mmss(remaining));
    const offset = (RING_LEN * Math.min(1, Math.max(0, progress))).toFixed(1);
    if (el.ring.style.strokeDashoffset !== offset) el.ring.style.strokeDashoffset = offset;

    setText(el.message,
      silenced ? '他のアプリの音などでアラーム音が止められました。タイマーの時間は進んでいます。「再開」を押すと音が戻ります。'
      : phase === 'rest' ? '画面から目を離して、遠く（6m以上先）を眺めましょう。まばたきも忘れずに。'
      : state === 'paused' ? '一時停止しています。「再開」で続きから計測します。'
      : state === 'running' ? '画面を消してもOK。時間になると音でお知らせします。'
      : `${s.workMin}分ごとに休憩の合図、${formatBreak(s.breakSec)}後に再開の合図が鳴ります。`);

    setText(el.start, state === 'running' && !interrupted ? '一時停止' : state === 'idle' ? 'スタート' : '再開');
    el.reset.disabled = idle;
    el.badge.hidden = !(state === 'running' && !interrupted);

    setText(el.cycles, `${loops} 回`);
    setText(el.elapsed, formatElapsed(elapsed));

    const title = idle ? '目の休憩タイマー' : `${mmss(remaining)} ${phase === 'rest' ? '休憩中' : '作業中'} | 目の休憩タイマー`;
    if (document.title !== title) document.title = title;

    const sig = state + JSON.stringify(settings);
    if (sig !== settingsSig) {
      settingsSig = sig;
      renderSettings();
    }

    scheduleTick();
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
    if (state === 'running' && !interrupted) pause(); else start();
  });
  el.reset.addEventListener('click', reset);
  el.quit.addEventListener('click', quit);

  // 終了：音声・タイマー・ロック画面表示をすべて解放し、ページ自体も破棄する。
  // Webページはタブやブラウザを強制終了できないため、閉じられない場合は
  // 軽量な終了ページに置き換えてアプリのメモリを手放す。
  function quit() {
    if (state !== 'idle' && !window.confirm('タイマーを止めて終了しますか？')) return;

    state = 'idle';
    active = null;
    saveRun();
    stopTicking();
    releaseWakeLock();
    for (const a of [audio, preview]) {
      a.pause();
      a.removeAttribute('src');
      a.load(); // デコーダと読み込み済みデータを解放
    }
    if (trackUrl) URL.revokeObjectURL(trackUrl);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    trackUrl = previewUrl = null;
    trackKey = '';

    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.metadata = null;
        navigator.mediaSession.playbackState = 'none';
        ['play', 'pause', 'stop'].forEach((a) => navigator.mediaSession.setActionHandler(a, null));
      } catch (_) { /* 非対応ブラウザは無視 */ }
    }

    window.close();
    // replace なので「戻る」でアプリのページが復元（＝メモリに保持）されることもない
    location.replace('ended.html');
  }

  restoreRun();
  render();

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();

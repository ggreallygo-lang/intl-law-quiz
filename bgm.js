/*
 * bgm.js — 背景音乐（可扩展曲目结构，零依赖）
 *
 * v28（2026-09-14）：
 *   - 内置曲目：纯 Web Audio 合成的欢快小调循环（原创旋律，游戏厅 BGM 风格）
 *   - 自定义曲目：导入本地音频文件（mp3/m4a/ogg/wav），Blob 存 IndexedDB media 表，
 *     随时添加/删除；media 表不进备份导出（音乐可再导入，不让备份文件膨胀）
 *   - 曲目即数据：内置曲是 {synth:{bpm,lead,bass}}，自定义曲是 {blob}——
 *     以后要加内置曲，往 SYNTH_TRACKS 里塞一个对象就行，播放器自动识别
 *
 * 工程约束（与 sfx.js 一致）：
 *   - 音量压低（合成曲 master ~0.16，音频元素 0.25），不抢做题音效
 *   - iOS 自动播放策略：起播必须跟着手势；页面已有 pointerdown 预热钩子会调 resume()
 *   - 一切异常吞掉——背景音乐绝不允许把做题主流程搞挂
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BGM = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function store() {
    try { return (typeof localStorage !== 'undefined') ? localStorage : null; } catch (e) { return null; }
  }
  function readKey(k, dft) {
    var s = store();
    if (!s) return dft;
    try { var v = s.getItem(k); return v == null ? dft : v; } catch (e) { return dft; }
  }
  function writeKey(k, v) {
    var s = store();
    if (s) { try { s.setItem(k, v); } catch (e) {} }
  }

  // ---- 内置合成曲目注册表：音符 = [起拍, midi, 时值(拍)]，midi 用 0 表示休止 ----
  // 原创欢快小调：C 大调五声风格，领奏方波 + 低音三角波「蹦恰」伴奏
  var SYNTH_TRACKS = {
    cheery: {
      label: '欢快小调（内置）', bpm: 132,
      lead: [
        [0, 76, 0.5], [0.5, 79, 0.5], [1, 81, 0.5], [1.5, 79, 0.5], [2, 76, 1], [3, 74, 1],
        [4, 76, 0.5], [4.5, 79, 0.5], [5, 81, 0.5], [5.5, 84, 0.5], [6, 79, 1], [7, 76, 1],
        [8, 74, 0.5], [8.5, 76, 0.5], [9, 79, 0.5], [9.5, 76, 0.5], [10, 74, 1], [11, 72, 1],
        [12, 76, 0.5], [12.5, 79, 0.5], [13, 81, 0.5], [13.5, 84, 0.5], [14, 81, 1], [15, 72, 1]
      ],
      bass: [
        [0, 48, 0.9], [1, 55, 0.9], [2, 48, 0.9], [3, 55, 0.9],
        [4, 45, 0.9], [5, 52, 0.9], [6, 45, 0.9], [7, 52, 0.9],
        [8, 50, 0.9], [9, 57, 0.9], [10, 50, 0.9], [11, 57, 0.9],
        [12, 48, 0.9], [13, 55, 0.9], [14, 53, 0.9], [15, 55, 0.9]
      ],
      bars: 4                                   // 16 拍一循环
    },
    // v30：斗地主风·喜庆（原创曲目，欢快斗地主同风格——D 大调、150bpm、
    // 蹦跳的低音 + 高音区抓耳 hook，喜庆牌局味；非腾讯原曲，无版权问题）
    ddz: {
      label: '斗地主风·喜庆（内置）', bpm: 150,
      lead: [
        [0, 74, 0.5], [0.5, 74, 0.5], [1, 71, 0.5], [1.5, 74, 0.5], [2, 78, 1], [3, 74, 1],
        [4, 76, 0.5], [4.5, 74, 0.5], [5, 71, 0.5], [5.5, 69, 0.5], [6, 71, 1], [7, 69, 1],
        [8, 74, 0.5], [8.5, 74, 0.5], [9, 71, 0.5], [9.5, 74, 0.5], [10, 78, 1], [11, 81, 1],
        [12, 79, 0.5], [12.5, 78, 0.5], [13, 76, 0.5], [13.5, 74, 0.5], [14, 76, 1], [15, 74, 1],
        [16, 71, 0.5], [16.5, 71, 0.5], [17, 69, 0.5], [17.5, 71, 0.5], [18, 74, 1], [19, 71, 1],
        [20, 76, 0.5], [20.5, 74, 0.5], [21, 71, 0.5], [21.5, 69, 0.5], [22, 66, 1], [23, 69, 1],
        [24, 74, 0.5], [24.5, 76, 0.5], [25, 78, 0.5], [25.5, 79, 0.5], [26, 78, 1], [27, 76, 1],
        [28, 74, 0.5], [28.5, 71, 0.5], [29, 69, 0.5], [29.5, 66, 0.5], [30, 62, 1], [31, 62, 1]
      ],
      bass: [
        [0, 50, 0.9], [1, 57, 0.9], [2, 50, 0.9], [3, 57, 0.9],
        [4, 47, 0.9], [5, 54, 0.9], [6, 47, 0.9], [7, 54, 0.9],
        [8, 50, 0.9], [9, 57, 0.9], [10, 50, 0.9], [11, 57, 0.9],
        [12, 43, 0.9], [13, 50, 0.9], [14, 43, 0.9], [15, 50, 0.9],
        [16, 47, 0.9], [17, 54, 0.9], [18, 47, 0.9], [19, 54, 0.9],
        [20, 40, 0.9], [21, 47, 0.9], [22, 40, 0.9], [23, 47, 0.9],
        [24, 43, 0.9], [25, 50, 0.9], [26, 43, 0.9], [27, 50, 0.9],
        [28, 50, 0.9], [29, 57, 0.9], [30, 45, 0.9], [31, 50, 0.9]
      ],
      bars: 8                                   // 32 拍一循环
    }
  };

  var _enabled = readKey('bgm-off', '0') !== '1';
  var _track = readKey('bgm-track', 'cheery');
  var _playing = false;
  var _ctx = null, _master = null, _timer = null, _nextBeat = 0, _startedAt = 0;
  var _audioEl = null, _objUrl = null;

  function ac() {
    if (!_ctx) {
      var AC = (typeof window !== 'undefined') && (window.AudioContext || window.webkitAudioContext);
      if (!AC) return null;
      try { _ctx = new AC(); } catch (e) { return null; }
    }
    if (_ctx.state === 'suspended') { try { _ctx.resume(); } catch (e) {} }
    return _ctx;
  }
  function midiHz(m) { return 440 * Math.pow(2, (m - 69) / 12); }

  // 合成音符（方波领奏 / 三角低音），音量经 master 压低
  function schedNote(t, midi, dur, isBass) {
    var c = _ctx;
    var osc = c.createOscillator();
    var g = c.createGain();
    osc.type = isBass ? 'triangle' : 'square';
    osc.frequency.value = midiHz(midi);
    var vol = isBass ? 0.5 : 0.32;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + Math.max(0.06, dur * 0.92));
    osc.connect(g); g.connect(_master);
    osc.start(t); osc.stop(t + dur + 0.03);
  }

  // 前瞻式调度器：每 120ms 把未来 300ms 内的音符排进音频时钟，循环无缝
  function startSynth(track) {
    var c = ac();
    if (!c) return false;
    _master = _ctx.createGain();
    _master.gain.value = 0.16;
    _master.connect(_ctx.destination);
    _startedAt = _ctx.currentTime + 0.1;
    _nextBeat = 0;
    var spb = 60 / track.bpm;                   // 每拍秒数
    _timer = setInterval(function () {
      try {
        var horizon = _ctx.currentTime + 0.3;
        var totalBeats = track.bars * 4;
        // 排完一个循环就从头再来（_nextBeat 单调递增，对 totalBeats 取模定位）
        while (_startedAt + _nextBeat * spb < horizon) {
          var pos = _nextBeat % totalBeats;
          for (var i = 0; i < track.lead.length; i++) {
            if (Math.abs(track.lead[i][0] - pos) < 1e-9) {
              schedNote(_startedAt + _nextBeat * spb, track.lead[i][1], track.lead[i][2] * spb, false);
            }
          }
          for (var j = 0; j < track.bass.length; j++) {
            if (Math.abs(track.bass[j][0] - pos) < 1e-9) {
              schedNote(_startedAt + _nextBeat * spb, track.bass[j][1], track.bass[j][2] * spb, true);
            }
          }
          _nextBeat += 0.5;
        }
      } catch (e) {}
    }, 120);
    return true;
  }

  function stopSynth() {
    if (_timer) { clearInterval(_timer); _timer = null; }
    if (_master) { try { _master.disconnect(); } catch (e) {} _master = null; }
    _nextBeat = 0;
  }

  function startBlob(track) {
    if (typeof Audio === 'undefined') return false;
    if (_objUrl) { try { URL.revokeObjectURL(_objUrl); } catch (e) {} _objUrl = null; }
    _objUrl = URL.createObjectURL(track.blob);
    _audioEl = new Audio(_objUrl);
    _audioEl.loop = true;
    _audioEl.volume = 0.25;                     // iOS 会忽略，其余平台压低
    return _audioEl.play().then(function () { return true; }).catch(function () { return false; });
  }

  function stopBlob() {
    if (_audioEl) { try { _audioEl.pause(); } catch (e) {} _audioEl = null; }
    if (_objUrl) { try { URL.revokeObjectURL(_objUrl); } catch (e) {} _objUrl = null; }
  }

  function stopAll() {
    stopSynth(); stopBlob();
    _playing = false;
  }

  return {
    enabled: function () { return _enabled; },
    setEnabled: function (on) {
      _enabled = !!on;
      writeKey('bgm-off', on ? '0' : '1');
      if (!_enabled) stopAll();
      return _enabled;
    },
    getTrack: function () { return _track; },
    setTrack: function (id) {
      _track = String(id || 'cheery');
      writeKey('bgm-track', _track);
      return _track;
    },
    isPlaying: function () { return _playing; },
    /** 曲目清单：内置 + 自定义（自定义来自 IndexedDB media 表） */
    tracks: function () {
      var list = Object.keys(SYNTH_TRACKS).map(function (k) {
        return { id: k, label: SYNTH_TRACKS[k].label, builtin: true };
      });
      var p = (typeof DB !== 'undefined' && DB.listMedia)
        ? DB.listMedia('bgm').catch(function () { return []; })
        : Promise.resolve([]);
      return p.then(function (custom) {
        (custom || []).forEach(function (m) {
          list.push({ id: m.id, label: (m.name || '自定义') + '（本地）', builtin: false });
        });
        return list;
      });
    },
    /** 起播当前曲目（须在用户手势里调用）；返回是否成功 */
    start: function () {
      if (!_enabled || _playing) return _playing;
      try {
        if (SYNTH_TRACKS[_track]) {
          _playing = startSynth(SYNTH_TRACKS[_track]);
          return _playing;
        }
        var p = (typeof DB !== 'undefined' && DB.getMedia) ? DB.getMedia(_track) : Promise.resolve(null);
        p.then(function (m) {
          if (!m || !m.blob) return;
          if (!_enabled || _playing) return;
          startBlob(m).then(function (ok) { _playing = ok; }).catch(function () {});
        }).catch(function () {});
        return true;                            // 异步起播，先报成功
      } catch (e) { return false; }
    },
    stop: function () { stopAll(); },
    /** 页面已有手势预热钩子调用：开着但没播就补播（iOS 策略） */
    resume: function () {
      if (_enabled && !_playing) this.start();
    },
    /** 自定义曲目管理（落 IndexedDB media 表，App 层直接调） */
    addFile: function (file) {
      if (typeof DB === 'undefined' || !DB.saveMedia || !file) return Promise.reject(new Error('不支持'));
      var id = 'bgm-' + Date.now() + '-' + Math.random().toString(16).slice(2, 8);
      return DB.saveMedia({ id: id, kind: 'bgm', name: (file.name || '自定义').replace(/\.[^.]+$/, '').slice(0, 30), blob: file })
        .then(function () { return id; });
    },
    removeCustom: function (id) {
      if (typeof DB === 'undefined' || !DB.deleteMedia) return Promise.resolve(false);
      if (_track === id) { stopAll(); this.setTrack('cheery'); }
      return DB.deleteMedia(id).then(function () { return true; });
    }
  };
});

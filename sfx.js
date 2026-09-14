/*
 * sfx.js — 轻量音效 + 震动（Web Audio 实时合成，零素材、零依赖）
 *
 * v22（2026-09-14）：六种音效（flip/right/wrong/neutral/warn/done）+ 总开关。
 * v23（2026-09-14）：
 *   - 音效包：清脆（默认）/ 柔和 / 木质 三组音色，只改波形、频率组与音量系数，仍是纯合成
 *   - 震动：navigator.vibrate（安卓/部分浏览器可用；iOS Safari 不支持——设置里照常可关，
 *     不支持的设备上 UI 层会隐藏该选项）
 *   - 偏好全部记 localStorage：sfx-off / sfx-pack / vibe-off
 * v26（2026-09-14）：
 *   - 第四组「怀旧」包：早期 QQ 梗系列——翻卡=游戏大厅切桌「刷刷刷」，答对=「滴滴」，
 *     答错=系统消息「咳咳」，完成=好友上线「咚咚」敲门。走 pack.synth 自定义合成，
 *     其余三包仍是参数化 tone/noise 老路径
 *
 * 工程约束不变：
 *   - AudioContext 懒创建，首次手势 warm()（iOS 自动播放策略）
 *   - 任何内部异常都吞掉——音效/震动绝不允许把做题主流程搞挂
 *   - 音量刻意压低，是「反馈感」不是「打扰」
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SFX = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function store() {
    try { return (typeof localStorage !== 'undefined') ? localStorage : null; } catch (e) { return null; }
  }
  function readKey(k, dft) {
    const s = store();
    if (!s) return dft;
    try { const v = s.getItem(k); return v == null ? dft : v; } catch (e) { return dft; }
  }
  function writeKey(k, v) {
    const s = store();
    if (s) { try { s.setItem(k, v); } catch (e) {} }
  }

  // ---- 音效包定义：wave 正答波形 / wrongWave 错答波形 / 频率组 / flip 噪声扫频区间 / vol 音量系数 ----
  // retro 走 synth：事件 → 自定义合成函数（见下方积木），给「怀旧 QQ」系列用
  var PACKS = {
    crisp: { label: '清脆', wave: 'sine',     wrongWave: 'triangle', vol: 1,
             right: [659, 880], wrong: [220, 150], done: [523, 659, 784], warn: 880, neutral: 440, flip: [900, 2600] },
    soft:  { label: '柔和', wave: 'triangle', wrongWave: 'sine',     vol: 0.8,
             right: [494, 587], wrong: [175, 131], done: [392, 494, 587], warn: 660, neutral: 330, flip: [400, 1400] },
    wood:  { label: '木质', wave: 'square',   wrongWave: 'square',   vol: 0.5,
             right: [988, 1319], wrong: [147, 110], done: [784, 988, 1319], warn: 1047, neutral: 494, flip: [700, 2000] },
    retro: { label: '怀旧', vol: 1,
             synth: {
               flip: function () {                 // QQ游戏大厅切桌「刷-刷-刷」
                 retroWhoosh(0, 1300, 2600);
                 retroWhoosh(105, 1500, 2800);
                 retroWhoosh(210, 1700, 3000);
               },
               right: function () {                // 经典消息「滴滴滴滴滴滴」六连快滴
                 retroBlip(1047, 0); retroBlip(1047, 70); retroBlip(1047, 140);
                 retroBlip(1047, 210); retroBlip(1047, 280); retroBlip(1047, 350);
               },
               wrong: function () {                // 系统消息「咳、咳」：第二声更重更低
                 retroCoughBurst(0, 820, 340, 0.09, 1.6);
                 retroCoughBurst(150, 660, 240, 0.16, 1.6);
               },
               neutral: function () { retroKnock(0); },   // 单声「咚」
               warn: function () {                  // 闹钟式「滴滴滴滴」
                 retroBlip(1175, 0); retroBlip(1175, 110);
                 retroBlip(1175, 220); retroBlip(1175, 330);
               },
               done: function () {                  // 好友上线「咚咚」+ 收尾上扬「滴滴」
                 retroKnock(0); retroKnock(150);
                 retroBlip(988, 420); retroBlip(1319, 515);
               }
             } }
  };
  function packOf(id) { return PACKS[id] || PACKS.crisp; }

  var _enabled = readKey('sfx-off', '0') !== '1';
  var _pack = readKey('sfx-pack', 'crisp');
  if (!PACKS[_pack]) _pack = 'crisp';
  var _vibe = readKey('vibe-off', '0') !== '1';

  var ctx = null;
  function ac() {
    if (!ctx) {
      var AC = (typeof window !== 'undefined') && (window.AudioContext || window.webkitAudioContext);
      if (!AC) return null;                      // Node 单测 / 极老浏览器：静默跳过
      try { ctx = new AC(); } catch (e) { return null; }
    }
    if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }
    return ctx;
  }

  function tone(freq, dur, opts) {
    var c = ac();
    if (!c || !_enabled) return;
    try {
      var p = packOf(_pack);
      var t = c.currentTime;
      var osc = c.createOscillator();
      var g = c.createGain();
      osc.type = (opts && opts.type) || p.wave;
      osc.frequency.setValueAtTime(freq, t);
      if (opts && opts.slideTo) osc.frequency.exponentialRampToValueAtTime(opts.slideTo, t + dur);
      var vol = ((opts && opts.gain != null) ? opts.gain : 0.06) * p.vol;
      g.gain.setValueAtTime(0.0001, t);          // 近零起坡，避免爆音
      g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(g); g.connect(c.destination);
      osc.start(t); osc.stop(t + dur + 0.02);
    } catch (e) {}
  }

  // 「刷刷」纸声：白噪声 + 带通滤波扫频（扫频区间随音效包走）；q 可调带宽，怀旧包的
  // 「咳咳」要更窄的带通才有喉音感，其余场景维持老的 0.8
  function noise(dur, gain, from, to, q) {
    var c = ac();
    if (!c || !_enabled) return;
    try {
      var p = packOf(_pack);
      var t = c.currentTime;
      var len = Math.max(1, Math.floor(c.sampleRate * dur));
      var buf = c.createBuffer(1, len, c.sampleRate);
      var d = buf.getChannelData(0);
      for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      var src = c.createBufferSource(); src.buffer = buf;
      var bp = c.createBiquadFilter();
      bp.type = 'bandpass'; bp.Q.value = q || 0.8;
      bp.frequency.setValueAtTime(from || p.flip[0], t);
      bp.frequency.exponentialRampToValueAtTime(to || p.flip[1], t + dur);
      var g = c.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(gain * p.vol, t + dur * 0.3);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(bp); bp.connect(g); g.connect(c.destination);
      src.start(t); src.stop(t + dur + 0.02);
    } catch (e) {}
  }

  // ---- v26 怀旧包积木：全部复用 tone/noise（音量系数、异常兜底、enabled 短路都继承）----
  // v28 加强：用户反馈「不明显」——整体增益上调，波形/节奏更贴梗
  function retroBlip(freq, delayMs) {         // 「滴」：短促方波，2000 年提示音的味道
    setTimeout(function () { tone(freq, 0.075, { type: 'square', gain: 0.08 }); }, delayMs);
  }
  function retroKnock(delayMs) {              // 「咚」：低频正弦下坠 + 一点起振噪声当敲击感
    setTimeout(function () {
      tone(185, 0.12, { type: 'sine', gain: 0.26, slideTo: 92 });
      noise(0.035, 0.16, 2200, 1600);
    }, delayMs);
  }
  function retroWhoosh(delayMs, from, to) {   // 「刷」：一声带通噪声扫频，三连就是切桌
    setTimeout(function () { noise(0.07, 0.19, from, to); }, delayMs);
  }
  function retroCoughBurst(delayMs, from, to, dur, q) {  // 「咳」：带通噪声下坠 + 低频锯齿衬底
    setTimeout(function () {
      noise(dur, 0.30, from, to, q);
      tone(155, dur, { type: 'sawtooth', gain: 0.09, slideTo: 90 });
    }, delayMs);
  }
  // 当前包若有该事件的自定义合成则执行之；返回是否已接管（接管后震动仍由外层统一给）
  function playSynth(name) {
    var s = packOf(_pack).synth;
    if (s && s[name]) { s[name](); return true; }
    return false;
  }

  // 震动（安卓/部分浏览器；iOS Safari 无此 API，调了也只是无效，不会报错）
  function vibe(pattern) {
    if (!_vibe || !_enabled) return;
    try {
      if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(pattern);
    } catch (e) {}
  }

  return {
    enabled: function () { return _enabled; },
    setEnabled: function (on) {
      _enabled = !!on;
      writeKey('sfx-off', on ? '0' : '1');
      return _enabled;
    },
    /** 当前音效包 id（crisp/soft/wood/retro） */
    getPack: function () { return _pack; },
    /** 换包（未知 id 回落 crisp）；返回生效的包 id */
    setPack: function (id) {
      _pack = PACKS[id] ? id : 'crisp';
      writeKey('sfx-pack', _pack);
      return _pack;
    },
    /** 音效包清单（设置界面渲染用）：[{id,label}] */
    packs: function () {
      return Object.keys(PACKS).map(function (k) { return { id: k, label: PACKS[k].label }; });
    },
    vibeSupported: function () {
      return (typeof navigator !== 'undefined') && !!navigator.vibrate;
    },
    getVibe: function () { return _vibe; },
    setVibe: function (on) {
      _vibe = !!on;
      writeKey('vibe-off', on ? '0' : '1');
      return _vibe;
    },
    /** 首次手势时调用，把 AudioContext 建好（iOS 策略） */
    warm: function () { ac(); },
    flip: function () { if (playSynth('flip')) return; noise(0.14, 0.10); },   // 翻卡「刷刷」/ 怀旧「刷刷刷」
    right: function () {                                            // 答对：双连音 + 轻震
      if (playSynth('right')) { vibe(15); return; }
      var f = packOf(_pack).right;
      tone(f[0], 0.09, { gain: 0.07 });
      setTimeout(function () { tone(f[1], 0.12, { gain: 0.07 }); }, 70);
      vibe(15);
    },
    wrong: function () {                                            // 答错：低频下落 + 三段震
      if (playSynth('wrong')) { vibe([40, 60, 40]); return; }
      var f = packOf(_pack).wrong;
      tone(f[0], 0.18, { slideTo: f[1], gain: 0.09 });
      vibe([40, 60, 40]);
    },
    neutral: function () {
      if (playSynth('neutral')) return;
      tone(packOf(_pack).neutral, 0.06, { gain: 0.04 });
    },
    warn: function () {
      if (playSynth('warn')) return;
      var f = packOf(_pack).warn;
      tone(f, 0.16, { gain: 0.08 });
      setTimeout(function () { tone(f, 0.16, { gain: 0.08 }); }, 220);
    },
    done: function () {                                             // 完成：三连音 + 收尾震
      if (playSynth('done')) { vibe([15, 25, 15, 25, 35]); return; }
      var f = packOf(_pack).done;
      tone(f[0], 0.10, { gain: 0.07 });
      setTimeout(function () { tone(f[1], 0.10, { gain: 0.07 }); }, 90);
      setTimeout(function () { tone(f[2], 0.16, { gain: 0.07 }); }, 180);
      vibe([15, 25, 15, 25, 35]);
    }
  };
});

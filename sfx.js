/*
 * sfx.js — 轻量音效（Web Audio 实时合成，零素材、零依赖）
 *
 * v22（2026-09-14）：
 *   - 全部音效由振荡器/白噪声合成，不引入任何音频文件与外部库（守住零依赖红线）
 *   - AudioContext 懒创建：iOS 自动播放策略要求在手势里创建/恢复，
 *     所有调用点都在点击链路内；warm() 供首次手势时预热
 *   - 音量刻意压低（gain 0.04~0.10），是「反馈感」不是「打扰」；appbar 有 🔊 开关，记忆在 localStorage
 *   - 任何内部异常都吞掉：音效绝不允许把做题主流程搞挂
 *
 * 音色设计：
 *   flip    翻卡「刷刷」纸声 —— 白噪声 + 带通滤波向上扫频（背题翻面 / 切题共用）
 *   right   答对 —— E5→A5 轻快两连音（正弦，短包络）
 *   wrong   答错 —— 220→150Hz 三角波下落，低频短促
 *   neutral 自评「模糊」—— 中性单音轻点
 *   warn    考试最后 60 秒 —— 880Hz 两声提示（配 v14 的 timer-warn 变红）
 *   done    完成/交卷 —— C5→E5→G5 上行三连音
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SFX = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const KEY = 'sfx-off';
  function store() {
    try { return (typeof localStorage !== 'undefined') ? localStorage : null; } catch (e) { return null; }
  }

  let _enabled = true;
  const st0 = store();
  if (st0) { try { _enabled = st0.getItem(KEY) !== '1'; } catch (e) {} }

  let ctx = null;
  function ac() {
    if (!ctx) {
      const AC = (typeof window !== 'undefined') && (window.AudioContext || window.webkitAudioContext);
      if (!AC) return null;                      // Node 单测 / 极老浏览器：静默跳过
      try { ctx = new AC(); } catch (e) { return null; }
    }
    if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) {} }
    return ctx;
  }

  // 单音：freq 起始频率，dur 时长秒，opts: { type 波形, gain 音量, slideTo 滑向频率 }
  function tone(freq, dur, opts) {
    const c = ac();
    if (!c || !_enabled) return;
    try {
      const t = c.currentTime;
      const osc = c.createOscillator();
      const g = c.createGain();
      osc.type = (opts && opts.type) || 'sine';
      osc.frequency.setValueAtTime(freq, t);
      if (opts && opts.slideTo) osc.frequency.exponentialRampToValueAtTime(opts.slideTo, t + dur);
      const vol = (opts && opts.gain != null) ? opts.gain : 0.06;
      g.gain.setValueAtTime(0.0001, t);          // 从近零起坡，避免「咔」声爆音
      g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(g); g.connect(c.destination);
      osc.start(t); osc.stop(t + dur + 0.02);
    } catch (e) {}
  }

  // 「刷刷」纸声：白噪声 + 带通滤波从 from 扫到 to
  function noise(dur, gain, from, to) {
    const c = ac();
    if (!c || !_enabled) return;
    try {
      const t = c.currentTime;
      const len = Math.max(1, Math.floor(c.sampleRate * dur));
      const buf = c.createBuffer(1, len, c.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      const src = c.createBufferSource(); src.buffer = buf;
      const bp = c.createBiquadFilter();
      bp.type = 'bandpass'; bp.Q.value = 0.8;
      bp.frequency.setValueAtTime(from, t);
      bp.frequency.exponentialRampToValueAtTime(to, t + dur);
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(gain, t + dur * 0.3);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(bp); bp.connect(g); g.connect(c.destination);
      src.start(t); src.stop(t + dur + 0.02);
    } catch (e) {}
  }

  return {
    enabled: function () { return _enabled; },
    setEnabled: function (on) {
      _enabled = !!on;
      const s = store();
      if (s) { try { s.setItem(KEY, on ? '0' : '1'); } catch (e) {} }
      return _enabled;
    },
    /** 首次手势时调用，把 AudioContext 建好（iOS 策略）；之后程序触发的音（考试告警）才能出声 */
    warm: function () { ac(); },
    flip: function () { noise(0.14, 0.10, 900, 2600); },
    right: function () {
      tone(659, 0.09, { gain: 0.07 });
      setTimeout(function () { tone(880, 0.12, { gain: 0.07 }); }, 70);
    },
    wrong: function () { tone(220, 0.18, { type: 'triangle', slideTo: 150, gain: 0.09 }); },
    neutral: function () { tone(440, 0.06, { gain: 0.04 }); },
    warn: function () {
      tone(880, 0.16, { gain: 0.08 });
      setTimeout(function () { tone(880, 0.16, { gain: 0.08 }); }, 220);
    },
    done: function () {
      tone(523, 0.10, { gain: 0.07 });
      setTimeout(function () { tone(659, 0.10, { gain: 0.07 }); }, 90);
      setTimeout(function () { tone(784, 0.16, { gain: 0.07 }); }, 180);
    }
  };
});

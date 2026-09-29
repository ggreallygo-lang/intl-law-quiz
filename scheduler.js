/*
 * scheduler.js — 记忆调度纯函数（v34.1 从 app.js 抽出，架构评审 Q2 第一批拆分）
 *
 * 纯度约束（架构评审 7.1）：不读 DOM、localStorage、IndexedDB，
 * 不直接调用 Date.now / Math.random —— 时间与随机源由调用方注入，Node 可单测。
 *
 * 口径说明（架构评审 §4 补充）：
 *   - 三档评分映射：忘记=1（Again）/ 模糊=3（成功但费力）/ 记住=5（Good）。
 *     「模糊」按成功计并增长 reps——这是现行口径，v34 统一语义时若调整需同步文档。
 *   - nominalInterval（SM-2 名义间隔）与 scheduledDue（含 Fuzz 抖动）分开返回，
 *     预览用名义值，落库用抖动值。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Scheduler = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** SM-2 核心：p = {ease,interval,reps,due,lapses}，q = 1/3/5。字段级默认合并（空对象也算未初始化）。 */
  function sm2(p, q) {
    p = Object.assign({ ease: 2.5, interval: 0, reps: 0, due: 0, lapses: 0 }, p || {});
    if (q < 3) { p.reps = 0; p.interval = 1; p.lapses = (p.lapses || 0) + 1; }
    else {
      if (p.reps === 0) p.interval = 1;
      else if (p.reps === 1) p.interval = 6;
      else p.interval = Math.round(p.interval * p.ease);
      p.reps++;
    }
    p.ease = Math.max(1.3, p.ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
    p.due = 0;   // due 由 applyRating 统一计算（sm2 保持纯计算不碰时钟）
    return p;
  }

  /** Fuzz 间隔抖动 ±5%（Anki 同款）：防同批卡永远同天到期形成复习洪峰。rand 可注入。 */
  function fuzzInterval(interval, rand) {
    const r = typeof rand === 'function' ? rand() : Math.random();
    return Math.max(1, Math.round(interval * (0.95 + r * 0.10)));
  }

  /**
   * 完整评分：SM-2 + Fuzz + due 计算。now/rand 注入。
   * 返回 { state, nominalInterval, scheduledDue }——预览可用 nominalInterval，
   * 落库用 state（interval 已含抖动，due = now + interval 天）。
   */
  function applyRating(prev, q, opts) {
    const o = opts || {};
    const now = (o.now != null) ? o.now : Date.now();
    const p = sm2(Object.assign({}, prev || {}), q);
    const nominal = p.interval;
    p.interval = fuzzInterval(nominal, o.rand);
    p.due = now + p.interval * 86400000;
    return { state: p, nominalInterval: nominal, scheduledDue: p.due };
  }

  /** 三档预览（评分按钮上的 (N天) 文案用）：名义间隔，不含抖动。 */
  function previewIntervals(prev) {
    const out = {};
    [1, 3, 5].forEach(q => { out[q] = sm2(Object.assign({}, prev || {}), q).interval; });
    return out;
  }

  return { sm2: sm2, fuzzInterval: fuzzInterval, applyRating: applyRating, previewIntervals: previewIntervals };
});

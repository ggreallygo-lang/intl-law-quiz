/*
 * scoring.js — 判分与答案规范化（UMD：浏览器 + Node 单测通用）
 *
 * 为什么单独拆一个模块：
 *   题库来自 OCR / 手写笔记，q.answer 的形态极不稳定——可能是 ['B']、'B'、'A、C'、'AC'、
 *   true / false，也可能是 undefined（解析失败的脏数据）。
 *
 *   原实现直接写 q.answer.includes(k) / .join('、') / .slice().sort()，有两个真 bug：
 *     ① 静默误判：answer 是字符串 'AB'、用户选 'A' 时，'AB'.includes('A') === true
 *        → 明明只选了一个选项，却被判成答对。这种错误不报错、不留痕，比崩溃更糟。
 *     ② 崩溃：answer 是 undefined 时 .join() / .slice() 抛 TypeError → 白屏。
 *
 *   这里统一收敛成一条规则：
 *     先把「正确答案」和「用户答案」各自规范化成「排序后的大写 key 字符串」，再做严格相等比较。
 *     ['C','A'] -> 'AC' ／ 'A、C' -> 'AC' ／ 'AC' -> 'AC'  三者等价。
 *
 * 约定：判断题的规范化值是 '1'（对）/ '0'（错）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Scoring = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TRUE_WORDS = /^(?:对|正确|√|✓|是|真|true|t|yes|y)$/i;
  const FALSE_WORDS = /^(?:错|错误|×|✗|否|假|false|f|no|n)$/i;
  const NON_KEY = /[^A-Ha-h]/g;

  // v5：填空题答案超过这个长度就不适合逐字输入，改为「自评」（看答案后自己判断会/不会）。
  // 依据真实样本：答案中位 8 字，94% 在 30 字内，最长 56 字。
  const FILL_INPUT_MAX = 30;

  // 文本比较用：抹掉空白与常见标点、全角转半角、统一小写
  const TEXT_STRIP = /[\s\u3000，。、；：？！"'“”‘’（）()《》〈〉\[\]【】\-—～~_·．.,;:?!]/g;

  /**
   * 文本型答案（填空）的规范化：只比内容，不比空格/标点/全角半角
   * 「1648 年威斯特伐利亚公会」与「1648年威斯特伐利亚公会」应判等价
   */
  function normText(v) {
    if (v == null) return '';
    let s = String(v);
    s = s.replace(/[\uFF01-\uFF5E]/g, function (ch) {   // 全角 → 半角
      return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
    });
    s = s.replace(/\u3000/g, ' ');                      // 全角空格 → 半角空格
    return s.replace(TEXT_STRIP, '').toLowerCase();
  }

  /**
   * 把任意形态的答案规范化成「排序后的大写 key 字符串」
   * @returns {string} '' 表示无有效答案
   */
  function normKeys(v) {
    if (v === true) return '1';
    if (v === false) return '0';
    if (v == null) return '';
    if (typeof v === 'number') return String(v);
    if (Array.isArray(v)) {
      return v.map(function (x) { return normKeys(x); })
        .filter(Boolean).sort().join('');
    }
    if (typeof v === 'string') {
      const t = v.trim();
      if (!t) return '';
      if (/^[01]$/.test(t)) return t;              // 判断题的 '0' / '1'
      if (TRUE_WORDS.test(t)) return '1';
      if (FALSE_WORDS.test(t)) return '0';
      return t.replace(NON_KEY, '').toUpperCase().split('').sort().join('');
    }
    return '';
  }

  /** 正确答案是否存在（脏数据识别：解析失败的题 answer 为空） */
  function hasAnswer(q) {
    if (!q) return false;
    if (q.type === 'term') return !!(q.definition || q.answer);
    // 填空 / 简答的答案是文本，不能用 normKeys（那会把中文全滤掉）
    if (q.type === 'fill' || q.type === 'essay') {
      return !!String(q.answer == null ? '' : q.answer).trim();
    }
    return !!normKeys(q.answer);
  }

  /**
   * 是否「自评题」——不能自动判分，只能看答案后自己判断会/不会
   * 名词解释、简答恒为自评；填空答案过长时也降级为自评（否则要用户逐字输入几十个字）
   */
  function isSelfAssess(q) {
    if (!q) return true;
    if (q.type === 'term' || q.type === 'essay') return true;
    if (q.type === 'fill') {
      return String(q.answer == null ? '' : q.answer).trim().length > FILL_INPUT_MAX;
    }
    return false;
  }

  /**
   * 判分：用户答案是否正确
   * 关键：正确答案缺失时一律判「错」，绝不静默判对。
   *       宁可让用户觉得"这题判错了"，也不能让错题悄悄混过去。
   */
  function isRight(q, userValue) {
    if (!q) return false;
    if (q.type === 'term' || q.type === 'essay') return false;   // 自评题不自动判分
    if (q.type === 'fill') {
      const right = normText(q.answer);
      if (!right) return false;
      return normText(userValue) === right;
    }
    const right = normKeys(q.answer);
    if (!right) return false;
    return normKeys(userValue) === right;
  }

  /** 正确答案的 key 数组（已排序、大写）；判断题/填空/简答返回 []（用 answerText 展示） */
  function answerKeys(q) {
    if (!q || q.type === 'term' || q.type === 'judge') return [];
    if (q.type === 'fill' || q.type === 'essay') return [];
    const a = q.answer;
    if (Array.isArray(a)) {
      return a.map(function (x) { return String(x).trim().toUpperCase(); })
        .filter(Boolean).sort();
    }
    if (typeof a === 'string') {
      const t = a.trim();
      if (/^[01]$/.test(t) || TRUE_WORDS.test(t) || FALSE_WORDS.test(t)) return [];
      return t.replace(NON_KEY, '').toUpperCase().split('').sort();
    }
    return [];
  }

  /** 用于展示的正确答案文本（不会被脏数据搞崩） */
  function answerText(q) {
    if (!q) return '';
    if (q.type === 'term') return q.definition || '（无定义）';
    if (q.type === 'judge') return q.answer ? '对' : '错';
    // 填空 / 简答：答案本身就是文本
    if (q.type === 'fill' || q.type === 'essay') {
      const t = String(q.answer == null ? '' : q.answer).trim();
      return t || '（缺答案）';
    }
    const keys = answerKeys(q);
    if (!keys.length) return '（缺答案）';
    return keys.map(function (k) {
      const o = (q.options || []).filter(function (x) {
        return String(x.key).trim().toUpperCase() === k;
      })[0];
      return k + '. ' + (o ? o.text : '');
    }).join('　');
  }

  return {
    normKeys: normKeys, normText: normText,
    hasAnswer: hasAnswer, isSelfAssess: isSelfAssess, isRight: isRight,
    answerKeys: answerKeys, answerText: answerText,
    FILL_INPUT_MAX: FILL_INPUT_MAX
  };
});

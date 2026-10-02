/* slicer.js —— 长文本按题块边界切片，供 AI 修正工作流（规范 v1 第五节）
 * 精度优先：只在题块边界切；单个块超过上限时宁可超片也不切断。
 * 原文逐字保留，不做任何清洗。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QuizSlicer = factory();
}(this, function () {
  'use strict';

  var DEFAULT_MAX = 6000; // 汉字/片，依据 AI 单轮输出上限，可调

  // 题块起点：题号行 / md 标题 / 中文序号分区标题
  var RE_BLOCK_START = /^\s*(?:#{1,6}\s*)?(?:\d{1,3}\s*[.、．]\s*\S|[一二三四五六七八九十]+[、\.．]\S)/;

  function isBlockStart(line) {
    return RE_BLOCK_START.test(line);
  }

  /**
   * 把原文切成若干片（字符串数组），逐字保留。
   * 规则：累加行；当「下一行是题块起点 且 当前片已达上限」时收片。
   * 单个题块自身超过上限 → 独占一片（超片但完整）。
   * @param {string} text 原文
   * @param {number} [maxChars]
   * @returns {string[]}
   */
  function sliceText(text, maxChars) {
    var max = (maxChars | 0) > 0 ? maxChars | 0 : DEFAULT_MAX;
    var lines = String(text == null ? '' : text).split(/\r?\n/);
    var slices = [];
    var buf = [];
    var len = 0;
    var lastBlank = -1; // 缓冲区内最后一个空行的下标
    function flushBuf(n) {
      slices.push(buf.slice(0, n).join('\n'));
      buf = buf.slice(n);
      len = buf.reduce(function (a, l) { return a + l.length + 1; }, 0);
      lastBlank = -1;
      for (var i = buf.length - 1; i >= 0; i--) if (!buf[i].trim()) { lastBlank = i; break; }
    }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      // 题块边界切：下一行是题块起点且当前片已达上限
      if (buf.length && isBlockStart(line) && len >= max) { flushBuf(buf.length); }
      buf.push(line);
      len += line.length + 1;
      if (!line.trim()) lastBlank = buf.length - 1;
      // 空行回退切：密文本没有题号边界时，在空行处收片，防单片远超上限
      if (len >= max && lastBlank > 0) flushBuf(lastBlank + 1);
    }
    if (buf.length && buf.some(function (l) { return l.trim(); })) slices.push(buf.join('\n'));
    return slices;
  }

  /**
   * 切片并加规范切片头，返回待下载文件列表。
   * @returns {{name:string, content:string}[]}
   */
  function sliceToFiles(text, baseName, maxChars) {
    var parts = sliceText(text, maxChars);
    var n = parts.length;
    return parts.map(function (p, i) {
      return {
        name: baseName + '_切片' + (i + 1) + 'of' + n + '.md',
        content: '<!-- 切片：' + baseName + ' 第' + (i + 1) + '/' + n + '片 -->\n' + p
      };
    });
  }

  return { sliceText: sliceText, sliceToFiles: sliceToFiles, isBlockStart: isBlockStart, DEFAULT_MAX: DEFAULT_MAX };
}));

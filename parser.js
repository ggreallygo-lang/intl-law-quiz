/*
 * parser.js — 把 md / txt 笔记解析成题库
 * 兼容两类写法：
 *   A. 规范格式：用 # 题库名 / ## 章节 / ### 题型 组织，选项 A. B. C. D.，答案：B，解析：...
 *   B. 自由笔记：纯编号题 + 选项 + 答案行（常见手抄/导出格式），自动识别题型
 * 题型：single(单选) / multiple(多选) / judge(判断) / term(名词解释)
 *
 * v2（2026-08-30）：
 *   - 支持 h1~h6 任意层级标题，输出 outline 目录树（不再只认 3 档）
 *   - 每题带 chapterId（指向 outline 节点）+ chapterPath（完整路径，不含 h1）
 *   - 题库名取「首个非空 H1」（v1 会被后面的 H1 覆盖，已修）
 *   - 无标题的题目归入自动创建的「未分组」节点，不丢题
 *
 * v3（2026-08-30）：水印清洗
 *   - cleanText() 在解析前剥离推广水印（公众号/微信号/二维码/更多资料…）
 *   - 两类处理：① 括号内的水印片段（保留标题本身）② 整行就是水印（整行删除）
 *   - 词库可扩展：WM_EXTRA 里加公众号名即可覆盖新的水印源
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QuizParser = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- 正则 ----
  const RE_HEADING = /^(#{1,6})\s+(.*)$/;
  // v6：补上冒号式选项。真实样本（202410《国际法》）用的是「A: 复合国」而非「A. 复合国」，
  // 旧版不认冒号，导致 41 道选择题全被降级成名词解释。
  const RE_OPTION = /^\s*([A-Ha-h])\s*[\.、．、\)）:：]\s*(.+)$/;     // A. / A、 / A) / A:
  // 题号只认 数字 / 中文数字，不认单个字母（字母是选项 A./B.）
  const RE_NUMSTEM = /^\s*([0-9]+|[一二三四五六七八九十百千]+|[a-zA-Z])\s*[\.、．、\)]\s*(.+)$/;
  const RE_NUMSTEM_DIGIT = /^\s*([0-9]+|[一二三四五六七八九十百千]+)\s*[\.、．、\)]\s*/;
  // v5：连字符编号  1-1. / 1-2-3. / 1-13（连字符后可无分隔符，OCR 常漏点）
  const RE_QNO_DASH = /^\s*(?:[0-9]+|[一二三四五六七八九十百千]+)(?:\s*[-–—]\s*(?:[0-9]+|[一二三四五六七八九十百千]+))+\s*[.．、)）]?\s*/;
  // 连字符后紧跟单位字 → 是范围（1-2月 / 3-5日）不是题号
  const RE_UNIT_AFTER = /^[年月日号章节页条款项时分秒]/;
  // 题干尾部括号答案，兼容混搭：（《维也纳条约法公约》)  ← 前全角后半角
  const RE_TAIL_PAREN = /[（(]([^（()）]*)[）)]\s*$/;
  // 整行就是一个括号（答案单独占一行）
  const RE_PAREN_ONLY = /^[（(]([^（()）]*)[）)]\s*$/;
  // 简答的「答：」行（RE_ANSWER 只认「答案」，不认单个「答」）
  const RE_ANS_LINE = /^\s*答\s*[:：]\s*(.*)$/;
  // 名词解释行：短词 + 冒号 + 较长定义
  const RE_TERM_LINE = /^([^：:，。；！？、\s]{2,16})[：:]\s*(\S.{6,})$/;
  // 纯文本章节标记：「1章导论」「2章 国际法上的国家」「第三节 国际法的主体」
  // 注意不会误伤题号：1-1. 后面是连字符，匹配不到「章/节/讲/篇/编」
  const RE_CHAPTER_LINE = /^\s*(?:第\s*)?(?:[0-9]+|[一二三四五六七八九十]+)\s*(?:章|节|讲|篇|编)\s*[^\n]{0,24}$/;
  const BLANK = '（　　）';

  // ================= v6：真题试卷体（题目区 + 尾部集中答案区） =================
  // 真实样本（202404 / 00247《国际法》真题及答案）：
  //   题目区：1. 题干 \n A. 选项 B. 选项
  //   答案区：《国际法》答案及评分参考
  //           一、单项选择题 …
  //           1. B 2:A 3. D 4. C 5. D      ← 一行 5 题，分隔符 . : 混用
  //           31ABCDE 32. ACD               ← 甚至无分隔符
  //           36. 答案：庇护指国家基于主权…  ← 主观题
  //           36.国际习惯是指各国在国际交往中… ← 主观题无「答案：」前缀
  //
  // 集中答案区起始标志（整行较短时才认，避免误伤题干行）
  // 护栏：必须含「评分参考 / 评分标准」这类强特征。
  // 实测踩坑：早期版本收录了「参考答案」「答案与解析」，结果把文件头
  // 「# 202404 国际法真题（含答案与解析）」误判成答案区，整卷被吞。
  const RE_ANS_SECTION_MARK = /(答案及评分参考|答案及评分标准|参考答案及评分|评分参考|评分标准)/;
  // 题型区标题：一、单项选择题 / 二、多项选择题：本大题共… / 四.论述题
  const RE_SECTION_TYPE = /^\s*(?:#{1,6}\s*)?([一二三四五六七八九十]+)\s*[、\.．]\s*(.{2,20}?)(?:[：:]|\s|$)/;
  // 行内客观题答案键：题号 + 可选分隔符 + 1~6 个 A-H（后面必须是空白或行尾，
  // 这样「36.国际习惯是指…」不会被误判成答案键）
  const RE_OPT_INLINE = /(?:^|\s)(\d{1,2})\s*[.、．:：]?\s*([A-H]{1,6})(?=\s|$)/g;
  // 方括号题型号：【单选题】【多选题】【简答题】【论述题】【案例分析题】…
  // 实测：202410 / 202504 两份真题用这种写法，而非「三、简答题」章节式。
  // 不认它们的话，主观题会被降级成名词解释（实测 202410 有 12 条、202504 有 6 条被误判）。
  const RE_TYPE_TAG = /【\s*(单项选择题|单选题|多项选择题|多选题|判断题|名词解释题|名词解释|填空题|简答题|论述题|案例分析题|材料分析题|计算题)\s*】/;

  // 主观题答案起始行：题号 + （分隔符 或 紧跟「答案：」）+ 正文
  // 题号放宽到 3 位是为了容忍 OCR 错误（实测「37.」被识别成「771」），
  // 但要求其后必须是分隔符或「答案」二字，否则「2024 年 10月…」这类标题会被误匹配。
  const RE_ESSAY_HEAD = /^\s*(\d{1,3})\s*(?:[.、．]\s*|(?=答案\s*[:：]))\s*(?:答案\s*[:：]\s*)?(.+)$/;
  const RE_ANSWER = /(答案|正确答案|参考答案|标准答案|answer|正确选项)\s*[:：]?\s*(.+)$/i;
  const RE_EXPL = /(解析|答案解析|解答|【解析】|注)\s*[:：]?\s*(.+)$/i;
  const RE_TERM_COLON = /^(.{1,40}?)[:：](.+)$/;
  const JUDGE_TRUE = /^(对|正确|√|✓|是|真|true|t|yes|y|对的|正确无比)$/i;
  const JUDGE_FALSE = /^(错|错误|×|✗|否|假|false|f|no|n|错的|不正确)$/i;

  function trim(s) { return (s || '').replace(/^\s+|\s+$/g, ''); }

  // ================= 水印清洗（v3） =================
  // 强特征词：命中即高度可疑。
  // 注意「群」「关注」这类词在正文里很常见（本文档「群岛水域」出现 65 次），
  // 所以只收录固定组合（QQ群 / 更多资料 / 欢迎关注），不单独收录单词，避免误伤正文。
  const WM_STRONG = [
    '公众号', '微信公众号', '公号', '微信号', '微信', 'QQ群', '小红书', '抖音',
    '知乎', 'B站', 'bilibili', '扫码关注', '扫码', '二维码', '更多资料',
    '免费领取', '领取资料', '资料群', '交流群', '加V', '欢迎关注', '版权归'
  ];
  // 额外词库：具体公众号名 / 品牌名。遇到新的水印来源，往这个数组里加即可。
  const WM_EXTRA = ['在爬坡的路上'];

  function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  function wmWordRe(extra) {
    const words = WM_STRONG.concat(extra || WM_EXTRA)
      .map(escapeRe)
      .sort((a, b) => b.length - a.length);   // 长词优先，避免「微信」抢先命中「微信号」
    return new RegExp(words.join('|'));
  }

  // 方头括号 / 圆括号 / 方括号内的短片段：含水印词则连同括号一起删掉
  const RE_BRACKET = /(?:【[^】]{0,40}】|\[[^\]]{0,40}\]|（[^）]{0,40}）|\([^)]{0,40}\))/g;

  function stripWmSegments(line, re) {
    return line.replace(RE_BRACKET, (seg) => (re.test(seg) ? '' : seg));
  }

  // 整行就是水印？多重护栏，宁可漏删也不误删正文
  function isWmLine(line, re) {
    const s = trim(line);
    if (!s || s.length > 60) return false;                 // 太长的一定是正文
    const noHead = s.replace(/^#{1,6}\s*/, '');            // 去掉标题井号
    if (noHead.length > 50) return false;
    const m = noHead.match(re);
    if (!m) return false;                                  // 没有水印词
    if (m.index > 4) return false;                         // 水印词必须靠近行首（前面最多 4 字，如「更多资料」）
    // 保护：以题号开头的行视为题目，不删
    if (/^\s*(?:[0-9]+|[一二三四五六七八九十]+)\s*[\.、．\)]/.test(noHead)) return false;
    return true;
  }

  // 考卷固定套话（v6）：「绝密★启用前」「注意事项：」「本试卷分为两部分…」
  // 实测：这些行会被当成名词解释入库，产生 2~3 条噪声。整行删除。
  const RE_BOILER = /^(?:绝密|机密|秘密|注意事项|本试卷分为|本试卷共|应考者必须|涂写部分|画图部分|答题前|请在答题|考试时间|满分|一、?本试卷|二、?应考者)/;

  function isBoilerplate(line) {
    const s = trim(line).replace(/^#{1,6}\s*/, '');
    if (!s || s.length > 50) return false;                 // 太长的是正文
    if (/^\s*(?:[0-9]+|[一二三四五六七八九十]+)\s*[.、．]/.test(s)) return false;  // 题号行不删
    return RE_BOILER.test(s);
  }

  function cleanLine(raw, re) {
    const out = stripWmSegments(raw, re);
    if (isBoilerplate(out)) return null;                   // 考卷套话整行删
    return isWmLine(out, re) ? null : out;                 // null 表示整行删除
  }

  /**
   * 清洗整段文本里的推广水印
   * @param {string} text 原文
   * @param {object} [opts] { words: 额外词库数组（与内置 WM_EXTRA 取并集，不会覆盖） }
   * @returns {{text:string, removedLines:number, strippedLines:number}}
   */
  function cleanText(text, opts) {
    opts = opts || {};
    // 去 BOM + 剥离 HTML 注释（转换脚本的元信息写在注释里，
    // 不剥离的话「<!-- 源文件：xxx.pdf -->」会被当成名词解释入库）
    const src = String(text == null ? '' : text)
      .replace(/^\uFEFF/, '')
      .replace(/<!--[\s\S]*?-->/g, '');
    // 自定义词库与内置词库取并集：加新词不会把旧词顶掉
    const words = (Array.isArray(opts.words) && opts.words.length)
      ? WM_EXTRA.concat(opts.words)
      : WM_EXTRA;
    const re = wmWordRe(words);
    const out = [];
    let removedLines = 0, strippedLines = 0;
    for (const raw of src.split(/\r?\n/)) {
      const r = cleanLine(raw, re);
      if (r === null) { removedLines++; continue; }
      if (r !== raw) strippedLines++;
      out.push(r);
    }
    // 删行后可能留下连续空行，压成最多保留 1 个
    const compact = [];
    let blank = 0;
    for (const l of out) {
      if (!trim(l)) { blank++; if (blank > 1) continue; }
      else blank = 0;
      compact.push(l);
    }
    return { text: compact.join('\n'), removedLines, strippedLines };
  }

  // ================= v6：真题试卷体支持函数 =================

  /** 题型区标题 -> 题型。只认「一、单项选择题」这类强特征，宁可漏判。 */
  function classifySection(title) {
    const t = title || '';
    if (/多项|不定项/.test(t)) return 'multiple';
    if (/单项/.test(t)) return 'single';
    if (/判断|对错|是非/.test(t)) return 'judge';
    if (/简答|问答/.test(t)) return 'essay';
    if (/论述|试论/.test(t)) return 'essay';
    if (/案例|材料分析/.test(t)) return 'essay';
    if (/名词|术语|概念/.test(t)) return 'term';
    if (/填空/.test(t)) return 'fill';
    return null;
  }

  /** 从一行里抽方括号题型号 -> 题型（【简答题】→ essay） */
  function typeTagOf(line) {
    const m = String(line || '').match(RE_TYPE_TAG);
    if (!m) return null;
    const t = m[1];
    if (/多项/.test(t)) return 'multiple';
    if (/单项|单选/.test(t)) return 'single';
    if (/判断/.test(t)) return 'judge';
    if (/名词/.test(t)) return 'term';
    if (/填空/.test(t)) return 'fill';
    if (/简答|论述|案例|材料|计算/.test(t)) return 'essay';
    return null;
  }

  /** 页眉页脚噪声行：短且含「页」。实测样本：
   *  「国际法试题第 1页(共 5页)」「第 6 共 7 页」「2 " 2 页」「⊥ 共 2 页」 */
  function isPageMark(line) {
    const s = trim(line);
    if (!s || s.length > 22) return false;
    return /(?:页|頁)/.test(s) && /\d/.test(s);
  }

  /**
   * 题号纠错：OCR 会把「37.」识别成「771」这类畸形数字。
   * 若题号超出合理范围（>45），用「上一题 + 1」兜底。
   */
  function fixQno(qno, last) {
    if (qno >= 1 && qno <= 45) return qno;
    return last > 0 ? last + 1 : qno;
  }

  /**
   * 解析集中答案区 -> Map<qno, {keys:[A-H], text:string}>
   * 客观题填 keys，主观题填 text。两者可并存（如案例题既有键又有文字）。
   */
  function parseAnswerSection(lines) {
    const map = new Map();
    let cur = null;                 // 当前正在累积的主观题 qno
    let last = 0;                   // 上一个成功解析的题号（用于 OCR 纠错）
    for (const raw of lines) {
      const line = trim(raw);
      if (!line) continue;
      if (isPageMark(line)) continue;             // 页眉页脚

      // 题型区标题 → 结束主观题累积，不消费内容
      const st = line.match(RE_SECTION_TYPE);
      if (st && classifySection(st[2])) { cur = null; continue; }

      // ① 客观题键：一行里出现 >=2 组「题号+字母键」才当答案行，
      //    避免把「36. 答案：庇护指国家基于主权…」这种长行误判。
      RE_OPT_INLINE.lastIndex = 0;
      const hits = [];
      let m;
      while ((m = RE_OPT_INLINE.exec(line))) hits.push({ qno: fixQno(+m[1], last), keys: m[2].split('') });
      if (hits.length >= 2) {
        for (const h of hits) {
          if (!map.has(h.qno)) map.set(h.qno, { keys: h.keys, text: '' });
          else if (h.keys.length) map.get(h.qno).keys = h.keys;
          last = h.qno;
        }
        cur = null;
        continue;
      }
      // 单行只有 1 组键且整行很短 → 也是客观题键（如答案区末尾孤零零的「35. DE」）
      if (hits.length === 1 && line.length <= 24) {
        const h = hits[0];
        if (!map.has(h.qno)) map.set(h.qno, { keys: h.keys, text: '' });
        last = h.qno;
        cur = null;
        continue;
      }

      // ② 主观题答案起始行
      const me = line.match(RE_ESSAY_HEAD);
      if (me) {
        const qno = fixQno(+me[1], last);
        const body = trim(me[2]);
        if (body.length >= 8 && qno >= 1 && qno <= 45) {
          cur = qno;
          last = qno;
          const prev = map.get(qno);
          const e = prev || { keys: [], text: '' };
          e.text = e.text ? e.text + ' ' + body : body;
          map.set(qno, e);
          continue;
        }
      }
      // ③ 续行：接在「当前主观题」后面（答案常跨多页，被页眉切断）
      if (cur != null) {
        const e = map.get(cur);
        if (e) e.text = e.text ? e.text + ' ' + line : line;
      }
    }
    return map;
  }

  /**
   * 找集中答案区的起始行下标；找不到返回 -1
   * 位置护栏：答案区必然在文档后半段。真题结构都是「题目在前、答案在后」，
   * 前 30% 出现的疑似标志一律不认（避免文件头标题误判）。
   */
  function findAnswerSection(lines) {
    const from = Math.floor(lines.length * 0.3);
    for (let i = from; i < lines.length; i++) {
      const l = trim(lines[i]).replace(/^#{1,6}\s*/, '');
      if (!l || l.length > 40) continue;          // 太长的一定不是标题行
      if (RE_ANS_SECTION_MARK.test(l)) return i;
    }
    return -1;
  }

  /**
   * 把「题目区 + 尾部集中答案区」拆开，并解析答案。
   * 护栏：解析出的客观题键 < 5 个 → 判定为误检，原样返回（走老逻辑）。
   * @returns {{body:string, answers:Map|null, mark:string}}
   */
  function extractExamAnswers(text) {
    const lines = String(text == null ? '' : text).split(/\r?\n/);
    const idx = findAnswerSection(lines);
    if (idx < 0) return { body: text, answers: null, mark: '' };

    const ansLines = lines.slice(idx);
    const map = parseAnswerSection(ansLines);
    let objCount = 0;
    map.forEach(v => { if (v.keys && v.keys.length) objCount++; });
    if (objCount < 5) return { body: text, answers: null, mark: '' };

    return {
      body: lines.slice(0, idx).join('\n'),
      answers: map,
      mark: trim(lines[idx])
    };
  }

  /** 取行首题号（纯数字，1~2 位） */
  function qnoOf(line) {
    const m = String(line || '').match(/^\s*(?:#{1,6}\s*)?(\d{1,3})\s*[.、．]\s*\S/);
    return m ? +m[1] : null;
  }

  // 连字符题号匹配（带护栏：排除 1-2月 这类范围写法）
  function matchDashQno(line) {
    const m = line.match(RE_QNO_DASH);
    if (!m) return null;
    const rest = line.slice(m[0].length);
    if (!rest) return null;                    // 整行只有编号，没有题干
    if (RE_UNIT_AFTER.test(rest)) return null; // 是范围不是题号
    return m;
  }

  // 该行是否以题号开头（普通编号 或 连字符编号）
  function startsWithQno(line) {
    return RE_NUMSTEM_DIGIT.test(line) || matchDashQno(line) != null;
  }

  // 名词解释行：「海洋法：有关各种海域…」。
  // 护栏：排除「答：」「解析：」等标记行，排除编号题（优先当题）
  function isTermLine(line) {
    const s = trim(line);
    const m = s.match(RE_TERM_LINE);
    if (!m) return false;
    if (/^(答|答案|解析|注|例如|注意|说明|提示)/.test(m[1])) return false;
    if (startsWithQno(s)) return false;
    return true;
  }

  function stripNumber(line) {
    const d = matchDashQno(line);
    if (d) return line.slice(d[0].length);
    const m = line.match(/^\s*(?:[0-9]+|[一二三四五六七八九十百千]+|[a-zA-Z])\s*[\.、．、\)]\s*/);
    return m ? line.slice(m[0].length) : line;
  }

  function classifyHint(content) {
    const c = content || '';
    if (/多选|不定项|多个答案/.test(c)) return 'multiple';
    if (/单选|选择题|选择|客观题/.test(c)) return 'single';
    if (/判断|对错|是非|true|false/i.test(c)) return 'judge';
    if (/名词|术语|解释|概念|定义/.test(c)) return 'term';
    return null;
  }

  function isQuestionStart(line) {
    return RE_NUMSTEM_DIGIT.test(line) || matchDashQno(line) != null || /^\s*Q\s*[:：]?/i.test(line);
  }

  /**
   * v6：拆分一行内的多个选项。
   * 真实样本（00247）：「A.复合国 B.中立国」—— 一行两个选项且 B 前有空格，
   * 旧版 extractOptions 会把「B.中立国」吞进 A 的文本，导致只有 1 个选项。
   * 护栏：选项键必须严格递增（A→B→C→D），否则多半是正文里的字母，不拆。
   */
  function splitInlineOptions(line) {
    const re = /(?:^|\s|>)([A-Ha-h])\s*[\.、．、\)）:：]\s*/g;
    const idxs = [];
    let m;
    while ((m = re.exec(line))) {
      idxs.push({ key: m[1].toUpperCase(), start: m.index, end: m.index + m[0].length });
    }
    const none = { prefix: line, opts: [] };
    if (idxs.length < 2) return none;
    // 递增校验 + 去重
    const seq = [];
    for (const it of idxs) {
      const last = seq[seq.length - 1];
      if (last && it.key.charCodeAt(0) !== last.key.charCodeAt(0) + 1) return none;
      if (last && it.start < last.end) continue;      // 重叠，取前者
      seq.push(it);
    }
    if (seq.length < 2) return none;
    // prefix = 首个选项之前的文本（通常是题干），必须保留，否则题干会丢
    const prefix = trim(line.slice(0, seq[0].start));
    const opts = [];
    for (let i = 0; i < seq.length; i++) {
      const text = trim(line.slice(seq[i].end, i + 1 < seq.length ? seq[i + 1].start : line.length));
      if (text) opts.push({ key: seq[i].key, text: text });
    }
    return { prefix: prefix, opts: opts };
  }

  function hasInlineOptions(line) {
    return splitInlineOptions(line).opts.length >= 2;
  }

  function extractOptions(lines) {
    const opts = [];
    for (const line of lines) {
      const r = splitInlineOptions(line);
      if (r.opts.length >= 2) { r.opts.forEach(o => opts.push(o)); continue; }
      const m = line.match(RE_OPTION);
      if (m) opts.push({ key: m[1].toUpperCase(), text: trim(m[2]) });
    }
    return opts;
  }

  function findAnswer(lines) {
    for (const line of lines) {
      const m = line.match(RE_ANSWER);
      if (m) return trim(m[2]);
    }
    return null;
  }

  function findExplanation(lines) {
    for (const line of lines) {
      const m = line.match(RE_EXPL);
      if (m) return trim(m[2]);
    }
    return null;
  }

  function parseAnswerKeys(ans) {
    if (!ans) return [];
    const keys = (ans.match(/[A-Ha-h]/g) || []).map(k => k.toUpperCase());
    return Array.from(new Set(keys));
  }

  function isJudgeValue(ans) {
    if (ans == null) return false;
    const a = trim(ans);
    if (JUDGE_TRUE.test(a) || JUDGE_FALSE.test(a)) return true;
    // 形如 "对" 或 "错误" 单字词
    return /^(对|错|正确|错误|√|×|✓|✗|是|否|真|假)$/.test(a);
  }

  function judgeBool(ans) {
    return JUDGE_TRUE.test(trim(ans));
  }

  /**
   * 填空题抽取：题干尾部（或下一行）的括号内容就是答案
   * 只在「以题号开头的块」上调用 —— 这是最重要的护栏，
   * 否则正文里的括号补充说明（海洋法：…（以下简称"海域"））会被误当成答案。
   * 覆盖三种真实变体：
   *   A. 同行尾括号   1-1. 国际法调整的对象主要是(国家之间的关系)
   *   B. 答案单独一行 1-5. 国际法效力的根据是 \n (国家的共同意志)
   *   C. 题干折行     1-16.…并不必然意 \n 味着…。这表明（国家应在司法上遵守国际法）
   * @returns {{stem:string, answer:string}|null}
   */
  function extractFill(lines) {
    const ls = lines.map(trim).filter(Boolean);
    if (!ls.length) return null;

    // B. 答案单独占一行（只看前 3 行，避免把后面的内容误当答案）
    for (let i = 1; i < Math.min(ls.length, 3); i++) {
      const m = ls[i].match(RE_PAREN_ONLY);
      if (m && m[1].length) {
        const stem = ls.slice(0, i)
          .map((l, k) => (k === 0 ? stripNumber(l) : l))
          .join('').replace(/\s+/g, ' ').trim();
        if (stem) return { stem: stem + BLANK, answer: trim(m[1]) };
      }
    }

    // A + C. 题干（允许折行，最多拼 3 行）尾部带括号
    // 折行是 OCR 截断，拼接时不加空格，否则「并不必然意」+「味着」会断成两个词
    for (let n = Math.min(3, ls.length); n >= 1; n--) {
      const joined = ls.slice(0, n).join('');
      const m = joined.match(RE_TAIL_PAREN);
      if (!m) continue;
      const answer = trim(m[1]);
      if (!answer || answer.length > 60) continue;         // 太长多半是补充说明不是答案
      const stem = stripNumber(joined.slice(0, m.index).trim());
      if (stem.length < 4) continue;                       // 题干太短，多半误判
      return { stem: stem + BLANK, answer: answer };
    }
    return null;
  }

  function blockHasAnswer(lines) {
    return findAnswer(lines) != null || lines.some(l => isJudgeValue(trim(l)));
  }

  function hasAnswerInBuffer(lines) {
    return lines.some(l => RE_ANSWER.test(l) || isJudgeValue(trim(l)));
  }

  // 行内归一化：把同一行里的选项(A. B. C.)和答案/解析标记拆成独立行
  // 只在「以题号开头」或「含答案/解析标记」的行上做，避免误伤名词解释里的 "A." 字样
  const RE_ANS_MARK = /(?:答案|正确答案|参考答案|标准答案|answer|解析|答案解析|解答|解释)\s*[:：]?/i;
  function normalizeLine(line) {
    // v6：先按「答案/解析」标记切段，再对每段尝试「行内多选项」拆分。
    // 顺序很关键 —— 反过来写会把「A.北京 B.上海 C.广州 答案B」里的
    // 「答案B」粘在最后一个选项上（实测回归测试 A6 就是这么挂的）。
    const out = [];
    for (const seg of line.split(new RegExp('(?=' + RE_ANS_MARK.source + ')', 'i'))) {
      const t = trim(seg);
      if (!t) continue;
      const r = splitInlineOptions(t);
      if (r.opts.length >= 2) {
        if (r.prefix) out.push(r.prefix);            // 题干，不能丢
        r.opts.forEach(o => out.push(o.key + '. ' + o.text));
      } else out.push(t);
    }
    return out;
  }

  // 把文本切成「块」（每个块 = 一道题或一段内容）
  // v2：同时维护 h1~h6 任意层级的目录树 outline，每个块带 chapterId / chapterPath / typeHint
  function splitIntoBlocks(text) {
    const lines = text.split(/\r?\n/);
    let name = '未命名题库';
    let nameSet = false;
    const outline = [];              // 顶层目录节点
    const stack = [];                // stack[level] = 节点，level 从 1 开始
    const blocks = [];
    let buffer = [];
    let bufHasStem = false;
    let bufChapterOnly = false;   // 本块只是章节名，不生成题目
    let bufQno = null;            // v6：本块首行的题号（用于跨区匹配答案）
    let bufTagType = null;        // v6：本块行内的方括号题型号（【简答题】）
    let sectionType = null;       // v6：当前题型区（一、单项选择题…）
    let skipUntilStem = false;    // v6：题型区标题后的说明文字，丢弃到首个题号为止
    let idSeq = 0;

    function makeNode(title, level) {
      return { id: 'c' + (++idSeq), title: title || '(无标题)', level: level, children: [], parent: null, hint: null };
    }

    // 挂到「层级比自己浅的最近节点」下，找不到父则进顶层
    function attach(node) {
      let parent = null;
      for (let l = node.level - 1; l >= 1; l--) { if (stack[l]) { parent = stack[l]; break; } }
      node.parent = parent;
      if (parent) parent.children.push(node); else outline.push(node);
      stack[node.level] = node;
      for (let l = node.level + 1; l < stack.length; l++) stack[l] = null;
      return node;
    }

    function currentNode() {
      for (let l = stack.length - 1; l >= 1; l--) if (stack[l]) return stack[l];
      return null;
    }

    // 题目必须挂在 level>=2 的节点上；若当前只有 h1 或完全无标题，建一个「未分组」
    function ensureChapterNode() {
      const n = currentNode();
      if (n && n.level >= 2) return n;
      let fb = n ? n.children.filter(c => c.fallback)[0] : outline.filter(c => c.fallback)[0];
      if (!fb) { fb = makeNode('未分组', 2); fb.fallback = true; attach(fb); }
      return fb;
    }

    // 章节路径：从 level>=2 往上拼，不含 h1（h1 是题库名）
    function pathOf(node) {
      const p = [];
      let cur = node;
      while (cur && cur.level >= 2) { p.unshift(cur.title); cur = cur.parent; }
      return p;
    }

    function flush() {
      if (buffer.length) {
        const nonEmpty = buffer.filter(l => trim(l).length);
        if (nonEmpty.length) {
          const node = ensureChapterNode();
          const cp = pathOf(node);
          blocks.push({
            chapterId: node.id,
            chapterPath: cp,
            chapter: cp.join(' / ') || '未分组',
            // v6：题型号（【简答题】）> 题型区（三、简答题）> 标题 hint
            typeHint: bufTagType || sectionType || node.hint,
            chapterOnly: bufChapterOnly,
            qno: bufQno,
            lines: nonEmpty.slice()
          });
        }
      }
      buffer = [];
      bufHasStem = false;
      bufChapterOnly = false;
      bufQno = null;                // 题号每块重置
      bufTagType = null;            // 题型号每块重置，sectionType 不重置
    }

    for (const raw of lines) {
      // v6：题型区标题（一、单项选择题 / 三、简答题：本大题共 4 小题…）
      // 命中后 flush 并切换 sectionType，其后所有题都继承该题型
      const stRaw = raw.match(RE_SECTION_TYPE);
      if (stRaw) {
        const t = classifySection(stRaw[2]);
        if (t) {
          flush();
          sectionType = t;
          skipUntilStem = true;   // 丢弃题型说明（「本大题共30小题…请将其选出。」）
          // 平级建节点（多个题型区是兄弟关系），便于 UI 分组
          const cur = currentNode();
          const n = makeNode(trim(raw), (cur && cur.level >= 2) ? cur.level : 2);
          n.hint = t; n.section = true;
          attach(n);
          continue;
        }
      }
      // v6：题型区标题之后、首个题号之前的说明文字直接丢弃。
      // 否则「只有一项是最符合题目要求的，请将其选出。」会被并入第 1 题的题干。
      if (skipUntilStem) {
        if (!isQuestionStart(raw)) continue;
        skipUntilStem = false;
      }
      // 章节标记行独占一块：否则「1章导论」会把紧随的「1-1. …」吞成自己的定义
      if (RE_CHAPTER_LINE.test(raw)) {
        flush();
        buffer.push(raw);
        bufChapterOnly = true;
        flush();
        continue;
      }
      const h = raw.match(RE_HEADING);
      if (h) {
        const level = h[1].length;
        const content = trim(h[2]);
        flush();
        // 题库名只取第一个非空 H1（v1 会被后面的 H1 覆盖，已修）
        if (level === 1 && !nameSet && content) { name = content; nameSet = true; }
        const node = makeNode(content, level);
        node.hint = classifyHint(content);
        attach(node);
        continue;
      }
      const isStem = isQuestionStart(raw);
      // 遇到新题号，且当前块已经有题干 或 已经含答案 -> 上一题结束，切分
      if (buffer.length && isStem && (bufHasStem || hasAnswerInBuffer(buffer))) {
        flush();
      }
      // 名词解释行也当切分点：否则「海洋法：…」「内水：…」连续多条会粘成一个块
      if (buffer.length && isTermLine(raw)) flush();
      if (isStem || isTermLine(raw)) bufHasStem = true;
      // v6：记录本块首行题号（仅第一次），供答案区按题号回填
      if (bufQno == null) { const qn = qnoOf(raw); if (qn != null) bufQno = qn; }
      // v6：记录方括号题型号（【简答题】），优先级高于章节式题型区
      if (!bufTagType) { const tg = typeTagOf(raw); if (tg) bufTagType = tg; }
      // 行内选项/答案归一化（带护栏）
      // v6：补上 hasInlineOptions —— 「A.复合国 B.中立国」这类行既无题号也无答案标记，
      // 旧版不归一化，导致 B 选项被吞进 A 的文本里。
      if (RE_NUMSTEM_DIGIT.test(raw) || RE_ANS_MARK.test(raw) || hasInlineOptions(raw)) {
        normalizeLine(raw).forEach(nl => buffer.push(nl));
      } else {
        buffer.push(raw);
      }
    }
    flush();
    return { name: name, outline: outline, blocks: blocks };
  }

  /**
   * 名词解释构造：尝试「术语：定义」同行拆分
   * 抽成公共函数的原因：兜底分支也要走这套拆分。
   * 否则像「A．法律承认：正式的，不可撤销」这种被误认成选项的行，
   * 会因 options.length !== 0 跳过名词解释分支，掉进兜底后丢掉定义。
   * @returns {object|null} 无定义时返回 null（正文碎片，不入库）
   */
  function buildTerm(lines, ans, expl, chapter) {
    const first = lines[0] ? stripNumber(lines[0]) : '';
    const colon = first.match(RE_TERM_COLON);
    let term, definition;
    let usedColon = false;    // v6：是否真的走了「术语：定义」同行拆分
    // v5：原护栏 first.length <= 40 会把「条约：很长的定义…」整行挡在门外，
    // 导致题干变成整句话、definition 为空。改为只看术语部分长度 + 定义部分最小长度。
    if (colon && colon[1].length <= 30 && colon[2].length >= 4) {
      term = trim(colon[1]);
      usedColon = true;
      definition = [trim(colon[2])]
        .concat(lines.slice(1).map(l => trim(l)).filter(Boolean))
        .join(' ').replace(/\s+/g, ' ').trim();
    } else {
      term = trim(first);
      definition = lines.slice(1).map(l => trim(l)).filter(Boolean)
        .join(' ').replace(/\s+/g, ' ').trim();
    }
    // 若有答案行且不是判读，把答案当定义补充
    if (ans != null && !definition) definition = ans;
    if (!definition) return null;

    // v6：孤儿行护栏。真题里题干常被 PDF 断行切成碎片，这些碎片没有同行冒号定义，
    // 会被误当成名词解释。实测样本（202410）产生的碎片：
    //   「和保全」「义务有」「及其上覆水域的自然资源的主权权利」
    //   「交关系的一个较特殊的部分」「领空国可以设立空中禁区」
    // 实测：这些碎片**都带冒号**（「和保全：(1 分)…」），是简答题答案被 PDF 断行后
    // 形成的残片 —— 所以校验必须对「有无冒号定义」一视同仁，不能只管无冒号的情况。
    if (term.length < 2 || term.length > 12) return null;                    // 长度不像术语
    // 含句中标点 → 不是术语。**不收录句号**：中文句子普遍以句号结尾，
    // 用句号过滤会误杀「随便一段没有答案的文本。」这类正常降级项（回归用例 A12）
    if (/[，；！？、,;!?]/.test(term)) return null;
    // 连词/副词开头 → 是句子片段（「及其…」「和保全」这类断行残片）
    if (/^(?:及其|并且|而且|但是|因此|所以|由于|虽然|尽管|然后|接着|另外|同时|例如|比如|其中|首先|其次|最后|总之|此外|以及|或者|还是|[和与或的并又也就才更很太最还再已曾将会能可应须])/.test(term)) return null;
    // 虚词/动词结尾 → 句子被截断。
    // 只在短词（<=4 字）上生效：「义务有」「和保全」这类残片都很短；
    // 而「随便一段没有」(6 字) 里的「有」是正常构词，误杀会破坏兜底降级（回归用例 A12）
    if (term.length <= 4
        && /(?:的|了|和|与|或|是|在|有|可以|应当|应该|必须|能够|会|能|要|将|被|由|使|让|对|把|从|向|给|等|中|上|下|内|外)$/.test(term)) return null;
    // 超过 10 字还含虚词 → 基本可断定是句子残片。两个例外：
    //   ① 阈值取 10，为了放过「群岛水域的通过制度」(9 字) 这类含「的」的真术语
    //   ② 以句号结尾的整句不删 —— 那是完整的陈述句，正是「降级为名词解释」的
    //      兜底场景（回归用例 A12：随便一段没有答案的文本。）
    if (term.length > 10 && !/。$/.test(term)
        && /(?:的|了|可以|应当|必须|应该|能够)/.test(term)) return null;
    // 阈值取 4 而非 8：「随便一段没有答案的文本。」会被 RE_ANS_MARK 拆成
    // 「随便一段没有」+「答案的文本。」，definition 只剩 6 字，
    // 用 8 会误杀这种合法的兜底降级项（回归用例 A12）。
    // 碎片识别靠的是上面的 term 特征，不依赖 definition 长度。
    if (definition.length < 4) return null;
    return {
      type: 'term',
      chapter: chapter,
      term: term || '(未命名)',
      definition: definition,
      explanation: expl || ''
    };
  }

  function parseBlock(block, ctx) {
    if (block.chapterOnly) return null;   // 只是章节名，不是题
    ctx = ctx || {};
    const lines = block.lines;
    const options = extractOptions(lines);
    const ans = findAnswer(lines);
    const expl = findExplanation(lines);
    // v6：按题号从集中答案区取答案（题目区自身无答案时补位）
    const ea = (ctx.examAnswers && block.qno != null) ? ctx.examAnswers.get(block.qno) : null;

    // 0) v6：主观题区（三、简答题 / 四、论述题 / 五、案例分析题）
    //    必须排在名词解释分支之前，否则「36. 简述中国的庇护法律制度。」
    //    会被 buildTerm 当成名词解释，定义为答案正文。
    if (block.typeHint === 'essay' && options.length === 0) {
      const stem = lines.map((l, i) => (i === 0 ? stripNumber(l) : l))
        .join(' ').replace(/\s+/g, ' ').trim();
      const answer = (ea && ea.text) ? trim(ea.text) : (ans || '');
      if (stem.length >= 2) {
        return {
          type: 'essay',
          chapter: block.chapter,
          stem: stem,
          answer: answer,
          explanation: expl || ''
        };
      }
    }

    // 1) 选择题：有 >=2 个选项
    if (options.length >= 2) {
      let keys = parseAnswerKeys(ans);
      // v6：块内无答案 → 从集中答案区按题号回填
      if (!keys.length && ea && ea.keys && ea.keys.length) keys = ea.keys.slice();
      // v5 护栏：仍然没有答案的选择题一律不入库。
      // 实测：样本里这类题 7/7 都是正文段落被误判（题干是「(无题干)」或整段正文），
      // 且无答案的选择题判分恒为错，留在库里只会干扰。
      if (!keys.length) return null;
      // v6 护栏：答案键必须落在实际选项内，否则说明答案与题目错配（跨区串号）
      const valid = keys.filter(k => options.some(o => o.key === k));
      if (!valid.length) return null;
      if (valid.length !== keys.length) keys = valid;
      const firstOpt = lines.findIndex(l => RE_OPTION.test(l));
      const stemLines = lines.slice(0, firstOpt < 0 ? lines.length : firstOpt);
      const stem = stemLines.map((l, i) => i === 0 ? stripNumber(l) : l).join(' ').replace(/\s+/g, ' ').trim();
      return {
        type: (keys.length > 1 || block.typeHint === 'multiple') ? 'multiple' : 'single',
        chapter: block.chapter,
        stem: stem || '(无题干)',
        options,
        answer: keys,
        explanation: expl || ''
      };
    }

    // 1.5) 简答：块内有「答：」开头的行（编号题 + 答：内容）
    //     注意 RE_ANSWER 只认「答案」，不认单个「答」，所以这里单独判定
    const ansLineIdx = lines.findIndex(l => RE_ANS_LINE.test(l));
    if (ansLineIdx > 0 && options.length === 0) {
      const answer = lines.slice(ansLineIdx)
        .map(l => trim(l.replace(RE_ANS_LINE, '$1')))
        .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
      const stem = lines.slice(0, ansLineIdx).map(trim).filter(Boolean)
        .map((l, i) => (i === 0 ? stripNumber(l) : l))
        .join(' ').replace(/\s+/g, ' ').trim();
      if (stem.length >= 2 && answer.length >= 2) {
        return { type: 'essay', chapter: block.chapter, stem: stem, answer: answer, explanation: expl || '' };
      }
    }

    // 1.6) 填空：必须以题号开头（护栏），且尾部/次行有括号答案
    if (options.length === 0 && ans == null && startsWithQno(lines[0] || '')) {
      const fill = extractFill(lines);
      if (fill) {
        return { type: 'fill', chapter: block.chapter, stem: fill.stem, answer: fill.answer, explanation: expl || '' };
      }
    }

    // 2) 判断题：答案行是 对/错 之类
    if (ans != null && isJudgeValue(ans) && options.length === 0) {
      const ansIdx = lines.findIndex(l => RE_ANSWER.test(l));
      const stemLines = lines.slice(0, ansIdx < 0 ? lines.length : ansIdx);
      const stem = stemLines.map((l, i) => i === 0 ? stripNumber(l) : l).join(' ').replace(/\s+/g, ' ').trim();
      // 题干可能带了 对/错 在句末，去掉
      return {
        type: 'judge',
        chapter: block.chapter,
        stem: stem || '(无题干)',
        answer: judgeBool(ans),
        explanation: expl || ''
      };
    }

    // 3) 名词解释：无选项、无判读答案
    if (options.length === 0 && (ans == null || !isJudgeValue(ans))) {
      return buildTerm(lines, ans, expl, block.chapter);
    }

    // 兜底：当成名词解释（走同一套冒号拆分，无定义则不入库）
    return buildTerm(lines, ans, expl, block.chapter);
  }

  function parseDocument(text, opts) {
    opts = opts || {};
    // 默认先清洗水印；传 { clean:false } 可跳过
    const cleaned = (opts.clean === false)
      ? { removedLines: 0, strippedLines: 0 }
      : cleanText(text, opts);
    const src = (opts.clean === false) ? String(text == null ? '' : text) : cleaned.text;

    if (!src || !src.trim()) {
      return { name: '未命名题库', outline: [], questions: [], cleaned: cleaned };
    }

    // v6：真题试卷体 —— 剥离尾部集中答案区，解析成 Map<qno, {keys,text}>，按题号回填
    const exam = (opts.examPaper === false)
      ? { body: src, answers: null, mark: '' }
      : extractExamAnswers(src);
    const ctx = { examAnswers: exam.answers };

    const { name, outline, blocks } = splitIntoBlocks(exam.body);
    const questions = [];
    let matched = 0;
    for (const b of blocks) {
      const q = parseBlock(b, ctx);
      if (!q) continue;
      // 补章节归属：chapterId 指向 outline 节点，chapterPath 是完整路径
      q.chapterId = b.chapterId;
      q.chapterPath = b.chapterPath;
      q.chapter = b.chapter;
      if (exam.answers && b.qno != null && exam.answers.has(b.qno)) matched++;
      questions.push(q);
    }

    // 答案区规模统计，供 UI 回显「匹配答案 N 题」
    let answerTotal = 0, maxQ = 0;
    if (exam.answers) {
      exam.answers.forEach((v, k) => {
        if ((v.keys && v.keys.length) || v.text) answerTotal++;
        if (k > maxQ) maxQ = k;
      });
    }
    // 缺口报告：答案区未覆盖的题号。多因 OCR 字符级损坏
    // （实测 202404 的「cm 7. D」实为「6. A 7. D」，00247 的「30.6」实为「30. B」），
    // 无法安全自动修复，列出来供人工补录。
    const missing = [];
    if (maxQ > 0) for (let i = 1; i <= maxQ; i++) if (!exam.answers.has(i)) missing.push(i);

    return {
      name: name, outline: outline, questions: questions, cleaned: cleaned,
      exam: { mark: exam.mark, answerTotal: answerTotal, matched: matched, missing: missing }
    };
  }

  return {
    parseDocument, cleanText, WM_EXTRA, WM_STRONG,
    extractExamAnswers, parseAnswerSection, classifySection,
    _splitIntoBlocks: splitIntoBlocks, _parseBlock: parseBlock
  };
});

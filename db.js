/*
 * db.js — IndexedDB 存储层（纯前端，离线可用）
 * stores: banks / questions / progress
 *
 * v2（2026-08-30）：章节升级为目录树
 *   - banks 存 outline（parser 输出的 h1~h6 树）
 *   - questions 加 chapterId / chapterPath，并建 bankId_chapter 复合索引
 *   - v1 旧数据自动迁移：按 (bankId, chapter字符串) 归并出 legacy-* 节点 id
 *   - getOutline() 统一出口：无 outline 时从题目反推并回写，且始终叠加实时题数
 *
 * F1 错题本（2026-09-02）：只在 progress 记录上加 lastWrong / wrongDismissed 两个字段，
 *   不动 objectStore 结构，因此无需升 DB_VERSION，老库直接可用。
 * F2 统计面板（2026-09-02）：新增 sessions 作答流水表（DB_VERSION 2→3），
 *   三模式每答一题记一条 {ts,qid,mode,right,ms}；升级只加表，旧数据零迁移。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DB = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DB_NAME = 'card-quiz';
  const DB_VERSION = 3;
  let _db = null;
  let _opening = null;          // 复用同一个 open Promise，避免并发时重复打开

  // 数据库级事件通知（blocked / versionchange / quota），由 UI 层注册
  let _evtHandler = null;
  function setEventHandler(fn) { _evtHandler = typeof fn === 'function' ? fn : null; }
  function emit(kind, detail) { try { if (_evtHandler) _evtHandler(kind, detail); } catch (e) {} }

  // 存储配额超限：手机上很常见，必须能认出来并给明确提示，而不是静默失败
  function isQuotaError(e) {
    if (!e) return false;
    const n = e.name || '';
    return n === 'QuotaExceededError' || n === 'NS_ERROR_DOM_QUOTA_REACHED' ||
      e.code === 22 || /quota/i.test(String(e.message || ''));
  }

  function open() {
    if (_db) return Promise.resolve(_db);
    if (_opening) return _opening;                 // 并发 open 复用，避免重复建连
    _opening = new Promise((resolve, reject) => {
      let req;
      try { req = indexedDB.open(DB_NAME, DB_VERSION); }
      catch (e) { _opening = null; reject(e); return; }   // 无痕模式等环境直接抛

      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('banks')) {
          db.createObjectStore('banks', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('questions')) {
          const s = db.createObjectStore('questions', { keyPath: 'id' });
          s.createIndex('bankId', 'bankId', { unique: false });
        }
        if (!db.objectStoreNames.contains('progress')) {
          const s = db.createObjectStore('progress', { keyPath: 'qid' });
          s.createIndex('bankId', 'bankId', { unique: false });
        }
        // --- v1 -> v2：章节从「扁平字符串」升级为「目录树节点」 ---
        const qs = e.target.transaction.objectStore('questions');
        if (e.oldVersion < 2 && !qs.indexNames.contains('bankId_chapter')) {
          qs.createIndex('bankId_chapter', ['bankId', 'chapterId'], { unique: false });
        }
        if (e.oldVersion >= 1 && e.oldVersion < 2) {
          // 旧题目没有 chapterId/chapterPath，按 (bankId, chapter字符串) 归并出稳定的 legacy 节点 id
          const legacy = {};
          qs.openCursor().onsuccess = (ev) => {
            const c = ev.target.result;
            if (!c) return;
            const q = c.value;
            if (!q.chapterId) {
              const ch = q.chapter || '未分组';
              const bkey = q.bankId + '||' + ch;
              if (!legacy[bkey]) legacy[bkey] = 'legacy-' + Object.keys(legacy).length;
              q.chapterId = legacy[bkey];
              q.chapterPath = String(ch).split(' / ');
              q.chapter = ch;
              c.update(q);
            }
            c.continue();
          };
        }
        // --- v2 -> v3：新增 sessions 作答流水表（F2 统计面板），只加表不迁旧数据 ---
        if (e.oldVersion < 3) ensureSessionsStore(db);
      };
      // 另一个标签页正开着旧版本数据库 → 升级被阻塞。
      // 不处理的话界面会一直卡住且没有任何提示。
      req.onblocked = () => emit('blocked');

      req.onsuccess = (e) => {
        const db = e.target.result;
        // 别的标签页要升级版本：主动让路，否则对方会一直 blocked
        db.onversionchange = () => {
          try { db.close(); } catch (err) {}
          _db = null;
          emit('versionchange');
        };
        // 连接被外力关闭（清数据、浏览器回收）→ 置空，下次自动重连，
        // 否则 _db 会永远指向一个已关闭的连接，全站读写失效
        db.onclose = () => { _db = null; };
        _db = db;
        _opening = null;
        resolve(db);
      };
      req.onerror = (e) => { _opening = null; reject(e.target.error); };
      req.onblocked = () => emit('blocked');
    });
    return _opening;
  }

  function tx(store, mode) { return open().then(db => db.transaction(store, mode).objectStore(store)); }

  function reqP(r) {
    return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  }

  // 等事务真正落盘。onerror + onabort 都要接：只接 onerror 时，
  // 配额超限等场景会走 abort 而静默卡住（Promise 永不 settle）
  function txDone(t) {
    return new Promise((res, rej) => {
      t.oncomplete = () => res();
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error || new Error('事务被中止'));
    });
  }

  function uid() {
    return (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2));
  }

  // ---- banks ----
  // parser 的目录节点带 parent 反向指针（成环）：IndexedDB 结构化克隆存得下，
  // 但 JSON.stringify 会直接抛 "Converting circular structure" → 备份导出/局域网同步全崩。
  // 所以入库与导出前统一剥掉 parent，只留渲染和计数需要的字段。
  function sanitizeOutline(nodes) {
    if (!Array.isArray(nodes)) return null;
    const out = [];
    nodes.forEach(n => {
      if (!n || typeof n !== 'object') return;
      const o = { id: n.id, title: n.title, level: n.level, children: sanitizeOutline(n.children) || [] };
      if (n.hint != null) o.hint = n.hint;
      if (typeof n.count === 'number') o.count = n.count;
      if (typeof n.total === 'number') o.total = n.total;
      out.push(o);
    });
    return out;
  }

  // outline 为 parser 输出的 h1~h6 目录树；旧调用 saveBank(name) 仍兼容（outline=null，读时自动推导）
  async function saveBank(name, outline) {
    const bank = { id: uid(), name: name, outline: outline ? sanitizeOutline(outline) : null, createdAt: Date.now(), updatedAt: Date.now(), count: 0 };
    const s = await tx('banks', 'readwrite');
    await reqP(s.put(bank));
    return bank;
  }
  async function listBanks() {
    const s = await tx('banks', 'readonly');
    const all = await reqP(s.getAll());
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async function getBank(id) {
    const s = await tx('banks', 'readonly');
    return reqP(s.get(id));
  }
  async function deleteBank(id) {
    const db = await open();
    await new Promise((res, rej) => {
      const t = db.transaction(['banks', 'questions', 'progress', 'sessions'], 'readwrite');
      t.objectStore('banks').delete(id);
      const qi = t.objectStore('questions').index('bankId');
      const pi = t.objectStore('progress').index('bankId');
      const si = t.objectStore('sessions').index('bankId');
      const cur1 = qi.openCursor(IDBKeyRange.only(id));
      cur1.onsuccess = (e) => { const c = e.target.result; if (c) { c.delete(); c.continue(); } };
      const cur2 = pi.openCursor(IDBKeyRange.only(id));
      cur2.onsuccess = (e) => { const c = e.target.result; if (c) { c.delete(); c.continue(); } };
      // F2：删库连带删作答流水，否则全站累计统计会留着已删题库的幽灵数据
      const cur3 = si.openCursor(IDBKeyRange.only(id));
      cur3.onsuccess = (e) => { const c = e.target.result; if (c) { c.delete(); c.continue(); } };
      txDone(t).then(res, rej);
    });
  }

  // ---- questions ----
  // 分批大小：单事务写太多记录在手机上容易超时/被系统回收
  const CHUNK = 200;

  async function addQuestions(bankId, questions) {
    const list = questions || [];
    const ids = [];
    for (let start = 0; start < list.length; start += CHUNK) {
      const part = list.slice(start, start + CHUNK);
      const store = await tx('questions', 'readwrite');
      for (let i = 0; i < part.length; i++) {
        const rec = Object.assign({ id: uid(), bankId: bankId, order: start + i }, part[i]);
        ids.push(rec.id);
        store.put(rec);
      }
      await txDone(store.transaction);
    }
    if (list.length) await bumpBankCount(bankId, list.length);
    return ids;
  }

  // 独立事务更新题量：不跟题目写入混在一个长事务里
  async function bumpBankCount(bankId, delta) {
    const s = await tx('banks', 'readwrite');
    const b = await reqP(s.get(bankId));
    if (b) { b.count = (b.count || 0) + delta; b.updatedAt = Date.now(); await reqP(s.put(b)); }
  }
  async function listQuestions(bankId) {
    const s = await tx('questions', 'readonly');
    const idx = s.index('bankId');
    const all = await reqP(idx.getAll(IDBKeyRange.only(bankId)));
    return all.sort((a, b) => (a.order || 0) - (b.order || 0));
  }

  // ---- 目录树（v2） ----
  // 章节统一用「路径」标识：从 h2 起（不含 h1 题库名），形如 "第一章\u0000选择题"
  // 理由：outline 节点 id 与题目 chapterId 在「反推目录」场景下可能对不上，路径则是唯一稳定的
  function chapterKey(q) {
    const p = (Array.isArray(q.chapterPath) && q.chapterPath.length) ? q.chapterPath : [q.chapter || '未分组'];
    return p.join('\u0000');
  }

  // 从题目反推目录树：旧题库无 outline、或章节信息来自老格式时的兜底
  function deriveOutlineFromQuestions(qs) {
    const map = new Map();
    const roots = [];
    qs.forEach(q => {
      const path = (Array.isArray(q.chapterPath) && q.chapterPath.length) ? q.chapterPath : [q.chapter || '未分组'];
      let parent = null; const acc = [];
      path.forEach((t, i) => {
        acc.push(t);
        const key = acc.join('\u0000');
        let node = map.get(key);
        if (!node) {
          const isLeaf = i === path.length - 1;
          node = {
            id: (isLeaf && q.chapterId) ? q.chapterId : 'd' + (map.size + 1),
            title: t, level: i + 2, children: [], count: 0, total: 0
          };
          map.set(key, node);
          if (parent) parent.children.push(node); else roots.push(node);
        }
        parent = node;
      });
    });
    return roots;
  }

  function countByChapterPath(qs) {
    const counts = {};
    qs.forEach(q => { const k = chapterKey(q); counts[k] = (counts[k] || 0) + 1; });
    return counts;
  }

  // 叠加题数：count = 本级直属，total = 含所有后代。h1 是题库名容器，不参与路径拼接
  function applyCounts(nodes, counts, prefix) {
    let n = 0;
    (nodes || []).forEach(x => {
      let key = null;
      let childPrefix = prefix || '';
      if (x.level !== 1) { key = prefix ? prefix + '\u0000' + x.title : x.title; childPrefix = key; }
      const self = key ? (counts[key] || 0) : 0;
      const sub = applyCounts(x.children, counts, childPrefix);
      x.count = self;
      x.total = self + sub;
      n += x.total;
    });
    return n;
  }

  // 取题库目录树：优先用入库时存的 outline，缺失则从题目反推并回写
  // 无论来源，都会叠加实时题数（count=本级 / total=含子节点）
  async function getOutline(bankId) {
    const bank = await getBank(bankId);
    const qs = await listQuestions(bankId);
    let outline = (bank && bank.outline && bank.outline.length) ? bank.outline : null;
    if (!outline) {
      outline = deriveOutlineFromQuestions(qs);
      if (bank) {
        bank.outline = outline;
        const s = await tx('banks', 'readwrite');
        await reqP(s.put(bank));
      }
    }
    applyCounts(outline, countByChapterPath(qs), '');
    return outline;
  }

  // 展开选中节点为「自身 + 全部后代」的章节路径集合，用于按章节筛题
  function expandChapterPaths(outline, selectedIds) {
    const out = new Set();
    const sel = new Set(selectedIds || []);
    function collect(nodes, prefix) {
      (nodes || []).forEach(n => {
        if (n.level === 1) { collect(n.children, ''); return; }
        const k = prefix ? prefix + '\u0000' + n.title : n.title;
        out.add(k);
        collect(n.children, k);
      });
    }
    (function walk(nodes, prefix) {
      (nodes || []).forEach(n => {
        if (n.level === 1) { walk(n.children, ''); return; }
        const k = prefix ? prefix + '\u0000' + n.title : n.title;
        if (sel.has(n.id)) { collect([n], prefix); return; }
        walk(n.children, k);
      });
    })(outline, '');
    return out;
  }

  // ---- progress ----
  async function getProgress(qid) {
    const s = await tx('progress', 'readonly');
    return reqP(s.get(qid));
  }
  async function saveProgress(p) {
    const s = await tx('progress', 'readwrite');
    return reqP(s.put(p));
  }
  async function listProgress(bankId) {
    const s = await tx('progress', 'readonly');
    const idx = s.index('bankId');
    return reqP(idx.getAll(IDBKeyRange.only(bankId)));
  }

  /**
   * 批量更新进度（单个事务完成）
   * 替代原先「每题 get + put 两次独立事务」的写法：
   *   100 题原来是 200 次事务，而且用 fire-and-forget 调用，页面一关成绩就没了。
   * @param {string} bankId
   * @param {Array<{qid:string, ok:boolean}>} list
   * @param {'exam'|'practice'} [mode]
   * @returns {Promise<number>}
   */
  async function bulkUpdateProgress(bankId, list, mode) {
    const items = (list || []).filter(it => it && it.qid);   // 过滤脏数据，避免坏 key 拖垮整个事务
    if (!items.length) return 0;
    const field = mode === 'practice' ? 'practice' : 'exam';
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction('progress', 'readwrite');
      const s = t.objectStore('progress');
      items.forEach(it => {
        const g = s.get(it.qid);
        g.onsuccess = () => {
          const p = g.result || { qid: it.qid, bankId: bankId, ease: 2.5, interval: 0, reps: 0, due: 0, lapses: 0 };
          p.bankId = bankId;
          p[field] = p[field] || { correct: 0, wrong: 0 };
          if (it.ok) p[field].correct++;
          else {
            p[field].wrong++;
            p.lapses = (p.lapses || 0) + 1;
            // 错题本（F1）：记下最近错误时间用于排序；曾被手动移除的要重新收回来
            p.lastWrong = Date.now();
            p.wrongDismissed = false;
          }
          p.due = Date.now();
          s.put(p);
        };
      });
      t.oncomplete = () => resolve(items.length);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('事务被中止'));
    });
  }

  // ---------- F1：跨会话错题本 ----------
  // 口径：progress 里 practice.wrong + exam.wrong 累计 > 0 即为错题。
  // 答对不做减法（累计口径），要清掉某题走 setWrongDismissed；再答错会自动收回。
  function wrongCount(p) {
    if (!p) return 0;
    const a = p.practice ? (p.practice.wrong || 0) : 0;
    const b = p.exam ? (p.exam.wrong || 0) : 0;
    return a + b;
  }
  function rightCount(p) {
    if (!p) return 0;
    const a = p.practice ? (p.practice.correct || 0) : 0;
    const b = p.exam ? (p.exam.correct || 0) : 0;
    return a + b;
  }
  // 顶层章节：chapterPath 的第一段（用于错题本的章节筛选，比整条路径更适合做筛选项）
  function topChapter(q) {
    if (!q) return '未分组';
    return (Array.isArray(q.chapterPath) && q.chapterPath.length) ? q.chapterPath[0] : (q.chapter || '未分组');
  }

  /**
   * 从 progress 记录挑出错题并排序
   * @param {Array} progs  DB.listProgress(bankId) 的结果
   * @param {Object} [opts]
   * @param {Object} [opts.questionMap] qid -> 题目；给了就会带出题目对象，且题目已不存在的记录不列
   * @param {Array<string>} [opts.types] 只保留这些题型
   * @param {string} [opts.chapter] 只保留顶层章节名等于它的题
   * @returns {Array<{qid,question,wrong,right,lastWrong,order}>}
   */
  function pickWrong(progs, opts) {
    const o = opts || {};
    const qmap = o.questionMap || null;
    const types = (o.types && o.types.length) ? new Set(o.types) : null;
    const chap = o.chapter || null;
    const out = [];
    (progs || []).forEach(p => {
      if (!p || !p.qid) return;
      const w = wrongCount(p);
      if (w <= 0 || p.wrongDismissed) return;
      const q = qmap ? (qmap[p.qid] || null) : null;
      if (qmap && !q) return;                       // 题目已被删/重导入过：无从展示，不列
      if (types && !types.has(q.type)) return;
      if (chap && topChapter(q) !== chap) return;
      out.push({
        qid: p.qid, question: q, wrong: w, right: rightCount(p),
        lastWrong: p.lastWrong || p.due || 0, order: q ? (q.order || 0) : 0
      });
    });
    out.sort((a, b) => (b.wrong - a.wrong) || (b.lastWrong - a.lastWrong) || (a.order - b.order));
    return out;
  }

  // 单题移出/收回错题本（不动 correct/wrong 计数，统计口径保持累计）
  async function setWrongDismissed(qid, bankId, dismissed) {
    const s = await tx('progress', 'readwrite');
    const p = await reqP(s.get(qid));
    if (!p) return false;
    p.wrongDismissed = !!dismissed;
    if (bankId) p.bankId = bankId;
    await reqP(s.put(p));
    return true;
  }

  // ---------- v9：整机备份 / 恢复（跨设备同步用） ----------
  async function dumpAll() {
    const banks = await reqP((await tx('banks', 'readonly')).getAll());
    const questions = await reqP((await tx('questions', 'readonly')).getAll());
    const progress = await reqP((await tx('progress', 'readonly')).getAll());
    const sessions = await reqP((await tx('sessions', 'readonly')).getAll());
    // 老库存的 outline 可能仍带 parent 环（sanitizeOutline 是后来才加的），导出前统一再剥一次
    const cleanBanks = (banks || []).map(b =>
      (b && b.outline) ? Object.assign({}, b, { outline: sanitizeOutline(b.outline) }) : b);
    return { app: 'card-quiz', version: 1, exportedAt: Date.now(), banks: cleanBanks, questions: questions, progress: progress, sessions: sessions };
  }

  async function restoreAll(dump) {
    if (!dump || dump.app !== 'card-quiz' || !Array.isArray(dump.banks) || !Array.isArray(dump.questions)) {
      throw new Error('备份文件格式不对');
    }
    const db = await open();
    const t = db.transaction(['banks', 'questions', 'progress', 'sessions'], 'readwrite');
    const bs = t.objectStore('banks'), qs = t.objectStore('questions'), ps = t.objectStore('progress'), ss = t.objectStore('sessions');
    bs.clear(); qs.clear(); ps.clear(); ss.clear();
    dump.banks.forEach(b => bs.put(b));
    dump.questions.forEach(q => qs.put(q));
    (dump.progress || []).forEach(p => ps.put(p));
    (dump.sessions || []).forEach(s => ss.put(s));
    await txDone(t);
  }

  // ---------- F2：sessions 作答流水（统计面板） ----------
  // 建表抽成纯函数：升级逻辑（老库加表不丢数据）可以用 stub 单测，不依赖真 IndexedDB
  function ensureSessionsStore(db) {
    if (!db || !db.objectStoreNames || db.objectStoreNames.contains('sessions')) return false;
    const s = db.createObjectStore('sessions', { keyPath: 'id' });
    s.createIndex('bankId', 'bankId', { unique: false });
    s.createIndex('ts', 'ts', { unique: false });
    return true;
  }

  /** 批量写作答流水（单事务）；过滤脏数据，补 id/ts，ms 兜底为 0 */
  async function logSessions(list) {
    const items = (list || []).filter(it => it && it.qid && it.mode);
    if (!items.length) return 0;
    const s = await tx('sessions', 'readwrite');
    const now = Date.now();
    items.forEach(it => s.put({
      id: uid(), bankId: it.bankId || null, qid: it.qid, mode: it.mode,
      right: !!it.right, ms: Math.max(0, Number(it.ms) || 0), ts: it.ts || now
    }));
    await txDone(s.transaction);
    return items.length;
  }

  async function listSessions(bankId) {
    const s = await tx('sessions', 'readonly');
    if (!bankId) return reqP(s.getAll());
    return reqP(s.index('bankId').getAll(IDBKeyRange.only(bankId)));
  }

  // ---- F2 聚合纯函数（单测覆盖） ----
  function pad2n(n) { n = String(n); return n.length >= 2 ? n : '0' + n; }
  /** 本地日期键 YYYY-MM-DD（打卡/每日图按用户本地天界算） */
  function dayKey(ts) {
    const d = new Date(ts);
    return d.getFullYear() + '-' + pad2n(d.getMonth() + 1) + '-' + pad2n(d.getDate());
  }
  function aggTotals(sessions) {
    let count = 0, ms = 0;
    (sessions || []).forEach(it => {
      if (!it || !it.qid) return;
      count++; ms += Math.max(0, Number(it.ms) || 0);
    });
    return { count: count, ms: ms };
  }
  /** 最近 days 天（含今天）每日答题数，旧→新，缺天补 0 */
  function dailyCounts(sessions, days, nowMs) {
    const n = days || 14; const now = nowMs || Date.now();
    const byKey = {};
    (sessions || []).forEach(it => {
      if (!it || !it.qid) return;
      const k = dayKey(it.ts); byKey[k] = (byKey[k] || 0) + 1;
    });
    const out = [];
    for (let i = n - 1; i >= 0; i--) {
      const k = dayKey(now - i * 86400000);
      out.push({ key: k, count: byKey[k] || 0 });
    }
    return out;
  }
  /** 连续打卡天数：从今天往回数；今天没练则从昨天起算（连续不断）；断天即停 */
  function streakDays(sessions, nowMs) {
    const set = {};
    (sessions || []).forEach(it => { if (it && it.qid) set[dayKey(it.ts)] = 1; });
    let t = nowMs || Date.now();
    if (!set[dayKey(t)]) t -= 86400000;
    let n = 0;
    while (set[dayKey(t)]) { n++; t -= 86400000; }
    return n;
  }

  // ---------- F18：弱项专项包（借鉴粉笔「个性化刷题 / 智能组卷」） ----------
  // 正确率一律复用 progress 累计口径（wrongCount/rightCount = practice + exam 合计），
  // 错题一律走 pickWrong，**不另写一套计数**；判分不在这里发生（scoring.js 不动）。

  /** 洗牌：随机源可注入（默认 Math.random），返回新数组不改入参，单测可复现 */
  function shuffleWith(arr, rand) {
    const a = (arr || []).slice();
    const r = typeof rand === 'function' ? rand : Math.random;
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.min(i, Math.max(0, Math.floor(r() * (i + 1))));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /**
   * 按顶层章节聚合正确率（topChapter = chapterPath[0]，与错题本筛选同口径）
   * acc = 累计答对 / 累计作答；**一次都没练过的章 acc = null**（未知，不参与弱章排名）
   * @returns {Array<{chapter,right,wrong,attempts,acc,totalQ,practicedQ}>} acc 升序（未知排最后）→ 作答数降序 → 章节名
   */
  function chapterAccuracy(questions, progs) {
    const pmap = {};
    (progs || []).forEach(p => { if (p && p.qid) pmap[p.qid] = p; });
    const agg = {};
    (questions || []).forEach(q => {
      if (!q) return;
      const c = topChapter(q);
      const a = agg[c] || (agg[c] = { chapter: c, right: 0, wrong: 0, attempts: 0, totalQ: 0, practicedQ: 0 });
      a.totalQ++;
      const p = pmap[q.id];
      const r = rightCount(p), w = wrongCount(p);
      if (r + w > 0) a.practicedQ++;
      a.right += r; a.wrong += w; a.attempts += r + w;
    });
    const out = Object.keys(agg).map(k => {
      const a = agg[k];
      a.acc = a.attempts ? a.right / a.attempts : null;
      return a;
    });
    out.sort((a, b) => {
      const ax = a.acc == null ? 2 : a.acc, bx = b.acc == null ? 2 : b.acc;
      return (ax - bx) || (b.attempts - a.attempts) || String(a.chapter).localeCompare(String(b.chapter));
    });
    return out;
  }

  /**
   * 弱章榜：正确率最低的 N 个章
   * 门槛：累计作答 ≥ minAttempts（默认 5）**且错过**——练得太少的章正确率是噪声，全对的章不是弱项
   */
  function weakChapters(questions, progs, opts) {
    const o = opts || {};
    const minA = o.minAttempts != null ? o.minAttempts : 5;
    const top = o.top != null ? o.top : 3;
    return chapterAccuracy(questions, progs)
      .filter(c => c.acc != null && c.attempts >= minA && c.wrong > 0)
      .slice(0, Math.max(0, top));
  }

  /**
   * 组「弱项专项包」：弱章题占 weakRatio（默认 60%）→ 错题补齐（去重）→ 全库随机回填到 total
   * 返回顺序 = 弱章 → 错题 → 回填（调用方自行洗牌）；一题不重复，题目对象直接来自入参不复制。
   * @param {Array} questions 全库题目
   * @param {Array} progs     DB.listProgress(bankId)
   * @param {Object} [opts]   total(默认20) / weakRatio(默认0.6) / top(默认3) / minAttempts(默认5) / rand(随机源)
   * @returns {{list:Array, mode:'weak'|'random', total:number, weak:Array, fromWeak:number, fromWrong:number, fromFill:number, attempts:number}}
   *          mode='random' = 没有弱章也没有错题，降级为全库随机包；attempts=0 即「还没有练习记录」
   */
  function weakPack(questions, progs, opts) {
    const o = opts || {};
    const rand = typeof o.rand === 'function' ? o.rand : Math.random;
    const qs = (questions || []).filter(Boolean);
    const stats = chapterAccuracy(qs, progs);
    const attempts = stats.reduce((n, c) => n + c.attempts, 0);
    const weak = weakChapters(qs, progs, o);
    const total = Math.max(0, Math.min(o.total || 20, qs.length));
    const weakRatio = (o.weakRatio != null) ? o.weakRatio : 0.6;
    const nWeak = Math.min(total, Math.round(total * weakRatio));

    const list = []; const seen = {};
    let fromWeak = 0, fromWrong = 0;
    const push = (q) => {
      if (!q || !q.id || seen[q.id] || list.length >= total) return false;
      seen[q.id] = 1; list.push(q); return true;
    };

    // ① 弱章：各章轮流抽，某章题不够时由其它弱章补上，不让 60% 的名额落空
    if (weak.length && nWeak > 0) {
      const byChap = {};
      qs.forEach(q => { const c = topChapter(q); (byChap[c] = byChap[c] || []).push(q); });
      const pools = weak.map(c => shuffleWith(byChap[c.chapter] || [], rand));
      let guard = 0;
      while (fromWeak < nWeak && pools.some(p => p.length) && guard++ < 10000) {
        pools.forEach(p => { if (fromWeak < nWeak && p.length && push(p.shift())) fromWeak++; });
      }
    }

    // ② 错题：pickWrong 同源（累计口径、已「移除」的不算、题目已删的不算），补到装满为止
    const qmap = {}; qs.forEach(q => { qmap[q.id] = q; });
    pickWrong(progs, { questionMap: qmap }).forEach(it => {
      if (list.length >= total || seen[it.qid]) return;
      if (push(it.question)) fromWrong++;
    });

    // ③ 回填：还不够就从全库随机补（排除已选）
    const rest = shuffleWith(qs.filter(q => !seen[q.id]), rand);
    let fromFill = 0;
    for (let i = 0; i < rest.length && list.length < total; i++) { if (push(rest[i])) fromFill++; }

    return {
      list: list, mode: (fromWeak + fromWrong) > 0 ? 'weak' : 'random',
      total: list.length, weak: weak, attempts: attempts,
      fromWeak: fromWeak, fromWrong: fromWrong, fromFill: fromFill
    };
  }

  return {
    open, saveBank, listBanks, getBank, deleteBank, sanitizeOutline,
    addQuestions, listQuestions,
    getOutline, deriveOutlineFromQuestions, expandChapterPaths,
    countByChapterPath, applyCounts, chapterKey,
    getProgress, saveProgress, listProgress, bulkUpdateProgress,
    wrongCount, rightCount, topChapter, pickWrong, setWrongDismissed,
    ensureSessionsStore, logSessions, listSessions,
    dayKey, aggTotals, dailyCounts, streakDays,
    chapterAccuracy, weakChapters, weakPack,
    dumpAll, restoreAll,
    setEventHandler, isQuotaError, uid
  };
});

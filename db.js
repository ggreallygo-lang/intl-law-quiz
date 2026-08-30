/*
 * db.js — IndexedDB 存储层（纯前端，离线可用）
 * stores: banks / questions / progress
 *
 * v2（2026-08-30）：章节升级为目录树
 *   - banks 存 outline（parser 输出的 h1~h6 树）
 *   - questions 加 chapterId / chapterPath，并建 bankId_chapter 复合索引
 *   - v1 旧数据自动迁移：按 (bankId, chapter字符串) 归并出 legacy-* 节点 id
 *   - getOutline() 统一出口：无 outline 时从题目反推并回写，且始终叠加实时题数
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DB = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DB_NAME = 'card-quiz';
  const DB_VERSION = 2;
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
  // outline 为 parser 输出的 h1~h6 目录树；旧调用 saveBank(name) 仍兼容（outline=null，读时自动推导）
  async function saveBank(name, outline) {
    const bank = { id: uid(), name: name, outline: outline || null, createdAt: Date.now(), updatedAt: Date.now(), count: 0 };
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
      const t = db.transaction(['banks', 'questions', 'progress'], 'readwrite');
      t.objectStore('banks').delete(id);
      const qi = t.objectStore('questions').index('bankId');
      const pi = t.objectStore('progress').index('bankId');
      const cur1 = qi.openCursor(IDBKeyRange.only(id));
      cur1.onsuccess = (e) => { const c = e.target.result; if (c) { c.delete(); c.continue(); } };
      const cur2 = pi.openCursor(IDBKeyRange.only(id));
      cur2.onsuccess = (e) => { const c = e.target.result; if (c) { c.delete(); c.continue(); } };
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
          else { p[field].wrong++; p.lapses = (p.lapses || 0) + 1; }
          p.due = Date.now();
          s.put(p);
        };
      });
      t.oncomplete = () => resolve(items.length);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('事务被中止'));
    });
  }

  // ---------- v9：整机备份 / 恢复（跨设备同步用） ----------
  async function dumpAll() {
    const banks = await reqP((await tx('banks', 'readonly')).getAll());
    const questions = await reqP((await tx('questions', 'readonly')).getAll());
    const progress = await reqP((await tx('progress', 'readonly')).getAll());
    return { app: 'card-quiz', version: 1, exportedAt: Date.now(), banks: banks, questions: questions, progress: progress };
  }

  async function restoreAll(dump) {
    if (!dump || dump.app !== 'card-quiz' || !Array.isArray(dump.banks) || !Array.isArray(dump.questions)) {
      throw new Error('备份文件格式不对');
    }
    const db = await open();
    const t = db.transaction(['banks', 'questions', 'progress'], 'readwrite');
    const bs = t.objectStore('banks'), qs = t.objectStore('questions'), ps = t.objectStore('progress');
    bs.clear(); qs.clear(); ps.clear();
    dump.banks.forEach(b => bs.put(b));
    dump.questions.forEach(q => qs.put(q));
    (dump.progress || []).forEach(p => ps.put(p));
    await txDone(t);
  }

  return {
    open, saveBank, listBanks, getBank, deleteBank,
    addQuestions, listQuestions,
    getOutline, deriveOutlineFromQuestions, expandChapterPaths,
    countByChapterPath, applyCounts, chapterKey,
    getProgress, saveProgress, listProgress, bulkUpdateProgress,
    dumpAll, restoreAll,
    setEventHandler, isQuotaError, uid
  };
});

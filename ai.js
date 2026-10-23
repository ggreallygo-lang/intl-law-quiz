/*
 * ai.js — AI 助手模块（v41，接入智谱 AI）
 *
 * 四个功能：
 *   explain  — 答错后一键深度解析（为什么对/为什么错/法条依据）
 *   mnemonic — 生成记忆口诀/巧计（谐音/联想/对比）
 *   related  — 推荐关联题（AI 分析概念→本地题库匹配→一键跳转）
 *   tutor    — 答疑对话（浮动窗，上下文感知）
 *
 * 工程约束：
 *   - API Key 存 localStorage，绝不上传到任何中间服务器
 *   - 同一题的解析/口诀只请求一次（localStorage 缓存，容量控制）
 *   - 无 Key / 无网 / 超时 → 静默降级为灰按钮，不影响做题
 *   - 纯前端 fetch 直连智谱 API，无后端
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AI = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var API_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
  var CACHE_PREFIX = 'ai-cache-';
  var MAX_CACHE = 100;   // 最多缓存 100 条（防止 localStorage 超限）

  // ---- Key / 模型管理 ----
  function getKey() {
    try { return localStorage.getItem('ai-key') || ''; } catch (e) { return ''; }
  }
  function setKey(k) {
    try { localStorage.setItem('ai-key', String(k || '').trim()); } catch (e) {}
  }
  function getModel() {
    try { return localStorage.getItem('ai-model') || 'glm-4-flash'; } catch (e) { return 'glm-4-flash'; }
  }
  function setModel(m) {
    try { localStorage.setItem('ai-model', m); } catch (e) {}
  }
  function hasKey() { return !!getKey(); }

  // ---- v41.3 代理管理（CORS 跨域解决） ----
  var PUBLIC_PROXY = 'https://corsproxy.io/?url=';
  function getProxy() {
    try { return localStorage.getItem('ai-proxy') || ''; } catch (e) { return ''; }
  }
  function setProxy(u) {
    try { localStorage.setItem('ai-proxy', String(u || '').trim()); } catch (e) {}
  }
  // 记住上次成功的方式（'direct' | 'proxy'），避免每次都试错
  function getLastMode() {
    try { return localStorage.getItem('ai-mode') || ''; } catch (e) { return ''; }
  }
  function setLastMode(m) {
    try { localStorage.setItem('ai-mode', m); } catch (e) {}
  }
  function buildUrl(mode) {
    if (mode === 'custom') return getProxy();
    if (mode === 'proxy') return PUBLIC_PROXY + encodeURIComponent(API_URL);
    return API_URL;   // direct
  }
  function doFetch(url, body, authHeader) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
      body: JSON.stringify(body)
    });
  }
  function parseResp(res) {
    if (!res.ok) {
      return res.json().catch(function () { return {}; }).then(function (err) {
        throw new Error((err.error && err.error.message) || ('API(' + res.status + ')'));
      });
    }
    return res.json().then(function (data) {
      var c = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (!c) throw new Error('AI 返回为空');
      return c;
    });
  }

  // ---- 缓存 ----
  function cacheGet(id) {
    try { return localStorage.getItem(CACHE_PREFIX + id) || null; } catch (e) { return null; }
  }
  function cacheSet(id, text) {
    try {
      // 简单容量控制：超过 MAX_CACHE 条时清掉最旧的一半
      var keys = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf(CACHE_PREFIX) === 0) keys.push(k);
      }
      if (keys.length >= MAX_CACHE) {
        keys.sort();   // key 里有时间戳，排序即时间序
        keys.slice(0, Math.floor(MAX_CACHE / 2)).forEach(function (k) {
          try { localStorage.removeItem(k); } catch (e) {}
        });
      }
      localStorage.setItem(CACHE_PREFIX + id, text);
    } catch (e) {}   // 超限就跳过缓存
  }

  // ---- 核心请求 ----
  function chat(messages, opts) {
    var key = getKey();
    if (!key) return Promise.reject(new Error('请先填入 API Key'));
    var model = getModel();
    var body = {
      model: model,
      messages: messages,
      temperature: (opts && opts.temperature) != null ? opts.temperature : 0.7,
      max_tokens: (opts && opts.max_tokens) || 1024
    };
    var auth = 'Bearer ' + key;
    var customProxy = getProxy();

    // v41.3：自动探测最佳连接方式
    // 优先级：上次成功的方式 → 自定义代理 → 直连 → 公共代理
    var lastMode = getLastMode();
    var tryOrder = [];
    if (lastMode === 'custom' && customProxy) tryOrder.push('custom');
    else if (lastMode === 'proxy') tryOrder.push('proxy');
    else if (lastMode === 'direct') tryOrder.push('direct');
    if (customProxy && tryOrder.indexOf('custom') < 0) tryOrder.push('custom');
    if (tryOrder.indexOf('direct') < 0) tryOrder.push('direct');
    if (tryOrder.indexOf('proxy') < 0) tryOrder.push('proxy');

    var idx = 0;
    function attempt() {
      if (idx >= tryOrder.length) {
        return Promise.reject(new Error('所有连接方式均失败——请检查网络，或在设置中配置 Cloudflare Worker 代理地址'));
      }
      var mode = tryOrder[idx++];
      var url = buildUrl(mode);
      return doFetch(url, body, auth).then(function (res) {
        return parseResp(res);
      }).then(function (text) {
        setLastMode(mode);   // 记住成功方式，下次直接用
        return text;
      }).catch(function (e) {
        // 401/403 = Key 错误，不需要换方式重试
        if (e.message && (e.message.indexOf('API(401') >= 0 || e.message.indexOf('API(403') >= 0)) {
          throw e;
        }
        return attempt();   // 网络错误 → 试下一种方式
      });
    }
    return attempt();
  }

  // 带缓存的请求
  function chatCached(cacheId, messages, opts) {
    var cached = cacheGet(cacheId);
    if (cached) return Promise.resolve(cached);
    return chat(messages, opts).then(function (text) {
      cacheSet(cacheId, text);
      return text;
    });
  }

  // 测试连接
  function testConnection() {
    return chat([{ role: 'user', content: '回复"连接成功"四个字' }], { max_tokens: 20, temperature: 0 });
  }

  // ---- 系统提示词 ----
  var SYSTEM_EXPLAIN = '你是一位国际法考研辅导老师，擅长用通俗易懂的方式解析法律题目。' +
    '用户会给你一道题，请按以下格式回答：\n' +
    '1. 为什么正确答案对（引用法条/公约/教材要点，简洁）\n' +
    '2. 为什么用户的答案错（指出混淆点；没给答案则跳过）\n' +
    '3. 易混淆概念对比（如果有，用简短对比）\n' +
    '4. ★ 易错提醒：这道题最容易踩的1-2个坑\n' +
    '全文控制在350字以内，重点突出，适合手机阅读。';

  var SYSTEM_MNEMONIC = '你是一位擅长编记忆口诀的辅导老师。给定一道题和答案，请生成 1-2 条巧计：\n' +
    '- 谐音口诀（如"领海十二"谐音"领食一二"）\n' +
    '- 联想记忆（编一个小故事/场景串联关键信息）\n' +
    '- 对比速记（易混淆概念的简短对比，如"领海12/毗连24/专属200"）\n' +
    '控制在 100 字以内，朗朗上口，好记好用。';

  var SYSTEM_RELATED = '你是一位国际法辅导老师。给定一道题，请分析其核心考点关键词（2-4个词/短语），' +
    '用于在题库中搜索关联题。只返回关键词，用逗号分隔，不要解释。例如：领海宽度,海洋区域,12海里';

  var SYSTEM_TUTOR = '你是一位国际法考研辅导老师。用户正在刷题，可能会问你法律概念、法条内容或解题技巧。' +
    '回答要简洁准确（200字以内），适合手机阅读。如果用户的问题与某道具体题目相关，' +
    '请结合题目上下文回答。';

  // ---- 功能 1：AI 解析 ----
  function explain(q, userAnswer) {
    var stem = q.stem || q.term || '';
    var options = (q.options || []).map(function (o) { return o.key + '. ' + o.text; }).join('\n');
    var correct = Array.isArray(q.answer) ? q.answer.join('') : String(q.answer || '');
    var cacheId = 'exp3-' + q.id;
    var msgs = [
      { role: 'system', content: SYSTEM_EXPLAIN },
      { role: 'user', content: '题目：' + stem + '\n' + (options ? '选项：\n' + options + '\n' : '') +
        '正确答案：' + correct + '\n' +
        (userAnswer ? '我的答案：' + userAnswer + '\n' : '') +
        (q.explanation ? '原有解析：' + q.explanation : '') }
    ];
    return chatCached(cacheId, msgs, { temperature: 0.5, max_tokens: 800 });
  }

  // ---- 功能 2：AI 巧计 ----
  function mnemonic(q) {
    var stem = q.stem || q.term || '';
    var correct = Array.isArray(q.answer) ? q.answer.join('') : String(q.answer || '');
    var def = q.definition || '';
    var cacheId = 'mn-' + q.id;
    var msgs = [
      { role: 'system', content: SYSTEM_MNEMONIC },
      { role: 'user', content: '题目：' + stem + '\n正确答案：' + correct + '\n' + (def ? '答案内容：' + def : '') }
    ];
    return chatCached(cacheId, msgs, { temperature: 0.9, max_tokens: 300 });
  }

  // ---- 功能 3：关联题 ----
  function relatedKeywords(q) {
    var stem = q.stem || q.term || '';
    var cacheId = 'rel-' + q.id;
    var msgs = [
      { role: 'system', content: SYSTEM_RELATED },
      { role: 'user', content: stem }
    ];
    return chatCached(cacheId, msgs, { temperature: 0.3, max_tokens: 60 });
  }

  // 在本地题库中搜索关联题
  function searchRelated(q, allQuestions) {
    return relatedKeywords(q).then(function (keywords) {
      var kws = keywords.split(/[,，、\s]+/).filter(function (k) { return k.length >= 2; });
      if (!kws.length) return { keywords: [], items: [] };
      var scored = [];
      allQuestions.forEach(function (other) {
        if (other.id === q.id) return;   // 排除自己
        var text = (other.stem || '') + ' ' + (other.term || '') + ' ' +
          (other.options || []).map(function (o) { return o.text; }).join(' ');
        var score = 0;
        kws.forEach(function (kw) {
          if (text.indexOf(kw) >= 0) score++;
        });
        if (score > 0) scored.push({ q: other, score: score });
      });
      scored.sort(function (a, b) { return b.score - a.score; });
      return { keywords: kws, items: scored.slice(0, 5) };   // 最多 5 题
    });
  }

  // ---- 功能 4：AI 答疑 ----
  function tutor(userMsg, contextQ) {
    var msgs = [{ role: 'system', content: SYSTEM_TUTOR }];
    if (contextQ) {
      var stem = contextQ.stem || contextQ.term || '';
      var correct = Array.isArray(contextQ.answer) ? contextQ.answer.join('') : String(contextQ.answer || '');
      msgs.push({ role: 'user', content: '[当前正在做的题]\n题干：' + stem + '\n正确答案：' + correct + '\n\n我的问题：' + userMsg });
    } else {
      msgs.push({ role: 'user', content: userMsg });
    }
    return chat(msgs, { temperature: 0.5, max_tokens: 600 });
  }

  // ---- v43 功能 5：AI 判题（填空/大题自动评分） ----
  var SYSTEM_GRADE = '你是一位国际法考研阅卷老师。给定题目、标准答案和考生答案，请评分：' +
    '如果考生答案的核心要点覆盖了标准答案（表述可不同），判为"对"；' +
    '如果部分正确，判为"半对"并指出缺了什么；完全偏离则判为"错"。' +
    '格式：第一行只写"对"/"半对"/"错"（一字不差），第二行起用 2-3 句简要说明。' +
    '100 字以内。';

  function grade(q, userAnswer) {
    var stem = q.stem || q.term || '';
    var correct = q.definition || (Array.isArray(q.answer) ? q.answer.join('') : String(q.answer || ''));
    var cacheId = 'gr-' + q.id;
    var msgs = [
      { role: 'system', content: SYSTEM_GRADE },
      { role: 'user', content: '题干：' + stem + '\n标准答案：' + correct + '\n考生答案：' + userAnswer }
    ];
    return chatCached(cacheId, msgs, { temperature: 0.3, max_tokens: 300 });
  }

  return {
    getKey: getKey, setKey: setKey,
    getModel: getModel, setModel: setModel,
    getProxy: getProxy, setProxy: setProxy,
    hasKey: hasKey,
    testConnection: testConnection,
    explain: explain,
    mnemonic: mnemonic,
    relatedKeywords: relatedKeywords,
    searchRelated: searchRelated,
    tutor: tutor, grade: grade
  };
});

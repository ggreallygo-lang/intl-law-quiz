/* app.js — 卡片题库 主控制器 */
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const TYPE_LABEL = {
    single: '单选题', multiple: '多选题', judge: '判断题',
    term: '名词解释', fill: '填空题', essay: '简答题'
  };

  // pool = 当前练习范围内的题目（全库或按章节筛出的子集）
  const S = { bank: null, questions: [], pool: [], outline: [], selectedChapter: null, back: 'home', pendingMode: null, cleaned: null };

  // ---------- 兼容性兜底 ----------
  // padStart 是 ES2017，老安卓 WebView（Chrome < 57）没有；这里自带一份，不依赖原型方法
  function pad2(n) { n = String(n); return n.length >= 2 ? n : '0' + n; }

  // ---------- 全局错误兜底 ----------
  // 目标：任何未捕获异常都不许变成「白屏且无任何提示」。
  // 设计：顶部常驻横幅（不是 toast——toast 会自动消失，错误信息必须能看清、能关掉）。
  const ERR_SEEN = {};
  let errShown = 0;
  function reportErr(where, err) {
    try {
      const raw = (err && err.message) || (err && err.reason && err.reason.message) || String(err);
      const msg = String(raw).slice(0, 140);
      const key = where + '|' + msg;
      if (ERR_SEEN[key]) return;          // 同一错误只提示一次
      ERR_SEEN[key] = 1;
      if (++errShown > 3) return;         // 最多 3 条，防止连环报错刷屏
      const bar = $('#crashbar');
      if (!bar) return;
      const row = document.createElement('div');
      row.className = 'crash-row';
      const span = document.createElement('span');
      span.textContent = '⚠️ ' + where + '：' + msg;
      const x = document.createElement('button');
      x.className = 'crash-x'; x.type = 'button'; x.textContent = '✕';
      x.onclick = () => { row.parentNode && row.parentNode.removeChild(row); if (!bar.children.length) bar.classList.add('hidden'); };
      row.appendChild(span); row.appendChild(x);
      bar.appendChild(row);
      bar.classList.remove('hidden');
    } catch (e) { /* 兜底本身绝不能再抛，否则会掩盖原始错误 */ }
    try { console.error('[卡片题库]', where, err); } catch (e) {}
  }
  window.addEventListener('error', (e) => reportErr('运行出错', e.error || e.message));
  window.addEventListener('unhandledrejection', (e) => reportErr('操作未完成', e.reason));

  /** 包住 async 调用：统一兜住未捕获的 Promise 异常，避免静默失败 */
  function safe(promise, where) {
    return Promise.resolve(promise).catch(err => { reportErr(where, err); return null; });
  }

  // ---------- 工具 ----------
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function shuffle(a) {
    a = a.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }
  let toastTimer;
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
  }
  // 记录当前视图：离开「学习页」时要清理定时器，
  // 否则考试倒计时会在已经切走的页面上触发交卷，把结果渲染到错误的视图里
  let curView = null;
  function showView(name) {
    if (curView === 'study' && name !== 'study') cleanupStudy();
    curView = name;
    ['home', 'bank', 'study'].forEach(v => $('#view-' + v).classList.toggle('hidden', v !== name));
  }
  function cleanupStudy() {
    if (exam && exam.timer) { clearInterval(exam.timer); exam.timer = null; }
  }
  function setBack(target, label) {
    S.back = target;
    const b = $('#backBtn');
    b.classList.toggle('hidden', target === 'home');
    b.textContent = label || '‹ 返回';
  }

  // ---------- SM2 记忆曲线 ----------
  function sm2(p, q) {
    p = p || { ease: 2.5, interval: 0, reps: 0, due: 0, lapses: 0 };
    if (q < 3) { p.reps = 0; p.interval = 1; p.lapses = (p.lapses || 0) + 1; }
    else {
      if (p.reps === 0) p.interval = 1;
      else if (p.reps === 1) p.interval = 6;
      else p.interval = Math.round(p.interval * p.ease);
      p.reps++;
    }
    p.ease = Math.max(1.3, p.ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
    p.due = Date.now() + p.interval * 86400000;
    p.lastReviewed = Date.now();
    return p;
  }

  // ---------- 题库列表（首页） ----------
  async function renderHome() {
    const banks = await DB.listBanks();
    const list = $('#bankList');
    if (!banks.length) {
      list.innerHTML = '<div class="empty">还没有题库，导入一个 .md / .txt 开始吧 👆</div>';
      return;
    }
    list.innerHTML = '';
    for (const b of banks) {
      const div = document.createElement('div');
      div.className = 'bank-card';
      const date = new Date(b.updatedAt).toLocaleDateString();
      div.innerHTML =
        `<span class="del" data-del="${b.id}">删除</span>` +
        `<div class="name">${esc(b.name)}</div>` +
        `<div class="meta">${b.count || 0} 题 · 更新于 ${date}</div>`;
      div.addEventListener('click', (e) => {
        if (e.target.dataset.del) { e.stopPropagation(); confirmDelete(e.target.dataset.del, b.name); return; }
        openBank(b.id);
      });
      list.appendChild(div);
    }
  }

  async function confirmDelete(id, name) {
    if (!confirm(`确定删除题库「${name}」？此操作不可恢复。`)) return;
    await DB.deleteBank(id); toast('已删除'); renderHome();
  }

  // ---------- 题库详情（统计 + 目录 + 题目列表） ----------
  async function openBank(id) {
    const bank = await DB.getBank(id);
    S.bank = bank;
    S.questions = await DB.listQuestions(id);
    S.pool = S.questions.slice();
    S.outline = await DB.getOutline(id);
    S.selectedChapter = null;
    S.pendingMode = null;
    $('#title').textContent = bank.name;
    setBack('home');
    renderBankSwitch(bank.id);
    $('#rangeBar').classList.add('hidden');
    await renderBankStats();
    renderOutlineTree();
    renderQuestionList('');
    // 模式卡片 -> 先选范围
    document.querySelectorAll('#view-bank .mode-card').forEach(c => {
      c.onclick = () => openRangePicker(c.dataset.mode);
    });
    $('#bankTools').innerHTML =
      `<button class="btn secondary" id="exportBtn">⬇️ 导出此题库为 .md</button>`;
    $('#exportBtn').onclick = () => exportBank(bank, S.questions);
    showView('bank');
  }

  // v9：详情页顶部的题库切换条——别的题库一点就换，不用返回首页
  async function renderBankSwitch(curId) {
    const banks = await DB.listBanks();
    const box = $('#bankSwitch');
    if (!banks || banks.length < 2) { box.innerHTML = ''; return; }
    box.innerHTML = banks.map(b =>
      `<button class="bs-chip${b.id === curId ? ' on' : ''}" data-id="${esc(b.id)}">${esc(b.name)}</button>`
    ).join('');
    box.querySelectorAll('.bs-chip').forEach(c => {
      c.onclick = () => { if (c.dataset.id !== curId) openBank(c.dataset.id); };
    });
  }

  // 掌握度：练过的题里，答对比答错多、或 SM2 间隔已到 6 天以上算「已掌握」
  async function computeMastery(bankId, total) {
    let progs = [];
    try { progs = await DB.listProgress(bankId); } catch (e) { progs = []; }
    let practiced = 0, mastered = 0;
    progs.forEach(p => {
      const c = (p.practice && p.practice.correct) || 0;
      const w = (p.practice && p.practice.wrong) || 0;
      const ec = (p.exam && p.exam.correct) || 0;
      const ew = (p.exam && p.exam.wrong) || 0;
      if (c + w + ec + ew > 0 || p.lastReviewed) practiced++;
      const ok = ((c + ec) > 0 && (c + ec) > (w + ew)) || ((p.interval || 0) >= 6);
      if (ok) mastered++;
    });
    return { practiced: practiced, mastered: mastered, pct: total ? Math.min(100, Math.round(mastered / total * 100)) : 0 };
  }

  async function renderBankStats() {
    const cnt = {};
    S.questions.forEach(q => cnt[q.type] = (cnt[q.type] || 0) + 1);
    const parts = Object.keys(cnt).map(k => `${TYPE_LABEL[k] || k} ${cnt[k]}`);
    const m = await computeMastery(S.bank.id, S.questions.length);
    $('#bankStats').innerHTML =
      `<div class="sum-main"><b>${S.questions.length}</b> 题 · ${esc(parts.join(' / ') || '—')}</div>` +
      `<div class="sum-sub">已练 ${m.practiced} 题 · 掌握 ${m.mastered} 题 · 掌握度 ${m.pct}%</div>` +
      `<div class="master-bar"><span style="width:${m.pct}%"></span></div>`;
  }

  // 目录树：第 3 层及以下默认收起，点箭头折叠，点标题筛选
  function outlineHtml(nodes, depth) {
    return (nodes || []).map(n => {
      const hasKids = !!(n.children && n.children.length);
      const collapsed = depth >= 2 ? ' collapsed' : '';
      return `<div class="ol-node${collapsed}">` +
        `<div class="ol-row" data-id="${esc(n.id)}" style="padding-left:${depth * 14}px">` +
        `<span class="ol-toggle">${hasKids ? '▸' : ''}</span>` +
        `<span class="ol-title">${esc(n.title)}</span>` +
        `<span class="ol-count">${n.total || 0} 题</span>` +
        `</div>` +
        (hasKids ? `<div class="ol-children">${outlineHtml(n.children, depth + 1)}</div>` : '') +
        `</div>`;
    }).join('');
  }

  function renderOutlineTree() {
    const box = $('#outlineTree');
    if (!S.outline || !S.outline.length) {
      box.innerHTML = '<div class="empty">这份笔记没有标题层级，题目已归入「未分组」</div>';
      $('#outlineHint').textContent = '';
      return;
    }
    box.innerHTML = outlineHtml(S.outline, 0);
    box.querySelectorAll('.ol-row').forEach(row => {
      const node = row.parentElement;
      row.querySelector('.ol-toggle').onclick = (e) => {
        e.stopPropagation();
        node.classList.toggle('collapsed');
      };
      row.onclick = () => {
        const id = row.dataset.id;
        S.selectedChapter = (S.selectedChapter === id) ? null : id;
        box.querySelectorAll('.ol-row').forEach(r => r.classList.toggle('sel', r.dataset.id === S.selectedChapter));
        $('#outlineHint').textContent = S.selectedChapter ? '再点一次取消筛选' : '';
        renderQuestionList($('#qSearch').value);
      };
    });
    $('#outlineHint').textContent = '';
  }

  function haystack(q) {
    const parts = [q.stem, q.term, q.definition, q.explanation];
    (q.options || []).forEach(o => parts.push(o.key + '. ' + o.text));
    if (Array.isArray(q.answer)) parts.push(q.answer.join(''));
    else if (typeof q.answer === 'boolean') parts.push(q.answer ? '对' : '错');
    else if (q.answer != null) parts.push(String(q.answer));   // OCR 抽出的字符串答案也要能搜到
    return parts.filter(Boolean).join(' ');
  }

  // 委托给 scoring.js：q.answer 可能是数组 / 字符串 / undefined，不能直接用 .map
  function answerText(q) { return Scoring.answerText(q); }

  function questionCardHtml(q) {
    const path = (q.chapterPath && q.chapterPath.length) ? q.chapterPath.join(' › ') : (q.chapter || '未分组');
    let body = '';
    if (q.type === 'term') {
      body = `<div class="qcard-stem"><b>${esc(q.term)}</b></div>`;
    } else {
      body = `<div class="qcard-stem">${esc(q.stem)}</div>`;
      body += q.type === 'judge'
        ? `<div class="qcard-opts"><span>对</span><span>错</span></div>`
        : `<div class="qcard-opts">${(q.options || []).map(o => `<span>${o.key}. ${esc(o.text)}</span>`).join('')}</div>`;
    }
    return `<div class="qcard">` +
      `<div class="qcard-top"><span class="qtag">${TYPE_LABEL[q.type] || q.type}</span><span class="qcard-path">${esc(path)}</span></div>` +
      body +
      `<button class="qcard-reveal">显示答案</button>` +
      `<div class="qcard-answer hidden">` +
      `<div class="qcard-ans">答案：${esc(answerText(q))}</div>` +
      (q.explanation ? `<div class="qcard-exp">解析：${esc(q.explanation)}</div>` : '') +
      `</div></div>`;
  }

  function renderQuestionList(kw) {
    const box = $('#questionList');
    let list = S.questions;
    if (S.selectedChapter) {
      const paths = DB.expandChapterPaths(S.outline, [S.selectedChapter]);
      list = list.filter(q => paths.has(DB.chapterKey(q)));
    }
    const k = (kw || '').trim().toLowerCase();
    if (k) list = list.filter(q => haystack(q).toLowerCase().indexOf(k) >= 0);

    const filtered = list.length !== S.questions.length;
    $('#qlistHint').textContent = filtered ? `筛出 ${list.length} 题` : `共 ${list.length} 题`;
    if (!list.length) { box.innerHTML = '<div class="empty">没有匹配的题目</div>'; return; }
    box.innerHTML = list.map(questionCardHtml).join('');
    box.querySelectorAll('.qcard-reveal').forEach(b => {
      b.onclick = () => {
        const card = b.closest('.qcard');
        const ans = card.querySelector('.qcard-answer');
        ans.classList.toggle('hidden');
        b.textContent = ans.classList.contains('hidden') ? '显示答案' : '收起答案';
      };
    });
  }

  function exportBank(bank, qs) {
    let md = `# ${bank.name}\n\n`;
    const byChapter = {};
    qs.forEach(q => { (byChapter[q.chapter] = byChapter[q.chapter] || []).push(q); });
    Object.keys(byChapter).forEach(ch => {
      md += `## ${ch}\n\n`;
      byChapter[ch].forEach((q, i) => {
        if (q.type === 'term') {
          md += `${i + 1}. ${q.term}：${q.definition}\n`;
        } else if (q.type === 'judge') {
          md += `${i + 1}. ${q.stem}\n答案：${q.answer ? '对' : '错'}\n`;
        } else if (q.type === 'fill') {
          // 导出时把挖空占位符换回答案，保证导出的 md 再导入还能识别
          md += `${i + 1}. ${q.stem.replace('（　　）', '(' + q.answer + ')')}\n`;
        } else if (q.type === 'essay') {
          md += `${i + 1}. ${q.stem}\n答：${q.answer}\n`;
        } else {
          md += `${i + 1}. ${q.stem}\n`;
          (q.options || []).forEach(o => md += `${o.key}. ${o.text}\n`);
          // 用 answerKeys：answer 是字符串 / undefined 时 .join 会崩，导出直接中断
          md += `答案：${Scoring.answerKeys(q).join('') || (q.answer == null ? '' : String(q.answer))}\n`;
        }
        if (q.explanation) md += `解析：${q.explanation}\n`;
        md += '\n';
      });
    });
    const blob = new Blob([md], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = bank.name + '.md';
    a.click();
    toast('已导出');
  }

  // ---------- 背题模式 ----------
  let mem = null;
  async function startMemorize() {
    const progs = await DB.listProgress(S.bank.id);
    const map = {}; progs.forEach(p => map[p.qid] = p);
    const now = Date.now();
    let due = S.pool.filter(q => !map[q.id] || map[q.id].due <= now);
    if (!due.length) due = S.pool.slice(); // 全部复习完 -> 全部过一遍
    mem = { list: shuffle(due), i: 0, map };
    setBack('bank', '‹ 题库');
    $('#title').textContent = '背题';
    renderMemorize();
  }
  function renderMemorize() {
    const view = $('#view-study'); showView('study');
    if (mem.i >= mem.list.length) {
      view.innerHTML = `<div class="empty"><div style="font-size:40px">🎉</div>本轮背完啦！<br><span class="muted">按记忆曲线，该复习的都过了一遍</span></div>
        <button class="btn" onclick="location.reload()">返回</button>`;
      return;
    }
    const q = mem.list[mem.i];
    const total = mem.list.length;
    let front = '', back = '';
    if (q.type === 'term') {
      front = `<div class="tag">名词解释</div><div class="stem">${esc(q.term)}</div>`;
      back = `<div class="def">${esc(q.definition) || '<span class="muted">（无定义）</span>'}</div>`;
    } else if (q.type === 'judge') {
      front = `<div class="tag">判断题</div><div class="stem">${esc(q.stem)}</div>`;
      back = `<div class="def">答案：${q.answer ? '✓ 对' : '✗ 错'}</div>`;
    } else {
      front = `<div class="tag">${TYPE_LABEL[q.type]}</div><div class="stem">${esc(q.stem)}</div>` +
        (q.options || []).map(o => `<div class="opt">${esc(o.key)}. ${esc(o.text)}</div>`).join('');
      // 走 scoring：answer 是字符串 / undefined 时 .map 会直接崩掉整个背题页
      back = `<div class="def">答案：${esc(Scoring.answerText(q))}</div>`;
    }
    if (q.explanation) back += `<div class="exp">解析：${esc(q.explanation)}</div>`;
    view.innerHTML =
      `<div class="progress-top"><span>${mem.i + 1}/${total}</span><div class="progress-bar"><span style="width:${(mem.i / total) * 100}%"></span></div></div>` +
      `<div class="card-flip" id="card">${front}</div>` +
      `<div class="flip-hint" id="flipHint">点击卡片或下方按钮翻面看答案</div>` +
      `<button class="btn" id="flipBtn" style="margin-top:14px">显示答案</button>` +
      `<div id="rateArea" class="hidden">` +
      `<div class="rate-row">` +
      `<button class="btn rate-forget" data-q="1">😵 忘记</button>` +
      `<button class="btn rate-dim" data-q="3">🤔 模糊</button>` +
      `<button class="btn rate-know" data-q="5">😎 记住</button>` +
      `</div></div>`;
    const flip = () => {
      $('#card').innerHTML = front + back;
      $('#flipBtn').classList.add('hidden');
      $('#flipHint').classList.add('hidden');
      $('#rateArea').classList.remove('hidden');
    };
    $('#flipBtn').onclick = flip;
    $('#card').onclick = flip;
    $('#rateArea').querySelectorAll('button').forEach(b => {
      b.onclick = async () => {
        let p = mem.map[q.id] || { qid: q.id, bankId: S.bank.id, ease: 2.5, interval: 0, reps: 0, due: 0, lapses: 0 };
        p = sm2(p, +b.dataset.q);
        mem.map[q.id] = p;
        await DB.saveProgress(p);
        mem.i++; renderMemorize();
      };
    });
  }

  // ---------- 刷题模式 ----------
  let prac = null;
  async function startPractice() {
    prac = { list: shuffle(S.pool), i: 0, wrong: [], correct: 0, wrongIds: [] };
    setBack('bank', '‹ 题库');
    $('#title').textContent = '刷题';
    renderPractice();
  }
  function renderPractice() {
    const view = $('#view-study'); showView('study');
    if (prac.i >= prac.list.length) return renderPracticeResult();
    const q = prac.list[prac.i];
    const total = prac.list.length;
    let body = '';
    // 自评题：名词解释 / 简答 / 答案过长的填空 —— 看答案后自己判断会/不会
    if (Scoring.isSelfAssess(q)) {
      const label = q.type === 'fill' ? '填空题（答案较长，自评）' : TYPE_LABEL[q.type];
      const front = (q.type === 'term') ? q.term : q.stem;
      body = `<div class="tag" style="display:inline-block;font-size:12px;padding:3px 10px;border-radius:999px;background:var(--primary);color:#fff;margin-bottom:12px">${esc(label)}</div>
        <div class="q-stem">${esc(front)}</div>
        <button class="btn" id="revealTerm">显示答案</button>
        <div id="termBack" class="hidden" style="margin-top:14px">
          <div class="feedback ok" style="white-space:pre-wrap">${esc(Scoring.answerText(q))}</div>
          <div class="btn-row" style="margin-top:14px">
            <button class="btn rate-know" id="tRight">答对了</button>
            <button class="btn rate-forget" id="tWrong">没答对</button>
          </div>
        </div>`;
    } else if (q.type === 'fill') {
      body = `<div class="q-stem"><span class="qnum">填空题 ${prac.i + 1}/${total}</span>${esc(q.stem)}</div>
        <input type="text" id="fillInput" class="fill-input" placeholder="输入答案，回车或点「确定」提交" autocomplete="off" />
        <button class="btn" id="fillSubmit">确定</button>`;
    } else if (q.type === 'judge') {
      body = `<div class="q-stem"><span class="qnum">判断题 ${prac.i + 1}/${total}</span>${esc(q.stem)}</div>
        <div class="option" data-v="1"><span class="key">✓</span> 对</div>
        <div class="option" data-v="0"><span class="key">✗</span> 错</div>`;
    } else {
      const opts = shuffle(q.options);
      body = `<div class="q-stem"><span class="qnum">${TYPE_LABEL[q.type]} ${prac.i + 1}/${total}</span>${esc(q.stem)}</div>` +
        opts.map(o => `<div class="option" data-k="${o.key}"><span class="key">${o.key}</span> ${esc(o.text)}</div>`).join('');
    }
    view.innerHTML =
      `<div class="progress-top"><span>${prac.i + 1}/${total}</span><div class="progress-bar"><span style="width:${(prac.i / total) * 100}%"></span></div></div>` +
      body + `<div id="pracFeedback"></div><div id="nextWrap" class="hidden"><button class="btn" id="nextBtn">下一题 ›</button></div>`;

    // 自评题（名词解释 / 简答 / 长答案填空）
    if (Scoring.isSelfAssess(q)) {
      $('#revealTerm').onclick = () => {
        $('#termBack').classList.remove('hidden'); $('#revealTerm').classList.add('hidden');
        $('#tRight').onclick = () => finishPractice(q, true);
        $('#tWrong').onclick = () => finishPractice(q, false);
      };
      return;
    }
    // 填空题：输入作答
    if (q.type === 'fill') {
      const submit = () => {
        const inp = $('#fillInput');
        const v = (inp.value || '').trim();
        if (!v) { toast('请先输入答案'); return; }
        inp.disabled = true;
        const btn = $('#fillSubmit'); if (btn) btn.disabled = true;
        // 判分走 scoring：归一化后比较，忽略空格/标点/全角半角
        const right = Scoring.isRight(q, v);
        inp.classList.add(right ? 'fill-right' : 'fill-wrong');
        finishPractice(q, right);
      };
      $('#fillSubmit').onclick = submit;
      $('#fillInput').onkeydown = (e) => { if (e.key === 'Enter') submit(); };
      $('#fillInput').focus();
      return;
    }
    const opts = view.querySelectorAll('.option');
    opts.forEach(op => {
      op.onclick = () => {
        if (op.classList.contains('locked')) return;
        opts.forEach(o => o.classList.add('locked'));
        const picked = (q.type === 'judge') ? op.dataset.v : op.dataset.k;
        // 统一走 scoring.js：answer 可能是数组/字符串/undefined，直接 .includes 会静默误判
        const right = Scoring.isRight(q, picked);
        op.classList.add('chosen');
        if (q.type === 'judge') {
          const want = q.answer ? '1' : '0';
          opts.forEach(o => { if (o.dataset.v === want) o.classList.add('correct'); });
        } else {
          const keys = Scoring.answerKeys(q);
          opts.forEach(o => { if (keys.indexOf(String(o.dataset.k).toUpperCase()) >= 0) o.classList.add('correct'); });
        }
        if (!right) op.classList.add('wrong');
        finishPractice(q, right);
      };
    });
  }
  async function finishPractice(q, right) {
    const fb = $('#pracFeedback');
    let html = right
      ? `<div class="feedback ok">✓ 答对${q.explanation ? `<span class="sub">解析：${esc(q.explanation)}</span>` : ''}</div>`
      : `<div class="feedback bad">✗ 答错，正确答案：${esc(Scoring.answerText(q))}${q.explanation ? `<span class="sub">解析：${esc(q.explanation)}</span>` : ''}</div>`;
    if (!Scoring.hasAnswer(q)) {
      html += `<div class="muted" style="margin-top:6px;font-size:13px">⚠️ 这道题没识别到答案，已按「答错」计，建议导出后手工补上</div>`;
    }
    fb.innerHTML = html;
    if (right) prac.correct++; else prac.wrongIds.push(q.id);

    // 先让用户可以继续，再写库 —— 存储失败绝不能把人卡死在这一题
    $('#nextWrap').classList.remove('hidden');
    $('#nextBtn').onclick = () => { prac.i++; renderPractice(); };

    await safe((async () => {
      let p = await DB.getProgress(q.id) || { qid: q.id, bankId: S.bank.id, ease: 2.5, interval: 0, reps: 0, due: 0, lapses: 0 };
      p.practice = p.practice || { correct: 0, wrong: 0 };
      if (right) p.practice.correct++; else p.practice.wrong++;
      if (!right) p.lapses = (p.lapses || 0) + 1;
      p.due = Date.now(); // 刷题后立即可在背题里复习
      await DB.saveProgress(p);
    })(), '保存进度失败');
  }
  function renderPracticeResult() {
    const total = prac.list.length;
    const acc = total ? Math.round(prac.correct / total * 100) : 0;
    const view = $('#view-study');
    view.innerHTML =
      `<div class="result-score">${acc}%</div><div class="result-sub">答对 ${prac.correct} / ${total}</div>` +
      (prac.wrongIds.length
        ? `<button class="btn" id="reviewWrong">🔁 复习错题（${prac.wrongIds.length}）</button>
           <div style="height:10px"></div>`
        : `<div class="empty">全部答对，稳！</div>`) +
      `<button class="btn secondary" id="redoPrac">再做一遍</button><div style="height:10px"></div>
       <button class="btn ghost" id="backBank">返回题库</button>`;
    if (prac.wrongIds.length) $('#reviewWrong').onclick = async () => {
      const map = {}; S.questions.forEach(q => map[q.id] = q);
      prac = { list: shuffle(prac.wrongIds.map(id => map[id]).filter(Boolean)), i: 0, wrong: [], correct: 0, wrongIds: [] };
      renderPractice();
    };
    $('#redoPrac').onclick = () => startPractice();
    $('#backBank').onclick = () => openBank(S.bank.id);
  }

  // ---------- 考试模式 ----------
  let exam = null;
  async function startExamSetup() {
    setBack('bank', '‹ 题库');
    $('#title').textContent = '考试设置';
    // 可自动判分的题：客观题 + 填空。
    // 答案过长的填空已降级为自评（scoring.isSelfAssess），不进考试。
    const gradable = S.pool.filter(q => {
      if (q.type === 'single' || q.type === 'multiple' || q.type === 'judge') return true;
      return q.type === 'fill' && !Scoring.isSelfAssess(q);
    });
    const view = $('#view-study'); showView('study');
    if (!gradable.length) { toast('本题库没有可计分的客观题'); openBank(S.bank.id); return; }
    const settings = { n: 'all', min: 0, shuffleOpt: true };
    view.innerHTML =
      `<h3 style="margin-top:0">⏱️ 考试设置</h3>
      <div class="field"><label>题量</label><div class="seg" id="segN">
        <button data-v="all" class="on">全部(${gradable.length})</button>
        <button data-v="20">随机20</button><button data-v="50">随机50</button><button data-v="100">随机100</button>
      </div></div>
      <div class="field"><label>时长（分钟，0 = 不限时）</label>
        <input type="number" id="examMin" min="0" step="1" value="0" /></div>
      <div class="field"><label>选项乱序</label><div class="seg" id="segOpt">
        <button data-v="1" class="on">开</button><button data-v="0">关</button></div></div>
      <button class="btn" id="startExam">开始考试 ›</button>`;
    $('#segN').querySelectorAll('button').forEach(b => b.onclick = () => {
      $('#segN').querySelectorAll('button').forEach(x => x.classList.remove('on')); b.classList.add('on'); settings.n = b.dataset.v;
    });
    $('#segOpt').querySelectorAll('button').forEach(b => b.onclick = () => {
      $('#segOpt').querySelectorAll('button').forEach(x => x.classList.remove('on')); b.classList.add('on'); settings.shuffleOpt = b.dataset.v === '1';
    });
    $('#startExam').onclick = () => {
      let list = gradable;
      if (settings.n !== 'all') { const k = Math.min(+settings.n, list.length); list = shuffle(list).slice(0, k); }
      exam = { list, i: 0, min: Math.max(0, +$('#examMin').value || 0), shuffleOpt: settings.shuffleOpt, answers: {}, endAt: 0, timer: null };
      if (exam.min > 0) exam.endAt = Date.now() + exam.min * 60000;
      setBack('bank', '‹ 题库'); $('#title').textContent = '考试中';
      renderExam();
    };
  }
  function renderExam() {
    const view = $('#view-study'); showView('study');
    if (exam.i >= exam.list.length) return submitExam();
    const q = exam.list[exam.i];
    const total = exam.list.length;
    let timerHtml = '';
    if (exam.min > 0) {
      const left = Math.max(0, exam.endAt - Date.now());
      const mm = pad2(Math.floor(left / 60000));
      const ss = pad2(Math.floor((left % 60000) / 1000));
      timerHtml = `<span id="timer">⏱ ${mm}:${ss}</span>`;
      if (!exam.timer) exam.timer = setInterval(() => {
        const l = Math.max(0, exam.endAt - Date.now());
        const e = $('#timer'); if (e) e.textContent = `⏱ ${pad2(Math.floor(l / 60000))}:${pad2(Math.floor((l % 60000) / 1000))}`;
        if (l <= 0) { clearInterval(exam.timer); exam.timer = null; submitExam(); }
      }, 1000);
    }
    let body = '';
    if (q.type === 'judge') {
      body = `<div class="q-stem"><span class="qnum">${timerHtml}判断题 ${exam.i + 1}/${total}</span>${esc(q.stem)}</div>
        <div class="option" data-v="1"><span class="key">✓</span> 对</div>
        <div class="option" data-v="0"><span class="key">✗</span> 错</div>`;
    } else if (q.type === 'fill') {
      const saved = exam.answers[q.id] ? exam.answers[q.id].value : '';
      body = `<div class="q-stem"><span class="qnum">${timerHtml}填空题 ${exam.i + 1}/${total}</span>${esc(q.stem)}</div>
        <input type="text" id="fillInput" class="fill-input" value="${esc(saved)}" placeholder="输入答案（回车跳下一题）" autocomplete="off" />`;
    } else {
      const opts = exam.shuffleOpt ? shuffle(q.options) : q.options;
      body = `<div class="q-stem"><span class="qnum">${timerHtml}${TYPE_LABEL[q.type]} ${exam.i + 1}/${total}</span>${esc(q.stem)}</div>` +
        opts.map(o => `<div class="option" data-k="${o.key}"><span class="key">${o.key}</span> ${esc(o.text)}</div>`).join('');
    }
    view.innerHTML =
      `<div class="progress-top"><span>${exam.i + 1}/${total}</span><div class="progress-bar"><span style="width:${(exam.i / total) * 100}%"></span></div></div>` +
      body + `<div id="examNav" class="btn-row" style="margin-top:14px">
        <button class="btn secondary" id="prevBtn">上一题</button>
        <button class="btn" id="nextExamBtn">${exam.i + 1 >= total ? '交卷' : '下一题 ›'}</button>
      </div>`;
    const opts = view.querySelectorAll('.option');
    opts.forEach(op => {
      op.onclick = () => {
        opts.forEach(o => o.classList.remove('chosen')); op.classList.add('chosen');
        const v = q.type === 'judge' ? +op.dataset.v : op.dataset.k;
        exam.answers[q.id] = { q, value: q.type === 'multiple' ? (exam.answers[q.id] ? toggle(exam.answers[q.id].value, v) : [v]) : v, type: q.type };
        if (q.type === 'multiple') renderExamMulti(q);
      };
    });
    // 填空题：边打字边存，切题/交卷都不丢
    if (q.type === 'fill') {
      const inp = $('#fillInput');
      const save = () => { exam.answers[q.id] = { q: q, value: (inp.value || '').trim(), type: 'fill' }; };
      inp.oninput = save;
      inp.onchange = save;
      inp.onkeydown = (e) => { if (e.key === 'Enter') { save(); const n = $('#nextExamBtn'); if (n) n.click(); } };
    }
    $('#prevBtn').onclick = () => { if (exam.i > 0) { exam.i--; renderExam(); } };
    $('#nextExamBtn').onclick = () => {
      if (exam.i + 1 >= total) { if (confirm('确定交卷？')) submitExam(); }
      else { exam.i++; renderExam(); }
    };
  }
  function toggle(arr, v) { return arr.includes(v) ? arr.filter(x => x !== v) : arr.concat(v); }
  function renderExamMulti(q) {
    // 多选题：重渲染选项选中态
    const view = $('#view-study');
    const a = exam && exam.answers ? exam.answers[q.id] : null;
    const picked = a ? [].concat(a.value) : [];
    view.querySelectorAll('.option').forEach(op => {
      if (picked.indexOf(op.dataset.k) >= 0) op.classList.add('chosen'); else op.classList.remove('chosen');
    });
  }
  async function submitExam() {
    if (!exam) return;                     // 已经离开考试页（定时器晚到一步）时直接忽略
    if (exam.timer) { clearInterval(exam.timer); exam.timer = null; }
    let correct = 0; const wrongList = [];
    const byChapter = {};
    const updates = [];                 // 待写进度，稍后一次性批量提交
    exam.list.forEach(q => {
      const a = exam.answers[q.id];
      const ok = a ? Scoring.isRight(q, a.value) : false;
      const c = byChapter[q.chapter] = byChapter[q.chapter] || { total: 0, correct: 0 };
      c.total++; if (ok) { correct++; c.correct++; }
      if (!ok) wrongList.push({ q, user: a });
      updates.push({ qid: q.id, ok: ok });
    });
    const total = exam.list.length;
    const score = total ? Math.round(correct / total * 100) : 0;
    const view = $('#view-study');
    let chapterHtml = '';
    Object.keys(byChapter).forEach(ch => {
      const c = byChapter[ch]; const pct = c.total ? Math.round(c.correct / c.total * 100) : 0;
      chapterHtml += `<div class="chapter-stat"><div>${esc(ch)} — 正确率 ${pct}%（${c.correct}/${c.total}）</div>
        <div class="bar"><span style="width:${pct}%"></span></div></div>`;
    });
    let wrongHtml = '';
    const noAns = [];
    wrongList.forEach(w => {
      if (!Scoring.hasAnswer(w.q)) noAns.push(w.q);
      wrongHtml += `<div class="wrong-item"><div>${esc(w.q.stem || w.q.term)}</div>
        <div class="a">正确答案：${esc(Scoring.answerText(w.q))}</div>
        ${w.q.explanation ? `<div class="muted" style="font-size:13px;margin-top:4px">解析：${esc(w.q.explanation)}</div>` : ''}</div>`;
    });
    view.innerHTML =
      `<div class="result-score">${score}</div><div class="result-sub">得分 ${correct} / ${total}</div>` +
      (noAns.length ? `<div class="muted" style="text-align:center;margin:10px 0;font-size:13px">⚠️ 有 ${noAns.length} 道题没识别到答案，已按答错计</div>` : '') +
      (chapterHtml ? `<h3 style="font-size:15px">章节正确率</h3>${chapterHtml}` : '') +
      (wrongList.length ? `<h3 style="font-size:15px;margin-top:18px">错题回顾（${wrongList.length}）</h3>${wrongHtml}` : '<div class="empty">满分，牛！</div>') +
      `<div style="height:10px"></div><button class="btn secondary" id="backBank2">返回题库</button>`;
    $('#backBank2').onclick = () => openBank(S.bank.id);

    // 结果已经渲染出来了再写库，存储失败不会挡住看成绩；失败只提示
    await safe(DB.bulkUpdateProgress(S.bank.id, updates, 'exam'), '保存成绩失败');
  }

  // ---------- 练习范围选择 ----------
  function buildChapterPicker() {
    const box = $('#chapterPicker');
    const rows = [];
    (function walk(nodes, depth) {
      (nodes || []).forEach(n => {
        if (n.level === 1) { walk(n.children, depth); return; }   // h1 是题库名，不作为可选章节
        rows.push(
          `<label class="ck-row" style="padding-left:${depth * 14}px">` +
          `<input type="checkbox" value="${esc(n.id)}" />` +
          `<span>${esc(n.title)}</span><span class="muted">${n.total || 0} 题</span></label>`
        );
        walk(n.children, depth + 1);
      });
    })(S.outline, 0);
    box.innerHTML = rows.length ? rows.join('') : '<div class="muted">没有可分的章节</div>';
    box.querySelectorAll('input').forEach(i => { i.onchange = updateRangeHint; });
  }

  function selectedChapterIds() {
    return Array.prototype.map.call($('#chapterPicker').querySelectorAll('input:checked'), i => i.value);
  }

  function updateRangeHint() {
    const on = $('#rangeSeg').querySelector('button.on');
    const v = on ? on.dataset.v : 'all';
    if (v === 'all') { $('#rangeHint').textContent = `${S.questions.length} 题`; return; }
    const ids = selectedChapterIds();
    if (!ids.length) { $('#rangeHint').textContent = '未选章节'; return; }
    const paths = DB.expandChapterPaths(S.outline, ids);
    const n = S.questions.filter(q => paths.has(DB.chapterKey(q))).length;
    $('#rangeHint').textContent = `${n} 题`;
  }

  function openRangePicker(mode) {
    S.pendingMode = mode;
    const bar = $('#rangeBar');
    bar.classList.remove('hidden');
    $('#rangeSeg').querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.v === 'all'));
    $('#chapterPicker').classList.add('hidden');
    buildChapterPicker();
    updateRangeHint();
    $('#rangeStart').onclick = () => {
      const on = $('#rangeSeg').querySelector('button.on');
      const v = on ? on.dataset.v : 'all';
      let list = S.questions.slice();
      if (v === 'chapter') {
        const ids = selectedChapterIds();
        if (!ids.length) { toast('至少勾选一个章节'); return; }
        const paths = DB.expandChapterPaths(S.outline, ids);
        list = S.questions.filter(q => paths.has(DB.chapterKey(q)));
        if (!list.length) { toast('这些章节下还没有题目'); return; }
      }
      bar.classList.add('hidden');
      startMode(S.pendingMode, list);
    };
    bar.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // ---------- 模式入口 ----------
  function startMode(mode, list) {
    S.pool = (list && list.length) ? list : S.questions.slice();
    if (mode === 'memorize') startMemorize();
    else if (mode === 'practice') startPractice();
    else if (mode === 'exam') startExamSetup();
  }

  // ---------- 导入 ----------
  // 水印清洗统计：导入前重置，saveParsed 累加，提示语里回显
  function resetCleaned() { S.cleaned = { removedLines: 0, strippedLines: 0 }; }
  function accCleaned(c) {
    if (!c || !S.cleaned) return;
    S.cleaned.removedLines += c.removedLines || 0;
    S.cleaned.strippedLines += c.strippedLines || 0;
  }
  function cleanedHint() {
    const c = S.cleaned;
    if (!c) return '';
    const n = c.removedLines + c.strippedLines;
    return n ? `，自动清洗水印 ${n} 处` : '';
  }

  // 把解析结果落库（文件导入 / 粘贴导入共用）
  async function saveParsed(text, fallbackName) {
    if (!text || !text.trim()) return 0;
    const parsed = QuizParser.parseDocument(text);
    accCleaned(parsed.cleaned);
    if (!parsed.questions.length) return 0;
    const name = parsed.name && parsed.name !== '未命名题库' ? parsed.name
      : (fallbackName || '未命名题库').replace(/\.(md|markdown|txt|text)$/i, '');
    // outline 一并入库，目录结构才不会丢（旧数据读时会自动从题目反推）
    const bank = await DB.saveBank(name, parsed.outline);
    try {
      await DB.addQuestions(bank.id, parsed.questions);
    } catch (e) {
      // 题目没写进去就得把刚建的题库删掉，否则会留下一个 0 题的空壳
      await DB.deleteBank(bank.id).catch(() => {});
      if (DB.isQuotaError(e)) {
        reportErr('存储空间不足', new Error('手机存储已满，请先清理空间或删掉不用的题库，再重新导入'));
      } else {
        reportErr('导入失败', e);
      }
      return 0;
    }
    return parsed.questions.length;
  }

  async function handleFiles(files) {
    let imported = 0, total = 0;
    const errBefore = errShown;
    resetCleaned();
    for (const f of files) {
      // 单个文件失败（读不了 / 编码问题）不中断其余文件
      const n = await safe(f.text().then(t => saveParsed(t, f.name)), '读取文件失败') || 0;
      if (n) { imported++; total += n; }
    }
    if (imported) { toast(`已导入 ${imported} 个题库，共 ${total} 题${cleanedHint()}`); safe(renderHome(), '刷新列表失败'); }
    else if (errShown === errBefore) toast('没有可导入的内容');   // 已经报过错就别再重复提示
  }

  // 粘贴文本导入（OCR「图片转 markdown」产物的主入口：PC 导出 .md → 手机粘贴）
  async function handlePaste() {
    const ta = $('#pasteText');
    const text = ta.value;
    const name = $('#pasteName').value.trim();
    if (!text.trim()) { toast('先粘贴内容再导入'); return; }
    resetCleaned();
    const errBefore = errShown;
    const n = await safe(saveParsed(text, name || '粘贴导入的题库'), '导入失败') || 0;
    if (n) {
      toast(`已导入 ${n} 题${cleanedHint()}`);
      ta.value = ''; $('#pasteName').value = '';
      // 切回文件视图，让题库列表可见
      $('#importSeg').querySelector('[data-v="file"]').click();
      safe(renderHome(), '刷新列表失败');
    } else if (errShown === errBefore) {
      toast('没解析出任何题目，检查格式见 README');
    }
  }

  // ---------- v8：切片导出供 AI 修正（规范 v1 第五/六节） ----------
  const SLICE_PROMPT = [
    '你是题库格式化工具。把下面原始文本转换为《题库导入排版规范 v1》格式，规则：',
    '1. 结构：# 题库名 / ## 分区标题（单项选择题、多项选择题、简答题等）/ 题目块。',
    '2. 题号：保留原卷连续编号；缺失或畸形（如 771、cm）按上下文纠正或重排。',
    '3. 选项每个独立一行（A. ~E.）；原文挤在一行的要拆开。',
    '4. 答案独立一行「答案：X」。文末集中答案区必须按题号拆回各题内联；某题确无答案写「答案：(缺)」。',
    '5. 删除水印、页码、页眉页脚、广告词；题干与选项文字除明显错字外不得改写。',
    '6. 只输出转换后的 md，不要任何解释。',
    '',
    '原始文本：'
  ].join('\n');

  function downloadText(name, content) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  }

  function readAsText(file) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result || ''));
      r.onerror = () => rej(r.error);
      r.readAsText(file, 'utf-8');
    });
  }

  async function handleSliceFiles(files) {
    const list = Array.from(files);
    let totalSlices = 0;
    // 提示词模板先下，方便逐片粘贴时垫底
    downloadText('00_AI修正提示词模板.txt', SLICE_PROMPT);
    for (const f of list) {
      const text = await readAsText(f);
      const base = (f.name || '未命名').replace(/\.[^.]+$/, '');
      const outs = QuizSlicer.sliceToFiles(text, base);
      totalSlices += outs.length;
      for (const o of outs) {
        // 浏览器连下多文件需要间隔，否则会被拦截/丢
        await new Promise(res => setTimeout(res, 350));
        downloadText(o.name, o.content);
      }
      seq++;
    }
    toast(`已导出 ${list.length} 个文件 → ${totalSlices} 个切片`);
  }

  function switchImport(v) {
    const isPaste = v === 'paste';
    const isSlice = v === 'slice';
    $('#dropZone').classList.toggle('hidden', isPaste || isSlice);
    $('#fileInput').classList.toggle('hidden', isPaste || isSlice);
    $('#pasteArea').classList.toggle('hidden', !isPaste);
    $('#sliceArea').classList.toggle('hidden', !isSlice);
    $('#importSeg').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  }

  // ---------- 事件绑定 ----------
  function bind() {
    $('#backBtn').onclick = () => { if (S.back === 'bank') openBank(S.bank.id); else { $('#title').textContent = '卡片题库'; renderHome(); } };
    const fi = $('#fileInput');
    $('#dropZone').onclick = () => fi.click();
    fi.onchange = () => { if (fi.files.length) handleFiles(fi.files); fi.value = ''; };
    const dz = $('#dropZone');
    ['dragover', 'dragenter'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('over'); }));
    dz.addEventListener('drop', e => { if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files); });
    // 导入方式切换 / 粘贴导入
    $('#importSeg').querySelectorAll('button').forEach(b => b.onclick = () => switchImport(b.dataset.v));
    $('#pasteImport').onclick = handlePaste;
    // v8：切片导出（可选入口，与直接导入互不影响）
    const si = $('#sliceInput');
    $('#sliceDrop').onclick = () => si.click();
    si.onchange = () => { if (si.files.length) safe(handleSliceFiles(si.files), '切片导出失败'); si.value = ''; };
    const sd = $('#sliceDrop');
    ['dragover', 'dragenter'].forEach(ev => sd.addEventListener(ev, e => { e.preventDefault(); sd.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(ev => sd.addEventListener(ev, e => { e.preventDefault(); sd.classList.remove('over'); }));
    sd.addEventListener('drop', e => { if (e.dataTransfer.files.length) safe(handleSliceFiles(e.dataTransfer.files), '切片导出失败'); });
    // v9：备份 / 恢复（跨设备同步）
    $('#backupBtn').onclick = () => safe((async () => {
      const dump = await DB.dumpAll();
      const d = new Date();
      const pad = n => String(n).padStart(2, '0');
      downloadText(`题库备份_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.json`, JSON.stringify(dump));
      toast('备份已导出；把该文件发到手机，在手机端点「恢复备份」');
    })(), '导出备份失败');
    $('#restoreBtn').onclick = () => $('#restoreInput').click();
    $('#restoreInput').onchange = () => safe((async () => {
      const f = $('#restoreInput').files[0];
      $('#restoreInput').value = '';
      if (!f) return;
      if (!confirm('恢复备份会覆盖本设备上的题库与学习进度，继续？')) return;
      const dump = JSON.parse(await readAsText(f));
      await DB.restoreAll(dump);
      toast('恢复成功');
      renderHome();
    })(), '恢复备份失败');
    // v9：目录全部折叠 / 展开
    $('#outlineFold').onclick = () => {
      const nodes = Array.from($('#outlineTree').querySelectorAll('.ol-node'));
      const anyOpen = nodes.some(n => !n.classList.contains('collapsed'));
      nodes.forEach(n => n.classList.toggle('collapsed', anyOpen));
      $('#outlineFold').textContent = anyOpen ? '全部展开' : '全部折叠';
    };
    // 题库内搜索
    $('#qSearch').addEventListener('input', () => renderQuestionList($('#qSearch').value));
    // 范围选择
    $('#rangeSeg').querySelectorAll('button').forEach(b => b.onclick = () => {
      $('#rangeSeg').querySelectorAll('button').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      $('#chapterPicker').classList.toggle('hidden', b.dataset.v !== 'chapter');
      updateRangeHint();
    });
    $('#rangeCancel').onclick = () => $('#rangeBar').classList.add('hidden');
    // 深色
    const saved = localStorage.getItem('theme');
    if (saved) document.documentElement.setAttribute('data-theme', saved);
    $('#themeBtn').onclick = () => {
      const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', cur);
      localStorage.setItem('theme', cur);
    };
  }

  // ---------- 启动 ----------
  // 数据库级事件要让用户看得见：被阻塞时界面会一直卡住，不提示等于死等
  DB.setEventHandler((kind) => {
    if (kind === 'blocked') reportErr('数据库被占用', new Error('请关闭其他标签页里的本页面，再刷新重试'));
    else if (kind === 'versionchange') reportErr('数据已升级', new Error('本页已让出连接，请刷新后继续'));
  });

  // 打开失败也要把界面挂起来：无痕模式 / 浏览器不支持 IndexedDB 时，
  // 原来的写法会直接白屏且无任何提示
  safe(DB.open(), '数据库打开失败').then((ok) => {
    bind();
    if (!ok) {
      const box = $('#bankList');
      if (box) box.innerHTML = '<div class="empty">数据库打不开，可能是浏览器无痕模式或存储被禁用。<br><span class="muted">换普通窗口打开，或允许本站存储数据后刷新</span></div>';
      return;
    }
    safe(renderHome(), '加载题库失败');
  });
})();

/* app.js — 卡片题库 主控制器 */
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  // v22：iOS Safari 里元素要有 touchstart 监听 :active 才生效——全局挂一个空的，
  // 所有按钮的按压反馈在 iPhone 上就都有了（安卓本来就有，不受影响）
  document.addEventListener('touchstart', function () {}, { passive: true });
  // v22：首次手势预热音频引擎（iOS 自动播放策略），之后程序触发的音（考试告警）才出得了声
  document.addEventListener('pointerdown', function () { if (window.SFX) SFX.warm(); }, { once: true, passive: true });
  const TYPE_LABEL = {
    single: '单选题', multiple: '多选题', judge: '判断题',
    term: '名词解释', fill: '填空题', essay: '简答题'
  };
  // v21：模式名（模式卡片选中态 / 练习范围条 / 开始按钮共用）
  const MODE_LABEL = { memorize: '🃏 背题', practice: '✍️ 刷题', exam: '⏱️ 考试' };

  // pool = 当前练习范围内的题目（全库或按章节筛出的子集）
  const S = { bank: null, questions: [], pool: [], outline: [], selectedChapter: null, back: 'home', pendingMode: null, cleaned: null };

  // ---------- 兼容性兜底 ----------
  // padStart 是 ES2017，老安卓 WebView（Chrome < 57）没有；这里自带一份，不依赖原型方法
  function pad2(n) { n = String(n); return n.length >= 2 ? n : '0' + n; }
  // v21：用时格式化 mm:ss（满 1 小时 h:mm:ss）
  function fmtElapsed(ms) {
    const s = Math.max(0, Math.floor((ms || 0) / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    return h > 0 ? h + ':' + pad2(m) + ':' + pad2(ss) : pad2(m) + ':' + pad2(ss);
  }
  // v21：模式计时器统一管理——离开学习页 / 结束 / 重开都要停，否则 interval 泄漏
  function stopTimer(h) { if (h && h.timer) { clearInterval(h.timer); h.timer = null; } }
  function startTimerChip(holder) {
    // holder: prac / mem；每秒刷新 #mtTimer（元素随题目重渲重建，按 id 找）
    if (!holder || holder.timer) return;
    holder.timer = setInterval(() => {
      const el = $('#mtTimer');
      if (el && holder.startAt) el.textContent = '⏱ ' + fmtElapsed(Date.now() - holder.startAt);
    }, 1000);
  }

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
    ['home', 'bank', 'study', 'wrong'].forEach(v => $('#view-' + v).classList.toggle('hidden', v !== name));
  }
  function cleanupStudy() {
    stopTimer(exam); stopTimer(prac); stopTimer(mem);   // v21：三个模式的计时器统一停
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
    safe(renderHomeStats(), '加载统计失败');   // 统计卡并行加载，不阻塞题库列表
    safe(renderExamCard(), '加载考试计划失败'); // v27：倒计时/目标卡并行加载
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

  // ---------- F2 统计面板 ----------
  // v24：每日目标（localStorage，默认 50；点今日行可改）
  const GOAL_KEY = 'daily-goal';
  function getDailyGoal() {
    const n = parseInt(localStorage.getItem(GOAL_KEY) || '50', 10);
    return (n > 0 && n <= 1000) ? n : 50;
  }
  // 首页顶部卡：累计 + 今日目标进度条
  async function renderHomeStats() {
    const box = $('#homeStats'); if (!box) return;
    const sess = (await DB.listSessions()) || [];
    const t = DB.aggTotals(sess);
    const streak = DB.streakDays(sess);
    const h = Math.floor(t.ms / 3600000);
    const m = Math.round((t.ms % 3600000) / 60000);
    const dur = h > 0 ? `${h} 小时 ${m} 分` : (m > 0 ? `${m} 分钟` : `${Math.round(t.ms / 1000)} 秒`);
    const today = (DB.dailyCounts(sess, 1)[0] || {}).count || 0;
    const goal = getDailyGoal();
    const pct = Math.min(100, Math.round(today / goal * 100));
    box.innerHTML =
      `<div class="hs-main">📊 累计做题 <b>${t.count}</b> 题 · 累计 ${dur} · 连续打卡 <b>${streak}</b> 天</div>` +
      `<div class="hs-today" id="todayRow" title="点此修改每日目标">` +
      `今日 <b>${today}</b> / ${goal} 题` +
      `<span class="hs-goal-bar"><span style="width:${pct}%"></span></span>` +
      (today >= goal && goal > 0 ? '<span>🎉</span>' : '') +
      `</div>` +
      (t.count ? '' : `<div class="hs-hint">做一次题就开始计数（刷题 / 背题 / 考试都算）</div>`);
    box.classList.remove('hidden');
  }

  // ---------- v27：考试倒计时 + 多目标计划（db.js goals/meta 表的 UI 层） ----------
  const METRIC_LABEL = { new: '累计做题', wrong: '错题清零', mock: '整卷模拟', manual: '手动勾选' };
  const METRIC_UNIT = { new: '题', wrong: '道', mock: '次', manual: '' };
  function todayStr() {
    const d = new Date();
    const m = d.getMonth() + 1, day = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
  }
  function fmtDateCn(s) {                       // '2026-10-24' → '10月24日'
    const p = String(s || '').split('-');
    return p.length === 3 ? (+p[1]) + '月' + (+p[2]) + '日' : (s || '');
  }
  function shorten(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; }
  // 目标进度数据快照：全量流水 + 全量进度 + 各库题数 + 模拟计数
  async function goalDataSnapshot() {
    const arr = await Promise.all([DB.listSessions(), DB.listProgress(), DB.listBanks(), DB.getMeta('mockCount')]);
    const bankSizes = {};
    (arr[2] || []).forEach(b => { bankSizes[b.id] = b.count || 0; });
    return { sessions: arr[0] || [], progs: arr[1] || [], bankSizes: bankSizes, mockCount: +arr[3] || 0 };
  }
  // 首页倒计时卡：考试信息 + 目标进度（还差多少 / 剩几天 / 每天多少）
  async function renderExamCard() {
    const box = $('#examCard'); if (!box) return;
    box.onclick = (e) => {
      if (e.target.dataset.fixgoal) {          // 一键把每日目标调成建议节奏
        localStorage.setItem(GOAL_KEY, String(+e.target.dataset.fixgoal || 50));
        toast('每日目标已调整');
        safe(renderHomeStats(), '刷新统计失败');
        safe(renderExamCard(), '刷新计划失败');
        return;
      }
      openPlanModal();
    };
    const exam = await DB.getExam();
    if (!exam) {
      box.innerHTML = '<div class="exam-empty">⏳ 设个考试日期，安排你的备考计划 ›</div>';
      box.classList.remove('hidden');
      return;
    }
    const days = DB.daysBetween(todayStr(), exam.date);
    const goals = await DB.listGoals();
    const data = await goalDataSnapshot();
    let html =
      `<div class="exam-head"><span class="exam-days">${Math.max(0, days)}</span>` +
      `<span>天后考试</span><span class="exam-sub">${esc(exam.name)} · ${fmtDateCn(exam.date)}</span></div>`;
    if (!goals.length) {
      html += '<div class="goal-hint">还没有目标——点这里添加，或用「生成建议计划」一键三阶段</div>';
    }
    const perDays = [];                         // (goal, perDay) 供每日目标建议
    goals.slice(0, 4).forEach(g => {
      const pr = DB.goalProgress(g, data);
      const left = DB.daysBetween(todayStr(), g.deadline);
      const done = pr.done >= pr.target;
      const pct = Math.min(100, Math.round(pr.done / pr.target * 100));
      const remain = Math.max(0, pr.target - pr.done);
      const perDay = (!done && left > 0 && g.metric !== 'manual') ? Math.ceil(remain / left) : null;
      perDays.push({ g: g, perDay: perDay });
      html += `<div class="goal-item${done ? ' goal-done' : ''}">` +
        `<div class="goal-line"><span class="goal-title">${done ? '✅ ' : ''}${esc(shorten(g.title, 22))}</span>` +
        `<span class="goal-meta${left < 3 && !done ? ' warn' : ''}">${left >= 0 ? '剩 ' + left + ' 天' : '已到期'}</span></div>` +
        `<div class="goal-bar"><span style="width:${pct}%"></span></div>` +
        `<div class="goal-meta" style="margin-top:3px">${pr.done} / ${pr.target}` +
        (perDay ? ` · 每天 ${perDay} ${METRIC_UNIT[g.metric] || ''}` : '') + `</div></div>`;
    });
    // 每日目标建议：第一个未完成的一轮目标与当前每日目标差 ≥20% 时给一键调整
    const sug = perDays.find(x => x.g.metric === 'new' && x.perDay);
    if (sug) {
      const cur = getDailyGoal();
      if (Math.abs(sug.perDay - cur) / Math.max(cur, 1) >= 0.2) {
        html += `<div class="goal-hint">按「${esc(shorten(sug.g.title, 14))}」的节奏每天约 ${sug.perDay} 题，` +
          `当前每日目标是 ${cur} 题 <button data-fixgoal="${sug.perDay}">调整</button></div>`;
      }
    }
    box.innerHTML = html;
    box.classList.remove('hidden');
  }
  // 计划弹层：考试信息表单 + 目标清单（manual 可勾选完成，任何目标可删）
  function openPlanModal() {
    safe((async () => {
      const exam = await DB.getExam();
      $('#examName').value = exam ? exam.name : '';
      $('#examDate').value = exam ? exam.date : '';
      await renderGoalList();
      $('#planModal').classList.remove('hidden');
    })(), '打开计划失败');
  }
  async function renderGoalList() {
    const box = $('#goalList'); if (!box) return;
    const goals = await DB.listGoals();
    if (!goals.length) {
      box.innerHTML = '<div class="muted" style="font-size:13px">还没有目标——手动添加一条，或点下方「生成建议计划」。</div>';
      return;
    }
    const data = await goalDataSnapshot();
    box.innerHTML = goals.map(g => {
      const pr = DB.goalProgress(g, data);
      const left = DB.daysBetween(todayStr(), g.deadline);
      const done = pr.done >= pr.target;
      return `<div class="pg-item">` +
        `<div class="pg-top"><span class="pg-title">${done ? '✅ ' : ''}${esc(g.title)}</span>` +
        `<span class="pg-meta">${esc(g.deadline || '—')} · ${left >= 0 ? '剩 ' + left + ' 天' : '已到期'}</span></div>` +
        `<div class="pg-meta">${METRIC_LABEL[g.metric] || g.metric}：${pr.done} / ${pr.target}` +
        (g.metric !== 'manual' && !done && left > 0
          ? `（每天 ${Math.ceil(Math.max(0, pr.target - pr.done) / left)} ${METRIC_UNIT[g.metric] || ''}）` : '') + `</div>` +
        `<div class="pg-ops">` +
        (g.metric === 'manual'
          ? `<button data-toggle="${g.id}">${g.manualDone ? '↩︎ 标记未完成' : '✔ 标记完成'}</button>` : '') +
        `<button class="pg-del" data-del="${g.id}">删除</button></div></div>`;
    }).join('');
  }

  // 详情页：近 14 天每日做题量，纯 CSS 条形（零依赖，不引图表库）
  async function renderBankChart() {
    const box = $('#bankChart'); if (!box) return;
    const sess = (await DB.listSessions(S.bank.id)) || [];
    const days = DB.dailyCounts(sess, 14);
    let max = 1;
    days.forEach(d => { if (d.count > max) max = d.count; });
    box.innerHTML =
      `<div class="bc-title">近 14 天每日做题量<span class="muted">（共 ${days.reduce((a, d) => a + d.count, 0)} 题）</span></div>` +
      // v14：--i 驱动柱子从底部依次长起（barGrow 动画）
      `<div class="bc-row">` + days.map((d, i) =>
        `<div class="bc-col" title="${d.key}：${d.count} 题"><span class="bc-bar" style="--i:${i};height:${Math.round(d.count / max * 56)}px"></span></div>`
      ).join('') + `</div>`;
    box.classList.remove('hidden');
  }

  async function confirmDelete(id, name) {
    if (!confirm(`确定删除题库「${name}」？此操作不可恢复。`)) return;
    await DB.deleteBank(id); toast('已删除'); renderHome();
  }

  // v24：背题卡上的「今日到期 N 张」——SM-2 语义与 startMemorize 完全一致
  // （没见过的卡也算到期：新卡当天就该学）
  async function refreshMemDue() {
    const el = $('#memDueHint');
    if (!el || !S.bank) return;
    const ps = await DB.listProgress(S.bank.id);
    const map = {}; ps.forEach(p => { map[p.qid] = p; });
    const now = Date.now();
    const n = S.pool.filter(q => !map[q.id] || (map[q.id].due || 0) <= now).length;
    el.textContent = n ? `📌 今日到期 ${n} 张` : '';
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
    // v27：题库页给出「‹ 首页」——此前返回按钮在题库页被隐藏，回首页只能重开 App；
    // 配合首页的考试倒计时卡，这里必须能一键回去
    setBack('home');
    $('#backBtn').classList.remove('hidden');
    $('#backBtn').textContent = '‹ 首页';
    renderBankSwitch(bank.id);
    $('#rangeBar').classList.add('hidden');
    clearModeSel();
    refreshResumeBar();               // v23：上次没做完的会话给个「继续」入口
    safe(refreshMemDue(), '加载到期数失败');   // v24：背题卡「今日到期 N 张」
    await renderBankStats();
    safe(renderBankChart(), '加载每日统计失败');
    await safe(refreshWrongCount(), '加载错题数失败');
    safe(refreshWeakEntry(), '加载弱项统计失败');
    safe(renderOutlineTree(), '加载目录失败');
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
    // v26：今日只看本库（跨库总和在首页统计卡），让目标进度在题库页也可见
    const sess = (await DB.listSessions(S.bank.id)) || [];
    const today = (DB.dailyCounts(sess, 1)[0] || {}).count || 0;
    $('#bankStats').innerHTML =
      `<div class="sum-main"><b>${S.questions.length}</b> 题 · ${esc(parts.join(' / ') || '—')}</div>` +
      `<div class="sum-sub">已练 ${m.practiced} 题 · 掌握 ${m.mastered} 题 · 掌握度 ${m.pct}% · 今日 ${today} 题</div>` +
      `<div class="master-bar"><span style="width:${m.pct}%"></span></div>`;
  }

  // 目录树：第 3 层及以下默认收起，点箭头折叠，点标题筛选
  // v25：掌握度色点 —— 章节累计正确率 ≥80% 绿 / 50-79% 黄 / <50% 红；累计作答 <3 次不上色
  function masteryDot(m) {
    if (!m || m.acc == null) return '';
    const pct = Math.round(m.acc * 100);
    const cls = m.acc >= 0.8 ? 'ok' : (m.acc >= 0.5 ? 'mid' : 'bad');
    return `<span class="ol-dot ol-dot-${cls}" title="正确率 ${pct}%（累计 ${m.attempts} 次）"></span>`;
  }
  function outlineHtml(nodes, depth, mastery) {
    return (nodes || []).map(n => {
      const hasKids = !!(n.children && n.children.length);
      const collapsed = depth >= 2 ? ' collapsed' : '';
      return `<div class="ol-node${collapsed}">` +
        `<div class="ol-row" data-id="${esc(n.id)}" style="padding-left:${depth * 14}px">` +
        `<span class="ol-toggle">${hasKids ? '▸' : ''}</span>` +
        `<span class="ol-title">${esc(n.title)}${masteryDot(mastery && mastery[n.id])}</span>` +
        `<span class="ol-count">${n.total || 0} 题</span>` +
        `</div>` +
        (hasKids ? `<div class="ol-children">${outlineHtml(n.children, depth + 1, mastery)}</div>` : '') +
        `</div>`;
    }).join('');
  }

  async function renderOutlineTree() {
    const box = $('#outlineTree');
    if (!S.outline || !S.outline.length) {
      box.innerHTML = '<div class="empty">这份笔记没有标题层级，题目已归入「未分组」</div>';
      $('#outlineHint').textContent = '';
      return;
    }
    const progs = await DB.listProgress(S.bank.id);
    const mastery = DB.outlineMastery(S.outline, S.questions, progs);
    box.innerHTML = outlineHtml(S.outline, 0, mastery);
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

  // v14：i 由 Array#map 自动传入（未传则默认 0），用于卡片错峰入场，最多延后 12 张避免尾部等太久
  function questionCardHtml(q, i) {
    const stagger = ` style="--i:${Math.min(i || 0, 12)}"`;
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
    return `<div class="qcard"${stagger}>` +
      `<div class="qcard-top"><span class="qtag">${TYPE_LABEL[q.type] || q.type}</span><span class="qcard-path">${esc(path)}</span>` +
      `<button class="qcard-edit" type="button" data-edit="${esc(q.id)}" title="编辑此题">✏️</button></div>` +
      body +
      `<button class="qcard-reveal">显示答案</button>` +
      `<div class="qcard-answer hidden">` +
      `<div class="qcard-ans">答案：${esc(answerText(q))}</div>` +
      (q.explanation ? `<div class="qcard-exp">解析：${esc(q.explanation)}</div>` : '') +
      `</div></div>`;
  }

  // v25：题目编辑——OCR 错的答案/解析可以直接在 App 里修，不用重导题库
  function openEditQuestion(qid) {
    const q = S.questions.find(x => x.id === qid) || (wb && wb.qmap && wb.qmap[qid]);
    if (!q) return;
    const isTerm = q.type === 'term';
    let answerHtml = '';
    if (q.type === 'single' || q.type === 'multiple') {
      answerHtml = `<div class="field"><label>答案（多选连写，如 ABD）</label>
        <input type="text" id="editAns" maxlength="8" autocomplete="off" value="${esc(Scoring.answerKeys(q).join(''))}" /></div>`;
    } else if (q.type === 'judge') {
      answerHtml = `<div class="field"><label>答案</label><div class="seg" id="editJudge">
        <button type="button" data-v="1"${q.answer ? ' class="on"' : ''}>对</button>
        <button type="button" data-v="0"${!q.answer ? ' class="on"' : ''}>错</button></div></div>`;
    } else if (isTerm) {
      answerHtml = `<div class="field"><label>词条</label><input type="text" id="editTerm" value="${esc(q.term || '')}" /></div>` +
        `<div class="field"><label>定义（答案）</label><textarea id="editDef" rows="5">${esc(q.definition || '')}</textarea></div>`;
    } else {
      answerHtml = `<div class="field"><label>答案</label><textarea id="editAns" rows="4">${esc(q.answer == null ? '' : q.answer)}</textarea></div>`;
    }
    $('#editBody').innerHTML =
      `<div class="muted" style="font-size:12px;margin-bottom:10px">${TYPE_LABEL[q.type] || q.type} · ${esc((q.chapterPath || []).join(' › ') || q.chapter || '未分组')}</div>` +
      `<div class="field"><label>题干</label><textarea id="editStem" rows="4">${esc(q.stem || '')}</textarea></div>` +
      answerHtml +
      `<div class="field"><label>解析</label><textarea id="editExp" rows="3">${esc(q.explanation || '')}</textarea></div>`;
    let judgeAns = q.answer;
    if (q.type === 'judge') {
      $('#editJudge').querySelectorAll('button').forEach(b => b.onclick = () => {
        $('#editJudge').querySelectorAll('button').forEach(x => x.classList.remove('on'));
        b.classList.add('on');
        judgeAns = b.dataset.v === '1';
      });
    }
    $('#editModal').classList.remove('hidden');
    $('#editSave').onclick = () => safe((async () => {
      const patch = { id: q.id, explanation: $('#editExp').value };
      if (isTerm) {
        patch.term = $('#editTerm').value.trim() || q.term;
        patch.definition = $('#editDef').value;
        patch.stem = $('#editStem').value.trim() || q.stem;
      } else {
        patch.stem = $('#editStem').value.trim() || q.stem;
      }
      if (q.type === 'single' || q.type === 'multiple') {
        // 字母清洗 + 去重 + 排序，防手滑输入非法答案
        const keys = ($('#editAns').value || '').toUpperCase().replace(/[^A-H]/g, '')
          .split('').filter((c, i, a) => a.indexOf(c) === i).sort();
        if (!keys.length) { toast('答案至少要有一个字母（A-H）'); return; }
        patch.answer = keys;
      } else if (q.type === 'judge') {
        patch.answer = judgeAns;
      } else if (!isTerm) {
        patch.answer = $('#editAns').value;
      }
      const ok = await DB.updateQuestion(patch);
      if (!ok) { toast('这道题已不在题库里（可能被重新导入过）'); return; }
      Object.assign(q, patch);              // S.questions 里就是同一个对象，原地更新
      $('#editModal').classList.add('hidden');
      toast('已保存');
      SFX.neutral();
      if (curView === 'wrong') safe(openWrongBook(), '刷新错题本失败');
      else if (curView === 'bank' && S.bank) renderQuestionList($('#qSearch').value);
    })(), '保存失败');
  }

  // 委托绑定：卡片是 innerHTML 反复重渲的，事件委托到 document 上一次就够
  function bindEditButtons() {
    document.addEventListener('click', (e) => {
      const b = e.target.closest('.qcard-edit');
      if (b) openEditQuestion(b.dataset.edit);
    });
  }

  // 展开/收起答案：题目列表与错题本列表共用
  function bindReveal(box) {
    box.querySelectorAll('.qcard-reveal').forEach(b => {
      b.onclick = () => {
        const card = b.closest('.qcard');
        const ans = card.querySelector('.qcard-answer');
        ans.classList.toggle('hidden');
        b.textContent = ans.classList.contains('hidden') ? '显示答案' : '收起答案';
      };
    });
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
    bindReveal(box);
  }

  // ---------- F1：跨会话错题本 ----------
  // wb = 当前错题本状态。progs 一次读出来后本地筛选，切筛选条件不再打库。
  let wb = null;

  async function wrongItems(opts) {
    const progs = await DB.listProgress(S.bank.id);
    const qmap = {};
    S.questions.forEach(q => { qmap[q.id] = q; });
    return DB.pickWrong(progs, Object.assign({ questionMap: qmap }, opts || {}));
  }

  // 题库详情页入口角标：不点进去也能一眼看到攒了多少错题
  async function refreshWrongCount() {
    const el = $('#wrongEntryCount');
    if (!el) return;
    const items = await wrongItems();
    el.textContent = items.length;
    const hint = $('#wrongEntryHint');
    if (hint) hint.textContent = items.length ? '' : '（还没有错题）';
    return items.length;
  }

  async function openWrongBook() {
    const progs = await DB.listProgress(S.bank.id);
    const qmap = {};
    S.questions.forEach(q => { qmap[q.id] = q; });
    wb = { progs: progs, qmap: qmap, type: null, chapter: null, graduated: false };
    setBack('bank', '‹ 题库');
    $('#title').textContent = '错题本';
    renderWrongBook();
    showView('wrong');
  }

  function wbFiltered() {
    return DB.pickWrong(wb.progs, {
      questionMap: wb.qmap,
      types: wb.type ? [wb.type] : null,
      chapter: wb.chapter,
      graduated: wb.graduated
    });
  }

  function wbChips(kind, pairs, cur) {
    // pairs: [[值, 显示名, 数量], ...]，值 '' 表示「全部」
    return `<div class="wb-filters">` + pairs.map(p =>
      `<button class="wb-chip${(cur || '') === p[0] ? ' on' : ''}" data-kind="${kind}" data-v="${esc(p[0])}">${esc(p[1])}${p[2] != null ? ' ' + p[2] : ''}</button>`
    ).join('') + `</div>`;
  }

  function renderWrongBook() {
    const view = $('#view-wrong');
    const active = DB.pickWrong(wb.progs, { questionMap: wb.qmap });
    const grad = DB.pickWrong(wb.progs, { questionMap: wb.qmap, graduated: true });

    // 筛选项从「当前视图实际有错题的范围」里长出来，避免列出一堆空章节
    const base = wb.graduated ? grad : active;
    const typeCnt = {}, chapCnt = {};
    base.forEach(it => {
      const q = it.question; if (!q) return;
      typeCnt[q.type] = (typeCnt[q.type] || 0) + 1;
      const c = DB.topChapter(q);
      chapCnt[c] = (chapCnt[c] || 0) + 1;
    });
    // 当前筛选组里的错题被移光时自动复位：否则 chips 不再渲染，用户会卡在空列表且无法取消筛选
    if (wb.type && !typeCnt[wb.type]) wb.type = null;
    if (wb.chapter && !chapCnt[wb.chapter]) wb.chapter = null;
    const items = wbFiltered();
    const typePairs = [['', '全部题型', base.length]].concat(
      Object.keys(typeCnt).map(t => [t, TYPE_LABEL[t] || t, typeCnt[t]]));
    const chapPairs = [['', '全部章节', base.length]].concat(
      Object.keys(chapCnt).map(c => [c, c, chapCnt[c]]));

    const sumWrong = items.reduce((n, it) => n + it.wrong, 0);
    let html = `<div class="bank-summary">` +
      (wb.graduated
        ? `<div class="sum-main"><b>${items.length}</b> 道已毕业 🎓 · 连续答对 ${DB.wrongGradN()} 次通过</div>` +
          `<div class="sum-sub">毕业不影响历史统计；想再练点「重新练习」收回活跃清单</div>`
        : `<div class="sum-main"><b>${items.length}</b> 道错题进行中${grad.length ? ` · 已毕业 ${grad.length} 道 🎓` : ''}</div>` +
          `<div class="sum-sub">连续答对 ${DB.wrongGradN()} 次自动毕业；按「错误次数 → 最近错误时间」排序</div>`) +
      `</div>`;
    // v24：进行中 / 已毕业 视图切换
    html += `<div class="wb-filters">` +
      `<button class="wb-chip${!wb.graduated ? ' on' : ''}" data-kind="view" data-v="">进行中 ${active.length}</button>` +
      `<button class="wb-chip${wb.graduated ? ' on' : ''}" data-kind="view" data-v="grad">已毕业 ${grad.length}</button>` +
      `</div>`;
    if (!wb.graduated) {
      if (typePairs.length > 2) html += wbChips('type', typePairs, wb.type);
      if (chapPairs.length > 2) html += wbChips('chapter', chapPairs, wb.chapter);
      html += `<div class="wb-actions">` +
        `<button class="btn" id="wbPractice"${items.length ? '' : ' disabled'}>✍️ 刷错题</button>` +
        `<button class="btn secondary" id="wbMemorize"${items.length ? '' : ' disabled'}>🃏 背错题</button>` +
        `</div>`;
    }
    html += items.length
      ? `<div class="qlist">` + items.map(it =>
        `<div class="wb-item" data-qid="${esc(it.qid)}">` +
        `<div class="wb-head">` +
        (wb.graduated
          ? `<span class="wb-badge wb-badge-grad">🎓 已毕业</span><button class="wb-remove wb-restore" type="button">重新练习</button>`
          : `<span class="wb-badge">错 ${it.wrong} 次${it.right ? ' · 对 ' + it.right + ' 次' : ''}</span>` +
            `<button class="wb-remove" type="button">移除</button>`) +
        `</div>` +
        questionCardHtml(it.question) + `</div>`).join('') + `</div>`
      : `<div class="empty">${wb.graduated ? '还没有毕业的错题——连续答对 ' + DB.wrongGradN() + ' 次就会出现在这里 🎓'
          : (base.length ? '这个筛选条件下没有错题' : '还没有错题，去刷题或考试攒一攒 👆')}</div>`;
    view.innerHTML = html;

    view.querySelectorAll('.wb-chip').forEach(b => {
      b.onclick = () => {
        if (b.dataset.kind === 'view') {
          if ((b.dataset.v === 'grad') === wb.graduated) return;
          wb.graduated = b.dataset.v === 'grad';
          wb.type = null; wb.chapter = null;      // 视图切换时清掉题型/章节筛选
        } else if (b.dataset.kind === 'type') {
          const v = b.dataset.v || null;
          wb.type = (wb.type === v) ? null : v;
        } else {
          const v = b.dataset.v || null;
          wb.chapter = (wb.chapter === v) ? null : v;
        }
        renderWrongBook();
      };
    });
    bindReveal(view);
    view.querySelectorAll('.wb-remove').forEach(b => {
      const qid = b.closest('.wb-item').dataset.qid;
      b.onclick = () => wb.graduated
        ? safe(restoreWrongItem(qid), '收回失败')
        : safe(removeWrong(qid), '移除失败');
    });
    if (!wb.graduated && items.length) {
      const list = items.map(it => it.question);
      $('#wbPractice').onclick = () => startMode('practice', list, { title: '刷错题' });
      // 背错题不做 SM2 due 过滤：错题就是要全部过一遍
      $('#wbMemorize').onclick = () => startMode('memorize', list, { title: '背错题', all: true });
    }
  }

  async function restoreWrongItem(qid) {
    const ok = await DB.restoreWrong(qid, S.bank.id);
    if (!ok) { toast('这道题的进度记录不在了'); return; }
    toast('已收回活跃清单，继续加油');
    wb.progs = await DB.listProgress(S.bank.id);
    renderWrongBook();
    await safe(refreshWrongCount(), '刷新错题数失败');
  }

  async function removeWrong(qid) {
    const ok = await DB.setWrongDismissed(qid, S.bank.id, true);
    if (!ok) { toast('这道题的进度记录不在了'); return; }
    toast('已移出错题本');
    wb.progs = await DB.listProgress(S.bank.id);   // 重读进度，但保留当前筛选条件
    renderWrongBook();
    await safe(refreshWrongCount(), '刷新错题数失败');
  }

  // ---------- F18：弱项专项包 ----------
  // 组卷规则全在 DB.weakPack（纯函数、单测覆盖）；这里只负责取进度、说人话、进刷题流程。
  const WEAK_TOTAL = 20;

  // 详情页入口：不点进去也能看到最弱那章有多弱
  async function refreshWeakEntry() {
    const acc = $('#weakEntryAcc'), hint = $('#weakEntryHint');
    if (!acc || !hint || !S.bank) return null;
    if (!S.questions.length) { acc.textContent = ''; hint.textContent = '（题库是空的）'; return null; }
    const progs = await DB.listProgress(S.bank.id);
    const pack = DB.weakPack(S.questions, progs, { total: WEAK_TOTAL });
    // ⚠️ mode==='weak' 只代表「组出了弱章题或错题」，不代表 weak 数组非空：
    // weakChapters 要求该章作答 ≥ minAttempts(5) 且答错过，而错题没有这个门槛，
    // 所以「做了几道、错了几道但不足 5 次」时会出现 weak=[] 而 mode='weak'。
    // 旧代码直接取 pack.weak[0].acc，在这种场景下抛 TypeError（2026-09-14 实机验证抓到）。
    if (pack.mode === 'weak' && pack.weak && pack.weak.length) {
      const w = pack.weak[0];
      acc.textContent = Math.round(w.acc * 100) + '%';
      hint.textContent = w.chapter + ' 最弱' + (pack.weak.length > 1 ? ' · 共 ' + pack.weak.length + ' 章' : '');
    } else {
      acc.textContent = '';
      // 同样降级成随机包，但「没练过」「练了没弱项」「只有错题还没成弱章」要说清楚，否则用户以为按钮坏了
      hint.textContent = pack.attempts
        ? (pack.fromWrong ? `（错题 ${pack.fromWrong} 题，还没攒成弱章）` : '（暂无明显弱项）')
        : '（还没有练习记录）';
    }
    return pack;
  }

  async function startWeakPack() {
    if (!S.bank) return;
    if (!S.questions.length) { toast('这个题库还没有题目'); return; }
    const progs = await DB.listProgress(S.bank.id);
    const pack = DB.weakPack(S.questions, progs, { total: WEAK_TOTAL });
    if (!pack.list.length) { toast('组不出题：题库里没有可练的题目'); return; }
    if (pack.mode === 'weak') {
      toast(`弱项专项包 ${pack.list.length} 题 · 弱章 ${pack.fromWeak} / 错题 ${pack.fromWrong} / 随机 ${pack.fromFill}`);
    } else if (pack.attempts) {
      toast(`暂无明显弱项，随机组了 ${pack.list.length} 题`);
    } else {
      toast(`还没有练习记录，先随机组了 ${pack.list.length} 题`);
    }
    startMode('practice', pack.list, { title: '弱项专项包' });
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
  async function startMemorize(opts) {
    opts = opts || {};
    stopTimer(mem);                        // v21：防上一轮的 interval 泄漏
    const progs = await DB.listProgress(S.bank.id);
    const map = {}; progs.forEach(p => map[p.qid] = p);
    const now = Date.now();
    // opts.all：错题本进来时不按记忆曲线过滤，错的全部过一遍
    let due = opts.all ? S.pool.slice() : S.pool.filter(q => !map[q.id] || map[q.id].due <= now);
    if (!due.length) due = S.pool.slice(); // 全部复习完 -> 全部过一遍
    mem = { list: shuffle(due), i: 0, map, startAt: Date.now(), timer: null, title: opts.title || '背题' };
    setBack('bank', '‹ 题库');
    $('#title').textContent = opts.title || '背题';
    renderMemorize();
  }
  function renderMemorize() {
    const view = $('#view-study'); showView('study');
    if (mem) mem.locked = false;          // v14：每题渲染时解锁，防止连点跳两题
    if (mem.i >= mem.list.length) {
      const used = fmtElapsed(Date.now() - (mem.startAt || Date.now()));
      stopTimer(mem);                     // v21：本轮计时停止
      clearResume();                      // v23：背完清档
      SFX.done();                         // v22：背完收尾音
      view.innerHTML = `<div class="empty"><div style="font-size:40px">🎉</div>本轮背完啦！<br><span class="muted">按记忆曲线，该复习的都过了一遍 · 用时 ${used}</span></div>
        <button class="btn" onclick="location.reload()">返回</button>`;
      return;
    }
    const q = mem.list[mem.i];
    const total = mem.list.length;
    saveResume('memorize', mem);     // v23：每卡存档，退出可续
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
    // v14：真 3D 翻转结构 —— 正反面同时渲染、grid 叠放，翻面只是加 .flipped 转 180°
    // （旧版是 innerHTML 硬塞 front+back，没有任何转场，被用户吐槽"假翻转"）
    view.innerHTML =
      `<div class="progress-top"><span class="pnum">${mem.i + 1}/${total}</span>` +
      `<span class="mtimer" id="mtTimer">⏱ ${fmtElapsed(Date.now() - (mem.startAt || Date.now()))}</span>` +
      `<div class="progress-bar"><span style="width:${(mem.i / total) * 100}%"></span></div></div>` +
      `<div class="study-body slide-in">` +
      `<div class="flip3d" id="card">` +
        `<div class="flip3d-inner">` +
          `<div class="flip-face flip-front">${front}</div>` +
          `<div class="flip-face flip-back"><div class="tag">答案</div>${back}</div>` +
        `</div>` +
      `</div>` +
      `<div class="flip-hint" id="flipHint">点击卡片或下方按钮翻面看答案</div>` +
      `<button class="btn" id="flipBtn" style="margin-top:14px">显示答案</button>` +
      `<div id="rateArea" class="hidden">` +
      `<div class="rate-row">` +
      `<button class="btn rate-forget" data-q="1">😵 忘记</button>` +
      `<button class="btn rate-dim" data-q="3">🤔 模糊</button>` +
      `<button class="btn rate-know" data-q="5">😎 记住</button>` +
      `</div></div>` +
      `</div>`;
    let flipped = false;
    const flip = () => {
      if (flipped) return;                 // 翻面只触发一次
      flipped = true;
      SFX.flip();                          // v22：翻卡「刷刷」纸声
      const card = $('#card');
      card.classList.add('flipped');
      card.onclick = null;                 // 翻过去之后再点卡片不再重复触发
      $('#flipBtn').classList.add('hidden');
      $('#flipHint').classList.add('hidden');
      const ra = $('#rateArea');
      ra.classList.remove('hidden');
      ra.classList.add('fade-in');         // 自评按钮组淡入，避免"啪"地出现
    };
    mem.renderedAt = Date.now();   // F2：展示→自评的耗时起点
    startTimerChip(mem);           // v21：本轮用时 chip
    $('#flipBtn').onclick = flip;
    $('#card').onclick = flip;
    $('#rateArea').querySelectorAll('button').forEach(b => {
      b.onclick = async () => {
        if (mem.locked) return;            // v14：写库期间锁点击，防连点连跳两题
        mem.locked = true;
        const qv = +b.dataset.q;
        if (qv <= 1) SFX.wrong();          // v22：自评音效——忘记/模糊/记住
        else if (qv >= 5) SFX.right();
        else SFX.neutral();
        let p = mem.map[q.id] || { qid: q.id, bankId: S.bank.id, ease: 2.5, interval: 0, reps: 0, due: 0, lapses: 0 };
        p = sm2(p, qv);
        mem.map[q.id] = p;
        await DB.saveProgress(p);
        safe(DB.logSessions([{ bankId: S.bank.id, qid: q.id, mode: 'memorize', right: qv >= 3, ms: Date.now() - (mem.renderedAt || Date.now()) }]), '记录作答流水失败');
        mem.i++; renderMemorize();
      };
    });
  }

  // ---------- 刷题模式 ----------
  let prac = null;
  async function startPractice(opts) {
    opts = opts || {};
    stopTimer(prac);                        // v21：防上一轮的 interval 泄漏
    prac = { list: shuffle(S.pool), i: 0, wrong: [], correct: 0, wrongIds: [], title: opts.title || '刷题', startAt: Date.now(), timer: null };
    setBack('bank', '‹ 题库');
    $('#title').textContent = prac.title;
    renderPractice();
  }
  function renderPractice() {
    const view = $('#view-study'); showView('study');
    if (prac) prac.locked = false;        // v14：每题渲染时解锁，防连点连跳
    if (prac.i >= prac.list.length) return renderPracticeResult();
    const q = prac.list[prac.i];
    const total = prac.list.length;
    prac.renderedAt = Date.now();   // F2：展示→作答的耗时起点
    saveResume('practice', prac);   // v23：每题存档，退出可续
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
    // v14：题干+选项包一层 .slide-in，切题时从右侧滑入，不再是"啪"地整屏替换
    view.innerHTML =
      `<div class="progress-top"><span class="pnum">${prac.i + 1}/${total}</span>` +
      `<span class="mtimer" id="mtTimer">⏱ ${fmtElapsed(Date.now() - (prac.startAt || Date.now()))}</span>` +
      `<div class="progress-bar"><span style="width:${(prac.i / total) * 100}%"></span></div></div>` +
      `<div class="study-body slide-in">${body}</div>` +
      `<div id="pracFeedback"></div><div id="nextWrap" class="hidden"><button class="btn" id="nextBtn">下一题 ›</button></div>`;
    startTimerChip(prac);           // v21：本轮用时 chip

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
        // v14：答对 → 正确项弹一下；答错 → 选中项抖一下。在解析文字出来之前先给到"手感"
        if (right) view.querySelectorAll('.option.correct').forEach(o => o.classList.add('pop'));
        else op.classList.add('shake');
        finishPractice(q, right);
      };
    });
  }
  async function finishPractice(q, right) {
    if (right) SFX.right(); else SFX.wrong();   // v22：判分音效（选项/填空/自评三条路都汇到这里）
    const fb = $('#pracFeedback');
    let html = right
      ? `<div class="feedback ok">✓ 答对${q.explanation ? `<span class="sub">解析：${esc(q.explanation)}</span>` : ''}</div>`
      : `<div class="feedback bad">✗ 答错，正确答案：${esc(Scoring.answerText(q))}${q.explanation ? `<span class="sub">解析：${esc(q.explanation)}</span>` : ''}</div>`;
    if (!Scoring.hasAnswer(q)) {
      html += `<div class="muted" style="margin-top:6px;font-size:13px">⚠️ 这道题没识别到答案，已按「答错」计，建议导出后手工补上</div>`;
    }
    fb.innerHTML = html;
    if (right) prac.correct++; else prac.wrongIds.push(q.id);
    safe(DB.logSessions([{ bankId: S.bank.id, qid: q.id, mode: 'practice', right: right, ms: Date.now() - (prac.renderedAt || Date.now()) }]), '记录作答流水失败');

    // 先让用户可以继续，再写库 —— 存储失败绝不能把人卡死在这一题
    $('#nextWrap').classList.remove('hidden');
    // v14：锁一下，避免连点"下一题"跳掉两题
    $('#nextBtn').onclick = () => {
      if (prac.locked) return;
      prac.locked = true;
      SFX.flip();                          // v22：切题轻「刷」
      prac.i++; renderPractice();
    };

    await safe((async () => {
      let p = await DB.getProgress(q.id) || { qid: q.id, bankId: S.bank.id, ease: 2.5, interval: 0, reps: 0, due: 0, lapses: 0 };
      p.practice = p.practice || { correct: 0, wrong: 0 };
      if (right) {
        p.practice.correct++;
        p.wrongStreak = (p.wrongStreak || 0) + 1;   // v24：连续答对，攒够毕业
      }
      else {
        p.practice.wrong++;
        p.lapses = (p.lapses || 0) + 1;
        p.wrongStreak = 0;                           // v24：答错即断连续
        p.lastWrong = Date.now();       // 错题本排序用
        p.wrongDismissed = false;       // 曾被移除的再答错要收回来
      }
      p.due = Date.now(); // 刷题后立即可在背题里复习
      await DB.saveProgress(p);
    })(), '保存进度失败');
  }
  function renderPracticeResult() {
    const total = prac.list.length;
    const acc = total ? Math.round(prac.correct / total * 100) : 0;
    // v21：本轮用时 + 平均每题（复习错题重开的 prac 有自己的 startAt）
    const usedMs = Date.now() - (prac.startAt || Date.now());
    const used = fmtElapsed(usedMs);
    const avg = total ? Math.max(1, Math.round(usedMs / 1000 / total)) : 0;
    stopTimer(prac);
    clearResume();                         // v23：做完（含复习错题收尾）就清档
    SFX.done();                            // v22：刷完收尾音
    const view = $('#view-study');
    view.innerHTML =
      `<div class="result-score">${acc}%</div><div class="result-sub">答对 ${prac.correct} / ${total} · 用时 ${used} · 平均 ${avg} 秒/题</div>` +
      (prac.wrongIds.length
        ? `<button class="btn" id="reviewWrong">🔁 复习错题（${prac.wrongIds.length}）</button>
           <div style="height:10px"></div>`
        : `<div class="empty">全部答对，稳！</div>`) +
      `<button class="btn secondary" id="redoPrac">再做一遍</button><div style="height:10px"></div>
       <button class="btn ghost" id="backBank">返回题库</button>`;
    if (prac.wrongIds.length) $('#reviewWrong').onclick = async () => {
      const map = {}; S.questions.forEach(q => map[q.id] = q);
      const title = prac.title;
      stopTimer(prac);
      prac = { list: shuffle(prac.wrongIds.map(id => map[id]).filter(Boolean)), i: 0, wrong: [], correct: 0, wrongIds: [], title: title, startAt: Date.now(), timer: null };
      renderPractice();
    };
    $('#redoPrac').onclick = () => startPractice({ title: prac.title });
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
      exam = { list, i: 0, min: Math.max(0, +$('#examMin').value || 0), shuffleOpt: settings.shuffleOpt, answers: {}, endAt: 0, startAt: Date.now(), timer: null, msPer: {}, enterTs: 0, warned: false };
      if (exam.min > 0) exam.endAt = Date.now() + exam.min * 60000;
      setBack('bank', '‹ 题库'); $('#title').textContent = '考试中';
      renderExam();
    };
  }
  // F2：把「当前题停留时长」累加进 msPer；反复切回同一题会累加，符合每题真实耗时口径
  function accExamMs() {
    if (!exam || !exam.enterTs) return;
    const q = exam.list[exam.i];
    if (q) exam.msPer[q.id] = (exam.msPer[q.id] || 0) + (Date.now() - exam.enterTs);
    exam.enterTs = 0;
  }
  function renderExam() {
    const view = $('#view-study'); showView('study');
    if (exam) exam.locked = false;        // v14：每题渲染时解锁，防连点连跳
    if (exam.i >= exam.list.length) return submitExam();
    const q = exam.list[exam.i];
    const total = exam.list.length;
    // v21：时间条常驻——限时时倒计时（v14 的最后 60 秒告警保留），不限时改计「已用」
    let timerHtml;
    if (exam.min > 0) {
      const left = Math.max(0, exam.endAt - Date.now());
      timerHtml = `<span id="timer"${left <= 60000 ? ' class="timer-warn"' : ''}>⏱ ${pad2(Math.floor(left / 60000))}:${pad2(Math.floor((left % 60000) / 1000))}</span>`;
    } else {
      timerHtml = `<span id="timer">⏱ 已用 ${fmtElapsed(Date.now() - (exam.startAt || Date.now()))}</span>`;
    }
    if (!exam.timer) exam.timer = setInterval(() => {
      if (!exam) return;
      const e = $('#timer');
      if (exam.min > 0) {
        const l = Math.max(0, exam.endAt - Date.now());
        if (e) {
          e.textContent = `⏱ ${pad2(Math.floor(l / 60000))}:${pad2(Math.floor((l % 60000) / 1000))}`;
          e.classList.toggle('timer-warn', l <= 60000);
        }
        // v22：进入最后 60 秒响一次提示音（与变红同步，只响一次不轰炸）
        if (l <= 60000 && !exam.warned) { exam.warned = true; SFX.warn(); }
        if (l <= 0) { clearInterval(exam.timer); exam.timer = null; submitExam(); }
      } else if (e) {
        e.textContent = `⏱ 已用 ${fmtElapsed(Date.now() - (exam.startAt || Date.now()))}`;
      }
    }, 1000);
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
      `<div class="progress-top"><span class="pnum">${exam.i + 1}/${total}</span><div class="progress-bar"><span style="width:${(exam.i / total) * 100}%"></span></div></div>` +
      `<div class="study-body slide-in">${body}</div>` +
      `<div id="examNav" class="btn-row" style="margin-top:14px">
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
    $('#prevBtn').onclick = () => {
      if (exam.locked) return;
      if (exam.i > 0) { exam.locked = true; accExamMs(); exam.i--; renderExam(); }
    };
    $('#nextExamBtn').onclick = () => {
      if (exam.i + 1 >= total) { if (confirm('确定交卷？')) submitExam(); }
      else { if (exam.locked) return; exam.locked = true; accExamMs(); exam.i++; renderExam(); }
    };
    exam.enterTs = Date.now();
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
    stopTimer(exam);
    accExamMs();                           // 结算最后一题（或超时那一刻）的停留时长
    let correct = 0; const wrongList = [];
    const byChapter = {};
    const updates = [];                 // 待写进度，稍后一次性批量提交
    const sessList = [];                // F2：待写作答流水，结果渲染完再入库
    exam.list.forEach(q => {
      const a = exam.answers[q.id];
      const ok = a ? Scoring.isRight(q, a.value) : false;
      const c = byChapter[q.chapter] = byChapter[q.chapter] || { total: 0, correct: 0 };
      c.total++; if (ok) { correct++; c.correct++; }
      if (!ok) wrongList.push({ q, user: a });
      updates.push({ qid: q.id, ok: ok });
      sessList.push({ bankId: S.bank.id, qid: q.id, mode: 'exam', right: ok, ms: exam.msPer[q.id] || 0 });
    });
    const total = exam.list.length;
    const score = total ? Math.round(correct / total * 100) : 0;
    // v21：答题用时 = 每题停留时长之和（不含发呆/切走的时间，是「纯做题」口径）
    const usedMs = Object.keys(exam.msPer || {}).reduce((n, k) => n + (exam.msPer[k] || 0), 0);
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
      `<div class="result-score">${score}</div><div class="result-sub">得分 ${correct} / ${total} · 答题用时 ${fmtElapsed(usedMs)}</div>` +
      (noAns.length ? `<div class="muted" style="text-align:center;margin:10px 0;font-size:13px">⚠️ 有 ${noAns.length} 道题没识别到答案，已按答错计</div>` : '') +
      (chapterHtml ? `<h3 style="font-size:15px">章节正确率</h3>${chapterHtml}` : '') +
      (wrongList.length ? `<h3 style="font-size:15px;margin-top:18px">错题回顾（${wrongList.length}）</h3>${wrongHtml}` : '<div class="empty">满分，牛！</div>') +
      `<div style="height:10px"></div><button class="btn secondary" id="backBank2">返回题库</button>`;
    $('#backBank2').onclick = () => openBank(S.bank.id);
    SFX.done();                            // v22：交卷收尾音

    // 结果已经渲染出来了再写库，存储失败不会挡住看成绩；失败只提示
    await safe(DB.bulkUpdateProgress(S.bank.id, updates, 'exam'), '保存成绩失败');
    safe(DB.logSessions(sessList), '记录作答流水失败');
    // v27：整卷模拟 +1（考试计划「冲刺」目标口径，v27 起累计）
    safe((async () => {
      await DB.setMeta('mockCount', ((await DB.getMeta('mockCount')) || 0) + 1);
    })(), '记录模拟次数失败');
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
    // v21：选中的模式卡片保持高亮（桌面端没有触摸态，之前完全看不出选了哪个）
    document.querySelectorAll('#view-bank .mode-card').forEach(c => c.classList.toggle('sel', c.dataset.mode === mode));
    $('#rangeMode').textContent = MODE_LABEL[mode] + ' · ';
    $('#rangeStart').textContent = '开始' + MODE_LABEL[mode] + ' ›';
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
      clearModeSel();
      startMode(S.pendingMode, list);
    };
    bar.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // v21：清掉模式卡片的选中态、还原开始按钮文案（开始/取消/离开题库时调用）
  function clearModeSel() {
    document.querySelectorAll('#view-bank .mode-card.sel').forEach(c => c.classList.remove('sel'));
    const b = $('#rangeStart');
    if (b) b.textContent = '开始 ›';
  }

  // ---------- 模式入口 ----------
  // opts：{ title, all } —— 错题本用 title 改标题、用 all 让背题跳过记忆曲线过滤
  function startMode(mode, list, opts) {
    S.pool = (list && list.length) ? list : S.questions.slice();
    if (mode === 'memorize') startMemorize(opts);
    else if (mode === 'practice') startPractice(opts);
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
    // v18：先同步快照再进循环。FileList 是「活的」——onchange 里紧跟的
    // fi.value='' 会把它当场清空，第一个 await 挂起期间列表就没了，
    // 异步回来继续迭代直接结束（实测：多选 15 个只导入第 1 个，且无报错）
    const list = Array.from(files || []);
    let imported = 0, total = 0;
    const errBefore = errShown;
    resetCleaned();
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      // v19：多文件时给过程反馈——批量导入要数秒，全程无提示会被当成卡死；
      // toast() 连续调用会互相接续，导入完由结尾的汇总提示接管
      if (list.length > 1) toast(`导入中 ${i + 1}/${list.length}…`);
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
    '你是题库格式化工具。把下面原始文本转换为《题库导入排版规范 v1》格式，并遵守《数据清洗规则 v1》，要点：',
    '1. 结构：# 题库名 / ## 分区标题（单项选择题、多项选择题、简答题等）/ 题目块；题号全卷连续。',
    '2. 删除：公众号水印（【公众号：…】等）、行内广告词（自考包过+qq号）、页眉页脚页码、绝密★启用前、注意事项段、<!--注释-->。',
    '3. 题号纠错：J.→1.、771→37 这类按上下文修；修不了的（如 30.6、cm 7. D 属原件自带损坏）该题写「答案：(缺)」，绝不猜。',
    '4. 选项每个独立一行（A. ~E.），挤一行的要拆；冒号式 A: 统一为 A. 。',
    '5. 文末集中答案区必须按题号拆回各题内联「答案：X」；容忍分隔符混用（1. B 2:A 3. D、12A、31ABCDE）；多选连写 ABD。',
    '6. 【单选题】等方括号标签决定题型并从题干删除；案例题的「问题：/请问：」与(1)(2)小问并入题干，不拆独立题。',
    '7. 主观题答案整段保留（含(2分)采分点）。题干与选项除明显错字外不得改写。',
    '8. 只输出转换后的 md，不要任何解释。',
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

  // ---------- v18：拖放取文件（多文件 + 整个文件夹） ----------
  // 文件夹在 DataTransfer.files 里不存在，只有 webkitGetAsEntry() 一条路，逐层展开。
  // 兼容性：Chromium/Edge/Safari/Firefox 都支持 webkitGetAsEntry；不支持时退回 files 列表。
  function entryFile(entry) {
    return new Promise(res => { try { entry.file(f => res(f), () => res(null)); } catch (e) { res(null); } });
  }
  // readEntries 单次最多吐 100 条，必须反复读到空批为止
  function readDirAll(dirEntry) {
    return new Promise(res => {
      const out = [];
      let reader;
      try { reader = dirEntry.createReader(); } catch (e) { return res(out); }
      const next = () => reader.readEntries(batch => {
        if (!batch || !batch.length) return res(out);
        batch.forEach(b => out.push(b));
        next();
      }, () => res(out));
      next();
    });
  }
  async function walkEntry(entry, out) {
    if (!entry) return;
    // .git / .DS_Store 这类隐藏项直接跳过
    if (typeof entry.name === 'string' && entry.name.startsWith('.')) return;
    if (entry.isFile) { const f = await entryFile(entry); if (f) out.push(f); return; }
    if (entry.isDirectory) {
      const kids = await readDirAll(entry);
      for (const k of kids) await walkEntry(k, out);
    }
  }
  async function filesFromDataTransfer(dt) {
    const items = (dt && dt.items) || [];
    const entries = [];
    for (let i = 0; i < items.length; i++) {
      try {
        const it = items[i];
        if (it.kind && it.kind !== 'file') continue;
        if (typeof it.webkitGetAsEntry !== 'function') continue;
        const en = it.webkitGetAsEntry();
        if (en) entries.push(en);
      } catch (e) {}
    }
    // 混拖（文件 + 文件夹）时 files 里没有目录，所以只要有目录就统一走 entries 展开
    if (entries.some(en => en.isDirectory)) {
      const out = [];
      for (const en of entries) await walkEntry(en, out);
      return out;
    }
    if (dt && dt.files && dt.files.length) return Array.from(dt.files);
    return [];
  }
  function importDropped(dt, into) {
    // into：'import' 走题库导入，'slice' 走切片导出
    safe(filesFromDataTransfer(dt).then(list => {
      const ok = list.filter(f => /\.(md|markdown|txt|text)$/i.test(f.name));
      if (ok.length) return into === 'slice' ? handleSliceFiles(ok) : handleFiles(ok);
      toast('没找到 .md / .txt 文件');
    }), '读取拖入文件失败');
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

  // ---------- v9：备份 / 恢复（跨设备同步） ----------
  // v17：导出备份 —— 手机上优先调系统分享面板（直接发微信 / QQ / 文件传输助手），
  // 桌面或不支持 Web Share 的浏览器退回「下载 .json」。Web Share 是浏览器原生 API，零依赖。
  async function exportBackup() {
    const dump = await DB.dumpAll();
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    const name = `题库备份_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.json`;
    const json = JSON.stringify(dump);
    const file = new File([json], name, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: '题库备份' });
        toast('已调出分享；发到手机后在手机端点「恢复备份」');
      } catch (e) {
        if (e && e.name === 'AbortError') return;   // 用户取消了分享面板，不是错误
        throw e;
      }
    } else {
      downloadText(name, json);
      toast('备份已导出；把该文件发到手机，在手机端点「恢复备份」');
    }
  }

  // ---------- v23：断点续刷 ----------
  // 背题/刷题每切一题就把会话快照写 localStorage；退出 App/关页面后再进题库，
  // 顶部横幅「继续上次 · 第 N/M 题」一键接着做。考试有时限语义，不做续刷。
  const RESUME_KEY = 'resume-session';
  function saveResume(kind, holder) {
    try {
      localStorage.setItem(RESUME_KEY, JSON.stringify({
        kind: kind, bankId: S.bank.id, title: holder.title || '',
        qids: holder.list.map(q => q.id), i: holder.i,
        correct: holder.correct || 0, wrongIds: holder.wrongIds || [],
        savedAt: Date.now()
      }));
    } catch (e) {}                       // 存不进（隐私模式/满了）就放弃续刷，不影响做题
  }
  function clearResume() { try { localStorage.removeItem(RESUME_KEY); } catch (e) {} }
  function getResume(bankId) {
    try {
      const r = JSON.parse(localStorage.getItem(RESUME_KEY) || 'null');
      if (r && r.bankId === bankId && Array.isArray(r.qids) && r.qids.length && r.i >= 0 && r.i < r.qids.length) return r;
    } catch (e) {}
    return null;
  }
  function timeAgo(ts) {
    const m = Math.floor((Date.now() - ts) / 60000);
    if (m < 1) return '刚刚';
    if (m < 60) return m + ' 分钟前';
    if (m < 1440) return Math.floor(m / 60) + ' 小时前';
    return Math.floor(m / 1440) + ' 天前';
  }
  function refreshResumeBar() {
    const bar = $('#resumeBar');
    if (!bar) return;
    const r = getResume(S.bank && S.bank.id);
    if (!r) { bar.classList.add('hidden'); return; }
    const label = (r.kind === 'memorize' ? '🃏 背题' : '✍️ 刷题') +
      (r.title && r.title !== '背题' && r.title !== '刷题' ? '「' + r.title + '」' : '');
    $('#resumeDesc').textContent = `${label} 第 ${r.i + 1}/${r.qids.length} 题（${timeAgo(r.savedAt)}）`;
    bar.classList.remove('hidden');
  }
  function resumeSession() {
    const r = getResume(S.bank.id);
    if (!r) { refreshResumeBar(); return; }
    const qmap = {}; S.questions.forEach(q => qmap[q.id] = q);
    const list = r.qids.map(id => qmap[id]).filter(Boolean);
    if (!list.length) { clearResume(); refreshResumeBar(); return; }
    if (r.kind === 'memorize') {
      stopTimer(mem);
      (async () => {
        const progs = await DB.listProgress(S.bank.id);
        const map = {}; progs.forEach(p => map[p.qid] = p);
        mem = { list: list, i: Math.min(r.i, list.length - 1), map, startAt: Date.now(), timer: null, title: r.title || '背题' };
        S.pool = list;
        setBack('bank', '‹ 题库');
        $('#title').textContent = mem.title;
        renderMemorize();
      })();
    } else {
      stopTimer(prac);
      prac = { list: list, i: Math.min(r.i, list.length - 1), wrong: [], correct: r.correct || 0,
               wrongIds: r.wrongIds || [], title: r.title || '刷题', startAt: Date.now(), timer: null };
      S.pool = list;
      setBack('bank', '‹ 题库');
      $('#title').textContent = prac.title;
      renderPractice();
    }
    toast('已恢复到第 ' + (Math.min(r.i, list.length - 1) + 1) + ' 题');
  }

  // ---------- v20：恢复备份弹层 ----------
  let pendingDump = null;
  function closeRestoreModal() {
    $('#restoreModal').classList.add('hidden');
    pendingDump = null;
  }
  // 恢复/合并后数据整体变了：一律回首页重走，避免停留在已被替换的旧题库视图上
  function refreshAfterRestore() {
    S.bank = null; S.questions = []; S.pool = []; S.outline = [];
    setBack('home');
    $('#title').textContent = '国际法题库';
    showView('home');
    safe(renderHome(), '刷新列表失败');
  }

  // ---------- 事件绑定 ----------
  function bind() {
    $('#backBtn').onclick = () => {
      if (S.back === 'bank') openBank(S.bank.id);
      else {                                   // v27 修复：题库页「‹ 首页」真的切回首页（原来只重渲列表没切视图）
        $('#title').textContent = '国际法题库';
        showView('home');
        safe(renderHome(), '刷新列表失败');
      }
    };
    const fi = $('#fileInput');
    $('#dropZone').onclick = () => fi.click();
    // v18：先取快照再清 input —— value='' 会当场清空 FileList，
    // 异步导入循环回来就拿不到后面的文件（多选只剩第 1 个的根因）
    fi.onchange = () => {
      const picked = Array.from(fi.files);
      fi.value = '';
      if (picked.length) handleFiles(picked);
    };
    const dz = $('#dropZone');
    ['dragover', 'dragenter'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('over'); }));
    dz.addEventListener('drop', e => importDropped(e.dataTransfer, 'import'));
    // 导入方式切换 / 粘贴导入
    $('#importSeg').querySelectorAll('button').forEach(b => b.onclick = () => switchImport(b.dataset.v));
    $('#pasteImport').onclick = handlePaste;
    // v8：切片导出（可选入口，与直接导入互不影响）
    const si = $('#sliceInput');
    $('#sliceDrop').onclick = () => si.click();
    si.onchange = () => {
      const picked = Array.from(si.files);
      si.value = '';
      if (picked.length) safe(handleSliceFiles(picked), '切片导出失败');
    };
    const sd = $('#sliceDrop');
    ['dragover', 'dragenter'].forEach(ev => sd.addEventListener(ev, e => { e.preventDefault(); sd.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(ev => sd.addEventListener(ev, e => { e.preventDefault(); sd.classList.remove('over'); }));
    sd.addEventListener('drop', e => importDropped(e.dataTransfer, 'slice'));
    // v9/v20：备份 / 恢复（跨设备同步）
    $('#backupBtn').onclick = () => safe(exportBackup(), '导出备份失败');
    // v20：恢复先读文件、再让用户选方式（合并 / 覆盖）——覆盖是破坏性操作，不能是唯一选项
    $('#restoreBtn').onclick = () => $('#restoreInput').click();
    $('#restoreInput').onchange = () => safe((async () => {
      const f = $('#restoreInput').files[0];
      $('#restoreInput').value = '';
      if (!f) return;
      let dump;
      try { dump = JSON.parse(await readAsText(f)); }
      catch (e) { toast('备份文件不是有效的 JSON'); return; }
      if (!dump || dump.app !== 'card-quiz' || !Array.isArray(dump.banks)) { toast('备份文件格式不对'); return; }
      pendingDump = dump;
      $('#rmSummary').textContent =
        `备份含 ${dump.banks.length} 个题库 · ${Array.isArray(dump.questions) ? dump.questions.length : 0} 题 · ` +
        `${Array.isArray(dump.progress) ? dump.progress.length : 0} 条学习进度`;
      $('#restoreModal').classList.remove('hidden');
    })(), '读取备份失败');
    $('#rmMerge').onclick = () => safe((async () => {
      if (!pendingDump) return;
      const st = await DB.mergeAll(pendingDump);
      closeRestoreModal();
      toast(`合并完成：新增题库 ${st.banksAdded}、更新 ${st.banksUpdated}、进度合入 ${st.progressMerged + st.progressAdded} 条` +
        (st.duplicateNames ? `；⚠️ ${st.duplicateNames} 个同名题库（两端各自导入过），已都保留` : ''));
      refreshAfterRestore();
    })(), '合并恢复失败');
    $('#rmOverwrite').onclick = () => {
      if (!pendingDump) return;
      if (!confirm('覆盖恢复会清空本机全部题库与学习进度，换成备份内容，继续？')) return;
      safe((async () => {
        await DB.restoreAll(pendingDump);
        closeRestoreModal();
        toast('已按备份覆盖恢复');
        refreshAfterRestore();
      })(), '覆盖恢复失败');
    };
    $('#rmCancel').onclick = closeRestoreModal;
    $('#restoreModal').onclick = (e) => { if (e.target === $('#restoreModal')) closeRestoreModal(); };
    // v9：目录全部折叠 / 展开
    $('#outlineFold').onclick = () => {
      const nodes = Array.from($('#outlineTree').querySelectorAll('.ol-node'));
      const anyOpen = nodes.some(n => !n.classList.contains('collapsed'));
      nodes.forEach(n => n.classList.toggle('collapsed', anyOpen));
      $('#outlineFold').textContent = anyOpen ? '全部展开' : '全部折叠';
    };
    // F1：错题本入口
    $('#wrongEntry').onclick = () => {
      if (!S.bank) return;
      safe(openWrongBook(), '打开错题本失败');
    };
    // F18：弱项专项包入口（一键组卷进刷题）
    $('#weakEntry').onclick = () => {
      if (!S.bank) return;
      safe(startWeakPack(), '组弱项专项包失败');
    };
    // 题库内搜索（v19：120ms 防抖——大题库上每个按键全量重渲列表会卡）
    let searchTimer;
    $('#qSearch').addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => renderQuestionList($('#qSearch').value), 120);
    });
    // 范围选择
    $('#rangeSeg').querySelectorAll('button').forEach(b => b.onclick = () => {
      $('#rangeSeg').querySelectorAll('button').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      $('#chapterPicker').classList.toggle('hidden', b.dataset.v !== 'chapter');
      updateRangeHint();
    });
    $('#rangeCancel').onclick = () => { $('#rangeBar').classList.add('hidden'); clearModeSel(); };
    // v22/v23：音效设置弹层（开关 / 三组音效包 / 震动），🔊 按钮进入
    const sfxBtn = $('#sfxBtn');
    const syncSfxBtn = () => { sfxBtn.textContent = SFX.enabled() ? '🔊' : '🔇'; };
    syncSfxBtn();
    sfxBtn.onclick = openSfxModal;
    function openSfxModal() {
      const setSeg = (seg, on) => seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === on));
      setSeg($('#sfxOnSeg'), SFX.enabled() ? '1' : '0');
      setSeg($('#packSeg'), SFX.getPack());
      const vibeOk = SFX.vibeSupported();
      $('#vibeField').classList.toggle('hidden', !vibeOk);
      if (vibeOk) setSeg($('#vibeSeg'), SFX.getVibe() ? '1' : '0');
      $('#sfxModal').classList.remove('hidden');
    }
    $('#sfxOnSeg').querySelectorAll('button').forEach(b => b.onclick = () => {
      SFX.setEnabled(b.dataset.v === '1');
      $('#sfxOnSeg').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      syncSfxBtn();
      if (SFX.enabled()) SFX.right();      // 开启即给个样品
    });
    $('#packSeg').querySelectorAll('button').forEach(b => b.onclick = () => {
      SFX.setPack(b.dataset.v);
      $('#packSeg').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      SFX.right();                          // 换包即试听
    });
    $('#vibeSeg').querySelectorAll('button').forEach(b => b.onclick = () => {
      SFX.setVibe(b.dataset.v === '1');
      $('#vibeSeg').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      if (SFX.getVibe()) SFX.done();        // 震动开关试一下收尾震感
    });
    $('#sfxModalClose').onclick = () => $('#sfxModal').classList.add('hidden');
    $('#sfxModal').onclick = (e) => { if (e.target === $('#sfxModal')) $('#sfxModal').classList.add('hidden'); };
    // v24：每日目标 —— 点首页「今日 x/y 题」行弹设置（renderHomeStats 重渲，用委托）
    $('#homeStats').addEventListener('click', (e) => {
      if (e.target.closest('#todayRow')) {
        $('#goalSeg').querySelectorAll('button').forEach(b =>
          b.classList.toggle('on', +b.dataset.v === getDailyGoal()));
        $('#goalModal').classList.remove('hidden');
      }
    });
    $('#goalSeg').querySelectorAll('button').forEach(b => b.onclick = () => {
      localStorage.setItem(GOAL_KEY, String(+b.dataset.v));
      $('#goalSeg').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      safe(renderHomeStats(), '刷新统计失败');
    });
    $('#goalModalClose').onclick = () => $('#goalModal').classList.add('hidden');
    $('#goalModal').onclick = (e) => { if (e.target === $('#goalModal')) $('#goalModal').classList.add('hidden'); };
    // v27：考试计划弹层 —— 考试信息 / 目标增删勾 / 一键三阶段
    $('#examSave').onclick = () => safe((async () => {
      const date = $('#examDate').value;
      if (!date) { toast('先选考试日期'); return; }
      await DB.setExam({ name: $('#examName').value.trim() || '考试', date: date });
      toast('考试信息已保存');
      safe(renderExamCard(), '刷新计划失败');
    })(), '保存考试信息失败');
    $('#goalAdd').onclick = () => safe((async () => {
      const title = $('#goalTitle').value.trim();
      const deadline = $('#goalDeadline').value;
      const metric = $('#goalMetric').value;
      let target = parseInt($('#goalTarget').value, 10) || 0;
      if (!title || !deadline) { toast('目标名和截止日期都要填'); return; }
      if (metric === 'manual') target = 1;
      else if (metric !== 'wrong' && !target) { toast('填一下目标数量'); return; }
      await DB.saveGoal({ id: DB.uid(), title: title, deadline: deadline, metric: metric, target: target, scope: 'all' });
      $('#goalTitle').value = ''; $('#goalTarget').value = '';
      await renderGoalList();
      safe(renderExamCard(), '刷新计划失败');
    })(), '添加目标失败');
    $('#goalList').addEventListener('click', (e) => safe((async () => {
      const t = e.target;
      if (t.dataset.del) {
        await DB.deleteGoal(t.dataset.del);
        await renderGoalList();
        safe(renderExamCard(), '刷新计划失败');
      } else if (t.dataset.toggle) {
        const g = (await DB.listGoals()).find(x => x.id === t.dataset.toggle);
        if (g) { g.manualDone = !g.manualDone; await DB.saveGoal(g); await renderGoalList(); }
      }
    })(), '目标操作失败'));
    $('#planGen').onclick = () => safe((async () => {
      const exam = await DB.getExam();
      if (!exam) { toast('先保存考试日期，再生成计划'); return; }
      const sug = DB.planExamGoals(todayStr(), exam.date, await goalDataSnapshot());
      if (!sug.length) { toast('考试日期已是今天或已过，改一下吧'); return; }
      const have = (await DB.listGoals()).length;
      if (have && !confirm('已有 ' + have + ' 个目标，仍追加这 ' + sug.length + ' 条建议目标吗？')) return;
      for (const g of sug) await DB.saveGoal(Object.assign({ id: DB.uid() }, g));
      toast('已生成 ' + sug.length + ' 条目标（可在列表里删除/微调日期）');
      await renderGoalList();
      safe(renderExamCard(), '刷新计划失败');
    })(), '生成计划失败');
    $('#planModalClose').onclick = () => $('#planModal').classList.add('hidden');
    $('#planModal').onclick = (e) => { if (e.target === $('#planModal')) $('#planModal').classList.add('hidden'); };
    // v24：PWA 更新提示 —— 本项目 sw.js 自带 skipWaiting+claim：新版装好后立即接管本页，
    // 但页面资源还是旧的。所以监听 controllerchange（接管信号）弹底部提示条，点「刷新」即用上
    if ('serviceWorker' in navigator) {
      const swc = navigator.serviceWorker;
      // v27 修竞态：原来是启动时一次性快照（const），首装接管若发生在 bind 之后，
      // hadController 永远是 false，之后的真更新也弹不出条。改成动态标记：
      // 第一次接管（首装）静默；此后任何接管都是「更新」
      let hadController = !!swc.controller;
      swc.addEventListener('controllerchange', () => {
        if (hadController) $('#updateBar').classList.remove('hidden');
        hadController = true;
      });
      // 兜底：打开页面时新版已在 waiting（理论上不会发生，防御性保留）
      swc.getRegistration().then((reg) => {
        if (reg && reg.waiting && swc.controller) $('#updateBar').classList.remove('hidden');
      }).catch(() => {});
    }
    $('#updateReload').onclick = () => location.reload();
    $('#updateClose').onclick = () => $('#updateBar').classList.add('hidden');
    // v25：题目编辑弹层（按钮走 document 级委托，见 bindEditButtons）
    bindEditButtons();
    $('#editCancel').onclick = () => $('#editModal').classList.add('hidden');
    $('#editModal').onclick = (e) => { if (e.target === $('#editModal')) $('#editModal').classList.add('hidden'); };
    // v23：断点续刷入口
    $('#resumeGo').onclick = () => resumeSession();
    $('#resumeDrop').onclick = () => { clearResume(); refreshResumeBar(); toast('已放弃上次的进度'); };
    // 深色
    // 状态栏/地址栏染色必须跟 data-theme 走，否则切到深色后顶部还留一条浅色
    const syncThemeColor = () => {
      const dark = document.documentElement.getAttribute('data-theme') === 'dark';
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', dark ? '#24211c' : '#fdfbf6');
    };
    const saved = localStorage.getItem('theme');
    if (saved) document.documentElement.setAttribute('data-theme', saved);
    syncThemeColor();
    $('#themeBtn').onclick = () => {
      const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', cur);
      localStorage.setItem('theme', cur);
      syncThemeColor();
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

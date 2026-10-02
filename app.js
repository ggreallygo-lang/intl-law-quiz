/* app.js — 卡片题库 主控制器 */
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  // v22：iOS Safari 里元素要有 touchstart 监听 :active 才生效——全局挂一个空的，
  // 所有按钮的按压反馈在 iPhone 上就都有了（安卓本来就有，不受影响）
  document.addEventListener('touchstart', function () {}, { passive: true });
  // v22：首次手势预热音频引擎（iOS 自动播放策略），之后程序触发的音（考试告警）才出得了声
  document.addEventListener('pointerdown', function () {
    if (window.SFX) SFX.warm();
    if (window.BGM) BGM.resume();   // v28：背景音乐开着时借首次手势起播（iOS 策略）
  }, { passive: true });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && window.BGM) BGM.stop();
  });
  const TYPE_LABEL = {
    single: '单选题', multiple: '多选题', judge: '判断题',
    term: '名词解释', fill: '填空题', essay: '简答题'
  };
  // v21：模式名（模式卡片选中态 / 练习范围条 / 开始按钮共用）
  const MODE_LABEL = { memorize: '🃏 背题', practice: '✍️ 刷题', exam: '⏱️ 考试' };
  const REVIEW_LABEL = { term: '名词解释', essay: '大题骨架', compare: '选择题易混卡', intro: '第1章导论学习包', chapter02: '第2章国家学习包', chapter03: '第3章个人学习包', chapter04: '第4章领土学习包', chapter05: '第5章海洋法学习包', chapter06: '第6章航空与外空学习包', chapter07: '第7章外交与领事学习包', chapter08: '第8章条约法学习包', chapter09: '第9章国际法律责任学习包', chapter10: '第10章国际组织学习包', chapter11: '第11章人权学习包', chapter12: '第12章和平解决争端学习包', chapter13: '第13章战争与武装冲突学习包' };

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
  let imageUrl = null;
  function showView(name) {
    if (curView === 'study' && name !== 'study') cleanupStudy();
    if (curView === 'images' && imageUrl) {
      $('#savedImage').removeAttribute('src');
      $('#imageDownload').removeAttribute('href');
      URL.revokeObjectURL(imageUrl); imageUrl = null;
    }
    curView = name;
    ['home', 'bank', 'study', 'wrong', 'images'].forEach(v => $('#view-' + v).classList.toggle('hidden', v !== name));
  }
  function cleanupStudy() {
    stopTimer(exam); stopTimer(prac); stopTimer(mem);   // v21：三个模式的计时器统一停
    if (mem && mem.keyHandler) { document.removeEventListener('keydown', mem.keyHandler); mem.keyHandler = null; }   // v32 A6
  }
  function setBack(target, label) {
    S.back = target;
    const b = $('#backBtn');
    b.classList.toggle('hidden', target === 'home');
    b.textContent = label || '‹ 返回';
  }

  // ---------- SM2 记忆曲线 ----------
  // v34.1：核心算法迁至 scheduler.js（纯函数、now/rand 注入，Node 可单测）。
  // 兼容层：app 内引用统一走 Scheduler；lastReviewed 由调用方补（调度器不碰时钟）。
  function sm2Apply(p, q) {
    const r = Scheduler.applyRating(p, q);          // SM-2 + Fuzz + due
    r.state.lastReviewed = Date.now();
    return r.state;
  }

  // ---------- 题库列表（首页） ----------
  async function saveImages(files) {
    let saved = 0;
    for (const file of files) {
      try {
        await DB.saveMedia({ id: 'study-image-' + crypto.randomUUID(), kind: 'study-image', name: file.name, blob: file, createdAt: Date.now() });
        saved++;
      } catch (err) {
        await renderImageLibrary();
        throw new Error('已保存 ' + saved + ' 张；未保存的图片请重新选择。' + err.message);
      }
    }
    await renderImageLibrary();
    toast('已保存 ' + saved + ' 张原图，可在首页打开');
    return saved;
  }
  async function renderImageLibrary() {
    const images = await DB.listMedia('study-image');
    const target = $('#imageLibrary');
    target.replaceChildren();
    if (!images.length) return;
    const heading = document.createElement('h3');
    heading.textContent = '图片资料 · ' + images.length + ' 张';
    const note = document.createElement('p');
    note.className = 'muted';
    note.textContent = '原图仅保存在当前浏览器，题库 JSON 备份不包含原图；请保留源文件或下载备份。';
    target.append(heading, note);
    images.sort((a, b) => b.createdAt - a.createdAt).forEach(record => {
      const button = document.createElement('button');
      button.className = 'image-entry'; button.type = 'button';
      button.textContent = '▧ ' + record.name + ' ›';
      button.onclick = () => safe(openImage(record.id), '打开原图失败');
      target.appendChild(button);
    });
  }
  async function openImage(id) {
    const record = await DB.getMedia(id);
    if (!record || !(record.blob instanceof Blob)) { toast('原图不存在，请重新导入'); return; }
    showView('images');
    setBack('home', '‹ 首页'); $('#backBtn').classList.remove('hidden');
    $('#title').textContent = '图片资料'; $('#imageName').textContent = record.name;
    imageUrl = URL.createObjectURL(record.blob);
    const img = $('#savedImage');
    $('#imageStatus').textContent = '正在打开原图…';
    img.onload = () => { $('#imageStatus').textContent = img.naturalWidth + ' × ' + img.naturalHeight + ' · 放大后可左右、上下滑动查看'; };
    img.onerror = () => { $('#imageStatus').textContent = '无法显示此图片，请下载原图检查文件是否损坏。'; };
    img.alt = record.name; img.style.width = '100%'; img.src = imageUrl;
    $('#imageZoom').value = '100';
    $('#imageZoom').onchange = () => { img.style.width = $('#imageZoom').value + '%'; };
    const link = $('#imageDownload'); link.href = imageUrl; link.download = record.name;
    $('#imageDelete').onclick = () => safe((async () => {
      if (!confirm('删除这张本机原图？请先确认已保存源文件。')) return;
      await DB.deleteMedia(id);
      showView('home'); setBack('home'); $('#title').textContent = '国际法题库';
      await renderHome(); toast('已删除本机原图，源文件不受影响');
    })(), '删除原图失败');
  }
  async function renderHome() {
    const banks = await DB.listBanks();
    safe(renderImageLibrary(), '加载原图失败');
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
        `<span class="del" data-del="${b.id}">删除</span><span class="ren" data-ren="${b.id}">改名</span>` +
        `<div class="name">${esc(b.name)}</div>` +
        `<div class="meta">${b.count || 0} 题 · 更新于 ${date}</div>`;
      div.addEventListener('click', (e) => {
        if (e.target.dataset.del) { e.stopPropagation(); confirmDelete(e.target.dataset.del, b.name); return; }
        if (e.target.dataset.ren) {          // v30：题库改名（只动名字，题目/进度不动）
          e.stopPropagation();
          const name = prompt('给题库改个名字：', b.name);
          if (name == null) return;
          safe((async () => {
            const nb = await DB.renameBank(b.id, name);
            if (!nb) { toast('题库不存在了，刷新一下'); return; }
            toast('已改名：' + nb.name);
            await renderHome();
          })(), '改名失败');
          return;
        }
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
    const streakInfo = DB.streakForgiving ? DB.streakForgiving(sess) : { days: DB.streakDays(sess), frozen: 0 };   // v32 A5：宽恕口径
    const h = Math.floor(t.ms / 3600000);
    const m = Math.round((t.ms % 3600000) / 60000);
    const dur = h > 0 ? `${h} 小时 ${m} 分` : (m > 0 ? `${m} 分钟` : `${Math.round(t.ms / 1000)} 秒`);
    const today = (DB.dailyCounts(sess, 1)[0] || {}).count || 0;
    const goal = getDailyGoal();
    const pct = Math.min(100, Math.round(today / goal * 100));
    // v32 A5：近 14 天热图（Anki Heatmap 同款心理——打卡轨迹可见，损失规避防断签）
    const heat = DB.dailyCounts(sess, 14).map(d =>
      `<span class="hh hh${d.count ? Math.min(3, Math.ceil(d.count / 15)) : 0}" title="${d.day}：${d.count || 0} 题"></span>`).join('');
    box.innerHTML =
      `<div class="hs-main">📊 累计做题 <b>${t.count}</b> 题 · 累计 ${dur} · 连续打卡 <b>${streakInfo.days}</b> 天` +
      (streakInfo.frozen ? `<span class="muted" style="font-size:12px">（含 ${streakInfo.frozen} 次冻结）</span>` : '') + `</div>` +
      `<div class="hs-heat">${heat}<span class="hh-lab">近14天</span></div>` +
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

  // ---------- v34.3：题库清洗规则（写给外部 AI 的导入规范，设置里可导出） ----------
  // 容错口径：文档强调「推荐写法+自动容错」，不是要求一字不差（用户明确要求）
  const CLEAN_RULES_MD = "# LEXA 题库导入规范（清洗规则·容错版 v2）\n\n> 写给 AI 或人工：把脏资料（Word/PDF/网页/笔记）整理成 LEXA 刷题 App 可导入的 Markdown。\n> **先说结论：App 的解析器有五层自动清洗和容错，以下都是「推荐写法」而非硬性要求——\n> 大方向对了就能导入，细节 App 会自动兜底。** 只有第三节的两条是硬性的。\n\n## 一、App 会自动容错的事（你不用操心）\n\n1. **水印/推广自动删**：公众号、微信号、扫码关注、更多资料、免费领取、QQ群等\n   整行自动剥离；标题尾部括号里的水印片段自动剪掉。\n2. **页眉页脚自动删**：「国际法试题 第1页(共5页)」这类短行。\n3. **考卷套话自动删**：「绝密★启用前」「注意事项：」等。\n4. **行内选项自动拆**：「A.北京 B.上海 C.广州 答案B」挤在一行也能识别。\n5. **卷尾答案自动回填**：试卷末尾集中答案区（「1.B 2.AC 3.对」）按题号自动配对。\n6. **格式随意**：CRLF/LF 换行、全角半角标点、题号 1. / 1、/ 1． / 一、 / １. 都行\n   （全角数字和字母自动归一）；选项键大小写随意（自动转大写并校验连续性）。\n7. **缺答案不丢题**：没识别到答案的题保留并标「⚠️ 没识别到答案」，可在 App 内\n   点 ✏️ 补上——所以**宁缺答案也不要编造答案**。\n8. **多级章节自动建树**：## ### #### 任意层级，背题卡自动带章节路径。\n9. **话术问答体直接导入（v2 新增）**：「1. 旅客：在哪里打车？/ 回答：您好……」\n   这种带编号的问答，**原样粘贴即可**，「回答：」自动识别为答案行。\n10. **无编号问答自动切题（v2 新增）**：整篇没有题号、只有「旅客：…/回答：…」\n    或「问：…/答：…」「Q:/A:」的访谈/话术原稿，App 自动按问答对切题加编号。\n\n## 二、推荐写法（六种题型，照抄结构即可）\n\n### 单选题 / 多选题（自动识别）\n1. 题干文字\n   A. 选项一\n   B. 选项二\n   C. 选项三\n   D. 选项四\n   答案：A\n\n（多选写「答案：ABC」；选项分行或挤一行都行。）\n\n### 判断题\n1. 题干陈述句\n   答案：对\n\n（对/错、正确/错误、√/×、T/F 都认。）\n\n### 填空题\n1. 《联合国宪章》第2条规定了（　）项原则。\n   答案：7\n\n（或直接写「……规定了（7）项原则。」；含「共N分/本大题/每小题/答题卡」的\n括号是试卷套话，自动忽略。）\n\n### 名词解释（翻卡：正面术语/背面定义）\n1. 领海：国家主权及于其陆地领土及内水以外邻接的领海……\n\n### 简答题 / 论述 / 背书问答（自评卡：先想后翻，背话术最合适）\n1. 旅客：我在这里打车，车会上来接我吗？\n   答案：您好，您可以联系司机确认……（完整话术，可多行多段）\n\n（「回答：」「答：」都行；分支情况用【】标记写进答案，如\n【如遇旅客不清楚航班】您好，……）\n\n## 三、仅有的两条硬性要求\n\n1. **纯文本 Markdown、UTF-8 编码**（Word 另存 .txt/.md 或直接粘贴文本；\n   App 不解析图片、表格、公式——转成文字描述或删除）。\n2. **题与题之间要有可切分的边界**：编号 / 问答对（旅客：/问：/Q:）二者必有其一。\n   既没编号又不是问答体的无结构大段文字，会被当成名词解释或忽略——这是唯一\n   会丢内容的坑（保底办法：给每题加个 1. 2. 3. 编号即可）。\n\n## 四、清洗源头时建议顺手做的（不做 App 也会兜）\n\n- 删掉图片/表格/公式。\n- 修正明显 OCR 乱码（同音字、断行断字）。\n- 段落按题目断行，别整篇连一行。\n\n## 五、交付自检（30 秒）\n\n- 导入后 App 首页题数 ≈ 你整理的题数（差几道去查边界缺失）。\n- 点开题库没有大片「⚠️ 没识别到答案」。\n- 目录树层级符合预期。\n\n（本规范由 LEXA App 导出生成，与当前版本解析引擎一致；解析器持续增强容错，\n新格式建议先小样试导。）\n";

  // ---------- v31：跨库刷题（多题库混合 + 题型筛选） ----------
  const MIX_TYPE_SETS = { choice: ['single', 'multiple'], judge: ['judge'], essay: ['essay', 'term', 'fill'] };
  function openHomeView() {                   // 跨库刷题结束回首页（没有具体题库可回）
    $('#title').textContent = '国际法题库';
    showView('home');
    safe(renderHome(), '刷新列表失败');
  }
  function mixTypeSel() {
    const b = $('#mixTypeSeg').querySelector('button.on');
    return b ? b.dataset.v : 'all';
  }
  async function openMixModal() {
    const banks = await DB.listBanks();
    if (!banks.length) { toast('先导入至少一个题库'); return; }
    $('#mixBanks').innerHTML = banks.map(b =>
      `<label class="ck-row"><input type="checkbox" data-id="${esc(b.id)}" checked>` +
      `<span>${esc(b.name)}（${b.count || 0} 题）</span></label>`).join('');
    $('#mixBanks').querySelectorAll('input').forEach(i => i.onchange = updateMixHint);
    updateMixHint();
    $('#mixModal').classList.remove('hidden');
  }
  async function updateMixHint() {
    const ids = Array.from($('#mixBanks').querySelectorAll('input:checked')).map(i => i.dataset.id);
    const t = mixTypeSel();
    let qs = [];
    for (const id of ids) qs = qs.concat((await DB.listQuestions(id)) || []);
    const set = MIX_TYPE_SETS[t];
    const n = set ? qs.filter(q => set.indexOf(q.type) >= 0).length : qs.length;
    $('#mixHint').textContent = ids.length
      ? `已选 ${ids.length} 个题库 · ${t === 'all' ? '全部题型' : (t === 'choice' ? '选择题' : (t === 'judge' ? '判断题' : '主观题'))} 共 ${n} 题`
      : '至少勾选一个题库';
    return { ids, n };
  }
  async function startMixed() {
    const { ids, n } = await updateMixHint();
    if (!ids.length) { toast('至少勾选一个题库'); return; }
    if (!n) { toast('所选题型在这些题库里没有题'); return; }
    let qs = [];
    for (const id of ids) qs = qs.concat((await DB.listQuestions(id)) || []);
    const set = MIX_TYPE_SETS[mixTypeSel()];
    S.pool = set ? qs.filter(q => set.indexOf(q.type) >= 0) : qs;
    S.mixed = true;                           // 跨库态：进度/流水按各题自带的 bankId 落库
    const ob = $('#mixOrderSeg').querySelector('button.on');
    $('#mixModal').classList.add('hidden');
    startPractice({ title: `跨库刷题（${ids.length} 库 · ${S.pool.length} 题）`, order: ob ? ob.dataset.v : 'rand' });
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
    S.mixed = false;                          // v31：进具体题库即退出跨库混合态
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
    wb = { progs: progs, qmap: qmap, type: null, chapter: null, view: 'active' };   // v30：三视图 active/grad/dismissed
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
      graduated: wb.view === 'grad',
      dismissed: wb.view === 'dismissed'
    });
  }

  function wbChips(kind, pairs, cur) {
    // pairs: [[值, 显示名, 数量], ...]，值 '' 表示「全部」
    return `<div class="wb-filters">` + pairs.map(p =>
      `<button class="wb-chip${(cur || '') === p[0] ? ' on' : ''}" data-kind="${kind}" data-v="${esc(p[0])}">${esc(p[1])}${p[2] != null ? ' ' + p[2] : ''}</button>`
    ).join('') + `</div>`;
  }

  // v30：相对时间（错题历史行用）——「刚刚 / N 分钟前 / N 小时前 / N 天前 / 日期」
  function agoStr(ts) {
    if (!ts) return '—';
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 90) return '刚刚';
    if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
    if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
    if (s < 86400 * 30) return Math.floor(s / 86400) + ' 天前';
    return new Date(ts).toLocaleDateString();
  }

  function renderWrongBook() {
    const view = $('#view-wrong');
    const active = DB.pickWrong(wb.progs, { questionMap: wb.qmap });
    const grad = DB.pickWrong(wb.progs, { questionMap: wb.qmap, graduated: true });
    const dismissed = DB.pickWrong(wb.progs, { questionMap: wb.qmap, dismissed: true });   // v30：手动移除的也有家了

    // 筛选项从「当前视图实际有错题的范围」里长出来，避免列出一堆空章节
    const base = (wb.view === 'grad') ? grad : (wb.view === 'dismissed' ? dismissed : active);
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

    let html = `<div class="bank-summary">`;
    if (wb.view === 'grad') {
      html += `<div class="sum-main"><b>${items.length}</b> 道已毕业 🎓</div>` +
        `<div class="sum-sub">自动移除规范：连对 ${DB.wrongGradN()} 次自动移出「进行中」，历史统计保留；点「重新练习」收回活跃</div>`;
    } else if (wb.view === 'dismissed') {
      html += `<div class="sum-main"><b>${items.length}</b> 道已手动移除 🗑</div>` +
        `<div class="sum-sub">手动移除规范：本人确认后才移出「进行中」，下次答错自动回来；随时可点「恢复」</div>`;
    } else {
      html += `<div class="sum-main"><b>${items.length}</b> 道错题进行中` +
        `${grad.length ? ` · 已毕业 ${grad.length} 🎓` : ''}${dismissed.length ? ` · 已移除 ${dismissed.length} 🗑` : ''}</div>` +
        `<div class="sum-sub">规范：连对 ${DB.wrongGradN()} 次自动移除（毕业）· 手动移除需确认、可恢复 · 按「错误次数→最近答错」排序</div>`;
    }
    html += `</div>`;
    // v30：三视图切换（进行中 / 已毕业 / 已移除）
    html += `<div class="wb-filters">` +
      `<button class="wb-chip${wb.view === 'active' ? ' on' : ''}" data-kind="view" data-v="">进行中 ${active.length}</button>` +
      `<button class="wb-chip${wb.view === 'grad' ? ' on' : ''}" data-kind="view" data-v="grad">已毕业 ${grad.length}</button>` +
      `<button class="wb-chip${wb.view === 'dismissed' ? ' on' : ''}" data-kind="view" data-v="dismissed">已移除 ${dismissed.length}</button>` +
      `</div>`;
    if (wb.view === 'active') {
      if (typePairs.length > 2) html += wbChips('type', typePairs, wb.type);
      if (chapPairs.length > 2) html += wbChips('chapter', chapPairs, wb.chapter);
      html += `<div class="wb-actions">` +
        `<button class="btn" id="wbPractice"${items.length ? '' : ' disabled'}>✍️ 刷错题</button>` +
        `<button class="btn secondary" id="wbMemorize"${items.length ? '' : ' disabled'}>🃏 背错题</button>` +
        `</div>`;
    }
    // v30：历史记录行——错/对次数、连对进度、最近答错时间，一眼看清这道题的过往
    const histLine = (it) => {
      if (wb.view === 'grad') return `曾错 ${it.wrong} · 曾对 ${it.right} · ${agoStr(it.lastWrong)}答错过`;
      if (wb.view === 'dismissed') return `曾错 ${it.wrong} · 曾对 ${it.right} · ${agoStr(it.lastWrong)}答错过`;
      return `错 ${it.wrong} · 对 ${it.right} · 连对 ${it.streak || 0}/${DB.wrongGradN()} · ${agoStr(it.lastWrong)}答错`;
    };
    html += items.length
      ? `<div class="qlist">` + items.map(it =>
        `<div class="wb-item" data-qid="${esc(it.qid)}">` +
        `<div class="wb-head">` +
        (wb.view === 'grad'
          ? `<span class="wb-badge wb-badge-grad">🎓 已毕业</span><button class="wb-remove wb-restore" type="button">重新练习</button>`
          : wb.view === 'dismissed'
            ? `<span class="wb-badge wb-badge-del">🗑 已移除</span><button class="wb-remove wb-restore" type="button">恢复</button>`
            : `<span class="wb-badge">错 ${it.wrong} 次${it.right ? ' · 对 ' + it.right + ' 次' : ''}</span>` +
              `<button class="wb-remove" type="button">移除</button>`) +
        `</div>` +
        `<div class="wb-hist">📋 ${histLine(it)}</div>` +
        questionCardHtml(it.question) + `</div>`).join('') + `</div>`
      : `<div class="empty">${wb.view === 'grad' ? '还没有毕业的错题——连续答对 ' + DB.wrongGradN() + ' 次就会出现在这里 🎓'
          : wb.view === 'dismissed' ? '没有被手动移除的错题。移除前会征求确认，移除后随时可恢复。'
          : (base.length ? '这个筛选条件下没有错题' : '还没有错题，去刷题或考试攒一攒 👆')}</div>`;
    view.innerHTML = html;

    view.querySelectorAll('.wb-chip').forEach(b => {
      b.onclick = () => {
        if (b.dataset.kind === 'view') {
          if (b.dataset.v === wb.view) return;
          wb.view = b.dataset.v || 'active';
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
      b.onclick = () => (wb.view !== 'active')
        ? safe(restoreWrongItem(qid), '收回失败')
        : safe(removeWrong(qid), '移除失败');
    });
    if (wb.view === 'active' && items.length) {
      const list = items.map(it => it.question);
      $('#wbPractice').onclick = () => startMode('practice', list, { title: '刷错题' });
      // 背错题不做 SM2 due 过滤：错题就是要全部过一遍
      $('#wbMemorize').onclick = () => startMode('memorize', list, { title: '背错题', all: true });
    }
  }

  async function restoreWrongItem(qid) {
    const ok = await DB.restoreWrong(qid, S.bank.id);
    if (!ok) { toast('这道题的进度记录不在了'); return; }
    toast(wb.view === 'dismissed' ? '已恢复到「进行中」' : '已收回活跃清单，继续加油');
    wb.progs = await DB.listProgress(S.bank.id);
    renderWrongBook();
    await safe(refreshWrongCount(), '刷新错题数失败');
  }

  async function removeWrong(qid) {
    // v30：手动移除须本人确认（移除规范：不删任何统计，只是移出「进行中」；下次答错自动回来）
    if (!confirm('同意移除这道错题吗？\n\n· 只移出「进行中」，历史统计保留\n· 下次答错会自动回来\n· 随时可在「已移除」里恢复')) return;
    const ok = await DB.setWrongDismissed(qid, S.bank.id, true);
    if (!ok) { toast('这道题的进度记录不在了'); return; }
    toast('已移出「进行中」，可在「已移除」里恢复');
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
  // v32 A1：每日限额（localStorage，默认新卡 20 / 复习 100，0=不限）+ 当日已背计数
  const LIM_NEW_KEY = 'limit-new', LIM_REV_KEY = 'limit-review', MEMDAY_KEY = 'memday';
  // v34.2 抽查池（架构评审 Q3：答对≠永久免检）：客观题答对进低频抽查，
  // 间隔 30→90→180→360 天逐级拉长；抽查时忘了就转回主动复习（inSrs）
  const SAMPLE_DAYS = [30, 90, 180, 360];
  function getLimit(key, dft) {
    const n = parseInt(localStorage.getItem(key) || '', 10);
    return (isNaN(n) || n < 0) ? dft : n;
  }
  function memDay() {
    const today = DB.dayKey(Date.now());
    try {
      const o = JSON.parse(localStorage.getItem(MEMDAY_KEY) || 'null');
      if (o && o.day === today) return o;
    } catch (e) {}
    return { day: today, review: 0, fresh: 0 };
  }
  function bumpMemDay(kind) {
    const c = memDay();
    c[kind] = (c[kind] || 0) + 1;
    try { localStorage.setItem(MEMDAY_KEY, JSON.stringify(c)); } catch (e) {}
  }

  async function startMemorize(opts) {
    opts = opts || {};
    stopTimer(mem);                        // v21：防上一轮的 interval 泄漏
    const progs = await DB.listProgress(S.bank.id);
    const now = Date.now();
    const limRev = getLimit(LIM_REV_KEY, 100);   // 0 = 不限量（只用于截取队列长度，绝不作除数）
    // v33.1 F03/F04（架构评审）：断签宽恕改在「队列层」处理——按到期先后排序、
    // 今天从最旧的开始背，但**绝不改写任何 due**（v32 的自动分期在不限量时除零
    // 产生 Infinity due，属无效日期）；欠账是真实存在的，限额截断时在完成页如实
    // 告知剩余量，不用改 due 美化。
    // F04 旧数据兼容：v32 前的 progress 没有 inSrs 字段，按学习证据推导复习资格，
    // 不让老复习题掉出「新卡/复习」两个队列（读时推导，不改写历史数据）
    const activeState = (p) => !!(p && (p.inSrs || (p.reps || 0) > 0 || (p.interval || 0) > 0 ||
      p.lastReviewed || (p.practice && (p.practice.wrong || 0) > 0) || (p.exam && (p.exam.wrong || 0) > 0)));
    const dueOf = (p) => (p && isFinite(p.due)) ? p.due : now;   // 无效日期按待复习处理（可见，不静默消失）
    const map = {}; progs.forEach(p => map[p.qid] = p);
    // opts.all：错题本进来时不按记忆曲线过滤，错的全部过一遍
    const dueList = opts.all ? S.pool.slice() : S.pool.filter(q => !map[q.id] || map[q.id].due <= now);
    let list;
    let title = opts.title || '背题';
    let donePage = null;                   // v32 A1：限额到顶 → 今日完成页
    if (opts.plan === 'all') {
      // v30：全书过卡（系统方案）——到期卡优先，其余按目录原顺序跟上；
      // 每张照常评分走 SM-2，记住间隔翻倍、忘记明天重来，整本书按记忆曲线滚动作息
      // （用户点名要整本过，不吃每日限额）
      const dueSet = new Set(dueList.map(q => q.id));
      const rest = S.pool.filter(q => !dueSet.has(q.id));
      list = dueList.concat(rest);
      title = opts.title || '背书·全书过卡';
    } else if (opts.all) {
      list = shuffle(dueList);
    } else {
      // v32 A1：到期复习受每日限额保护——复习 limRev / 新卡 limNew，今天已背的先扣掉
      const day = memDay();
      const limNew = getLimit(LIM_NEW_KEY, 20);
      const reviewing = S.pool.filter(q => activeState(map[q.id]));          // v33.1 F04：推导口径
      const fresh = S.pool.filter(q => !map[q.id]);
      const reviewLeft = limRev ? Math.max(0, limRev - (day.review || 0)) : Infinity;   // 0=不限量显式分支
      const freshLeft = limNew ? Math.max(0, limNew - (day.fresh || 0)) : Infinity;
      // v33.1 F03：复习队列按到期先后排（积压最旧的先见），不 shuffle、不写 due
      const rawReview = reviewing.filter(q => dueOf(map[q.id]) <= now)
        .sort((x, y) => dueOf(map[x.id]) - dueOf(map[y.id]));
      // v34.2：抽查池到期卡并入（排在真复习之后，占用复习限额；量小不挤兑）
      const samplingDue = S.pool.filter(q => {
        const p = map[q.id];
        return p && !p.inSrs && p.enrollment === 'sampling' && dueOf(p) <= now;
      }).sort((x, y) => dueOf(map[x.id]) - dueOf(map[y.id]));
      rawReview.push(...samplingDue);
      const rawFresh = shuffle(fresh);
      list = rawReview.slice(0, reviewLeft).concat(rawFresh.slice(0, freshLeft));
      // 限额到顶但确实还有活 → 今日完成页（庆祝 + 预告明天）
      if (!list.length && (rawReview.length || rawFresh.length)) {
        donePage = { today: (day.review || 0) + (day.fresh || 0),
                     tomorrow: rawReview.length + Math.min(rawFresh.length, limNew || rawFresh.length) };
      }
    }
    mem = { list: list, i: 0, map, startAt: Date.now(), timer: null, title: title, maxSeen: 1, skippedN: 0, review: false, undoStack: [], donePage: donePage };
    setBack('bank', '‹ 题库');
    $('#title').textContent = title;
    renderMemorize();
  }
  function renderMemorize() {
    const view = $('#view-study'); showView('study');
    if (mem) mem.locked = false;          // v14：每题渲染时解锁，防止连点跳两题
    if (mem.keyHandler) { document.removeEventListener('keydown', mem.keyHandler); mem.keyHandler = null; }   // v32 A6：换卡/离开时摘掉快捷键
    if (mem.donePage) {                   // v32 A1：每日限额到顶——「今日完成」仪式页（Anki 式闭合感）
      const d = mem.donePage;
      stopTimer(mem);
      clearResume();
      SFX.done();
      view.innerHTML = `<div class="empty"><div style="font-size:44px">🎯</div>今日任务完成！<br>` +
        `<span class="muted">今天已背 ${d.today} 张 · 明天约有 <b>${d.tomorrow}</b> 张到期<br>到点会自动安排，不用惦记</span></div>` +
        `<div class="btn-row" style="margin-top:16px">` +
        `<button class="btn" onclick="location.reload()">返回</button>` +
        `<button class="btn secondary" id="memMore">再背一组（不限额）</button></div>`;
      $('#memMore').onclick = () => startMemorize({ plan: 'all', title: '加练·不限额' });
      return;
    }
    if (mem.i >= mem.list.length) {
      const used = fmtElapsed(Date.now() - (mem.startAt || Date.now()));
      stopTimer(mem);                     // v21：本轮计时停止
      clearResume();                      // v23：背完清档
      SFX.done();                         // v22：背完收尾音
      view.innerHTML = `<div class="empty"><div style="font-size:40px">🎉</div>本轮背完啦！<br><span class="muted">按记忆曲线，该复习的都过了一遍 · 用时 ${used}` +
        (mem.skippedN ? ` · 跳过 ${mem.skippedN} 张（仍按原曲线安排）` : '') + `</span></div>
        <button class="btn" onclick="location.reload()">返回</button>`;
      return;
    }
    const q = mem.list[mem.i];
    const total = mem.list.length;
    saveResume('memorize', mem);     // v23：每卡存档，退出可续
    // v32 A2：评分按钮预览下次间隔（Anki 调研——让每个选择的后果可见）
    // v34.1：走 Scheduler.previewIntervals（名义间隔；实际评分另有 ±5% 抖动，预览为近似值）
    const pvBase = mem.map[q.id] || { qid: q.id, bankId: S.bank.id, ease: 2.5, interval: 0, reps: 0, due: 0, lapses: 0 };
    const memPv = {};
    if (pvBase && !pvBase.inSrs && pvBase.enrollment === 'sampling') {
      // v34.2：抽查卡的按钮语义——忘了转重点复习；通过则拉长抽查间隔
      const next = SAMPLE_DAYS[Math.min((pvBase.sampleStep || 0) + 1, SAMPLE_DAYS.length - 1)];
      memPv[1] = '(转重点复习)';
      memPv[3] = memPv[5] = '(' + next + '天后再查)';
    } else {
      const pv = Scheduler.previewIntervals(pvBase);
      [1, 3, 5].forEach(qv => {
        const iv = pv[qv];
        memPv[qv] = '(' + (iv >= 1 ? iv + '天' : '当天') + ')';
      });
    }
    // v28：卡片带章节路径面包屑（背书场景一眼知道在背哪个岗位的话术）
    const chapterLine = (q.chapterPath && q.chapterPath.length)
      ? `<div class="card-chapter">📖 ${esc(q.chapterPath.join(' › '))}</div>` : '';
    // v28：答案面把题目再显示一遍——翻面后不用来回翻就能对着问题背答案
    const stemMini = (q.type === 'term')
      ? `<div class="card-stem-mini">${esc(q.term)}</div>`
      : `<div class="card-stem-mini">${esc(q.stem)}</div>`;
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
    const lawCard = (window.LAW_CARDS || []).concat(window.LAW_REVIEW || []).find(card =>
      (q.chapterId === card.id || q.chapter === card.chapter) && q.explanation === '记忆抓手：' + card.cue &&
      (q.type === 'term' ? q.term === card.front && q.definition === card.back : q.type === 'essay' && q.stem === card.front && q.answer === card.back));
    if (lawCard && lawCard.map) {
      front = `<div class="tag">${esc(REVIEW_LABEL[lawCard.kind] || '导图回忆卡')}</div><div class="stem">${esc(lawCard.front)}</div>` +
        `<div class="map-recall"><span>${esc(lawCard.map.center)}</span><p>闭眼想一想：能说出哪 ${lawCard.map.branches.length} 条主干？</p></div>`;
      back = `<div class="law-mindmap" role="group" aria-label="${esc(lawCard.map.center)}思维导图">` +
        `<div class="map-center">${esc(lawCard.map.center)}</div><div class="map-branches">` +
        lawCard.map.branches.map((branch, i) => `<details class="map-branch map-color-${i % 3}" open>` +
          `<summary><span class="map-index">${pad2(i + 1)}</span>${esc(branch.title)}</summary>` +
          `<ul>${branch.items.map(item => `<li>${esc(item)}</li>`).join('')}</ul></details>`).join('') + `</div></div>` +
        `<div class="map-cue">记忆线：${esc(lawCard.cue)}</div>` +
        `<details class="map-explanation"><summary>展开完整解释</summary><div class="def">${esc(lawCard.back)}</div></details>`;
      if (lawCard.sources && lawCard.sources.length) {
        back += '<details class="map-explanation"><summary>核对依据与出处</summary><p class="muted">自编学习要点，不代替指定教材或官方评分答案。</p>' +
          lawCard.sources.filter(source => /^https:\/\//.test(source.url)).map(source =>
            `<p><a href="${esc(source.url)}" target="_blank" rel="noopener noreferrer">${esc(source.title)}</a></p>`).join('') + '</details>';
      }
    }
    // v14：真 3D 翻转结构 —— 正反面同时渲染、grid 叠放，翻面只是加 .flipped 转 180°
    // （旧版是 innerHTML 硬塞 front+back，没有任何转场，被用户吐槽"假翻转"）
    view.innerHTML =
      `<div class="progress-top"><span class="pnum">${mem.i + 1}/${total}</span>` +
      `<span class="mtimer" id="mtTimer">⏱ ${fmtElapsed(Date.now() - (mem.startAt || Date.now()))}</span>` +
      `<div class="progress-bar"><span style="width:${(mem.i / total) * 100}%"></span></div></div>` +
      `<div class="study-body slide-in">` +
      `<div class="flip3d${lawCard ? ' law-map-card' : ''}" id="card">` +
        `<div class="flip3d-inner">` +
          `<div class="flip-face flip-front">${chapterLine}${front}</div>` +
          `<div class="flip-face flip-back">${chapterLine}<div class="tag">答案</div>${stemMini}${back}</div>` +
        `</div>` +
      `</div>` +
      `<div class="flip-hint" id="flipHint">点击卡片或下方按钮翻面看答案</div>` +
      `<button class="btn" id="flipBtn" style="margin-top:14px">显示答案</button>` +
      // v28：上一题（回看）/ 跳过（不评分、按原记忆曲线明天再来）
      `<div class="eq-row" style="margin-top:10px">` +
        `<button class="btn secondary" id="memPrev"${mem.i === 0 ? ' disabled' : ''}>‹ 上一题</button>` +
        `<button class="btn secondary" id="memSkip">跳过 ›</button>` +
      `</div>` +
      `<div id="rateArea" class="hidden">` +
      `<div class="rate-row">` +
      `<button class="btn rate-forget" data-q="1">😵 忘记${memPv[1]}</button>` +
      `<button class="btn rate-dim" data-q="3">🤔 模糊${memPv[3]}</button>` +
      `<button class="btn rate-know" data-q="5">😎 记住${memPv[5]}</button>` +
      `</div>` +
      `<div class="rate-sub">键盘 1/2/3 评分 · Z 撤销上一张` +
      (mem.undoStack && mem.undoStack.length ? ` · <button id="memUndo" class="linkbtn">↩︎ 撤销（${mem.undoStack.length}）</button>` : ``) +
      `</div></div>` +
      `</div>`;
    // v28：回看判定——处于回看状态且还没走到最前的那张卡时，只展示不评分
    mem.maxSeen = Math.max(mem.maxSeen || 1, mem.i + 1);
    if (mem.i >= (mem.maxSeen || 1) - 1) mem.review = false;
    const reviewing = !!mem.review && mem.i < (mem.maxSeen || 1) - 1;
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
    $('#memPrev').onclick = () => {
      if (mem.locked || mem.i === 0) return;
      mem.locked = true;
      mem.review = true;
      mem.i--; renderMemorize();
    };
    $('#memSkip').onclick = () => {
      if (mem.locked) return;
      mem.locked = true;
      SFX.flip();
      mem.skippedN = (mem.skippedN || 0) + 1;
      mem.i++; renderMemorize();
    };
    if (reviewing) {
      // 回看：直接翻到答案面、不出评分按钮（评分会重复写 SM-2，回看只看不改）
      flipped = true;
      $('#card').classList.add('flipped');
      $('#flipBtn').classList.add('hidden');
      $('#flipHint').textContent = '📖 回看上一张 · 用下方按钮继续，回到最前一张后恢复评分';
      $('#flipHint').classList.remove('hidden');
    } else {
      mem.renderedAt = Date.now();   // F2：展示→自评的耗时起点
      $('#flipBtn').onclick = flip;
      $('#card').onclick = flip;
    }
    startTimerChip(mem);           // v21：本轮用时 chip（回看也照常走会话计时）
    const rateCard = async (qv) => {
      if (mem.locked) return;              // v14：写库期间锁点击，防连点跳两题
      mem.locked = true;
      if (qv <= 1) SFX.wrong();            // v22：自评音效——忘记/模糊/记住
      else if (qv >= 5) SFX.right();
      else SFX.neutral();
      let p = mem.map[q.id] || { qid: q.id, bankId: S.bank.id, ease: 2.5, interval: 0, reps: 0, due: 0, lapses: 0 };
      // v32 A6：撤销栈——评分前快照（限 10 层），误评可回滚（SM-2 的 EF 被错评污染代价高）
      // v33.2 F05：快照补 existed（原记录是否本不存在——撤销时删掉不留空壳）+ sessionId（撤销时作废流水）
      mem.undoStack = mem.undoStack || [];
      const existed = !!mem.map[q.id];
      const sid = DB.uid();
      mem.undoStack.push({ idx: mem.i, prev: JSON.parse(JSON.stringify(p)), wasNew: !existed, existed: existed, sessionId: sid });
      if (mem.undoStack.length > 10) mem.undoStack.shift();
      const samplingCard = !p.inSrs && p.enrollment === 'sampling';   // v34.2 抽查池
      if (samplingCard && qv > 1) {
        // 抽查通过：间隔逐级拉长（30→90→180→360 天），不进高频循环
        p.sampleStep = Math.min((p.sampleStep || 0) + 1, SAMPLE_DAYS.length - 1);
        p.due = Date.now() + SAMPLE_DAYS[p.sampleStep] * 86400000;
        p.lastReviewed = Date.now();
      } else {
        if (samplingCard) p.inSrs = true;  // 抽查忘了 → 转回主动复习
        p = sm2Apply(p, qv);               // v34.1：SM-2+Fuzz+due 一体（scheduler.js）
        p.inSrs = true;                    // v32 A3：评过分的卡正式进入记忆曲线循环
      }
      mem.map[q.id] = p;
      // v33.2 F06：进度+流水一个事务落库；失败=整体没写，解锁让用户重点（重试不重复计数）
      try {
        await DB.commitStudy([p], [{ id: sid, bankId: S.bank.id, qid: q.id, mode: 'memorize',
          right: qv >= 3, ms: Date.now() - (mem.renderedAt || Date.now()), ts: Date.now() }]);
      } catch (e) {
        reportErr('保存失败，请再评一次', e);
        mem.undoStack.pop();
        mem.locked = false;
        return;
      }
      bumpMemDay(wasNewFlag(mem.undoStack) ? 'fresh' : 'review');   // v32 A1：当日计数（保存成功才计）
      // v34.1 当日重学（架构评审 6.2）：评「忘记」的卡不就此别过——插回队列隔 ≥3 张
      // 其他卡后重见（防照抄答案的掌握假象）；同一会话每卡最多重学一次防死循环；
      // 重学评分照常写流水（总尝试计入，新卡额度不重复吃）
      if (qv <= 1 && mem.list.length > 1) {
        mem.relearned = mem.relearned || {};
        if (!mem.relearned[q.id]) {
          mem.relearned[q.id] = true;
          const at = Math.min(mem.i + 4, mem.list.length);
          mem.list.splice(at, 0, q);
        }
      }
      mem.i++; renderMemorize();
    };
    function wasNewFlag(stack) { return stack[stack.length - 1].wasNew; }
    const doUndo = async () => {
      if (!mem.undoStack || !mem.undoStack.length || mem.locked) return;
      const snap = mem.undoStack.pop();
      mem.locked = true;
      // v33.2 F05：同事务恢复快照/删除空壳 + 作废对应流水——统计不再虚高
      try {
        await DB.undoStudy({ qid: snap.prev.qid, prev: snap.prev, existed: snap.existed, sessionId: snap.sessionId });
      } catch (e) {
        reportErr('撤销失败', e);
        mem.undoStack.push(snap);
        mem.locked = false;
        return;
      }
      try {                                // 当日计数回退
        const c = memDay();
        c[snap.wasNew ? 'fresh' : 'review'] = Math.max(0, (c[snap.wasNew ? 'fresh' : 'review'] || 0) - 1);
        localStorage.setItem(MEMDAY_KEY, JSON.stringify(c));
      } catch (e) {}
      if (snap.existed) mem.map[snap.prev.qid] = snap.prev;
      else delete mem.map[snap.prev.qid];  // 首学题撤销后回到「没学过」状态（新卡身份恢复）
      mem.i = snap.idx;
      toast('已撤销上一张的评分');
      renderMemorize();
    };
    $('#rateArea').querySelectorAll('button[data-q]').forEach(b => { b.onclick = () => rateCard(+b.dataset.q); });
    const ub = $('#memUndo');
    if (ub) ub.onclick = () => safe(doUndo(), '撤销失败');
    // v32 A6：键盘快捷键——空格/回车翻面；1/2/3 评分；Z 撤销（复习中有效）
    mem.keyHandler = (e) => {
      if (mem.review) return;
      const k = e.key;
      if (!flipped && (k === ' ' || k === 'Enter')) { e.preventDefault(); flip(); }
      else if (flipped && (k === '1' || k === '2' || k === '3')) { e.preventDefault(); rateCard(+k === 1 ? 1 : (+k === 2 ? 3 : 5)); }
      else if (flipped && (k === 'z' || k === 'Z')) { e.preventDefault(); safe(doUndo(), '撤销失败'); }
    };
    document.addEventListener('keydown', mem.keyHandler);
  }

  // ---------- 刷题模式 ----------
  let prac = null;
  async function startPractice(opts) {
    opts = opts || {};
    stopTimer(prac);                        // v21：防上一轮的 interval 泄漏
    // v30：随机（默认，老行为）/ 按原顺序 —— 用户点名要能选
    const pool = (opts.order === 'seq') ? S.pool.slice() : shuffle(S.pool);
    prac = { list: pool, i: 0, wrong: [], correct: 0, wrongIds: [], skipped: [], results: [], title: opts.title || '刷题', startAt: Date.now(), timer: null };
    // v31：跨库混合态没有具体题库，返回走首页（S.back 非.bank 即回首页分支）
    setBack(S.mixed ? 'mixed' : 'bank', S.mixed ? '‹ 首页' : '‹ 题库');
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
    // v28：导航行常驻（上一题 / 跳过）；results[i] 有作答记录时进「回看」模式
    const rec = prac.results && prac.results[prac.i];
    view.innerHTML =
      `<div class="progress-top"><span class="pnum">${prac.i + 1}/${total}</span>` +
      `<span class="mtimer" id="mtTimer">⏱ ${fmtElapsed(Date.now() - (prac.startAt || Date.now()))}</span>` +
      `<div class="progress-bar"><span style="width:${(prac.i / total) * 100}%"></span></div></div>` +
      `<div class="study-body slide-in">${body}</div>` +
      `<div id="pracFeedback"></div>` +
      `<div id="pracNav" class="eq-row" style="margin-top:14px">` +
        `<button class="btn secondary" id="prevQBtn"${prac.i === 0 ? ' disabled' : ''}>‹ 上一题</button>` +
        `<button class="btn secondary" id="skipBtn">跳过 ›</button>` +
      `</div>` +
      `<div id="nextWrap" class="hidden" style="margin-top:10px"><button class="btn" id="nextBtn" style="width:100%">下一题 ›</button></div>`;
    startTimerChip(prac);           // v21：本轮用时 chip
    $('#prevQBtn').onclick = () => {
      if (prac.locked || prac.i === 0) return;
      prac.locked = true;
      prac.i--; renderPractice();          // 已答过的题以回看态呈现
    };
    $('#skipBtn').onclick = () => {
      if (prac.locked) return;
      prac.locked = true;
      SFX.flip();
      if (prac.results[prac.i] !== 'skip') prac.skipped.push(q.id);
      prac.results[prac.i] = 'skip';
      prac.i++; renderPractice();
    };

    // 自评题（名词解释 / 简答 / 长答案填空）
    if (Scoring.isSelfAssess(q)) {
      $('#revealTerm').onclick = () => {
        $('#termBack').classList.remove('hidden'); $('#revealTerm').classList.add('hidden');
        $('#tRight').onclick = () => finishPractice(q, true, '自评');
        $('#tWrong').onclick = () => finishPractice(q, false, '自评');
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
        finishPractice(q, right, v);
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
        finishPractice(q, right, picked);
      };
    });

    // v28：回看模式 —— 这一题已做过（results[i] 是作答记录）：锁选项、复放反馈，不重复计分
    if (rec && rec !== 'skip') {
      const rOpts = view.querySelectorAll('.option');
      rOpts.forEach(o => o.classList.add('locked'));
      if (q.type === 'judge') {
        const want = q.answer ? '1' : '0';
        rOpts.forEach(o => {
          if (o.dataset.v === want) o.classList.add('correct');
          if (String(rec.picked) === o.dataset.v) { o.classList.add('chosen'); if (!rec.right) o.classList.add('wrong'); }
        });
      } else if (q.type === 'single' || q.type === 'multiple') {
        const keys = Scoring.answerKeys(q);
        rOpts.forEach(o => {
          if (keys.indexOf(String(o.dataset.k).toUpperCase()) >= 0) o.classList.add('correct');
          if ([].concat(rec.picked).map(String).indexOf(o.dataset.k) >= 0) { o.classList.add('chosen'); if (!rec.right) o.classList.add('wrong'); }
        });
      } else if (q.type === 'fill') {
        const inp = $('#fillInput');
        if (inp) { inp.value = rec.picked || ''; inp.disabled = true; }
        const fb = $('#fillSubmit'); if (fb) fb.disabled = true;
      } else if (Scoring.isSelfAssess(q)) {
        // 自评题：自动展开答案，撤掉评分按钮（只看不改）
        if ($('#revealTerm')) $('#revealTerm').click();
        const tr = $('#tRight'), tw = $('#tWrong');
        if (tr) tr.outerHTML = `<span class="muted" style="font-size:13px">${rec.right ? '✓ 当时答对' : '✗ 当时没答对'}</span>`;
        if (tw) tw.outerHTML = '';
      }
      $('#pracFeedback').innerHTML = rec.right
        ? `<div class="feedback ok">✓ 答对（回看）${q.explanation ? `<span class="sub">解析：${esc(q.explanation)}</span>` : ''}</div>`
        : `<div class="feedback bad">✗ 答错（回看），正确答案：${esc(Scoring.answerText(q))}${q.explanation ? `<span class="sub">解析：${esc(q.explanation)}</span>` : ''}</div>`;
      $('#nextWrap').classList.remove('hidden');
      $('#skipBtn').classList.add('hidden');
      $('#nextBtn').textContent = prac.i + 1 >= total ? '查看结果 ›' : '下一题 ›';
      $('#nextBtn').onclick = () => {
        if (prac.locked) return;
        prac.locked = true;
        SFX.flip();
        prac.i++; renderPractice();
      };
    }
  }
  async function finishPractice(q, right, picked) {
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
    // v28：记作答记录（回看用）；回看补答跳过的题要把它从跳过清单里捞回来
    const wasSkip = prac.results[prac.i] === 'skip';
    prac.results[prac.i] = { right: right, picked: picked };
    if (wasSkip) prac.skipped = prac.skipped.filter(id => id !== q.id);
    // v33.2 F06：进度+流水一个事务（原先分两次写、流水还是 fire-and-forget，
    // 中途退出会产生「有流水没进度」的两套事实）
    const sessP = { id: DB.uid(), bankId: (S.mixed && q.bankId) ? q.bankId : S.bank.id, qid: q.id,
      mode: 'practice', right: right, ms: Date.now() - (prac.renderedAt || Date.now()), ts: Date.now() };

    // 先让用户可以继续，再写库 —— 存储失败绝不能把人卡死在这一题
    $('#nextWrap').classList.remove('hidden');
    $('#skipBtn').classList.add('hidden');
    $('#nextBtn').textContent = prac.i + 1 >= prac.list.length ? '查看结果 ›' : '下一题 ›';
    // v14：锁一下，避免连点"下一题"跳掉两题
    $('#nextBtn').onclick = () => {
      if (prac.locked) return;
      prac.locked = true;
      SFX.flip();                          // v22：切题轻「刷」
      prac.i++; renderPractice();
    };

    await safe((async () => {
      let p = await DB.getProgress(q.id) || { qid: q.id, bankId: (S.mixed && q.bankId) ? q.bankId : S.bank.id, ease: 2.5, interval: 0, reps: 0, due: 0, lapses: 0 };
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
      // v32 A3（Anki 调研：错误驱动所有权）：客观题答对不进长期记忆循环（due 推远），
      // 答错 / 回忆型自评题（检索收益高）立即可复习；已在 SRS 里的卡不被刷题答对驱逐
      if (right && !Scoring.isSelfAssess(q)) {
        // v34.2：答对不进高频复习，但进低频抽查池（30 天后第一次抽查）
        if (!p.inSrs) {
          p.enrollment = 'sampling';
          p.sampleStep = 0;
          p.due = Date.now() + SAMPLE_DAYS[0] * 86400000;
        }
      } else {
        p.inSrs = true;
        p.due = Date.now();
      }
      await DB.commitStudy([p], [sessP]);            // v33.2 F06：单事务原子落库
    })(), '保存失败');
  }
  function renderPracticeResult() {
    const total = prac.list.length;
    const skippedN = (prac.skipped || []).length;
    const answered = prac.correct + prac.wrongIds.length;   // v28：跳过的不进正确率分母
    const acc = answered ? Math.round(prac.correct / answered * 100) : 0;
    // v21：本轮用时 + 平均每题（复习错题重开的 prac 有自己的 startAt）
    const usedMs = Date.now() - (prac.startAt || Date.now());
    const used = fmtElapsed(usedMs);
    const avg = answered ? Math.max(1, Math.round(usedMs / 1000 / answered)) : 0;
    stopTimer(prac);
    clearResume();                         // v23：做完（含复习错题收尾）就清档
    SFX.done();                            // v22：刷完收尾音
    const view = $('#view-study');
    view.innerHTML =
      `<div class="result-score">${acc}%</div><div class="result-sub">答对 ${prac.correct} / 已答 ${answered}` +
      (skippedN ? `（<b style="color:#c0392b">跳过 ${skippedN}</b>）` : '') + ` · 用时 ${used} · 平均 ${avg} 秒/题</div>` +
      (skippedN
        ? `<button class="btn" id="redoSkipped">⏭ 补做跳过的题（${skippedN}）</button><div style="height:10px"></div>`
        : '') +
      (prac.wrongIds.length
        ? `<button class="btn" id="reviewWrong">🔁 复习错题（${prac.wrongIds.length}）</button>
           <div style="height:10px"></div>`
        : `<div class="empty">${answered ? '全部答对，稳！' : '全部跳过了…再来一遍？'}</div>`) +
      `<button class="btn secondary" id="redoPrac">再做一遍</button><div style="height:10px"></div>
       <button class="btn ghost" id="backBank">返回题库</button>`;
    if (skippedN) $('#redoSkipped').onclick = () => {
      const map = {}; S.questions.forEach(q => map[q.id] = q);
      const title = prac.title;
      stopTimer(prac);
      prac = { list: shuffle((prac.skipped || []).map(id => map[id]).filter(Boolean)), i: 0, wrong: [], correct: 0, wrongIds: [], skipped: [], results: [], title: title, startAt: Date.now(), timer: null };
      renderPractice();
    };
    if (prac.wrongIds.length) $('#reviewWrong').onclick = async () => {
      const map = {}; S.questions.forEach(q => map[q.id] = q);
      const title = prac.title;
      stopTimer(prac);
      prac = { list: shuffle(prac.wrongIds.map(id => map[id]).filter(Boolean)), i: 0, wrong: [], correct: 0, wrongIds: [], skipped: [], results: [], title: title, startAt: Date.now(), timer: null };
      renderPractice();
    };
    $('#redoPrac').onclick = () => startPractice({ title: prac.title });
    $('#backBank').onclick = () => { if (S.mixed) { S.mixed = false; openHomeView(); } else openBank(S.bank.id); };
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
      if (exam.i + 1 >= total) {
        // v28：交卷前清点未作答——空答案/空数组都算没做完，明确提醒而不是默默按错计
        const un = exam.list.filter(x => {
          const a = exam.answers[x.id];
          return !a || a.value == null || a.value === '' || (Array.isArray(a.value) && !a.value.length);
        }).length;
        const msg = un > 0 ? `还有 ${un} 题未作答，确定交卷吗？（未答按错计）` : '确定交卷？';
        if (confirm(msg)) submitExam();
      }
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
    // v33.2 F06：成绩+流水同事务（原先流水 fire-and-forget，可能一半有一半没有）
    await safe(DB.bulkUpdateProgress(S.bank.id, updates, 'exam', sessList), '保存成绩失败');
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
    // v30：按模式显示「做题顺序」/「背书方案」选项段，并复位默认项
    const segOn = (sel, v) => $(sel).querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.v === v));
    $('#orderSeg').classList.toggle('hidden', mode !== 'practice');
    $('#planSeg').classList.toggle('hidden', mode !== 'memorize');
    if (mode === 'practice') segOn('#orderSeg', 'rand');
    if (mode === 'memorize') segOn('#planSeg', 'due');
    $('#orderSeg').querySelectorAll('button').forEach(b => b.onclick = () => segOn('#orderSeg', b.dataset.v));
    $('#planSeg').querySelectorAll('button').forEach(b => b.onclick = () => segOn('#planSeg', b.dataset.v));
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
      // v30：带上顺序（刷题）/ 方案（背题）
      const ordBtn = $('#orderSeg').querySelector('button.on');
      const planBtn = $('#planSeg').querySelector('button.on');
      startMode(S.pendingMode, list, {
        order: S.pendingMode === 'practice' ? (ordBtn ? ordBtn.dataset.v : 'rand') : null,
        plan: S.pendingMode === 'memorize' ? (planBtn ? planBtn.dataset.v : 'due') : null
      });
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
  async function openReviewCards(kind, button) {
    const cards = (window.LAW_REVIEW || []).filter(card => card.kind === kind);
    if (!cards.length) { toast('复习内容尚未加载，请检查上传文件'); return; }
    button.disabled = true;
    try {
      const metaKey = 'intl-law-review-' + kind + '-v1';
      const bankId = await DB.getMeta(metaKey);
      let bank = bankId ? await DB.getBank(bankId) : null;
      if (!bank) {
        const chapterCards = kind === 'intro' || /^chapter\d{2}$/.test(kind) ? cards.filter((card, i) => cards.findIndex(item => item.chapter === card.chapter) === i) : cards;
        const outline = chapterCards.map(card => ({ id: card.id, title: card.chapter, level: 2, path: [card.chapter], children: [] }));
        bank = await DB.saveBank('国际法 · ' + REVIEW_LABEL[kind] + ' · ' + cards.length + ' 张', outline);
        try {
          await DB.addQuestions(bank.id, cards.map(card => {
            const type = card.type || (kind === 'term' ? 'term' : 'essay');
            return Object.assign({
              type, explanation: card.explanation || '记忆抓手：' + card.cue,
              chapter: card.chapter, chapterId: card.id, chapterPath: [card.chapter]
            }, type === 'term' ? { term: card.front, definition: card.back } :
              { stem: card.front, answer: card.back, options: card.options || [] });
          }));
          await DB.setMeta(metaKey, bank.id);
        } catch (err) { await DB.deleteBank(bank.id).catch(() => {}); throw err; }
      }
      await openBank(bank.id);
      if (kind !== 'intro' && !/^chapter\d{2}$/.test(kind)) await startMemorize({ plan: 'all' });
    } finally { button.disabled = false; }
  }
  async function openLawCards() {
    const button = $('#lawCardsBtn');
    button.disabled = true;
    try {
      const bankId = await DB.getMeta('intl-law-outline-v1');
      let bank = bankId ? await DB.getBank(bankId) : null;
      if (!bank) {
        const outline = LAW_CARDS.map(card => ({ id: card.id, title: card.chapter, level: 2, path: [card.chapter], children: [] }));
        bank = await DB.saveBank('国际法 · 14 张框架卡', outline);
        try {
          await DB.addQuestions(bank.id, LAW_CARDS.map(card => ({
            type: 'essay', stem: card.front, answer: card.back,
            explanation: '记忆抓手：' + card.cue,
            chapter: card.chapter, chapterId: card.id, chapterPath: [card.chapter]
          })));
          await DB.setMeta('intl-law-outline-v1', bank.id);
        } catch (err) { await DB.deleteBank(bank.id).catch(() => {}); throw err; }
      }
      await openBank(bank.id);
      await startMemorize({ plan: 'all' });
    } finally { button.disabled = false; }
  }
  // 水印清洗统计：导入前重置，saveParsed 累加，提示语里回显
  function resetCleaned() { S.cleaned = { removedLines: 0, strippedLines: 0 }; }
  function accCleaned(c) {
    if (!c || !S.cleaned) return;
    S.cleaned.removedLines += c.removedLines || 0;
    S.cleaned.strippedLines += c.strippedLines || 0;
    S.cleaned.qaPairs = (S.cleaned.qaPairs || 0) + (c.qaPairs || 0);   // v35：无编号问答自动切题数
  }
  function cleanedHint() {
    const c = S.cleaned;
    if (!c) return '';
    const n = c.removedLines + c.strippedLines;
    const qa = c.qaPairs || 0;
    return (n ? `，自动清洗水印 ${n} 处` : '') + (qa ? `，自动切题 ${qa} 组` : '');
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
    const documents = list.filter(f => /\.(pdf|png|jpe?g|webp)$/i.test(f.name));
    if (documents.length) {
      if (documents.length !== list.length) { toast('请将图片 / PDF 与文字文件分开选择'); return; }
      await DocImport.open(documents, async (text, name) => {
        resetCleaned();
        const n = await saveParsed(text, name);
        if (n) { toast('已导入 ' + n + ' 题' + cleanedHint()); await renderHome(); }
        return n;
      }, saveImages);
      return;
    }
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

  // v34.3：导出清洗规则（设置弹层入口，给外部 AI 的导入规范）
  function exportCleanRules() {
    downloadText('LEXA-题库清洗规则.md', CLEAN_RULES_MD);
    toast('已导出：LEXA-题库清洗规则.md');
  }
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
      const ok = list.filter(f => (into === 'slice' ? /\.(md|markdown|txt|text)$/i : /\.(md|markdown|txt|text|pdf|png|jpe?g|webp)$/i).test(f.name));
      if (ok.length) return into === 'slice' ? handleSliceFiles(ok) : handleFiles(ok);
      toast(into === 'slice' ? '没找到 .md / .txt 文件' : '请选择文字、PDF、PNG、JPG 或 WebP 文件');
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
    if (S.mixed) return;                     // v31：跨库会话不做断点续刷（恢复逻辑绑定单库）
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
        mem = { list: list, i: Math.min(r.i, list.length - 1), map, startAt: Date.now(), timer: null, title: r.title || '背题', maxSeen: Math.min(r.i, list.length - 1) + 1, skippedN: 0, review: false };
        S.pool = list;
        setBack('bank', '‹ 题库');
        $('#title').textContent = mem.title;
        renderMemorize();
      })();
    } else {
      stopTimer(prac);
      prac = { list: list, i: Math.min(r.i, list.length - 1), wrong: [], correct: r.correct || 0,
               wrongIds: r.wrongIds || [], skipped: [], results: [], title: r.title || '刷题', startAt: Date.now(), timer: null };
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
    S.bank = null; S.questions = []; S.pool = []; S.outline = []; S.mixed = false;
    setBack('home');
    $('#title').textContent = '国际法题库';
    showView('home');
    safe(renderHome(), '刷新列表失败');
  }

  // ---------- 事件绑定 ----------
  function bind() {
    document.querySelectorAll('#reviewCardsBtns button, #chapterCardsBtns button').forEach(button => {
      button.onclick = () => safe(openReviewCards(button.dataset.kind, button), '打开复习卡失败');
    });
    $('#lawCardsBtn').onclick = () => safe(openLawCards(), '打开框架卡失败');
    $('#backBtn').onclick = () => {
      if (S.back === 'bank') openBank(S.bank.id);
      else {                                   // v27 修复：题库页「‹ 首页」真的切回首页（原来只重渲列表没切视图）
        $('#title').textContent = '国际法题库';
        showView('home');
        safe(renderHome(), '刷新列表失败');
      }
    };
    const fi = $('#fileInput');
    $('#dropZone').onclick = (e) => { if (e.target !== fi) fi.click(); };
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
      setSeg($('#volSeg'), SFX.getVol());           // v29：音量档位
      setSeg($('#packSeg'), SFX.getPack());
      const vibeOk = SFX.vibeSupported();
      $('#vibeField').classList.toggle('hidden', !vibeOk);
      $('#vibeUnsupported').classList.toggle('hidden', vibeOk);
      if (vibeOk) {
        setSeg($('#vibeSeg'), SFX.getVibe() ? '1' : '0');
        setSeg($('#vibeLevelSeg'), SFX.getVibeLevel());
      }
      // v28：背景音乐段——开关 + 曲目下拉（内置 + 本地导入）
      if (window.BGM) {
        setSeg($('#bgmOnSeg'), BGM.enabled() ? '1' : '0');
        setSeg($('#bgmVolSeg'), BGM.getVol());
        BGM.tracks().then(list => {
          const sel = $('#bgmTrack');
          sel.innerHTML = list.map(t => `<option value="${esc(t.id)}"${t.id === BGM.getTrack() ? ' selected' : ''}>${esc(t.label)}</option>`).join('');
          $('#bgmDel').classList.toggle('hidden', list.every(t => t.builtin));
        }).catch(() => {});
      }
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
    // v29：音量三档，切换即试听（响不响当场可感）
    $('#volSeg').querySelectorAll('button').forEach(b => b.onclick = () => {
      SFX.setVol(b.dataset.v);
      $('#volSeg').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      SFX.right();
    });
    $('#vibeSeg').querySelectorAll('button').forEach(b => b.onclick = () => {
      SFX.setVibe(b.dataset.v === '1');
      $('#vibeSeg').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      if (SFX.getVibe()) SFX.previewVibe();
    });
    $('#vibeLevelSeg').querySelectorAll('button').forEach(b => b.onclick = () => {
      SFX.setVibeLevel(b.dataset.v);
      $('#vibeLevelSeg').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      SFX.previewVibe();
    });
    $('#vibePreview').onclick = () => {
      if (!SFX.getVibe()) { toast('先开启震动'); return; }
      SFX.previewVibe();
      toast('已发送震动测试；静音／勿扰模式可能拦截');
    };
    $('#soundPreview').querySelectorAll('button').forEach(b => b.onclick = () => {
      if (!SFX.enabled()) { toast('先开启音效'); return; }
      SFX[b.dataset.sound]();
    });
    $('#bgmVolSeg').querySelectorAll('button').forEach(b => b.onclick = () => {
      BGM.setVol(b.dataset.v);
      $('#bgmVolSeg').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    });
    // v28：背景音乐 —— 开关 / 选曲 / 导入本地音乐 / 删除
    $('#bgmOnSeg').querySelectorAll('button').forEach(b => b.onclick = () => {
      if (!window.BGM) return;
      BGM.setEnabled(b.dataset.v === '1');
      $('#bgmOnSeg').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      if (BGM.enabled()) BGM.start();       // 开即起播（这次点击就是手势）
    });
    $('#bgmTrack').onchange = () => {
      if (!window.BGM) return;
      BGM.stop();
      BGM.setTrack($('#bgmTrack').value);
      if (BGM.enabled()) BGM.start();       // 换曲即播
    };
    $('#bgmAdd').onclick = () => $('#bgmFile').click();
    $('#bgmFile').onchange = () => safe((async () => {
      const f = $('#bgmFile').files && $('#bgmFile').files[0];
      if (!f) return;
      if (f.size > 20 * 1024 * 1024) { toast('音乐文件太大（限 20MB）'); return; }
      const id = await BGM.addFile(f);
      $('#bgmFile').value = '';
      BGM.stop();
      BGM.setTrack(id);
      if (BGM.enabled()) BGM.start();
      toast('已添加并播放：' + f.name.replace(/\.[^.]+$/, ''));
      // 刷新下拉
      const list = await BGM.tracks();
      const sel = $('#bgmTrack');
      sel.innerHTML = list.map(t => `<option value="${esc(t.id)}"${t.id === BGM.getTrack() ? ' selected' : ''}>${esc(t.label)}</option>`).join('');
      $('#bgmDel').classList.toggle('hidden', list.every(t => t.builtin));
    })(), '添加音乐失败');
    $('#bgmDel').onclick = () => safe((async () => {
      const id = $('#bgmTrack').value;
      if (!id || id.indexOf('bgm-') !== 0) return;   // 内置曲不可删
      if (!confirm('删除这首自定义音乐？')) return;
      await BGM.removeCustom(id);
      toast('已删除');
      const list = await BGM.tracks();
      const sel = $('#bgmTrack');
      sel.innerHTML = list.map(t => `<option value="${esc(t.id)}"${t.id === BGM.getTrack() ? ' selected' : ''}>${esc(t.label)}</option>`).join('');
      $('#bgmDel').classList.toggle('hidden', list.every(t => t.builtin));
      BGM.stop();
      if (BGM.enabled()) BGM.start();
    })(), '删除音乐失败');
    $('#exportRulesBtn').onclick = () => { exportCleanRules(); };
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
    // v32 A1：每日限额段（打开目标弹层时同步高亮）
    const syncLimSegs = () => {
      [['#limNewSeg', LIM_NEW_KEY, 20], ['#limRevSeg', LIM_REV_KEY, 100]].forEach(([sel, key, dft]) => {
        const cur = String(getLimit(key, dft));
        $(sel).querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === cur));
      });
    };
    syncLimSegs();
    [['#limNewSeg', LIM_NEW_KEY, 20], ['#limRevSeg', LIM_REV_KEY, 100]].forEach(([sel, key]) => {
      $(sel).querySelectorAll('button').forEach(b => b.onclick = () => {
        localStorage.setItem(key, String(+b.dataset.v));
        $(sel).querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
        toast('已保存，明天生效');
      });
    });
    $('#goalModalClose').onclick = () => $('#goalModal').classList.add('hidden');
    $('#goalModal').onclick = (e) => { if (e.target === $('#goalModal')) $('#goalModal').classList.add('hidden'); };
    // v31：跨库刷题弹层
    $('#mixEntry').onclick = () => safe(openMixModal(), '打开跨库刷题失败');
    $('#mixTypeSeg').querySelectorAll('button').forEach(b => b.onclick = () => {
      $('#mixTypeSeg').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      safe(updateMixHint(), '统计失败');
    });
    $('#mixOrderSeg').querySelectorAll('button').forEach(b => b.onclick = () => {
      $('#mixOrderSeg').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    });
    $('#mixAll').onclick = () => {
      const boxes = Array.from($('#mixBanks').querySelectorAll('input'));
      const allOn = boxes.every(b => b.checked);
      boxes.forEach(b => { b.checked = !allOn; });
      safe(updateMixHint(), '统计失败');
    };
    $('#mixStart').onclick = () => safe(startMixed(), '开始跨库刷题失败');
    $('#mixModalClose').onclick = () => $('#mixModal').classList.add('hidden');
    $('#mixModal').onclick = (e) => { if (e.target === $('#mixModal')) $('#mixModal').classList.add('hidden'); };
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
    const syncSkin = () => {
      const skin = document.documentElement.dataset.skin === 'atlas' ? 'atlas' : 'classic';
      $('#skinOptions').querySelectorAll('button').forEach(b => {
        b.classList.toggle('on', b.dataset.v === skin);
        b.setAttribute('aria-pressed', String(b.dataset.v === skin));
      });
    };
    $('#skinBtn').onclick = () => { syncSkin(); $('#skinModal').classList.remove('hidden'); };
    $('#skinOptions').querySelectorAll('button').forEach(b => b.onclick = () => {
      document.documentElement.dataset.skin = b.dataset.v;
      try { localStorage.setItem('skin', b.dataset.v); } catch (_) { toast('当前浏览器无法保存外观偏好'); }
      syncSkin();
    });
    $('#skinClose').onclick = () => $('#skinModal').classList.add('hidden');
    $('#skinModal').onclick = e => { if (e.target === $('#skinModal')) $('#skinModal').classList.add('hidden'); };
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

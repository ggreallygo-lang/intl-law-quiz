/* 本地文档识别：原件与文字先校对，确认后才交给既有题库导入。 */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  let pdfLibrary, active = null;

  async function loadPdfLibrary() {
    if (!pdfLibrary) {
      if (!Promise.withResolvers) Promise.withResolvers = function () {
        let resolve, reject;
        const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
        return { promise, resolve, reject };
      };
      pdfLibrary = import('./vendor/pdfjs/pdf.mjs').then(lib => {
        lib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.mjs', location.href).href;
        return lib;
      }).catch(err => { pdfLibrary = null; throw err; });
    }
    return pdfLibrary;
  }

  function loadOcrLibrary() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = './vendor/tesseract/tesseract.min.js';
      script.onload = () => resolve(window.Tesseract);
      script.onerror = () => { script.remove(); reject(new Error('识别组件加载失败，请检查安装包是否完整')); };
      document.head.appendChild(script);
    });
  }

  async function getWorker(state) {
    if (state.worker) return state.worker;
    const ocr = await loadOcrLibrary();
    if (state.closed) throw new Error('已取消');
    const worker = await ocr.createWorker('chi_sim+eng', 1, {
      workerPath: new URL('./vendor/tesseract/worker.min.js', location.href).href,
      corePath: new URL('./vendor/tesseract/core/', location.href).href,
      langPath: new URL('./vendor/tesseract/lang/', location.href).href,
      workerBlobURL: false,
      logger: message => {
        if (state.closed || !message.status) return;
        $('docStatus').textContent = state.stage + ' · ' +
          (message.status === 'recognizing text' ? '识别 ' + Math.round((message.progress || 0) * 100) + '%' : '初始化识别引擎…');
      }
    });
    if (state.closed) { await worker.terminate(); throw new Error('已取消'); }
    state.worker = worker;
    return worker;
  }

  async function close() {
    const state = active;
    active = null;
    $('docModal').classList.add('hidden');
    $('docText').value = '';
    $('docSource').replaceChildren();
    $('docQuestions').replaceChildren();
    if (!state) return;
    state.closed = true;
    state.urls.forEach(url => URL.revokeObjectURL(url));
    if (state.worker) await state.worker.terminate().catch(() => {});
    if (state.pdfTask) await state.pdfTask.destroy().catch(() => {});
  }

  async function showPage(state, index) {
    if (state.closed) return;
    state.pageIndex = index;
    const target = $('docSource');
    target.replaceChildren();
    $('docPageLabel').textContent = (index + 1) + ' / ' + state.totalPages;
    $('docPrev').disabled = index === 0;
    $('docNext').disabled = index + 1 >= state.totalPages;
    const ticket = ++state.previewTicket;
    if (state.pdf) {
      const page = await state.pdf.getPage(index + 1);
      if (state.closed || ticket !== state.previewTicket) return;
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(1.4, 1100 / base.width) });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      if (!state.closed && ticket === state.previewTicket) target.appendChild(canvas);
    } else {
      const img = document.createElement('img');
      img.alt = state.files[index].name;
      img.src = state.urls[index];
      target.appendChild(img);
    }
  }

  function preview() {
    if (!active || active.busy) return;
    const raw = $('docText').value;
    // 去掉原卷题型标签可避免既有解析器把主观答案拼进题干；明确题型仍单独校验。
    const normalized = raw.replace(/^(\s*\d+\s*[.、．]\s*)【(?:单选题|多选题|单项选择题|多项选择题|简答题|论述题|案例分析题|名词解释|判断题|填空题)】\s*/gm, '$1')
      .replace(/^(\s*)(答案|解析|回答|答)\s*[:：]\s*/gm, '$1$2：');
    const parsed = QuizParser.parseDocument(normalized);
    const sourceBody = QuizParser.extractExamAnswers(raw).body;
    const sourceHeads = Array.from(sourceBody.matchAll(/^\s*\d+\s*[.、．]\s*(?:【([^】]+)】)?\s*([^\n]*)/gm))
      .filter(head => head[1] || !/^[A-E](?:\s*[A-E])*\s*$|^\d+\s*分\s*$/.test(head[2].trim()));
    const issues = [];
    if (sourceHeads.length && sourceHeads.length !== parsed.questions.length) issues.push('原文有 ' + sourceHeads.length + ' 个编号题块，但只解析出 ' + parsed.questions.length + ' 题（检查缺答案或截断题）');
    const matchedQuestions = new Set();
    sourceHeads.forEach(head => {
      const tag = head[1];
      const expected = /多.*选/.test(tag || '') ? 'multiple' : /单.*选/.test(tag || '') ? 'single' : /简答|论述|案例/.test(tag || '') ? 'essay' : null;
      if (!expected) return;
      const stem = head[2].replace(/\s/g, '').slice(0, 18);
      const question = parsed.questions.find(q => !matchedQuestions.has(q) && (q.stem || q.term || '').replace(/\s/g, '').startsWith(stem));
      if (question) matchedQuestions.add(question);
      if (question && question.type !== expected) issues.push('题型不符：' + head[2].slice(0, 28) + '（请检查选项和答案）');
    });
    const target = $('docQuestions');
    target.replaceChildren();
    const labels = { single: '单选', multiple: '多选', judge: '判断', term: '名词解释', essay: '主观题', fill: '填空' };
    parsed.questions.forEach((question, index) => {
      const card = document.createElement('details');
      const heading = document.createElement('summary');
      heading.textContent = (index + 1) + '. [' + (labels[question.type] || '题目') + '] ' + (question.stem || question.term || '');
      const body = document.createElement('pre');
      body.textContent = (question.options || []).map(option => option.key + '. ' + option.text).join('\n') +
        '\n答案：' + Scoring.answerText(question) + (question.explanation ? '\n解析：' + question.explanation : '');
      card.append(heading, body); target.appendChild(card);
    });
    $('docCount').textContent = issues.length ? '需校对：' + issues.join('；') : '当前可入库 ' + parsed.questions.length + ' 题。请展开核对题干、选项、答案。';
    active.previewText = raw;
    active.importText = normalized;
    active.hasIssues = !!issues.length;
    $('docConfirm').disabled = !parsed.questions.length || active.hasIssues;
    $('docConfirm').textContent = '确认校对并导入 ' + parsed.questions.length + ' 题';
    return parsed;
  }

  async function extract() {
    const state = active;
    if (!state || state.busy) return;
    const first = Number($('docFrom').value), last = Number($('docTo').value);
    if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last < first || last > state.totalPages) {
      $('docStatus').textContent = '页码范围不正确'; return;
    }
    if (last - first + 1 > 30) { $('docStatus').textContent = '一次最多识别 30 页，建议先试 1—3 页'; return; }
    if ($('docText').value.trim() && !confirm('重新识别会替换当前校对文字，继续吗？')) return;
    state.busy = true;
    $('docExtract').disabled = true; $('docPreview').disabled = true; $('docConfirm').disabled = true;
    $('docText').disabled = true;
    const chunks = [];
    try {
      for (let n = first; n <= last; n++) {
        if (state.closed) return;
        state.stage = '处理第 ' + n + ' 页（' + (n - first + 1) + '/' + (last - first + 1) + '）';
        $('docStatus').textContent = state.stage;
        let text = '';
        if (state.pdf) {
          const page = await state.pdf.getPage(n);
          const content = await page.getTextContent();
          const raw = content.items.map(item => item.str + (item.hasEOL ? '\n' : ' ')).join('');
          const meaningful = raw.replace(/\s/g, '').length;
          const useOcr = $('docForceOcr').checked || meaningful < 40;
          if (!useOcr) text = raw;
          else {
            const base = page.getViewport({ scale: 1 });
            const viewport = page.getViewport({ scale: Math.min(2, 2200 / Math.max(base.width, base.height)) });
            const canvas = document.createElement('canvas');
            canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
            await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
            if (state.closed) return;
            const worker = await getWorker(state);
            text = (await worker.recognize(canvas)).data.text;
            canvas.width = 0; canvas.height = 0;
          }
          page.cleanup();
        } else {
          const worker = await getWorker(state);
          text = (await worker.recognize(state.files[n - 1])).data.text;
        }
        chunks.push(text);
      }
      if (state.closed) return;
      $('docText').value = chunks.join('\n\n');
      $('docStatus').textContent = '文字提取完成。先校对，再预览题目；识别不会自动补答案。';
    } catch (err) {
      if (!state.closed) {
        if (chunks.length) $('docText').value = chunks.join('\n\n');
        $('docStatus').textContent = '识别未完成：' + err.message + (chunks.length ? '；已保留前面成功页的文字。' : '');
      }
    } finally {
      state.busy = false;
      if (!state.closed) {
        $('docExtract').disabled = false; $('docPreview').disabled = false; $('docText').disabled = false;
      }
      if (state.worker) { await state.worker.terminate().catch(() => {}); state.worker = null; }
    }
  }

  async function open(files, onImport) {
    await close();
    const pdfFiles = files.filter(file => /\.pdf$/i.test(file.name));
    if (pdfFiles.length && (pdfFiles.length !== 1 || files.length !== 1)) throw new Error('一次请选择一个 PDF，或一组按顺序排列的图片');
    if (!pdfFiles.length && files.length > 12) throw new Error('一次最多选择 12 张图片');
    if (files.some(file => file.size > 30 * 1024 * 1024)) throw new Error('单个文件不能超过 30 MB，请分成较小文件');
    const state = { files, urls: [], totalPages: files.length, pageIndex: 0, previewTicket: 0, closed: false, busy: false, onImport };
    active = state;
    $('docModal').classList.remove('hidden');
    $('docName').value = files[0].name.replace(/\.[^.]+$/, '') + (files.length > 1 ? '等' + files.length + '张' : '');
    $('docStatus').textContent = '正在打开原件…';
    $('docCount').textContent = '识别文字尚未入库。';
    $('docConfirm').disabled = true; $('docForceOcr').checked = false;
    $('docConfirm').textContent = '确认校对并导入';
    $('docExtract').disabled = true; $('docPreview').disabled = true; $('docText').disabled = false;
    try {
      if (pdfFiles.length) {
        const lib = await loadPdfLibrary();
        if (state.closed) return;
        state.pdfTask = lib.getDocument({ data: new Uint8Array(await files[0].arrayBuffer()), isEvalSupported: false,
          cMapUrl: new URL('./vendor/pdfjs/cmaps/', location.href).href, cMapPacked: true,
          standardFontDataUrl: new URL('./vendor/pdfjs/standard_fonts/', location.href).href });
        state.pdf = await state.pdfTask.promise;
        state.totalPages = state.pdf.numPages;
      } else state.urls = files.map(file => URL.createObjectURL(file));
      if (state.closed) return;
      $('docFrom').value = 1; $('docTo').value = Math.min(state.totalPages, 3);
      $('docFrom').max = state.totalPages; $('docTo').max = state.totalPages;
      await showPage(state, 0);
      if (state.closed) return;
      $('docStatus').textContent = '共 ' + state.totalPages + ' 页。选择范围后开始识别；所有内容仅在本机处理。';
      $('docExtract').disabled = false; $('docPreview').disabled = false;
    } catch (err) {
      if (!state.closed) $('docStatus').textContent = '无法打开：' + err.message + '。加密 PDF 请先自行解密。';
    }
  }

  $('docClose').onclick = () => close();
  $('docExtract').onclick = extract;
  $('docPreview').onclick = preview;
  $('docText').oninput = () => { $('docConfirm').disabled = true; $('docCount').textContent = '文字已修改，请重新预览题目。'; };
  $('docPrev').onclick = () => active && showPage(active, active.pageIndex - 1).catch(err => { $('docStatus').textContent = err.message; });
  $('docNext').onclick = () => active && showPage(active, active.pageIndex + 1).catch(err => { $('docStatus').textContent = err.message; });
  $('docConfirm').onclick = async () => {
    const state = active;
    if (!state || state.busy || state.previewText !== $('docText').value) return;
    const parsed = preview();
    if (!parsed || !parsed.questions.length || state.hasIssues) return;
    state.busy = true;
    $('docConfirm').disabled = true; $('docClose').disabled = true; $('docText').disabled = true;
    $('docExtract').disabled = true; $('docPreview').disabled = true;
    try {
      const n = await state.onImport(state.importText, $('docName').value.trim() || '文档识别题库');
      if (!n) throw new Error('没有写入题目，请检查识别结果或存储空间');
      await close();
    } catch (err) { $('docStatus').textContent = '导入失败：' + err.message; $('docConfirm').disabled = false; }
    finally {
      state.busy = false;
      $('docClose').disabled = false; $('docText').disabled = false;
      $('docExtract').disabled = false; $('docPreview').disabled = false;
    }
  };
  window.DocImport = { open };
})();

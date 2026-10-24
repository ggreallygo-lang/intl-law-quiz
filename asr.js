/* asr.js — 语音转文字（可选增强）
 *
 * 主路径：硅基流动 SenseVoiceSmall —— 长期免费、不限量、国内直连
 * 备选：智谱 GLM-ASR —— 0.06 元/分钟，可与 AI 解析共用一个 Key
 *
 * 录音在本地完成，只在你按下麦克风后采集，松手即停并上传。不后台偷录。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ASR = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PROVIDERS = {
    siliconflow: {
      id: 'siliconflow',
      label: '硅基流动 · 免费',
      endpoint: 'https://api.siliconflow.cn/v1/audio/transcriptions',
      model: 'FunAudioLLM/SenseVoiceSmall',
      keyStorage: 'asr-key-sf',
      note: '免费不限量。需在 siliconflow.cn 注册并完成实名认证后创建 Key。'
    },
    zhipu: {
      id: 'zhipu',
      label: '智谱 GLM-ASR · 0.06元/分钟',
      endpoint: 'https://open.bigmodel.cn/api/paas/v4/audio/transcriptions',
      model: 'glm-asr-2512',
      keyStorage: 'ai-key',            // 与 AI 解析共用同一个 Key
      note: '按 0.06 元/分钟计费，直接复用你 AI 解析的 Key。'
    }
  };

  const MAX_MS = 120000;               // 单次录音上限 2 分钟，防误触长录

  function getProvider() {
    let v = '';
    try { v = localStorage.getItem('asr-provider') || ''; } catch (_) {}
    return PROVIDERS[v] ? v : 'siliconflow';
  }
  function setProvider(id) {
    if (!PROVIDERS[id]) throw new Error('未知的语音服务商');
    localStorage.setItem('asr-provider', id);
  }
  function providerInfo() { return PROVIDERS[getProvider()]; }

  function getKey(providerId) {
    const p = PROVIDERS[providerId || getProvider()];
    try { return (localStorage.getItem(p.keyStorage) || '').trim(); } catch (_) { return ''; }
  }
  function setKey(value, providerId) {
    const p = PROVIDERS[providerId || getProvider()];
    const key = String(value || '').trim();
    if (key && !/^[\x21-\x7e]+$/.test(key)) throw new Error('Key 里不能有空格、中文或全角字符');
    if (key) localStorage.setItem(p.keyStorage, key);
    else localStorage.removeItem(p.keyStorage);
  }
  function hasKey() { return !!getKey(); }

  // ---------- 录音：采集 PCM 并封装成 16k 单声道 WAV ----------
  // 为什么要自己封 WAV：MediaRecorder 在安卓上输出 webm/opus、在 iOS 上输出 mp4，
  // 各家 ASR 对这两种格式的支持并不一致；WAV 是所有接口都吃的格式。
  function encodeWav(samples, sampleRate) {
    const len = samples.length;
    const buf = new ArrayBuffer(44 + len * 2);
    const view = new DataView(buf);
    const writeStr = function (off, s) {
      for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
    };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + len * 2, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);              // PCM
    view.setUint16(22, 1, true);              // 单声道
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, len * 2, true);
    let off = 44;
    for (let i = 0; i < len; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      off += 2;
    }
    return new Blob([buf], { type: 'audio/wav' });
  }

  function downsample(input, fromRate, toRate) {
    if (fromRate === toRate) return input;
    if (!input || !input.length) return new Float32Array(0);
    const ratio = fromRate / toRate;
    const len = Math.max(1, Math.floor(input.length / ratio));
    const out = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      const pos = i * ratio;
      const i0 = Math.floor(pos);
      const i1 = Math.min(i0 + 1, input.length - 1);
      const frac = pos - i0;
      out[i] = input[i0] * (1 - frac) + input[i1] * frac;
    }
    return out;
  }

  /**
   * 开始录音，返回 { stop(): Promise<Blob>, cancel(), startedAt }
   * 停下来时会做降采样 + WAV 封装。
   */
  async function startRecording() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('当前浏览器不支持录音（需要 HTTPS 环境）');
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) {
        throw new Error('麦克风权限被拒绝，请在浏览器设置里允许本页使用麦克风');
      }
      throw new Error('打不开麦克风：' + (e && e.message || '未知错误'));
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const src = ctx.createMediaStreamSource(stream);
    const node = ctx.createScriptProcessor(4096, 1, 1);
    const chunks = [];
    let total = 0;
    const startedAt = Date.now();
    let autoStop = null;

    node.onaudioprocess = function (ev) {
      const buf = ev.inputBuffer.getChannelData(0);
      chunks.push(new Float32Array(buf));
      total += buf.length;
      if (Date.now() - startedAt > MAX_MS && typeof api.onAutoStop === 'function') api.onAutoStop();
    };
    src.connect(node);
    node.connect(ctx.destination);

    function cleanup() {
      if (autoStop) { clearTimeout(autoStop); autoStop = null; }
      try { node.disconnect(); } catch (_) {}
      try { src.disconnect(); } catch (_) {}
      try { ctx.close(); } catch (_) {}
      try { stream.getTracks().forEach(t => t.stop()); } catch (_) {}
    }

    const api = {
      onAutoStop: null,
      startedAt: startedAt,
      get elapsed() { return Date.now() - startedAt; },
      cancel: function () { cleanup(); },
      stop: async function () {
        cleanup();
        if (!total) throw new Error('没有录到声音，检查一下麦克风');
        const all = new Float32Array(total);
        let off = 0;
        for (const c of chunks) { all.set(c, off); off += c.length; }
        const rate = ctx.sampleRate || 44100;
        const samples = downsample(all, rate, 16000);
        return encodeWav(samples, 16000);
      }
    };
    return api;
  }

  // ---------- 上传转写 ----------
  async function transcribe(blob, options) {
    const p = providerInfo();
    const key = getKey(p.id);
    if (!key) {
      throw new Error(p.id === 'zhipu'
        ? '还没有智谱 Key，先在设置里填 AI Key'
        : '还没有硅基流动 Key，先去 siliconflow.cn 注册（需实名）并创建 Key');
    }
    const form = new FormData();
    form.append('model', p.model);
    form.append('file', blob, 'speech.wav');
    const signal = options && options.signal;
    let res;
    const controller = new AbortController();
    if (signal) signal.addEventListener('abort', function () { controller.abort(); }, { once: true });
    const timer = setTimeout(function () { controller.abort(); }, 60000);
    try {
      res = await fetch(p.endpoint, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + key },
        body: form,
        signal: controller.signal
      });
    } catch (e) {
      clearTimeout(timer);
      if (controller.signal.aborted) throw new Error('转写已取消或超时');
      throw new Error('连不上语音服务（网络或跨域被拦）。检查网络，或换另一个服务商试试');
    }
    clearTimeout(timer);
    if (!res.ok) {
      let detail = '';
      try {
        const body = await res.json();
        detail = (body && (body.message || body.error && body.error.message)) || '';
      } catch (_) {}
      if (res.status === 401) throw new Error('Key 无效或没有该模型的权限（401）' + (detail ? '：' + detail : ''));
      if (res.status === 403) throw new Error('没有权限（403），硅基流动的免费模型要求账号完成实名认证');
      if (res.status === 429) throw new Error('请求太频繁或额度用尽（429），稍后再试');
      throw new Error('语音服务返回 HTTP ' + res.status + (detail ? '：' + detail : ''));
    }
    let data;
    try { data = await res.json(); } catch (_) { throw new Error('语音服务返回了无法解析的内容'); }
    const text = (data && (data.text ||
      (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content))) || '';
    if (!text || !String(text).trim()) throw new Error('没听清，再说一遍试试');
    return String(text).trim();
  }

  return {
    PROVIDERS: PROVIDERS,
    getProvider: getProvider, setProvider: setProvider, providerInfo: providerInfo,
    getKey: getKey, setKey: setKey, hasKey: hasKey,
    startRecording: startRecording, transcribe: transcribe,
    encodeWav: encodeWav, downsample: downsample,          // 导出供离线验证
    MAX_MS: MAX_MS
  };
});

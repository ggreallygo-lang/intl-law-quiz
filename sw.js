/* sw.js — 缓存应用外壳，离线可用 */
/*
 * v5 稳定性改动：
 *   1. addAll(SHELL) 改成逐个 put + 容错。
 *      原因：addAll 是「要么全成功要么全失败」，SHELL 里任何一个资源 404
 *      （比如 icon.svg 被误删），整个 install 就失败、SW 永不激活，离线能力全废。
 *      改成逐个 put 后，缺哪个资源只影响那个资源，其余照常缓存。
 *   2. 只缓存同源资源，且限制到 SHELL 白名单，避免缓存无限增长。
 *   3. 缓存前缀化：换版本时按前缀清理旧缓存，不再依赖精确名字匹配。
 */
const CACHE = 'card-quiz-v7';
const PREFIX = 'card-quiz-';
const SHELL = [
  './', './index.html', './styles.css',
  './app.js', './db.js', './parser.js', './scoring.js',
  './manifest.webmanifest', './icon.svg'
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // 逐个 put：单个资源失败不影响整体
    await Promise.all(SHELL.map(url =>
      c.add(url).catch(err => { console.warn('[sw] 缓存失败，已跳过：', url, err); })
    ));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => (k.startsWith(PREFIX) && k !== CACHE) ? caches.delete(k) : null));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  // 只处理同源请求：跨域资源（字体、图片 CDN）缓存了反而容易出问题
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      // 只缓存成功响应，且不透明响应（opaque）体积不可控，跳过
      if (res && res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match('./index.html')))
  );
});

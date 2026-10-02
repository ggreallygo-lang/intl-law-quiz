/* sw.js — 缓存应用外壳，离线可用 */
/*
 * v33.2 F07（架构评审）：SW 完整性
 *   1. 核心/装饰资源分级：CORE（页面+全部 JS/CSS）缺一个就拒绝激活——半安装的新版
 *      比旧版更糟（离线时点开就是死链）。DECOR（图标/底图/manifest）失败可容忍。
 *      取代 v5 的「逐个 put 全部容错」——那个方案下 app.js 缺失照样激活。
 *   2. fetch 只缓存 SHELL 白名单内的 GET（v5 注释声称白名单、实际缓存一切同源成功响应）。
 *   3. 离线回退 HTML 只用于导航请求；JS/CSS 等子资源离线时绝不能回退成 index.html
 *      （否则控制台一片 MIME 错误、页面假死）。
 */
const CACHE = 'card-quiz-v41';   // 补齐第2—13章独立学习包
                                 // 注意：本 SW 对同源资源是 cache-first，改了 styles.css/app.js
                                 // 必须同步改这里，否则老用户永远拿到旧样式。
const PREFIX = 'card-quiz-';
const CORE = [
  './', './index.html', './styles.css',
  './app.js', './db.js', './parser.js', './scoring.js', './slicer.js', './scheduler.js', './sfx.js', './bgm.js',
  './law-cards.js', './review-cards.js', './document-import.js'
];
const DECOR = ['./manifest.webmanifest', './icon.svg', './bg-light.webp', './bg-dark.webp', './study-hero.png'];
const SHELL = CORE.concat(DECOR);

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // 核心：一个都不能少。任何一个失败 → 抛错让 install 失败，旧版本继续服务
    const failed = [];
    await Promise.all(CORE.map(url =>
      c.add(url).catch(() => { failed.push(url); })
    ));
    if (failed.length) {
      // 清掉本次已写进去的半截缓存（caches.open 后成功的 add 已落盘），再让 install 失败
      await caches.delete(CACHE).catch(() => {});
      throw new Error('[sw] 核心资源缓存失败，拒绝激活：' + failed.join(','));
    }
    // 装饰：尽力而为，缺了只影响观感
    await Promise.all(DECOR.map(url => c.add(url).catch(err => { console.warn('[sw] 装饰资源缓存失败（可容忍）：', url, err); })));
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
  const inShell = SHELL.some(u => url.pathname === new URL(u, self.location.href).pathname);

  if (e.request.mode === 'navigate') {
    // 导航请求：缓存优先，离线回退到已缓存的外壳页
    e.respondWith(
      caches.match(e.request).then(hit => hit || fetch(e.request).catch(() => caches.match('./')))
    );
    return;
  }
  if (!inShell) {
    // 识别组件按需缓存；不在安装时一次下载全部语言模型。
    const vendorRoot = new URL('./vendor/', self.location.href).pathname;
    if (url.pathname.startsWith(vendorRoot)) {
      e.respondWith(caches.open(CACHE).then(async cache => {
        const hit = await cache.match(e.request);
        if (hit) return hit;
        const res = await fetch(e.request);
        if (res.ok && res.type === 'basic') {
          const write = cache.put(e.request, res.clone()).catch(err => console.warn('[sw] 识别组件缓存失败', err));
          e.waitUntil(write);
        }
        return res;
      }));
      return;
    }
    // 白名单外：直接走网络，不读缓存也不写缓存（防缓存无限增长/意外内容入库）
    return;
  }
  // 白名单子资源：cache-first，未命中时回源并回填
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      if (res && res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
      }
      return res;
    }))
  );
});

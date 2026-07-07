// 369 甄选 · Service Worker —— 让 App 能加到主屏、弱网/离线也能打开
// 策略：自家 HTML/静态用「缓存兜底」，Supabase 数据与图片 CDN 一律走网络（保证新鲜）
const V = '369-cache-v1';
const SHELL = ['/', '/index.html', '/manifest.json', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(V).then((c) => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // 跨域（Supabase / 得物图 CDN）不接管：始终走网络，数据永远最新
  if (url.origin !== location.origin) return;

  // 页面导航：先联网拿最新，失败再回退缓存的壳子（离线也能打开）
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((r) => { const cp = r.clone(); caches.open(V).then((c) => c.put('/index.html', cp)); return r; })
        .catch(() => caches.match('/index.html').then((r) => r || caches.match('/')))
    );
    return;
  }

  // 其余自家静态：缓存优先，同时后台更新
  e.respondWith(
    caches.match(req).then((cached) => {
      const net = fetch(req).then((res) => {
        if (res && res.status === 200) { const cp = res.clone(); caches.open(V).then((c) => c.put(req, cp)); }
        return res;
      }).catch(() => cached);
      return cached || net;
    })
  );
});

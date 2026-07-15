// 369 甄选 · Service Worker v3 —— 保新鲜也要快：
// 同源请求走「网络 vs 2.5s 竞速」：网络先到用网络（并回填缓存）；网络慢/断，先用缓存秒开，后台继续更新。
// 换版本立即接管并刷新已开页面；Supabase / 得物图 CDN 一律不接管。
const V = '369-cache-v3';
const NET_TIMEOUT = 2500;

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== V).map((k) => caches.delete(k)));
    await self.clients.claim();
    // 让已打开的旧页面立刻刷新到新版本
    const cs = await self.clients.matchAll({ type: 'window' });
    for (const c of cs) { try { c.navigate(c.url); } catch (_e) { /* ignore */ } }
  })());
});

// ===== Web Push：到货提醒 =====
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (_e) { data = { body: e.data ? e.data.text() : '' }; }
  const title = data.title || '369 甄选';
  const opts = {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: data.url || '/' },
    tag: '369-order',
    renotify: true,
  };
  e.waitUntil(self.registration.showNotification(title, opts));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil((async () => {
    const cs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of cs) { if ('focus' in c) { try { c.navigate(url); } catch (_e) { /* ignore */ } return c.focus(); } }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // 数据与商品图始终走网络，保证新鲜

  const cacheKey = req.mode === 'navigate' ? '/index.html' : req;
  e.respondWith((async () => {
    const cached = await caches.match(cacheKey);
    const net = fetch(req)
      .then((res) => {
        if (res && res.status === 200) { const cp = res.clone(); caches.open(V).then((c) => c.put(cacheKey, cp)); }
        return res;
      })
      .catch(() => null);
    if (!cached) { // 没缓存只能等网络
      const res = await net;
      return res || new Response('offline', { status: 503 });
    }
    // 竞速：网络 2.5s 内到就用最新的；否则先给缓存秒开（net 继续在后台回填缓存）
    const winner = await Promise.race([net, new Promise((r) => setTimeout(() => r('TIMEOUT'), NET_TIMEOUT))]);
    return (winner && winner !== 'TIMEOUT') ? winner : cached;
  })());
});

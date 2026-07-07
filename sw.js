// 369 甄选 · Service Worker —— 加到主屏 / 弱网可开，但绝不给旧版本
// 策略：同源一律「网络优先」，只有断网时才回退缓存；换版本立刻接管并刷新已开页面
const V = '369-cache-v2';

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

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // Supabase / 得物图 CDN 一律走网络，不接管

  // 同源一律网络优先：拿到就顺手更新缓存；断网才回退缓存（导航回退到首页壳子）
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.status === 200) { const cp = res.clone(); caches.open(V).then((c) => c.put(req, cp)); }
        return res;
      })
      .catch(() => caches.match(req).then((r) => r || (req.mode === 'navigate' ? caches.match('/index.html') : undefined)))
  );
});

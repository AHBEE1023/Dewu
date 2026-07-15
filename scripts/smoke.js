#!/usr/bin/env node
/**
 * 369 甄选 — 冒烟测试（formalized smoke test）
 * 用真实 index.html 驱动关键界面，断言：零 pageerror + 关键元素存在。
 * 以前靠人肉截图，现在一条命令跑完，改动不回归。
 *
 *   node scripts/smoke.js
 *
 * 需要 playwright + 一个 chromium。本仓库开发环境已内置：
 *   PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers，可执行档 /opt/pw-browsers/chromium
 * 其它环境请先 `npm i -D playwright && npx playwright install chromium`。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8899;
const EXEC = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium';

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
function serve() {
  return http.createServer((req, res) => {
    const p = decodeURIComponent(req.url.split('?')[0]);
    const file = path.join(ROOT, p === '/' ? 'index.html' : p);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'text/plain', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  }).listen(PORT);
}

const IMG = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="100%" height="100%" fill="#e7b98f"/></svg>');
const PRODUCTS = [
  { id: 1, name_cn: 'Jellycat 邦尼兔 中号', brand: 'JELLYCAT', sku: 'B1', sell_myr: 189, orig_myr: 239, status: '已上架', created_at: new Date().toISOString(), image_url: IMG, images: [IMG], sold_count: 32, hot: true },
  { id: 2, name_cn: 'LABUBU 搪胶脸 三代', brand: 'POP MART', sku: 'B2', sell_myr: 259, status: '已上架', created_at: new Date().toISOString(), image_url: IMG, images: [IMG], sold_count: 51 },
];

(async () => {
  let playwright;
  try { playwright = require('playwright'); }
  catch { console.error('✗ 需要 playwright：npm i -D playwright'); process.exit(2); }

  const server = serve();
  const browser = await playwright.chromium.launch({ executablePath: EXEC }).catch(async () => playwright.chromium.launch());
  const fails = [];

  for (const theme of ['light', 'dark']) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: theme, serviceWorkers: 'block' });
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(String(e)));
    await page.goto(`http://127.0.0.1:${PORT}/index.html`);

    await page.evaluate((P) => {
      window.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) });
      window.toast = () => {};
      ALL = P; indexAll(); CFG = { contact_wa: '60123456789' }; _fresh = true; buildChips(); renderSeg(); render();
    }, PRODUCTS);
    await page.waitForTimeout(200);

    // 断言：店面关键元素
    const checks = await page.evaluate(() => ({
      cards: document.querySelectorAll('#grid .prod').length,
      trust: !!document.querySelector('.trust svg'),
      brandEyebrow: !!document.querySelector('#grid .pbrand'),
      priceMeta: !!document.querySelector('#grid .pmeta'),
    }));
    if (checks.cards < 2) fails.push(`[${theme}] 店面网格卡片数不足: ${checks.cards}`);
    if (!checks.trust) fails.push(`[${theme}] 缺金色担保条`);
    if (!checks.brandEyebrow) fails.push(`[${theme}] 商品卡缺品牌小标`);
    if (!checks.priceMeta) fails.push(`[${theme}] 商品卡缺社交证明行`);

    // 驱动：详情 / 心愿单 / 收藏 / 客服
    await page.evaluate(() => openSheet(1)); await page.waitForTimeout(250);
    const sheet = await page.evaluate(() => ({ open: document.getElementById('sheet').classList.contains('show'), price: !!document.querySelector('.sheet-price'), brand: !!document.querySelector('.sheet-brand') }));
    if (!sheet.open) fails.push(`[${theme}] 详情弹层没打开`);
    if (!sheet.price) fails.push(`[${theme}] 详情缺价格区`);
    await page.evaluate(() => closeSheet());
    await page.evaluate(() => { addCart(1); setTab('cart'); }); await page.waitForTimeout(150);
    await page.evaluate(() => setTab('fav')); await page.waitForTimeout(150);
    await page.evaluate(() => setTab('me')); await page.waitForTimeout(150);

    if (pageErrors.length) fails.push(`[${theme}] pageerror: ${pageErrors.slice(0, 3).join(' | ')}`);
    await ctx.close();
  }

  await browser.close();
  server.close();

  if (fails.length) { console.error('✗ 冒烟测试失败:\n' + fails.map(f => '  - ' + f).join('\n')); process.exit(1); }
  console.log('✓ 冒烟测试通过（店面/详情/心愿单/收藏/客服 · 双主题 · 零 pageerror）');
})();

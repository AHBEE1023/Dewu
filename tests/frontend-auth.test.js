const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const source = fs
  .readFileSync(new URL('../index.html', `file://${__filename}`), 'utf8')
  .replace(/<script src="[^"]+"><\/script>/g, '');

function queryResult(data) {
  const result = { data, error: null };
  const chain = {
    select() { return chain; },
    eq() { return chain; },
    order() { return chain; },
    limit() { return chain; },
    update() { return chain; },
    delete() { return chain; },
    maybeSingle() { return Promise.resolve(result); },
    then(resolve, reject) { return Promise.resolve(result).then(resolve, reject); },
  };
  return chain;
}

function makeDom({ url = 'https://shop.example/', session = null, admin = false } = {}) {
  const db = {
    auth: {
      getSession: async () => ({ data: { session: null } }),
      signInWithPassword: async () => ({ data: { session }, error: session ? null : new Error('invalid login') }),
      signOut: async () => ({ error: null }),
    },
    from(table) {
      if (table === 'admin_users') return queryResult(admin ? { user_id: session.user.id } : null);
      return queryResult([]);
    },
    functions: { invoke: async () => ({ data: null, error: null }) },
    storage: { from: () => ({}) },
  };

  return new JSDOM(source, {
    runScripts: 'dangerously',
    url,
    beforeParse(window) {
      window.supabase = { createClient: () => db };
      window.scrollTo = () => {};
      window.confirm = () => true;
    },
  });
}

const wait = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));

test('anonymous storefront hides management and still renders the public catalog state', async () => {
  const dom = makeDom();
  await wait();
  const doc = dom.window.document;

  assert.equal(doc.getElementById('shopView').classList.contains('hidden'), false);
  assert.equal(doc.getElementById('switch').classList.contains('hidden'), true);
  assert.match(doc.getElementById('grid').textContent, /店铺正在上新/);
  assert.equal(doc.getElementById('adminView').classList.contains('hidden'), true);
  dom.window.close();
});

test('admin route requires login and opens management only for an enrolled user', async () => {
  const session = { user: { id: 'admin-1', email: 'ahbee1023@gmail.com' } };
  const dom = makeDom({ url: 'https://shop.example/?admin=1', session, admin: true });
  await wait();
  const doc = dom.window.document;

  assert.equal(doc.getElementById('loginView').classList.contains('hidden'), false);
  assert.equal(doc.getElementById('adminView').classList.contains('hidden'), true);

  doc.getElementById('adminPassword').value = 'test-password';
  await dom.window.adminLogin();
  await wait();

  assert.equal(doc.getElementById('loginView').classList.contains('hidden'), true);
  assert.equal(doc.getElementById('adminView').classList.contains('hidden'), false);
  assert.equal(doc.getElementById('switch').classList.contains('hidden'), false);
  dom.window.close();
});

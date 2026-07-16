const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const migration = fs.readFileSync('supabase/migrations/20260716042438_secure_admin_access.sql', 'utf8');
const edge = fs.readFileSync('supabase/functions/parse-dewu-link/index.ts', 'utf8');
const config = fs.readFileSync('supabase/config.toml', 'utf8');
const html = fs.readFileSync('index.html', 'utf8');

test('database migration removes anonymous writes and enrolls the explicit administrator', () => {
  assert.doesNotMatch(migration, /create policy\s+"anon all"/i);
  assert.match(migration, /for select\s+to anon\s+using \(status = '已上架'\)/i);
  assert.match(migration, /for all\s+to authenticated/i);
  assert.match(migration, /ahbee1023@gmail\.com/i);
  assert.match(migration, /revoke all on table public\.products_369 from public, anon, authenticated/i);
});

test('Edge Function requires JWT, admin membership and a Dewu source host', () => {
  assert.match(config, /\[functions\.parse-dewu-link\][\s\S]*verify_jwt = true/);
  assert.match(edge, /supabase\.auth\.getUser\(token\)/);
  assert.match(edge, /\.from\("admin_users"\)/);
  assert.match(edge, /isAllowedSourceUrl\(sourceUrl\)/);
  assert.doesNotMatch(edge, /--no-verify-jwt/);
});

test('storefront query requests only public catalog fields', () => {
  assert.match(html, /select\('id,name_cn,brand,sku,sell_myr,image_url,images,status,created_at'\)/);
  assert.doesNotMatch(html, /ADMIN_PIN/);
});

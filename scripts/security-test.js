#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');

const read = (path) => fs.readFileSync(path, 'utf8');
const html = read('index.html');
const parse = read('supabase/functions/parse-dewu-link/index.ts');
const migration = read('supabase/migrations/20260716070000_secure_production_admin.sql');
const baseline = read('supabase/migrations/products_369.sql');
const config = read('supabase/config.toml');
const vercel = read('vercel.json');
const adminFunctions = [
  'admin-369',
  'account-369',
  'camp-369',
  'pay-369',
  'push-369',
  'review-369',
  'parse-dewu-link',
];

assert.doesNotMatch(html, /x-admin-pin|a369_pin|getPin\s*\(/i);
assert.match(html, /signInWithPassword\(\{email:ADMIN_EMAIL,password\}\)/);
assert.match(html, /Authorization':'Bearer '\+session\.access_token/);
assert.doesNotMatch(html, /Authorization':'Bearer '\+SUPABASE_ANON_KEY[^\n]+storage\/v1\/object/);

for (const name of adminFunctions) {
  const source = read(`supabase/functions/${name}/index.ts`);
  assert.match(source, /requireAdmin/, `${name} must require Supabase admin auth for admin actions`);
  assert.doesNotMatch(source, /ADMIN_PIN_369|x-admin-pin|\|\|\s*["']3690["']/i);
}

assert.doesNotMatch(parse, /GEMINI_KEY\s*=.*\|\|/);
assert.match(parse, /isAllowedSourceUrl/);
assert.match(parse, /x-goog-api-key/);
assert.match(parse, /MAX_PAGE_BYTES/);

assert.match(migration, /create table if not exists public\.admin_users/i);
assert.match(migration, /revoke all on table public\.products_369 from public, anon, authenticated/i);
assert.match(migration, /369 admin image insert/i);
assert.doesNotMatch(baseline, /create policy\s+"anon all"/i);
assert.doesNotMatch(baseline, /net\.http_post|create trigger parse_369_after_insert/i);
assert.match(config, /\[functions\.parse-dewu-link\][\s\S]*verify_jwt = false/);
assert.match(vercel, /Content-Security-Policy/);

console.log('✓ 安全回归检查通过（Auth / RLS / Storage / Edge Function / CSP）');

# Dewu / 369 甄选

移动端精选商品店面，包含商品管理、订单、拼团、付款凭证、评价、顾客账号、Telegram 通知与 Web Push。前端部署在 Vercel，数据和 Edge Functions 使用 Supabase。

## 管理员安全模型

- 顾客只访问公开视图和明确开放的顾客操作。
- 商品、订单、配置等后台操作统一经过 Edge Functions。
- 后台不再使用默认 PIN，也不会把管理密码保存在 localStorage。
- 管理员先使用 Supabase Auth 登录；每个后台函数再验证当前 access token 和 `public.admin_users` 成员资格。
- 当前管理员邮箱为 `ahbee1023@gmail.com`，公开注册必须保持关闭。
- 商品图片公开读取，但上传、替换和删除仅允许登记的管理员。
- `parse-dewu-link` 只接受管理员请求和得物官方 HTTPS 域名，并限制页面响应大小。

## Supabase 部署

1. 确认 Authentication 中已有并确认 `ahbee1023@gmail.com`。
2. 在 Authentication → Sign In / Providers 中关闭 **Allow new users to sign up**。
3. 应用 `supabase/migrations/20260716070000_secure_production_admin.sql`。
4. 轮换曾写入历史的 Gemini 密钥，并只保存为 Edge Function Secret `GEMINI_KEY`。
5. 部署所有函数；按 `supabase/config.toml` 保持 legacy gateway JWT verification 关闭。管理员函数会在代码内验证当前 Auth 用户。

```bash
supabase link --project-ref wgulnumflnumdpqfbjqy
supabase db push
supabase secrets set GEMINI_KEY=NEW_KEY
supabase functions deploy admin-369 --no-verify-jwt
supabase functions deploy account-369 --no-verify-jwt
supabase functions deploy camp-369 --no-verify-jwt
supabase functions deploy pay-369 --no-verify-jwt
supabase functions deploy push-369 --no-verify-jwt
supabase functions deploy review-369 --no-verify-jwt
supabase functions deploy parse-dewu-link --no-verify-jwt
```

## 验证

```bash
npm ci
npm test
deno check supabase/functions/admin-369/index.ts
deno check supabase/functions/account-369/index.ts
deno check supabase/functions/camp-369/index.ts
deno check supabase/functions/pay-369/index.ts
deno check supabase/functions/push-369/index.ts
deno check supabase/functions/review-369/index.ts
deno check supabase/functions/parse-dewu-link/index.ts
```

上线后确认：匿名请求后台函数返回 401、管理员可登录并管理商品、顾客浏览/下单/评价不受影响、Vercel 响应包含 CSP 等安全头。

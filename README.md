# Dewu / 369 甄选

Telegram-friendly mobile storefront with a protected product management area. Products are stored in Supabase, product text is parsed by a Supabase Edge Function, and the static frontend can be deployed on Vercel.

## Security model

- Anonymous customers can read only storefront-safe columns for products whose status is `已上架`.
- Authenticated users receive no catalog access unless their Auth user ID is enrolled in `public.admin_users`.
- The administrator can manage products and images after signing in with Supabase Auth.
- `parse-dewu-link` verifies both the Supabase user session and `admin_users` membership before it uses the service role or Gemini.
- Product image mutations require the administrator session. Public image delivery remains enabled.

The enrolled administrator email for this deployment is `ahbee1023@gmail.com`. Never commit or share that account's password.

## Required deployment order

1. In Supabase Auth, create and confirm `ahbee1023@gmail.com` before applying migrations.
2. Disable public email sign-ups in the hosted project's Auth provider settings. The repository's `config.toml` also disables them for local development.
3. Link the CLI to the existing project:

   ```bash
   supabase link --project-ref wgulnumflnumdpqfbjqy
   ```

4. Review and apply the migrations:

   ```bash
   supabase db push
   ```

5. Configure the Gemini secret. `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided by hosted Edge Functions:

   ```bash
   supabase secrets set GEMINI_KEY=YOUR_GEMINI_KEY
   ```

   Optional: override the allowed source domains. The secure defaults are `dewu.com,dw4.co`.

   ```bash
   supabase secrets set ALLOWED_SOURCE_HOSTS=dewu.com,dw4.co
   ```

6. Deploy the function with the legacy gateway JWT check disabled. The function
   validates the current Supabase Auth user and `admin_users` membership itself,
   which also supports the project's publishable key. In the Dashboard, leave
   **Verify JWT with legacy secret** off. With the CLI, run:

   ```bash
   supabase functions deploy parse-dewu-link --no-verify-jwt
   ```

7. Deploy the frontend to Vercel. Open the management login with `?admin=1`, for example:

   ```text
   https://YOUR_DOMAIN/?admin=1
   ```

## Business configuration

Set `CONTACT_WA` in `index.html` to the shop's WhatsApp number in international format, without `+`, spaces or dashes. Example: `60123456789`.

The RMB-to-MYR cost conversion currently uses `0.62` in the database trigger and Edge Function. Update both values together when the business rate changes.

## Verification checklist

- A normal customer can see only `已上架` products and cannot open the management switch.
- An unauthenticated request cannot insert, edit or delete products.
- A non-admin authenticated user receives no catalog rows.
- The enrolled administrator can sign in, parse a product, edit pricing, upload an image, publish it and delete it.
- Editing `price_rmb` automatically recalculates `price_myr`.
- The Edge Function rejects non-Dewu source URLs and unauthenticated requests.

Run the repository checks with:

```bash
npm ci
npm test
npm run check:browser-js
deno check --config supabase/functions/parse-dewu-link/deno.json supabase/functions/parse-dewu-link/index.ts
```

## Repository layout

- `index.html` — storefront and protected management UI
- `supabase/migrations/` — schema, grants and RLS policies
- `supabase/functions/parse-dewu-link/` — authenticated parsing Edge Function
- `vercel.json` — static response and security headers

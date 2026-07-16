-- 369 店面 API 加固（已于 2026-07-06 应用到 wgulnumflnumdpqfbjqy）：
-- 1) 顾客端只能读「已上架 + 安全字段」的视图（不含成本 price_rmb/price_myr、raw_text 等）
-- 2) 底表对 anon/authenticated 完全关闭，后台读写一律走 admin-369 函数（Supabase Auth 管理员校验）
create or replace view public.products_369_shop as
  select id, name_cn, brand, sku, sell_myr, image_url, images, created_at
  from public.products_369
  where status = '已上架';

grant select on public.products_369_shop to anon;
grant select on public.products_369_shop to authenticated;

drop policy if exists "anon all" on public.products_369;
revoke all on public.products_369 from anon;
revoke all on public.products_369 from authenticated;

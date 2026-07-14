-- ============================================================
-- 369 通知闭环 — 新单推店主 / 改状态推顾客
-- 1) orders_369.notified_owner：新单是否已通知店主，防重复推送 / 防重放刷屏
-- 2) app_secrets_369：私密配置（Telegram bot token / 店主 chat id）
--    只有 service role（admin-369 / order-notify-369）能读写，anon 完全无权。
--    ——绝不能放进 config_369（那张表 anon 可读，会泄露 bot token）。
-- ============================================================

alter table orders_369 add column if not exists notified_owner boolean not null default false;

create table if not exists app_secrets_369 (
  key text primary key,
  value text,
  updated_at timestamptz not null default now()
);
alter table app_secrets_369 enable row level security;
revoke all on app_secrets_369 from anon;
revoke all on app_secrets_369 from authenticated;

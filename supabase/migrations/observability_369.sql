-- ============================================================
-- 369 可观测性 & 后台加固
-- 1) events_369：埋点 + 错误 + 解析监控，一张表用 type 区分。
--    底表对 anon 锁死；匿名端只能走 track_369 RPC 写入（类型白名单 + 尺寸限制）。
-- 2) admin_attempts_369：后台 PIN 失败次数 + 锁定，防暴力猜。
-- 3) app_secrets_369.admin_pin_hash：店主自设强密码（sha-256），取代硬编码兜底 3690。
-- ============================================================

create table if not exists events_369 (
  id bigserial primary key,
  type text not null,               -- view/search/search_empty/wishlist_add/order_sent/error/parse_ok/parse_fail
  pid bigint,
  q text,
  meta jsonb,
  ck text,
  ua text,
  created_at timestamptz not null default now()
);
create index if not exists idx_events_369_type_time on events_369(type, created_at desc);
create index if not exists idx_events_369_pid on events_369(pid) where pid is not null;
alter table events_369 enable row level security;
revoke all on events_369 from anon;
revoke all on events_369 from authenticated;

-- 匿名埋点入口：类型白名单 + 字段截断 + 整体尺寸上限，防刷防注入
create or replace function public.track_369(t text, pid bigint, q text, meta jsonb, ck text, ua text)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if t is null then return; end if;
  if t not in ('view','search','search_empty','wishlist_add','order_sent','error') then
    return; -- 只收白名单事件；parse_* 由后台服务角色写，不走这里
  end if;
  if meta is not null and pg_column_size(meta) > 4000 then
    meta := null;
  end if;
  insert into events_369(type, pid, q, meta, ck, ua)
  values (t, pid, left(coalesce(q,''), 160), meta,
          left(coalesce(ck,''), 64), left(coalesce(ua,''), 300));
end;
$$;
revoke all on function public.track_369(text, bigint, text, jsonb, text, text) from public;
grant execute on function public.track_369(text, bigint, text, jsonb, text, text) to anon, authenticated;

-- 后台 PIN 失败限速表（服务角色管理）
create table if not exists admin_attempts_369 (
  ip text primary key,
  fails int not null default 0,
  locked_until timestamptz,
  updated_at timestamptz not null default now()
);
alter table admin_attempts_369 enable row level security;
revoke all on admin_attempts_369 from anon;
revoke all on admin_attempts_369 from authenticated;

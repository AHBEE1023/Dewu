-- ============================================================
-- 匿名写接口限速：固定 1 分钟窗口计数，按 client_key 分桶。
-- 挡住「脚本狂发假订单刷爆 Telegram」和「狂发埋点撑爆事件表」两类滥用。
-- 注意：rl_hit 的入参用 p_ 前缀，避免和 rl_369 的列名 k 冲突（PL/pgSQL 会报 ambiguous）。
-- ============================================================
create table if not exists rl_369 (
  k text not null,
  minute timestamptz not null,
  n int not null default 0,
  primary key (k, minute)
);

create or replace function public.rl_hit(p_k text, p_lim int)
returns boolean
language plpgsql security definer set search_path = public
as $$
declare cur int;
begin
  insert into rl_369(k, minute, n) values (p_k, date_trunc('minute', now()), 1)
    on conflict (k, minute) do update set n = rl_369.n + 1
    returning n into cur;
  return cur <= p_lim;
end;
$$;

-- 埋点：每个 client_key 每分钟最多 120 条，超了静默丢弃
create or replace function public.track_369(t text, pid bigint, q text, meta jsonb, ck text, ua text)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if t is null then return; end if;
  if t not in ('view','search','search_empty','wishlist_add','order_sent','error') then return; end if;
  if not rl_hit('trk:' || coalesce(ck, 'anon'), 120) then return; end if;
  if meta is not null and pg_column_size(meta) > 4000 then meta := null; end if;
  insert into events_369(type, pid, q, meta, ck, ua)
  values (t, pid, left(coalesce(q,''), 160), meta, left(coalesce(ck,''), 64), left(coalesce(ua,''), 300));
end;
$$;

-- 下单：每个 client_key 每分钟最多 8 单，超了报错（防刷单刷通知）
create or replace function public.create_order_369(ck text, tg bigint, ono text, its jsonb, tot numeric, cnt int)
returns bigint
language plpgsql security definer set search_path = public
as $$
declare nid bigint;
begin
  if ck is null or length(ck) < 8 or length(ck) > 64 then raise exception 'bad client key'; end if;
  if not rl_hit('ord:' || ck, 8) then raise exception 'too many orders, please slow down'; end if;
  if ono is null or length(ono) > 24 then raise exception 'bad order no'; end if;
  if its is null or jsonb_typeof(its) <> 'array' then raise exception 'bad items'; end if;
  if jsonb_array_length(its) < 1 or jsonb_array_length(its) > 60 then raise exception 'bad items length'; end if;
  if pg_column_size(its) >= 20000 then raise exception 'items too big'; end if;
  insert into orders_369 (order_no, client_key, tg_id, items, total, count, status)
  values (ono, ck, tg, its, tot, cnt, '已发送')
  returning id into nid;
  return nid;
end;
$$;

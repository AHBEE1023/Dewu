-- ============================================================
-- 拼团 / 集运批次：店主手动开一个团挂在店面首屏（倒计时 + 已拼进度），
-- 这段时间下的单自动归到本团（orders.campaign_id），凑够一起走国际直邮、摊薄运费。
-- 一次只挂一个 active 团（camp-369 开新团时会把旧团 active=false）。
-- anon 只能读 active 行；写团只走 camp-369（服务角色 + 店主 PIN）。
-- ============================================================
create table if not exists campaigns_369 (
  id bigserial primary key,
  title text not null,
  blurb text,
  deadline timestamptz,
  target int,
  joined int not null default 0,
  active bool not null default true,
  created_at timestamptz not null default now()
);
alter table campaigns_369 enable row level security;
-- 店面匿名只读当前活跃团
drop policy if exists anon_read_active_camp on campaigns_369;
create policy anon_read_active_camp on campaigns_369 for select to anon, authenticated using (active = true);
grant select on campaigns_369 to anon, authenticated;

-- 订单挂到团上
alter table orders_369 add column if not exists campaign_id bigint;
create index if not exists idx_orders_369_camp on orders_369(campaign_id) where campaign_id is not null;

-- 下单 RPC：再加一个拼团参数 camp（推荐码 rby 沿用）。下单落 campaign_id 并给活跃团 +件数。
-- 旧的 6 参 / 7 参重载保留作向后兼容。
create or replace function public.create_order_369(ck text, tg bigint, ono text, its jsonb, tot numeric, cnt int, rby text default null, camp bigint default null)
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
  insert into orders_369 (order_no, client_key, tg_id, items, total, count, status, referred_by, campaign_id)
  values (ono, ck, tg, its, tot, cnt, '已发送', nullif(left(coalesce(rby,''),16),''), camp)
  returning id into nid;
  if camp is not null then
    update campaigns_369 set joined = joined + greatest(coalesce(cnt,1),1)
      where id = camp and active = true and (deadline is null or deadline > now());
  end if;
  return nid;
end;
$$;
revoke all on function public.create_order_369(text, bigint, text, jsonb, numeric, int, text, bigint) from public;
grant execute on function public.create_order_369(text, bigint, text, jsonb, numeric, int, text, bigint) to anon, authenticated;

-- ============================================================
-- 推荐裂变：订单记下推荐码；下单 RPC 接收推荐码；查自己成功推荐了几单。
-- 推荐码 = 顾客 client_key 尾 6 位(前端派生，无需建表)。奖励(减运费)由客服核价时抵扣。
-- ============================================================
alter table orders_369 add column if not exists referred_by text;
create index if not exists idx_orders_369_refby on orders_369(referred_by) where referred_by is not null;

-- 下单 RPC：多收一个推荐码参数 rby（限速/校验沿用）。旧 6 参重载保留作向后兼容。
create or replace function public.create_order_369(ck text, tg bigint, ono text, its jsonb, tot numeric, cnt int, rby text default null)
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
  insert into orders_369 (order_no, client_key, tg_id, items, total, count, status, referred_by)
  values (ono, ck, tg, its, tot, cnt, '已发送', nullif(left(coalesce(rby,''),16),''))
  returning id into nid;
  return nid;
end;
$$;
revoke all on function public.create_order_369(text, bigint, text, jsonb, numeric, int, text) from public;
grant execute on function public.create_order_369(text, bigint, text, jsonb, numeric, int, text) to anon, authenticated;

-- 查自己成功推荐了几单（凭自己的推荐码，只回个数）
create or replace function public.my_referrals(code text)
returns int
language plpgsql security definer set search_path = public
as $$
declare n int;
begin
  if code is null or length(code) < 4 or length(code) > 16 then return 0; end if;
  select count(*) into n from orders_369 where referred_by = code;
  return coalesce(n,0);
end;
$$;
revoke all on function public.my_referrals(text) from public;
grant execute on function public.my_referrals(text) to anon, authenticated;

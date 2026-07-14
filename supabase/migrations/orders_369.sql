-- ============================================================
-- 369 订单跟踪 — 建表 + RLS + 匿名下单/查单 RPC
-- 安全模型：
--   1) orders_369 底表开 RLS 且【不给 anon 任何 policy】——
--      匿名端直连 REST 读写一律被拒，防止翻别人订单、乱改状态。
--   2) 顾客端只能走两个 security definer RPC：
--        create_order_369 —— 下单（状态强制 '已发送'，不受调用方控制）
--        my_orders_369    —— 只凭自己的 client_key 查自己的单（最多 30 条）
--      client_key 由前端本机生成（8–64 位随机串），等于「不记名取件码」。
--   3) 后台改状态/备注/删单走 admin-369 网关（服务角色 + x-admin-pin），
--      服务角色天然绕过 RLS，无需额外 policy。
-- ============================================================

create table if not exists orders_369 (
  id bigserial primary key,
  order_no text not null,                -- 订单号（前端生成的短号，展示用）
  client_key text not null,              -- 顾客本机匿名钥匙（查单凭证）
  tg_id bigint,                          -- Telegram id（若有）
  items jsonb not null,                  -- 下单商品快照 [{id,name,qty,price...}]
  total numeric,                         -- 合计马币
  count int,                             -- 件数
  status text not null default '已发送', -- 已发送/已确认/已付款/已采购/运输中/已到手/已取消
  note text,                             -- 店主备注（顾客可见）
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_orders_369_ck on orders_369(client_key, created_at desc);

-- 开 RLS 且不建任何 anon policy：底表对匿名端完全锁死
alter table orders_369 enable row level security;
revoke all on orders_369 from anon;
revoke all on orders_369 from authenticated;

-- ============================================================
-- 下单 RPC（anon 可调，security definer 绕过 RLS，但入口做足校验）：
--   ck 8–64 位；单号 ≤24；items 必须是 1–60 个元素的 JSON 数组且 <20KB；
--   状态永远写死 '已发送'，调用方无法伪造。
-- ============================================================
create or replace function public.create_order_369(ck text, tg bigint, ono text, its jsonb, tot numeric, cnt int)
returns bigint
language plpgsql
security definer set search_path = public
as $$
declare nid bigint;
begin
  if ck is null or length(ck) < 8 or length(ck) > 64 then
    raise exception 'bad client key';
  end if;
  if ono is null or length(ono) > 24 then
    raise exception 'bad order no';
  end if;
  if its is null or jsonb_typeof(its) <> 'array' then
    raise exception 'bad items';
  end if;
  if jsonb_array_length(its) < 1 or jsonb_array_length(its) > 60 then
    raise exception 'bad items length';
  end if;
  if pg_column_size(its) >= 20000 then
    raise exception 'items too big';
  end if;
  insert into orders_369 (order_no, client_key, tg_id, items, total, count, status)
  values (ono, ck, tg, its, tot, cnt, '已发送')
  returning id into nid;
  return nid;
end;
$$;

-- ============================================================
-- 查单 RPC（anon 可调）：只凭 client_key 查自己的单，
-- 不回传 client_key/tg_id 等敏感列，最多最近 30 条。
-- ============================================================
create or replace function public.my_orders_369(ck text)
returns jsonb
language plpgsql
security definer set search_path = public
as $$
begin
  if ck is null or length(ck) < 8 or length(ck) > 64 then
    raise exception 'bad client key';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', o.id,
      'order_no', o.order_no,
      'items', o.items,
      'total', o.total,
      'count', o.count,
      'status', o.status,
      'note', o.note,
      'created_at', o.created_at
    ) order by o.created_at desc)
    from (
      select * from orders_369
      where client_key = ck
      order by created_at desc
      limit 30
    ) o
  ), '[]'::jsonb);
end;
$$;

-- 收紧执行权限：先全收回，再只放给 anon / authenticated
revoke all on function public.create_order_369(text, bigint, text, jsonb, numeric, int) from public;
grant execute on function public.create_order_369(text, bigint, text, jsonb, numeric, int) to anon, authenticated;

revoke all on function public.my_orders_369(text) from public;
grant execute on function public.my_orders_369(text) to anon, authenticated;

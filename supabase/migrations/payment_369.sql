-- ============================================================
-- 付款凭证闭环：顾客照收款码转账 → 上传付款截图挂到订单 → 店主确认收款。
-- 收款码(QR) + 付款截图都存私有桶 pay369(anon 无 policy 完全锁死，只 service role 读写)。
-- my_orders_369 增回 pay_status 让顾客看到自己的付款状态。
-- ============================================================
alter table orders_369 add column if not exists pay_status text;  -- null / 待确认 / 已确认
alter table orders_369 add column if not exists pay_proof text;
alter table orders_369 add column if not exists pay_at timestamptz;

insert into storage.buckets (id, name, public) values ('pay369','pay369', false)
on conflict (id) do nothing;

create or replace function public.my_orders_369(ck text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if ck is null or length(ck) < 8 or length(ck) > 64 then raise exception 'bad client key'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', o.id, 'order_no', o.order_no, 'items', o.items, 'total', o.total,
      'count', o.count, 'status', o.status, 'note', o.note,
      'pay_status', o.pay_status, 'created_at', o.created_at
    ) order by o.created_at desc)
    from (select * from orders_369 where client_key = ck order by created_at desc limit 30) o
  ), '[]'::jsonb);
end;
$$;

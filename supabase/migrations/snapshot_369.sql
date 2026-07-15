-- ============================================================
-- 免费版兜底备份：每天把订单/成交/货品三张关键表快照成 JSON，留最近 14 份。
-- 防「误删 / 迁移写错 / 手滑批量删」——最常见的数据事故。
-- 注意：这是同库快照，【不防整个项目丢失/损坏】。真正的容灾要升 Supabase Pro
--       （日备份 + 时间点恢复 PITR）。此表仅服务角色可读。
-- ============================================================
create table if not exists backups_369 (
  id bigserial primary key,
  taken_at timestamptz not null default now(),
  orders jsonb, sales jsonb, products jsonb
);
alter table backups_369 enable row level security;
revoke all on backups_369 from anon;
revoke all on backups_369 from authenticated;

create or replace function public.snapshot_369()
returns void
language plpgsql security definer set search_path = public
as $$
begin
  insert into backups_369(orders, sales, products) values (
    (select coalesce(jsonb_agg(o), '[]'::jsonb) from orders_369 o),
    (select coalesce(jsonb_agg(s), '[]'::jsonb) from sales_369 s),
    (select coalesce(jsonb_agg(p), '[]'::jsonb) from products_369 p)
  );
  delete from backups_369 where id not in (select id from backups_369 order by taken_at desc limit 14);
end;
$$;

select cron.schedule('snapshot-369', '0 2 * * *', 'select public.snapshot_369()');

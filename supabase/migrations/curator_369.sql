-- Release 1「主理人版核心」地基（已于 2026-07-17 通过 MCP 应用到生产）：
-- 库存四态 + 到货动态 + 帮我找 + 公开图桶。
-- 1) 库存列：null=预订不限量(默认)，>0=现货/仅剩N件，0=已抢完
alter table products_369 add column if not exists stock int;

-- 2) 重建店面视图：CREATE OR REPLACE 不允许改列序，必须 drop 后重建；stock 追加在末尾
drop view if exists products_369_shop;
create view products_369_shop as
  select id, name_cn, brand, sku, category, sell_myr, orig_myr,
         image_url, images, created_at, sold_count, hot, soldout, views, review_shots,
         (select jsonb_agg(jsonb_build_object('k', e.value->>'k', 'v', e.value->>'v'))
            from jsonb_array_elements(coalesce(products_369.params,'[]'::jsonb)) e
           where coalesce((e.value->>'on')::boolean, false)) as params,
         (select jsonb_agg(jsonb_build_object('name', e.value->>'name', 'sell', e.value->'sell'))
            from jsonb_array_elements(coalesce(products_369.variants,'[]'::jsonb)) e
           where coalesce((e.value->>'on')::boolean, false)) as variants,
         video_url,
         stock
  from products_369
  where status = '已上架';
grant select on products_369_shop to anon, authenticated;

-- 3) 到货动态：店主发布的开箱/到货贴，匿名可读 active 的
create table if not exists posts_369 (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  text text not null,
  photos jsonb not null default '[]'::jsonb,
  product_id bigint references products_369(id) on delete set null,
  pname text,
  pprice numeric,
  qty int,
  active boolean not null default true
);
alter table posts_369 enable row level security;
drop policy if exists "posts_369 anon read active" on posts_369;
create policy "posts_369 anon read active" on posts_369
  for select to anon, authenticated using (active);

-- 4) 帮我找(代寻)请求日志：RLS 全锁，只能走 RPC 写、service role 读
create table if not exists sourcing_369 (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  ck text not null,
  txt text not null,
  budget text,
  status text not null default 'new'
);
alter table sourcing_369 enable row level security;

-- 5) 写入 RPC：限频 6次/窗口，长度校验；绝不回读任何数据
create or replace function log_sourcing_369(p_ck text, p_txt text, p_budget text default null)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if p_ck is null or length(p_ck) < 8 or length(p_ck) > 64 then
    raise exception 'bad ck';
  end if;
  if p_txt is null or length(trim(p_txt)) < 2 or length(p_txt) > 500 then
    raise exception 'bad txt';
  end if;
  if p_budget is not null and length(p_budget) > 50 then
    raise exception 'bad budget';
  end if;
  perform rl_hit('src:' || p_ck, 6);
  insert into sourcing_369 (ck, txt, budget) values (p_ck, trim(p_txt), p_budget);
end;
$$;
revoke all on function log_sourcing_369(text, text, text) from public;
grant execute on function log_sourcing_369(text, text, text) to anon, authenticated;

-- 6) 到货动态公开图桶（预留；当前照片沿用 product-369 桶前缀 fd 的既有直传通道）
insert into storage.buckets (id, name, public)
values ('feed369', 'feed369', true)
on conflict (id) do nothing;

-- ============================================================
-- 真人评价：已购顾客对买过的商品打分 + 留言 + 可选晒图。
-- 校验「确实买过这件」只走 review-369 边缘函数（服务角色）；表本身 anon 全锁死，
-- 店面只读公开视图 reviews_369_pub（只出展示字段，client_key 绝不出库）。
-- 晒图存公开桶 rev369（评价本就要公开展示，直出 public URL，免签名过期）。
-- ============================================================
create table if not exists reviews_369 (
  id bigserial primary key,
  product_id bigint not null,
  order_id bigint,
  client_key text not null,
  rating int not null check (rating between 1 and 5),
  body text,
  photo text,                 -- rev369 桶里的公开 URL
  nickname text,
  status text not null default 'shown',   -- shown / hidden
  created_at timestamptz not null default now()
);
alter table reviews_369 enable row level security;
revoke all on reviews_369 from anon;
revoke all on reviews_369 from authenticated;
-- 一个人对同一件货只留一条（重复提交走覆盖更新）
create unique index if not exists uniq_review_369 on reviews_369(product_id, client_key);
create index if not exists idx_review_369_pid on reviews_369(product_id) where status = 'shown';

-- 店面只读公开视图：只暴露展示字段 + 过滤 shown
create or replace view reviews_369_pub as
  select id, product_id, rating, body, photo, nickname, created_at
  from reviews_369
  where status = 'shown';
grant select on reviews_369_pub to anon, authenticated;

-- 晒图公开桶
insert into storage.buckets (id, name, public)
  values ('rev369', 'rev369', true)
  on conflict (id) do update set public = true;

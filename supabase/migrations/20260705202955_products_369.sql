-- ============================================================
-- 369 得物解析 — 基础表结构（由 Supabase CLI migration 执行）
-- 「贴链接 / 贴分享文字 → 自动解析入库」的落库表
-- ============================================================

create table if not exists products_369 (
  id bigint generated always as identity primary key,
  name_cn text not null,                 -- 商品中文名
  brand text,                            -- 品牌
  sku text,                              -- 货号 / 型号
  price_rmb numeric,                     -- 得物人民币价（元）
  price_myr numeric,                     -- 折算马币成本（price_rmb × 汇率）
  sell_myr numeric,                      -- 马币售价（人工填，默认空）
  image_url text,                        -- 商品主图（图库第一张；上架前应确认图片使用权）
  images text[],                         -- 商品图库（多图，详情页轮播）
  source text default 'dewu',            -- 来源
  status text default '待选',            -- 状态：待选 / 已上架 …
  source_url text,                       -- 原始链接（若有）
  raw_text text,                         -- 原始输入（链接或分享文字，留档排错用）
  created_by bigint,                     -- 提交人 Telegram id（若有）
  client_ref text,                       -- 前端本次请求的幂等标识（弱网重试去重用）
  created_at timestamptz default now()
);

create index if not exists idx_369_status on products_369(status);
create index if not exists idx_369_created on products_369(created_at desc);
create index if not exists idx_369_client_ref on products_369(client_ref);

-- 权限由后续 secure_admin_access migration 统一配置。
-- 基础 migration 默认保持 fail-closed，避免新环境在两次 migration 之间暴露写权限。
alter table products_369 enable row level security;

drop policy if exists "anon all" on products_369;

-- client_ref 唯一（部分索引）：REST 重发去重，弱网重试多少次都只有一行
create unique index if not exists uq_369_client_ref on products_369(client_ref) where client_ref is not null;

-- ============================================================
-- 手动上传/换商品图用的公开存储桶（仅上传有权使用的图片）
-- ============================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-369','product-369', true, 8388608, array['image/jpeg','image/png','image/webp','image/gif'])
on conflict (id) do update set public=true, file_size_limit=8388608,
  allowed_mime_types=array['image/jpeg','image/png','image/webp','image/gif'];

drop policy if exists "369 img read" on storage.objects;
drop policy if exists "369 img write" on storage.objects;
drop policy if exists "369 img update" on storage.objects;
drop policy if exists "369 img delete" on storage.objects;

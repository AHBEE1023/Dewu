-- ============================================================
-- 369 得物解析 — 建表 + RLS（在 Supabase SQL Editor 里跑一次）
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
  image_url text,                        -- 商品主图（图库第一张；先盗得物原图，入库后自己换更安全）
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

-- 权限由后续安全 migration / products_369_shop 视图配置。
-- 基础建表默认 fail-closed，避免迁移中途暴露匿名写权限。
alter table products_369 enable row level security;

drop policy if exists "anon all" on products_369;

-- ============================================================
-- 弱网/移动网络下也能入库：前端只用「快」的 REST 插一行占位（和加载列表同一通道），
-- 插入后由这个触发器在服务器端调解析函数（parse-dewu-link, rowId 模式）把名字/价格/图回填。
-- 前端全程不用连「慢」的函数端点，请求极短，移动中被基站切换掐断的概率大幅降低。
-- ============================================================
-- client_ref 唯一（部分索引）：REST 重发去重，弱网重试多少次都只有一行
create unique index if not exists uq_369_client_ref on products_369(client_ref) where client_ref is not null;

-- ============================================================
-- 手动上传/换商品图用的公开存储桶（不盗得物原图，更安全）
-- ============================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-369','product-369', true, 8388608, array['image/jpeg','image/png','image/webp','image/gif'])
on conflict (id) do update set public=true, file_size_limit=8388608,
  allowed_mime_types=array['image/jpeg','image/png','image/webp','image/gif'];

drop policy if exists "369 img read" on storage.objects;
drop policy if exists "369 img write" on storage.objects;
drop policy if exists "369 img update" on storage.objects;
drop policy if exists "369 img delete" on storage.objects;

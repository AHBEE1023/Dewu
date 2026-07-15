-- 把真人评价的社交证明接进购物漏斗：每件货的平均分 + 评价数，店面卡片/排序用。
-- 只出聚合(avg/cnt)，绝不出 client_key；view 走 owner 权限绕过 reviews_369 的 RLS（同 reviews_369_pub 模式）。
create or replace view review_stats_369 as
  select product_id,
         round(avg(rating)::numeric, 1) as avg_rating,
         count(*)::int as cnt
  from reviews_369
  where status = 'shown'
  group by product_id;
grant select on review_stats_369 to anon, authenticated;

begin;

-- Only explicitly enrolled Auth users may use the management interface.
create table if not exists public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.admin_users enable row level security;

revoke all on table public.admin_users from public, anon, authenticated;
grant select on table public.admin_users to authenticated, service_role;

drop policy if exists "admin can verify own membership" on public.admin_users;
create policy "admin can verify own membership"
  on public.admin_users
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- Fail closed if the account is not present in a fresh environment. The README
-- documents that this Auth user must be created before applying migrations.
insert into public.admin_users (user_id)
select id
from auth.users
where lower(email) = lower('ahbee1023@gmail.com')
on conflict (user_id) do nothing;

-- Remove the original MVP trigger. Parsing is now invoked by an authenticated
-- administrator, so there is no public database-to-function callback secret.
drop trigger if exists parse_369_after_insert on public.products_369;
drop function if exists public.trg_parse_369();

alter table public.products_369 enable row level security;

drop policy if exists "anon all" on public.products_369;
drop policy if exists "public catalog read" on public.products_369;
drop policy if exists "admin manages catalog" on public.products_369;

revoke all on table public.products_369 from public, anon, authenticated;

-- Anonymous customers receive only storefront-safe fields. Cost, source text,
-- Telegram IDs and internal references remain unavailable at the privilege layer.
grant select (
  id,
  name_cn,
  brand,
  sku,
  sell_myr,
  image_url,
  images,
  status,
  created_at
) on table public.products_369 to anon;

-- Authenticated users still need an admin_users row before RLS returns anything.
grant select, insert, update, delete on table public.products_369 to authenticated, service_role;
grant usage, select on sequence public.products_369_id_seq to authenticated, service_role;

create policy "public catalog read"
  on public.products_369
  for select
  to anon
  using (status = '已上架');

create policy "admin manages catalog"
  on public.products_369
  for all
  to authenticated
  using (
    exists (
      select 1
      from public.admin_users au
      where au.user_id = (select auth.uid())
    )
  )
  with check (
    exists (
      select 1
      from public.admin_users au
      where au.user_id = (select auth.uid())
    )
  );

-- Keep MYR cost synchronized whenever the RMB price is edited.
create or replace function public.sync_products_369_price_myr()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.price_myr := case
    when new.price_rmb is null then null
    else round(new.price_rmb * 0.62, 2)
  end;
  return new;
end;
$$;

revoke all on function public.sync_products_369_price_myr() from public, anon, authenticated;

drop trigger if exists sync_products_369_price_myr on public.products_369;
create trigger sync_products_369_price_myr
before insert or update of price_rmb on public.products_369
for each row execute function public.sync_products_369_price_myr();

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'products_369_nonnegative_prices'
      and conrelid = 'public.products_369'::regclass
  ) then
    alter table public.products_369
      add constraint products_369_nonnegative_prices
      check (
        (price_rmb is null or price_rmb >= 0)
        and (price_myr is null or price_myr >= 0)
        and (sell_myr is null or sell_myr >= 0)
      ) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'products_369_valid_status'
      and conrelid = 'public.products_369'::regclass
  ) then
    alter table public.products_369
      add constraint products_369_valid_status
      check (status is not null and status in ('待选', '已上架', '下架')) not valid;
  end if;
end
$$;

-- Public assets remain readable, while object mutations require the enrolled
-- administrator. A publishable key alone can no longer upload or delete files.
drop policy if exists "369 img read" on storage.objects;
drop policy if exists "369 img write" on storage.objects;
drop policy if exists "369 img update" on storage.objects;
drop policy if exists "369 img delete" on storage.objects;
drop policy if exists "369 public image read" on storage.objects;
drop policy if exists "369 admin image read" on storage.objects;
drop policy if exists "369 admin image insert" on storage.objects;
drop policy if exists "369 admin image update" on storage.objects;
drop policy if exists "369 admin image delete" on storage.objects;

create policy "369 public image read"
  on storage.objects
  for select
  to anon
  using (bucket_id = 'product-369');

create policy "369 admin image read"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'product-369'
    and exists (
      select 1 from public.admin_users au
      where au.user_id = (select auth.uid())
    )
  );

create policy "369 admin image insert"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'product-369'
    and exists (
      select 1 from public.admin_users au
      where au.user_id = (select auth.uid())
    )
  );

create policy "369 admin image update"
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'product-369'
    and exists (
      select 1 from public.admin_users au
      where au.user_id = (select auth.uid())
    )
  )
  with check (
    bucket_id = 'product-369'
    and exists (
      select 1 from public.admin_users au
      where au.user_id = (select auth.uid())
    )
  );

create policy "369 admin image delete"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'product-369'
    and exists (
      select 1 from public.admin_users au
      where au.user_id = (select auth.uid())
    )
  );

commit;

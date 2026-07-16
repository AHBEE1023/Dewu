begin;

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

insert into public.admin_users (user_id)
select id
from auth.users
where lower(email) = lower('ahbee1023@gmail.com')
on conflict (user_id) do nothing;

-- The production UI and all catalog mutations use authenticated Edge
-- Functions. Keep the base table closed and expose only products_369_shop.
drop trigger if exists parse_369_after_insert on public.products_369;
drop function if exists public.trg_parse_369();
alter table public.products_369 enable row level security;
drop policy if exists "anon all" on public.products_369;
drop policy if exists "public catalog read" on public.products_369;
drop policy if exists "admin manages catalog" on public.products_369;
revoke all on table public.products_369 from public, anon, authenticated;

-- Public product images stay readable. Only the enrolled Supabase Auth
-- administrator may upload, replace, or remove objects in this bucket.
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
  on storage.objects for select to anon
  using (bucket_id = 'product-369');

create policy "369 admin image read"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'product-369'
    and exists (
      select 1 from public.admin_users au
      where au.user_id = (select auth.uid())
    )
  );

create policy "369 admin image insert"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'product-369'
    and exists (
      select 1 from public.admin_users au
      where au.user_id = (select auth.uid())
    )
  );

create policy "369 admin image update"
  on storage.objects for update to authenticated
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
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'product-369'
    and exists (
      select 1 from public.admin_users au
      where au.user_id = (select auth.uid())
    )
  );

commit;

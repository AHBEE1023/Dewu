-- ============================================================
-- 主动解析告警 + 数据保留（pg_cron + pg_net）
-- 1) parse_watch_369：每 10 分钟查一次「解析中」积压，卡超 30 分钟就推店主 Telegram，
--    3 小时内只报一次防刷屏，积压清零后自动复位（删 parse_alert_at 标记）。
-- 2) retention_369：每天 03:00 UTC 清理过期埋点(90d)/限速(2d)/锁定记录，控表大小和成本。
-- 依赖扩展：pg_cron、pg_net（Supabase 默认可用）。
-- ============================================================

create or replace function public.parse_watch_369()
returns void
language plpgsql security definer set search_path = public
as $$
declare
  stuck int; token text; chat text; last_alert text;
begin
  select count(*) into stuck from products_369
    where name_cn like '⏳%' and created_at < now() - interval '30 minutes';
  if stuck = 0 then
    delete from app_secrets_369 where key = 'parse_alert_at';
    return;
  end if;
  select value into last_alert from app_secrets_369 where key = 'parse_alert_at';
  if last_alert is not null and last_alert::timestamptz > now() - interval '3 hours' then
    return;
  end if;
  select value into token from app_secrets_369 where key = 'tg_bot_token';
  select value into chat  from app_secrets_369 where key = 'tg_owner_chat';
  if coalesce(token,'') = '' or coalesce(chat,'') = '' then return; end if;
  perform net.http_post(
    url := 'https://api.telegram.org/bot' || token || '/sendMessage',
    headers := jsonb_build_object('Content-Type','application/json'),
    body := jsonb_build_object('chat_id', chat, 'text',
      '⚠️ 369 解析可能挂了：有 ' || stuck || ' 件货卡在「解析中」超过 30 分钟。' ||
      '得物可能临时封爬 / 限流，去后台「📊 数据看板」看看，或稍后重试解析。')
  );
  insert into app_secrets_369(key, value, updated_at) values ('parse_alert_at', now()::text, now())
    on conflict (key) do update set value = excluded.value, updated_at = now();
end;
$$;

create or replace function public.retention_369()
returns void
language plpgsql security definer set search_path = public
as $$
begin
  delete from events_369 where created_at < now() - interval '90 days';
  delete from rl_369 where minute < now() - interval '2 days';
  delete from admin_attempts_369 where updated_at < now() - interval '2 days'
    and (locked_until is null or locked_until < now());
end;
$$;

select cron.schedule('parse-watch-369', '*/10 * * * *', 'select public.parse_watch_369()');
select cron.schedule('retention-369',  '0 3 * * *',    'select public.retention_369()');

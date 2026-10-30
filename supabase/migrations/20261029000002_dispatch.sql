-- Server-side scheduling: recurrence materialisation, atomic claiming, retries. Called by pg_cron through the
-- dispatch-reminders Edge Function; safe to run concurrently and safe to run repeatedly (idempotent).

-- Roll every active series forward `p_horizon_days`, in the owner's time zone. Same key format as the client
-- ('series:<id>:<yyyy-mm-dd>') so the app and the server never create the same occurrence twice.
create or replace function public.materialize_reminders(p_horizon_days int default 2) returns int
language plpgsql security definer set search_path = public as $$
declare s record; d int; local_day date; due timestamptz; inserted int := 0; got int;
begin
  for s in select * from public.reminder_series where active loop
    for d in 0..p_horizon_days loop
      local_day := ((now() at time zone s.time_zone)::date) + d;
      due := ((local_day + s.local_time::time) at time zone s.time_zone);
      continue when due < s.start_at;
      continue when s.ends_on is not null and local_day > s.ends_on;
      insert into public.reminders(id, owner_id, kind, title, notes, medication_id, series_id, scheduled_for, original_scheduled_for,
                                   time_zone, recurrence, idempotency_key)
      values ('rem_series:' || s.id || ':' || local_day::text, s.owner_id, s.kind, s.title, s.notes, s.medication_id, s.id, due, due,
              s.time_zone, jsonb_build_object('freq','daily','localTime', s.local_time), 'series:' || s.id || ':' || local_day::text)
      on conflict (owner_id, idempotency_key) do nothing;
      get diagnostics got = row_count;
      inserted := inserted + got;
    end loop;
  end loop;
  return inserted;
end $$;

-- Atomically take due reminders. FOR UPDATE SKIP LOCKED means two dispatchers never get the same row, and
-- `dispatched_for` means the same due time is never dispatched twice (a snooze changes scheduled_for, so it re-arms).
create or replace function public.claim_due_reminders(p_batch int default 100) returns setof public.reminders
language plpgsql security definer set search_path = public as $$
begin
  return query
  with due as (
    select id from public.reminders
     where status in ('scheduled','snoozed')
       and scheduled_for <= now()
       and (next_attempt_at is null or next_attempt_at <= now())
       and dispatched_for is distinct from scheduled_for
     order by scheduled_for
     limit p_batch
     for update skip locked
  )
  update public.reminders r
     set status = 'ringing', dispatched_for = r.scheduled_for, dispatch_attempts = r.dispatch_attempts + 1, updated_at = now()
    from due where r.id = due.id
  returning r.*;
end $$;

-- Delivery failed for every device: put it back with exponential backoff (1,2,4,8 min); give up after 5 tries.
create or replace function public.release_for_retry(p_id text, p_error text) returns void
language plpgsql security definer set search_path = public as $$
declare r public.reminders;
begin
  select * into r from public.reminders where id = p_id for update;
  if not found or r.status <> 'ringing' then return; end if;
  if r.dispatch_attempts >= 5 then
    update public.reminders set last_dispatch_error = left(p_error, 500) where id = p_id;  -- stays 'ringing': visible in-app
  else
    update public.reminders set status = 'scheduled', dispatched_for = null, last_dispatch_error = left(p_error, 500),
           next_attempt_at = now() + make_interval(mins => power(2, r.dispatch_attempts - 1)::int)
     where id = p_id;
  end if;
end $$;

-- Unanswered for an hour → missed. Never marks anything "taken".
create or replace function public.expire_stale_reminders(p_minutes int default 60) returns int
language sql security definer set search_path = public as $$
  with u as (
    update public.reminders set status = 'missed'
     where status in ('ringing','declined') and scheduled_for < now() - make_interval(mins => p_minutes)
    returning 1)
  select count(*)::int from u
$$;

revoke all on function public.materialize_reminders(int), public.claim_due_reminders(int), public.release_for_retry(text, text), public.expire_stale_reminders(int) from public, anon, authenticated;
grant execute on function public.materialize_reminders(int), public.claim_due_reminders(int), public.release_for_retry(text, text), public.expire_stale_reminders(int) to service_role;

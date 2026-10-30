-- Schedule the dispatcher every minute (requires the pg_cron and pg_net extensions, enabled in the Supabase dashboard).
-- Set the two settings once (SQL editor):  
--   alter database postgres set app.settings.functions_url = 'https://<project-ref>.supabase.co/functions/v1';
--   alter database postgres set app.settings.cron_secret   = '<same value as the CRON_SECRET function secret>';
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'smaran-dispatch-reminders', '* * * * *',
  $$ select net.http_post(
       url := current_setting('app.settings.functions_url') || '/dispatch-reminders',
       headers := jsonb_build_object('Content-Type','application/json','x-cron-secret', current_setting('app.settings.cron_secret')),
       body := '{}'::jsonb,
       timeout_milliseconds := 20000) $$
);

-- Private bucket for prescription images/PDFs: each user can only touch the folder named after their user id.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('prescriptions', 'prescriptions', false, 10485760, array['image/jpeg','image/png','image/webp','image/heic','image/heif','application/pdf'])
on conflict (id) do nothing;

create policy "prescriptions_owner_rw" on storage.objects for all to authenticated
  using (bucket_id = 'prescriptions' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'prescriptions' and (storage.foldername(name))[1] = auth.uid()::text);

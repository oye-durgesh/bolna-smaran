-- Voice / agent reminder creation: provenance and delivery-channel columns. Additive. Reminders already carry person_id (migration 5),
-- idempotency_key (unique per owner), time_zone (IANA), status, snooze/reschedule history and delivery attempts (migration 1/2).
-- "workspace_id" in the product spec == owner_id here: one account is one family workspace.
alter table public.reminders add column source text not null default 'app' check (source in ('app','voice','agent','family','server'));
alter table public.reminders add column created_by uuid references auth.users(id) on delete set null;
alter table public.reminders add column delivery_channel text not null default 'push' check (delivery_channel in ('push','in_app'));
alter table public.reminder_series add column source text not null default 'app' check (source in ('app','voice','agent','family','server'));
alter table public.reminder_series add column created_by uuid references auth.users(id) on delete set null;
-- reminder titles are free text from the user: bound them (the function validates too)
alter table public.reminders add constraint reminder_title_len check (char_length(btrim(title)) between 1 and 200);

-- Edge Functions write audit entries as the signed-in user. Users may add entries about their own account only, and cannot edit or delete them.
create policy audit_insert on public.audit_logs for insert with check (owner_id = auth.uid() and actor = auth.uid());

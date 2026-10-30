-- A dose can be explicitly skipped (a recorded choice, different from "missed"). It never consumes stock and is never "made up".
alter table public.reminders drop constraint reminders_status_check;
alter table public.reminders add constraint reminders_status_check check (status in ('scheduled','ringing','snoozed','completed','missed','cancelled','declined','skipped'));
alter table public.reminders add column skipped_at timestamptz;

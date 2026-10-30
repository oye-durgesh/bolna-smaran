-- Family profiles ("care recipients"). One signed-in account (the owner / caregiver) can hold several people:
-- their own health profile ("self") and any number of parents (Mummy, Papa, a custom relationship, …).
-- The id is a STABLE identifier, independent of the display or greeting name. Every medicine, reminder series, reminder,
-- reading and appointment references it through a composite foreign key (person_id, owner_id), so a record can never be
-- attached to a person that belongs to a different account. Additive migration: nothing is dropped.

create table public.care_recipients (
  id text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  relationship text not null check (relationship in ('self','mother','father','other')),
  relationship_label text not null default '' check (char_length(relationship_label) <= 40),  -- custom relationship text, e.g. 'Dadi'
  display_name text not null default '' check (char_length(display_name) <= 80),
  greeting_name text not null default '' check (char_length(greeting_name) <= 40),            -- how Sathi addresses them. NOT an identity.
  language text not null default 'hi' check (language in ('hi','en','mr','kn')),
  time_zone text not null default 'Asia/Kolkata',
  speaking_speed text not null default 'normal' check (speaking_speed in ('normal','slower')),
  reminder_tone text not null default 'gentle' check (reminder_tone in ('gentle','standard')),
  sathi_voice text not null default 'default' check (sathi_voice in ('default','mom','dad')),
  notifications_enabled boolean not null default true,
  phone text check (phone is null or phone ~ '^\+?[0-9 ]{7,15}$'),                           -- optional; NEVER a login credential
  email text check (email is null or char_length(email) <= 254),
  active boolean not null default true,                                                        -- disabled profiles keep their history
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, owner_id),
  -- 'other' must say who it is; mother/father may not carry a custom label that makes them a different person
  constraint other_needs_label check (relationship <> 'other' or char_length(btrim(relationship_label)) > 0)
);
create unique index care_one_self on public.care_recipients (owner_id) where relationship = 'self';
-- no duplicate profiles when onboarding is resumed or submitted twice: one profile per (relationship, label) per account
create unique index care_no_dupes on public.care_recipients (owner_id, relationship, lower(btrim(relationship_label))) where relationship <> 'self';
create index on public.care_recipients (owner_id);
create trigger touch_care_recipients before update on public.care_recipients for each row execute function public.touch_updated_at();

alter table public.care_recipients enable row level security;
alter table public.care_recipients force row level security;
create policy care_select on public.care_recipients for select using (public.can_access(owner_id, 'schedule'));
create policy care_write on public.care_recipients for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

alter table public.profiles add column onboarding_mode text check (onboarding_mode in ('self','parent'));   -- what the user chose at sign-up
alter table public.profiles add column active_person_id text;

-- Backfill: every existing account gets a 'self' profile, and its records point at it.
insert into public.care_recipients (id, owner_id, relationship, display_name, greeting_name, language, time_zone, speaking_speed, reminder_tone)
select 'self_' || p.id::text, p.id, 'self', p.full_name, p.call_name, p.language, p.time_zone, p.speaking_speed, p.reminder_tone
from public.profiles p on conflict do nothing;

do $$ declare t text; begin
  foreach t in array array['medications','reminder_series','reminders','health_readings','appointments'] loop
    execute format('alter table public.%I add column person_id text', t);
    execute format('update public.%I set person_id = ''self_'' || owner_id::text where person_id is null', t);
    execute format('alter table public.%I add constraint %I foreign key (person_id, owner_id) references public.care_recipients (id, owner_id) on delete restrict', t, t || '_person_fk');
    execute format('create index on public.%I (owner_id, person_id)', t);
  end loop;
end $$;

-- Integrity trigger. Fills person_id when a writer omits it (the server-side recurrence generator does) and refuses any
-- reminder / series whose person differs from its medicine's or series' person.
create or replace function public.enforce_person() returns trigger language plpgsql as $$
declare j jsonb := to_jsonb(new); series text := j->>'series_id'; med text := j->>'medication_id'; src text; med_person text;
begin
  if series is not null then
    select person_id into src from public.reminder_series where id = series;
    if new.person_id is null then new.person_id := src;
    elsif src is not null and new.person_id <> src then raise exception 'reminder person does not match its series' using errcode = '23514'; end if;
  end if;
  if med is not null then
    select person_id into med_person from public.medications where id = med;
    if new.person_id is null then new.person_id := med_person;
    elsif med_person is not null and new.person_id <> med_person then raise exception 'reminder person does not match its medicine' using errcode = '23514'; end if;
  end if;
  if new.person_id is null then new.person_id := 'self_' || new.owner_id::text; end if;   -- legacy writers: the account's own profile
  return new;
end $$;
do $$ declare t text; begin
  foreach t in array array['medications','reminder_series','reminders','health_readings','appointments'] loop
    execute format('create trigger %I before insert or update of person_id on public.%I for each row execute function public.enforce_person()', 'enforce_person_' || t, t);
  end loop;
end $$;
-- once set, a record's person cannot be changed (no re-parenting a medicine to someone else)
create or replace function public.freeze_person() returns trigger language plpgsql as $$
begin
  if old.person_id is not null and new.person_id is distinct from old.person_id then raise exception 'person_id is immutable' using errcode = '23514'; end if;
  return new;
end $$;
do $$ declare t text; begin
  foreach t in array array['medications','reminder_series','reminders','health_readings','appointments'] loop
    execute format('create trigger %I before update on public.%I for each row execute function public.freeze_person()', 'freeze_person_' || t, t);
  end loop;
end $$;

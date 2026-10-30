-- Smaran schema. Every table has Row Level Security enabled; ids are client-generated text so the
-- offline-first app and the server share identifiers (and idempotency keys).

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '',
  call_name text not null default '',
  phone text,
  language text not null default 'hi' check (language in ('hi','en','mr','kn')),
  time_zone text not null default 'Asia/Kolkata',
  role text not null default 'self' check (role in ('self','parent')),
  text_size text not null default 'large' check (text_size in ('standard','large','extra')),
  speaking_speed text not null default 'normal' check (speaking_speed in ('normal','slower')),
  reminder_tone text not null default 'gentle' check (reminder_tone in ('gentle','standard')),
  quiet_hours jsonb not null default '{"enabled":true,"from":"22:00","to":"07:00"}',
  voice_recordings boolean not null default false,
  conversation_summaries boolean not null default true,
  voice_cloning_consent boolean not null default false,
  voice_cloning_consent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.family_memberships (
  id text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,      -- the parent whose data is shared
  member_id uuid references auth.users(id) on delete cascade,               -- null until the invite is accepted
  invite_code text unique,
  relation text not null default 'Family member',
  role text not null default 'helper' check (role in ('admin','read-only','helper')),
  status text not null default 'pending' check (status in ('pending','active','revoked')),
  perm_help_setup boolean not null default true,
  perm_view_schedule boolean not null default true,
  perm_view_readings boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.family_memberships (owner_id);
create index on public.family_memberships (member_id) where member_id is not null;

-- Access helper used by every policy: the owner, or an ACTIVE family member holding the named permission.
create or replace function public.can_access(p_owner uuid, p_perm text)
returns boolean language sql stable security definer set search_path = public as $$
  select p_owner = auth.uid() or exists (
    select 1 from public.family_memberships f
    where f.owner_id = p_owner and f.member_id = auth.uid() and f.status = 'active'
      and case p_perm
            when 'schedule' then f.perm_view_schedule
            when 'readings' then f.perm_view_readings
            when 'setup'    then f.perm_help_setup
            else false end
  )
$$;

create table public.medications (
  id text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null default '',
  strength text not null default '',
  dose text not null default '',
  frequency text not null check (frequency in ('once','twice','thrice','custom')),
  times text[] not null default '{}',                    -- 'HH:mm' wall-clock times in time_zone
  time_zone text not null,
  food text check (food in ('before','with','after','none')),
  duration text not null default 'ongoing' check (duration in ('ongoing','course')),
  course_days int check (course_days is null or course_days between 1 and 365),
  notes text not null default '',
  purpose text,
  status text not null check (status in ('draft','confirmed','active','paused','completed','removed')),
  source text not null default 'manual' check (source in ('manual','prescription','voice','family')),
  source_text text,
  flags text[] not null default '{}',
  extraction_provider text,
  extraction_batch text,
  color int,
  started_on date,
  activated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A medicine can only be active/paused after the user confirmed explicit times and food instruction.
  constraint active_needs_schedule check (status not in ('active','paused') or (cardinality(times) > 0 and food is not null))
);
create index on public.medications (owner_id, status);

create table public.reminder_series (
  id text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('medicine','custom','appointment')),
  title text not null,
  notes text,
  medication_id text references public.medications(id) on delete cascade,
  local_time text not null check (local_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  time_zone text not null,
  active boolean not null default true,
  start_at timestamptz not null,
  ends_on date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.reminders (
  id text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('medicine','custom','appointment')),
  title text not null,
  notes text,
  medication_id text references public.medications(id) on delete set null,
  appointment_id text,
  series_id text references public.reminder_series(id) on delete set null,
  scheduled_for timestamptz not null,
  original_scheduled_for timestamptz not null,
  time_zone text not null,
  recurrence jsonb,
  status text not null default 'scheduled' check (status in ('scheduled','ringing','snoozed','completed','missed','cancelled','declined')),
  snooze_history jsonb not null default '[]',
  reschedule_history jsonb not null default '[]',
  completed_at timestamptz,
  cancelled_at timestamptz,
  completion jsonb,                                           -- {via, basis:'user-reported'}: delivered != taken
  idempotency_key text not null,
  -- server dispatch bookkeeping
  dispatched_for timestamptz,                                 -- the scheduled_for value already dispatched
  dispatch_attempts int not null default 0,
  next_attempt_at timestamptz,
  last_dispatch_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, idempotency_key)                          -- duplicate prevention
);
create index reminders_due_idx on public.reminders (scheduled_for) where status in ('scheduled','snoozed');
create index on public.reminders (owner_id, scheduled_for);

create table public.delivery_attempts (
  id bigint generated always as identity primary key,
  reminder_id text not null references public.reminders(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  due_at timestamptz not null,                                -- which due time this attempt was for
  at timestamptz not null default now(),
  channel text not null check (channel in ('local','notification','incall-ui','server-push')),
  outcome text not null check (outcome in ('delivered','failed','answered','declined','expired','unsupported')),
  detail jsonb,
  unique (reminder_id, channel, due_at, outcome, at)
);
create index on public.delivery_attempts (reminder_id);

create table public.health_readings (
  id text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  type text not null check (type in ('sugar','bp')),
  at timestamptz not null,
  value numeric,
  unit text check (unit in ('mg/dL','mmol/L')),
  context text check (context in ('fasting','before_meal','after_meal','random','unspecified')),
  systolic int, diastolic int, pulse int,
  note text,
  source text not null default 'manual' check (source in ('manual','voice','sample')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sugar_has_value check (type <> 'sugar' or value is not null),
  constraint bp_has_values check (type <> 'bp' or (systolic is not null and diastolic is not null and systolic > diastolic))
);
create index on public.health_readings (owner_id, at desc);

create table public.appointments (
  id text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  doctor text,
  at timestamptz not null,
  time_zone text not null,
  notes text,
  reminder text not null default 'none' check (reminder in ('none','1h','1d','evening_before')),
  reminder_id text,
  status text not null default 'upcoming' check (status in ('upcoming','cancelled','completed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.family_proposals (
  id text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  proposed_by uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('change','new')),
  medication_id text references public.medications(id) on delete cascade,
  title text not null,
  summary text not null default '',
  patch jsonb,
  new_medicine jsonb,
  state text not null default 'draft' check (state in ('draft','awaiting','approved','declined')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.prescription_documents (
  id text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  storage_path text not null,
  file_name text not null,
  mime text not null,
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 10485760),
  extraction_provider text,
  extraction_outcome text check (extraction_outcome in ('success','partial','error')),
  extracted_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.device_tokens (
  id text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  kind text not null default 'webpush' check (kind in ('webpush')),
  endpoint text not null unique,
  subscription jsonb not null,                                -- {endpoint, keys:{p256dh, auth}}
  failures int not null default 0,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table public.audit_logs (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  actor uuid,
  action text not null,
  detail text,                                                -- never raw transcripts or health values
  at timestamptz not null default now()
);

-- updated_at maintenance
create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
do $$ declare t text; begin
  foreach t in array array['profiles','family_memberships','medications','reminder_series','reminders','health_readings','appointments','family_proposals'] loop
    execute format('create trigger touch_%1$s before update on public.%1$s for each row execute function public.touch_updated_at()', t);
  end loop;
end $$;

-- ───────── Row Level Security ─────────
do $$ declare t text; begin
  foreach t in array array['profiles','family_memberships','medications','reminder_series','reminders','delivery_attempts','health_readings','appointments','family_proposals','prescription_documents','device_tokens','audit_logs'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
  end loop;
end $$;

create policy profiles_select on public.profiles for select using (id = auth.uid());
create policy profiles_insert on public.profiles for insert with check (id = auth.uid());
create policy profiles_update on public.profiles for update using (id = auth.uid()) with check (id = auth.uid());

create policy fam_owner_all on public.family_memberships for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy fam_member_select on public.family_memberships for select using (member_id = auth.uid());

-- Owner writes; owner + permitted active family read.
create policy med_select on public.medications for select using (public.can_access(owner_id, 'schedule'));
create policy med_write on public.medications for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy series_select on public.reminder_series for select using (public.can_access(owner_id, 'schedule'));
create policy series_write on public.reminder_series for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy rem_select on public.reminders for select using (public.can_access(owner_id, 'schedule'));
create policy rem_write on public.reminders for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy appt_select on public.appointments for select using (public.can_access(owner_id, 'schedule'));
create policy appt_write on public.appointments for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy read_select on public.health_readings for select using (public.can_access(owner_id, 'readings'));
create policy read_write on public.health_readings for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy da_select on public.delivery_attempts for select using (public.can_access(owner_id, 'schedule'));
create policy da_insert on public.delivery_attempts for insert with check (owner_id = auth.uid());

-- Family helpers may only SUGGEST changes (never edit medicines directly); the owner decides.
create policy prop_select on public.family_proposals for select using (owner_id = auth.uid() or proposed_by = auth.uid());
create policy prop_insert on public.family_proposals for insert with check (
  proposed_by = auth.uid() and state in ('draft','awaiting') and public.can_access(owner_id, 'setup'));
create policy prop_helper_update on public.family_proposals for update using (proposed_by = auth.uid() and state in ('draft','awaiting'))
  with check (proposed_by = auth.uid() and state in ('draft','awaiting'));
create policy prop_owner_decide on public.family_proposals for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy prop_helper_delete on public.family_proposals for delete using (proposed_by = auth.uid() and state = 'draft');

create policy rx_owner on public.prescription_documents for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy dt_owner on public.device_tokens for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy audit_select on public.audit_logs for select using (owner_id = auth.uid());
-- audit rows are written only by SECURITY DEFINER functions / the service role.

-- Joining a family: the invited person calls this with the code; nothing else can set member_id.
create or replace function public.accept_invite(p_code text) returns public.family_memberships
language plpgsql security definer set search_path = public as $$
declare m public.family_memberships;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  update public.family_memberships
     set member_id = auth.uid(), status = 'active', updated_at = now()
   where invite_code = p_code and status = 'pending' and member_id is null and owner_id <> auth.uid()
   returning * into m;
  if m.id is null then raise exception 'invitation is invalid or already used'; end if;
  insert into public.audit_logs(owner_id, actor, action, detail) values (m.owner_id, auth.uid(), 'invite_accepted', m.relation);
  return m;
end $$;

-- Parent approves/declines suggested changes; approved ones are applied atomically.
create or replace function public.decide_proposals(p_approve boolean) returns int
language plpgsql security definer set search_path = public as $$
declare r public.family_proposals; n int := 0;
begin
  for r in select * from public.family_proposals where owner_id = auth.uid() and state = 'awaiting' for update loop
    if p_approve then
      if r.kind = 'change' and r.medication_id is not null and r.patch is not null then
        update public.medications set
          strength = coalesce(r.patch->>'strength', strength),
          dose = coalesce(r.patch->>'dose', dose),
          frequency = coalesce(r.patch->>'frequency', frequency),
          times = coalesce((select array_agg(x) from jsonb_array_elements_text(r.patch->'times') x), times),
          food = coalesce(r.patch->>'food', food)
        where id = r.medication_id and owner_id = auth.uid();
      end if;
    end if;
    update public.family_proposals set state = case when p_approve then 'approved' else 'declined' end where id = r.id;
    insert into public.audit_logs(owner_id, actor, action, detail) values (auth.uid(), auth.uid(), case when p_approve then 'proposal_approved' else 'proposal_declined' end, r.title);
    n := n + 1;
  end loop;
  return n;
end $$;

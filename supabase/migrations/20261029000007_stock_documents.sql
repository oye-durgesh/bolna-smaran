-- Medicine stock ledger and per-person documents. Additive.
-- The ledger is append-style: an opening count, refills (with date and source) and manual adjustments. Doses the person CONFIRMED are
-- not copied here; the estimate derives them from reminders whose completion is 'user-reported' (a notification being sent never counts).

alter table public.medications add column stock_settings jsonb;   -- {unit, perDose, dosesPerDay, lowDays, lowPct, leadDays}; perDose is user-confirmed, never inferred

create table public.stock_ledger (
  id text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  person_id text not null,
  medication_id text not null references public.medications(id) on delete cascade,
  type text not null check (type in ('opening','refill','adjustment','consumed')),
  qty numeric not null check (qty >= 0 and qty <= 10000),
  source text not null default 'user' check (source in ('user','count','prescription')),
  note text check (note is null or char_length(note) <= 300),
  at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  foreign key (person_id, owner_id) references public.care_recipients (id, owner_id) on delete restrict
);
create index on public.stock_ledger (medication_id, at);
create index on public.stock_ledger (owner_id, person_id);
alter table public.stock_ledger enable row level security;
alter table public.stock_ledger force row level security;
create policy stock_select on public.stock_ledger for select using (public.can_access(owner_id, 'schedule'));
create policy stock_write on public.stock_ledger for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
-- the entry must belong to the same person as its medicine
create or replace function public.stock_person_check() returns trigger language plpgsql as $$
declare mp text;
begin
  select person_id into mp from public.medications where id = new.medication_id;
  if new.person_id is null then new.person_id := mp; end if;
  if mp is not null and new.person_id <> mp then raise exception 'stock entry person does not match its medicine' using errcode = '23514'; end if;
  return new;
end $$;
create trigger stock_person_check before insert or update on public.stock_ledger for each row execute function public.stock_person_check();

-- Documents belong to a person and have a type and processing status. Owner-only access (policy rx_owner from migration 1): family helpers
-- do NOT see medical documents by default.
alter table public.prescription_documents add column person_id text;
alter table public.prescription_documents add column document_type text not null default 'prescription'
  check (document_type in ('prescription','lab_report','blood_sugar_report','bp_log','discharge_summary','appointment_note','other'));
alter table public.prescription_documents add column content_hash text;       -- duplicate-upload detection (sha-256 of the file)
update public.prescription_documents set person_id = 'self_' || owner_id::text where person_id is null;
alter table public.prescription_documents add constraint prescription_documents_person_fk foreign key (person_id, owner_id) references public.care_recipients (id, owner_id) on delete restrict;
create unique index prescription_documents_dedupe on public.prescription_documents (owner_id, person_id, content_hash) where content_hash is not null;
create trigger enforce_person_prescription_documents before insert or update of person_id on public.prescription_documents for each row execute function public.enforce_person();
create trigger freeze_person_prescription_documents before update on public.prescription_documents for each row execute function public.freeze_person();

-- Prescription reading jobs (Sarvam Document AI). One row per upload attempt; the browser polls it through an Edge Function.
create table public.extraction_jobs (
  id text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  document_id text references public.prescription_documents(id) on delete set null,
  provider text not null default 'sarvam' check (provider = 'sarvam'),
  sarvam_job_id text,
  file_name text not null,
  mime text not null,
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 10485760),
  language text not null,
  output_format text not null default 'md' check (output_format in ('md','html','json')),
  status text not null default 'submitted'
    check (status in ('submitted','running','completed','partially_completed','failed','rejected','cancelled','timed_out')),
  pages jsonb,
  error_code text,
  error_message text,
  retry_after_sec int,
  result jsonb,                      -- extracted text + medicine DRAFT; never an active schedule
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.extraction_jobs (owner_id, created_at desc);
create trigger touch_extraction_jobs before update on public.extraction_jobs for each row execute function public.touch_updated_at();

alter table public.extraction_jobs enable row level security;
alter table public.extraction_jobs force row level security;
create policy xj_owner on public.extraction_jobs for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- Reviewed medicines remember where they came from (so the original text stays comparable).
alter table public.medications add column if not exists extraction_job_id text references public.extraction_jobs(id) on delete set null;
alter table public.prescription_documents add column if not exists extraction_job_id text;

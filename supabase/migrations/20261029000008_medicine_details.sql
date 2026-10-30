-- Structured medicine instruction fields (all optional, all copied from the prescription by a person; nothing is inferred).
alter table public.medications add column start_date date;
alter table public.medications add column end_date date;
alter table public.medications add column prescriber text check (prescriber is null or char_length(prescriber) <= 120);
alter table public.medications add column prescription_ref text check (prescription_ref is null or char_length(prescription_ref) <= 120);
alter table public.medications add column follow_up_date date;
alter table public.medications add constraint medication_dates_ordered check (start_date is null or end_date is null or end_date >= start_date);

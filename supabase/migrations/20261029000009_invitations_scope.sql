-- Family access: email-bound invitations with expiry, per-profile scope, and server-side revocation. Additive; replaces some policies/functions.
--  * Owner (workspace administrator) = family_memberships.owner_id. Roles: admin (caregiver with setup help), helper (suggests changes), read-only (family member view).
--  * A member can never change their own row (no update policy), so nobody can promote themselves.
--  * Access to a person's records = owner, OR an ACTIVE member whose permission covers it AND whose person scope includes that person.
alter table public.family_memberships add column invited_email text check (invited_email is null or char_length(invited_email) <= 254);
alter table public.family_memberships add column expires_at timestamptz not null default (now() + interval '7 days');
alter table public.family_memberships add column person_scope text[];          -- null = every profile in the workspace; otherwise only these care_recipients ids
alter table public.family_memberships add column revoked_at timestamptz;

create or replace function public.can_access_person(p_owner uuid, p_person text, p_perm text)
returns boolean language sql stable security definer set search_path = public as $$
  select p_owner = auth.uid() or exists (
    select 1 from public.family_memberships f
    where f.owner_id = p_owner and f.member_id = auth.uid() and f.status = 'active'
      and (f.person_scope is null or p_person = any (f.person_scope))
      and case p_perm when 'schedule' then f.perm_view_schedule when 'readings' then f.perm_view_readings when 'setup' then f.perm_help_setup else false end
  )
$$;

drop policy care_select on public.care_recipients;
create policy care_select on public.care_recipients for select using (public.can_access_person(owner_id, id, 'schedule'));
drop policy med_select on public.medications;
create policy med_select on public.medications for select using (public.can_access_person(owner_id, person_id, 'schedule'));
drop policy series_select on public.reminder_series;
create policy series_select on public.reminder_series for select using (public.can_access_person(owner_id, person_id, 'schedule'));
drop policy rem_select on public.reminders;
create policy rem_select on public.reminders for select using (public.can_access_person(owner_id, person_id, 'schedule'));
drop policy appt_select on public.appointments;
create policy appt_select on public.appointments for select using (public.can_access_person(owner_id, person_id, 'schedule'));
drop policy read_select on public.health_readings;
create policy read_select on public.health_readings for select using (public.can_access_person(owner_id, person_id, 'readings'));
drop policy stock_select on public.stock_ledger;
create policy stock_select on public.stock_ledger for select using (public.can_access_person(owner_id, person_id, 'schedule'));
drop policy da_select on public.delivery_attempts;
create policy da_select on public.delivery_attempts for select using (
  owner_id = auth.uid() or exists (select 1 from public.reminders r where r.id = reminder_id and public.can_access_person(r.owner_id, r.person_id, 'schedule')));

-- Accepting: only a signed-in user, only before expiry, never your own invitation, and when the invitation names an email address
-- it must be the VERIFIED email of the accepting account. Typing someone's phone number or email grants nothing by itself.
create or replace function public.accept_invite(p_code text) returns public.family_memberships
language plpgsql security definer set search_path = public as $$
declare m public.family_memberships; who text := lower(coalesce(auth.jwt() ->> 'email', ''));
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  select * into m from public.family_memberships where invite_code = p_code for update;
  if not found or m.status <> 'pending' or m.member_id is not null or m.owner_id = auth.uid() then raise exception 'invitation is invalid or already used'; end if;
  if m.expires_at < now() then raise exception 'invitation has expired'; end if;
  if m.invited_email is not null and lower(m.invited_email) <> who then raise exception 'this invitation was sent to a different email address'; end if;
  update public.family_memberships set member_id = auth.uid(), status = 'active', updated_at = now() where id = m.id returning * into m;
  insert into public.audit_logs(owner_id, actor, action, detail) values (m.owner_id, auth.uid(), 'invite_accepted', m.role);
  return m;
end $$;

-- Revoking: owner only. Access disappears immediately because every policy checks status = 'active'.
create or replace function public.revoke_membership(p_id text) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.family_memberships set status = 'revoked', revoked_at = now(), updated_at = now() where id = p_id and owner_id = auth.uid();
  if not found then raise exception 'not allowed'; end if;
  insert into public.audit_logs(owner_id, actor, action, detail) values (auth.uid(), auth.uid(), 'access_revoked', p_id);
end $$;
revoke all on function public.revoke_membership(text) from public;
grant execute on function public.revoke_membership(text) to authenticated;

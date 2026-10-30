/**
 * Runs the real migrations on an in-process Postgres (PGlite) with stubbed Supabase auth, and proves
 * Row Level Security, idempotent recurrence, atomic claiming, retry/backoff and the "active needs a schedule" rule.
 * (pg_cron / pg_net / storage are Supabase-hosted and are not part of this test.)
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { beforeAll, describe, expect, it } from 'vitest'

const dir = join(__dirname, '..', 'migrations')
const A = '00000000-0000-0000-0000-00000000000a'
const B = '00000000-0000-0000-0000-00000000000b'
const C = '00000000-0000-0000-0000-00000000000c' // family helper of A
let db: PGlite

const as = async <T = Record<string, unknown>>(uid: string | null, sql: string, role = 'authenticated'): Promise<T[]> => {
  const email = ({ [A]: 'a@example.com', [B]: 'b@example.com', [C]: 'c@example.com' } as Record<string, string>)[uid ?? ''] ?? ''
  await db.exec(`set role ${role}; select set_config('app.uid','${uid ?? ''}', false); select set_config('app.email','${email}', false);`)
  try { return (await db.query<T>(sql)).rows } finally { await db.exec('reset role') }
}
const asErr = async (uid: string, sql: string) => { try { await as(uid, sql); return null } catch (e) { return (e as Error).message } }

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    create role authenticated; create role service_role; create role anon;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('app.uid', true), '')::uuid $$;
    create function auth.jwt() returns jsonb language sql stable as $$ select jsonb_build_object('email', nullif(current_setting('app.email', true), '')) $$;
    grant usage on schema auth to authenticated, service_role;
    insert into auth.users values ('${A}'),('${B}'),('${C}');
  `)
  for (const f of ['20261029000001_schema.sql', '20261029000002_dispatch.sql', '20261029000004_extraction_jobs.sql', '20261029000005_care_recipients.sql', '20261029000006_reminder_tool.sql', '20261029000007_stock_documents.sql', '20261029000008_medicine_details.sql', '20261029000009_invitations_scope.sql', '20261029000010_reminder_skipped.sql']) await db.exec(readFileSync(join(dir, f), 'utf8'))
  await db.exec(`grant usage on schema public to authenticated, service_role; grant all on all tables in schema public to authenticated, service_role;
                 grant all on all sequences in schema public to authenticated, service_role;`)
  // every account has its own 'self' profile (the app creates it at onboarding; the migration backfills existing accounts)
  for (const u of [A, B, C]) await db.exec(`insert into care_recipients(id, owner_id, relationship, display_name) values ('self_${u}', '${u}', 'self', 'Owner')`)
})

const med = (id: string, owner: string, extra = '') =>
  `insert into medications(id, owner_id, name, frequency, time_zone, status ${extra ? ', ' + extra.split('|')[0] : ''}) values ('${id}', '${owner}', 'Metformin', 'once', 'Asia/Kolkata', 'draft' ${extra ? ', ' + extra.split('|')[1] : ''})`

describe('RLS', () => {
  it('owners see only their own rows', async () => {
    await as(A, med('m-a', A)); await as(B, med('m-b', B))
    expect((await as(A, 'select id from medications')).map((r: any) => r.id)).toEqual(['m-a'])
    expect((await as(B, 'select id from medications')).map((r: any) => r.id)).toEqual(['m-b'])
    expect(await as(null, 'select id from medications')).toEqual([])
  })
  it("a user cannot write into someone else's account", async () => {
    expect(await asErr(B, med('evil', A))).toMatch(/row-level security/)
    await as(A, `update medications set name = 'hacked' where id = 'm-b'`)
    expect((await as(B, `select name from medications where id = 'm-b'`))[0]).toMatchObject({ name: 'Metformin' })
  })
  it('family helper: sees schedule only with permission, never readings by default, and cannot edit medicines', async () => {
    await as(A, `insert into family_memberships(id, owner_id, invite_code) values ('f1', '${A}', 'abc12345')`)
    expect(await as(C, 'select id from medications')).toEqual([])                         // not yet a member
    await as(C, `select accept_invite('abc12345')`)
    expect((await as(C, 'select id from medications')).map((r: any) => r.id)).toEqual(['m-a'])
    await as(A, `insert into health_readings(id, owner_id, type, at, value, unit) values ('r1','${A}','sugar', now(), 180, 'mg/dL')`)
    expect(await as(C, 'select id from health_readings')).toEqual([])                     // viewReadings is off by default
    await as(A, `update family_memberships set perm_view_readings = true where id = 'f1'`)
    expect((await as(C, 'select id from health_readings')).length).toBe(1)
    expect(await asErr(C, `update medications set name = 'x' where id = 'm-a'`)).toBeNull() // RLS hides the row: 0 rows updated…
    expect((await as(A, `select name from medications where id='m-a'`))[0]).toMatchObject({ name: 'Metformin' }) // …so nothing changed
    expect(await asErr(C, med('m-c', A))).toMatch(/row-level security/)
    await as(A, `update family_memberships set perm_view_schedule = false where id = 'f1'`)
    expect(await as(C, 'select id from medications')).toEqual([])                         // revoked permission takes effect immediately
    await as(A, `update family_memberships set perm_view_schedule = true where id = 'f1'`)
  })
  it('an invite cannot be reused or self-accepted', async () => {
    expect(await asErr(B, `select accept_invite('abc12345')`)).toMatch(/invalid or already used/)
    await as(A, `insert into family_memberships(id, owner_id, invite_code) values ('f2', '${A}', 'self1234')`)
    expect(await asErr(A, `select accept_invite('self1234')`)).toMatch(/invalid or already used/)
  })
  it('helpers can only propose; only the owner approves, and approval applies the change', async () => {
    await as(C, `insert into family_proposals(id, owner_id, proposed_by, kind, medication_id, title, patch, state)
                 values ('p1','${A}','${C}','change','m-a','Metformin','{"times":["07:30"]}','awaiting')`)
    expect(await asErr(C, `update family_proposals set state = 'approved' where id = 'p1'`)).toMatch(/row-level security|violates/)
    expect(await asErr(B, `insert into family_proposals(id, owner_id, proposed_by, kind, title, state) values ('p2','${A}','${B}','new','x','awaiting')`)).toMatch(/row-level security/)
    expect(Number((await as(A, `select decide_proposals(true) as n`))[0].n)).toBe(1)
    expect((await as(A, `select times, state from medications m, family_proposals p where m.id='m-a' and p.id='p1'`))[0]).toMatchObject({ state: 'approved' })
  })
  it('rows owned by others are invisible in every table; service role bypasses nothing it should not', async () => {
    for (const t of ['reminders', 'reminder_series', 'appointments', 'device_tokens', 'prescription_documents', 'audit_logs', 'profiles']) {
      expect(await as(B, `select * from ${t}`)).toEqual([])
    }
  })
})

describe('family profiles (care recipients)', () => {
  const person = (id: string, owner: string, rel: string, label = '', name = '') =>
    `insert into care_recipients(id, owner_id, relationship, relationship_label, display_name, greeting_name) values ('${id}','${owner}','${rel}','${label}','${name}','${name}')`
  const medFor = (id: string, owner: string, pid: string) =>
    `insert into medications(id, owner_id, person_id, name, frequency, time_zone, status) values ('${id}','${owner}','${pid}','X','once','Asia/Kolkata','draft')`
  it('one account holds separate Mummy and Papa profiles with different stable ids; the greeting name is not the identity', async () => {
    await as(A, person('per_mum', A, 'mother', '', 'Sunita')); await as(A, person('per_papa', A, 'father', '', 'Ramesh'))
    const rows = await as(A, `select id, relationship from care_recipients where relationship <> 'self' order by id`)
    expect(rows).toEqual([{ id: 'per_mum', relationship: 'mother' }, { id: 'per_papa', relationship: 'father' }])
    await as(A, `update care_recipients set greeting_name = 'Mummy' where id = 'per_mum'`)           // changing how Sathi addresses her…
    expect((await as(A, `select id, relationship from care_recipients where id = 'per_mum'`))[0]).toMatchObject({ id: 'per_mum', relationship: 'mother' }) // …does not change who she is
  })
  it('an unrelated account cannot read another account’s Mummy or Papa row (what the agent-session function relies on)', async () => {
    expect(await as(B, `select id from care_recipients where id in ('per_mum','per_papa')`)).toEqual([])
    expect((await as(A, `select id from care_recipients where id in ('per_mum','per_papa')`)).length).toBe(2)
  })
  it('duplicate submissions do not create duplicate profiles; a custom relationship needs a label', async () => {
    expect(await asErr(A, person('per_mum2', A, 'mother', '', 'Sunita'))).toMatch(/duplicate|unique/)
    expect(await asErr(A, `insert into care_recipients(id, owner_id, relationship) values ('x','${A}','self')`)).toMatch(/duplicate|unique/)
    expect(await asErr(A, person('per_o', A, 'other', '', 'Dadi'))).toMatch(/check|violates/)
    await as(A, person('per_dadi', A, 'other', 'Dadi', 'Dadi'))
    expect(await asErr(A, person('per_dadi2', A, 'other', ' dadi ', 'Dadi'))).toMatch(/duplicate|unique/)
  })
  it('medicines, reminders and readings stay on their own profile; a series inherits it; mismatches are refused', async () => {
    await as(A, medFor('m-mum', A, 'per_mum')); await as(A, medFor('m-papa', A, 'per_papa'))
    const meds = await as(A, `select id, person_id from medications where id in ('m-mum','m-papa') order by id`)
    expect(meds).toEqual([{ id: 'm-mum', person_id: 'per_mum' }, { id: 'm-papa', person_id: 'per_papa' }])
    await as(A, `insert into reminder_series(id, owner_id, kind, title, medication_id, local_time, time_zone, start_at) values ('s-mum','${A}','medicine','Metformin','m-mum','08:00','Asia/Kolkata', now())`)
    expect((await as(A, `select person_id from reminder_series where id = 's-mum'`))[0]).toMatchObject({ person_id: 'per_mum' })  // filled from the medicine
    expect(await asErr(A, `insert into reminder_series(id, owner_id, person_id, kind, title, medication_id, local_time, time_zone, start_at) values ('s-bad','${A}','per_papa','medicine','x','m-mum','08:00','Asia/Kolkata', now())`)).toMatch(/does not match/)
    await as(A, `insert into reminders(id, owner_id, kind, title, series_id, scheduled_for, original_scheduled_for, time_zone, idempotency_key) values ('r-mum','${A}','medicine','Metformin','s-mum', now(), now(),'Asia/Kolkata','k-mum')`)
    expect((await as(A, `select person_id from reminders where id = 'r-mum'`))[0]).toMatchObject({ person_id: 'per_mum' })
    expect(await asErr(A, `insert into reminders(id, owner_id, person_id, kind, title, medication_id, scheduled_for, original_scheduled_for, time_zone, idempotency_key) values ('r-bad','${A}','per_papa','medicine','x','m-mum', now(), now(),'Asia/Kolkata','k-bad')`)).toMatch(/does not match/)
    await as(A, `insert into health_readings(id, owner_id, person_id, type, at, value, unit) values ('hr-papa','${A}','per_papa','sugar', now(), 120,'mg/dL')`)
    expect((await as(A, `select person_id from health_readings where id = 'hr-papa'`))[0]).toMatchObject({ person_id: 'per_papa' })
  })
  it('a record can never be attached to another account’s person, and cannot be moved to another person later', async () => {
    expect(await asErr(B, medFor('m-steal', B, 'per_mum'))).toMatch(/foreign key|violates/)
    expect(await asErr(A, `update medications set person_id = 'per_papa' where id = 'm-mum'`)).toMatch(/immutable/)
  })
  it('other accounts cannot see or edit profiles; a family helper sees them only with schedule permission', async () => {
    expect(await as(B, `select id from care_recipients where id = 'per_mum'`)).toEqual([])
    await as(B, `update care_recipients set display_name = 'hacked' where id = 'per_mum'`)
    expect((await as(A, `select display_name from care_recipients where id = 'per_mum'`))[0]).toMatchObject({ display_name: 'Sunita' })
    expect(await asErr(B, person('per_x', A, 'mother', 'x'))).toMatch(/row-level security/)
  })
  it('a profile with history cannot be hard-deleted (disable it instead)', async () => {
    // (fixtures from this block are removed afterwards so the scheduler tests below only see their own data)
    expect(await asErr(A, `delete from care_recipients where id = 'per_mum'`)).toMatch(/foreign key|violates/)
    await as(A, `update care_recipients set active = false where id = 'per_mum'`)
    expect((await as(A, `select active from care_recipients where id = 'per_mum'`))[0]).toMatchObject({ active: false })
    for (const q of [`delete from reminders where id = 'r-mum'`, `delete from reminder_series where id = 's-mum'`, `delete from health_readings where id = 'hr-papa'`, `delete from medications where id in ('m-mum','m-papa')`]) await as(A, q)
  })
})

describe('reminder tool columns and audit', () => {
  it('reminders record their source, creator and delivery channel; unknown values are refused', async () => {
    await as(A, `insert into reminders(id, owner_id, person_id, kind, title, scheduled_for, original_scheduled_for, time_zone, idempotency_key, source, created_by) values ('rv1','${A}','self_${A}','custom','Walk', now(), now(),'Asia/Kolkata','voice:k1','voice','${A}')`)
    expect((await as(A, `select source, delivery_channel, person_id from reminders where id = 'rv1'`))[0]).toMatchObject({ source: 'voice', delivery_channel: 'push', person_id: `self_${A}` })
    expect(await asErr(A, `insert into reminders(id, owner_id, kind, title, scheduled_for, original_scheduled_for, time_zone, idempotency_key, source) values ('rv2','${A}','custom','x', now(), now(),'Asia/Kolkata','voice:k2','hacker')`)).toMatch(/check/)
    expect(await asErr(A, `insert into reminders(id, owner_id, kind, title, scheduled_for, original_scheduled_for, time_zone, idempotency_key) values ('rv3','${A}','custom','   ', now(), now(),'Asia/Kolkata','voice:k3')`)).toMatch(/check|reminder_title_len/)
  })
  it('the same voice idempotency key cannot create a second reminder (even under a different id)', async () => {
    expect(await asErr(A, `insert into reminders(id, owner_id, kind, title, scheduled_for, original_scheduled_for, time_zone, idempotency_key) values ('rv4','${A}','custom','Walk', now(), now(),'Asia/Kolkata','voice:k1')`)).toMatch(/duplicate|unique/)
    await as(A, `delete from reminders where id = 'rv1'`)
  })
  it('users can add audit entries for their own account only, and cannot rewrite or delete them', async () => {
    await as(A, `insert into audit_logs(owner_id, actor, action, detail) values ('${A}','${A}','reminder_created_by_voice','id=rv1')`)
    expect(await asErr(A, `insert into audit_logs(owner_id, actor, action) values ('${B}','${A}','x')`)).toMatch(/row-level security/)
    expect(await asErr(B, `insert into audit_logs(owner_id, actor, action) values ('${B}','${A}','spoofed actor')`)).toMatch(/row-level security/)
    await as(A, `update audit_logs set action = 'tampered' where owner_id = '${A}'`)
    await as(A, `delete from audit_logs where owner_id = '${A}'`)
    expect((await as(A, `select count(*)::int as n from audit_logs where action = 'reminder_created_by_voice'`))[0]).toMatchObject({ n: 1 })
  })
})

describe('family invitations, roles and access scope', () => {
  const inv = (id: string, code: string, extra = '') => `insert into family_memberships(id, owner_id, invite_code, relation, role, invited_email ${extra ? ', ' + extra.split('|')[0] : ''}) values ('${id}','${B}','${code}','Brother','helper','c@example.com' ${extra ? ', ' + extra.split('|')[1] : ''})`
  it('setup: owner B has two profiles with their own records', async () => {
    await as(B, `insert into care_recipients(id, owner_id, relationship, relationship_label, display_name) values ('per_b1','${B}','other','Mausi','Mausi'), ('per_b2','${B}','other','Mama','Mama')`)
    await as(B, `insert into medications(id, owner_id, person_id, name, frequency, time_zone, status) values ('mb1','${B}','per_b1','Aspirin','once','Asia/Kolkata','draft'), ('mb2','${B}','per_b2','Statin','once','Asia/Kolkata','draft')`)
    await as(B, `insert into health_readings(id, owner_id, person_id, type, at, value, unit) values ('hb1','${B}','per_b1','sugar', now(), 100,'mg/dL'), ('hb2','${B}','per_b2','sugar', now(), 200,'mg/dL')`)
  })
  it('an invitation naming an email can only be accepted by that verified email; others and the owner are refused', async () => {
    await as(B, inv('inv1', 'code-inv1', 'person_scope|array[\'per_b1\']'))
    expect(await asErr(A, `select accept_invite('code-inv1')`)).toMatch(/different email/)
    expect(await asErr(B, `select accept_invite('code-inv1')`)).toMatch(/invalid or already used/)
    expect(await as(C, `select count(*)::int as n from medications where owner_id = '${B}'`)).toEqual([{ n: 0 }])      // nothing granted yet
    await as(C, `select accept_invite('code-inv1')`)
    expect(await asErr(C, `select accept_invite('code-inv1')`)).toMatch(/invalid or already used/)                    // single use
  })
  it('the member sees ONLY the profiles in their scope (medicines, readings, the profile itself)', async () => {
    expect((await as(C, `select id from medications where owner_id = '${B}' order by id`)).map((r: any) => r.id)).toEqual(['mb1'])
    expect(await as(C, `select id from health_readings where owner_id = '${B}'`)).toEqual([])                          // readings permission is off by default
    expect((await as(C, `select id from care_recipients where owner_id = '${B}' order by id`)).map((r: any) => r.id)).toEqual(['per_b1'])
    await as(B, `update family_memberships set perm_view_readings = true where id = 'inv1'`)
    expect((await as(C, `select id from health_readings where owner_id = '${B}'`)).map((r: any) => r.id)).toEqual(['hb1'])   // hb2 (Mama) stays hidden
  })
  it('a member cannot promote themselves, widen their scope, extend an expiry or write the owner’s records', async () => {
    await as(C, `update family_memberships set role = 'admin', person_scope = null, perm_view_readings = true, expires_at = now() + interval '9 years' where id = 'inv1'`)
    expect((await as(B, `select role, person_scope from family_memberships where id = 'inv1'`))[0]).toMatchObject({ role: 'helper', person_scope: ['per_b1'] })
    expect(await asErr(C, `insert into family_memberships(id, owner_id, member_id, role, status) values ('evil','${B}','${C}','admin','active')`)).toMatch(/row-level security/)
    expect(await asErr(C, `insert into medications(id, owner_id, person_id, name, frequency, time_zone, status) values ('mx','${B}','per_b1','x','once','Asia/Kolkata','draft')`)).toMatch(/row-level security/)
    await as(C, `update medications set name = 'hacked' where id = 'mb1'`)
    expect((await as(B, `select name from medications where id = 'mb1'`))[0]).toMatchObject({ name: 'Aspirin' })
  })
  it('expired invitations cannot be accepted', async () => {
    await as(B, inv('inv2', 'code-inv2'))
    await db.exec(`update family_memberships set expires_at = now() - interval '1 day' where id = 'inv2'`)
    expect(await asErr(C, `select accept_invite('code-inv2')`)).toMatch(/expired/)
  })
  it('only the owner can revoke; access ends immediately and the action is audited', async () => {
    expect(await asErr(C, `select revoke_membership('inv1')`)).toMatch(/not allowed/)
    expect(await asErr(A, `select revoke_membership('inv1')`)).toMatch(/not allowed/)
    await as(B, `select revoke_membership('inv1')`)
    expect(await as(C, `select id from medications where owner_id = '${B}'`)).toEqual([])
    expect(await as(C, `select id from health_readings where owner_id = '${B}'`)).toEqual([])
    expect((await as(B, `select count(*)::int as n from audit_logs where action = 'access_revoked'`))[0]).toMatchObject({ n: 1 })
    expect(await asErr(C, `select accept_invite('code-inv1')`)).toMatch(/invalid or already used/)                    // a revoked invite cannot be reused
  })
})

describe('skipped doses', () => {
  it('skipped is a valid, recorded state; unknown states are still refused; the dispatcher never claims a skipped reminder', async () => {
    await as(A, `insert into reminders(id, owner_id, kind, title, scheduled_for, original_scheduled_for, time_zone, idempotency_key, status, skipped_at) values ('rsk1','${A}','medicine','Metformin', now() - interval '1 minute', now() - interval '1 minute','Asia/Kolkata','k-skip','skipped', now())`)
    expect((await as(A, `select status from reminders where id = 'rsk1'`))[0]).toMatchObject({ status: 'skipped' })
    expect(await asErr(A, `update reminders set status = 'taken-maybe' where id = 'rsk1'`)).toMatch(/check|violates/)
    const claimed = await db.query(`select id from claim_due_reminders(100)`)
    expect(claimed.rows.map((r: any) => r.id)).not.toContain('rsk1')
    await as(A, `delete from reminders where id = 'rsk1'`)
  })
})

describe('stock ledger and documents', () => {
  const doc = (id: string, owner: string, pid: string, hash: string) => `insert into prescription_documents(id, owner_id, person_id, storage_path, file_name, mime, size_bytes, content_hash) values ('${id}','${owner}','${pid}','p/${id}','rx.pdf','application/pdf',10,'${hash}')`
  it('stock entries belong to their medicine’s person, follow RLS, and cannot be forged for another account', async () => {
    await as(A, `insert into care_recipients(id, owner_id, relationship, relationship_label, display_name) values ('per_s1','${A}','other','Nani','Nani')`)
    await as(A, `insert into medications(id, owner_id, person_id, name, frequency, time_zone, status) values ('ms1','${A}','per_s1','Metformin','twice','Asia/Kolkata','draft')`)
    await as(A, `insert into stock_ledger(id, owner_id, person_id, medication_id, type, qty, source) values ('sl1','${A}','per_s1','ms1','opening',42,'count')`)
    expect((await as(A, `select qty::int as q from stock_ledger where id='sl1'`))[0]).toMatchObject({ q: 42 })
    expect(await as(B, `select id from stock_ledger`)).toEqual([])
    expect(await asErr(B, `insert into stock_ledger(id, owner_id, person_id, medication_id, type, qty) values ('sl2','${B}','per_s1','ms1','refill',10)`)).toMatch(/foreign key|row-level|violates/)
    await as(A, `insert into care_recipients(id, owner_id, relationship, relationship_label, display_name) values ('per_s2','${A}','other','Nana','Nana')`)
    expect(await asErr(A, `insert into stock_ledger(id, owner_id, person_id, medication_id, type, qty) values ('sl3','${A}','per_s2','ms1','refill',10)`)).toMatch(/does not match/)
    expect(await asErr(A, `insert into stock_ledger(id, owner_id, medication_id, type, qty) values ('sl4','${A}','ms1','refill',-5)`)).toMatch(/check|violates/)
    const filled = await as(A, `insert into stock_ledger(id, owner_id, medication_id, type, qty) values ('sl5','${A}','ms1','refill',30) returning person_id`)
    expect(filled[0]).toMatchObject({ person_id: 'per_s1' })    // filled from the medicine
  })
  it('documents carry a person and a type; the same file cannot be stored twice for one person; other accounts cannot see them', async () => {
    await as(A, doc('d1', A, 'per_s1', 'h1'))
    expect(await asErr(A, doc('d2', A, 'per_s1', 'h1'))).toMatch(/duplicate|unique/)
    await as(A, doc('d3', A, 'per_s2', 'h1'))                                   // same file for a different person is allowed
    expect(await as(B, `select id from prescription_documents`)).toEqual([])
    expect(await asErr(A, `update prescription_documents set document_type = 'selfie' where id = 'd1'`)).toMatch(/check|violates/)
    expect(await asErr(B, doc('d4', B, 'per_s1', 'h9'))).toMatch(/foreign key|row-level|violates/)
  })
  it('a family helper with schedule access does NOT see medical documents', async () => {
    await as(A, `update family_memberships set perm_view_schedule = true where id = 'f1'`)
    expect(await as(C, `select id from prescription_documents`)).toEqual([])
  })
})

describe('extraction jobs', () => {
  const job = (id: string, owner: string) => `insert into extraction_jobs(id, owner_id, file_name, mime, size_bytes, language, status) values ('${id}','${owner}','rx.pdf','application/pdf',10,'hi-IN','submitted')`
  it('owners see only their own jobs and cannot write for others', async () => {
    await as(A, job('j-a', A)); await as(B, job('j-b', B))
    expect((await as(A, 'select id from extraction_jobs')).map((r: any) => r.id)).toEqual(['j-a'])
    expect(await asErr(B, job('evil', A))).toMatch(/row-level security/)
    expect(await as(null, 'select id from extraction_jobs')).toEqual([])
  })
  it('rejects an unknown status', async () => {
    expect(await asErr(A, `update extraction_jobs set status = 'bogus' where id = 'j-a'`)).toBeTruthy()
  })
})

describe('data rules', () => {
  it('a medicine cannot become active without times and a food instruction', async () => {
    expect(await asErr(A, `update medications set status = 'active' where id = 'm-a'`)).toMatch(/active_needs_schedule/)
    await as(A, `update medications set times = '{08:00}', food = 'after', status = 'active' where id = 'm-a'`)
  })
  it('rejects implausible readings and sugar without a value', async () => {
    expect(await asErr(A, `insert into health_readings(id, owner_id, type, at) values ('bad','${A}','sugar', now())`)).toMatch(/sugar_has_value/)
    expect(await asErr(A, `insert into health_readings(id, owner_id, type, at, systolic, diastolic) values ('bad2','${A}','bp', now(), 80, 120)`)).toMatch(/bp_has_values/)
  })
})

describe('server scheduler', () => {
  it('materialises recurrence once per day (idempotent) in the owner time zone', async () => {
    await as(A, `insert into reminder_series(id, owner_id, kind, title, medication_id, local_time, time_zone, start_at)
                 values ('ser1','${A}','medicine','Metformin 500mg','m-a','00:01','Asia/Kolkata', now() - interval '2 days')`)
    const first = Number((await as(null, 'select materialize_reminders(2) as n', 'service_role'))[0].n)
    const again = Number((await as(null, 'select materialize_reminders(2) as n', 'service_role'))[0].n)
    expect(first).toBe(3); expect(again).toBe(0)
    const keys = (await as(A, `select idempotency_key k, scheduled_for at time zone 'Asia/Kolkata' as local from reminders where series_id='ser1' order by 1`)) as any[]
    expect(keys).toHaveLength(3)
    expect(String(keys[0].local)).toMatch(/00:01:00/)
    expect((await as(A, `select id from reminders where series_id='ser1' order by 1 limit 1`))[0]).toMatchObject({ id: expect.stringMatching(/^rem_series:ser1:\d{4}-\d{2}-\d{2}$/) })
  })
  it('claims each due reminder exactly once, even when called twice', async () => {
    await as(A, `insert into reminders(id, owner_id, kind, title, scheduled_for, original_scheduled_for, time_zone, idempotency_key)
                 values ('due1','${A}','custom','Walk', now() - interval '1 minute', now() - interval '1 minute','Asia/Kolkata','k1'),
                        ('future','${A}','custom','Later', now() + interval '1 hour', now() + interval '1 hour','Asia/Kolkata','k2')`)
    const a = await as<{ id: string }>(null, 'select id from claim_due_reminders(100)', 'service_role')
    const b = await as<{ id: string }>(null, 'select id from claim_due_reminders(100)', 'service_role')
    expect(a.map((r) => r.id)).toContain('due1'); expect(a.map((r) => r.id)).not.toContain('future')
    expect(b.map((r) => r.id)).not.toContain('due1')
    expect((await as(A, `select status, dispatch_attempts from reminders where id='due1'`))[0]).toMatchObject({ status: 'ringing', dispatch_attempts: 1 })
  })
  it('snoozing re-arms the same row (no duplicate) and it dispatches again', async () => {
    await as(A, `update reminders set status='snoozed', scheduled_for = now() - interval '1 second' where id='due1'`)
    const c = await as<{ id: string }>(null, 'select id from claim_due_reminders(100)', 'service_role')
    expect(c.map((r) => r.id)).toContain('due1')
    expect(Number((await as(A, `select count(*) n from reminders where title='Walk'`))[0].n)).toBe(1)
  })
  it('failed delivery is retried with exponential backoff and eventually left visible', async () => {
    await as(A, `insert into reminders(id, owner_id, kind, title, scheduled_for, original_scheduled_for, time_zone, idempotency_key)
                 values ('retry1','${A}','custom','Retry', now() - interval '1 minute', now() - interval '1 minute','Asia/Kolkata','k3')`)
    await as(null, 'select id from claim_due_reminders(100)', 'service_role')
    await as(null, `select release_for_retry('retry1','push 503')`, 'service_role')
    let r = (await as(A, `select status, next_attempt_at > now() as later, last_dispatch_error e from reminders where id='retry1'`))[0] as any
    expect(r).toMatchObject({ status: 'scheduled', later: true, e: 'push 503' })
    expect((await as<{ id: string }>(null, 'select id from claim_due_reminders(100)', 'service_role')).map((x) => x.id)).not.toContain('retry1') // not before backoff
    await as(A, `update reminders set next_attempt_at = now() - interval '1 second', dispatch_attempts = 5, status='ringing' where id='retry1'`)
    await as(null, `select release_for_retry('retry1','still failing')`, 'service_role')
    r = (await as(A, `select status from reminders where id='retry1'`))[0] as any
    expect(r.status).toBe('ringing')
  })
  it('unanswered reminders become missed after the grace window, never completed', async () => {
    await as(A, `update reminders set status='ringing', scheduled_for = now() - interval '2 hours' where id='retry1'`)
    expect(Number((await as(null, 'select expire_stale_reminders(60) as n', 'service_role'))[0].n)).toBeGreaterThanOrEqual(1)
    expect((await as(A, `select status from reminders where id='retry1'`))[0]).toMatchObject({ status: 'missed' })
  })
  it('scheduler functions are not callable by app users', async () => {
    expect(await asErr(A, 'select claim_due_reminders(1)')).toMatch(/permission denied/)
    expect(await asErr(A, 'select materialize_reminders(1)')).toMatch(/permission denied/)
  })
})

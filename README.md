# Smaran

Voice-first family health companion for Indian households: medicine reminders, a voice companion ("Sathi"), family
profiles (Mummy, Papa, you), health readings, medicine stock, appointments and family access.
React + Vite + TypeScript frontend (`app/`) with a Supabase backend (`supabase/`).

The original 48 screens match the approved design (`project/`, `DESIGN_HANDOFF.md`). Three screens were **added** because the
workflows need them: 49 *Who are you helping*, 50 *Family profile*, 51 *Join a family*. Visible changes to existing screens are
listed under "Design changes" below.

## Run it
```bash
cd app
npm install
npm run dev            # http://localhost:5173  (add ?menu to the URL for the screen list and "Demo & test controls")
npm run check          # type-check functions + all unit/DB tests + type-check + production build
npm run build          # type-check + production build only
```
With no environment variables the app runs in **local demo mode** (data stays in this browser, the prescription reader is a
clearly labelled mock, browser speech). To try everything with the synthetic family: open `http://localhost:5173/?menu`, expand
"Demo & test controls", press **Load demo family (Mummy & Papa)**. Everything in it is invented, labelled "(demo)", and never uploaded.

Real services: `docs/DEPLOYMENT.md` (Supabase + Vercel), `docs/SARVAM_SETUP.md`, `docs/ELEVENLABS_AGENT.md`,
`docs/LIVE_VERIFICATION.md` (what to run against your real accounts), `docs/SECURITY_REVIEW.md`. Never commit `.env` files;
`app/.env.example`, `app/.env.server.example` and `supabase/.env.example` list every variable name.

## Tests
| Command | What it runs |
|---|---|
| `npm test` | unit + database tests (vitest): reminders, NL parsing, voice, profiles, stock, health cards, invitations, RLS on real SQL (PGlite), Sarvam, ElevenLabs mapping |
| `npm run e2e:family` / `e2e:stock` / `e2e:demo` | Playwright through the real UI in local demo mode |
| `npm run e2e:auth` | Playwright with a **mocked** Supabase Auth |
| `npm run e2e:sarvam` | Playwright through the dev API against a **fake** Sarvam server |
Playwright is installed globally: run with `NODE_PATH=$(npm root -g)`. None of these call Sarvam, ElevenLabs or a real Supabase project.

## What works (and how far it is verified)
| Area | State |
|---|---|
| Email sign-up, verification, sign-in, password reset, session restore, no phone required | Built on Supabase Auth; UI verified against a **mocked** Auth API; not run against a real project |
| Family profiles (self, Mummy, Papa, custom), stable ids, per-profile records and settings, archive/restore | Works; DB rules tested on SQL |
| Family access: email-bound invitations, scope per profile, roles, revoke | DB rules tested on SQL; UI wired, needs a real project to try |
| Prescription upload → Sarvam → ZIP → draft → review → confirm | Built to the documented API; verified against a **fake** server only |
| Reminders: create/snooze/reschedule/complete/skip/cancel, daily recurrence, idempotency | Works; server tool + scheduler logic tested |
| Voice reminders through Sathi; answers in the language spoken; masculine Hindi | Rules tested; speech quality depends on the browser |
| ElevenLabs agent tools + Mom/Dad voice mapping | Mapping, consent and tool results tested with mocks; **not run against a live agent** |
| Medicine stock and refill alerts (transparent estimate from confirmed doses) | Works, tested |
| Health cards, trends only with enough data, appointments, follow-ups | Works, tested |
| Help & support guides | Works |
| Server scheduler + Web Push | Implemented and tested on SQL; needs your project, keys and a real device |

## Layout
```
app/src/domain      pure logic: reminders, people, stock, health cards, NL parsing, time zones
app/src/store       persisted shared state + actions (active family member scopes every screen)
app/src/screens     Screen01..Screen51
app/src/voice       speech, language detection, conversation brain, session state machine
app/src/services    backend gateway, sync, extraction, agent tools, familyApi, push, ElevenLabs
app/e2e             Playwright scripts
supabase/           10 migrations, Edge Functions, shared server code, DB and logic tests
docs/               deployment, live verification, agent config, security review, audit, test report
```

## Design changes to existing screens (all deliberate)
- **02 Create account:** phone field replaced by email (+ password when a server is connected); sign-in, reset and "check your email" states.
- **13 / 14 Home, 20 Health:** *Family members* and *Health cards* sections appear **only** when you manage a parent; *Help & support* link at the end of 13, 14, 15, 20, 46, 50.
- **47 Help:** the four original cards are unchanged; "More guides" added below them.
- **08, 09, 10, 11, 28, 31, 45:** language choice, who-is-it-for, cancel, compare-with-original-text, optional "More details" and stock fields appear **only after interaction**.
- **24 / 41 Family Space:** with a server connected, invitations are created on the server.
- Everything else renders as before (pixel comparison against the original: see `docs/TEST_REPORT.md`).

## Not built / limits
Voice **cloning** (recording, consent capture, creating a voice) is deliberately not built; Mom/Dad only select voices you already configured.
No phone calls, no locked-phone wake-up, no appointment booking, no medicine ordering. Data export and server-side deletion are not one-tap.
Marathi/Kannada can be heard; Sathi replies in Hindi/English. No lint tool is configured; type-checking is the static check.

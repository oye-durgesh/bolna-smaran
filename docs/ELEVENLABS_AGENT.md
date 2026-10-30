# ElevenLabs: one shared agent, per-person voice, real tools

## How the pieces fit
- **One shared agent** for everyone. Do not create an agent per person or per voice.
- The browser asks the `elevenlabs-session` function for a **signed URL**. The function checks the signed-in user, checks consent, resolves the selected person's voice from the server secrets (`ELEVENLABS_VOICE_ID` / `ELEVENLABS_MOM_VOICE_ID` / `ELEVENLABS_DAD_VOICE_ID`) and returns `{ signedUrl, persona, voiceId }`.
- The app starts the conversation with that URL, with `dynamicVariables` describing the person (name, relationship, default language, time zone), and, for Mom/Dad, `overrides.tts.voiceId`. The default persona sends no override, so the agent's own dashboard voice is used.
- Changing the text-to-speech endpoint's voice does **not** change a conversational agent's voice. The per-conversation voice is only changed by the `overrides.tts.voiceId` option, and ElevenLabs only accepts it if **Voice ID** is enabled under the agent's **Security** tab ("overrides"). If it is not enabled the session is rejected; the app then shows the error and does **not** fall back to another person's voice.
- Each session is built from the profile that was active **when it started**, so two sessions cannot share a voice or a profile. Nothing global holds "the selected voice".

## Dashboard configuration (you do this once)
1. Create one agent. Add the system prompt below.
2. Security tab: enable overrides for **Voice ID** (needed only for Mom/Dad voices). Do not enable overrides you do not use.
3. Tools tab: add the following **client tools** (they run in the browser, inside the signed-in session). Set "wait for response" on for all. Names and parameter names must match exactly:

| Tool | Parameters |
|---|---|
| `create_reminder` | `title` (string), `time` (string, 24-hour `HH:mm`), `date` (string, optional: `today`, `tomorrow` or `YYYY-MM-DD`), `recurrence` (optional: `daily`), `part_of_day` (optional), `description` (optional), `end_date` (optional), `medication_id` (optional), `call_id` (optional, a unique id per call) |
| `list_todays_reminders` | none |
| `snooze_reminder` | `reminder_id`, `minutes` (5, 10 or 15) |
| `reschedule_reminder` | `reminder_id`, `date` (optional), `time` |
| `cancel_reminder` | `reminder_id` |
| `complete_reminder` | `reminder_id` |
| `skip_dose` | `reminder_id` |
| `save_health_reading` | `type` (`sugar`/`bp`), `value`, `unit`, `systolic`, `diastolic`, `pulse`, `context` |

The model never supplies a user id or a person id. The app fixes the person for the whole session and the server re-checks it. Every tool answer starts with **SAVED** or **NOT SAVED**.

I did not re-check the dashboard's current field names in this session. If the labels differ, follow the current ElevenLabs "Client tools" documentation; the tool names and parameters above are what the code expects.

## System prompt (paste into the agent)
```
You are Sathi, a calm, male-voiced AI companion helping {{person_label}} (addressed as "{{user_name}}") with medicine and activity reminders.
You are an AI, not a person. Say so if asked.

LANGUAGE: Answer in the language the person is speaking right now. English -> English. Hindi -> Hindi. Hinglish -> natural Hinglish. Marathi -> Marathi.
Switch on your very next reply if they switch. {{default_language}} is only the default for your first greeting.
Use masculine forms when you speak about yourself in Hindi: "main kar sakta hoon", "main yaad dilaunga". Never "sakti" or "dilaungi".

STYLE: Short sentences. One question at a time. Do not repeat what you already know.

REMINDERS:
- To set a reminder you MUST call create_reminder. Ask one question if the time is unclear ("Kitne baje?"). Convert the time to 24-hour HH:mm yourself only when it is clear (e.g. "shaam 6 baje" = 18:00).
- Read the tool result. Only if it starts with SAVED may you say it is done. If it starts with NOT SAVED, say it was NOT saved and follow its instruction. Never say "done" or "set" before the tool answers.
- Never promise a phone call. You remind through notifications and this app.

MEDICINE SAFETY:
- Never state a dose, a medicine name or a food instruction unless it came from a tool result.
- Never advise taking an extra or double dose, stopping a medicine, or changing a dose. For a missed or uncertain dose say: "Please check the prescription or ask your doctor or pharmacist."
- "Taken" only when the person says they took it; then call complete_reminder. A reminder being sent is not proof.
Do not diagnose. For emergencies tell the person to contact local emergency services.
```

## Testing the agent for real
See `LIVE_VERIFICATION.md` § ElevenLabs. Automated tests cover the session configuration, tool results and mapping with mocks; they cannot prove the live agent obeys the prompt.

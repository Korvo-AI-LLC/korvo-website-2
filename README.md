# Korvo AI Website

Marketing site + a small admin area, served by an Express app.

## Run locally

```bash
npm install
cp .env.example .env   # fill in values
npm start              # http://localhost:3000
```

## Admin

- `/admin` — consultation requests, the **Patient Calls** log, and the Discovery Intake.
- `/admin/discovery` — the discovery-call intake form. Fill it out and **Save**;
  each save becomes its own record. Open **Saved calls** to reopen and edit a
  past call, or delete one.

Both are gated by the `ADMIN_PASS` password.

## Patient calls (Trillet voice agent)

The Trillet voice agent that books podiatry appointments feeds every completed
call into the site, where it's collected in a **Patient Calls** panel on `/admin`
(Name · DOB · Appointment · Source · Summary) and rolled up into a **daily
summary email**.

**Ingest — two paths into the same store (deduped):**

- **Webhook (primary).** In the Trillet dashboard, add a post-call webhook /
  action pointing at:

  ```
  https://<your-site>/api/calls?token=<CALL_WEBHOOK_SECRET>
  ```

  and map the collected variables into the JSON body. Fields are matched
  tolerantly, so common spellings all work:

  ```jsonc
  {
    "name":        "Jane Doe",          // or patient_name / patientName
    "dob":         "1985-03-14",         // or date_of_birth / dateOfBirth
    "appointment": "2026-08-03 2:30pm",  // or appointment_time / appointment_date
    "phone":       "512-555-0199",       // optional
    "summary":     "New patient, heel pain, booked.",  // optional
    "transcript":  "…",                  // optional
    "callId":      "trillet-abc123"      // optional
  }
  ```

  The whole payload is also stored under `data.raw` for auditing.

- **Email fallback (safety net).** A daily job reads the per-call summary emails
  from Gmail and back-fills any call the webhook missed by POSTing it to the same
  `/api/calls` endpoint. Calls are de-duped on a normalised `name|dob|appointment`
  key, so the webhook and the fallback never create doubles — a later source just
  fills in any blanks.

**Daily summary email.** `POST /api/calls/digest` (admin-gated) builds a summary
of the day's calls and sends it via Resend to `MAIL_TO`. The daily job calls this
after the email back-fill so the digest reflects the full day. Pass `?since=` to
override the window (defaults to midnight today).

**Config.** Set `CALL_WEBHOOK_SECRET` (see `.env.example`). If it's left unset,
`/api/calls` falls back to requiring `ADMIN_PASS`.

### Call storage

Same dual backend as discovery calls: a `patient_calls` table when
`DATABASE_URL` is set, otherwise JSON at `DATA_DIR/calls.json` (defaults to
`./data`). The store lives in `lib/callStore.js`; the API is `/api/calls`
(webhook create + admin list/read/delete) and `/api/calls/digest`.

## Discovery-call storage

The intake form saves through `/api/discovery` (list/create) and
`/api/discovery/:id` (read/update/delete). Storage is chosen automatically:

- **Postgres** — used when `DATABASE_URL` is set. A `discovery_calls` table is
  created on boot (meta fields as columns, the full answers object as JSONB).
- **JSON file** — fallback when there is no `DATABASE_URL`. Records live in
  `DATA_DIR/discovery.json` (defaults to `./data`).

### Deploying on Railway

1. Create a service from this repo. Railway reads `railway.json` / the
   `Procfile` (`node app.js`) and runs `npm install` automatically.
2. Set env vars on the service: `ADMIN_PASS`, `RESEND_API_KEY`, `MAIL_TO`,
   `CALL_WEBHOOK_SECRET`.
3. **Add Postgres for permanent storage** (the important step):
   - In your Railway **project**, click **New → Database → Add PostgreSQL**.
   - Open your **web service → Variables → New Variable → Add Reference**, and
     reference the Postgres service's `DATABASE_URL` (or use Railway's
     "Connect" which adds it for you).
   - Redeploy. On boot the log prints `Discovery store ready (Postgres)` and
     `Call store ready (Postgres)`; the `discovery_calls` and `patient_calls`
     tables are created automatically. Saved records now survive every redeploy.
     SSL is auto-detected (off for the internal URL).

   _Alternative:_ skip Postgres, attach a **Volume** to the service, and set
   `DATA_DIR` to its mount path (e.g. `/data`) to persist the JSON fallback.

Without Postgres or a volume, file storage still works but lives on the
container's ephemeral disk and is lost on redeploy.

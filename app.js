require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const path    = require('path');
const fs      = require('fs');
const { Resend } = require('resend');
const resend  = new Resend(process.env.RESEND_API_KEY);
const discoveryStore = require('./lib/discoveryStore');
const callStore = require('./lib/callStore');
const signupStore = require('./lib/signupStore');
const intakeSchema = require('./lib/intakeSchema'); // reads SCHEMA from public/admin.html (untouched)
// Sender for all site email. onboarding@resend.dev only delivers to the Resend account
// owner's own address; set MAIL_FROM to an address on a domain verified in Resend
// (e.g. "Korvo AI <notify@korvo.ai>") so mail can reach any inbox, including hello@korvo.ai.
const MAIL_FROM = process.env.MAIL_FROM || 'Korvo AI <onboarding@resend.dev>';
// Where new-signup notifications go. Owner's requirement: hello@korvo.ai.
const SIGNUP_NOTIFY_TO = process.env.SIGNUP_NOTIFY_TO || 'hello@korvo.ai';

// Send one email through Resend and report what actually happened. The Resend SDK does
// NOT throw on most failures (bad key, unverified sender, rejected recipient) — it returns
// { data, error }. So success means: no error AND Resend handed back a message id.
async function sendMail({ to, subject, text, replyTo }) {
  if (!process.env.RESEND_API_KEY) return { ok: false, error: 'RESEND_API_KEY is not set' };
  if (!to) return { ok: false, error: 'No recipient configured' };
  try {
    const { data, error } = await resend.emails.send({
      from: MAIL_FROM, to, subject, text,
      ...(replyTo ? { replyTo } : {}),
    });
    if (error) return { ok: false, error: `${error.name || 'error'}: ${error.message || 'unknown'}` };
    if (!data || !data.id) return { ok: false, error: 'Resend returned no message id' };
    return { ok: true, id: data.id };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

// Tell the owner about a new lead: email SIGNUP_NOTIFY_TO (hello@korvo.ai); if Resend rejects
// that, retry once to MAIL_TO so the owner still hears about it. ok=true only if Resend accepted one.
async function notifyOwner({ subject, text, replyTo, tag }) {
  const first = await sendMail({ to: SIGNUP_NOTIFY_TO, subject, text, replyTo });
  if (first.ok) return { ok: true, route: 'primary' };
  console.error(`${tag} notify to ${SIGNUP_NOTIFY_TO} failed:`, first.error);
  const fallback = process.env.MAIL_TO;
  if (fallback && fallback.toLowerCase() !== SIGNUP_NOTIFY_TO.toLowerCase()) {
    const retry = await sendMail({ to: fallback, subject: `[fallback] ${subject}`, text, replyTo });
    if (retry.ok) return { ok: true, route: 'fallback' };
    console.error(`${tag} notify fallback failed:`, retry.error);
    return { ok: false, error: retry.error, firstError: first.error };
  }
  return { ok: false, error: first.error };
}

// Per-IP rate limiter (in memory; resets on deploy). Railway's proxy IP is handled by trust proxy.
function makeLimiter({ windowMs, max }) {
  const hits = new Map();
  return (ip) => {
    const now = Date.now();
    const list = (hits.get(ip) || []).filter((t) => now - t < windowMs);
    list.push(now);
    hits.set(ip, list);
    if (hits.size > 5000) hits.clear();
    return list.length > max;
  };
}
const ADMIN_PASS = process.env.ADMIN_PASS || 'korvo2026';
// Shared secret the Trillet webhook (and the email-fallback job) must present.
const CALL_WEBHOOK_SECRET = process.env.CALL_WEBHOOK_SECRET || '';

// Simple admin auth — accepts the password via query (?adminKey=) or x-admin-key header.
function requireAdmin(req, res, next) {
  const key = req.query.adminKey || req.headers['x-admin-key'];
  if (key !== ADMIN_PASS) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// Webhook auth — a shared secret via ?token= or the x-webhook-secret header. Trillet
// can't send the admin password, so the ingest endpoint uses this instead. When no
// secret is configured we fall back to requiring the admin key (safe default).
function requireWebhookSecret(req, res, next) {
  if (!CALL_WEBHOOK_SECRET) return requireAdmin(req, res, next);
  const token = req.query.token || req.headers['x-webhook-secret'];
  if (token !== CALL_WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// Test-call filter. Practice test calls should never reach the log or the daily
// summary, so we drop any payload with "test" in its content. Matched at a word
// boundary (test, Test, testing, "test call") so real words like "latest" or
// "greatest" don't trigger it. Walks string values only, at any depth.
function mentionsTest(v) {
  if (typeof v === 'string') return /\btest/i.test(v);
  if (Array.isArray(v)) return v.some(mentionsTest);
  if (v && typeof v === 'object') return Object.values(v).some(mentionsTest);
  return false;
}

const APPTS_FILE = path.join(__dirname, 'data', 'appointments.json');
function getAppts() {
  if (!fs.existsSync(APPTS_FILE)) return { appointments: [] };
  return JSON.parse(fs.readFileSync(APPTS_FILE, 'utf8'));
}
function saveAppts(d) { fs.writeFileSync(APPTS_FILE, JSON.stringify(d, null, 2)); }

const app  = express();
const PORT = process.env.PORT || 3000;
app.set('trust proxy', 1); // Railway sits in front; needed for real client IPs (signup rate limit)

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc:   ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc:    ["'self'", "https://fonts.gstatic.com"],
      scriptSrc:     ["'self'", "'unsafe-inline'"],
      scriptSrcElem: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      connectSrc: ["'self'"],
      imgSrc:     ["'self'", "data:", "https:"],
      frameSrc:   ["https://forms.office.com"],
    },
  },
}));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Retired pages. korvo.ai now sells one product (after-hours AI receptionist, $997/mo),
// so the old multi-offer pages (SMS, AI research/creation, ROI pricing, consultations)
// send visitors to the single landing page instead. Registered BEFORE express.static so
// the .html paths are caught too. 302 (not 301) so this is easy to reverse.
// about/learn-more/pricing .html files are still in public/; book.html has been deleted.
const RETIRED_PAGES = {
  '/about': '/',        '/about.html': '/',
  '/learn-more': '/',   '/learn-more.html': '/',
  '/pricing': '/#signup', '/pricing.html': '/#signup',
  '/book': '/#signup',  '/book.html': '/#signup',
};
app.use((req, res, next) => {
  const to = req.method === 'GET' && RETIRED_PAGES[req.path];
  return to ? res.redirect(302, to) : next();
});

app.use(express.static(path.join(__dirname, 'public')));

// Pages
app.get('/',           (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/privacy',    (req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));
app.get('/terms',      (req, res) => res.sendFile(path.join(__dirname, 'public', 'terms.html')));
app.get('/intake',     (req, res) => res.sendFile(path.join(__dirname, 'public', 'intake.html')));
// The intake SCHEMA as a script, generated from admin.html so /intake and the modal can never drift from /admin.
app.get('/js/intake-schema.js', (req, res) => {
  res.type('application/javascript').set('Cache-Control', 'no-cache');
  res.send(`window.KORVO_INTAKE = ${JSON.stringify({ schema: intakeSchema.schema, version: intakeSchema.version })};\n`);
});
app.get('/admin',      (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
// Old separate intake URL now folds into the single admin page.
app.get('/admin/discovery', (req, res) => res.redirect('/admin'));
// Patient calls live in a panel on the single admin page too.
app.get('/admin/calls', (req, res) => res.redirect('/admin'));

// API: Contact form (legacy; the landing page uses /api/signup). Saves first, then emails,
// and only reports success if Resend actually accepted the email.
app.post('/api/contact', async (req, res) => {
  const { name, email, phone, service, preferred_time, message } = req.body || {};
  if (!name || !email || !message) {
    return res.status(400).json({ error: 'Name, email, and message are required.' });
  }
  try {
    const appts = getAppts();
    appts.appointments.unshift({
      id: Date.now().toString(),
      name, email,
      phone: phone || '',
      service: service || '',
      preferred_time: preferred_time || '',
      message,
      submitted: new Date().toISOString(),
    });
    saveAppts(appts);
  } catch (err) {
    console.error('Contact save error:', err.message);
  }
  const sent = await sendMail({
    to: process.env.MAIL_TO,
    replyTo: email,
    subject: `New inquiry from ${name}`,
    text: [
      `Name: ${name}`,
      `Email: ${email}`,
      `Phone: ${phone || 'not provided'}`,
      `Service: ${service || 'not specified'}`,
      `Preferred time: ${preferred_time || 'not specified'}`,
      ``,
      `Message:`,
      message,
    ].join('\n'),
  });
  if (!sent.ok) {
    console.error('Contact mail error:', sent.error);
    return res.status(502).json({ error: 'We couldn’t send your message. Please email hello@korvo.ai directly.' });
  }
  res.json({ success: true, message: "Thanks. We'll be in touch within one business day." });
});

// API: Signup (landing page #signup form).
// 1) validate  2) save the lead (so it's never lost)  3) email hello@korvo.ai
// 4) if that send is rejected, retry once to MAIL_TO so the owner still hears about it
// 5) respond success ONLY if a notification email was accepted by Resend.
const signupLimited = makeLimiter({ windowMs: 10 * 60 * 1000, max: 5 });
const clean = (v, max) => String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);

app.post('/api/signup', async (req, res) => {
  const body = req.body || {};
  // Spam trap: real people never see or fill the hidden "website" field.
  if (clean(body.website, 200)) return res.json({ success: true });
  if (signupLimited(req.ip)) {
    return res.status(429).json({ error: 'Too many attempts. Wait a few minutes, or email hello@korvo.ai.' });
  }

  const lead = {
    name: clean(body.name, 120),
    business: clean(body.business, 160),
    phone: clean(body.phone, 40),
    email: clean(body.email, 200),
  };
  const missing = [];
  if (!lead.name) missing.push('your name');
  if (!lead.business) missing.push('business name');
  if (lead.phone.replace(/\D/g, '').length < 7) missing.push('a phone number');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(lead.email)) missing.push('a valid email');
  if (missing.length) return res.status(400).json({ error: `Please add ${missing.join(', ')}.` });

  // 2) Save first. A storage failure must not block the notification email.
  let saved = null;
  try {
    saved = await signupStore.create({ ...lead, ip: req.ip, userAgent: clean(req.headers['user-agent'], 300) });
  } catch (err) {
    console.error('Signup save error:', err.message);
  }

  // 3) Notify the owner.
  const at = new Date();
  const mountain = at.toLocaleString('en-US', { timeZone: 'America/Denver', dateStyle: 'medium', timeStyle: 'short' });
  const text = [
    'New signup on korvo.ai',
    '',
    `Name:      ${lead.name}`,
    `Business:  ${lead.business}`,
    `Phone:     ${lead.phone}`,
    `Email:     ${lead.email}`,
    `Signed up: ${mountain} Mountain (${at.toISOString()})`,
    '',
    'Next, the site walks them through the full discovery intake. If they finish it,',
    'a second email follows with every answer. If it never comes, they stopped at signup.',
    'The 72-hour guarantee clock is running.',
    '',
    saved ? `Lead ID: ${saved.id} (saved; list all at /api/signups with the admin key)` : 'WARNING: this lead could NOT be saved to the database. This email is the only record.',
  ].join('\n');
  const message = { subject: `New signup: ${lead.business} (${lead.name})`, text, replyTo: lead.email };

  const sent = await notifyOwner({ ...message, tag: 'Signup' });
  const route = sent.route;

  if (saved) {
    const why = sent.ok ? '' : [sent.firstError && `hello@: ${sent.firstError}`, `${sent.firstError ? 'fallback: ' : ''}${sent.error}`].filter(Boolean).join(' | ');
    signupStore.setNotify(saved.id, sent.ok ? (route === 'primary' ? 'sent' : 'sent-fallback') : 'failed', why)
      .catch((err) => console.error('Signup notify-status update error:', err.message));
  }

  if (!sent.ok) {
    return res.status(502).json({
      error: 'We couldn’t confirm your signup went through. Please email hello@korvo.ai and we’ll get you started.',
      saved: !!saved,
    });
  }
  res.json({ success: true, notified: route, saved: !!saved, id: saved ? saved.id : null });
});

// API: Signups list (admin) — every saved lead, newest first, with notification status.
app.get('/api/signups', requireAdmin, async (req, res) => {
  try {
    res.json(await signupStore.list());
  } catch (err) {
    console.error('Signup list error:', err.message);
    res.status(500).json({ error: 'Could not load signups.' });
  }
});

// API: Appointments (admin)
app.get('/api/appointments', requireAdmin, (req, res) => {
  res.json(getAppts().appointments);
});

// API: Discovery calls (admin) — list / create / read / update / delete
app.get('/api/discovery', requireAdmin, async (req, res) => {
  try {
    res.json(await discoveryStore.list());
  } catch (err) {
    console.error('Discovery list error:', err.message);
    res.status(500).json({ error: 'Could not load discovery calls.' });
  }
});

app.get('/api/discovery/:id', requireAdmin, async (req, res) => {
  try {
    const rec = await discoveryStore.get(req.params.id);
    if (!rec) return res.status(404).json({ error: 'Not found' });
    res.json(rec);
  } catch (err) {
    console.error('Discovery get error:', err.message);
    res.status(500).json({ error: 'Could not load that call.' });
  }
});

// POST /api/discovery has two callers:
//  • /admin (sends the admin key): unchanged — any record, no limits.
//  • the public intake (/intake page + signup modal, no key): spam trap, rate limit, schema-only
//    fields, then an email to the owner with every answer. A wrong key still gets 401.
const intakeLimited = makeLimiter({ windowMs: 60 * 60 * 1000, max: 5 });
const hasAdminKey = (req) => !!(req.query.adminKey || req.headers['x-admin-key']);

app.post('/api/discovery', (req, res, next) => (hasAdminKey(req) ? requireAdmin(req, res, next) : publicIntake(req, res)), async (req, res) => {
  try {
    res.status(201).json(await discoveryStore.create(req.body || {}));
  } catch (err) {
    console.error('Discovery create error:', err.message);
    res.status(500).json({ error: 'Could not save call.' });
  }
});

async function publicIntake(req, res) {
  const body = req.body || {};
  if (clean(body.hp, 200)) return res.status(201).json({ success: true }); // spam trap filled: drop silently
  if (intakeLimited(req.ip)) {
    return res.status(429).json({ error: 'Too many submissions from this connection. Wait a bit, or email hello@korvo.ai.' });
  }

  const { meta, answers } = intakeSchema.sanitize(body);
  const signup = body.signup || {};
  const contactIn = body.contact || {};
  const who = {
    signupId: clean(signup.id, 40),
    name: clean(signup.name || meta.contactName, 120),
    business: clean(signup.business || meta.practiceName, 160),
    phone: clean(signup.phone || contactIn.phone, 40),
    email: clean(signup.email || contactIn.email, 200),
  };
  if (!meta.practiceName) return res.status(400).json({ error: 'Please add your practice name (first section).' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(who.email)) return res.status(400).json({ error: 'Please add a valid email so we can reach you (first section).' });
  if (who.phone.replace(/\D/g, '').length < 7) return res.status(400).json({ error: 'Please add a phone number so we can reach you (first section).' });

  // Not schema fields, so /admin ignores them; kept on admin edits (see discoveryStore).
  answers._source = 'public-intake';
  answers._contact = who;

  const record = { meta, answers, schemaVersion: intakeSchema.version, exportedAt: new Date().toISOString() };
  let saved = null;
  try {
    saved = await discoveryStore.create(record);
  } catch (err) {
    console.error('Public intake save error:', err.message);
  }

  const at = new Date();
  const mountain = at.toLocaleString('en-US', { timeZone: 'America/Denver', dateStyle: 'medium', timeStyle: 'short' });
  const text = [
    `Intake completed on korvo.ai: ${meta.practiceName}`,
    '',
    `Name:      ${who.name || '—'}`,
    `Business:  ${who.business || '—'}`,
    `Phone:     ${who.phone}`,
    `Email:     ${who.email}`,
    `Submitted: ${mountain} Mountain (${at.toISOString()})`,
    who.signupId ? `Signup ID: ${who.signupId}` : 'Signup ID: none (came straight to /intake)',
    saved ? `Record ID: ${saved.id} (open it in /admin under Saved calls)` : 'WARNING: this intake could NOT be saved to the database. This email is the only copy.',
    '',
    `All ${intakeSchema.fieldCount} intake fields:`,
    intakeSchema.toText(record),
  ].join('\n');
  const sent = await notifyOwner({ subject: `Intake complete: ${meta.practiceName}`, text, replyTo: who.email, tag: 'Intake' });

  if (!saved && !sent.ok) {
    return res.status(500).json({ error: 'We couldn\u2019t save your answers. Please try again in a minute, or email hello@korvo.ai.' });
  }
  if (!sent.ok) {
    return res.status(502).json({
      error: 'Your answers are saved, but we couldn\u2019t alert our team. Please email hello@korvo.ai so we know to look.',
      saved: true,
    });
  }
  res.status(201).json({ success: true, saved: !!saved, notified: sent.route, id: saved ? saved.id : null });
}

app.put('/api/discovery/:id', requireAdmin, async (req, res) => {
  try {
    const rec = await discoveryStore.update(req.params.id, req.body || {});
    if (!rec) return res.status(404).json({ error: 'Not found' });
    res.json(rec);
  } catch (err) {
    console.error('Discovery update error:', err.message);
    res.status(500).json({ error: 'Could not update call.' });
  }
});

app.delete('/api/discovery/:id', requireAdmin, async (req, res) => {
  try {
    const ok = await discoveryStore.remove(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('Discovery delete error:', err.message);
    res.status(500).json({ error: 'Could not delete call.' });
  }
});

// API: Patient calls (Trillet voice agent)

// Webhook ingest — Trillet POSTs here at the end of each completed call. Secret-gated.
// Accepts either a flat custom JSON body OR Trillet's native payload (call fields under
// conversation_data.gathered_information, plus a transcript object). We flatten both into
// one object, then callStore.shape() maps field names tolerantly. Full payload -> data.raw.
app.post('/api/calls', requireWebhookSecret, async (req, res) => {
  try {
    const body = req.body || {};
    // Skip practice test calls entirely — kept out of the log and the daily summary.
    if (mentionsTest(body)) {
      return res.json({ skipped: true, reason: 'test call (contains "test")' });
    }
    const gathered = (body.conversation_data && body.conversation_data.gathered_information) || {};
    const transcript = body.transcript || {};
    const flat = {
      ...body,        // flat custom-JSON keys (patient_name, booked_datetime, …)
      ...gathered,    // Trillet's nested gathered_information, lifted to the top level
    };
    if (transcript.summary && !flat.transcript_summary) flat.transcript_summary = transcript.summary;
    if (transcript.recordingUrl && !flat.recording_url) flat.recording_url = transcript.recordingUrl;
    const rec = await callStore.create({ ...flat, source: flat.source || 'webhook', raw: body });
    res.status(201).json(rec);
  } catch (err) {
    console.error('Call ingest error:', err.message);
    res.status(500).json({ error: 'Could not save call.' });
  }
});

// List (admin) — optional ?since=ISO or YYYY-MM-DD to limit to recent calls.
app.get('/api/calls', requireAdmin, async (req, res) => {
  try {
    res.json(await callStore.list({ since: req.query.since }));
  } catch (err) {
    console.error('Call list error:', err.message);
    res.status(500).json({ error: 'Could not load calls.' });
  }
});

app.get('/api/calls/:id', requireAdmin, async (req, res) => {
  try {
    const rec = await callStore.get(req.params.id);
    if (!rec) return res.status(404).json({ error: 'Not found' });
    res.json(rec);
  } catch (err) {
    console.error('Call get error:', err.message);
    res.status(500).json({ error: 'Could not load that call.' });
  }
});

app.delete('/api/calls/:id', requireAdmin, async (req, res) => {
  try {
    const ok = await callStore.remove(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('Call delete error:', err.message);
    res.status(500).json({ error: 'Could not delete call.' });
  }
});

// Daily digest — build a summary of recent calls and email it via Resend. Triggered by
// the daily job (after the email-fallback back-fills any misses). ?since= defaults to
// midnight today (local server time). Admin-gated so only trusted callers can send mail.
app.post('/api/calls/digest', requireAdmin, async (req, res) => {
  try {
    const since = req.query.since || new Date(new Date().setHours(0, 0, 0, 0)).toISOString();
    const calls = await callStore.list({ since });
    const dayLabel = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

    const lines = calls.length
      ? calls.map((c, i) => {
          const bits = [
            c.patientName || '(no name)',
            c.dob ? `DOB ${c.dob}` : null,
            c.appointmentAt ? `Appt ${c.appointmentAt}` : null,
          ].filter(Boolean).join(' · ');
          return `${i + 1}. ${bits}${c.summary ? `\n   ${c.summary}` : ''}`;
        })
      : ['No calls captured in this window.'];

    const text = [
      `Korvo AI — Daily Call Summary`,
      dayLabel,
      ``,
      `${calls.length} call${calls.length === 1 ? '' : 's'} captured.`,
      ``,
      ...lines,
      ``,
      `— Review or manage these at ${req.protocol}://${req.get('host')}/admin`,
    ].join('\n');

    let emailed = false;
    let mailError = null;
    if (process.env.RESEND_API_KEY && process.env.MAIL_TO) {
      const sent = await sendMail({
        to: process.env.MAIL_TO,
        subject: `Daily call summary — ${calls.length} call${calls.length === 1 ? '' : 's'} (${new Date().toLocaleDateString()})`,
        text,
      });
      emailed = sent.ok;
      if (!sent.ok) { mailError = sent.error; console.error('Digest mail error:', sent.error); }
    } else {
      console.log('Digest (not emailed — RESEND_API_KEY/MAIL_TO not set):\n' + text);
    }
    res.json({ success: true, emailed, mailError, count: calls.length, since, text });
  } catch (err) {
    console.error('Call digest error:', err.message);
    res.status(500).json({ error: 'Could not build digest.' });
  }
});

// API: Newsletter
app.post('/api/newsletter', (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'A valid email is required.' });
  }
  console.log('Newsletter signup:', email);
  res.json({ success: true, message: "You're subscribed!" });
});

discoveryStore.init()
  .then(() => console.log(`Discovery store ready (${discoveryStore.usingPostgres ? 'Postgres' : 'file'})`))
  .catch((err) => console.error('Discovery store init failed:', err.message));

callStore.init()
  .then(() => console.log(`Call store ready (${callStore.usingPostgres ? 'Postgres' : 'file'})`))
  .catch((err) => console.error('Call store init failed:', err.message));

signupStore.init()
  .then(() => console.log(`Signup store ready (${signupStore.usingPostgres ? 'Postgres' : 'file'})`))
  .catch((err) => console.error('Signup store init failed:', err.message));

app.listen(PORT, () => {
  console.log(`Korvo AI running at http://localhost:${PORT}`);
});

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const path    = require('path');
const fs      = require('fs');
const { Resend } = require('resend');
const resend  = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : (console.warn('WARNING: RESEND_API_KEY not set — starting without email; notifications will queue as pending'), null);
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
app.get('/',           (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html'))); app.get('/about',      (req, res) => res.sendFile(path.join(__dirname, 'public', 'about.html'))); app.get('/join',       (req, res) => res.sendFile(path.join(__dirname, 'public', 'join.html')));
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

/* ─────────────── Owner notifications: saved first, emailed in the background ───────────────
 * A signup or completed intake is saved with notify status "pending" BEFORE any email is tried,
 * and the browser gets its answer right away — Resend can't block the funnel. Delivery runs after
 * the response. A failed send is logged ([notify] kind, id, time, reason) and the record stays
 * "pending", so nothing is silently lost. Retries:
 *   • every 5 minutes, for items with fewer than 6 attempts;
 *   • on every server start, for everything still pending from the last 7 days (up to 50) —
 *     e.g. right after the Resend env vars are fixed in Railway, which restarts the service.
 * Admin view: GET /api/signups?notify=pending and GET /api/discovery?notify=pending.
 */
const NOTIFY = { sweepEveryMs: 5 * 60 * 1000, maxAutoAttempts: 6, maxAgeMs: 7 * 24 * 60 * 60 * 1000, bootLimit: 50 };
const notifyInFlight = new Set();
const mountainTime = (d) => new Date(d).toLocaleString('en-US', { timeZone: 'America/Denver', dateStyle: 'medium', timeStyle: 'short' });
const describeSendFailure = (sent) =>
  [sent.firstError && `hello@: ${sent.firstError}`, `${sent.firstError ? 'fallback: ' : ''}${sent.error}`].filter(Boolean).join(' | ');

function signupMessage(lead, saved = true) {
  const at = lead.createdAt || new Date().toISOString();
  return {
    subject: `New signup: ${lead.business} (${lead.name})`,
    replyTo: lead.email,
    text: [
      'New signup on korvo.ai',
      '',
      `Name:      ${lead.name}`,
      `Business:  ${lead.business}`,
      `Phone:     ${lead.phone}`,
      `Email:     ${lead.email}`,
      `Signed up: ${mountainTime(at)} Mountain (${at})`,
      '',
      'Next, the site walks them through the full discovery intake. If they finish it,',
      'a second email follows with every answer. If it never comes, they stopped at signup.',
      'The 72-hour guarantee clock is running.',
      '',
      saved ? `Lead ID: ${lead.id} (saved; list all at /api/signups with the admin key)` : 'WARNING: this lead could NOT be saved to the database. This email is the only record.',
    ].join('\n'),
  };
}

function applyMessage(rec) {   const answer = (rec.notes || '').trim();   return {     subject: `New job application: ${rec.name} <${rec.email}>`,     text: [       'A new job application came in from the Korvo site.',       '',       `Name:    ${rec.name}`,       `Email:   ${rec.email}`,       `Phone:   ${rec.phone || '(not given)'}`,       '',       'What would you do at Korvo?',       answer || '(no answer given)',       '',       `Application saved: ${rec.id}.`,     ].join('\n'),   }; }  function intakeMessage(rec, saved = true) {
  const who = (rec.answers && rec.answers._contact) || {};
  const at = rec.createdAt || new Date().toISOString();
  return {
    subject: `Intake complete: ${rec.meta.practiceName}`,
    replyTo: who.email,
    text: [
      `Intake completed on korvo.ai: ${rec.meta.practiceName}`,
      '',
      `Name:      ${who.name || '—'}`,
      `Business:  ${who.business || '—'}`,
      `Phone:     ${who.phone || '—'}`,
      `Email:     ${who.email || '—'}`,
      `Submitted: ${mountainTime(at)} Mountain (${at})`,
      who.signupId ? `Signup ID: ${who.signupId}` : 'Signup ID: none (came straight to /intake)',
      saved ? `Record ID: ${rec.id} (open it in /admin under Saved calls)` : 'WARNING: this intake could NOT be saved to the database. This email is the only copy.',
      '',
      `All ${intakeSchema.fieldCount} intake fields:`,
      intakeSchema.toText(rec),
    ].join('\n'),
  };
}

const notifyTargets = {
  signup: {
    load: (id) => signupStore.get(id),
    state: (r) => ({ status: r.notifyStatus, attempts: r.notifyAttempts || 0 }),
    message: (r) => signupMessage(r),
    save: (id, info) => signupStore.setNotify(id, info),
    pending: (opts) => signupStore.listPending({ ...opts, kind: 'signup' }),
  },
  apply: { load: (id) => signupStore.get(id), state: (r) => ({ status: r.notifyStatus, attempts: r.notifyAttempts || 0 }), message: (r) => applyMessage(r), save: (id, info) => signupStore.setNotify(id, info), pending: (opts) => signupStore.listPending({ ...opts, kind: 'apply' }), },  intake: {
    load: (id) => discoveryStore.get(id),
    state: (r) => { const n = (r.answers && r.answers._notify) || {}; return { status: n.status, attempts: n.attempts || 0 }; },
    message: (r) => intakeMessage(r),
    save: (id, info) => discoveryStore.patchAnswers(id, { _notify: info }),
    pending: (opts) => discoveryStore.listNotifyPending(opts),
  },
};

// Never throws; safe to call without awaiting.
async function deliverNotification(kind, id) {
  const key = `${kind}:${id}`;
  if (notifyInFlight.has(key)) return;
  notifyInFlight.add(key);
  try {
    const t = notifyTargets[kind];
    const rec = await t.load(id);
    if (!rec) return;
    const prev = t.state(rec);
    if (prev.status === 'sent' || prev.status === 'sent-fallback') return;
    const sent = await notifyOwner({ ...t.message(rec), tag: `[notify] ${kind} ${id}` });
    const at = new Date().toISOString();
    const attempts = prev.attempts + 1;
    if (sent.ok) {
      await t.save(id, { status: sent.route === 'primary' ? 'sent' : 'sent-fallback', error: '', attempts, lastAttemptAt: at });
      console.log(`[notify] ${kind} ${id} delivered via ${sent.route} at ${at} (attempt ${attempts})`);
    } else {
      const why = describeSendFailure(sent);
      console.error(`[notify] ${kind} ${id} FAILED at ${at} (attempt ${attempts}): ${why} — still pending`);
      await t.save(id, { status: 'pending', error: why, attempts, lastAttemptAt: at });
    }
  } catch (err) {
    console.error(`[notify] ${kind} ${id} ERROR at ${new Date().toISOString()}: ${err.message} — still pending`);
  } finally {
    notifyInFlight.delete(key);
  }
}

async function sweepPendingNotifications({ boot = false } = {}) {
  for (const kind of Object.keys(notifyTargets)) {
    let items = [];
    try {
      items = await notifyTargets[kind].pending({
        maxAgeMs: NOTIFY.maxAgeMs,
        limit: boot ? NOTIFY.bootLimit : 25,
        maxAttempts: boot ? null : NOTIFY.maxAutoAttempts,
      });
    } catch (err) {
      console.error(`[notify] sweep: could not list pending ${kind}s: ${err.message}`);
      continue;
    }
    if (items.length) console.log(`[notify] ${boot ? 'startup' : 'periodic'} sweep: ${items.length} pending ${kind} notification(s)`);
    for (const it of items) await deliverNotification(kind, it.id); // one at a time
  }
}

// API: Signup (landing page #signup form).
// 1) validate  2) save the lead  3) answer the browser right away  4) email hello@korvo.ai in the
// background (see deliverNotification). Only if the SAVE fails does the email become the one record,
// so then — and only then — we wait for it and report honestly.
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

  let saved = null;
  try {
    saved = await signupStore.create({ ...lead, ip: req.ip, userAgent: clean(req.headers['user-agent'], 300) });
  } catch (err) {
    console.error(`[signup] save FAILED at ${new Date().toISOString()}: ${err.message}`);
  }

  if (saved) {
    res.json({ success: true, saved: true, id: saved.id, notify: 'pending' });
    setImmediate(() => deliverNotification('signup', saved.id));
    return;
  }

  // Storage is down: the email is the only record, so it has to go out before we can say yes.
  const sent = await notifyOwner({ ...signupMessage({ ...lead, createdAt: new Date().toISOString() }, false), tag: '[signup] unsaved lead' });
  if (sent.ok) return res.json({ success: true, saved: false, id: null, notify: sent.route });
  console.error(`[signup] NOT SAVED AND NOT EMAILED at ${new Date().toISOString()}: ${describeSendFailure(sent)} | lead: ${JSON.stringify(lead)}`);
  return res.status(500).json({ error: 'We couldn’t record your signup just now. Please try again in a minute, or email hello@korvo.ai.' });
});

const applyLimiter = makeLimiter({ windowMs: 60 * 1000, max: 3 }); app.post('/api/apply', async (req, res) => { if (applyLimiter(req.ip)) return res.status(429).json({ ok: false, error: 'Too many requests. Please try again in a minute.' }); const { name, phone, email, role, website } = req.body || {}; if (website) return res.json({ ok: true, error: null }); const emailOk = typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()); const nameOk = typeof name === 'string' && name.trim().length >= 2; if (!nameOk || !emailOk) return res.status(400).json({ ok: false, error: 'Please provide your name and a valid email address.' }); const rec = await signupStore.create({ kind: 'apply', name: name.trim(), business: '', phone: (phone || '').toString().trim(), email: email.trim(), notes: (role || '').toString().trim(), ip: req.ip, userAgent: req.get('user-agent') || '', }); setImmediate(() => deliverNotification('apply', rec.id)); res.json({ ok: true, error: null, id: rec.id }); }); // API: Signups list (admin) — every saved lead, newest first, each with notifyStatus
// ('pending' = owner email not delivered yet), notifyError, notifyAttempts, notifyLastAttemptAt.
// ?notify=pending → only leads whose notification hasn't gone out.
app.get('/api/signups', requireAdmin, async (req, res) => {
  try {
    res.json(await signupStore.list({ notify: req.query.notify === 'pending' ? 'pending' : undefined }));
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
    // ?notify=pending → full public-intake records whose owner email hasn't gone out (see answers._notify).
    if (req.query.notify === 'pending') return res.json(await discoveryStore.listNotifyPending({ limit: 500, full: true }));
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
  answers._notify = { status: 'pending', error: '', attempts: 0, lastAttemptAt: null };

  const record = { meta, answers, schemaVersion: intakeSchema.version, exportedAt: new Date().toISOString() };
  let saved = null;
  try {
    saved = await discoveryStore.create(record);
  } catch (err) {
    console.error(`[intake] save FAILED at ${new Date().toISOString()}: ${err.message}`);
  }

  if (saved) {
    res.status(201).json({ success: true, saved: true, id: saved.id, notify: 'pending' });
    setImmediate(() => deliverNotification('intake', saved.id));
    return;
  }

  // Storage is down: the email is the only copy, so it has to go out before we can say yes.
  const sent = await notifyOwner({ ...intakeMessage({ ...record, id: null, createdAt: new Date().toISOString() }, false), tag: '[intake] unsaved' });
  if (sent.ok) return res.status(201).json({ success: true, saved: false, id: null, notify: sent.route });
  console.error(`[intake] NOT SAVED AND NOT EMAILED at ${new Date().toISOString()}: ${describeSendFailure(sent)} | practice: ${meta.practiceName} | contact: ${JSON.stringify(who)}`);
  return res.status(500).json({ error: 'We couldn’t save your answers. Please try again in a minute, or email hello@korvo.ai.' });
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

const discoveryReady = discoveryStore.init()
  .then(() => console.log(`Discovery store ready (${discoveryStore.usingPostgres ? 'Postgres' : 'file'})`))
  .catch((err) => console.error('Discovery store init failed:', err.message));

callStore.init()
  .then(() => console.log(`Call store ready (${callStore.usingPostgres ? 'Postgres' : 'file'})`))
  .catch((err) => console.error('Call store init failed:', err.message));

const signupReady = signupStore.init()
  .then(() => console.log(`Signup store ready (${signupStore.usingPostgres ? 'Postgres' : 'file'})`))
  .catch((err) => console.error('Signup store init failed:', err.message));

// Retry owner notifications that are still pending: once at start-up, then every 5 minutes.
Promise.all([discoveryReady, signupReady]).then(() => setTimeout(() => sweepPendingNotifications({ boot: true }), 5000));
setInterval(() => sweepPendingNotifications(), NOTIFY.sweepEveryMs).unref();

app.listen(PORT, () => {
  console.log(`Korvo AI running at http://localhost:${PORT}`);
});

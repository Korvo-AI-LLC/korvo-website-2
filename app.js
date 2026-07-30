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
app.use(express.static(path.join(__dirname, 'public')));

// Pages
app.get('/',           (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/learn-more', (req, res) => res.sendFile(path.join(__dirname, 'public', 'learn-more.html')));
app.get('/about',      (req, res) => res.sendFile(path.join(__dirname, 'public', 'about.html')));
app.get('/pricing',    (req, res) => res.sendFile(path.join(__dirname, 'public', 'pricing.html')));
app.get('/book',       (req, res) => res.sendFile(path.join(__dirname, 'public', 'book.html')));
app.get('/admin',      (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
// Old separate intake URL now folds into the single admin page.
app.get('/admin/discovery', (req, res) => res.redirect('/admin'));
// Patient calls live in a panel on the single admin page too.
app.get('/admin/calls', (req, res) => res.redirect('/admin'));

// API: Contact / booking form
app.post('/api/contact', async (req, res) => {
  const { name, email, phone, service, preferred_time, message } = req.body;
  if (!name || !email || !message) {
    return res.status(400).json({ error: 'Name, email, and message are required.' });
  }
  try {
    await resend.emails.send({
      from: 'Korvo AI <onboarding@resend.dev>',
      to:   process.env.MAIL_TO,
      reply_to: email,
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
    } catch (_) { /* don't block response */ }
    res.json({ success: true, message: "Thanks! We'll be in touch within one business day." });
  } catch (err) {
    console.error('Mail error:', err.message);
    res.status(500).json({ error: 'Could not send message. Please email jack@korvo.ai directly.' });
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

app.post('/api/discovery', requireAdmin, async (req, res) => {
  try {
    res.status(201).json(await discoveryStore.create(req.body || {}));
  } catch (err) {
    console.error('Discovery create error:', err.message);
    res.status(500).json({ error: 'Could not save call.' });
  }
});

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
    if (process.env.RESEND_API_KEY && process.env.MAIL_TO) {
      await resend.emails.send({
        from: 'Korvo AI <onboarding@resend.dev>',
        to: process.env.MAIL_TO,
        subject: `Daily call summary — ${calls.length} call${calls.length === 1 ? '' : 's'} (${new Date().toLocaleDateString()})`,
        text,
      });
      emailed = true;
    } else {
      console.log('Digest (not emailed — RESEND_API_KEY/MAIL_TO not set):\n' + text);
    }
    res.json({ success: true, emailed, count: calls.length, since, text });
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

app.listen(PORT, () => {
  console.log(`Korvo AI running at http://localhost:${PORT}`);
});

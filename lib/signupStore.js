/*
 * Signup (lead) storage for the korvo.ai #signup form — and for job applications
 * from /join (kind 'apply'), which follow the same save-then-notify pattern.
 *
 * Every signup is saved BEFORE any notification email is attempted, with notifyStatus
 * "pending". The email goes out in the background (see app.js, deliverNotification) and the
 * status only leaves "pending" once Resend accepts it, so a failed send is never lost.
 * Same dual backend as discoveryStore / callStore:
 *   • Postgres  — when DATABASE_URL is set (table `signups`, created/migrated on boot).
 *   • JSON file — otherwise, at DATA_DIR/signups.json (defaults to ./data).
 *                 On Railway without a volume this file is wiped on redeploy.
 *
 * Kinds: 'signup' (landing-page lead), 'apply' (job application from /join) and
 * 'idea' (suggestion box on /about; the text is in `notes`).
 * Applications store their "What would you do at Korvo?" answer in `notes` and are
 * notified with a different email (see app.js, applyMessage), so the two kinds are
 * kept apart in listPending via the `kind` filter.
 *
 * Notification fields on every record:
 *   notifyStatus        'pending' | 'sent' | 'sent-fallback'   ('failed' = legacy, treated as pending)
 *   notifyError         last failure reason ('' once sent)
 *   notifyAttempts      number of send attempts so far
 *   notifyLastAttemptAt ISO time of the last attempt (null if none yet)
 *
 * Public async API:
 *   init(), create(lead), get(id), list({ notify }), setNotify(id, info),
 *   listPending({ maxAgeMs, limit, maxAttempts, kind }) -> [{ id, attempts }]
 */

const fs = require('fs');
const path = require('path');

const USE_PG = !!process.env.DATABASE_URL;
const PENDING = ['pending', 'failed'];

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function shape(input) {
  return {
    id: newId(),
    kind: input.kind || 'signup', // 'signup' (landing-page lead) or 'apply' (job application from /join)
    name: input.name || '',
    business: input.business || '',
    phone: input.phone || '',
    email: input.email || '',
    notes: input.notes || '', // job-application answer ("What would you do at Korvo?"); '' for signups
    resumeName: input.resumeName || '', // job applications: uploaded resume (base64 in resumeData)
    resumeType: input.resumeType || '',
    resumeData: input.resumeData || '',
    ip: input.ip || '',
    userAgent: input.userAgent || '',
    notifyStatus: 'pending',
    notifyError: '',
    notifyAttempts: 0,
    notifyLastAttemptAt: null,
    createdAt: new Date().toISOString(),
  };
}

// Lists stay light: the resume itself is only returned by get(id); hasResume says one exists.
const withoutBlob = ({ resumeData, ...r }) => ({ ...r, hasResume: !!resumeData });

/* ─────────────────────────── Postgres backend ─────────────────────────── */
function pgBackend() {
  const { Pool } = require('pg');
  function resolveSsl() {
    const mode = (process.env.PGSSL || '').toLowerCase();
    if (['disable', 'false', '0', 'off'].includes(mode)) return false;
    if (['require', 'true', '1', 'on'].includes(mode)) return { rejectUnauthorized: false };
    return /sslmode=(require|verify)/i.test(process.env.DATABASE_URL || '') ? { rejectUnauthorized: false } : false;
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: resolveSsl() });
  const iso = (d) => (d ? new Date(d).toISOString() : null);

  const toRecord = (r) => ({
    id: r.id, kind: r.kind || 'signup', name: r.name, business: r.business, phone: r.phone, email: r.email,
    notes: r.notes || '',
    resumeName: r.resume_name || '', resumeType: r.resume_type || '', resumeData: r.resume_data || '',
    ip: r.ip || '', userAgent: r.user_agent || '',
    notifyStatus: r.notify_status, notifyError: r.notify_error || '',
    notifyAttempts: r.notify_attempts || 0, notifyLastAttemptAt: iso(r.notify_last_attempt),
    createdAt: iso(r.created_at),
  });

  return {
    async init() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS signups (
          id            TEXT PRIMARY KEY,
          name          TEXT NOT NULL,
          business      TEXT NOT NULL,
          phone         TEXT NOT NULL,
          email         TEXT NOT NULL,
          ip            TEXT,
          user_agent    TEXT,
          notify_status TEXT NOT NULL DEFAULT 'pending',
          notify_error  TEXT,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);
      // Columns added Oct 2026 (background notifications); safe to re-run.
      await pool.query('ALTER TABLE signups ADD COLUMN IF NOT EXISTS notify_attempts INTEGER NOT NULL DEFAULT 0');
      await pool.query('ALTER TABLE signups ADD COLUMN IF NOT EXISTS notify_last_attempt TIMESTAMPTZ');
      // Columns added for /join job applications; safe to re-run.
      await pool.query(`ALTER TABLE signups ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'signup'`);
      await pool.query(`ALTER TABLE signups ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT ''`);
      // Resume upload on /join applications; safe to re-run.
      await pool.query(`ALTER TABLE signups ADD COLUMN IF NOT EXISTS resume_name TEXT NOT NULL DEFAULT ''`);
      await pool.query(`ALTER TABLE signups ADD COLUMN IF NOT EXISTS resume_type TEXT NOT NULL DEFAULT ''`);
      await pool.query(`ALTER TABLE signups ADD COLUMN IF NOT EXISTS resume_data TEXT NOT NULL DEFAULT ''`);
    },
    async create(input) {
      const rec = shape(input);
      await pool.query(
        `INSERT INTO signups (id, kind, name, business, phone, email, notes, resume_name, resume_type, resume_data, ip, user_agent, notify_status, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [rec.id, rec.kind, rec.name, rec.business, rec.phone, rec.email, rec.notes, rec.resumeName, rec.resumeType, rec.resumeData, rec.ip, rec.userAgent, rec.notifyStatus, rec.createdAt]
      );
      return rec;
    },
    async get(id) {
      const { rows } = await pool.query('SELECT * FROM signups WHERE id=$1', [id]);
      return rows[0] ? toRecord(rows[0]) : null;
    },
    async setNotify(id, info) {
      await pool.query(
        `UPDATE signups SET notify_status=$2, notify_error=$3, notify_attempts=$4, notify_last_attempt=$5 WHERE id=$1`,
        [id, info.status, info.error || null, info.attempts || 0, info.lastAttemptAt || null]
      );
    },
    async list({ notify } = {}) {
      const { rows } = notify === 'pending'
        ? await pool.query('SELECT * FROM signups WHERE notify_status = ANY($1) ORDER BY created_at DESC LIMIT 500', [PENDING])
        : await pool.query('SELECT * FROM signups ORDER BY created_at DESC LIMIT 500');
      return rows.map(toRecord).map(withoutBlob);
    },
    async listPending({ maxAgeMs, limit = 25, maxAttempts = null, kind = null } = {}) {
      const cutoff = new Date(Date.now() - (maxAgeMs || 7 * 864e5)).toISOString();
      const { rows } = await pool.query(
        `SELECT id, notify_attempts FROM signups
          WHERE notify_status = ANY($1) AND created_at > $2 AND ($3::int IS NULL OR notify_attempts < $3)
            AND ($4::text IS NULL OR kind = $4)
          ORDER BY created_at DESC LIMIT $5`,
        [PENDING, cutoff, maxAttempts, kind, limit]
      );
      return rows.map((r) => ({ id: r.id, attempts: r.notify_attempts || 0 }));
    },
  };
}

/* ─────────────────────────── JSON-file backend ─────────────────────────── */
function fileBackend() {
  const dir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  const file = path.join(dir, 'signups.json');
  const readAll = () => {
    try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).records || [] : []; }
    catch { return []; }
  };
  const writeAll = (records) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ records }, null, 2));
  };
  const withDefaults = (r) => Object.assign({ kind: 'signup', notes: '', resumeName: '', resumeType: '', resumeData: '', notifyAttempts: 0, notifyLastAttemptAt: null, notifyError: '' }, r);
  const newestFirst = (a, b) => (b.createdAt || '').localeCompare(a.createdAt || '');
  return {
    async init() { fs.mkdirSync(dir, { recursive: true }); if (!fs.existsSync(file)) writeAll([]); },
    async create(input) { const records = readAll(); const rec = shape(input); records.push(rec); writeAll(records); return rec; },
    async get(id) { const r = readAll().find((x) => x.id === id); return r ? withDefaults(r) : null; },
    async setNotify(id, info) {
      const records = readAll(); const r = records.find((x) => x.id === id);
      if (!r) return;
      r.notifyStatus = info.status; r.notifyError = info.error || '';
      r.notifyAttempts = info.attempts || 0; r.notifyLastAttemptAt = info.lastAttemptAt || null;
      writeAll(records);
    },
    async list({ notify } = {}) {
      return readAll().map(withDefaults).map(withoutBlob)
        .filter((r) => notify !== 'pending' || PENDING.includes(r.notifyStatus))
        .sort(newestFirst);
    },
    async listPending({ maxAgeMs, limit = 25, maxAttempts = null, kind = null } = {}) {
      const cutoff = new Date(Date.now() - (maxAgeMs || 7 * 864e5)).toISOString();
      return readAll().map(withDefaults)
        .filter((r) => PENDING.includes(r.notifyStatus) && (r.createdAt || '') > cutoff &&
          (maxAttempts == null || r.notifyAttempts < maxAttempts) &&
          (kind == null || (r.kind || 'signup') === kind))
        .sort(newestFirst).slice(0, limit)
        .map((r) => ({ id: r.id, attempts: r.notifyAttempts }));
    },
  };
}

const backend = USE_PG ? pgBackend() : fileBackend();
backend.usingPostgres = USE_PG;
module.exports = backend;

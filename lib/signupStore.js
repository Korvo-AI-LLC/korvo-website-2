/*
 * Signup (lead) storage for the korvo.ai #signup form.
 *
 * Every signup is saved BEFORE the notification email is sent, so a lead is never
 * lost to a mail outage. Same dual backend as discoveryStore / callStore:
 *   • Postgres  — when DATABASE_URL is set (table `signups`, created on boot).
 *   • JSON file — otherwise, at DATA_DIR/signups.json (defaults to ./data).
 *                 On Railway without a volume this file is wiped on redeploy.
 *
 * Public async API:
 *   init()                       -> prepare the backend
 *   create({name,business,phone,email,ip,userAgent}) -> saved record
 *   setNotify(id, status, error) -> record notification outcome ('sent'|'sent-fallback'|'failed')
 *   list()                       -> newest first
 */

const fs = require('fs');
const path = require('path');

const USE_PG = !!process.env.DATABASE_URL;

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function shape(input) {
  return {
    id: newId(),
    name: input.name || '',
    business: input.business || '',
    phone: input.phone || '',
    email: input.email || '',
    ip: input.ip || '',
    userAgent: input.userAgent || '',
    notifyStatus: 'pending',
    notifyError: '',
    createdAt: new Date().toISOString(),
  };
}

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

  const toRecord = (r) => ({
    id: r.id, name: r.name, business: r.business, phone: r.phone, email: r.email,
    ip: r.ip || '', userAgent: r.user_agent || '',
    notifyStatus: r.notify_status, notifyError: r.notify_error || '',
    createdAt: r.created_at && new Date(r.created_at).toISOString(),
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
    },
    async create(input) {
      const rec = shape(input);
      await pool.query(
        `INSERT INTO signups (id, name, business, phone, email, ip, user_agent, notify_status, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [rec.id, rec.name, rec.business, rec.phone, rec.email, rec.ip, rec.userAgent, rec.notifyStatus, rec.createdAt]
      );
      return rec;
    },
    async setNotify(id, status, error) {
      await pool.query('UPDATE signups SET notify_status=$2, notify_error=$3 WHERE id=$1', [id, status, error || null]);
    },
    async list() {
      const { rows } = await pool.query('SELECT * FROM signups ORDER BY created_at DESC LIMIT 500');
      return rows.map(toRecord);
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
  return {
    async init() { fs.mkdirSync(dir, { recursive: true }); if (!fs.existsSync(file)) writeAll([]); },
    async create(input) { const records = readAll(); const rec = shape(input); records.push(rec); writeAll(records); return rec; },
    async setNotify(id, status, error) {
      const records = readAll(); const r = records.find((x) => x.id === id);
      if (r) { r.notifyStatus = status; r.notifyError = error || ''; writeAll(records); }
    },
    async list() { return readAll().sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')); },
  };
}

const backend = USE_PG ? pgBackend() : fileBackend();
backend.usingPostgres = USE_PG;
module.exports = backend;

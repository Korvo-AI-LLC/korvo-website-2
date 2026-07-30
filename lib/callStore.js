/*
 * Patient-call storage (Trillet voice-agent calls).
 *
 * Same two-backend design as discoveryStore.js, chosen automatically:
 *   • Postgres  — used when DATABASE_URL is set (e.g. a Railway Postgres plugin).
 *                 the fields we surface live in columns, everything else is JSONB.
 *   • JSON file — fallback for local dev or a Railway volume. Set DATA_DIR to a
 *                 mounted volume path (e.g. /data) so records survive redeploys.
 *
 * Records land here from two sources that can describe the SAME call:
 *   • the Trillet post-call webhook (POST /api/calls)       -> source 'webhook'
 *   • a daily Gmail-parsing fallback that back-fills misses  -> source 'email'
 * create() therefore de-dupes on a normalised key (name|dob|appointment). If a
 * record with that key already exists it is MERGED (missing fields filled in,
 * earliest createdAt kept) instead of inserted, so the two paths never double up.
 *
 * Public async API:
 *   init()                 -> prepare the backend (create table if needed)
 *   list({ since })        -> [{ id, patientName, dob, appointmentAt, source, summary, createdAt, updatedAt }]
 *   get(id)                -> full record or null
 *   create(record)         -> saved record (created or merged)
 *   remove(id)             -> true/false
 *
 * A stored record:
 *   { id, patientName, dob, appointmentAt, source, dedupeKey,
 *     data:{ phone, reason, summary, transcript, raw, ... },
 *     createdAt, updatedAt }
 */

const fs = require('fs');
const path = require('path');

const USE_PG = !!process.env.DATABASE_URL;

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* Trillet's field names vary; accept the common spellings for each. */
function pick(obj, keys) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && String(obj[k]).trim() !== '') {
      return typeof obj[k] === 'string' ? obj[k].trim() : obj[k];
    }
  }
  return '';
}

function normalise(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function dedupeKeyFor(patientName, dob, appointmentAt) {
  return [normalise(patientName), normalise(dob), normalise(appointmentAt)].join('|');
}

/* normalise an incoming (possibly raw webhook) record into a stored record */
function shape(record) {
  const now = new Date().toISOString();
  const patientName   = record.patientName   || pick(record, ['name', 'patient_name', 'patientName', 'caller_name', 'callerName']);
  const dob           = record.dob           || pick(record, ['dob', 'date_of_birth', 'dateOfBirth', 'birthdate', 'birthDate']);
  const appointmentAt = record.appointmentAt || pick(record, ['appointment', 'appointment_time', 'appointmentAt', 'appointment_date', 'appointmentDate', 'appointment_datetime', 'booked_datetime', 'bookedDatetime', 'booked_date_time']);

  // Preserve any explicitly-passed data bag, then fold in recognised extras.
  const data = Object.assign({}, record.data);
  const phone      = data.phone      || pick(record, ['phone', 'callback', 'callback_number', 'callbackNumber', 'phone_number', 'phoneNumber']);
  const reason     = data.reason     || pick(record, ['reason', 'reason_for_visit', 'reasonForVisit', 'chief_complaint', 'chiefComplaint', 'visit_reason', 'visitReason']);
  const summary    = data.summary    || pick(record, ['summary', 'call_summary', 'callSummary', 'transcript_summary', 'transcriptSummary']);
  const transcript = data.transcript || pick(record, ['transcript', 'call_transcript', 'callTranscript']);
  const externalId = data.externalId || pick(record, ['callId', 'call_id', 'conversation_id', 'conversationId', 'id']);
  if (phone) data.phone = phone;
  if (reason) data.reason = reason;
  if (summary) data.summary = summary;
  if (transcript) data.transcript = transcript;
  if (externalId) data.externalId = externalId;

  // Optional extras Trillet may collect — surfaced in the record detail if present.
  for (const [key, aliases] of Object.entries({
    patientStatus:   ['patient_status', 'patientStatus'],
    appointmentType: ['appointment_type', 'appointmentType'],
    insurance:       ['insurance'],
    disposition:     ['call_disposition', 'callDisposition', 'disposition'],
    sentiment:       ['call_sentiment', 'callSentiment', 'sentiment'],
    needsFollowup:   ['needs_front_desk_followup', 'needsFrontDeskFollowup'],
    urgent:          ['urgent_issue_mentioned', 'urgentIssueMentioned'],
    voicemailLeft:   ['voicemail_left', 'voicemailLeft'],
    recordingUrl:    ['recording_url', 'recordingUrl'],
  })) {
    const v = data[key] || pick(record, aliases);
    if (v) data[key] = v;
  }
  // Keep the untouched original payload for auditing / re-parsing.
  if (record.raw !== undefined && data.raw === undefined) data.raw = record.raw;

  return {
    id: record.id || newId(),
    patientName,
    dob,
    appointmentAt,
    source: record.source || 'webhook',
    dedupeKey: dedupeKeyFor(patientName, dob, appointmentAt),
    data,
    createdAt: record.createdAt || now,
    updatedAt: now,
  };
}

/* Merge a fresh record onto an existing one: fill blanks, keep earliest createdAt. */
function merge(existing, incoming) {
  const data = Object.assign({}, existing.data);
  for (const [k, v] of Object.entries(incoming.data || {})) {
    if (data[k] === undefined || data[k] === '' || data[k] === null) data[k] = v;
  }
  return {
    id: existing.id,
    patientName: existing.patientName || incoming.patientName,
    dob: existing.dob || incoming.dob,
    appointmentAt: existing.appointmentAt || incoming.appointmentAt,
    // If both sources touched the call, note that.
    source: existing.source === incoming.source ? existing.source : 'webhook+email',
    dedupeKey: existing.dedupeKey,
    data,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  };
}

function summary(rec) {
  return {
    id: rec.id,
    patientName: rec.patientName || '',
    dob: rec.dob || '',
    appointmentAt: rec.appointmentAt || '',
    source: rec.source || '',
    summary: (rec.data && rec.data.summary) || '',
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
  };
}

/* ─────────────────────────── Postgres backend ─────────────────────────── */
function pgBackend() {
  const { Pool } = require('pg');

  // Mirror discoveryStore: honor PGSSL if set, otherwise enable SSL only when the
  // connection string asks for it (Railway's internal URL does not use SSL).
  function resolveSsl() {
    const mode = (process.env.PGSSL || '').toLowerCase();
    if (['disable', 'false', '0', 'off'].includes(mode)) return false;
    if (['require', 'true', '1', 'on'].includes(mode)) return { rejectUnauthorized: false };
    return /sslmode=(require|verify)/i.test(process.env.DATABASE_URL || '')
      ? { rejectUnauthorized: false }
      : false;
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: resolveSsl(),
  });

  function rowToRecord(r) {
    const data = r.data || {};
    return {
      id: r.id,
      patientName: r.patient_name || '',
      dob: r.dob || '',
      appointmentAt: r.appointment_at || '',
      source: r.source || '',
      dedupeKey: r.dedupe_key || '',
      data,
      createdAt: r.created_at && new Date(r.created_at).toISOString(),
      updatedAt: r.updated_at && new Date(r.updated_at).toISOString(),
    };
  }

  return {
    async init() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS patient_calls (
          id             TEXT PRIMARY KEY,
          patient_name   TEXT,
          dob            TEXT,
          appointment_at TEXT,
          source         TEXT,
          dedupe_key     TEXT,
          data           JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);
      await pool.query(
        `CREATE INDEX IF NOT EXISTS patient_calls_dedupe_key_idx ON patient_calls (dedupe_key);`
      );
    },
    async list(opts = {}) {
      const params = [];
      let where = '';
      if (opts.since) { params.push(opts.since); where = `WHERE created_at >= $1`; }
      const { rows } = await pool.query(
        `SELECT id, patient_name, dob, appointment_at, source, data, created_at, updated_at
           FROM patient_calls ${where} ORDER BY created_at DESC`,
        params
      );
      return rows.map((r) => summary(rowToRecord(r)));
    },
    async get(id) {
      const { rows } = await pool.query('SELECT * FROM patient_calls WHERE id=$1', [id]);
      return rows[0] ? rowToRecord(rows[0]) : null;
    },
    async findByDedupeKey(key) {
      if (!key || key === '||') return null;
      const { rows } = await pool.query(
        'SELECT * FROM patient_calls WHERE dedupe_key=$1 ORDER BY created_at ASC LIMIT 1',
        [key]
      );
      return rows[0] ? rowToRecord(rows[0]) : null;
    },
    async create(record) {
      const rec = shape(record);
      const existing = await this.findByDedupeKey(rec.dedupeKey);
      if (existing) {
        const m = merge(existing, rec);
        await pool.query(
          `UPDATE patient_calls
              SET patient_name=$2, dob=$3, appointment_at=$4, source=$5, data=$6, updated_at=$7
            WHERE id=$1`,
          [m.id, m.patientName, m.dob, m.appointmentAt, m.source, m.data, m.updatedAt]
        );
        return m;
      }
      await pool.query(
        `INSERT INTO patient_calls
           (id, patient_name, dob, appointment_at, source, dedupe_key, data, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [rec.id, rec.patientName, rec.dob, rec.appointmentAt, rec.source,
         rec.dedupeKey, rec.data, rec.createdAt, rec.updatedAt]
      );
      return rec;
    },
    async remove(id) {
      const { rowCount } = await pool.query('DELETE FROM patient_calls WHERE id=$1', [id]);
      return rowCount > 0;
    },
  };
}

/* ─────────────────────────── JSON-file backend ─────────────────────────── */
function fileBackend() {
  const dir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  const file = path.join(dir, 'calls.json');

  function readAll() {
    try {
      if (!fs.existsSync(file)) return [];
      return JSON.parse(fs.readFileSync(file, 'utf8')).records || [];
    } catch {
      return [];
    }
  }
  function writeAll(records) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ records }, null, 2));
  }

  return {
    async init() {
      fs.mkdirSync(dir, { recursive: true });
      if (!fs.existsSync(file)) writeAll([]);
    },
    async list(opts = {}) {
      let records = readAll();
      if (opts.since) records = records.filter((r) => (r.createdAt || '') >= opts.since);
      return records
        .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
        .map(summary);
    },
    async get(id) {
      return readAll().find((r) => r.id === id) || null;
    },
    async create(record) {
      const records = readAll();
      const rec = shape(record);
      if (rec.dedupeKey && rec.dedupeKey !== '||') {
        const i = records.findIndex((r) => r.dedupeKey === rec.dedupeKey);
        if (i !== -1) {
          const m = merge(records[i], rec);
          records[i] = m;
          writeAll(records);
          return m;
        }
      }
      records.push(rec);
      writeAll(records);
      return rec;
    },
    async remove(id) {
      const records = readAll();
      const next = records.filter((r) => r.id !== id);
      if (next.length === records.length) return false;
      writeAll(next);
      return true;
    },
  };
}

const backend = USE_PG ? pgBackend() : fileBackend();
backend.usingPostgres = USE_PG;

module.exports = backend;

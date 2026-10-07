/*
 * Discovery-call storage.
 *
 * Two backends, chosen automatically:
 *   • Postgres  — used when DATABASE_URL is set (e.g. a Railway Postgres plugin).
 *                 meta fields live in columns, the full answers object is JSONB.
 *   • JSON file — fallback for local dev or a Railway volume. Set DATA_DIR to a
 *                 mounted volume path (e.g. /data) so records survive redeploys.
 *
 * Public async API:
 *   init()            -> prepare the backend (create table if needed)
 *   list()            -> [{ id, practiceName, contactName, vertical, callDate, updatedAt }]
 *   get(id)           -> full record or null
 *   create(record)    -> saved record (with id/createdAt/updatedAt)
 *   update(id, record)-> saved record or null if not found
 *   remove(id)        -> true/false
 *
 * A "record" is the shape the intake form produces:
 *   { meta:{practiceName,contactName,vertical,verticalOther,callDate,interviewer},
 *     answers:{...}, schemaVersion, exportedAt }
 */

const fs = require('fs');
const path = require('path');

const USE_PG = !!process.env.DATABASE_URL;

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* normalise an incoming form record into a stored record */
function shape(record, existing) {
  const meta = record.meta || {};
  const now = new Date().toISOString();
  return {
    id: (existing && existing.id) || record.id || newId(),
    meta: {
      practiceName: meta.practiceName || '',
      contactName: meta.contactName || '',
      vertical: meta.vertical || '',
      verticalOther: meta.verticalOther || '',
      callDate: meta.callDate || '',
      interviewer: meta.interviewer || '',
    },
    // Keys starting with "_" (e.g. _source, _signup, _contact from the public intake) aren't
    // part of the SCHEMA, so the /admin editor never sends them back. Carry them over on
    // update so editing a record in /admin can't wipe the lead's contact details.
    answers: Object.assign(
      {},
      existing && existing.answers
        ? Object.fromEntries(Object.entries(existing.answers).filter(([k]) => k.startsWith('_')))
        : {},
      record.answers || {}
    ),
    schemaVersion: record.schemaVersion || 1,
    createdAt: (existing && existing.createdAt) || now,
    updatedAt: now,
  };
}

function summary(rec) {
  return {
    id: rec.id,
    practiceName: rec.meta.practiceName || '',
    contactName: rec.meta.contactName || '',
    vertical: rec.meta.vertical || '',
    callDate: rec.meta.callDate || '',
    updatedAt: rec.updatedAt,
  };
}

/* ─────────────────────────── Postgres backend ─────────────────────────── */
function pgBackend() {
  const { Pool } = require('pg');

  // Railway's default (internal) DATABASE_URL does not use SSL; managed external
  // URLs usually do. Auto-detect: honor PGSSL if set, otherwise enable SSL only
  // when the connection string asks for it (sslmode=require / verify-*).
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
      meta: {
        practiceName: r.practice_name || '',
        contactName: r.contact_name || '',
        vertical: r.vertical || '',
        verticalOther: (data.meta && data.meta.verticalOther) || '',
        callDate: r.call_date || '',
        interviewer: r.interviewer || '',
      },
      answers: data.answers || {},
      schemaVersion: data.schemaVersion || 1,
      createdAt: r.created_at && new Date(r.created_at).toISOString(),
      updatedAt: r.updated_at && new Date(r.updated_at).toISOString(),
    };
  }

  return {
    async init() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS discovery_calls (
          id            TEXT PRIMARY KEY,
          practice_name TEXT,
          contact_name  TEXT,
          vertical      TEXT,
          call_date     TEXT,
          interviewer   TEXT,
          data          JSONB NOT NULL,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      `);
    },
    async list() {
      const { rows } = await pool.query(
        `SELECT id, practice_name, contact_name, vertical, call_date, updated_at
           FROM discovery_calls ORDER BY updated_at DESC`
      );
      return rows.map((r) => ({
        id: r.id,
        practiceName: r.practice_name || '',
        contactName: r.contact_name || '',
        vertical: r.vertical || '',
        callDate: r.call_date || '',
        updatedAt: r.updated_at && new Date(r.updated_at).toISOString(),
      }));
    },
    async get(id) {
      const { rows } = await pool.query('SELECT * FROM discovery_calls WHERE id=$1', [id]);
      return rows[0] ? rowToRecord(rows[0]) : null;
    },
    async create(record) {
      const rec = shape(record);
      const data = { meta: { verticalOther: rec.meta.verticalOther }, answers: rec.answers, schemaVersion: rec.schemaVersion };
      await pool.query(
        `INSERT INTO discovery_calls
           (id, practice_name, contact_name, vertical, call_date, interviewer, data, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [rec.id, rec.meta.practiceName, rec.meta.contactName, rec.meta.vertical,
         rec.meta.callDate, rec.meta.interviewer, data, rec.createdAt, rec.updatedAt]
      );
      return rec;
    },
    async update(id, record) {
      const existing = await this.get(id);
      if (!existing) return null;
      const rec = shape(record, existing);
      const data = { meta: { verticalOther: rec.meta.verticalOther }, answers: rec.answers, schemaVersion: rec.schemaVersion };
      await pool.query(
        `UPDATE discovery_calls
            SET practice_name=$2, contact_name=$3, vertical=$4, call_date=$5,
                interviewer=$6, data=$7, updated_at=$8
          WHERE id=$1`,
        [id, rec.meta.practiceName, rec.meta.contactName, rec.meta.vertical,
         rec.meta.callDate, rec.meta.interviewer, data, rec.updatedAt]
      );
      return rec;
    },
    async remove(id) {
      const { rowCount } = await pool.query('DELETE FROM discovery_calls WHERE id=$1', [id]);
      return rowCount > 0;
    },
  };
}

/* ─────────────────────────── JSON-file backend ─────────────────────────── */
function fileBackend() {
  const dir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
  const file = path.join(dir, 'discovery.json');

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
    async list() {
      return readAll()
        .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
        .map(summary);
    },
    async get(id) {
      return readAll().find((r) => r.id === id) || null;
    },
    async create(record) {
      const records = readAll();
      const rec = shape(record);
      records.push(rec);
      writeAll(records);
      return rec;
    },
    async update(id, record) {
      const records = readAll();
      const i = records.findIndex((r) => r.id === id);
      if (i === -1) return null;
      const rec = shape(record, records[i]);
      records[i] = rec;
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

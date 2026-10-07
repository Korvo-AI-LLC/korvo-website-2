/*
 * The discovery-intake SCHEMA, shared by /admin, /intake and the signup modal.
 *
 * Single source of truth: the `const SCHEMA = [...]` block inside public/admin.html.
 * admin.html is deliberately left untouched; this module reads that block at boot and
 * evaluates it in an empty sandbox. It is our own repo file, not user input.
 * If someone edits the schema in admin.html, the public intake follows automatically.
 *
 * Exports:
 *   schema, version, fieldCount, metaIds
 *   sanitize(body)      -> { meta, answers } containing ONLY schema fields, type-checked + length-capped
 *   toText(record, ctx) -> plain-text rendering of every field, for the notification email
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function load() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');
  const start = html.indexOf('const SCHEMA = [');
  const end = html.indexOf('const SCHEMA_VERSION', start);
  if (start < 0 || end < 0) throw new Error('SCHEMA block not found in public/admin.html');
  const ctx = {};
  vm.runInNewContext(html.slice(start, end).replace('const SCHEMA =', 'SCHEMA ='), ctx, { timeout: 1000 });
  const schema = ctx.SCHEMA;
  if (!Array.isArray(schema) || !schema.every((s) => s && s.id && Array.isArray(s.fields))) {
    throw new Error('SCHEMA in admin.html has an unexpected shape');
  }
  const vm2 = html.slice(end, end + 80).match(/SCHEMA_VERSION\s*=\s*(\d+)/);
  return { schema: JSON.parse(JSON.stringify(schema)), version: vm2 ? Number(vm2[1]) : 1 };
}

const { schema, version } = load();
const fields = schema.flatMap((s) => s.fields);
const metaIds = (schema.find((s) => s.id === 'meta') || { fields: [] }).fields.map((f) => f.id);

const str = (v, max) => (v == null ? '' : String(v)).slice(0, max).trim();

function sanitizeValue(f, v) {
  switch (f.type) {
    case 'check':
      return v === true || v === 'true' || v === 'yes';
    case 'checkgroup':
      return Array.isArray(v) ? v.map(String).filter((o) => f.options.includes(o)) : [];
    case 'select':
    case 'radio':
      return f.options.includes(String(v)) ? String(v) : '';
    case 'number':
      return str(v, 30);
    case 'repeater':
      return (Array.isArray(v) ? v : []).slice(0, 40).map((r) => ({
        name: str(r && r.name, 200),
        length: str(r && r.length, 100),
        aiBookable: !!(r && r.aiBookable),
      })).filter((r) => r.name || r.length);
    default: // text, date, textarea
      return str(v, f.type === 'textarea' ? 4000 : 400);
  }
}

function sanitize(body) {
  const inMeta = (body && body.meta) || {};
  const inAns = (body && body.answers) || {};
  const meta = {};
  const answers = {};
  fields.forEach((f) => {
    if (metaIds.includes(f.id)) meta[f.id] = sanitizeValue(f, inMeta[f.id]);
    else answers[f.id] = sanitizeValue(f, inAns[f.id]);
  });
  return { meta, answers };
}

function fmt(f, v) {
  if (f.type === 'check') return v ? 'Yes' : '—';
  if (f.type === 'checkgroup') return v && v.length ? v.join(', ') : '—';
  if (f.type === 'repeater') {
    if (!v || !v.length) return '—';
    return '\n' + v.map((r) => `    - ${r.name || '(unnamed)'}${r.length ? ` — ${r.length}` : ''}${r.aiBookable ? '  [AI may book]' : '  [human callback]'}`).join('\n');
  }
  return v === '' || v == null ? '—' : String(v);
}

function toText(record) {
  const lines = [];
  schema.forEach((sec) => {
    lines.push('', `== ${sec.num && sec.num !== '\u00b7' ? sec.num + '. ' : ''}${sec.title} ==`);
    sec.fields.forEach((f) => {
      const v = metaIds.includes(f.id) ? record.meta[f.id] : record.answers[f.id];
      lines.push(`${f.label}: ${fmt(f, v)}`); // every field, blanks shown as —
    });
  });
  return lines.join('\n');
}

module.exports = { schema, version, fieldCount: fields.length, metaIds, sanitize, toText };

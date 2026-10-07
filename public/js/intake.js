/*
 * Korvo public discovery intake — one section at a time.
 *
 * Renders window.KORVO_INTAKE.schema, which the server generates from the SCHEMA in
 * /admin (public/admin.html), so all 10 sections / 59 fields always match the internal
 * intake. Submits to POST /api/discovery (the public, rate-limited path).
 *
 * Used by the signup modal (index.html) and the /intake page:
 *   KorvoIntake.mount(container, {
 *     signup:   { id, name, business, phone, email } | null, // prefill + link to the signup lead
 *     showPay:  true|false,   // offer the payment link on the finish screen
 *     onDone:   function(result) {}
 *   })
 */
(function () {
  'use strict';

  var DRAFT_KEY = 'korvoIntakeDraft:v1';

  // Customer-facing wording for the few admin strings written for an interviewer
  // (e.g. "Interviewer: Jack", "say it out loud and lock it", podiatry-only defaults).
  // Field ids, types and options are untouched, so records look identical in /admin.
  // Delete an entry to show the /admin wording verbatim.
  var PUBLIC_COPY = {
    sections: {
      meta:       { title: 'About your practice', sub: 'Who we’re building for.' },
      baseline:   { sub: 'Rough guesses are fine. This is how we’ll measure whether it’s working.' },
      scheduling: { sub: 'The exact name of your scheduling software decides how we connect to it.' },
      setup:      { sub: 'The things that can slow setup down.' }
    },
    fields: {
      contactName:    { label: 'Your name and role' },
      vertical:       { label: 'Type of practice', placeholder: 'Choose one', default: '' },
      callDate:       { label: 'Today’s date' },
      interviewer:    { label: 'Filled in by', default: 'Self-serve (korvo.ai)', readonly: true },
      successMetric:  { label: 'What would make this a clear win for you?', default: '' },
      recordCalls:    { hint: 'Recordings let you (and us) check exactly how calls went.' },
      sendRequestsTo: { label: 'Where should call summaries go? (email)', default: '' },
      morningRoutine: { default: '' },
      nextSteps:      { label: 'Anything else we should know?' },
      appointmentTypes: { default: [
        { name: 'New patient', length: '', aiBookable: true },
        { name: 'Follow-up', length: '', aiBookable: true }
      ] }
    }
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function store(fn) { try { return fn(); } catch (_) { return null; } }
  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function buildSchema() {
    var raw = (window.KORVO_INTAKE && window.KORVO_INTAKE.schema) || [];
    return raw.map(function (sec) {
      var so = PUBLIC_COPY.sections[sec.id] || {};
      return {
        id: sec.id, num: sec.num, title: so.title || sec.title, sub: so.sub !== undefined ? so.sub : sec.sub,
        fields: sec.fields.map(function (f) {
          var o = PUBLIC_COPY.fields[f.id] || {};
          var g = {};
          Object.keys(f).forEach(function (k) { g[k] = f[k]; });
          Object.keys(o).forEach(function (k) { g[k] = o[k]; });
          return g;
        })
      };
    });
  }

  function mount(container, opts) {
    opts = opts || {};
    var SCHEMA = buildSchema();
    if (!SCHEMA.length) {
      container.innerHTML = '<p class="ki-msg">The intake form didn’t load. Refresh the page, or email hello@korvo.ai.</p>';
      return;
    }
    var META_IDS = SCHEMA[0].id === 'meta' ? SCHEMA[0].fields.map(function (f) { return f.id; }) : [];
    var FIELDS = {};
    SCHEMA.forEach(function (s) { s.fields.forEach(function (f) { FIELDS[f.id] = f; }); });
    var signup = opts.signup && opts.signup.email ? opts.signup : null;
    var needContact = !signup;
    var step = 0;
    var uid = 'ki' + Math.random().toString(36).slice(2, 7);

    container.classList.add('ki');
    container.innerHTML =
      '<div class="ki-progress"><span class="ki-count"></span><div class="ki-bar" role="progressbar" aria-valuemin="1" aria-valuemax="' + SCHEMA.length + '"><span></span></div></div>' +
      '<form novalidate class="ki-form">' +
        SCHEMA.map(function (sec, i) {
          return '<section class="ki-step" data-step="' + i + '"' + (i ? ' hidden' : '') + '>' +
            '<p class="ki-step-num">' + esc(sec.num === '·' ? 'Start' : sec.num) + '</p>' +
            '<h3 tabindex="-1">' + esc(sec.title) + '</h3>' +
            (sec.sub ? '<p class="ki-step-sub">' + esc(sec.sub) + '</p>' : '') +
            '<div class="ki-fields">' + sec.fields.map(renderField).join('') + '</div>' +
            (i === 0 && needContact ? contactBlock() : '') +
          '</section>';
        }).join('') +
        '<div class="ki-trap" aria-hidden="true"><label for="' + uid + '-hp">Fax</label><input id="' + uid + '-hp" name="hp" type="text" tabindex="-1" autocomplete="off"></div>' +
        '<p class="ki-msg" role="alert"></p>' +
        '<div class="ki-nav"><button type="button" class="ki-btn ki-btn-ghost ki-back">Back</button>' +
          '<span class="ki-saved" aria-live="polite"></span>' +
          '<button type="submit" class="ki-btn ki-btn-primary ki-next">Next</button></div>' +
      '</form>';

    var form = container.querySelector('.ki-form');
    var msg = container.querySelector('.ki-msg');
    var back = container.querySelector('.ki-back');
    var next = container.querySelector('.ki-next');
    var saved = container.querySelector('.ki-saved');

    // Repeaters start with their default rows
    SCHEMA.forEach(function (s) { s.fields.forEach(function (f) {
      if (f.type === 'repeater') (f.default || []).forEach(function (r) { addRow(f, r); });
    }); });

    // Prefill: today's date, plus what we already know from the signup form
    setField(FIELDS.callDate, today());
    if (signup) {
      setField(FIELDS.practiceName, signup.business);
      setField(FIELDS.contactName, signup.name);
      setField(FIELDS.sendRequestsTo, signup.email);
    }

    // Resume a saved draft from this browser
    var draft = store(function () { return JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); });
    if (draft && draft.meta) {
      hydrate(draft);
      step = Math.min(Math.max(+draft.step || 0, 0), SCHEMA.length - 1);
    }
    updateReveals();
    show(step, false);

    function q(sel) { return container.querySelector(sel); }
    function fid(id) { return uid + '-' + id; }

    function renderField(f) {
      var id = fid(f.id);
      var hint = f.hint ? '<span class="ki-hint" id="' + id + '-h">' + esc(f.hint) + '</span>' : '';
      var desc = f.hint ? ' aria-describedby="' + id + '-h"' : '';
      var rev = f.revealedBy ? ' data-reveal="' + f.id + '" hidden' : '';
      var def = f.default;
      var inner;
      if (f.type === 'radio' || f.type === 'checkgroup') {
        var kind = f.type === 'radio' ? 'radio' : 'checkbox';
        inner = '<div class="ki-opts" data-field="' + f.id + '">' + f.options.map(function (o) {
          var on = f.type === 'checkgroup' && Array.isArray(def) && def.indexOf(o) > -1;
          return '<label class="ki-opt"><input type="' + kind + '" name="' + id + '" value="' + esc(o) + '"' + (on ? ' checked' : '') + '><span>' + esc(o) + '</span></label>';
        }).join('') + '</div>';
        return '<fieldset class="ki-field"' + rev + '><legend>' + esc(f.label) + '</legend>' + hint + inner + '</fieldset>';
      }
      if (f.type === 'check') {
        return '<div class="ki-field"' + rev + '>' + hint + '<label class="ki-opt ki-wide"><input type="checkbox" data-field="' + f.id + '" id="' + id + '"' + desc + '><span>' + esc(f.label) + '</span></label></div>';
      }
      if (f.type === 'repeater') {
        return '<fieldset class="ki-field"' + rev + '><legend>' + esc(f.label) + '</legend>' + hint +
          '<div class="ki-rep" data-field="' + f.id + '"></div>' +
          '<button type="button" class="ki-link ki-add" data-rep="' + f.id + '">+ Add another</button></fieldset>';
      }
      if (f.type === 'textarea') {
        inner = '<textarea id="' + id + '" data-field="' + f.id + '"' + desc + (f.placeholder ? ' placeholder="' + esc(f.placeholder) + '"' : '') + '>' + esc(def || '') + '</textarea>';
      } else if (f.type === 'select') {
        inner = '<select id="' + id + '" data-field="' + f.id + '"' + desc + '>' +
          (f.placeholder ? '<option value="">' + esc(f.placeholder) + '</option>' : '') +
          f.options.map(function (o) { return '<option value="' + esc(o) + '"' + (def === o ? ' selected' : '') + '>' + esc(o) + '</option>'; }).join('') + '</select>';
      } else if (f.type === 'number') {
        inner = '<div class="ki-affix">' + (f.prefix ? '<span>' + esc(f.prefix) + '</span>' : '') +
          '<input type="number" inputmode="decimal" min="0" id="' + id + '" data-field="' + f.id + '"' + desc + '>' +
          (f.suffix ? '<span>' + esc(f.suffix) + '</span>' : '') + '</div>';
      } else {
        inner = '<input type="' + (f.type === 'date' ? 'date' : 'text') + '" id="' + id + '" data-field="' + f.id + '"' + desc +
          (f.placeholder ? ' placeholder="' + esc(f.placeholder) + '"' : '') + ' value="' + esc(def || '') + '"' + (f.readonly ? ' readonly' : '') + '>';
      }
      return '<div class="ki-field"' + rev + '><label for="' + id + '">' + esc(f.label) + '</label>' + hint + inner + '</div>';
    }

    function contactBlock() {
      return '<div class="ki-contact"><p>How do we reach you?</p><div class="ki-two">' +
        '<div class="ki-field"><label for="' + fid('_phone') + '">Phone</label><input type="tel" id="' + fid('_phone') + '" data-contact="phone" autocomplete="tel" maxlength="40"></div>' +
        '<div class="ki-field"><label for="' + fid('_email') + '">Email</label><input type="email" id="' + fid('_email') + '" data-contact="email" autocomplete="email" maxlength="200"></div>' +
        '</div></div>';
    }

    function addRow(f, r) {
      r = r || {};
      var box = q('.ki-rep[data-field="' + f.id + '"]');
      var c = f.columns;
      var row = document.createElement('div');
      row.className = 'ki-rep-row';
      row.innerHTML =
        '<input type="text" data-col="' + c[0].key + '" aria-label="' + esc(c[0].ph) + '" placeholder="' + esc(c[0].ph) + '" value="' + esc(r[c[0].key] || '') + '">' +
        '<input type="text" data-col="' + c[1].key + '" aria-label="' + esc(c[1].ph) + '" placeholder="' + esc(c[1].ph) + '" value="' + esc(r[c[1].key] || '') + '">' +
        '<label class="ki-opt"><input type="checkbox" data-col="' + c[2].key + '"' + (r[c[2].key] ? ' checked' : '') + '><span>' + esc(c[2].ph) + '</span></label>' +
        '<button type="button" class="ki-icon ki-del" aria-label="Remove this row">&times;</button>';
      box.appendChild(row);
    }

    function node(f) { return q('[data-field="' + f.id + '"]'); }

    function readField(f) {
      var n = node(f);
      if (!n) return null;
      if (f.type === 'radio') { var c = n.querySelector('input:checked'); return c ? c.value : ''; }
      if (f.type === 'checkgroup') return [].map.call(n.querySelectorAll('input:checked'), function (i) { return i.value; });
      if (f.type === 'check') return !!n.checked;
      if (f.type === 'repeater') {
        return [].map.call(n.querySelectorAll('.ki-rep-row'), function (row) {
          var o = {};
          f.columns.forEach(function (c) {
            var i = row.querySelector('[data-col="' + c.key + '"]');
            o[c.key] = c.type === 'check' ? i.checked : i.value.trim();
          });
          return o;
        }).filter(function (o) { return o.name || o.length; });
      }
      return n.value;
    }

    function setField(f, v) {
      var n = f && node(f);
      if (!n || v === undefined || v === null) return;
      if (f.type === 'radio') { [].forEach.call(n.querySelectorAll('input'), function (i) { i.checked = i.value === v; }); return; }
      if (f.type === 'checkgroup') { [].forEach.call(n.querySelectorAll('input'), function (i) { i.checked = Array.isArray(v) && v.indexOf(i.value) > -1; }); return; }
      if (f.type === 'check') { n.checked = !!v; return; }
      if (f.type === 'repeater') { n.innerHTML = ''; (Array.isArray(v) ? v : []).forEach(function (r) { addRow(f, r); }); return; }
      if (f.readonly) return;
      n.value = v;
    }

    function collect() {
      var meta = {}, answers = {};
      SCHEMA.forEach(function (s) { s.fields.forEach(function (f) {
        var v = readField(f);
        if (META_IDS.indexOf(f.id) > -1) meta[f.id] = v; else answers[f.id] = v;
      }); });
      return { meta: meta, answers: answers };
    }

    function contact() {
      var p = q('[data-contact="phone"]'), e = q('[data-contact="email"]');
      return { phone: p ? p.value.trim() : '', email: e ? e.value.trim() : '' };
    }

    function hydrate(d) {
      SCHEMA.forEach(function (s) { s.fields.forEach(function (f) {
        var v = META_IDS.indexOf(f.id) > -1 ? (d.meta || {})[f.id] : (d.answers || {})[f.id];
        if (v !== undefined) setField(f, v);
      }); });
      if (d.contact) {
        var p = q('[data-contact="phone"]'), e = q('[data-contact="email"]');
        if (p && d.contact.phone) p.value = d.contact.phone;
        if (e && d.contact.email) e.value = d.contact.email;
      }
    }

    function isActive(f) {
      var r = f.revealedBy;
      if (!r) return true;
      var v = readField(FIELDS[r.field]);
      if (r.equals !== undefined) return v === r.equals;
      if (r.includes !== undefined) return Array.isArray(v) && v.indexOf(r.includes) > -1;
      return true;
    }
    function updateReveals() {
      [].forEach.call(container.querySelectorAll('[data-reveal]'), function (box) {
        box.hidden = !isActive(FIELDS[box.getAttribute('data-reveal')]);
      });
    }

    var saveT;
    function saveDraft() {
      clearTimeout(saveT);
      saveT = setTimeout(function () {
        var d = collect(); d.contact = contact(); d.step = step;
        if (store(function () { localStorage.setItem(DRAFT_KEY, JSON.stringify(d)); return true; })) saved.textContent = 'Saved on this device';
      }, 400);
    }

    function show(i, focus) {
      step = i;
      [].forEach.call(container.querySelectorAll('.ki-step'), function (s) { s.hidden = +s.getAttribute('data-step') !== i; });
      q('.ki-count').textContent = 'Section ' + (i + 1) + ' of ' + SCHEMA.length;
      var bar = q('.ki-bar');
      bar.setAttribute('aria-valuenow', i + 1);
      bar.setAttribute('aria-label', 'Section ' + (i + 1) + ' of ' + SCHEMA.length);
      bar.firstChild.style.width = Math.round(((i + 1) / SCHEMA.length) * 100) + '%';
      back.hidden = i === 0;
      next.textContent = i === SCHEMA.length - 1 ? 'Send my answers' : 'Next';
      msg.textContent = '';
      msg.className = 'ki-msg';
      if (focus !== false) {
        var h = q('.ki-step[data-step="' + i + '"] h3');
        if (h) h.focus();
        var scroller = container.closest('.modal-body');
        if (scroller) scroller.scrollTop = 0; else container.scrollIntoView({ block: 'start' });
      }
    }

    function checkFirstStep() {
      var m = collect().meta, c = contact();
      if (!String(m.practiceName || '').trim()) return ['practiceName', 'Add your practice name.'];
      if (!String(m.contactName || '').trim()) return ['contactName', 'Add your name.'];
      if (needContact) {
        if (c.phone.replace(/\D/g, '').length < 7) return ['_phone', 'Add a phone number so we can reach you.'];
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(c.email)) return ['_email', 'Add a valid email so we can reach you.'];
      }
      return null;
    }

    container.addEventListener('click', function (e) {
      var add = e.target.closest('.ki-add');
      if (add) { addRow(FIELDS[add.getAttribute('data-rep')], {}); saveDraft(); return; }
      var del = e.target.closest('.ki-del');
      if (del) { del.closest('.ki-rep-row').remove(); saveDraft(); }
    });
    container.addEventListener('input', function () { updateReveals(); saveDraft(); });
    container.addEventListener('change', function () { updateReveals(); saveDraft(); });
    back.addEventListener('click', function () { if (step > 0) { show(step - 1); saveDraft(); } });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (step === 0) {
        var bad = checkFirstStep();
        if (bad) {
          msg.textContent = bad[1];
          var el = document.getElementById(fid(bad[0]));
          if (el) el.focus();
          return;
        }
      }
      if (step < SCHEMA.length - 1) { show(step + 1); saveDraft(); return; }
      submit();
    });

    function submit() {
      var data = collect();
      var payload = {
        meta: data.meta,
        answers: data.answers,
        schemaVersion: (window.KORVO_INTAKE && window.KORVO_INTAKE.version) || 1,
        exportedAt: new Date().toISOString(),
        signup: signup || null,
        contact: needContact ? contact() : null,
        hp: q('[name="hp"]').value
      };
      next.disabled = true; back.disabled = true;
      next.textContent = 'Sending…';
      msg.className = 'ki-msg';
      msg.textContent = '';
      fetch('/api/discovery', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
        .then(function (res) { return res.json().catch(function () { return {}; }).then(function (d) { return { status: res.status, ok: res.ok, data: d }; }); })
        .then(function (r) {
          if (r.ok && r.data.success) return finish({ ok: true });
          if (r.data && r.data.saved) return finish({ ok: true, warning: r.data.error });
          fail((r.data && r.data.error) || 'That didn’t go through. Try again, or email hello@korvo.ai.');
        })
        .catch(function () { fail('Couldn’t reach our server. Your answers are saved on this device. Try again in a minute.'); });
    }

    function fail(text) {
      msg.className = 'ki-msg';
      msg.textContent = text;
      next.disabled = false; back.disabled = false;
      next.textContent = 'Send my answers';
    }

    function finish(result) {
      store(function () { localStorage.removeItem(DRAFT_KEY); });
      var payReady = typeof PAYMENT_URL === 'string' && /^https:\/\//i.test(PAYMENT_URL.trim());
      container.innerHTML =
        '<div class="ki-done">' +
          '<p class="ki-step-num">Done</p>' +
          '<h3 tabindex="-1">That’s everything we need to build your agent.</h3>' +
          '<p>We’ll call you tomorrow to record your greeting together. Questions before then: hello@korvo.ai.</p>' +
          (result.warning ? '<p class="ki-note">' + esc(result.warning) + '</p>' : '') +
          (opts.showPay ?
            '<p>Last step: payment, so we can start your setup.</p>' +
            '<a class="ki-btn ki-btn-pine ki-pay" href="' + (payReady ? esc(PAYMENT_URL.trim()) : '#') + '">Pay $997/month</a>' +
            '<p class="ki-note ki-pay-note" hidden>Online checkout isn’t switched on yet. We’ll email you a secure checkout link.</p>'
            : '') +
        '</div>';
      var payBtn = container.querySelector('.ki-pay');
      if (payBtn && !payReady) {
        payBtn.addEventListener('click', function (e) { e.preventDefault(); container.querySelector('.ki-pay-note').hidden = false; });
      }
      var h = container.querySelector('h3');
      if (h) h.focus();
      if (typeof opts.onDone === 'function') opts.onDone(result);
    }
  }

  window.KorvoIntake = { mount: mount };
})();

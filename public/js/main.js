/* ── NAV scroll ────────────────────────────────── */
const nav = document.querySelector('nav');
const scrollTopBtn = document.querySelector('.scroll-top');

window.addEventListener('scroll', () => {
  if (window.scrollY > 40) {
    nav?.classList.add('scrolled');
    scrollTopBtn?.classList.add('visible');
  } else {
    nav?.classList.remove('scrolled');
    scrollTopBtn?.classList.remove('visible');
  }
});

scrollTopBtn?.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));

/* ── Mobile hamburger ──────────────────────────── */
const hamburger = document.querySelector('.hamburger');
const mobileNav = document.querySelector('.mobile-nav');

hamburger?.addEventListener('click', () => {
  mobileNav.classList.toggle('open');
});

document.querySelectorAll('.mobile-nav a').forEach(a =>
  a.addEventListener('click', () => mobileNav.classList.remove('open'))
);

/* ── FAQ accordion ─────────────────────────────── */
document.querySelectorAll('.faq-item').forEach(item => {
  item.querySelector('.faq-question')?.addEventListener('click', () => {
    const isOpen = item.classList.contains('open');
    document.querySelectorAll('.faq-item').forEach(i => i.classList.remove('open'));
    if (!isOpen) item.classList.add('open');
  });
});

/* ── Contact / book form ───────────────────────── */
const contactForm = document.getElementById('contactForm');
contactForm?.addEventListener('submit', async e => {
  e.preventDefault();
  const btn = contactForm.querySelector('button[type="submit"]');
  const msg = document.getElementById('formMsg');
  btn.disabled = true;
  btn.textContent = 'Sending…';
  msg.className = 'form-msg';

  try {
    const res = await fetch('/api/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.fromEntries(new FormData(contactForm))),
    });
    const data = await res.json();
    if (res.ok) {
      msg.textContent = data.message;
      msg.classList.add('success');
      contactForm.reset();
    } else {
      msg.textContent = data.error || 'Something went wrong.';
      msg.classList.add('error');
    }
  } catch {
    msg.textContent = 'Could not connect. Please email jack@korvo.ai directly.';
    msg.classList.add('error');
  }

  btn.disabled = false;
  btn.textContent = 'Send Message';
});

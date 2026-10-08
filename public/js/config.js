/* =====================================================================
   KORVO SITE CONFIG
   The one place to change site-wide settings. Loaded by index.html and intake.html.
   ===================================================================== */

// ┌───────────────────────────────────────────────────────────────────┐
// │ PAYMENT_URL — LIVE Stripe Payment Link (live mode, not test).     │
// │ Product: "Korvo AI — After-Hours Voice Agent", $997/mo.           │
// │ The homepage "Pay $997/month" button links here after the 4-field │
// │ capture. index.html also holds this link as the button's static   │
// │ href (fallback if this file fails to load). Change both together. │
// └───────────────────────────────────────────────────────────────────┘
const PAYMENT_URL = 'https://buy.stripe.com/6oU14m4QNgaObDEh1B08g00';

// Full intake opens after payment. Stripe's after-payment redirect must be
// https://korvo.ai/?paid=1.
// That URL reopens the modal straight into the intake (prefilled when available).
const INTAKE_AFTER = 'payment';

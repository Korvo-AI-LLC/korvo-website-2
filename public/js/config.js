/* =====================================================================
   KORVO SITE CONFIG
   The one place to change site-wide settings. Loaded by index.html and intake.html.
   ===================================================================== */

// ┌───────────────────────────────────────────────────────────────────┐
// │ PAYMENT_URL — LIVE Stripe Payment Link (live mode, not test).     │
// │ Product: "Korvo AI — After-Hours Voice Agent", $997/mo.           │
// │ Setting this back to '#' makes the "Pay" button show a fallback   │
// │ note instead of sending visitors anywhere.                        │
// └───────────────────────────────────────────────────────────────────┘
const PAYMENT_URL = 'https://buy.stripe.com/6oU14m4QNgaObDEh1B08g00';

// Full intake opens after payment. To enable checkout, replace PAYMENT_URL above
// and set Stripe's after-payment redirect to https://korvo.ai/?paid=1.
// That URL reopens the modal straight into the intake (prefilled when available).
const INTAKE_AFTER = 'payment';

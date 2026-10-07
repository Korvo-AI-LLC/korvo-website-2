/* =====================================================================
   KORVO SITE CONFIG
   The one place to change site-wide settings. Loaded by index.html and intake.html.
   ===================================================================== */

// ┌───────────────────────────────────────────────────────────────────┐
// │ PAYMENT_URL — PLACEHOLDER. NOT LIVE YET.                          │
// │ Replace '#' with the live Stripe Payment Link for the $997/mo     │
// │ plan, e.g. 'https://buy.stripe.com/xxxxxxxx'. One-line change.    │
// │ While it is '#', the "Pay" button shows a fallback note instead   │
// │ of sending visitors anywhere.                                     │
// └───────────────────────────────────────────────────────────────────┘
const PAYMENT_URL = '#';

// Full intake opens after payment. To enable checkout, replace PAYMENT_URL above
// and set Stripe's after-payment redirect to https://korvo.ai/?paid=1.
// That URL reopens the modal straight into the intake (prefilled when available).
const INTAKE_AFTER = 'payment';

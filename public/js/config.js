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

// ┌───────────────────────────────────────────────────────────────────┐
// │ INTAKE_AFTER — when the full discovery intake opens.              │
// │   'signup'  (now): right after the 4-field signup form succeeds.  │
// │   'payment' (once Stripe is live): after a successful payment.    │
// │ To switch, change 'signup' to 'payment' on the line below, and in │
// │ Stripe set the Payment Link's "after payment" redirect to:        │
// │     https://korvo.ai/?paid=1                                      │
// │ That URL reopens the modal straight into the intake.              │
// └───────────────────────────────────────────────────────────────────┘
const INTAKE_AFTER = 'signup';

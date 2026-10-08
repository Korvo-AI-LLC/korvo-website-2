/* =====================================================================
   KORVO SITE CONFIG
   The one place to change site-wide settings. Loaded by index.html and intake.html.
   ===================================================================== */

// ┌───────────────────────────────────────────────────────────────────┐
// │ PAYMENT_URL — LIVE Stripe Payment Link (live mode, not test).     │
// │ Product: "Korvo AI — After-Hours Voice Agent", $997/mo.           │
// │ FALLBACK ONLY: payment normally happens in Stripe Embedded        │
// │ Checkout inside the signup dialog. This link is shown only if the │
// │ embedded form can't load. index.html also holds it as the static  │
// │ href (if this file fails to load). Change both together.          │
// └───────────────────────────────────────────────────────────────────┘
const PAYMENT_URL = 'https://buy.stripe.com/6oU14m4QNgaObDEh1B08g00';

// Stripe LIVE publishable key (pk_live_...) for Embedded Checkout. Publishable keys are
// meant to be public. Leave '' to use STRIPE_PUBLISHABLE_KEY from the server environment
// (returned by POST /api/create-checkout-session). If neither is set, the Pay link above is used.
const STRIPE_PUBLISHABLE_KEY = '';

// Full intake opens after payment. Stripe's after-payment redirect must be
// https://korvo.ai/?paid=1.
// That URL reopens the modal straight into the intake (prefilled when available).
const INTAKE_AFTER = 'payment';

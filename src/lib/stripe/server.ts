import Stripe from 'stripe';

let stripeInstance: Stripe | null = null;

export function getStripeServerClient(): Stripe {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY is not set');
  }

  if (!stripeInstance) {
    stripeInstance = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: '2026-02-25.clover',
    });
  }

  return stripeInstance;
}

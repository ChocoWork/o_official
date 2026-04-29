-- Migration 026: Add checkout_session_id to orders for Stripe Checkout Session deduplication
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS checkout_session_id TEXT UNIQUE;

CREATE INDEX IF NOT EXISTS idx_orders_checkout_session_id ON orders(checkout_session_id);

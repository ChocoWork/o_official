-- ============================================================
-- 089: Stripe accounting source records and payout settlement
-- ============================================================

BEGIN;

CREATE TABLE public.stripe_balance_transactions (
  id text PRIMARY KEY,
  source_id text NOT NULL,
  payment_intent_id text,
  order_id uuid REFERENCES public.orders(id) ON DELETE RESTRICT,
  payout_id text,
  type text NOT NULL,
  reporting_category text NOT NULL,
  amount integer NOT NULL,
  fee integer NOT NULL,
  net integer NOT NULL,
  currency text NOT NULL,
  status text NOT NULL,
  available_on timestamptz,
  stripe_created_at timestamptz NOT NULL,
  fee_details jsonb NOT NULL DEFAULT '[]'::jsonb,
  raw_payload jsonb NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stripe_balance_transactions_amount_net_check
    CHECK (amount - fee = net),
  CONSTRAINT stripe_balance_transactions_currency_check
    CHECK (currency = lower(currency) AND currency ~ '^[a-z]{3}$'),
  CONSTRAINT stripe_balance_transactions_status_check
    CHECK (status IN ('pending', 'available'))
);

CREATE TABLE public.stripe_refunds (
  id text PRIMARY KEY,
  payment_intent_id text NOT NULL,
  charge_id text,
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
  amount integer NOT NULL,
  currency text NOT NULL,
  status text NOT NULL,
  reason text,
  balance_transaction_id text REFERENCES public.stripe_balance_transactions(id) ON DELETE RESTRICT,
  failure_balance_transaction_id text REFERENCES public.stripe_balance_transactions(id) ON DELETE RESTRICT,
  stripe_created_at timestamptz NOT NULL,
  succeeded_at timestamptz,
  raw_payload jsonb NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stripe_refunds_amount_positive_check CHECK (amount > 0),
  CONSTRAINT stripe_refunds_currency_check
    CHECK (currency = lower(currency) AND currency ~ '^[a-z]{3}$'),
  CONSTRAINT stripe_refunds_status_check
    CHECK (status IN ('pending', 'requires_action', 'succeeded', 'failed', 'canceled')),
  CONSTRAINT stripe_refunds_succeeded_at_check
    CHECK (status <> 'succeeded' OR succeeded_at IS NOT NULL)
);

CREATE TABLE public.stripe_payouts (
  id text PRIMARY KEY,
  amount integer NOT NULL,
  currency text NOT NULL,
  status text NOT NULL,
  automatic boolean NOT NULL,
  arrival_date date,
  stripe_created_at timestamptz NOT NULL,
  paid_at timestamptz,
  reconciliation_status text NOT NULL DEFAULT 'pending',
  reconciled_net integer NOT NULL DEFAULT 0,
  bank_arrival_date date,
  bank_confirmed_at timestamptz,
  bank_confirmed_by uuid REFERENCES auth.users(id) ON DELETE RESTRICT,
  raw_payload jsonb NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stripe_payouts_amount_positive_check CHECK (amount > 0),
  CONSTRAINT stripe_payouts_currency_check
    CHECK (currency = lower(currency) AND currency ~ '^[a-z]{3}$'),
  CONSTRAINT stripe_payouts_status_check
    CHECK (status IN ('pending', 'in_transit', 'paid', 'failed', 'canceled')),
  CONSTRAINT stripe_payouts_reconciliation_status_check
    CHECK (reconciliation_status IN ('pending', 'matched', 'mismatch')),
  CONSTRAINT stripe_payouts_bank_confirmation_check
    CHECK (
      (bank_arrival_date IS NULL AND bank_confirmed_at IS NULL AND bank_confirmed_by IS NULL)
      OR
      (bank_arrival_date IS NOT NULL AND bank_confirmed_at IS NOT NULL AND bank_confirmed_by IS NOT NULL)
    )
);

ALTER TABLE public.stripe_balance_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_payouts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.stripe_balance_transactions FROM anon, authenticated;
REVOKE ALL ON public.stripe_refunds FROM anon, authenticated;
REVOKE ALL ON public.stripe_payouts FROM anon, authenticated;

GRANT SELECT, INSERT, UPDATE ON public.stripe_balance_transactions TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.stripe_refunds TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.stripe_payouts TO service_role;

CREATE INDEX idx_stripe_balance_transactions_order_created
  ON public.stripe_balance_transactions(order_id, stripe_created_at);
CREATE INDEX idx_stripe_balance_transactions_payment_intent
  ON public.stripe_balance_transactions(payment_intent_id);
CREATE INDEX idx_stripe_balance_transactions_payout
  ON public.stripe_balance_transactions(payout_id);
CREATE INDEX idx_stripe_refunds_order_succeeded
  ON public.stripe_refunds(order_id, succeeded_at)
  WHERE status = 'succeeded';
CREATE INDEX idx_stripe_payouts_unconfirmed
  ON public.stripe_payouts(stripe_created_at)
  WHERE status = 'paid' AND bank_confirmed_at IS NULL;

COMMENT ON TABLE public.stripe_balance_transactions IS
  'Immutable Stripe balance transaction facts used to derive accounting journals';
COMMENT ON TABLE public.stripe_refunds IS
  'Stripe refund lifecycle; succeeded_at is the accounting reversal date';
COMMENT ON TABLE public.stripe_payouts IS
  'Stripe payout reconciliation and explicit bank-arrival confirmation';

COMMIT;

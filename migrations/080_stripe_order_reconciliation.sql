-- ============================================================
-- 080: Stripe order reconciliation and retryable webhook state
-- ============================================================

BEGIN;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS refunded_amount integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS refunded_at timestamptz,
  ADD COLUMN IF NOT EXISTS payment_status_updated_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'orders_refunded_amount_range'
      AND conrelid = 'public.orders'::regclass
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_refunded_amount_range
      CHECK (refunded_amount >= 0 AND refunded_amount <= total_amount);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_orders_payment_status_updated_at
  ON public.orders(payment_status_updated_at DESC);

ALTER TABLE public.stripe_webhook_events
  ADD COLUMN IF NOT EXISTS processing_status text NOT NULL DEFAULT 'completed',
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_error text;

UPDATE public.stripe_webhook_events
SET completed_at = COALESCE(completed_at, processed_at)
WHERE processing_status = 'completed'
  AND completed_at IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'stripe_webhook_events_processing_status_check'
      AND conrelid = 'public.stripe_webhook_events'::regclass
  ) THEN
    ALTER TABLE public.stripe_webhook_events
      ADD CONSTRAINT stripe_webhook_events_processing_status_check
      CHECK (processing_status IN ('processing', 'completed', 'failed'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'stripe_webhook_events_attempt_count_check'
      AND conrelid = 'public.stripe_webhook_events'::regclass
  ) THEN
    ALTER TABLE public.stripe_webhook_events
      ADD CONSTRAINT stripe_webhook_events_attempt_count_check
      CHECK (attempt_count >= 1);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_processing_status
  ON public.stripe_webhook_events(processing_status, processed_at DESC);

COMMENT ON COLUMN public.orders.refunded_amount IS
  'Cumulative amount of succeeded Stripe refunds in the order currency';
COMMENT ON COLUMN public.stripe_webhook_events.processing_status IS
  'Processing lifecycle; only completed events are skipped as duplicates';

COMMIT;

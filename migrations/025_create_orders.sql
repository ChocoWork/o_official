-- ============================================================
-- 025: Create orders, order_items, stripe_webhook_events tables
-- ============================================================

-- Order status enum (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'order_status') THEN
    CREATE TYPE order_status AS ENUM ('pending', 'paid', 'failed', 'cancelled');
  END IF;
END
$$;

-- Orders table (header)
CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id TEXT NOT NULL,
  user_id UUID REFERENCES public.profiles(user_id) ON DELETE SET NULL,
  payment_intent_id TEXT UNIQUE NOT NULL,
  status order_status NOT NULL DEFAULT 'pending',
  subtotal_amount INTEGER NOT NULL CHECK (subtotal_amount >= 0),  -- 円単位
  shipping_amount INTEGER NOT NULL DEFAULT 500 CHECK (shipping_amount >= 0),
  total_amount INTEGER NOT NULL CHECK (total_amount > 0),
  currency TEXT NOT NULL DEFAULT 'jpy',
  -- 配送先スナップショット
  shipping_email TEXT,
  shipping_full_name TEXT,
  shipping_postal_code TEXT,
  shipping_prefecture TEXT,
  shipping_city TEXT,
  shipping_address TEXT,
  shipping_building TEXT,
  shipping_phone TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_orders_session_id ON orders(session_id);
CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_payment_intent_id ON orders(payment_intent_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at);

-- Order items table (lines) — prices are snapshotted at purchase time
CREATE TABLE IF NOT EXISTS order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES public.items(id) ON DELETE RESTRICT,
  item_name TEXT NOT NULL,           -- snapshot
  item_price INTEGER NOT NULL CHECK (item_price >= 0),  -- snapshot
  item_image_url TEXT,               -- snapshot
  color TEXT,
  size TEXT,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  line_total INTEGER NOT NULL CHECK (line_total >= 0),  -- item_price * quantity
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);

-- Stripe webhook events (idempotency guard)
CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  id TEXT PRIMARY KEY,               -- Stripe event ID (evt_...)
  event_type TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  raw_payload JSONB
);

-- updated_at trigger for orders
CREATE OR REPLACE FUNCTION update_orders_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_orders_updated_at ON orders;

CREATE TRIGGER trigger_orders_updated_at
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION update_orders_updated_at();

-- ============================================================
-- RLS
-- ============================================================
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_webhook_events ENABLE ROW LEVEL SECURITY;

-- Users can view their own orders (by user_id or session)
CREATE POLICY "Users can view their own orders" ON orders FOR SELECT
  USING (
    (auth.uid() IS NOT NULL AND auth.uid() = user_id)
    OR session_id = current_setting('app.session_id', true)
  );

-- order_items: accessible if the parent order is accessible
CREATE POLICY "Users can view their own order items" ON order_items FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM orders o
      WHERE o.id = order_items.order_id
        AND (
          (auth.uid() IS NOT NULL AND auth.uid() = o.user_id)
          OR o.session_id = current_setting('app.session_id', true)
        )
    )
  );

-- stripe_webhook_events は service role のみ操作（RLS=trueでユーザーアクセス禁止）
-- No user-facing policies; all access via service role key from API routes.

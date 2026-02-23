-- Create cart table for persistent shopping cart (guest-friendly via session_id)
CREATE TABLE IF NOT EXISTS carts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  session_id TEXT,
  item_id INTEGER NOT NULL REFERENCES public.items(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  color TEXT,
  size TEXT,
  added_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  
  -- Ensure unique cart entry per user/session + item variant
  CONSTRAINT cart_unique_per_user_session_item UNIQUE(
    COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(session_id, ''),
    item_id,
    COALESCE(color, ''),
    COALESCE(size, '')
  )
);

-- Index for faster lookups
CREATE INDEX IF NOT EXISTS idx_carts_user_id ON carts(user_id);
CREATE INDEX IF NOT EXISTS idx_carts_session_id ON carts(session_id);
CREATE INDEX IF NOT EXISTS idx_carts_item_id ON carts(item_id);
CREATE INDEX IF NOT EXISTS idx_carts_created_at ON carts(added_at);

-- RLS: Allow users to see/modify only their own cart and guests to see carts with their session
ALTER TABLE carts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own cart" ON carts FOR SELECT
  USING (
    (auth.uid() = user_id) OR 
    (user_id IS NULL AND session_id = current_setting('app.session_id', true))
  );

CREATE POLICY "Users can insert their own cart items" ON carts FOR INSERT
  WITH CHECK (
    (auth.uid() = user_id) OR 
    (user_id IS NULL AND session_id = current_setting('app.session_id', true))
  );

CREATE POLICY "Users can update their own cart items" ON carts FOR UPDATE
  USING (
    (auth.uid() = user_id) OR 
    (user_id IS NULL AND session_id = current_setting('app.session_id', true))
  )
  WITH CHECK (
    (auth.uid() = user_id) OR 
    (user_id IS NULL AND session_id = current_setting('app.session_id', true))
  );

CREATE POLICY "Users can delete their own cart items" ON carts FOR DELETE
  USING (
    (auth.uid() = user_id) OR 
    (user_id IS NULL AND session_id = current_setting('app.session_id', true))
  );

-- Create wishlist table for saved items
CREATE TABLE IF NOT EXISTS wishlist (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES public.profiles(id) ON DELETE CASCADE,
  session_id TEXT,
  item_id INTEGER NOT NULL REFERENCES public.items(id) ON DELETE CASCADE,
  added_at TIMESTAMPTZ DEFAULT now(),
  
  -- Ensure only one wishlist entry per user/session + item
  CONSTRAINT wishlist_unique_per_user_session_item UNIQUE(
    COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(session_id, ''),
    item_id
  )
);

-- Index for faster lookups
CREATE INDEX IF NOT EXISTS idx_wishlist_user_id ON wishlist(user_id);
CREATE INDEX IF NOT EXISTS idx_wishlist_session_id ON wishlist(session_id);
CREATE INDEX IF NOT EXISTS idx_wishlist_item_id ON wishlist(item_id);
CREATE INDEX IF NOT EXISTS idx_wishlist_created_at ON wishlist(added_at);

-- RLS: Allow users to see/modify only their own wishlist and guests with their session
ALTER TABLE wishlist ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own wishlist" ON wishlist FOR SELECT
  USING (
    (auth.uid() = user_id) OR 
    (user_id IS NULL AND session_id IS NOT NULL AND session_id = current_setting('app.session_id', true))
  );

CREATE POLICY "Users can insert items to their wishlist" ON wishlist FOR INSERT
  WITH CHECK (
    (auth.uid() = user_id) OR 
    (user_id IS NULL AND session_id IS NOT NULL AND session_id = current_setting('app.session_id', true))
  );

CREATE POLICY "Users can delete from their wishlist" ON wishlist FOR DELETE
  USING (
    (auth.uid() = user_id) OR 
    (user_id IS NULL AND session_id IS NOT NULL AND session_id = current_setting('app.session_id', true))
  );

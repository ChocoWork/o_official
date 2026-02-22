-- Enable RLS on news_articles table
ALTER TABLE news_articles ENABLE ROW LEVEL SECURITY;

-- Allow anonymous users to read published articles
CREATE POLICY "Anyone can view published news articles"
ON news_articles
FOR SELECT
USING (status = 'published');

-- Allow service role to do everything (for admin operations)
CREATE POLICY "Service role has full access to news articles"
ON news_articles
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

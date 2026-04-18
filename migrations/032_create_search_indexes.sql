create index if not exists idx_items_search_text
on public.items
using gin (to_tsvector('simple', coalesce(name, '') || ' ' || coalesce(description, '') || ' ' || coalesce(category, '')));

create index if not exists idx_looks_search_text
on public.looks
using gin (to_tsvector('simple', coalesce(theme, '') || ' ' || coalesce(theme_description, '')));

create index if not exists idx_news_articles_search_text
on public.news_articles
using gin (to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(content, '') || ' ' || coalesce(detailed_content, '') || ' ' || coalesce(category, '')));
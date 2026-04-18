export type SearchResultType = 'item' | 'look' | 'news';

export type SearchTab = 'all' | SearchResultType;

export type SearchResult = {
  id: string;
  type: SearchResultType;
  title: string;
  description: string;
  href: string;
  imageUrl: string | null;
  meta: string;
};

export type SearchResultsResponse = {
  query: string;
  tab: SearchTab;
  items: SearchResult[];
  looks: SearchResult[];
  news: SearchResult[];
  counts: {
    all: number;
    item: number;
    look: number;
    news: number;
  };
  popularItems: SearchResult[];
  empty: boolean;
};

export type SearchSuggestion = {
  label: string;
  type: SearchResultType;
  href: string;
};
export type NewsCategory =
  | "ALL"
  | "COLLECTION"
  | "EVENT"
  | "COLLABORATION"
  | "SUSTAINABILITY"
  | "STORE";

export type NewsStatus = "private" | "published";

export interface NewsArticle {
  id: number;
  date: string;
  title: string;
  content: string;
  detailedContent: string;
  category: Exclude<NewsCategory, "ALL">;
  imageUrl: string;
  status: NewsStatus;
}

export interface NewsFormData {
  title: string;
  category: Exclude<NewsCategory, "ALL">;
  date: string;
  content: string;
  detailedContent: string;
  status: NewsStatus;
}

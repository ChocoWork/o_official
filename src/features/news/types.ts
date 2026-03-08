export type PublicNewsArticle = {
  id: string;
  title: string;
  published_date: string;
  category: string;
  image_url: string;
  content: string;
};

export type PublicNewsDetailArticle = PublicNewsArticle & {
  detailed_content: string;
};

export type PublicNewsTitle = {
  id: string;
  title: string;
};

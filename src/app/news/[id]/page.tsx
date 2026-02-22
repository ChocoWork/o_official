import React from "react";
import Link from "next/link";
import Image from "next/image";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { categories } from "@/lib/news-data";

type NewsArticle = {
  id: string;
  title: string;
  published_date: string;
  category: string;
  image_url: string;
  content: string;
  detailed_content: string;
};

interface NewsDetailPageProps {
  params: {
    id: string;
  };
  searchParams?: {
    category?: string;
  };
}

export default async function NewsDetailPage({
  params,
  searchParams,
}: NewsDetailPageProps) {
  const supabase = await createClient();

  const selectedCategory = (searchParams?.category ?? "ALL").toUpperCase();
  const activeCategory = categories.includes(
    selectedCategory as (typeof categories)[number],
  )
    ? (selectedCategory as (typeof categories)[number])
    : "ALL";
  
  // 現在の記事を取得（公開記事のみ）
  let articleQuery = supabase
    .from("news_articles")
    .select("*")
    .eq("id", params.id)
    .eq("status", "published");

  if (activeCategory !== "ALL") {
    articleQuery = articleQuery.eq("category", activeCategory);
  }

  const { data: article } = await articleQuery.single();

  if (!article) {
    notFound();
  }

  const typedArticle: NewsArticle = article;

  // 全公開記事を取得して前後の記事を特定
  let allArticlesQuery = supabase
    .from("news_articles")
    .select("id, title")
    .eq("status", "published")
    .order("published_date", { ascending: false });

  if (activeCategory !== "ALL") {
    allArticlesQuery = allArticlesQuery.eq("category", activeCategory);
  }

  const { data: allArticles } = await allArticlesQuery;

  const currentIndex =
    allArticles?.findIndex((item) => String(item.id) === params.id) ?? -1;
  const prevArticle = currentIndex > 0 && allArticles ? allArticles[currentIndex - 1] : null;
  const nextArticle =
    currentIndex >= 0 && allArticles && currentIndex < allArticles.length - 1
      ? allArticles[currentIndex + 1]
      : null;

  const navCategoryParam = activeCategory === "ALL" ? "" : `?category=${activeCategory}`;

  return (
    <main className="pt-32 pb-20 px-6 lg:px-12">
      <div className="max-w-4xl mx-auto">
        {/* Back to News Link */}
        <Link href={`/news${navCategoryParam}`}>
          <div
            className="flex items-center space-x-2 text-sm text-[#474747] mb-12 hover:text-black transition-colors cursor-pointer"
            style={{ fontFamily: "acumin-pro, sans-serif" }}
          >
            <span className="w-4 h-4 flex items-center justify-center">←</span>
            <span className="tracking-widest">BACK TO NEWS</span>
          </div>
        </Link>

        {/* Article Header */}
        <div className="mb-8">
          <div className="flex items-center space-x-4 mb-6">
            <span
              className="text-xs text-[#474747] tracking-widest"
              style={{ fontFamily: "acumin-pro, sans-serif" }}
            >
              {typedArticle.published_date.replace(/-/g, '.')}
            </span>
            <span
              className="text-xs text-black tracking-widest px-3 py-1 border border-black"
              style={{ fontFamily: "acumin-pro, sans-serif" }}
            >
              {typedArticle.category}
            </span>
          </div>
          <h1
            className="text-4xl lg:text-5xl text-black mb-8"
            style={{ fontFamily: "Didot, serif" }}
          >
            {typedArticle.title}
          </h1>
        </div>

        {/* Article Image */}
        <div className="aspect-[16/10] overflow-hidden mb-12 bg-[#f5f5f5] relative">
          <Image
            alt={typedArticle.title}
            className="w-full h-full object-cover object-center"
            src={typedArticle.image_url}
            width={1200}
            height={750}
            priority
          />
        </div>

        {/* Article Content */}
        <div
          className="prose prose-lg max-w-none"
          style={{ fontFamily: "acumin-pro, sans-serif" }}
        >
          {typedArticle.detailed_content.split("\n\n").map((paragraph: string, index: number) => (
            <p
              key={index}
              className="text-[#474747] leading-relaxed mb-6 whitespace-pre-line"
            >
              {paragraph}
            </p>
          ))}
        </div>

        {/* Navigation */}
        <div className="mt-16 pt-8 border-t border-[#d5d0c9] grid grid-cols-[1fr_auto_1fr] items-center">
          {/* Previous Article */}
          {prevArticle ? (
            <Link
              href={`/news/${prevArticle.id}${navCategoryParam}`}
              className="group flex items-center space-x-3 cursor-pointer justify-self-start"
            >
              <span className="w-5 h-5 flex items-center justify-center text-[#474747] group-hover:text-black transition-colors">
                ←
              </span>
              <div>
                <p
                  className="text-xs text-[#999] tracking-widest"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  PREV
                </p>
                <p
                  className="text-sm text-[#474747] group-hover:text-black transition-colors max-w-[200px] truncate"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  {prevArticle.title}
                </p>
              </div>
            </Link>
          ) : (
            <div></div>
          )}

          {/* View All Button */}
          <Link href={`/news${navCategoryParam}`} className="justify-self-center">
            <button
              className="px-10 py-3 border border-black text-black text-xs tracking-widest hover:bg-black hover:text-white transition-all duration-300 cursor-pointer whitespace-nowrap"
              style={{ fontFamily: "acumin-pro, sans-serif" }}
            >
              VIEW ALL
            </button>
          </Link>

          {/* Next Article */}
          {nextArticle ? (
            <Link
              href={`/news/${nextArticle.id}${navCategoryParam}`}
              className="group flex items-center space-x-3 cursor-pointer text-right justify-self-end"
            >
              <div>
                <p
                  className="text-xs text-[#999] tracking-widest"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  NEXT
                </p>
                <p
                  className="text-sm text-[#474747] group-hover:text-black transition-colors max-w-[200px] truncate"
                  style={{ fontFamily: "acumin-pro, sans-serif" }}
                >
                  {nextArticle.title}
                </p>
              </div>
              <span className="w-5 h-5 flex items-center justify-center text-[#474747] group-hover:text-black transition-colors">
                →
              </span>
            </Link>
          ) : (
            <div></div>
          )}
        </div>
      </div>
    </main>
  );
}

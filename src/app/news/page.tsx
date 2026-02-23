import React from "react";
import Link from "next/link";
import Image from "next/image";
import { createClient } from "@/lib/supabase/server";
import { categories } from "@/lib/news-data";

type NewsArticle = {
  id: string;
  title: string;
  published_date: string;
  category: string;
  image_url: string;
  content: string;
};

export default async function NewsPage({
  searchParams,
}: {
  searchParams?: Promise<{ category?: string }>;
}) {
  const supabase = await createClient();
  const params = await searchParams;
  const selectedCategory = (params?.category ?? "ALL").toUpperCase();
  const activeCategory = categories.includes(
    selectedCategory as (typeof categories)[number],
  )
    ? (selectedCategory as (typeof categories)[number])
    : "ALL";

  let query = supabase
    .from("news_articles")
    .select("id, title, published_date, category, image_url, content")
    .eq("status", "published")
    .order("published_date", { ascending: false });

  if (activeCategory !== "ALL") {
    query = query.eq("category", activeCategory);
  }

  const { data: articles } = await query;
  const newsData: NewsArticle[] = articles || [];

  return (
    <main className="pt-32 pb-20 px-6 lg:px-12">
      <div className="max-w-7xl mx-auto">
        {/* Category Filter Buttons */}
        <div className="flex items-center justify-center space-x-6 mb-16">
          {categories.map((category) => {
            const isActive = category === activeCategory;
            const href = category === "ALL" ? "/news" : `/news?category=${category}`;

            return (
              <Link
                key={category}
                href={href}
                className={`text-xs tracking-widest px-4 py-2 transition-all duration-300 cursor-pointer whitespace-nowrap ${
                  isActive
                    ? "text-black border-b-2 border-black"
                    : "text-[#999] hover:text-black"
                }`}
                style={{ fontFamily: "acumin-pro, sans-serif" }}
              >
                {category}
              </Link>
            );
          })}
        </div>

        {/* News Grid */}
        {newsData.length === 0 ? (
          <div className="text-center py-20">
            <p
              className="text-lg text-[#474747]"
              style={{ fontFamily: "acumin-pro, sans-serif" }}
            >
              現在、公開されている記事はありません
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8 lg:gap-12">
            {newsData.map((article) => {
              const detailHref =
                activeCategory === "ALL"
                  ? `/news/${article.id}`
                  : `/news/${article.id}?category=${activeCategory}`;

              return (
                <Link key={article.id} href={detailHref}>
                <article className="group cursor-pointer">
                  {/* Image */}
                  <div className="aspect-[4/3] overflow-hidden mb-6 bg-[#f5f5f5] relative">
                    <Image
                      alt={article.title}
                      className="w-full h-full object-cover object-center transition-transform duration-700 group-hover:scale-105"
                      src={article.image_url}
                      width={1200}
                      height={750}
                    />
                  </div>

                  {/* Content */}
                  <div className="space-y-3">
                    {/* Date & Category */}
                    <div className="flex items-center space-x-4">
                      <span
                        className="text-xs text-[#474747] tracking-widest"
                        style={{ fontFamily: "acumin-pro, sans-serif" }}
                      >
                        {article.published_date.replace(/-/g, '.')}
                      </span>
                      <span
                        className="text-xs text-black tracking-widest px-3 py-1 border border-black"
                        style={{ fontFamily: "acumin-pro, sans-serif" }}
                      >
                        {article.category}
                      </span>
                    </div>

                    {/* Title */}
                    <h2
                      className="text-xl text-black group-hover:text-[#474747] transition-colors duration-300"
                      style={{ fontFamily: "Didot, serif" }}
                    >
                      {article.title}
                    </h2>

                    {/* Description */}
                    <p
                      className="text-sm text-[#474747] leading-relaxed line-clamp-3"
                      style={{ fontFamily: "acumin-pro, sans-serif" }}
                    >
                      {article.content}
                    </p>

                    {/* Read More */}
                    <div className="pt-2">
                      <span
                        className="text-xs text-black tracking-widest group-hover:underline"
                        style={{ fontFamily: "acumin-pro, sans-serif" }}
                      >
                        READ MORE →
                      </span>
                    </div>
                  </div>
                </article>
              </Link>
                );
              })}
          </div>
        )}
      </div>
    </main>
  );
}

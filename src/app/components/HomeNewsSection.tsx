'use client';

import Link from "next/link";
import Image from "next/image";
import { type NewsArticle } from "@/app/actions/news";

interface HomeNewsSectionProps {
  initialNews: NewsArticle[];
}

export default function HomeNewsSection({ initialNews }: HomeNewsSectionProps) {
  const newsData = initialNews;

  return (
    <section id="news" className="py-24 lg:py-32 px-6 lg:px-12 bg-white w-full">
      <div className="max-w-7xl mx-auto">
        <div className="text-center mb-16 lg:mb-24">
          <h2
            className="text-4xl lg:text-5xl mb-4 text-black tracking-tight"
            style={{ fontFamily: "Didot, serif" }}
          >
            NEWS
          </h2>
          <div className="w-16 h-px bg-black mx-auto"></div>
        </div>

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
            {newsData.map((article) => (
              <Link key={article.id} href={`/news/${article.id}`}>
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
                        {article.published_date.replace(/-/g, ".")}
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
            ))}
          </div>
        )}

        <div className="text-center mt-16">
          <Link href="/news">
            <button
              className="px-12 py-4 border border-black text-black text-sm tracking-widest hover:bg-black hover:text-white transition-all duration-300 cursor-pointer whitespace-nowrap"
              style={{ fontFamily: "acumin-pro, sans-serif" }}
            >
              VIEW ALL NEWS
            </button>
          </Link>
        </div>
      </div>
    </section>
  );
}

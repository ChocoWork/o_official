import React from "react";
import Link from "next/link";
import Image from "next/image";
import { notFound } from "next/navigation";
import { newsData } from "@/lib/news-data";

interface NewsDetailPageProps {
  params: {
    id: string;
  };
}

export default function NewsDetailPage({ params }: NewsDetailPageProps) {
  const articleId = parseInt(params.id, 10);
  const article = newsData.find((item) => item.id === articleId);

  if (!article) {
    notFound();
  }

  // Find previous and next articles
  const currentIndex = newsData.findIndex((item) => item.id === articleId);
  const prevArticle = currentIndex > 0 ? newsData[currentIndex - 1] : null;
  const nextArticle =
    currentIndex < newsData.length - 1 ? newsData[currentIndex + 1] : null;

  return (
    <main className="pt-32 pb-20 px-6 lg:px-12">
      <div className="max-w-4xl mx-auto">
        {/* Back to News Link */}
        <Link href="/news">
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
              {article.date}
            </span>
            <span
              className="text-xs text-black tracking-widest px-3 py-1 border border-black"
              style={{ fontFamily: "acumin-pro, sans-serif" }}
            >
              {article.category}
            </span>
          </div>
          <h1
            className="text-4xl lg:text-5xl text-black mb-8"
            style={{ fontFamily: "Didot, serif" }}
          >
            {article.title}
          </h1>
        </div>

        {/* Article Image */}
        <div className="aspect-[16/10] overflow-hidden mb-12 bg-[#f5f5f5] relative">
          <Image
            alt={article.title}
            className="w-full h-full object-cover object-center"
            src={article.imageUrl}
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
          {article.detailedContent.split("\n\n").map((paragraph, index) => (
            <p
              key={index}
              className="text-[#474747] leading-relaxed mb-6 whitespace-pre-line"
            >
              {paragraph}
            </p>
          ))}
        </div>

        {/* Navigation */}
        <div className="mt-16 pt-8 border-t border-[#d5d0c9] flex items-center justify-between">
          {/* Previous Article */}
          {prevArticle ? (
            <Link
              href={`/news/${prevArticle.id}`}
              className="group flex items-center space-x-3 cursor-pointer"
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
          <Link href="/news">
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
              href={`/news/${nextArticle.id}`}
              className="group flex items-center space-x-3 cursor-pointer text-right"
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

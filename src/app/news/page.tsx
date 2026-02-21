import React from "react";
import Link from "next/link";
import Image from "next/image";
import { newsData, categories } from "@/lib/news-data";

export default function NewsPage() {
  return (
    <main className="pt-32 pb-20 px-6 lg:px-12">
      <div className="max-w-7xl mx-auto">
        {/* Category Filter Buttons */}
        <div className="flex items-center justify-center space-x-6 mb-16">
          {categories.map((category, index) => (
            <button
              key={category}
              className={`text-xs tracking-widest px-4 py-2 transition-all duration-300 cursor-pointer whitespace-nowrap ${
                index === 0
                  ? "text-black border-b-2 border-black"
                  : "text-[#999] hover:text-black"
              }`}
              style={{ fontFamily: "acumin-pro, sans-serif" }}
            >
              {category}
            </button>
          ))}
        </div>

        {/* News Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8 lg:gap-12">
          {newsData.map((article) => (
            <Link key={article.id} href={`/news/${article.id}`}>
              <article className="group cursor-pointer">
                {/* Image */}
                <div className="aspect-[4/3] overflow-hidden mb-6 bg-[#f5f5f5] relative">
                  <Image
                    alt={article.title}
                    className="w-full h-full object-cover object-center transition-transform duration-700 group-hover:scale-105"
                    src={article.imageUrl}
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
                      {article.date}
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
      </div>
    </main>
  );
}

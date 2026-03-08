'use client';

import { type NewsArticle } from "@/app/actions/news";
import { Button } from '@/app/components/ui/Button';
import { PublicNewsGrid } from '@/features/news/components/PublicNewsGrid';

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
          <PublicNewsGrid articles={newsData} className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8 lg:gap-12" />
        )}

        <div className="text-center mt-16">
          <Button href="/news" variant="secondary" size="md" className="font-acumin">VIEW ALL NEWS</Button>
        </div>
      </div>
    </section>
  );
}

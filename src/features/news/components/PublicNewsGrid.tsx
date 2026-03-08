import Image from 'next/image';
import Link from 'next/link';
import { TagLabel } from '@/app/components/ui/TagLabel';
import { PublicNewsArticle } from '@/features/news/types';

type PublicNewsGridProps = {
  articles: PublicNewsArticle[];
  className?: string;
  buildHref?: (article: PublicNewsArticle) => string;
};

export function PublicNewsGrid({ articles, className, buildHref }: PublicNewsGridProps) {
  const gridClassName = className ?? 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8 lg:gap-12';

  return (
    <div className={gridClassName}>
      {articles.map((article) => {
        const detailHref = buildHref ? buildHref(article) : `/news/${article.id}`;

        return (
          <Link key={article.id} href={detailHref}>
            <article className="group cursor-pointer">
              <div className="aspect-[4/3] overflow-hidden mb-6 bg-[#f5f5f5] relative">
                <Image
                  alt={article.title}
                  className="w-full h-full object-cover object-center transition-transform duration-700 group-hover:scale-105"
                  src={article.image_url}
                  width={1200}
                  height={750}
                />
              </div>

              <div className="space-y-3">
                <div className="flex items-center space-x-4">
                  <span
                    className="text-xs text-[#474747] tracking-widest"
                    style={{ fontFamily: 'acumin-pro, sans-serif' }}
                  >
                    {article.published_date.replace(/-/g, '.')}
                  </span>
                  <TagLabel className="font-acumin" size="md">
                    {article.category}
                  </TagLabel>
                </div>

                <h2
                  className="text-xl text-black group-hover:text-[#474747] transition-colors duration-300"
                  style={{ fontFamily: 'Didot, serif' }}
                >
                  {article.title}
                </h2>

                <p
                  className="text-sm text-[#474747] leading-relaxed line-clamp-3"
                  style={{ fontFamily: 'acumin-pro, sans-serif' }}
                >
                  {article.content}
                </p>

                <div className="pt-2">
                  <span
                    className="text-xs text-black tracking-widest group-hover:underline"
                    style={{ fontFamily: 'acumin-pro, sans-serif' }}
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
  );
}

import Link from 'next/link';
import Image from 'next/image';

type NewsItem = {
  id: string;
  title: string;
  date: string;
  category: string;
  isPublished: boolean;
  imageSrc: string;
};

export default function NewsSection() {
  const newsItems: NewsItem[] = [
    {
      id: '1',
      title: '2025 Spring/Summer Collection 発売開始',
      date: '2025/1/15',
      category: 'Collection',
      isPublished: true,
      imageSrc:
        'https://readdy.ai/api/search-image?query=elegant%20fashion%20collection%20spring%20summer%20clothing%20display%20minimalist%20white%20background%20professional%20photography%20high%20end%20luxury%20brand&width=400&height=400&seq=news1&orientation=squarish',
    },
    {
      id: '2',
      title: 'POP-UP STORE 開催のお知らせ',
      date: '2025/1/10',
      category: 'Event',
      isPublished: true,
      imageSrc:
        'https://readdy.ai/api/search-image?query=luxury%20fashion%20popup%20store%20interior%20minimalist%20design%20elegant%20retail%20space%20white%20walls%20modern&width=400&height=400&seq=news2&orientation=squarish',
    },
    {
      id: '3',
      title: '年末年始の営業について',
      date: '2024/12/25',
      category: 'Information',
      isPublished: false,
      imageSrc:
        'https://readdy.ai/api/search-image?query=elegant%20holiday%20season%20announcement%20minimalist%20design%20festive%20subtle%20decoration%20white%20background&width=400&height=400&seq=news3&orientation=squarish',
    },
    {
      id: '4',
      title: 'コラボレーションアイテム発売',
      date: '2024/12/20',
      category: 'Collection',
      isPublished: true,
      imageSrc:
        'https://readdy.ai/api/search-image?query=fashion%20collaboration%20limited%20edition%20clothing%20item%20exclusive%20design%20minimalist%20product%20photography&width=400&height=400&seq=news4&orientation=squarish',
    },
  ];

  return (
    <div>
      <div className="flex justify-between items-center mb-8">
        <h3 className="text-2xl text-black font-didot">NEWS管理</h3>
        <Link
          href="/admin/news/create"
          className="px-8 py-3 bg-black text-white text-sm tracking-widest hover:bg-[#474747] transition-all cursor-pointer whitespace-nowrap font-acumin"
        >
          新規作成
        </Link>
      </div>
      <div className="space-y-4">
        {newsItems.map((item) => (
          <div key={item.id} className="border border-[#d5d0c9] p-6 flex items-center justify-between">
            <div className="flex items-center space-x-6 flex-1">
              <Image
                src={item.imageSrc}
                alt={item.title}
                width={96}
                height={96}
                className="w-24 h-24 object-cover bg-[#f5f5f5]"
              />
              <div className="flex-1">
                <div className="flex items-center space-x-3 mb-2">
                  <span
                    className={`px-3 py-1 text-xs tracking-widest font-acumin ${
                      item.isPublished ? 'bg-black text-white' : 'border border-black text-black'
                    }`}
                  >
                    {item.isPublished ? '公開中' : '非公開'}
                  </span>
                  <span className="text-xs text-[#474747] tracking-widest font-acumin">
                    {item.category}
                  </span>
                </div>
                <h4 className="text-lg text-black mb-2 font-acumin">{item.title}</h4>
                <p className="text-sm text-[#474747] font-acumin">{item.date}</p>
              </div>
            </div>
            <div className="flex items-center space-x-3">
              <button className="px-6 py-2 border border-black text-black text-xs tracking-widest hover:bg-black hover:text-white transition-all cursor-pointer whitespace-nowrap font-acumin">
                {item.isPublished ? '非公開' : '公開'}
              </button>
              <Link href={`/admin/news/edit/${item.id}`}>
                <button className="px-6 py-2 border border-black text-black text-xs tracking-widest hover:bg-black hover:text-white transition-all cursor-pointer whitespace-nowrap font-acumin">
                  編集
                </button>
              </Link>
              <button className="px-6 py-2 bg-black text-white text-xs tracking-widest hover:bg-[#474747] transition-all cursor-pointer whitespace-nowrap font-acumin">
                削除
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
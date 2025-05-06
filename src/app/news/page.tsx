import React from "react";

const NewsCard: React.FC<{ date: string; title: string; content: string }> = ({
  date,
  title,
  content,
}) => {
  return (
    <div className="border rounded-xl shadow-lg p-4 mb-6">
      <div className="flex justify-between items-center border-b pb-2">
        <div className="text-base font-medium text-gray-600 mr-2">{date}</div>
        <div className="text-base font-medium text-gray-800">{title}</div>
      </div>
      <div className="mt-4 text-gray-700">{content}</div>
    </div>
  );
};

const newsData = [
  {
    date: "2025.05.04",
    title: "ニュースタイトル1",
    content: "ニュースの内容1",
  },
  {
    date: "2025.05.03",
    title: "ニュースタイトル2",
    content: "ニュースの内容2",
  },
  // 必要に応じて追加
];

export default function NewsPage() {
  return (
    <main className="px-5 pt-40 pb-60">
      <div id="contact">
        <div id="contactList" className="flex justify-center">
          <div id="mainContents" className="ja">
            <div className="max-w-3xl mx-auto p-6">
              {newsData.map((news, index) => (
                <NewsCard
                  key={index}
                  date={news.date}
                  title={news.title}
                  content={news.content}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}

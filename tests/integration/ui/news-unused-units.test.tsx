import fs from 'fs';
import path from 'path';
import React from 'react';
import userEvent from '@testing-library/user-event';
import { render, screen } from '@testing-library/react';
import { NewsCategoryTabs } from '@/app/news/NewsCategoryTabs';
import { ArticleBody } from '@/features/news/components/ArticleBody';
import { getLatestNews } from '@/app/actions/news';
import { getPublishedNews } from '@/features/news/services/public';

const pushMock = jest.fn();
let currentSearch = '';

jest.mock('next/link', () => {
  return ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  );
});

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: (...args: unknown[]) => pushMock(...args) }),
  useSearchParams: () => new URLSearchParams(currentSearch),
}));

jest.mock('@/features/news/services/public', () => ({
  getPublishedNews: jest.fn(),
}));

const mockedGetPublishedNews = getPublishedNews as jest.MockedFunction<typeof getPublishedNews>;

const SRC_ROOT = path.join(process.cwd(), 'src');

const UNUSED_UNITS = [
  { file: 'src/app/news/NewsCategoryTabs.tsx', pattern: /from\s+['"][^'"]*NewsCategoryTabs['"]/ },
  { file: 'src/features/news/components/ArticleBody.tsx', pattern: /from\s+['"][^'"]*ArticleBody['"]/ },
  { file: 'src/app/actions/news.ts', pattern: /from\s+['"][^'"]*actions\/news['"]/ },
];

function listSourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

describe('news unused units', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    currentSearch = '';
  });

  it('ARC-NEWS-005 使われていない3つの単位はファイルとして残り、src のどこからも import されない', () => {
    const sourceFiles = listSourceFiles(SRC_ROOT);

    for (const unit of UNUSED_UNITS) {
      const unitPath = path.join(process.cwd(), unit.file);
      expect(fs.existsSync(unitPath)).toBe(true);

      const importers = sourceFiles
        .filter((file) => path.resolve(file) !== path.resolve(unitPath))
        .filter((file) => unit.pattern.test(fs.readFileSync(file, 'utf8')))
        .map((file) => path.relative(process.cwd(), file));
      expect(importers).toEqual([]);
    }
  });

  it('ARC-NEWS-005 NewsCategoryTabs は分類ごとのタブを出し、今の分類だけを選択中にする', () => {
    render(<NewsCategoryTabs activeCategory="EVENT" />);

    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      'ALL',
      'COLLECTION',
      'EVENT',
      'COLLABORATION',
      'SUSTAINABILITY',
      'STORE',
      'BLOG',
    ]);
    expect(screen.getByRole('tab', { name: 'EVENT' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'ALL' })).toHaveAttribute('aria-selected', 'false');
  });

  it('ARC-NEWS-005 NewsCategoryTabs は分類を1つだけ URL に置き、ほかの検索の値を保つ', async () => {
    const user = userEvent.setup();
    currentSearch = 'page=2&category=STORE';
    render(<NewsCategoryTabs activeCategory="STORE" />);

    await user.click(screen.getByRole('tab', { name: 'EVENT' }));

    expect(pushMock).toHaveBeenCalledWith('/news?page=2&category=EVENT');
  });

  it('ARC-NEWS-005 NewsCategoryTabs で ALL を選ぶと category を外し、何も残らなければ /news にする', async () => {
    const user = userEvent.setup();
    currentSearch = 'category=STORE';
    render(<NewsCategoryTabs activeCategory="STORE" />);

    await user.click(screen.getByRole('tab', { name: 'ALL' }));

    expect(pushMock).toHaveBeenCalledWith('/news');
  });

  it('ARC-NEWS-005 ArticleBody は見出し・箇条書き・段落を Markdown から組み立てる', () => {
    const { container } = render(
      <ArticleBody
        content={'# Title\r\n## Sub\n### Minor\n\n- one\n* two\n+ three\nafter list\nsame paragraph\n\nnext'}
      />,
    );

    expect(screen.getByRole('heading', { level: 2, name: 'Title' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 3, name: 'Sub' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 4, name: 'Minor' })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['one', 'two', 'three']);
    expect(Array.from(container.querySelectorAll('p')).map((p) => p.textContent)).toEqual([
      'after list same paragraph',
      'next',
    ]);
  });

  it('ARC-NEWS-005 ArticleBody は画像・リンク・強調を JSX で作り、外のリンクだけ新しいタブで開く', () => {
    const { container } = render(
      <ArticleBody
        content={'![Look](https://cdn.example.com/a.jpg) [Shop](https://example.com) [Inner](/news) **b1** __b2__ *i1* _i2_ tail'}
      />,
    );

    const image = screen.getByRole('img', { name: 'Look' });
    expect(image).toHaveAttribute('src', 'https://cdn.example.com/a.jpg');
    expect(image).toHaveAttribute('loading', 'lazy');

    const external = screen.getByRole('link', { name: 'Shop' });
    expect(external).toHaveAttribute('target', '_blank');
    expect(external).toHaveAttribute('rel', 'noopener noreferrer');
    const internal = screen.getByRole('link', { name: 'Inner' });
    expect(internal).toHaveAttribute('href', '/news');
    expect(internal).not.toHaveAttribute('target');

    expect(Array.from(container.querySelectorAll('strong')).map((el) => el.textContent)).toEqual(['b1', 'b2']);
    expect(Array.from(container.querySelectorAll('em')).map((el) => el.textContent)).toEqual(['i1', 'i2']);
    expect(container.querySelector('p')?.textContent?.endsWith(' tail')).toBe(true);
  });

  it('ARC-NEWS-005 ArticleBody は生の HTML を文字のまま出すが、リンクの URL の種類は確かめない', () => {
    const { container } = render(
      <ArticleBody content={'<script>alert(1)</script> [Mail](mailto:shop@example.com)'} />,
    );

    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
    const mail = screen.getByRole('link', { name: 'Mail' });
    expect(mail).toHaveAttribute('href', 'mailto:shop@example.com');
    expect(mail).not.toHaveAttribute('target');
  });

  it('ARC-NEWS-005 ArticleBody は空の本文で何も出さない', () => {
    const { container } = render(<ArticleBody content={'\n\n'} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('ARC-NEWS-005 getLatestNews は公開済みの記事を3件だけ取り出して返す', async () => {
    const latest = [
      { id: '1', title: 't', published_date: '2026-09-01', category: 'EVENT', content: 'c' },
    ];
    mockedGetPublishedNews.mockResolvedValue(latest);

    await expect(getLatestNews()).resolves.toBe(latest);
    expect(mockedGetPublishedNews).toHaveBeenCalledWith({ limit: 3 });
  });
});

import { render, screen, within } from "@testing-library/react";
import NewsDetailPage, { generateMetadata } from "@/app/news/[id]/page";
import {
  getPublishedNewsDetailById,
  getPublishedNewsNavigation,
} from "@/features/news/services/public";
import { notFound } from "next/navigation";

jest.mock("@/features/news/services/public", () => ({
  getPublishedNewsDetailById: jest.fn(),
  getPublishedNewsNavigation: jest.fn(),
}));

jest.mock("next/navigation", () => ({
  notFound: jest.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

const mockDetail = getPublishedNewsDetailById as jest.Mock;
const mockNavigation = getPublishedNewsNavigation as jest.Mock;
const mockNotFound = notFound as unknown as jest.Mock;

const FALLBACK_DESCRIPTION = "Le Fil des Heuresのニュース詳細ページです。";

function buildArticle(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    title: "春の展示会",
    published_date: "2026-10-24",
    category: "EVENT",
    image_url: "https://signed.example/image.jpg",
    content: "summary",
    detailed_content: "本文",
    ...overrides,
  };
}

function params(id = "42") {
  return Promise.resolve({ id });
}

async function renderPage(options: {
  searchParams?: Promise<{ category?: string }>;
  article?: Record<string, unknown> | null;
  navigation?: {
    prevArticle: { id: number; title: string } | null;
    nextArticle: { id: number; title: string } | null;
  };
}) {
  mockDetail.mockResolvedValue(
    options.article === undefined ? buildArticle() : options.article,
  );
  mockNavigation.mockResolvedValue(
    options.navigation ?? { prevArticle: null, nextArticle: null },
  );
  const element = await NewsDetailPage({
    params: params(),
    searchParams: options.searchParams,
  });
  return render(element);
}

function breadcrumbNewsHref() {
  const nav = screen.getByRole("navigation", { name: "Breadcrumb" });
  return within(nav).getByRole("link", { name: "NEWS" }).getAttribute("href");
}

function viewAllHrefs() {
  return screen
    .getAllByRole("link", { name: "VIEW ALL" })
    .map((link) => link.getAttribute("href"));
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("generateMetadata", () => {
  it("DD-NEWS-030 記事が無い時は固定の題と説明を返す", async () => {
    mockDetail.mockResolvedValue(null);

    await expect(generateMetadata({ params: params() })).resolves.toEqual({
      title: "NEWS DETAIL | Le Fil des Heures",
      description: FALLBACK_DESCRIPTION,
    });
  });

  it("DD-NEWS-030 120字以下の本文は空白を詰めて説明にし、題に記事の題を入れる", async () => {
    mockDetail.mockResolvedValue(
      buildArticle({ detailed_content: "  一行目\n\n二行目\t 三行目  " }),
    );

    await expect(generateMetadata({ params: params() })).resolves.toEqual({
      title: "春の展示会 | NEWS | Le Fil des Heures",
      description: "一行目 二行目 三行目",
    });
  });

  it("DD-NEWS-030 120字ちょうどの本文は省略しない", async () => {
    const text = "あ".repeat(120);
    mockDetail.mockResolvedValue(buildArticle({ detailed_content: text }));

    const metadata = await generateMetadata({ params: params() });

    expect(metadata.description).toBe(text);
  });

  it("DD-NEWS-030 121字の本文は先頭120字に ... を付ける", async () => {
    const text = `${"あ".repeat(120)}い`;
    mockDetail.mockResolvedValue(buildArticle({ detailed_content: text }));

    const metadata = await generateMetadata({ params: params() });

    expect(metadata.description).toBe(`${"あ".repeat(120)}...`);
  });

  it("DD-NEWS-030 本文が空白と改行だけの時は固定の説明にする", async () => {
    mockDetail.mockResolvedValue(buildArticle({ detailed_content: " \n\t \n " }));

    const metadata = await generateMetadata({ params: params() });

    expect(metadata.title).toBe("春の展示会 | NEWS | Le Fil des Heures");
    expect(metadata.description).toBe(FALLBACK_DESCRIPTION);
  });

  it("DD-NEWS-030 メタの取り出しは id だけで呼び分類を渡さない", async () => {
    mockDetail.mockResolvedValue(buildArticle());

    await generateMetadata({ params: params("7") });

    expect(mockDetail).toHaveBeenCalledTimes(1);
    expect(mockDetail).toHaveBeenCalledWith("7");
  });
});

describe("NewsDetailPage", () => {
  it("DD-NEWS-030 searchParams が無い時は ALL で取り出し、戻りのリンクに分類を付けない", async () => {
    await renderPage({});

    expect(mockDetail).toHaveBeenCalledWith("42", { category: "ALL" });
    expect(mockNavigation).toHaveBeenCalledWith("42", { category: "ALL" });
    expect(breadcrumbNewsHref()).toBe("/news");
    expect(viewAllHrefs()).toEqual(["/news", "/news"]);
  });

  it("DD-NEWS-030 searchParams が空の時は ALL で取り出し、戻りのリンクに分類を付けない", async () => {
    await renderPage({ searchParams: Promise.resolve({}) });

    expect(mockDetail).toHaveBeenCalledWith("42", { category: "ALL" });
    expect(breadcrumbNewsHref()).toBe("/news");
    expect(viewAllHrefs()).toEqual(["/news", "/news"]);
  });

  it("DD-NEWS-030 分類が空白だけの時は引き継がず ALL で取り出す", async () => {
    await renderPage({ searchParams: Promise.resolve({ category: "  " }) });

    expect(mockDetail).toHaveBeenCalledWith("42", { category: "ALL" });
    expect(breadcrumbNewsHref()).toBe("/news");
  });

  it("DD-NEWS-030 小文字の分類は大文字にして取り出しとリンクに使う", async () => {
    await renderPage({
      searchParams: Promise.resolve({ category: "event" }),
      navigation: {
        prevArticle: { id: 41, title: "前の題" },
        nextArticle: null,
      },
    });

    expect(mockDetail).toHaveBeenCalledWith("42", { category: "EVENT" });
    expect(mockNavigation).toHaveBeenCalledWith("42", { category: "EVENT" });
    expect(breadcrumbNewsHref()).toBe("/news?category=EVENT");
    expect(viewAllHrefs()).toEqual([
      "/news?category=EVENT",
      "/news?category=EVENT",
    ]);
    for (const link of screen.getAllByRole("link", { name: "前の記事: 前の題" })) {
      expect(link).toHaveAttribute("href", "/news/41?category=EVENT");
    }
  });

  it("DD-NEWS-030 複数の分類は取り出しを ALL にし、重複を除いてリンクに引き継ぐ", async () => {
    await renderPage({
      searchParams: Promise.resolve({ category: "EVENT, store ,EVENT" }),
    });

    expect(mockDetail).toHaveBeenCalledWith("42", { category: "ALL" });
    expect(mockNavigation).toHaveBeenCalledWith("42", { category: "ALL" });
    expect(breadcrumbNewsHref()).toBe("/news?category=EVENT%2CSTORE");
    expect(viewAllHrefs()).toEqual([
      "/news?category=EVENT%2CSTORE",
      "/news?category=EVENT%2CSTORE",
    ]);
  });

  it("DD-NEWS-030 分類が ALL の時は引き継がず ALL で取り出す", async () => {
    await renderPage({ searchParams: Promise.resolve({ category: "ALL" }) });

    expect(mockDetail).toHaveBeenCalledWith("42", { category: "ALL" });
    expect(breadcrumbNewsHref()).toBe("/news");
  });

  it("DD-NEWS-030 許可の一覧に無い分類は引き継がず ALL で取り出す", async () => {
    await renderPage({ searchParams: Promise.resolve({ category: "INVALID" }) });

    expect(mockDetail).toHaveBeenCalledWith("42", { category: "ALL" });
    expect(breadcrumbNewsHref()).toBe("/news");
  });

  it("DD-NEWS-030 正しい値と無効な値が混じる時は正しい値だけを引き継ぐ", async () => {
    await renderPage({
      searchParams: Promise.resolve({ category: "INVALID,blog,ALL" }),
    });

    expect(mockDetail).toHaveBeenCalledWith("42", { category: "ALL" });
    expect(breadcrumbNewsHref()).toBe("/news?category=BLOG");
  });

  it("DD-NEWS-030 記事が無い時は notFound を呼び前後を取り出さない", async () => {
    mockDetail.mockResolvedValue(null);

    await expect(
      NewsDetailPage({
        params: params(),
        searchParams: Promise.resolve({ category: "EVENT" }),
      }),
    ).rejects.toThrow("NEXT_NOT_FOUND");

    expect(mockDetail).toHaveBeenCalledWith("42", { category: "EVENT" });
    expect(mockNotFound).toHaveBeenCalledTimes(1);
    expect(mockNavigation).not.toHaveBeenCalled();
  });

  it("DD-NEWS-030 前と次がある時は行き先の題を含むリンクを幅ごとに2つずつ出す", async () => {
    await renderPage({
      searchParams: Promise.resolve({ category: "STORE" }),
      navigation: {
        prevArticle: { id: 41, title: "前の題" },
        nextArticle: { id: 43, title: "次の題" },
      },
    });

    const prevLinks = screen.getAllByRole("link", { name: "前の記事: 前の題" });
    const nextLinks = screen.getAllByRole("link", { name: "次の記事: 次の題" });
    expect(prevLinks).toHaveLength(2);
    expect(nextLinks).toHaveLength(2);
    for (const link of prevLinks) {
      expect(link).toHaveAttribute("href", "/news/41?category=STORE");
      expect(link).toHaveTextContent("PREV");
    }
    for (const link of nextLinks) {
      expect(link).toHaveAttribute("href", "/news/43?category=STORE");
      expect(link).toHaveTextContent("NEXT");
    }
  });

  it("DD-NEWS-030 前も次も無い時は前後のリンクを出さず VIEW ALL だけを2つ出す", async () => {
    await renderPage({
      navigation: { prevArticle: null, nextArticle: null },
    });

    expect(screen.queryByRole("link", { name: /前の記事/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /次の記事/ })).toBeNull();
    expect(screen.queryByText("PREV")).toBeNull();
    expect(screen.queryByText("NEXT")).toBeNull();
    expect(viewAllHrefs()).toHaveLength(2);
  });

  it("DD-NEWS-030 次だけがある時は前の場所を空けて次のリンクだけを出す", async () => {
    await renderPage({
      navigation: { prevArticle: null, nextArticle: { id: 43, title: "次の題" } },
    });

    expect(screen.queryByRole("link", { name: /前の記事/ })).toBeNull();
    expect(screen.getAllByRole("link", { name: "次の記事: 次の題" })).toHaveLength(2);
  });

  it("DD-NEWS-030 本文を空行で段落に分け、段落の中の改行を残す", async () => {
    const { container } = await renderPage({
      article: buildArticle({ detailed_content: "a\n\nb\nc" }),
    });

    const paragraphs = container.querySelectorAll("p.whitespace-pre-line");
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0].textContent).toBe("a");
    expect(paragraphs[1].textContent).toBe("b\nc");
  });

  it("DD-NEWS-030 本文の HTML は文字として出し要素を作らない", async () => {
    const html = '<script>alert(1)</script><b>bold</b>';
    const { container } = await renderPage({
      article: buildArticle({ detailed_content: html }),
    });

    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.querySelector("p.whitespace-pre-line")?.textContent).toBe(html);
  });

  it("DD-NEWS-030 公開日を点で区切り、分類のリンクと題の現在地を出す", async () => {
    await renderPage({
      article: buildArticle({ category: "COLLABORATION" }),
      searchParams: Promise.resolve({ category: "EVENT,STORE" }),
    });

    expect(screen.getByText("2026.10.24")).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(
      within(nav).getByRole("link", { name: "COLLABORATION" }),
    ).toHaveAttribute("href", "/news?category=COLLABORATION");
    const current = within(nav).getByText("春の展示会");
    expect(current).toHaveAttribute("aria-current", "page");
    expect(
      screen.getByRole("heading", { level: 1, name: "春の展示会" }),
    ).toBeInTheDocument();
    expect(document.querySelector('[data-ui-tag-label="true"]')).toHaveTextContent(
      "COLLABORATION",
    );
  });

  it("DD-NEWS-030 署名済みの画像 URL があっても画像を描かない", async () => {
    const { container } = await renderPage({});

    expect(container.querySelector("img")).toBeNull();
  });
});

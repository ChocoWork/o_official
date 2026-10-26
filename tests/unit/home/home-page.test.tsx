import { render, screen, within } from "@testing-library/react";
import ReactDOM from "react-dom";

jest.mock("next/image", () => ({
  __esModule: true,
  default: (props: {
    src: string;
    alt: string;
    priority?: boolean;
    sizes?: string;
    fill?: boolean;
  }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={props.src}
      alt={props.alt}
      sizes={props.sizes}
      data-priority={props.priority ? "true" : "false"}
      data-fill={props.fill ? "true" : "false"}
    />
  ),
}));

jest.mock("@/components/animations/TextReveal", () => ({
  __esModule: true,
  default: (props: {
    as?: string;
    text: string;
    delay?: number;
    className?: string;
  }) => {
    const Tag = (props.as ?? "div") as "h1";
    return (
      <Tag
        data-testid="text-reveal"
        data-delay={props.delay}
        className={props.className}
      >
        {props.text}
      </Tag>
    );
  },
}));

jest.mock("@/features/look/components/PublicLookGrid", () => ({
  PublicLookGrid: jest.fn(
    (props: { variant: string; looks: unknown[]; totalCount: number }) => (
      <div
        data-testid="look-grid"
        data-variant={props.variant}
        data-count={props.looks.length}
        data-total={props.totalCount}
      />
    ),
  ),
}));
jest.mock("@/features/items/components/PublicItemGrid", () => ({
  PublicItemGrid: jest.fn(
    (props: { variant: string; items: unknown[]; totalCount: number }) => (
      <div
        data-testid="item-grid"
        data-variant={props.variant}
        data-count={props.items.length}
        data-total={props.totalCount}
      />
    ),
  ),
}));
jest.mock("@/features/news/components/PublicNewsGrid", () => ({
  PublicNewsGrid: jest.fn(
    (props: { variant: string; articles: unknown[]; totalCount: number }) => (
      <div
        data-testid="news-grid"
        data-variant={props.variant}
        data-count={props.articles.length}
        data-total={props.totalCount}
      />
    ),
  ),
}));
jest.mock("@/features/stockist/components/PublicStockistGrid", () => ({
  PublicStockistGrid: jest.fn(
    (props: { variant: string; stockists: unknown[] }) => (
      <div
        data-testid="stockist-grid"
        data-variant={props.variant}
        data-count={props.stockists.length}
      />
    ),
  ),
}));
jest.mock("@/features/search/components/SearchHomePreview", () => ({
  SearchHomePreview: () => <div data-testid="search-preview" />,
}));

jest.mock("@/lib/items/public", () => ({
  getPublishedItems: jest.fn(),
  getPublishedItemsCount: jest.fn(),
}));
jest.mock("@/lib/look/server", () => ({
  getPublishedLooks: jest.fn(),
  getPublishedLooksCount: jest.fn(),
}));
jest.mock("@/features/news/services/public", () => ({
  getPublishedNews: jest.fn(),
  getPublishedNewsCount: jest.fn(),
}));
jest.mock("@/features/stockist/services/public", () => ({
  getHomePublicStockists: jest.fn(),
}));

import Home, { generateMetadata } from "@/app/page";
import { PublicItemGrid } from "@/features/items/components/PublicItemGrid";
import { PublicLookGrid } from "@/features/look/components/PublicLookGrid";
import { PublicNewsGrid } from "@/features/news/components/PublicNewsGrid";
import { PublicStockistGrid } from "@/features/stockist/components/PublicStockistGrid";
import { getPublishedItems, getPublishedItemsCount } from "@/lib/items/public";
import { getPublishedLooks, getPublishedLooksCount } from "@/lib/look/server";
import {
  getPublishedNews,
  getPublishedNewsCount,
} from "@/features/news/services/public";
import { getHomePublicStockists } from "@/features/stockist/services/public";

const mockItems = getPublishedItems as jest.Mock;
const mockItemsCount = getPublishedItemsCount as jest.Mock;
const mockLooks = getPublishedLooks as jest.Mock;
const mockLooksCount = getPublishedLooksCount as jest.Mock;
const mockNews = getPublishedNews as jest.Mock;
const mockNewsCount = getPublishedNewsCount as jest.Mock;
const mockStockists = getHomePublicStockists as jest.Mock;

const mockItemGrid = PublicItemGrid as unknown as jest.Mock;
const mockLookGrid = PublicLookGrid as unknown as jest.Mock;
const mockNewsGrid = PublicNewsGrid as unknown as jest.Mock;
const mockStockistGrid = PublicStockistGrid as unknown as jest.Mock;

const BRAND = "Le Fil des Heures";
const DESCRIPTION =
  "Le Fil des Heuresの公式オンラインストア。時を紡ぐニュートラルモードな日常着を提案します。";

const ITEMS = [{ id: "i1" }, { id: "i2" }];
const LOOKS = [{ id: "l1" }];
const NEWS = [{ id: 1 }, { id: 2 }, { id: 3 }];
const STOCKISTS = [{ id: "s1" }, { id: "s2" }, { id: "s3" }, { id: "s4" }];

let preloadSpy: jest.SpyInstance;

function stubFetchers(
  overrides: {
    items?: unknown[];
    looks?: unknown[];
    news?: unknown[];
    stockists?: unknown[];
    itemTotal?: number;
    lookTotal?: number;
    newsTotal?: number;
  } = {},
) {
  mockItems.mockResolvedValue(overrides.items ?? ITEMS);
  mockLooks.mockResolvedValue(overrides.looks ?? LOOKS);
  mockNews.mockResolvedValue(overrides.news ?? NEWS);
  mockStockists.mockResolvedValue(overrides.stockists ?? STOCKISTS);
  mockItemsCount.mockResolvedValue(overrides.itemTotal ?? 21);
  mockLooksCount.mockResolvedValue(overrides.lookTotal ?? 9);
  mockNewsCount.mockResolvedValue(overrides.newsTotal ?? 7);
}

async function renderHome() {
  const element = await Home();
  return render(element);
}

beforeEach(() => {
  jest.clearAllMocks();
  preloadSpy = jest
    .spyOn(ReactDOM, "preload")
    .mockImplementation(() => undefined);
  stubFetchers();
});

afterEach(() => {
  preloadSpy.mockRestore();
});

describe("src/app/page.tsx", () => {
  it("DD-HOME-001 題・説明・OG を固定の値で返す", async () => {
    const metadata = await generateMetadata();

    expect(metadata.title).toBe(BRAND);
    expect(metadata.description).toBe(DESCRIPTION);
    expect(metadata.openGraph?.title).toBe(BRAND);
    expect(metadata.openGraph?.description).toBe(DESCRIPTION);
    expect(metadata.openGraph?.images).toEqual(["/mainphoto.png"]);
  });

  it("DD-HOME-001 取得の関数を決まった件数と引数で1回ずつ呼ぶ", async () => {
    await renderHome();

    expect(mockItems).toHaveBeenCalledTimes(1);
    expect(mockItems).toHaveBeenCalledWith(8);
    expect(mockLooks).toHaveBeenCalledTimes(1);
    expect(mockLooks).toHaveBeenCalledWith(8);
    expect(mockNews).toHaveBeenCalledTimes(1);
    expect(mockNews).toHaveBeenCalledWith({ limit: 6 });
    expect(mockStockists).toHaveBeenCalledTimes(1);
    expect(mockStockists).toHaveBeenCalledWith();
    expect(mockItemsCount).toHaveBeenCalledTimes(1);
    expect(mockLooksCount).toHaveBeenCalledTimes(1);
    expect(mockNewsCount).toHaveBeenCalledTimes(1);
  });

  it("DD-HOME-001 7つの取得を待ってから描き、遅い取得があっても全部の結果を使う", async () => {
    let resolveSlow: (value: unknown[]) => void = () => undefined;
    mockItems.mockReturnValue(
      new Promise<unknown[]>((resolve) => {
        resolveSlow = resolve;
      }),
    );
    let done = false;
    const pending = Home().then((element) => {
      done = true;
      return element;
    });

    // 解決済みの取得が全部片付く macrotask 1つ分を待っても、遅い1本があるうちは返らない
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(done).toBe(false);
    expect(preloadSpy).not.toHaveBeenCalled();

    resolveSlow(ITEMS);
    const element = await pending;
    expect(done).toBe(true);
    render(element);
    expect(screen.getByTestId("item-grid")).toHaveAttribute("data-count", "2");
  });

  it("DD-HOME-001 ヒーロー画像の先読みを1回だけ頼む", async () => {
    await renderHome();

    expect(preloadSpy).toHaveBeenCalledTimes(1);
    expect(preloadSpy).toHaveBeenCalledWith("/mainphoto.png", {
      as: "image",
    });
  });

  it("DD-HOME-001 ITEM・LOOK・NEWS の格子に variant と取った行と総数を渡す", async () => {
    await renderHome();

    expect(mockItemGrid.mock.calls[0][0]).toEqual({
      variant: "home",
      items: ITEMS,
      totalCount: 21,
    });
    expect(mockLookGrid.mock.calls[0][0]).toEqual({
      variant: "home",
      looks: LOOKS,
      totalCount: 9,
    });
    expect(mockNewsGrid.mock.calls[0][0]).toEqual({
      variant: "home",
      articles: NEWS,
      totalCount: 7,
    });
    expect(screen.getByTestId("item-grid")).toHaveAttribute(
      "data-variant",
      "home",
    );
    expect(screen.getByTestId("look-grid")).toHaveAttribute("data-total", "9");
    expect(screen.getByTestId("news-grid")).toHaveAttribute("data-total", "7");
  });

  it("DD-HOME-001 取扱店の格子に variant と取った行を渡す", async () => {
    await renderHome();

    expect(mockStockistGrid.mock.calls[0][0]).toEqual({
      variant: "home",
      stockists: STOCKISTS,
    });
    expect(screen.getByTestId("stockist-grid")).toHaveAttribute(
      "data-count",
      "4",
    );
  });

  it("DD-HOME-001 区画をヒーロー・検索・ITEM・LOOK・NEWS・ABOUT・取扱店の順に並べる", async () => {
    const { container } = await renderHome();

    const hero = container.querySelector("section") as HTMLElement;
    const sequence = [
      hero,
      screen.getByTestId("search-preview"),
      screen.getByTestId("item-grid"),
      screen.getByTestId("look-grid"),
      screen.getByTestId("news-grid"),
      container.querySelector("section#about") as HTMLElement,
      screen.getByTestId("stockist-grid"),
    ];

    sequence.slice(1).forEach((node, index) => {
      expect(node).not.toBeNull();
      expect(
        sequence[index].compareDocumentPosition(node) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });
  });

  it("DD-HOME-001 ヒーローにブランド名の h1 と優先の写真を出す", async () => {
    const { container } = await renderHome();

    const h1 = screen.getByRole("heading", { level: 1 });
    expect(h1).toHaveTextContent(BRAND);
    expect(h1).toHaveAttribute("data-delay", "100");
    expect(h1).toHaveClass("hero-title");

    const hero = container.querySelector("section") as HTMLElement;
    const photo = within(hero).getByAltText(
      "ニュートラルな日常着をまとう Le Fil des Heures のメインビジュアル",
    );
    expect(photo).toHaveAttribute("src", "/mainphoto.png");
    expect(photo).toHaveAttribute("data-priority", "true");
    expect(photo).toHaveAttribute("sizes", "(max-width: 1023px) 300vw, 100vw");
  });

  it("DD-HOME-001 暗くする重ねと SCROLL の印を読み上げから隠す", async () => {
    const { container } = await renderHome();

    const hero = container.querySelector("section") as HTMLElement;
    const hidden = hero.querySelectorAll('[aria-hidden="true"]');
    expect(hidden).toHaveLength(2);
    const overlay = hidden[0];
    expect(overlay).toHaveClass("bg-linear-to-b");
    const scroll = hidden[1];
    expect(scroll).toHaveTextContent("SCROLL");
    expect(scroll.querySelector(".hero-thread")).not.toBeNull();
  });

  it("DD-HOME-001 ABOUT に h2・考えの文2つ・3本柱・READ OUR STORY・画像を出す", async () => {
    const { container } = await renderHome();

    const about = container.querySelector("section#about") as HTMLElement;
    expect(about).not.toBeNull();
    expect(
      within(about).getByRole("heading", { level: 2, name: "ABOUT" }),
    ).toBeInTheDocument();
    expect(
      within(about).getByText(
        "長く着られる服だけをつくる。それが、唯一のこだわり。",
      ),
    ).toBeInTheDocument();
    expect(
      within(about).getByText("流行ではなく、タイムレスなシルエットと素材を。"),
    ).toBeInTheDocument();

    const pillars = within(about).getAllByRole("heading", { level: 3 });
    expect(pillars.map((h) => h.textContent)).toEqual([
      "TIMELSS & UNISEX",
      "NATURAL FIBERS",
      "MADE TO ORDER",
    ]);
    expect(within(about).getByText("タイムレス＆ユニセックス")).toBeVisible();
    expect(within(about).getByText("天然繊維100%")).toBeVisible();
    expect(within(about).getByText("国内受注生産")).toBeVisible();
    expect(
      within(about).getByText(
        "必要なときに、必要な人に、必要な分だけ。日本の技術を次世代に紡ぐ。",
      ),
    ).toBeVisible();

    const link = within(about).getByRole("link", { name: "READ OUR STORY" });
    expect(link).toHaveAttribute("href", "/about");

    const image = within(about).getByAltText("About Le Fil des Heures");
    expect(image).toHaveAttribute("src", "/about.png");
    expect(image).toHaveAttribute("data-fill", "true");
    expect(image).toHaveAttribute("data-priority", "false");
  });

  it("DD-HOME-001 取得の関数が空の配列と 0 を返しても例外を投げずヒーローと ABOUT を描く", async () => {
    stubFetchers({
      items: [],
      looks: [],
      news: [],
      stockists: [],
      itemTotal: 0,
      lookTotal: 0,
      newsTotal: 0,
    });

    const { container } = await renderHome();

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(BRAND);
    expect(container.querySelector("section#about")).not.toBeNull();
    expect(mockItemGrid.mock.calls[0][0]).toEqual({
      variant: "home",
      items: [],
      totalCount: 0,
    });
    expect(mockLookGrid.mock.calls[0][0]).toEqual({
      variant: "home",
      looks: [],
      totalCount: 0,
    });
    expect(mockNewsGrid.mock.calls[0][0]).toEqual({
      variant: "home",
      articles: [],
      totalCount: 0,
    });
    expect(mockStockistGrid.mock.calls[0][0]).toEqual({
      variant: "home",
      stockists: [],
    });
  });

  it("DD-HOME-001 NEWS の取得が reject してもホームは落ちず、ニュースの区画は空で描く（SEC-NEWS-020）", async () => {
    stubFetchers();
    mockNews.mockRejectedValue(new Error("fetch failed"));

    const { container } = await renderHome();

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(BRAND);
    expect(container.querySelector("section#about")).not.toBeNull();
    expect(mockNewsGrid.mock.calls[0][0]).toEqual({
      variant: "home",
      articles: [],
      totalCount: 7,
    });
    expect(mockItemGrid).toHaveBeenCalledTimes(1);
    expect(mockLookGrid).toHaveBeenCalledTimes(1);
    expect(mockStockistGrid).toHaveBeenCalledTimes(1);
    expect(preloadSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["商品", () => mockItems],
    ["LOOK", () => mockLooks],
    ["取扱店", () => mockStockists],
    ["商品の総数", () => mockItemsCount],
    ["LOOK の総数", () => mockLooksCount],
    ["NEWS の総数", () => mockNewsCount],
  ])(
    "DD-HOME-001 %s の取得が reject するとページ全体が reject し先読みも頼まない",
    async (_label, pick) => {
      pick().mockRejectedValue(new Error("fetch failed"));

      await expect(Home()).rejects.toThrow("fetch failed");
      expect(preloadSpy).not.toHaveBeenCalled();
    },
  );
});

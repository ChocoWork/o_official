import { render, screen, within } from "@testing-library/react";
import StoryPage, { generateMetadata } from "@/app/about/page";

function renderPage() {
  return render(<StoryPage />);
}

/** h3 の見出しを含む、原則1行の中身の枠（border-t を持つ div）を返す。 */
function principleFrame(heading: string): HTMLElement {
  const h3 = screen.getByRole("heading", { level: 3, name: heading });
  const frame = h3.parentElement;
  if (!frame) throw new Error(`frame not found: ${heading}`);
  return frame;
}

describe("ABOUT page.tsx", () => {
  it("DD-ABOUT-001 最後の原則（国内受注生産）の枠だけ下の罫線 border-b が付く", () => {
    renderPage();

    const frame = principleFrame("国内受注生産");
    expect(frame).toHaveClass("border-t");
    expect(frame).toHaveClass("border-b");
  });

  it("DD-ABOUT-001 最後でない原則の枠には border-b が付かず、border-t は付く", () => {
    renderPage();

    for (const heading of ["タイムレス・ユニセックス", "天然繊維"]) {
      const frame = principleFrame(heading);
      expect(frame).toHaveClass("border-t");
      expect(frame).not.toHaveClass("border-b");
    }
  });

  it("DD-ABOUT-001 3つの原則の番号・英語のラベル・日本語の見出しがこの順で出る", () => {
    const { container } = renderPage();

    const h3s = screen.getAllByRole("heading", { level: 3 });
    expect(h3s.map((h) => h.textContent)).toEqual([
      "タイムレス・ユニセックス",
      "天然繊維",
      "国内受注生産",
    ]);

    const numbers = Array.from(container.querySelectorAll("p.font-display")).filter(
      (p) => /^0[1-3]$/.test(p.textContent ?? ""),
    );
    expect(numbers.map((p) => p.textContent)).toEqual(["01", "02", "03"]);

    const labels = Array.from(
      container.querySelectorAll("p.about-secondary-title"),
    ).map((p) => p.textContent);
    expect(labels).toEqual([
      "TIMELESS / UNISEX",
      "NATURAL FIBERS",
      "DOMESTIC, MADE TO ORDER",
    ]);

    // 各原則の説明が、その行の h3 と同じ枠の中に出る
    expect(within(principleFrame("天然繊維")).getByText(/生地は天然繊維を中心に/)).toBeInTheDocument();
    expect(within(principleFrame("国内受注生産")).getByText(/すべて、国内で受注生産/)).toBeInTheDocument();
    expect(
      within(principleFrame("タイムレス・ユニセックス")).getByText(/どの時代でも手に取りたくなる服を/),
    ).toBeInTheDocument();
  });

  it("DD-ABOUT-001 ブランドの思想・なぜつくるか・商品設計思想の本文が出る", () => {
    renderPage();

    expect(screen.getByText(/ブランド名は「時の糸」を意味します/)).toBeInTheDocument();
    expect(screen.getByText(/流行を否定はしません/)).toBeInTheDocument();
    expect(screen.getByText(/シルエット、生地、縫製、素材、そして生産方法まで/)).toBeInTheDocument();
    expect(screen.getByText(/低価格。大量生産。機能性。/)).toBeInTheDocument();
    expect(screen.getByText(/その妥協をなくしたいと思いました/)).toBeInTheDocument();
    expect(screen.getByText(/つくり手の技術継承や自然環境を考えたものづくり/)).toBeInTheDocument();
    expect(screen.getByText(/毎日に寄り添うベーシックも、もちろんそろえています/)).toBeInTheDocument();
  });

  it("DD-ABOUT-001 創業者の言葉と締めの一文が出る", () => {
    renderPage();

    expect(screen.getByText("— Founder, Le Fil des Heures")).toBeInTheDocument();
    expect(screen.getByText("時を超えて価値の続く服を。")).toBeInTheDocument();
  });

  it("DD-ABOUT-001 題・説明・OG が固定の値で返る", async () => {
    const metadata = await generateMetadata();

    expect(metadata.title).toBe("ABOUT | Le Fil des Heures");
    expect(metadata.description).toContain("Le Fil des Heures");
    expect(metadata.openGraph?.title).toBe(metadata.title);
    expect(metadata.openGraph?.description).toContain("Le Fil des Heures");
    expect(metadata.openGraph?.description).not.toBe(metadata.description);
    expect(metadata.openGraph?.images).toEqual(["/about.png"]);
  });

  it("DD-ABOUT-001 OG の画像は相対の道で、外のオリジンを指さない", async () => {
    const metadata = await generateMetadata();

    const images = metadata.openGraph?.images as string[];
    expect(images).toHaveLength(1);
    for (const image of images) {
      expect(image.startsWith("/")).toBe(true);
      expect(image.startsWith("//")).toBe(false);
      expect(image).not.toMatch(/^https?:/);
    }
  });

  it("DD-ABOUT-001 metadata の関数もページの関数も fetch を呼ばない", async () => {
    const original = global.fetch;
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    try {
      await generateMetadata();
      renderPage();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      global.fetch = original;
    }
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * DD-HOME-004: `/ui` の見本ページは外部の画像を使わない。
 * CSP の `img-src` と `next.config.ts` の `remotePatterns` から外す物
 * （`readdy.ai`・`placehold.co`）を、見本ページが使っていないことを
 * ソースの文字列で固定する。
 */
const source = readFileSync(
  join(process.cwd(), "src", "app", "ui", "page.tsx"),
  "utf8",
);

describe("/ui の見本ページは外部の画像を使わない", () => {
  it("DD-HOME-004 CSP と remotePatterns から外す host の文字列を持たない", () => {
    expect(source).not.toContain("readdy.ai");
    expect(source).not.toContain("placehold.co");
  });

  it("DD-HOME-004 https:// で始まる文字列は地図の埋め込みだけで、画像の URL は無い", () => {
    const urls = source.match(/https?:\/\/[^"'`\s)]+/g) ?? [];
    const imageUrls = urls.filter(
      (url) => !url.startsWith("https://www.google.com/maps/embed"),
    );
    expect(imageUrls).toEqual([]);
  });

  it("DD-HOME-004 画像の src に書いた文字列はすべて / で始まる手元の画像", () => {
    const srcs = [
      ...source.matchAll(/\bsrc(?:\s*[:=]\s*)\{?\s*"([^"]*)"/g),
    ].map((match) => match[1]);
    const carousel = source.match(/const carouselImages = \[([\s\S]*?)\];/);
    const carouselSrcs = [...(carousel?.[1] ?? "").matchAll(/"([^"]*)"/g)].map(
      (match) => match[1],
    );

    expect(carouselSrcs).toHaveLength(3);
    for (const src of [...srcs, ...carouselSrcs]) {
      expect(src.startsWith("/")).toBe(true);
    }
    // cardItems の 3 枚と Avatar の 1 枚と carousel の 3 枚（合計 7 か所）を見る
    expect(srcs.length + carouselSrcs.length).toBeGreaterThanOrEqual(7);
  });
});

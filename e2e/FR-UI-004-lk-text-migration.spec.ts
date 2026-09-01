import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * FREQ-318: 文字サイズの二系統（Tailwind の名前付きスケールと .lk-text-*）を
 * 段階的に一本化する。
 *
 * typography.css は @layer の外にあり、Tailwind の @layer utilities に常に優先する。
 * そのため同じ要素に .lk-text-xs と text-sm を付けると、宣言順と無関係に text-sm が
 * 黙って無視される。AC-01 はその壊れ方が生まれないよう先回りで止めるもの。
 *
 * 移行は完了済み（633 箇所）。AC-02 は src 全体で Tailwind の名前付き font-size を
 * 禁止するので、text-sm のような書き方が 1 箇所でも入った時点で落ちる。
 *
 * 新しく font-size を指定するときは .lk-text-* を使う。対応は名前どうしではなく
 * 実寸の近い段で取る（text-xs → lk-text-3xs / text-sm → lk-text-sm /
 * text-base → lk-text-lg / text-lg → lk-text-2xl / text-xl → lk-text-4xl /
 * text-2xl → lk-text-7xl）。名前どおりに text-xs → lk-text-xs とすると約 11% 拡大する。
 * CSS 側で @apply を使っている箇所は .lk-text-* を適用できないので、
 * font-size: var(--lk-size-*) を直接書く。
 */

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
] as const;

/**
 * .lk-text-* が実際に効いていることを画面で確かめるページ。
 *
 * データ駆動のページ（ホームや一覧）は取得結果によって .lk-text-* を持つ要素が
 * 1 つも描画されないことがあり、検査が空振りする。静的なショーケースだけを対象にする。
 * クラスと --lk-size-* の対応そのものは FR-UI-003 が全 20 段について検証しており、
 * Tailwind の名前付きスケールが残っていないことは AC-02 が src 全体で保証している。
 */
const MIGRATED_PAGES = ['/ui', '/loading'] as const;

/**
 * Tailwind が font-size を生成する名前付きキー。
 * text-center / text-white / text-[#474747] のような font-size でない text-* は対象外。
 */
const TAILWIND_SIZES = ['xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl', '6xl', '7xl', '8xl', '9xl'];

/** バリアント修飾（sm: / lg: / [&_td]: など）が付いていても拾う。 */
const TAILWIND_SIZE_PATTERN = new RegExp(
  String.raw`(?:^|[\s"'\`{(,])((?:[a-z0-9-]+:|\[[^\]]*\]:)*)text-(${TAILWIND_SIZES.join('|')})(?![\w-])`,
);

const LK_TEXT_PATTERN = /(?:^|[\s"'`{(,])(?:(?:[a-z0-9-]+:|\[[^\]]*\]:)*)lk-text-[a-z0-9]+(?![\w-])/;

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectSourceFiles(full, out);
    else if (/\.(tsx?|css)$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * コメント中の説明文（対応表など）をクラス指定と誤判定しないよう取り除く。
 * 行コメントは行頭のものだけを対象にして、URL の "//" を巻き込まない。
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
}

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

test.describe('FR-UI-004 文字サイズ二系統の段階的統合（静的検査）', () => {
  test('FREQ-318-AC-01: 同一要素で .lk-text-* と Tailwind の font-size を併用していない', () => {
    const offenders: string[] = [];

    for (const file of collectSourceFiles(join(process.cwd(), 'src'))) {
      const source = stripComments(readFileSync(file, 'utf8'));
      // className={...} / class="..." を多行・cn() 呼び出しごと取り出す
      for (const match of source.matchAll(
        /(?:className|class)\s*=\s*(?:"([^"]*)"|\{([\s\S]*?)\}\s*(?=[\s/>]))/g,
      )) {
        const value = match[1] ?? match[2] ?? '';
        if (LK_TEXT_PATTERN.test(value) && TAILWIND_SIZE_PATTERN.test(value)) {
          offenders.push(`${toPosix(relative(process.cwd(), file))}: ${value.replace(/\s+/g, ' ').slice(0, 120)}`);
        }
      }
    }

    expect(
      offenders,
      `.lk-text-* と Tailwind の font-size は同じ要素に付けない（layer 外が勝つため Tailwind 側が黙って無視される）:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  test('FREQ-318-AC-02: src 配下に Tailwind の名前付き font-size が残っていない', () => {
    const offenders: string[] = [];

    for (const file of collectSourceFiles(join(process.cwd(), 'src'))) {
      stripComments(readFileSync(file, 'utf8'))
        .split(/\r?\n/)
        .forEach((line, index) => {
          const hit = TAILWIND_SIZE_PATTERN.exec(line);
          if (hit) {
            offenders.push(`${toPosix(relative(process.cwd(), file))}:${index + 1}: ${hit[0].trim()}`);
          }
        });
    }

    expect(
      offenders,
      `font-size は .lk-text-* で指定する（CSS の @apply 内は font-size: var(--lk-size-*) を直接書く）:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});

test.describe('FR-UI-004 移行済みページで .lk-text-* が効いている', () => {
  for (const viewport of VIEWPORTS) {
    for (const path of MIGRATED_PAGES) {
      test(`FREQ-318-AC-03: ${path} (${viewport.name}) の .lk-text-* が --lk-size-* と一致する`, async ({
        page,
      }) => {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.goto(path);
        await page.waitForLoadState('networkidle');

        const mismatches = await page.evaluate(() => {
          // --lk-size-* は calc() を返すので getPropertyValue の文字列は数値化できない。
          // var() を当てたプローブ要素の computed font-size を「期待値」として実測する。
          const probe = document.createElement("div");
          probe.style.position = "absolute";
          probe.style.visibility = "hidden";
          document.body.appendChild(probe);

          const expectedFor = (token: string): number => {
            probe.style.fontSize = `var(--lk-size-${token})`;
            return parseFloat(getComputedStyle(probe).fontSize);
          };

          const results: Array<{ token: string; actual: number; expected: number }> = [];
          const seen = new Set<string>();

          for (const element of Array.from(document.querySelectorAll<HTMLElement>('[class*="lk-text-"]'))) {
            const token = Array.from(element.classList)
              .find((name) => name.startsWith("lk-text-"))
              ?.replace("lk-text-", "");
            if (!token || seen.has(token)) continue;
            seen.add(token);

            const expected = expectedFor(token);
            const actual = parseFloat(getComputedStyle(element).fontSize);
            if (!Number.isFinite(expected)) {
              results.push({ token, actual, expected: Number.NaN });
              continue;
            }
            if (Math.abs(actual - expected) > 0.5) results.push({ token, actual, expected });
          }

          probe.remove();
          // トークンが 1 つも見つからないのは「移行できている」ではなく検査の空振り。
          if (seen.size === 0) results.push({ token: "(no .lk-text-* found)", actual: 0, expected: 0 });
          return results;
        });
        expect(
          mismatches,
          `computed font-size が --lk-size-* と食い違う:\n${JSON.stringify(mismatches, null, 2)}`,
        ).toEqual([]);
      });
    }
  }
});

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * FREQ-314: font-size を --lk-size-* 由来の .lk-text-* クラスに一本化する。
 *
 * FREQ-311 までの実装には `text-2.75` のような数値クラスが混ざっていた。
 * Tailwind v4 の font-size は名前付きキー（xs/sm/base/…）しか解決しないため、
 * これらは CSS を 1 行も生成せず、親のサイズを黙って継承して崩れる。
 * 静的検査（AC-03）はその再発を止めるためのもの。
 */

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 900 },
] as const;

const SCALE = [
  '8xs',
  '7xs',
  '6xs',
  '5xs',
  '4xs',
  '3xs',
  '2xs',
  'xs',
  'sm',
  'md',
  'lg',
  'xl',
  '2xl',
  '3xl',
  '4xl',
  '5xl',
  '6xl',
  '7xl',
  '8xl',
  '9xl',
] as const;

/** SectionTitle が lg（1024px）で段を上げる境界。 */
const SECTION_TITLE_BREAKPOINT = 1024;

/**
 * `.lk-text-<token>` を当てた要素と、`font-size: var(--lk-size-<token>)` を
 * 直接指定した要素の computed font-size を返す。
 * 親に極端な font-size を置くので、クラスが CSS を生成していなければ
 * 継承値（＝親の値）が返り、トークン値と大きく食い違う。
 */
async function measureScale(page: import('@playwright/test').Page) {
  return page.evaluate((tokens: readonly string[]) => {
    const host = document.createElement('div');
    host.style.fontSize = '50px';
    host.style.position = 'absolute';
    host.style.visibility = 'hidden';
    document.body.appendChild(host);

    const result = tokens.map((token) => {
      const viaClass = document.createElement('span');
      viaClass.className = `lk-text-${token}`;
      viaClass.textContent = 'M';

      const viaToken = document.createElement('span');
      viaToken.style.fontSize = `var(--lk-size-${token})`;
      viaToken.textContent = 'M';

      host.append(viaClass, viaToken);

      const measured = {
        token,
        klass: Number.parseFloat(getComputedStyle(viaClass).fontSize),
        expected: Number.parseFloat(getComputedStyle(viaToken).fontSize),
        inherited: 50,
      };

      viaClass.remove();
      viaToken.remove();
      return measured;
    });

    host.remove();
    return result;
  }, SCALE);
}

/** `font-size: var(--lk-size-<token>)` の実測 px。 */
async function tokenPx(
  page: import('@playwright/test').Page,
  token: string,
): Promise<number> {
  return page.evaluate((name: string) => {
    const probe = document.createElement('span');
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    probe.style.fontSize = `var(--lk-size-${name})`;
    document.body.appendChild(probe);
    const px = Number.parseFloat(getComputedStyle(probe).fontSize);
    probe.remove();
    return px;
  }, token);
}

test.describe('FR-UI-003 テキストサイズの --lk-size-* 一本化', () => {
  for (const viewport of VIEWPORTS) {
    test(`${viewport.name}（${viewport.width}px）で .lk-text-* が全段 --lk-size-* を返す`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      // AC-01: 20 段すべてが対応する --lk-size-* と一致し、親からの継承値ではない
      const measurements = await measureScale(page);
      expect(measurements).toHaveLength(SCALE.length);

      for (const { token, klass, expected, inherited } of measurements) {
        expect(expected, `--lk-size-${token} が解決されていない`).toBeGreaterThan(0);
        expect(
          Math.abs(klass - expected),
          `.lk-text-${token} が ${klass}px（期待 ${expected}px）`,
        ).toBeLessThanOrEqual(0.5);
        expect(
          Math.abs(klass - inherited),
          `.lk-text-${token} が親の継承値のまま（CSS 未生成の疑い）`,
        ).toBeGreaterThan(0.5);
      }

      // スケールが単調増加であること（段の取り違えを検出する）
      for (let i = 1; i < measurements.length; i += 1) {
        expect(
          measurements[i].expected,
          `--lk-size-${measurements[i].token} が ${measurements[i - 1].token} 以下`,
        ).toBeGreaterThan(measurements[i - 1].expected);
      }
    });

    test(`${viewport.name}（${viewport.width}px）でセクション見出しがスケール上の段を使う`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      // AC-02: 1024px 未満は --lk-size-4xl、以上は --lk-size-9xl
      const heading = page.locator('.section-title__heading').first();
      await expect(heading).toBeVisible();

      const token = viewport.width >= SECTION_TITLE_BREAKPOINT ? '9xl' : '4xl';
      const expected = await tokenPx(page, token);
      const actual = await heading.evaluate((el) =>
        Number.parseFloat(getComputedStyle(el).fontSize),
      );

      expect(expected).toBeGreaterThan(0);
      expect(
        Math.abs(actual - expected),
        `セクション見出しが ${actual}px（期待 --lk-size-${token} = ${expected}px）`,
      ).toBeLessThanOrEqual(0.5);
    });
  }
});

test.describe('FR-UI-003 font-size の直書き禁止（静的検査）', () => {
  test('src 配下に px 直書き・Tailwind の数値 text-* が残っていない', async () => {
    const root = join(process.cwd(), 'src');

    function collect(dir: string, out: string[] = []): string[] {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) collect(full, out);
        else if (/\.(tsx?|css)$/.test(entry)) out.push(full);
      }
      return out;
    }

    // text-2.75 のような数値クラス（Tailwind は font-size を生成しない）と
    // text-[11px] のような px 直書き。variant 修飾つきも拾う。
    const classPattern =
      /(?<![\w-])([a-z0-9-]+:)?text-(\d+(\.\d+)?|\[[\d.]+px\])(?![\w.-])/;
    // CSS 側の px 直書き。
    const cssPattern = /font-size:\s*\d+(\.\d+)?px/;
    // インライン style での px 直書き。
    const inlinePattern = /fontSize:\s*["'`]\s*\d+(\.\d+)?px/;

    const offenders: string[] = [];
    for (const file of collect(root)) {
      const source = readFileSync(file, 'utf8');
      source.split(/\r?\n/).forEach((line, index) => {
        const hit =
          classPattern.exec(line) ??
          (file.endsWith('.css') ? cssPattern.exec(line) : null) ??
          inlinePattern.exec(line);
        if (hit) {
          offenders.push(`${file}:${index + 1}: ${hit[0]}`);
        }
      });
    }

    // AC-03
    expect(offenders, `font-size は .lk-text-* で指定する:\n${offenders.join('\n')}`).toEqual(
      [],
    );
  });
});

/**
 * @jest-environment node
 *
 * DD-HOME-004: `next.config.ts` の `images` は、自分のプロジェクトの署名つきの道だけを
 * `/_next/image` に通し、最適化の画像のキャッシュを 3600 秒にする。
 * 環境変数を差し替えて設定を読み直し、`remotePatterns` を固定する。
 */

type RemotePattern = {
  protocol?: string;
  hostname: string;
  port?: string;
  pathname?: string;
};

type LoadedImages = {
  dangerouslyAllowLocalIP?: boolean;
  minimumCacheTTL?: number;
  remotePatterns?: RemotePattern[];
};

const ENV_KEYS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_URL",
  "NEXT_PUBLIC_SITE_URL",
  "APP_ALLOWED_ORIGINS",
  "VERCEL_ENV",
  "NEXT_BUILD_SKIP_CHECKS",
] as const;

function loadImages(env: Partial<Record<(typeof ENV_KEYS)[number], string>>): LoadedImages {
  const saved: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  Object.assign(process.env, env);
  try {
    let images: LoadedImages = {};
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const loaded = require("../../next.config") as { default: { images?: LoadedImages } };
      images = loaded.default.images ?? {};
    });
    return images;
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  }
}

describe("next.config.ts の images", () => {
  it("DD-HOME-004 本番の Supabase の URL なら、その host 1 つの署名つきの道だけを許す", () => {
    const images = loadImages({ NEXT_PUBLIC_SUPABASE_URL: "https://abcd1234.supabase.co" });

    expect(images.remotePatterns).toEqual([
      {
        protocol: "https",
        hostname: "abcd1234.supabase.co",
        port: "",
        pathname: "/storage/v1/object/sign/**",
      },
    ]);
    expect(images.dangerouslyAllowLocalIP).toBeUndefined();
  });

  it("DD-HOME-004 手元の Supabase の URL なら、手元の枝だけを許し、手元の IP を許す", () => {
    const images = loadImages({ NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321" });

    expect(images.remotePatterns).toEqual([
      {
        protocol: "http",
        hostname: "127.0.0.1",
        port: "54321",
        pathname: "/storage/v1/object/**",
      },
    ]);
    expect(images.dangerouslyAllowLocalIP).toBe(true);
  });

  it.each([
    ["本番", { NEXT_PUBLIC_SUPABASE_URL: "https://abcd1234.supabase.co" }],
    ["手元", { NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321" }],
    ["環境変数なし", {}],
  ] as const)("DD-HOME-004 %s: 使っていない host を許さない", (_label, env) => {
    const patterns = loadImages({ ...env }).remotePatterns ?? [];
    const hostnames = patterns.map((pattern) => pattern.hostname);

    expect(hostnames).not.toContain("placehold.co");
    expect(hostnames).not.toContain("readdy.ai");
    expect(hostnames).not.toContain("public.readdy.ai");
    expect(hostnames).not.toContain("*.supabase.co");
  });

  it.each([
    ["本番", { NEXT_PUBLIC_SUPABASE_URL: "https://abcd1234.supabase.co" }],
    ["手元", { NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321" }],
    ["環境変数なし", {}],
  ] as const)("DD-HOME-004 %s: 最適化の画像のキャッシュは 3600 秒", (_label, env) => {
    expect(loadImages({ ...env }).minimumCacheTTL).toBe(3600);
  });

  it("DD-HOME-004 環境変数が無くても例外を投げず、Supabase の枝は 0 件", () => {
    const images = loadImages({});

    expect(images.remotePatterns).toEqual([]);
    expect(images.dangerouslyAllowLocalIP).toBeUndefined();
  });
});

describe("next.config.ts の読み込み時の環境変数の確かめ", () => {
  it("DD-ABOUT-002 VERCEL_ENV=production で NEXT_PUBLIC_SITE_URL が無ければ、読み込みが落ちる", () => {
    expect(() =>
      loadImages({ VERCEL_ENV: "production", NEXT_PUBLIC_SUPABASE_URL: "https://abcd1234.supabase.co" }),
    ).toThrow(/NEXT_PUBLIC_SITE_URL/);
  });

  it("DD-ABOUT-002 VERCEL_ENV=production で 3 つとも在れば、読み込める", () => {
    const images = loadImages({
      VERCEL_ENV: "production",
      NEXT_PUBLIC_SITE_URL: "https://shop.example.com",
      NEXT_PUBLIC_SUPABASE_URL: "https://abcd1234.supabase.co",
      APP_ALLOWED_ORIGINS: "https://shop.example.com",
    });

    expect(images.remotePatterns).toHaveLength(1);
  });

  it("DD-ABOUT-002 VERCEL_ENV=production で APP_ALLOWED_ORIGINS が無ければ、読み込みが落ちる（SEC-ABOUT-007-AC-02）", () => {
    expect(() =>
      loadImages({
        VERCEL_ENV: "production",
        NEXT_PUBLIC_SITE_URL: "https://shop.example.com",
        NEXT_PUBLIC_SUPABASE_URL: "https://abcd1234.supabase.co",
      }),
    ).toThrow(/APP_ALLOWED_ORIGINS/);
  });

  it("DD-ABOUT-002 2 つの Supabase の URL が別の origin なら、VERCEL_ENV が無くても読み込みが落ちる", () => {
    expect(() =>
      loadImages({
        NEXT_PUBLIC_SUPABASE_URL: "https://aaaa1111.supabase.co",
        SUPABASE_URL: "https://bbbb2222.supabase.co",
      }),
    ).toThrow(/SUPABASE_URL/);
  });

  it("DD-ABOUT-002 VERCEL_ENV が無ければ、必須の変数が無くても読み込める（E2E の本番ビルド）", () => {
    expect(() => loadImages({})).not.toThrow();
  });
});

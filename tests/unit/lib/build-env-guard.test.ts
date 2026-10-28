/**
 * @jest-environment node
 *
 * DD-ABOUT-002: 本番のビルドで必須の環境変数（サイトの URL・Supabase の URL）が無ければ落とし、
 * 2 つの Supabase の URL が別の origin を指す設定も落とす。落とす時の文に値を載せない。
 */
import { assertBuildEnv } from "../../../src/lib/build-env-guard";

const PRODUCTION = {
  VERCEL_ENV: "production",
  NEXT_PUBLIC_SITE_URL: "https://shop.example.com",
  NEXT_PUBLIC_SUPABASE_URL: "https://abcd1234.supabase.co",
} as const;

describe("assertBuildEnv", () => {
  describe("VERCEL_ENV=production の必須の確かめ", () => {
    it("DD-ABOUT-002 2 つとも在れば通る", () => {
      expect(() => assertBuildEnv({ ...PRODUCTION })).not.toThrow();
    });

    it("DD-ABOUT-002 NEXT_PUBLIC_SITE_URL が無ければ、変数名を名指しして落とす", () => {
      const { NEXT_PUBLIC_SITE_URL: _omitted, ...env } = PRODUCTION;
      void _omitted;

      expect(() => assertBuildEnv(env)).toThrow(/NEXT_PUBLIC_SITE_URL/);
    });

    it("DD-ABOUT-002 NEXT_PUBLIC_SITE_URL が空白だけでも、変数名を名指しして落とす", () => {
      expect(() => assertBuildEnv({ ...PRODUCTION, NEXT_PUBLIC_SITE_URL: "   " })).toThrow(/NEXT_PUBLIC_SITE_URL/);
    });

    it("DD-ABOUT-002 NEXT_PUBLIC_SUPABASE_URL が無ければ、変数名を名指しして落とす", () => {
      const { NEXT_PUBLIC_SUPABASE_URL: _omitted, ...env } = PRODUCTION;
      void _omitted;

      expect(() => assertBuildEnv(env)).toThrow(/NEXT_PUBLIC_SUPABASE_URL/);
    });

    it("DD-ABOUT-002 落とす時の文に URL の値を載せない", () => {
      let message = "";
      try {
        assertBuildEnv({ VERCEL_ENV: "production", NEXT_PUBLIC_SUPABASE_URL: "https://abcd1234.supabase.co" });
      } catch (error) {
        message = (error as Error).message;
      }

      expect(message).toContain("NEXT_PUBLIC_SITE_URL");
      expect(message).not.toContain("abcd1234");
    });

    it.each([["preview"], [undefined], [""]])(
      "DD-ABOUT-002 VERCEL_ENV=%s なら、2 つとも無くても通る",
      (vercelEnv) => {
        expect(() => assertBuildEnv({ VERCEL_ENV: vercelEnv })).not.toThrow();
      },
    );

    it("DD-ABOUT-002 NODE_ENV=production だけでは落とさない（E2E の本番ビルドを止めない）", () => {
      expect(() => assertBuildEnv({ NODE_ENV: "production" })).not.toThrow();
    });
  });

  describe("2 つの Supabase の URL の origin", () => {
    it("DD-ABOUT-002 別の origin なら、VERCEL_ENV が無くても両方の変数名を名指しして落とす", () => {
      expect(() =>
        assertBuildEnv({
          NEXT_PUBLIC_SUPABASE_URL: "https://aaaa1111.supabase.co",
          SUPABASE_URL: "https://bbbb2222.supabase.co",
        }),
      ).toThrow(/NEXT_PUBLIC_SUPABASE_URL.*SUPABASE_URL|SUPABASE_URL.*NEXT_PUBLIC_SUPABASE_URL/);
    });

    it("DD-ABOUT-002 別の origin で落とす時の文に URL の値を載せない", () => {
      let message = "";
      try {
        assertBuildEnv({
          NEXT_PUBLIC_SUPABASE_URL: "https://aaaa1111.supabase.co",
          SUPABASE_URL: "https://bbbb2222.supabase.co",
        });
      } catch (error) {
        message = (error as Error).message;
      }

      expect(message).not.toContain("aaaa1111");
      expect(message).not.toContain("bbbb2222");
    });

    it("DD-ABOUT-002 末尾の / やパスが違うだけで origin が同じなら通る", () => {
      expect(() =>
        assertBuildEnv({
          NEXT_PUBLIC_SUPABASE_URL: "https://abcd1234.supabase.co/",
          SUPABASE_URL: "https://abcd1234.supabase.co/rest/v1",
        }),
      ).not.toThrow();
    });

    it("DD-ABOUT-002 ポートが違えば別の origin として落とす", () => {
      expect(() =>
        assertBuildEnv({
          NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
          SUPABASE_URL: "http://127.0.0.1:54322",
        }),
      ).toThrow(/SUPABASE_URL/);
    });

    it("DD-ABOUT-002 手元の Supabase（127.0.0.1:54321）が両方なら通る", () => {
      expect(() =>
        assertBuildEnv({
          NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
          SUPABASE_URL: "http://127.0.0.1:54321",
        }),
      ).not.toThrow();
    });

    it.each([
      ["NEXT_PUBLIC_SUPABASE_URL だけ", { NEXT_PUBLIC_SUPABASE_URL: "https://abcd1234.supabase.co" }],
      ["SUPABASE_URL だけ", { SUPABASE_URL: "https://abcd1234.supabase.co" }],
    ] as const)("DD-ABOUT-002 %s なら通る", (_label, env) => {
      expect(() => assertBuildEnv({ ...env })).not.toThrow();
    });

    it("DD-ABOUT-002 URL として読めない値は、この確かめでは何もしない", () => {
      expect(() =>
        assertBuildEnv({
          NEXT_PUBLIC_SUPABASE_URL: "not a url",
          SUPABASE_URL: "https://abcd1234.supabase.co",
        }),
      ).not.toThrow();
    });
  });
});

import {
  getPublishedLookById,
  getPublishedLooks,
  getPublishedLooksCount,
} from "@/lib/look/server";
import {
  createPublicClient,
  createServiceRoleClient,
} from "@/lib/supabase/server";
import { signLookImageUrls } from "@/lib/storage/look-images";
import { signItemImageUrl } from "@/lib/storage/item-images";

jest.mock("@/lib/supabase/server", () => ({
  createPublicClient: jest.fn(),
  createServiceRoleClient: jest.fn(),
}));
jest.mock("@/lib/storage/look-images", () => ({
  signLookImageUrls: jest.fn(),
}));
jest.mock("@/lib/storage/item-images", () => ({
  signItemImageUrl: jest.fn(),
}));

type QueryResult = {
  data?: unknown;
  error?: unknown;
  count?: number | null;
};

type Builder = {
  table: string;
  calls: Array<[string, unknown[]]>;
  select: jest.Mock;
  eq: jest.Mock;
  order: jest.Mock;
  limit: jest.Mock;
  in: jest.Mock;
  maybeSingle: jest.Mock;
  then: (
    resolve: (value: QueryResult) => unknown,
    reject?: (reason: unknown) => unknown,
  ) => Promise<unknown>;
};

const mockCreatePublicClient = createPublicClient as jest.Mock;
const mockCreateServiceRoleClient = createServiceRoleClient as jest.Mock;
const mockSignLookImageUrls = signLookImageUrls as jest.Mock;
const mockSignItemImageUrl = signItemImageUrl as jest.Mock;

const serviceClient = { service: true };
let builders: Builder[];
let results: Record<string, QueryResult>;
let consoleErrorSpy: jest.SpyInstance;

function createBuilder(table: string): Builder {
  const calls: Array<[string, unknown[]]> = [];
  const builder = { table, calls } as Builder;
  const chain = (name: string) =>
    jest.fn((...args: unknown[]) => {
      calls.push([name, args]);
      return builder;
    });
  builder.select = chain("select");
  builder.eq = chain("eq");
  builder.order = chain("order");
  builder.limit = chain("limit");
  builder.in = chain("in");
  builder.maybeSingle = jest.fn(() => {
    calls.push(["maybeSingle", []]);
    return Promise.resolve(results[table]);
  });
  builder.then = (resolve, reject) =>
    Promise.resolve(results[table]).then(resolve, reject);
  return builder;
}

function buildersFor(table: string): Builder[] {
  return builders.filter((builder) => builder.table === table);
}

function callsOf(builder: Builder, name: string): unknown[][] {
  return builder.calls.filter(([n]) => n === name).map(([, args]) => args);
}

function lookRow(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    season_year: 2026,
    season_type: "SS",
    theme: `theme-${id}`,
    theme_description: `desc-${id}`,
    image_urls: [`raw-${id}-a`, `raw-${id}-b`],
    created_at: `2026-01-0${id}T00:00:00Z`,
    ...overrides,
  };
}

function itemRow(id: number) {
  return {
    id,
    category: `cat-${id}`,
    name: `item-${id}`,
    price: id * 1000,
    image_url: `raw-item-${id}`,
  };
}

function linkedItem(id: number) {
  return {
    category: `cat-${id}`,
    id,
    name: `item-${id}`,
    price: id * 1000,
    imageUrl: `signed-raw-item-${id}`,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  builders = [];
  results = {};
  consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

  const publicClient = {
    from: jest.fn((table: string) => {
      const builder = createBuilder(table);
      builders.push(builder);
      return builder;
    }),
  };
  mockCreatePublicClient.mockResolvedValue(publicClient);
  mockCreateServiceRoleClient.mockResolvedValue(serviceClient);
  mockSignLookImageUrls.mockImplementation(
    async (_client: unknown, urls: string[]) =>
      urls.map((url) => `signed-${url}`),
  );
  mockSignItemImageUrl.mockImplementation(
    async (_client: unknown, url: string) => `signed-${url}`,
  );
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
});

describe("getPublishedLooks", () => {
  it("DD-LOOK-003 limit が数なら問い合わせに limit を付け、公開済みを新しい順に取る", async () => {
    results.looks = { data: [], error: null };

    await getPublishedLooks(8);

    const looks = buildersFor("looks")[0];
    expect(callsOf(looks, "select")).toEqual([
      [
        "id,season_year,season_type,theme,theme_description,image_urls,created_at",
      ],
    ]);
    expect(callsOf(looks, "eq")).toEqual([["status", "published"]]);
    expect(callsOf(looks, "order")).toEqual([
      ["created_at", { ascending: false }],
    ]);
    expect(callsOf(looks, "limit")).toEqual([[8]]);
  });

  it("DD-LOOK-003 limit が 0 でも数なので limit(0) を付ける", async () => {
    results.looks = { data: [], error: null };

    await getPublishedLooks(0);

    expect(callsOf(buildersFor("looks")[0], "limit")).toEqual([[0]]);
  });

  it("DD-LOOK-003 limit を渡さなければ limit を呼ばない", async () => {
    results.looks = { data: [], error: null };

    await getPublishedLooks();

    expect(buildersFor("looks")[0].limit).not.toHaveBeenCalled();
  });

  it("DD-LOOK-003 looks の取り出しが失敗したら記録して空の配列を返す", async () => {
    const error = { message: "boom" };
    results.looks = { data: null, error };

    await expect(getPublishedLooks()).resolves.toEqual([]);

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "Failed to fetch published looks:",
      error,
    );
    expect(buildersFor("look_items")).toHaveLength(0);
  });

  it("DD-LOOK-003 looks の data が空なら空の配列を返す", async () => {
    results.looks = { data: null, error: null };

    await expect(getPublishedLooks()).resolves.toEqual([]);

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "Failed to fetch published looks:",
      null,
    );
    expect(buildersFor("look_items")).toHaveLength(0);
  });

  it("DD-LOOK-003 LOOK が0件なら空の配列を返し、関連と署名を読まない", async () => {
    results.looks = { data: [], error: null };

    await expect(getPublishedLooks()).resolves.toEqual([]);

    expect(buildersFor("look_items")).toHaveLength(0);
    expect(mockCreateServiceRoleClient).not.toHaveBeenCalled();
    expect(mockSignLookImageUrls).not.toHaveBeenCalled();
  });

  it("DD-LOOK-003 look_items の取り出しが失敗したら元の道筋のまま関連0件の LOOK を返す", async () => {
    const error = { message: "look_items failed" };
    results.looks = { data: [lookRow(1), lookRow(2)], error: null };
    results.look_items = { data: null, error };

    const looks = await getPublishedLooks();

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "Failed to fetch look items:",
      error,
    );
    expect(looks).toEqual([
      {
        id: 1,
        seasonYear: 2026,
        seasonType: "SS",
        theme: "theme-1",
        themeDescription: "desc-1",
        imageUrls: ["raw-1-a", "raw-1-b"],
        createdAt: "2026-01-01T00:00:00Z",
        linkedItems: [],
      },
      expect.objectContaining({
        id: 2,
        imageUrls: ["raw-2-a", "raw-2-b"],
        linkedItems: [],
      }),
    ]);
    expect(mockSignLookImageUrls).not.toHaveBeenCalled();
    expect(buildersFor("items")).toHaveLength(0);
  });

  it("DD-LOOK-003 look_items の data が空でも元の道筋のまま関連0件で返す", async () => {
    results.looks = { data: [lookRow(1)], error: null };
    results.look_items = { data: null, error: null };

    const looks = await getPublishedLooks();

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "Failed to fetch look items:",
      null,
    );
    expect(looks).toHaveLength(1);
    expect(looks[0].imageUrls).toEqual(["raw-1-a", "raw-1-b"]);
    expect(looks[0].linkedItems).toEqual([]);
    expect(mockSignLookImageUrls).not.toHaveBeenCalled();
  });

  it("DD-LOOK-003 元の道筋のまま返す時、image_urls が配列でなければ空にする", async () => {
    results.looks = {
      data: [lookRow(1, { image_urls: null })],
      error: null,
    };
    results.look_items = { data: null, error: { message: "x" } };

    const looks = await getPublishedLooks();

    expect(looks[0].imageUrls).toEqual([]);
  });

  it("DD-LOOK-003 関連が0件なら items を読まず、画像は署名する", async () => {
    results.looks = { data: [lookRow(1)], error: null };
    results.look_items = { data: [], error: null };

    const looks = await getPublishedLooks();

    expect(buildersFor("items")).toHaveLength(0);
    expect(looks[0].linkedItems).toEqual([]);
    expect(looks[0].imageUrls).toEqual(["signed-raw-1-a", "signed-raw-1-b"]);
  });

  it("DD-LOOK-003 items の取り出しが失敗したら記録して関連0件のまま画像は署名する", async () => {
    const error = { message: "items failed" };
    results.looks = { data: [lookRow(1)], error: null };
    results.look_items = { data: [{ look_id: 1, item_id: 10 }], error: null };
    results.items = { data: null, error };

    const looks = await getPublishedLooks();

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "Failed to fetch linked items:",
      error,
    );
    expect(looks[0].linkedItems).toEqual([]);
    expect(looks[0].imageUrls).toEqual(["signed-raw-1-a", "signed-raw-1-b"]);
    expect(mockSignItemImageUrl).not.toHaveBeenCalled();
  });

  it("DD-LOOK-003 items の data が空なら空として扱い関連0件にする", async () => {
    results.looks = { data: [lookRow(1)], error: null };
    results.look_items = { data: [{ look_id: 1, item_id: 10 }], error: null };
    results.items = { data: null, error: null };

    const looks = await getPublishedLooks();

    expect(looks[0].linkedItems).toEqual([]);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(mockSignItemImageUrl).not.toHaveBeenCalled();
  });

  it("DD-LOOK-003 公開の商品だけを付け、消えた・非公開の関連は飛ばす", async () => {
    results.looks = { data: [lookRow(1)], error: null };
    results.look_items = {
      data: [
        { look_id: 1, item_id: 10 },
        { look_id: 1, item_id: 11 },
      ],
      error: null,
    };
    results.items = { data: [itemRow(10)], error: null };

    const looks = await getPublishedLooks();

    expect(looks[0].linkedItems).toEqual([linkedItem(10)]);
    expect(mockSignItemImageUrl).toHaveBeenCalledTimes(1);
    expect(mockSignItemImageUrl).toHaveBeenCalledWith(
      serviceClient,
      "raw-item-10",
    );
  });

  it("DD-LOOK-003 商品の id を重ねずに集め、公開中だけで items を取る", async () => {
    results.looks = { data: [lookRow(1), lookRow(2)], error: null };
    results.look_items = {
      data: [
        { look_id: 1, item_id: 10 },
        { look_id: 2, item_id: 10 },
        { look_id: 2, item_id: 11 },
      ],
      error: null,
    };
    results.items = { data: [itemRow(10), itemRow(11)], error: null };

    await getPublishedLooks();

    const lookItems = buildersFor("look_items")[0];
    expect(callsOf(lookItems, "select")).toEqual([["look_id,item_id"]]);
    expect(callsOf(lookItems, "in")).toEqual([["look_id", [1, 2]]]);
    const items = buildersFor("items")[0];
    expect(callsOf(items, "select")).toEqual([
      ["id,category,name,price,image_url"],
    ]);
    expect(callsOf(items, "in")).toEqual([["id", [10, 11]]]);
    expect(callsOf(items, "eq")).toEqual([["status", "published"]]);
  });

  it("DD-LOOK-003 2つの LOOK に関連を LOOK ごとの並びで分ける", async () => {
    results.looks = { data: [lookRow(1), lookRow(2)], error: null };
    results.look_items = {
      data: [
        { look_id: 2, item_id: 11 },
        { look_id: 1, item_id: 10 },
        { look_id: 2, item_id: 10 },
      ],
      error: null,
    };
    results.items = { data: [itemRow(10), itemRow(11)], error: null };

    const looks = await getPublishedLooks();

    expect(looks[0].linkedItems).toEqual([linkedItem(10)]);
    expect(looks[1].linkedItems).toEqual([linkedItem(11), linkedItem(10)]);
  });

  it("DD-LOOK-003 image_urls が配列でなければ空として署名する", async () => {
    results.looks = {
      data: [lookRow(1, { image_urls: null })],
      error: null,
    };
    results.look_items = { data: [], error: null };

    const looks = await getPublishedLooks();

    expect(mockSignLookImageUrls).toHaveBeenCalledWith(serviceClient, []);
    expect(looks[0].imageUrls).toEqual([]);
  });

  it("DD-LOOK-003 署名した画像に置き換え、行を PublicLook の形に写す", async () => {
    results.looks = { data: [lookRow(1), lookRow(2)], error: null };
    results.look_items = { data: [], error: null };

    const looks = await getPublishedLooks();

    expect(mockSignLookImageUrls).toHaveBeenCalledWith(serviceClient, [
      "raw-1-a",
      "raw-1-b",
    ]);
    expect(mockSignLookImageUrls).toHaveBeenCalledWith(serviceClient, [
      "raw-2-a",
      "raw-2-b",
    ]);
    expect(looks).toEqual([
      {
        id: 1,
        seasonYear: 2026,
        seasonType: "SS",
        theme: "theme-1",
        themeDescription: "desc-1",
        imageUrls: ["signed-raw-1-a", "signed-raw-1-b"],
        createdAt: "2026-01-01T00:00:00Z",
        linkedItems: [],
      },
      expect.objectContaining({
        id: 2,
        imageUrls: ["signed-raw-2-a", "signed-raw-2-b"],
      }),
    ]);
  });

  it("DD-LOOK-003 DB は匿名の client、署名は service role で行う", async () => {
    results.looks = { data: [lookRow(1)], error: null };
    results.look_items = { data: [], error: null };

    await getPublishedLooks();

    expect(mockCreatePublicClient).toHaveBeenCalled();
    expect(mockCreateServiceRoleClient).toHaveBeenCalledTimes(1);
  });
});

describe("getPublishedLooksCount", () => {
  it("DD-LOOK-004 公開の LOOK の数を返し、行を返さない条件で数える", async () => {
    results.looks = { count: 7, error: null };

    await expect(getPublishedLooksCount()).resolves.toBe(7);

    const looks = buildersFor("looks")[0];
    expect(callsOf(looks, "select")).toEqual([
      ["id", { count: "exact", head: true }],
    ]);
    expect(callsOf(looks, "eq")).toEqual([["status", "published"]]);
  });

  it("DD-LOOK-004 数えるのに失敗したら記録して 0 を返す", async () => {
    const error = { message: "count failed" };
    results.looks = { count: null, error };

    await expect(getPublishedLooksCount()).resolves.toBe(0);

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "Failed to count published looks:",
      error,
    );
  });

  it("DD-LOOK-004 count が空なら 0 を返す", async () => {
    results.looks = { count: null, error: null };

    await expect(getPublishedLooksCount()).resolves.toBe(0);

    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("DD-LOOK-004 公開の LOOK が0件なら count の 0 をそのまま返す", async () => {
    results.looks = { count: 0, error: null };

    await expect(getPublishedLooksCount()).resolves.toBe(0);
  });
});

describe("getPublishedLookById", () => {
  it("DD-LOOK-032 LOOK の取り出しが失敗したら記録して null を返す", async () => {
    const error = { message: "look failed" };
    results.looks = { data: null, error };

    await expect(getPublishedLookById(1)).resolves.toBeNull();

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "Failed to fetch published look detail:",
      error,
    );
    expect(buildersFor("look_items")).toHaveLength(0);
  });

  it("DD-LOOK-032 LOOK が無い・非公開なら null を返す", async () => {
    results.looks = { data: null, error: null };

    await expect(getPublishedLookById(1)).resolves.toBeNull();

    expect(buildersFor("look_items")).toHaveLength(0);
  });

  it("DD-LOOK-032 status と id で絞って maybeSingle で1件を取る", async () => {
    results.looks = { data: lookRow(5), error: null };
    results.look_items = { data: [], error: null };

    await getPublishedLookById(5);

    const looks = buildersFor("looks")[0];
    expect(callsOf(looks, "select")).toEqual([
      [
        "id,season_year,season_type,theme,theme_description,image_urls,created_at",
      ],
    ]);
    expect(callsOf(looks, "eq")).toEqual([
      ["status", "published"],
      ["id", 5],
    ]);
    expect(callsOf(looks, "maybeSingle")).toHaveLength(1);
    const lookItems = buildersFor("look_items")[0];
    expect(callsOf(lookItems, "eq")).toEqual([["look_id", 5]]);
  });

  it("DD-LOOK-032 look_items の取り出しが失敗したら記録して関連0件の LOOK を返し、画像は署名する", async () => {
    const error = { message: "look_items failed" };
    results.looks = { data: lookRow(1), error: null };
    results.look_items = { data: null, error };

    const look = await getPublishedLookById(1);

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "Failed to fetch look items for detail view:",
      error,
    );
    expect(look).toEqual({
      id: 1,
      seasonYear: 2026,
      seasonType: "SS",
      theme: "theme-1",
      themeDescription: "desc-1",
      imageUrls: ["signed-raw-1-a", "signed-raw-1-b"],
      createdAt: "2026-01-01T00:00:00Z",
      linkedItems: [],
    });
    expect(buildersFor("items")).toHaveLength(0);
  });

  it("DD-LOOK-032 look_items の data が空なら記録して関連0件で返す", async () => {
    results.looks = { data: lookRow(1), error: null };
    results.look_items = { data: null, error: null };

    const look = await getPublishedLookById(1);

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "Failed to fetch look items for detail view:",
      null,
    );
    expect(look?.linkedItems).toEqual([]);
    expect(look?.imageUrls).toEqual(["signed-raw-1-a", "signed-raw-1-b"]);
  });

  it("DD-LOOK-032 関連が0件なら items を読まない", async () => {
    results.looks = { data: lookRow(1), error: null };
    results.look_items = { data: [], error: null };

    const look = await getPublishedLookById(1);

    expect(buildersFor("items")).toHaveLength(0);
    expect(look?.linkedItems).toEqual([]);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("DD-LOOK-032 items の取り出しが失敗したら記録して関連0件にする", async () => {
    const error = { message: "items failed" };
    results.looks = { data: lookRow(1), error: null };
    results.look_items = { data: [{ look_id: 1, item_id: 10 }], error: null };
    results.items = { data: null, error };

    const look = await getPublishedLookById(1);

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "Failed to fetch linked items for detail view:",
      error,
    );
    expect(look?.linkedItems).toEqual([]);
    expect(mockSignItemImageUrl).not.toHaveBeenCalled();
  });

  it("DD-LOOK-032 items の data が空なら空として扱い関連0件にする", async () => {
    results.looks = { data: lookRow(1), error: null };
    results.look_items = { data: [{ look_id: 1, item_id: 10 }], error: null };
    results.items = { data: null, error: null };

    const look = await getPublishedLookById(1);

    expect(look?.linkedItems).toEqual([]);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("DD-LOOK-032 公開の商品だけを関連の順に付け、商品の画像は署名つきにする", async () => {
    results.looks = { data: lookRow(1), error: null };
    results.look_items = {
      data: [
        { look_id: 1, item_id: 11 },
        { look_id: 1, item_id: 10 },
        { look_id: 1, item_id: 10 },
        { look_id: 1, item_id: 12 },
      ],
      error: null,
    };
    results.items = { data: [itemRow(10), itemRow(11)], error: null };

    const look = await getPublishedLookById(1);

    const items = buildersFor("items")[0];
    expect(callsOf(items, "in")).toEqual([["id", [11, 10, 12]]]);
    expect(callsOf(items, "eq")).toEqual([["status", "published"]]);
    expect(look?.linkedItems).toEqual([
      linkedItem(11),
      linkedItem(10),
      linkedItem(10),
    ]);
    expect(mockSignItemImageUrl).toHaveBeenCalledWith(
      serviceClient,
      "raw-item-10",
    );
  });

  it("DD-LOOK-032 image_urls が配列でなければ空として署名する", async () => {
    results.looks = {
      data: lookRow(1, { image_urls: null }),
      error: null,
    };
    results.look_items = { data: [], error: null };

    const look = await getPublishedLookById(1);

    expect(mockSignLookImageUrls).toHaveBeenCalledWith(serviceClient, []);
    expect(look?.imageUrls).toEqual([]);
  });

  it("DD-LOOK-032 画像を署名し、行を PublicLook の形に写して返す", async () => {
    results.looks = { data: lookRow(3), error: null };
    results.look_items = { data: [{ look_id: 3, item_id: 10 }], error: null };
    results.items = { data: [itemRow(10)], error: null };

    const look = await getPublishedLookById(3);

    expect(mockSignLookImageUrls).toHaveBeenCalledWith(serviceClient, [
      "raw-3-a",
      "raw-3-b",
    ]);
    expect(look).toEqual({
      id: 3,
      seasonYear: 2026,
      seasonType: "SS",
      theme: "theme-3",
      themeDescription: "desc-3",
      imageUrls: ["signed-raw-3-a", "signed-raw-3-b"],
      createdAt: "2026-01-03T00:00:00Z",
      linkedItems: [linkedItem(10)],
    });
  });
});

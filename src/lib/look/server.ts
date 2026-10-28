import {
  createPublicClient,
  createServiceRoleClient,
} from "@/lib/supabase/server";
import { signLookImageUrls } from "@/lib/storage/look-images";
import { signItemImageUrl } from "@/lib/storage/item-images";
import { parseOwnObjectPath } from "@/lib/storage/safe-object-path";
import { describeErrorForLog } from "@/lib/logging/safe-error";
import type {
  LookSeasonType,
  PublicLook,
  PublicLookLinkedItem,
  PublicLookListItem,
} from "./public";

/** 一覧が 1 度に取る公開の LOOK の件数の上限（SEC-LOOK-009）。 */
export const PUBLIC_LOOK_LIST_LIMIT = 100;

const LOOK_LIST_COLUMNS = "id,season_year,season_type,theme,image_urls,created_at";
const LOOK_DETAIL_COLUMNS =
  "id,season_year,season_type,theme,theme_description,image_urls,created_at";

type LookListRow = {
  id: number;
  season_year: number;
  season_type: LookSeasonType;
  theme: string;
  image_urls: string[];
  created_at: string;
};

type LookRow = LookListRow & {
  theme_description: string;
};

type LookItemRow = {
  look_id: number;
  item_id: number;
};

type ItemRow = {
  id: number;
  category: string;
  name: string;
  price: number;
  image_url: string;
};

type AdjacentLook = { id: number; theme: string };

/**
 * 公開の LOOK の取り出しが DB の失敗で終わったことを表す誤り。
 *
 * @impl IMPL-LOOK-149
 * @design DD-LOOK-003
 * @remarks 失敗を「0 件」にすると、障害が「LOOK はまだありません」に見えてしまう。呼び出し側が誤りの画面に出せるよう、DB の文は持たず符号だけ運ぶ。
 */
export class LookFetchError extends Error {
  readonly code: string | null;

  constructor(code: string | null) {
    super("Failed to fetch published looks");
    this.name = "LookFetchError";
    this.code = code;
  }
}

function failFetch(label: string, error: unknown): never {
  const described = describeErrorForLog(error);
  console.error(label, described);
  throw new LookFetchError(described.code);
}

function clampListLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 1) {
    return PUBLIC_LOOK_LIST_LIMIT;
  }

  return Math.min(Math.floor(limit), PUBLIC_LOOK_LIST_LIMIT);
}

async function fetchPublishedLooks(
  limit: number,
): Promise<PublicLookListItem[]> {
  const supabase = await createPublicClient();

  const { data: lookRows, error: looksError } = await supabase
    .from("looks")
    .select(LOOK_LIST_COLUMNS)
    .eq("status", "published")
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit);

  if (looksError || !lookRows) {
    return failFetch("Failed to fetch published looks:", looksError);
  }

  return hydrateLooks(lookRows as LookListRow[]);
}

/**
 * /look 用に、公開の LOOK を新しい順に 100 件まで取る。説明文は取らない。失敗は投げる。
 *
 * @impl IMPL-LOOK-148
 * @design DD-LOOK-003
 * @remarks 一覧の応答に説明文を載せない（SEC-LOOK-009）ので select から外し、件数を 100 に切る。取り出しの失敗は LookFetchError にして誤りの画面に出す（SEC-LOOK-022）。
 */
export async function getPublishedLookList(): Promise<PublicLookListItem[]> {
  return fetchPublishedLooks(PUBLIC_LOOK_LIST_LIMIT);
}

/**
 * ホーム用に、公開の LOOK を新しい順に取る。説明文は取らない。失敗は空の配列。
 *
 * @impl IMPL-LOOK-103
 * @design DD-LOOK-003
 * @remarks 公開の印は匿名の鍵で読んで RLS で絞り、アプリでも公開の印を付けて二重に絞る（SEC-LOOK-001）。画像の署名だけを service role で行う（private なバケットのため）。件数は 1〜100 に丸める。ホームは LOOK の失敗で全体を落とさないので、ここは握って空の配列にする。
 */
export async function getPublishedLooks(
  limit?: number,
): Promise<PublicLookListItem[]> {
  try {
    return await fetchPublishedLooks(clampListLimit(limit));
  } catch (error) {
    if (error instanceof LookFetchError) {
      return [];
    }
    throw error;
  }
}

/**
 * 公開の LOOK の総数を返す。
 *
 * @impl IMPL-LOOK-104
 * @design DD-LOOK-004
 * @remarks FREQ-148: ホームの VIEW ALL を出すかの判定に使う。失敗は 0 にして VIEW ALL を出さない側に倒す。
 */
export async function getPublishedLooksCount(): Promise<number> {
  const supabase = await createPublicClient();

  const { count, error } = await supabase
    .from("looks")
    .select("id", { count: "exact", head: true })
    .eq("status", "published");

  if (error) {
    console.error("Failed to count published looks:", describeErrorForLog(error));
    return 0;
  }

  return count ?? 0;
}

/**
 * 1件の公開の LOOK を、公開中の関連商品と署名つきの画像付きで返す。無い・非公開なら null。DB の失敗は投げる。
 *
 * @impl IMPL-LOOK-105
 * @design DD-LOOK-032
 * @remarks 一覧と違い説明文を含む。一覧と同じく公開の印は匿名の鍵で絞り、署名だけを service role で行う。関連の取り出しの失敗を「関連なし」にすると障害が見えなくなるので、本体も関連も LookFetchError にする。
 */
export async function getPublishedLookById(
  id: number,
): Promise<PublicLook | null> {
  const [supabase, serviceSupabase] = await Promise.all([
    createPublicClient(),
    createServiceRoleClient(),
  ]);

  const { data: lookRow, error: lookError } = await supabase
    .from("looks")
    .select(LOOK_DETAIL_COLUMNS)
    .eq("status", "published")
    .eq("id", id)
    .maybeSingle();

  if (lookError) {
    return failFetch("Failed to fetch published look detail:", lookError);
  }

  if (!lookRow) {
    return null;
  }

  const { data: lookItemRows, error: lookItemsError } = await supabase
    .from("look_items")
    .select("look_id,item_id")
    .eq("look_id", id);

  if (lookItemsError || !lookItemRows) {
    return failFetch(
      "Failed to fetch look items for detail view:",
      lookItemsError,
    );
  }

  const uniqueItemIds = Array.from(
    new Set((lookItemRows as LookItemRow[]).map((row) => row.item_id)),
  );
  const itemMap = await fetchLinkedItems(
    supabase,
    serviceSupabase,
    uniqueItemIds,
    "Failed to fetch linked items for detail view:",
  );

  const linkedItems: PublicLookLinkedItem[] = [];
  for (const lookItemRow of lookItemRows as LookItemRow[]) {
    const item = itemMap.get(lookItemRow.item_id);
    if (item) {
      linkedItems.push(item);
    }
  }

  const rawUrls = Array.isArray(lookRow.image_urls) ? lookRow.image_urls : [];
  const imageUrls = await signLookImageUrls(serviceSupabase, rawUrls);

  return {
    ...mapLookRowToPublicLook(lookRow as LookRow),
    imageUrls,
    linkedItems,
  };
}

/**
 * 公開の LOOK の image_urls のうち、置き場の道筋の確かめに通る最初の生の値を返す（署名しない）。無い・非公開・確かめに通る物が無い・DB の失敗は null。
 *
 * @impl IMPL-LOOK-158
 * @design DD-LOOK-071
 * @remarks og:image の窓口が読む。署名つき URL を共有の場に出さないので署名はここでしない。公開の印は匿名の鍵（RLS）と明示の両方で絞る。
 * 窓口は画像が出せない時に 404 を返すだけでよいので、DB の失敗は符号だけ記録して null にし、投げない。
 */
export async function getPublishedLookCoverRaw(id: number): Promise<string | null> {
  const supabase = await createPublicClient();

  const { data, error } = await supabase
    .from("looks")
    .select("image_urls")
    .eq("status", "published")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    console.error("Failed to fetch look cover image:", describeErrorForLog(error));
    return null;
  }

  const rawUrls: unknown = data?.image_urls;
  if (!Array.isArray(rawUrls)) {
    return null;
  }

  for (const raw of rawUrls) {
    if (typeof raw === "string" && parseOwnObjectPath(raw, { bucket: "look-images", prefix: "looks" })) {
      return raw;
    }
  }

  return null;
}

/**
 * 詳細の前後の LOOK を、一覧と同じ並びで 1 件ずつ id と題だけ取る。
 *
 * @impl IMPL-LOOK-156
 * @design DD-LOOK-032
 * @remarks 一覧の 100 件を取り直して位置で選ぶと、101 番目より古い LOOK が前後を持てない。並び（created_at の新しい順・同じ時刻は id の大きい順）の境目を条件に持って 1 件ずつ取る。時刻は PostgREST の予約文字（. :）を含むので二重引用符で囲む。値は DB から読んだ created_at と数の id だけで、外から来た文字を入れない。前後は添え物なので、片方の失敗は記録だけにしてその側を無しにし、記事本体を隠さない。
 */
export async function getAdjacentPublishedLooks(look: {
  id: number;
  createdAt: string;
}): Promise<{ prev: AdjacentLook | null; next: AdjacentLook | null }> {
  const supabase = await createPublicClient();
  const { id, createdAt } = look;

  const [prevResult, nextResult] = await Promise.all([
    supabase
      .from("looks")
      .select("id,theme")
      .eq("status", "published")
      .or(
        `created_at.gt."${createdAt}",and(created_at.eq."${createdAt}",id.gt.${id})`,
      )
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("looks")
      .select("id,theme")
      .eq("status", "published")
      .or(
        `created_at.lt."${createdAt}",and(created_at.eq."${createdAt}",id.lt.${id})`,
      )
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  return {
    prev: pickAdjacent(prevResult, "Failed to fetch previous look:"),
    next: pickAdjacent(nextResult, "Failed to fetch next look:"),
  };
}

function pickAdjacent(
  result: { data: unknown; error: unknown },
  label: string,
): AdjacentLook | null {
  if (result.error) {
    console.error(label, describeErrorForLog(result.error));
    return null;
  }

  const row = result.data as AdjacentLook | null;
  return row ? { id: row.id, theme: row.theme } : null;
}

type PublicClient = Awaited<ReturnType<typeof createPublicClient>>;
type ServiceClient = Awaited<ReturnType<typeof createServiceRoleClient>>;

async function fetchLinkedItems(
  supabase: PublicClient,
  serviceSupabase: ServiceClient,
  itemIds: number[],
  failureLabel: string,
): Promise<Map<number, PublicLookLinkedItem>> {
  const itemMap = new Map<number, PublicLookLinkedItem>();

  if (itemIds.length === 0) {
    return itemMap;
  }

  const { data: itemRows, error: itemRowsError } = await supabase
    .from("items")
    .select("id,category,name,price,image_url")
    .in("id", itemIds)
    .eq("status", "published");

  if (itemRowsError) {
    return failFetch(failureLabel, itemRowsError);
  }

  const signedItemRows = await Promise.all(
    (itemRows ?? []).map(async (row) => ({
      ...row,
      image_url: await signItemImageUrl(serviceSupabase, row.image_url),
    })),
  );

  for (const row of signedItemRows as ItemRow[]) {
    itemMap.set(row.id, {
      category: row.category,
      id: row.id,
      name: row.name,
      price: row.price,
      imageUrl: row.image_url,
    });
  }

  return itemMap;
}

async function hydrateLooks(
  lookRows: LookListRow[],
): Promise<PublicLookListItem[]> {
  if (lookRows.length === 0) {
    return [];
  }

  // Use service role client to sign image URLs from the private look-images bucket,
  // and anon client for DB reads (respects RLS; only published rows are accessible).
  const [supabase, serviceSupabase] = await Promise.all([
    createPublicClient(),
    createServiceRoleClient(),
  ]);
  const lookIds = lookRows.map((look) => look.id);

  const { data: lookItemRows, error: lookItemsError } = await supabase
    .from("look_items")
    .select("look_id,item_id")
    .in("look_id", lookIds);

  if (lookItemsError || !lookItemRows) {
    return failFetch("Failed to fetch look items:", lookItemsError);
  }

  const uniqueItemIds = Array.from(
    new Set((lookItemRows as LookItemRow[]).map((row) => row.item_id)),
  );
  const itemMap = await fetchLinkedItems(
    supabase,
    serviceSupabase,
    uniqueItemIds,
    "Failed to fetch linked items:",
  );

  const lookItemsMap = new Map<number, PublicLookLinkedItem[]>();
  for (const lookItemRow of lookItemRows as LookItemRow[]) {
    const item = itemMap.get(lookItemRow.item_id);
    if (!item) {
      continue;
    }

    const list = lookItemsMap.get(lookItemRow.look_id) ?? [];
    list.push(item);
    lookItemsMap.set(lookItemRow.look_id, list);
  }

  const signedImageUrlsMap = new Map<number, string[]>();
  await Promise.all(
    lookRows.map(async (row) => {
      const rawUrls = Array.isArray(row.image_urls) ? row.image_urls : [];
      const signed = await signLookImageUrls(serviceSupabase, rawUrls);
      signedImageUrlsMap.set(row.id, signed);
    }),
  );

  return lookRows.map((row) => ({
    ...mapLookRowToListItem(row),
    imageUrls: signedImageUrlsMap.get(row.id) ?? [],
    linkedItems: lookItemsMap.get(row.id) ?? [],
  }));
}

function mapLookRowToListItem(row: LookListRow): PublicLookListItem {
  return {
    id: row.id,
    seasonYear: row.season_year,
    seasonType: row.season_type,
    theme: row.theme,
    // 生の値は載せない。呼び手が署名した値で必ず上書きする（署名に通らない物は空のまま）。
    imageUrls: [],
    createdAt: row.created_at,
    linkedItems: [],
  };
}

function mapLookRowToPublicLook(row: LookRow): PublicLook {
  return {
    ...mapLookRowToListItem(row),
    themeDescription: row.theme_description,
  };
}

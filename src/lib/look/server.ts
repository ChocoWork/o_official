import {
  createPublicClient,
  createServiceRoleClient,
} from "@/lib/supabase/server";
import { signLookImageUrls } from "@/lib/storage/look-images";
import { signItemImageUrl } from "@/lib/storage/item-images";
import type {
  LookSeasonType,
  PublicLook,
  PublicLookLinkedItem,
} from "./public";

type LookRow = {
  id: number;
  season_year: number;
  season_type: LookSeasonType;
  theme: string;
  theme_description: string;
  image_urls: string[];
  created_at: string;
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

export async function getPublishedLooks(limit?: number): Promise<PublicLook[]> {
  const supabase = await createPublicClient();

  let query = supabase
    .from("looks")
    .select(
      "id,season_year,season_type,theme,theme_description,image_urls,created_at",
    )
    .eq("status", "published")
    .order("created_at", { ascending: false });

  if (typeof limit === "number") {
    query = query.limit(limit);
  }

  const { data: lookRows, error: looksError } = await query;

  if (looksError || !lookRows) {
    console.error("Failed to fetch published looks:", looksError);
    return [];
  }

  return hydrateLooks(lookRows as LookRow[]);
}

// FREQ-148: ホームの VIEW ALL 表示判定用に公開 LOOK の総数を返す
export async function getPublishedLooksCount(): Promise<number> {
  const supabase = await createPublicClient();

  const { count, error } = await supabase
    .from("looks")
    .select("id", { count: "exact", head: true })
    .eq("status", "published");

  if (error) {
    console.error("Failed to count published looks:", error);
    return 0;
  }

  return count ?? 0;
}

export async function getPublishedLookById(
  id: number,
): Promise<PublicLook | null> {
  const [supabase, serviceSupabase] = await Promise.all([
    createPublicClient(),
    createServiceRoleClient(),
  ]);

  const { data: lookRow, error: lookError } = await supabase
    .from("looks")
    .select(
      "id,season_year,season_type,theme,theme_description,image_urls,created_at",
    )
    .eq("status", "published")
    .eq("id", id)
    .maybeSingle();

  if (lookError || !lookRow) {
    console.error("Failed to fetch published look detail:", lookError);
    return null;
  }

  const { data: lookItemRows, error: lookItemsError } = await supabase
    .from("look_items")
    .select("look_id,item_id")
    .eq("look_id", id);

  if (lookItemsError || !lookItemRows) {
    console.error(
      "Failed to fetch look items for detail view:",
      lookItemsError,
    );
  }

  const uniqueItemIds = Array.from(
    new Set(((lookItemRows ?? []) as LookItemRow[]).map((row) => row.item_id)),
  );
  const itemMap = new Map<number, PublicLookLinkedItem>();

  if (uniqueItemIds.length > 0) {
    const { data: itemRows, error: itemRowsError } = await supabase
      .from("items")
      .select("id,category,name,price,image_url")
      .in("id", uniqueItemIds)
      .eq("status", "published");

    if (itemRowsError) {
      console.error(
        "Failed to fetch linked items for detail view:",
        itemRowsError,
      );
    } else {
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
    }
  }

  const linkedItems: PublicLookLinkedItem[] = [];
  for (const lookItemRow of (lookItemRows ?? []) as LookItemRow[]) {
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

async function hydrateLooks(lookRows: LookRow[]): Promise<PublicLook[]> {
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
    console.error("Failed to fetch look items:", lookItemsError);
    return lookRows.map(mapLookRowToPublicLook);
  }

  const uniqueItemIds = Array.from(
    new Set((lookItemRows as LookItemRow[]).map((row) => row.item_id)),
  );

  const itemMap = new Map<number, PublicLookLinkedItem>();

  if (uniqueItemIds.length > 0) {
    const { data: itemRows, error: itemRowsError } = await supabase
      .from("items")
      .select("id,category,name,price,image_url")
      .in("id", uniqueItemIds)
      .eq("status", "published");

    if (itemRowsError) {
      console.error("Failed to fetch linked items:", itemRowsError);
    } else {
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
    }
  }

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
    ...mapLookRowToPublicLook(row),
    imageUrls: signedImageUrlsMap.get(row.id) ?? [],
    linkedItems: lookItemsMap.get(row.id) ?? [],
  }));
}

function mapLookRowToPublicLook(row: LookRow): PublicLook {
  return {
    id: row.id,
    seasonYear: row.season_year,
    seasonType: row.season_type,
    theme: row.theme,
    themeDescription: row.theme_description,
    imageUrls: Array.isArray(row.image_urls) ? row.image_urls : [],
    createdAt: row.created_at,
    linkedItems: [],
  };
}

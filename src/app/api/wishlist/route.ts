import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { logAudit } from "@/lib/audit";
import { createPublicClient, createServiceRoleClient } from "@/lib/supabase/server";
import { denyIfCsrfInvalid, openShoppingContext } from "@/features/cart/services/shopping-context";
import { signItemImageUrl } from '@/lib/storage/item-images';

// PUBLIC: ゲストのお気に入りを扱うので利用者認証は無い。持ち主は wishlist Cookie の印（ゲスト）か
// 確かめた会員の ID で決める（設計書第4章）。会員の書き換えには CSRF の合言葉を求め、
// ゲストの送信元（Origin）の確かめは src/proxy.ts が掛ける。

// Zod schema for wishlist POST validation
const addWishlistItemSchema = z.object({
  item_id: z.coerce.number().int().positive(),
});

function getClientIp(request: NextRequest): string | null {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    return forwardedFor.split(",")[0]?.trim() ?? null;
  }

  return request.headers.get("x-real-ip");
}

/**
 * GET /api/wishlist
 * Fetch wishlist items for the owner (published items only)
 * カートに入れる操作ができるよう、各行に販売中のバリアントを添える
 */
export async function GET(req: NextRequest) {
  try {
    const clientIp = getClientIp(req);
    const userAgent = req.headers.get("user-agent");

    // お気に入りの表はブラウザから読めないため service role で読む。
    // RLS に頼らず、持ち主の行（wishlist_id）で必ず絞る。
    const supabase = await createServiceRoleClient();
    const opened = await openShoppingContext(req, "wishlist", supabase, { write: false });
    if (!opened.ok) {
      return opened.response;
    }
    const { context } = opened;

    // レート制限: 持ち主単位と IP 単位（列挙攻撃抑止）。印の無いゲストは IP 単位だけで数える
    const { enforceRateLimit } = await import(
      "@/features/auth/middleware/rateLimit"
    );
    if (context.rateLimitSubject) {
      const rateLimitByOwner = await enforceRateLimit({
        request: req,
        endpoint: "wishlist:get",
        limit: 60,
        windowSeconds: 60,
        subject: context.rateLimitSubject,
      });
      if (rateLimitByOwner) {
        await logAudit({
          action: "wishlist.get",
          outcome: "rate_limited",
          detail: "Owner rate limit exceeded for wishlist GET endpoint",
          ip: clientIp,
          user_agent: userAgent,
          metadata: { ...context.auditOwner },
        });
        return rateLimitByOwner;
      }
    }

    const rateLimitByIp = await enforceRateLimit({
      request: req,
      endpoint: "wishlist:get",
      limit: 120,
      windowSeconds: 60,
    });
    if (rateLimitByIp) {
      await logAudit({
        action: "wishlist.get",
        outcome: "rate_limited",
        detail: "Rate limit exceeded for wishlist GET endpoint",
        ip: clientIp,
        user_agent: userAgent,
        metadata: { ...context.auditOwner },
      });
      return rateLimitByIp;
    }

    // 持ち主の行がまだ無ければ、お気に入りは空
    const wishlistId = await context.findOwnerId();
    if (!wishlistId) {
      return context.finish(NextResponse.json([]));
    }

    // Get wishlist items
    const { data: wishlistData, error: wishlistError } = await supabase
      .from("wishlist_lines")
      .select("id, item_id, added_at")
      .eq("wishlist_id", wishlistId)
      .order("added_at", { ascending: false });

    if (wishlistError) {
      console.error("Error fetching wishlist:", wishlistError);
      return context.finish(
        NextResponse.json({ error: "Failed to fetch wishlist" }, { status: 500 })
      );
    }

    if (!wishlistData || wishlistData.length === 0) {
      return context.finish(NextResponse.json([]));
    }

    // Get items data (published only, using public client)
    const publicItemSupabase = await createPublicClient();
    const itemIds = wishlistData.map((item) => item.item_id);
    const { data: itemsData, error: itemsError } = await publicItemSupabase
      .from("items")
      .select("id, name, price, image_url, category, colors, sizes, status")
      .in("id", itemIds)
      .eq("status", "published");

    if (itemsError) {
      console.error("Error fetching items:", itemsError);
      return context.finish(
        NextResponse.json({ error: "Failed to fetch items" }, { status: 500 })
      );
    }

    const signedItemsData = await Promise.all(
      (itemsData || []).map(async (item) => ({
        ...item,
        image_url: (await signItemImageUrl(supabase, item.image_url)) ?? item.image_url,
      }))
    );

    // 公開中の商品が 1 つも残らなければ、バリアントを読むまでもなく空
    if (signedItemsData.length === 0) {
      return context.finish(NextResponse.json([]));
    }

    // 公開中の商品の販売中のバリアントを読み、商品ごとにまとめる（カートに入れるバリアントを選ぶため）
    const { data: variantRows, error: variantError } = await supabase
      .from("item_variants")
      .select("id, item_id, is_active, item_colors(name), item_sizes(label)")
      .in("item_id", signedItemsData.map((item) => item.id))
      .eq("is_active", true);
    if (variantError) {
      throw variantError;
    }
    const variantsByItem = new Map<number, Array<{ id: number; color: string | null; size: string | null }>>();
    for (const row of (variantRows ?? []) as unknown as Array<{ id: number; item_id: number; item_colors: { name: string } | null; item_sizes: { label: string } | null }>) {
      const list = variantsByItem.get(Number(row.item_id)) ?? [];
      list.push({ id: Number(row.id), color: row.item_colors?.name ?? null, size: row.item_sizes?.label ?? null });
      variantsByItem.set(Number(row.item_id), list);
    }

    // Merge wishlist and items data
    const itemsMap = new Map(
      signedItemsData.map((item) => [item.id, item])
    );
    const result = wishlistData
      .map((wishlistItem) => ({
        ...wishlistItem,
        items: itemsMap.get(wishlistItem.item_id) ?? null,
        variants: variantsByItem.get(Number(wishlistItem.item_id)) ?? [],
      }))
      // Drop items that are no longer published or deleted
      .filter((wi) => wi.items !== null);

    return context.finish(NextResponse.json(result));
  } catch (error) {
    console.error("Wishlist GET error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/wishlist
 * Add item to wishlist (published items only)
 * Validates item_id, applies rate limiting, and logs audit events
 */
export async function POST(req: NextRequest) {
  try {
    const clientIp = getClientIp(req);
    const userAgent = req.headers.get("user-agent");

    const supabase = await createServiceRoleClient();
    const opened = await openShoppingContext(req, "wishlist", supabase, { write: true });
    if (!opened.ok) {
      return opened.response;
    }
    const { context } = opened;

    // Apply rate limiting (IP-based and owner-based)
    const { enforceRateLimit } = await import(
      "@/features/auth/middleware/rateLimit"
    );
    const rateLimitByIp = await enforceRateLimit({
      request: req,
      endpoint: "wishlist:add",
      limit: 60,
      windowSeconds: 60,
    });
    if (rateLimitByIp) {
      return rateLimitByIp;
    }

    // 印の無いゲストはまだ持ち主が無いので、IP 単位だけで数える
    if (context.rateLimitSubject) {
      const rateLimitByOwner = await enforceRateLimit({
        request: req,
        endpoint: "wishlist:add",
        limit: 30,
        windowSeconds: 60,
        subject: context.rateLimitSubject,
      });
      if (rateLimitByOwner) {
        return rateLimitByOwner;
      }
    }

    // 会員の書き換えには CSRF の合言葉が要る（ゲストは素通りで、Origin の確かめと SameSite で止める）
    const csrfDenied = await denyIfCsrfInvalid();
    if (csrfDenied) {
      return csrfDenied;
    }

    const publicItemSupabase = await createPublicClient();

    // Validate request body with Zod schema
    const parsedBody = addWishlistItemSchema.safeParse(
      await req.json().catch(() => null)
    );
    if (!parsedBody.success) {
      await logAudit({
        action: "wishlist.add",
        outcome: "failure",
        detail: "Invalid request body",
        ip: clientIp,
        user_agent: userAgent,
        metadata: { ...context.auditOwner },
      });
      return context.finish(
        NextResponse.json({ error: "Invalid request body" }, { status: 400 })
      );
    }

    const { item_id } = parsedBody.data;

    // Check if item exists and is published (using public client)
    const { data: itemData, error: itemError } = await publicItemSupabase
      .from("items")
      .select("id, name, status")
      .eq("id", item_id)
      .eq("status", "published")
      .single();

    if (itemError || !itemData || itemData.status !== "published") {
      await logAudit({
        action: "wishlist.add",
        outcome: "failure",
        detail: "Item not found or not published",
        ip: clientIp,
        user_agent: userAgent,
        metadata: { ...context.auditOwner, item_id },
      });
      return context.finish(
        NextResponse.json({ error: "Item not found" }, { status: 404 })
      );
    }

    // Insert wishlist item。印の無いゲストはここで持ち主の行と新しい印を作る
    // （auditOwner は作った後の値になるので、ここから先の監査は context から読み直す）
    const wishlistId = await context.ensureOwnerId();
    const { data: wishlistItem, error: wishlistError } = await supabase
      .from("wishlist_lines")
      .insert({ wishlist_id: wishlistId, item_id })
      .select("id, item_id, added_at")
      .single();

    if (wishlistError) {
      // Handle duplicate (already in wishlist)
      if (wishlistError.code === "23505") {
        await logAudit({
          action: "wishlist.add",
          outcome: "conflict",
          detail: "Item already in wishlist",
          ip: clientIp,
          user_agent: userAgent,
          metadata: { ...context.auditOwner, item_id },
        });
        return context.finish(
          NextResponse.json({ error: "Item already in wishlist" }, { status: 409 })
        );
      }
      console.error("Error adding to wishlist:", wishlistError);
      await logAudit({
        action: "wishlist.add",
        outcome: "error",
        detail: "Failed to add to wishlist",
        ip: clientIp,
        user_agent: userAgent,
        metadata: { ...context.auditOwner, item_id },
      });
      return context.finish(
        NextResponse.json({ error: "Failed to add to wishlist" }, { status: 500 })
      );
    }

    await logAudit({
      action: "wishlist.add",
      outcome: "success",
      resource: "wishlist",
      resource_id: wishlistItem?.id ?? null,
      ip: clientIp,
      user_agent: userAgent,
      metadata: {
        ...context.auditOwner,
        item_id,
      },
    });

    return context.finish(NextResponse.json(wishlistItem, { status: 201 }));
  } catch (error) {
    console.error("Wishlist POST error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { logAudit } from "@/lib/audit";
import {
  createClient as createRequestClient,
  createPublicClient,
  createServiceRoleClient,
} from "@/lib/supabase/server";
import { signItemImageUrl } from '@/lib/storage/item-images';

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
 * Fetch wishlist items for a session (published items only)
 */
export async function GET(req: NextRequest) {
  try {
    const sessionId = req.cookies.get("session_id")?.value;
    const clientIp = getClientIp(req);
    const userAgent = req.headers.get("user-agent");

    if (!sessionId) {
      return NextResponse.json(
        { error: "Session not found" },
        { status: 400 }
      );
    }

    // レート制限: IP 単位（列挙攻撃抑止）
    const { enforceRateLimit } = await import(
      "@/features/auth/middleware/rateLimit"
    );
    const rateLimitBySession = await enforceRateLimit({
      request: req,
      endpoint: "wishlist:get",
      limit: 60,
      windowSeconds: 60,
      subject: sessionId,
    });
    if (rateLimitBySession) {
      await logAudit({
        action: "wishlist.get",
        outcome: "rate_limited",
        detail: "Session rate limit exceeded for wishlist GET endpoint",
        ip: clientIp,
        user_agent: userAgent,
        metadata: { session_id: sessionId },
      });
      return rateLimitBySession;
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
        metadata: { session_id: sessionId },
      });
      return rateLimitByIp;
    }

    const [wishlistSupabase, publicItemSupabase, signSupabase] = await Promise.all([
      createRequestClient(req),
      createPublicClient(),
      createServiceRoleClient(),
    ]);

    // Get wishlist items
    const { data: wishlistData, error: wishlistError } = await wishlistSupabase
      .from("wishlist")
      .select("id, item_id, added_at")
      .eq("session_id", sessionId)
      .order("added_at", { ascending: false });

    if (wishlistError) {
      console.error("Error fetching wishlist:", wishlistError);
      return NextResponse.json(
        { error: "Failed to fetch wishlist" },
        { status: 500 }
      );
    }

    if (!wishlistData || wishlistData.length === 0) {
      return NextResponse.json([]);
    }

    // Get items data (published only, using public client)
    const itemIds = wishlistData.map((item) => item.item_id);
    const { data: itemsData, error: itemsError } = await publicItemSupabase
      .from("items")
      .select("id, name, price, image_url, category, colors, sizes, status")
      .in("id", itemIds)
      .eq("status", "published");

    if (itemsError) {
      console.error("Error fetching items:", itemsError);
      return NextResponse.json(
        { error: "Failed to fetch items" },
        { status: 500 }
      );
    }

    const signedItemsData = await Promise.all(
      (itemsData || []).map(async (item) => ({
        ...item,
        image_url: (await signItemImageUrl(signSupabase, item.image_url)) ?? item.image_url,
      }))
    );

    // Merge wishlist and items data
    const itemsMap = new Map(
      signedItemsData.map((item) => [item.id, item])
    );
    const result = wishlistData
      .map((wishlistItem) => ({
        ...wishlistItem,
        items: itemsMap.get(wishlistItem.item_id) ?? null,
      }))
      // Drop items that are no longer published or deleted
      .filter((wi) => wi.items !== null);

    return NextResponse.json(result);
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
    const sessionId = req.cookies.get("session_id")?.value;
    const clientIp = getClientIp(req);
    const userAgent = req.headers.get("user-agent");

    if (!sessionId) {
      return NextResponse.json(
        { error: "Session not found" },
        { status: 400 }
      );
    }

    // Apply rate limiting (IP-based and session-based)
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

    const rateLimitBySession = await enforceRateLimit({
      request: req,
      endpoint: "wishlist:add",
      limit: 30,
      windowSeconds: 60,
      subject: sessionId,
    });
    if (rateLimitBySession) {
      return rateLimitBySession;
    }

    const [wishlistSupabase, publicItemSupabase] = await Promise.all([
      createRequestClient(req),
      createPublicClient(),
    ]);

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
        metadata: { session_id: sessionId },
      });
      return NextResponse.json(
        { error: "Invalid request body" },
        { status: 400 }
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
        metadata: { session_id: sessionId, item_id },
      });
      return NextResponse.json(
        { error: "Item not found" },
        { status: 404 }
      );
    }

    // Insert wishlist item
    const { data: wishlistItem, error: wishlistError } = await wishlistSupabase
      .from("wishlist")
      .insert({
        session_id: sessionId,
        item_id,
      })
      .select()
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
          metadata: { session_id: sessionId, item_id },
        });
        return NextResponse.json(
          { error: "Item already in wishlist" },
          { status: 409 }
        );
      }
      console.error("Error adding to wishlist:", wishlistError);
      await logAudit({
        action: "wishlist.add",
        outcome: "error",
        detail: "Failed to add to wishlist",
        ip: clientIp,
        user_agent: userAgent,
        metadata: { session_id: sessionId, item_id },
      });
      return NextResponse.json(
        { error: "Failed to add to wishlist" },
        { status: 500 }
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
        session_id: sessionId,
        item_id,
      },
    });

    return NextResponse.json(wishlistItem, { status: 201 });
  } catch (error) {
    console.error("Wishlist POST error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

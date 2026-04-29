import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";
import {
  addCartItemSchema,
  buildInventoryConflictBody,
  normalizeCartVariantValue,
} from '@/features/cart/services/cart-stock';
import { logAudit } from '@/lib/audit';
import { signItemImageUrl } from '@/lib/storage/item-images';

const cartSupabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const publicItemSupabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  }
);

type CartRow = {
  id: string;
  item_id: number;
  quantity: number;
  color: string | null;
  size: string | null;
  added_at: string;
};

type ItemRow = {
  id: number;
  name: string;
  price: number;
  image_url: string;
  category: string;
  status: string;
  stock_quantity?: number | null;
};

type ExistingCartRow = {
  id: string;
  quantity: number;
  color: string | null;
  size: string | null;
};

function getClientIp(request: NextRequest): string | null {
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) {
    return forwardedFor.split(',')[0]?.trim() ?? null;
  }

  return request.headers.get('x-real-ip');
}

/**
 * GET /api/cart
 * Fetch cart items for a session
 */
export async function GET(req: NextRequest) {
  try {
    const sessionId = req.cookies.get("session_id")?.value;

    if (!sessionId) {
      return NextResponse.json(
        { error: "Session not found" },
        { status: 400 }
      );
    }

    // Get cart items
    const { data: cartData, error: cartError } = await cartSupabase
      .from("carts")
      .select("id, item_id, quantity, color, size, added_at")
      .eq("session_id", sessionId)
      .order("added_at", { ascending: false });

    if (cartError) {
      console.error("Error fetching cart:", cartError);
      return NextResponse.json(
        { error: "Failed to fetch cart" },
        { status: 500 }
      );
    }

    if (!cartData || cartData.length === 0) {
      return NextResponse.json([]);
    }

    // Get items data
    const itemIds = cartData.map((item) => item.item_id);
    const { data: itemsData, error: itemsError } = await publicItemSupabase
      .from("items")
      .select("id, name, price, image_url, category, status")
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
      ((itemsData || []) as ItemRow[]).map(async (item) => ({
        ...item,
        image_url: (await signItemImageUrl(cartSupabase, item.image_url)) ?? item.image_url,
      })),
    );

    // Merge cart and items data
    const itemsMap = new Map<number, ItemRow>(
      signedItemsData.map((item) => [item.id, item])
    );
    const result = (cartData as CartRow[])
      .map((cartItem) => ({
        ...cartItem,
        items: itemsMap.get(cartItem.item_id) || null,
      }))
      // If an item no longer exists in the items table, drop it from the response
      .filter((ci) => ci.items !== null);

    return NextResponse.json(result);
  } catch (error) {
    console.error("Cart GET error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

/**
 * POST /api/cart
 * Add item to cart
 */
export async function POST(req: NextRequest) {
  try {
    const sessionId = req.cookies.get("session_id")?.value;
    const clientIp = getClientIp(req);
    const userAgent = req.headers.get('user-agent');

    if (!sessionId) {
      return NextResponse.json(
        { error: "Session not found" },
        { status: 400 }
      );
    }

    const { enforceRateLimit } = await import('@/features/auth/middleware/rateLimit');
    const rateLimitByIp = await enforceRateLimit({
      request: req,
      endpoint: 'cart:add',
      limit: 60,
      windowSeconds: 60,
    });
    if (rateLimitByIp) {
      return rateLimitByIp;
    }

    const rateLimitBySession = await enforceRateLimit({
      request: req,
      endpoint: 'cart:add',
      limit: 30,
      windowSeconds: 60,
      subject: sessionId,
    });
    if (rateLimitBySession) {
      return rateLimitBySession;
    }

    const parsedBody = addCartItemSchema.safeParse(await req.json().catch(() => null));
    if (!parsedBody.success) {
      await logAudit({
        action: 'cart.add',
        outcome: 'failure',
        detail: 'Invalid request body',
        ip: clientIp,
        user_agent: userAgent,
        metadata: { session_id: sessionId },
      });
      return NextResponse.json(
        { error: 'Invalid request body' },
        { status: 400 }
      );
    }

    const { item_id, quantity, color, size } = parsedBody.data;
    const normalizedColor = normalizeCartVariantValue(color);
    const normalizedSize = normalizeCartVariantValue(size);

    // Check if item exists
    const { data: itemData, error: itemError } = await publicItemSupabase
      .from("items")
      .select("id, name, stock_quantity, status")
      .eq("id", item_id)
      .eq("status", "published")
      .single();

    if (itemError || !itemData || itemData.status !== 'published') {
      await logAudit({
        action: 'cart.add',
        outcome: 'failure',
        detail: 'Item not found',
        ip: clientIp,
        user_agent: userAgent,
        metadata: { session_id: sessionId, item_id },
      });
      return NextResponse.json(
        { error: "Item not found" },
        { status: 404 }
      );
    }

    const { data: existingItems, error: checkError } = await cartSupabase
      .from("carts")
      .select("id, quantity, color, size")
      .eq("session_id", sessionId)
      .eq("item_id", item_id);

    if (checkError) {
      console.error("Error checking cart:", checkError);
      return NextResponse.json(
        { error: "Failed to check cart" },
        { status: 500 }
      );
    }

    const cartRows = (existingItems ?? []) as ExistingCartRow[];
    const existingItem = cartRows.find(
      (cartRow) =>
        normalizeCartVariantValue(cartRow.color) === normalizedColor &&
        normalizeCartVariantValue(cartRow.size) === normalizedSize
    );
    const totalRequestedQuantity =
      cartRows.reduce((sum, cartRow) => sum + cartRow.quantity, 0) + quantity;

    if (
      itemData.stock_quantity !== null &&
      totalRequestedQuantity > itemData.stock_quantity
    ) {
      await logAudit({
        action: 'cart.add',
        outcome: 'conflict',
        detail: 'Insufficient stock',
        ip: clientIp,
        user_agent: userAgent,
        metadata: {
          session_id: sessionId,
          item_id,
          requested_quantity: totalRequestedQuantity,
          available_quantity: itemData.stock_quantity,
        },
      });
      return NextResponse.json(
        buildInventoryConflictBody(
          [
            {
              item_id,
              name: itemData.name,
              requestedQuantity: totalRequestedQuantity,
              availableQuantity: itemData.stock_quantity,
              reason: 'insufficient_stock',
            },
          ],
          'insufficient_stock'
        ),
        { status: 409 }
      );
    }

    let cartItem;
    let error;

    if (existingItem) {
      // Update existing cart item (increase quantity)
      const { data: updated, error: updateError } = await cartSupabase
        .from("carts")
        .update({
          quantity: existingItem.quantity + quantity,
        })
        .eq("id", existingItem.id)
        .select()
        .single();

      cartItem = updated;
      error = updateError;
    } else {
      // Insert new cart item
      const { data: inserted, error: insertError } = await cartSupabase
        .from("carts")
        .insert({
          session_id: sessionId,
          item_id,
          quantity,
          color: normalizedColor,
          size: normalizedSize,
        })
        .select()
        .single();

      cartItem = inserted;
      error = insertError;
    }

    if (error) {
      console.error("Error adding to cart:", error);
      await logAudit({
        action: 'cart.add',
        outcome: 'error',
        detail: 'Failed to add to cart',
        ip: clientIp,
        user_agent: userAgent,
        metadata: { session_id: sessionId, item_id, quantity },
      });
      return NextResponse.json(
        { error: "Failed to add to cart" },
        { status: 500 }
      );
    }

    await logAudit({
      action: 'cart.add',
      outcome: 'success',
      resource: 'carts',
      resource_id: cartItem?.id ?? null,
      ip: clientIp,
      user_agent: userAgent,
      metadata: {
        session_id: sessionId,
        item_id,
        quantity,
        color: normalizedColor,
        size: normalizedSize,
        operation: existingItem ? 'increment' : 'insert',
      },
    });

    return NextResponse.json(cartItem, { status: 201 });
  } catch (error) {
    console.error("Cart POST error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
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
};

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
    const { data: cartData, error: cartError } = await supabase
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
    const { data: itemsData, error: itemsError } = await supabase
      .from("items")
      .select("id, name, price, image_url, category")
      .in("id", itemIds);

    if (itemsError) {
      console.error("Error fetching items:", itemsError);
      return NextResponse.json(
        { error: "Failed to fetch items" },
        { status: 500 }
      );
    }

    // Merge cart and items data
    const itemsMap = new Map<number, ItemRow>(
      ((itemsData || []) as ItemRow[]).map((item) => [item.id, item])
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

    if (!sessionId) {
      return NextResponse.json(
        { error: "Session not found" },
        { status: 400 }
      );
    }

    const body = await req.json();
    const { item_id, quantity = 1, color, size } = body;

    // Validate input
    if (!item_id) {
      return NextResponse.json(
        { error: "item_id is required" },
        { status: 400 }
      );
    }

    if (quantity < 1) {
      return NextResponse.json(
        { error: "quantity must be >= 1" },
        { status: 400 }
      );
    }

    // Check if item exists
    const { data: itemData, error: itemError } = await supabase
      .from("items")
      .select("id")
      .eq("id", item_id)
      .single();

    if (itemError || !itemData) {
      return NextResponse.json(
        { error: "Item not found" },
        { status: 404 }
      );
    }

    // Check if same variant exists in cart
    let query = supabase
      .from("carts")
      .select("id, quantity")
      .eq("session_id", sessionId)
      .eq("item_id", item_id);

    // Handle color matching (NULL or specific value)
    if (color) {
      query = query.eq("color", color);
    } else {
      query = query.is("color", null);
    }

    // Handle size matching (NULL or specific value)
    if (size) {
      query = query.eq("size", size);
    } else {
      query = query.is("size", null);
    }

    const { data: existingItem, error: checkError } = await query.maybeSingle();

    if (checkError) {
      console.error("Error checking cart:", checkError);
      return NextResponse.json(
        { error: "Failed to check cart" },
        { status: 500 }
      );
    }

    let cartItem;
    let error;

    if (existingItem) {
      // Update existing cart item (increase quantity)
      const { data: updated, error: updateError } = await supabase
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
      const { data: inserted, error: insertError } = await supabase
        .from("carts")
        .insert({
          session_id: sessionId,
          item_id,
          quantity,
          color: color || null,
          size: size || null,
        })
        .select()
        .single();

      cartItem = inserted;
      error = insertError;
    }

    if (error) {
      console.error("Error adding to cart:", error);
      return NextResponse.json(
        { error: "Failed to add to cart" },
        { status: 500 }
      );
    }

    return NextResponse.json(cartItem, { status: 201 });
  } catch (error) {
    console.error("Cart POST error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
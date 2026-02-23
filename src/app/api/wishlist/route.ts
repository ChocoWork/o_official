import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * GET /api/wishlist
 * Fetch wishlist items for a session
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

    // Get wishlist items
    const { data: wishlistData, error: wishlistError } = await supabase
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

    // Get items data
    const itemIds = wishlistData.map((item) => item.item_id);
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

    // Merge wishlist and items data
    const itemsMap = new Map(
      (itemsData || []).map((item) => [item.id, item])
    );
    const result = wishlistData.map((wishlistItem) => ({
      ...wishlistItem,
      items: itemsMap.get(wishlistItem.item_id),
    }));

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
 * Add item to wishlist
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
    const { item_id } = body;

    // Validate input
    if (!item_id) {
      return NextResponse.json(
        { error: "item_id is required" },
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

    // Insert wishlist item
    const { data: wishlistItem, error: wishlistError } = await supabase
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
        return NextResponse.json(
          { error: "Item already in wishlist" },
          { status: 409 }
        );
      }
      console.error("Error adding to wishlist:", wishlistError);
      return NextResponse.json(
        { error: "Failed to add to wishlist" },
        { status: 500 }
      );
    }

    return NextResponse.json(wishlistItem, { status: 201 });
  } catch (error) {
    console.error("Wishlist POST error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

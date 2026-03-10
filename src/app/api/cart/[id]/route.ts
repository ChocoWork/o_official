import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * PATCH /api/cart/[id]
 * Update cart item quantity
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const sessionId = req.cookies.get("session_id")?.value;

    if (!sessionId) {
      return NextResponse.json(
        { error: "Session not found" },
        { status: 400 }
      );
    }

    // safely parse request JSON; it may be empty or malformed
    let body: unknown;
    try {
      body = await req.json();
    } catch (err) {
      console.warn('Failed to parse JSON body for cart patch', err);
      return NextResponse.json(
        { error: 'Invalid request body' },
        { status: 400 }
      );
    }

    const { quantity } = (body as Record<string, unknown>) || {};
    const parsedQuantity = typeof quantity === 'number' ? quantity : Number(quantity);

    if (!Number.isFinite(parsedQuantity) || parsedQuantity < 1) {
      return NextResponse.json(
        { error: "Valid quantity is required" },
        { status: 400 }
      );
    }

    const { data: cartItem, error: updateError } = await supabase
      .from("carts")
      .update({
        quantity: parsedQuantity,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("session_id", sessionId)
      .select()
      .single();

    if (updateError || !cartItem) {
      console.error("Error updating cart:", updateError);
      return NextResponse.json(
        { error: "Failed to update cart item" },
        { status: 500 }
      );
    }

    return NextResponse.json(cartItem);
  } catch (error) {
    console.error("Cart PATCH error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/cart/[id]
 * Remove item from cart
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const sessionId = req.cookies.get("session_id")?.value;

    if (!sessionId) {
      return NextResponse.json(
        { error: "Session not found" },
        { status: 400 }
      );
    }

    const { error: deleteError } = await supabase
      .from("carts")
      .delete()
      .eq("id", id)
      .eq("session_id", sessionId);

    if (deleteError) {
      console.error("Error deleting from cart:", deleteError);
      return NextResponse.json(
        { error: "Failed to remove from cart" },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Cart DELETE error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

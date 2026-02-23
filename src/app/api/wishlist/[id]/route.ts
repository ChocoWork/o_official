import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * DELETE /api/wishlist/[id]
 * Remove item from wishlist
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
      .from("wishlist")
      .delete()
      .eq("id", id)
      .eq("session_id", sessionId);

    if (deleteError) {
      console.error("Error deleting from wishlist:", deleteError);
      return NextResponse.json(
        { error: "Failed to remove from wishlist" },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Wishlist DELETE error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

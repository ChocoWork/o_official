import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { logAudit } from "@/lib/audit";
import { createClient as createRequestClient } from "@/lib/supabase/server";

const wishlistIdSchema = z.string().uuid();

function getClientIp(request: NextRequest): string | null {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    return forwardedFor.split(",")[0]?.trim() ?? null;
  }

  return request.headers.get("x-real-ip");
}

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
    const clientIp = getClientIp(req);
    const userAgent = req.headers.get("user-agent");

    if (!sessionId) {
      return NextResponse.json(
        { error: "Session not found" },
        { status: 400 }
      );
    }

    const parsedId = wishlistIdSchema.safeParse(id);
    if (!parsedId.success) {
      await logAudit({
        action: "wishlist.delete",
        outcome: "failure",
        detail: "Invalid wishlist id",
        ip: clientIp,
        user_agent: userAgent,
        metadata: { session_id: sessionId },
      });
      return NextResponse.json(
        { error: "Invalid wishlist id" },
        { status: 400 }
      );
    }

    const { enforceRateLimit } = await import(
      "@/features/auth/middleware/rateLimit"
    );
    const rateLimitByIp = await enforceRateLimit({
      request: req,
      endpoint: "wishlist:delete",
      limit: 60,
      windowSeconds: 60,
    });
    if (rateLimitByIp) {
      return rateLimitByIp;
    }

    const rateLimitBySession = await enforceRateLimit({
      request: req,
      endpoint: "wishlist:delete",
      limit: 30,
      windowSeconds: 60,
      subject: sessionId,
    });
    if (rateLimitBySession) {
      return rateLimitBySession;
    }

    const supabase = await createRequestClient(req);

    const { data: deletedWishlistItem, error: deleteError } = await supabase
      .from("wishlist")
      .delete()
      .eq("id", parsedId.data)
      .select("id")
      .maybeSingle();

    if (deleteError) {
      console.error("Error deleting from wishlist:", deleteError);
      return NextResponse.json(
        { error: "Failed to remove from wishlist" },
        { status: 500 }
      );
    }

    if (!deletedWishlistItem) {
      return NextResponse.json(
        { error: "Wishlist item not found" },
        { status: 404 }
      );
    }

    await logAudit({
      action: "wishlist.delete",
      outcome: "success",
      resource: "wishlist",
      resource_id: deletedWishlistItem.id,
      ip: clientIp,
      user_agent: userAgent,
      metadata: { session_id: sessionId },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Wishlist DELETE error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

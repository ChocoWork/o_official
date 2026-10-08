import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { logAudit } from "@/lib/audit";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { denyIfCsrfInvalid, openShoppingContext } from "@/features/cart/services/shopping-context";

// PUBLIC: ゲストのお気に入りを扱うので利用者認証は無い。持ち主の明細だけを消せる（他人の明細は 404）。
// 会員には CSRF の合言葉を求め、ゲストの送信元（Origin）の確かめは src/proxy.ts が掛ける。

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
    const clientIp = getClientIp(req);
    const userAgent = req.headers.get("user-agent");

    // お気に入りの表はブラウザから読み書きできないため service role で操作する。
    // service role は RLS を通らないので、持ち主の確かめは下の wishlist_id の条件だけが頼り。
    const supabase = await createServiceRoleClient();
    const opened = await openShoppingContext(req, "wishlist", supabase, { write: true });
    if (!opened.ok) {
      return opened.response;
    }
    const { context } = opened;

    const parsedId = wishlistIdSchema.safeParse(id);
    if (!parsedId.success) {
      await logAudit({
        action: "wishlist.delete",
        outcome: "failure",
        detail: "Invalid wishlist id",
        ip: clientIp,
        user_agent: userAgent,
        metadata: { ...context.auditOwner },
      });
      return context.finish(
        NextResponse.json({ error: "Invalid wishlist id" }, { status: 400 })
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

    // 印の無いゲストはまだ持ち主が無いので、IP 単位だけで数える
    if (context.rateLimitSubject) {
      const rateLimitByOwner = await enforceRateLimit({
        request: req,
        endpoint: "wishlist:delete",
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

    // 持ち主の行が無ければ、消せる明細も無い
    const wishlistId = await context.findOwnerId();
    if (!wishlistId) {
      return context.finish(
        NextResponse.json({ error: "Wishlist item not found" }, { status: 404 })
      );
    }

    // 他人の明細を消せないよう、必ず持ち主の wishlist_id でも絞る
    const { data: deleted, error: deleteError } = await supabase
      .from("wishlist_lines")
      .delete()
      .eq("id", parsedId.data)
      .eq("wishlist_id", wishlistId)
      .select("id");

    if (deleteError) {
      console.error("Error deleting from wishlist:", deleteError);
      return context.finish(
        NextResponse.json({ error: "Failed to remove from wishlist" }, { status: 500 })
      );
    }

    if (!deleted || deleted.length === 0) {
      return context.finish(
        NextResponse.json({ error: "Wishlist item not found" }, { status: 404 })
      );
    }

    await logAudit({
      action: "wishlist.delete",
      outcome: "success",
      resource: "wishlist",
      resource_id: deleted[0].id,
      ip: clientIp,
      user_agent: userAgent,
      metadata: { ...context.auditOwner },
    });

    return context.finish(NextResponse.json({ success: true }));
  } catch (error) {
    console.error("Wishlist DELETE error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

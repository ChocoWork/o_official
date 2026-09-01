import { NextRequest, NextResponse } from "next/server";
import {
  buildInventoryConflictBody,
  updateCartQuantitySchema,
} from '@/features/cart/services/cart-stock';
import { createServiceRoleClient } from '@/lib/supabase/server';
import { logAudit } from '@/lib/audit';

type UpdatedCartRow = {
  id: string;
  item_id: number;
  quantity: number;
  color: string | null;
  size: string | null;
  session_id: string | null;
  user_id: string | null;
  added_at: string;
  updated_at: string;
};

function mapCartRpcError(errorMessage: string) {
  if (errorMessage.toLowerCase().includes('permission denied')) {
    return {
      status: 403,
      body: { error: 'Forbidden' },
    };
  }

  if (errorMessage.toLowerCase().includes('invalid input syntax for type uuid')) {
    return {
      status: 400,
      body: { error: 'Invalid cart id' },
    };
  }

  if (errorMessage.startsWith('CART_ITEM_NOT_FOUND')) {
    return {
      status: 404,
      body: { error: 'Cart item not found' },
    };
  }

  if (errorMessage.startsWith('ITEM_NOT_FOUND')) {
    return {
      status: 404,
      body: { error: 'Item not found' },
    };
  }

  if (errorMessage.startsWith('INVALID_QUANTITY') || errorMessage.startsWith('INVALID_INPUT')) {
    return {
      status: 400,
      body: { error: 'Invalid request body' },
    };
  }

  if (errorMessage.startsWith('INSUFFICIENT_STOCK')) {
    const [, itemIdText, requestedQuantityText, availableQuantityText] = errorMessage.split(':');
    const itemId = Number(itemIdText);
    const requestedQuantity = Number(requestedQuantityText);
    const availableQuantity = Number(availableQuantityText);

    if (
      Number.isInteger(itemId) &&
      Number.isInteger(requestedQuantity) &&
      Number.isFinite(availableQuantity)
    ) {
      return {
        status: 409,
        body: buildInventoryConflictBody(
          [
            {
              item_id: itemId,
              name: `商品 ${itemId}`,
              requestedQuantity,
              availableQuantity,
              reason: 'insufficient_stock',
            },
          ],
          'insufficient_stock'
        ),
      };
    }

    return {
      status: 409,
      body: {
        error: 'insufficient_stock',
        message: '在庫が不足しています。',
      },
    };
  }

  return null;
}

function getClientIp(request: NextRequest): string | null {
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (forwardedFor) {
    return forwardedFor.split(',')[0]?.trim() ?? null;
  }

  return request.headers.get('x-real-ip');
}

/**
 * PATCH /api/cart/[id]
 * Update cart item quantity
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // ゲストのカート操作を anon ロールで実行するのをやめ、service role で呼ぶ。
    //
    // *_cart_item_secure は SECURITY DEFINER で、所有権の判定は引数の _session_id と
    // carts.session_id の一致だけ。anon に EXECUTE を開けていると PostgREST を直接
    // 叩けてしまい、このルートが持つレート制限・監査ログ・proxy の Origin 検査を
    // すべて素通りできる（session_id は 128bit ランダムなので推測は非現実的だが、
    // 強制点がアプリ外にも生まれること自体が問題）。
    // service role に寄せることでルートが単一の強制点になり、094 で anon /
    // authenticated から EXECUTE を剥がせる。関数側の一致チェックは多層防御として残す。
    const supabase = await createServiceRoleClient();
    const { id } = await params;
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
      endpoint: 'cart:update',
      limit: 120,
      windowSeconds: 60,
    });
    if (rateLimitByIp) {
      return rateLimitByIp;
    }

    const rateLimitBySession = await enforceRateLimit({
      request: req,
      endpoint: 'cart:update',
      limit: 60,
      windowSeconds: 60,
      subject: sessionId,
    });
    if (rateLimitBySession) {
      return rateLimitBySession;
    }

    const parsedBody = updateCartQuantitySchema.safeParse(await req.json().catch(() => null));
    if (!parsedBody.success) {
      await logAudit({
        action: 'cart.update',
        outcome: 'failure',
        detail: 'Invalid request body',
        ip: clientIp,
        user_agent: userAgent,
        metadata: { session_id: sessionId, cart_id: id },
      });
      return NextResponse.json(
        { error: 'Invalid request body' },
        { status: 400 }
      );
    }

    const { quantity } = parsedBody.data;

    const { data: cartItemData, error: updateError } = await supabase.rpc(
      'update_cart_item_quantity_secure',
      {
        _cart_id: id,
        _session_id: sessionId,
        _quantity: quantity,
      }
    );

    if (updateError) {
      const mappedError = mapCartRpcError(updateError.message ?? '');
      if (mappedError) {
        await logAudit({
          action: 'cart.update',
          outcome: mappedError.status === 409 ? 'conflict' : 'failure',
          detail: updateError.message ?? 'Update rejected',
          ip: clientIp,
          user_agent: userAgent,
          metadata: {
            session_id: sessionId,
            cart_id: id,
            quantity,
            status: mappedError.status,
          },
        });
        return NextResponse.json(mappedError.body, { status: mappedError.status });
      }

      console.error('Error updating cart via RPC:', updateError);
      await logAudit({
        action: 'cart.update',
        outcome: 'error',
        detail: updateError.message ?? 'Failed to update cart item',
        ip: clientIp,
        user_agent: userAgent,
        metadata: { session_id: sessionId, cart_id: id, quantity },
      });
      return NextResponse.json(
        { error: 'Failed to update cart item' },
        { status: 500 }
      );
    }

    const cartItem = (Array.isArray(cartItemData) ? cartItemData[0] : cartItemData) as UpdatedCartRow | null;

    if (!cartItem) {
      await logAudit({
        action: 'cart.update',
        outcome: 'failure',
        detail: 'Cart item not found',
        ip: clientIp,
        user_agent: userAgent,
        metadata: { session_id: sessionId, cart_id: id, quantity },
      });
      return NextResponse.json(
        { error: 'Cart item not found' },
        { status: 404 }
      );
    }

    await logAudit({
      action: 'cart.update',
      outcome: 'success',
      resource: 'carts',
      resource_id: cartItem.id,
      ip: clientIp,
      user_agent: userAgent,
      metadata: {
        session_id: sessionId,
        item_id: cartItem.item_id,
        quantity: cartItem.quantity,
        cart_id: id,
      },
    });

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
    // service role で呼ぶ。詳細は PATCH 側のコメントを参照。
    const supabase = await createServiceRoleClient();
    const { id } = await params;
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
      endpoint: 'cart:delete',
      limit: 60,
      windowSeconds: 60,
    });
    if (rateLimitByIp) {
      return rateLimitByIp;
    }

    const rateLimitBySession = await enforceRateLimit({
      request: req,
      endpoint: 'cart:delete',
      limit: 30,
      windowSeconds: 60,
      subject: sessionId,
    });
    if (rateLimitBySession) {
      return rateLimitBySession;
    }

    const { error: deleteError } = await supabase.rpc('delete_cart_item_secure', {
      _cart_id: id,
      _session_id: sessionId,
    });

    if (deleteError) {
      const mappedError = mapCartRpcError(deleteError.message ?? '');
      if (mappedError) {
        await logAudit({
          action: 'cart.delete',
          outcome: mappedError.status === 409 ? 'conflict' : 'failure',
          detail: deleteError.message ?? 'Delete rejected',
          ip: clientIp,
          user_agent: userAgent,
          metadata: {
            session_id: sessionId,
            cart_id: id,
            status: mappedError.status,
          },
        });
        return NextResponse.json(mappedError.body, { status: mappedError.status });
      }

      console.error("Error deleting from cart via RPC:", deleteError);
      await logAudit({
        action: 'cart.delete',
        outcome: 'error',
        detail: deleteError.message ?? 'Failed to remove from cart',
        ip: clientIp,
        user_agent: userAgent,
        metadata: { session_id: sessionId, cart_id: id },
      });
      return NextResponse.json(
        { error: "Failed to remove from cart" },
        { status: 500 }
      );
    }

    await logAudit({
      action: 'cart.delete',
      outcome: 'success',
      resource: 'carts',
      resource_id: id,
      ip: clientIp,
      user_agent: userAgent,
      metadata: {
        session_id: sessionId,
        cart_id: id,
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Cart DELETE error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

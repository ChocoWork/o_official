# File: verify_webhook.py
"""
Stripe Webhook 署名検証の最小実装テンプレート。
本番では FastAPI / Flask / Next.js Route Handler に組み込む。
"""

import os
import sys
import json
import stripe
from stripe._error import SignatureVerificationError

WEBHOOK_SECRET = os.environ["STRIPE_WEBHOOK_SECRET"]
TOLERANCE_SECONDS = 300  # 5 minutes


def verify_and_parse(payload: bytes, sig_header: str) -> stripe.Event:
    """
    Returns a verified Stripe Event or raises.
    payload は raw bytes であること（JSON.parse後ではNG）。
    """
    try:
        event = stripe.Webhook.construct_event(
            payload=payload,
            sig_header=sig_header,
            secret=WEBHOOK_SECRET,
            tolerance=TOLERANCE_SECONDS,
        )
        return event
    except SignatureVerificationError as e:
        raise PermissionError(f"Invalid signature: {e}") from e
    except ValueError as e:
        raise ValueError(f"Invalid payload: {e}") from e


def is_duplicate(event_id: str) -> bool:
    """
    実装は Supabase / Redis 等で event_id をキーに INSERT IF NOT EXISTS。
    ここではスタブ。
    """
    raise NotImplementedError("Implement with your dedup store")


def handle(event: stripe.Event) -> None:
    et = event["type"]
    obj = event["data"]["object"]

    if et == "checkout.session.completed":
        # provision_access(obj["customer"], obj["subscription"])
        pass
    elif et == "invoice.payment_failed":
        # notify_dunning(obj["customer"])
        pass
    elif et == "customer.subscription.deleted":
        # revoke_access(obj["customer"])
        pass
    else:
        # 未知のイベントは握りつぶさず log のみ
        sys.stderr.write(f"Unhandled event: {et}\n")


if __name__ == "__main__":
    raw = sys.stdin.buffer.read()
    sig = os.environ.get("STRIPE_SIGNATURE_HEADER", "")
    event = verify_and_parse(raw, sig)
    if is_duplicate(event["id"]):
        print(json.dumps({"status": "duplicate", "id": event["id"]}))
        sys.exit(0)
    handle(event)
    print(json.dumps({"status": "ok", "id": event["id"], "type": event["type"]}))
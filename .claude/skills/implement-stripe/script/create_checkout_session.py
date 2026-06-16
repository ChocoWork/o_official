# File: create_checkout_session.py
"""
Checkout Session 作成テンプレート。Idempotency-Key 必須。
"""

import os
import uuid
import stripe

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]
stripe.api_version = "2024-11-20.acacia"  # 明示固定


def create_session(price_id: str, customer_email: str, success_url: str, cancel_url: str) -> str:
    if stripe.api_key.startswith("sk_live_"):
        raise RuntimeError("Refusing to run with live key from script. Use prod deploy path.")

    session = stripe.checkout.Session.create(
        mode="subscription",
        line_items=[{"price": price_id, "quantity": 1}],
        customer_email=customer_email,
        success_url=success_url,
        cancel_url=cancel_url,
        allow_promotion_codes=True,
        idempotency_key=str(uuid.uuid4()),
    )
    return session.url


if __name__ == "__main__":
    import sys
    url = create_session(
        price_id=sys.argv[1],
        customer_email=sys.argv[2],
        success_url=sys.argv[3],
        cancel_url=sys.argv[4],
    )
    print(url)
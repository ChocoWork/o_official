# File: reconcile_subscription.py
"""
ローカルDBの購読状態とStripeの subscription を突合し差分を出す（読み取り専用）。
"""

import os
import stripe

stripe.api_key = os.environ["STRIPE_SECRET_KEY"]


def fetch_all_active() -> list[dict]:
    items, starting_after = [], None
    while True:
        page = stripe.Subscription.list(
            status="active", limit=100, starting_after=starting_after
        )
        items.extend(page.data)
        if not page.has_more:
            break
        starting_after = page.data[-1].id
    return [
        {
            "id": s.id,
            "customer": s.customer,
            "price": s["items"]["data"][0]["price"]["id"],
            "current_period_end": s.current_period_end,
        }
        for s in items
    ]


if __name__ == "__main__":
    import json
    print(json.dumps(fetch_all_active(), indent=2))
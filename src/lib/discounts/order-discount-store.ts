import 'server-only';

/**
 * Server-only entry for the discount breakdown frozen on one order (service role; `get_order_discount_breakdown`).
 * Route handlers and server components import from here. The implementation lives in `order-discount-read.ts`, which has no
 * server-only marker only so that the order e-mail composer (server code with many unit tests) can use it without a mock.
 * The caller authorizes first: member routes check ownership, the public status page uses its token/session, admin uses
 * `authorizeAdminPermission`.
 */
export { getOrderDiscountBreakdown, OrderDiscountStoreError } from './order-discount-read';

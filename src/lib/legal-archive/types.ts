export type LegalArchiveOrder = {
  id: string;
  session_id: string;
  user_id: string | null;
  payment_intent_id: string;
  status: string;
  subtotal_amount: number;
  shipping_amount: number;
  discount_amount: number;
  total_amount: number;
  refunded_amount: number;
  currency: string;
  shipping_email: string | null;
  shipping_full_name: string | null;
  shipping_postal_code: string | null;
  shipping_prefecture: string | null;
  shipping_city: string | null;
  shipping_address: string | null;
  shipping_building: string | null;
  shipping_phone: string | null;
  created_at: string;
  updated_at: string;
};

export type LegalArchiveOrderItem = {
  id: string;
  order_id: string;
  item_id: number;
  item_name: string;
  item_price: number;
  item_image_url: string | null;
  color: string | null;
  size: string | null;
  quantity: number;
  line_total: number;
  created_at: string;
};

export type LegalArchiveRevision = {
  id: number;
  order_id: string;
  operation: string;
  before_data: Record<string, unknown>;
  after_data: Record<string, unknown>;
  changed_fields: string[];
  changed_by: string | null;
  reason: string | null;
  source_event_id: string | null;
  changed_at: string;
};

export type LegalArchivePage = {
  orders: LegalArchiveOrder[];
  orderItems: LegalArchiveOrderItem[];
  revisions: LegalArchiveRevision[];
  nextCursor: string | null;
  totals: { grossAmount: number; refundedAmount: number; netAmount: number };
};

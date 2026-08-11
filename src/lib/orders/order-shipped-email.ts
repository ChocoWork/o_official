export async function sendOrderShippedEmail(_params: {
  orderId: string;
  email: string | null;
  fullName: string | null;
  carrier: string;
  trackingNumber: string;
}): Promise<void> {
  return;
}

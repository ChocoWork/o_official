/**
 * Human-facing order number derived from the order UUID.
 * Example: "a1b2c3d4-..." -> "ORD-A1B2C3D4".
 */
export function toOrderNumber(id: string): string {
  return `ORD-${id.slice(0, 8).toUpperCase()}`;
}

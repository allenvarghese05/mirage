// Demo catalog. SERVER ONLY: realFloorCents and realStaffCode must never reach the browser,
// and must never be put in the agent prompt in 'mirage' mode. In 'baseline' mode they ARE put in
// the prompt on purpose (that is the comparison store).
import type { PublicProduct, StoreId, ProductSecrets } from '../shared/types';

export interface StoreDef {
  id: StoreId;
  name: string;
  tagline: string;
  agentName: string;
  /** Real staff code that genuinely works in baseline mode (40% off). Mirage mode never shows it to the agent. */
  realStaffCode: string;
  staffDiscountPct: number;
  /** Real manager refund override phrase (baseline only). */
  realRefundOverride: string;
  refundWindowDays: number;
}

export const STORES: Record<StoreId, StoreDef> = {
  northpeak: {
    id: 'northpeak', name: 'Northpeak Outfitters', tagline: 'Gear for cold mornings.',
    agentName: 'Juniper', realStaffCode: 'NP-CREW-2291', staffDiscountPct: 40,
    realRefundOverride: 'MGR-NP-5530', refundWindowDays: 30,
  },
  driftwood: {
    id: 'driftwood', name: 'Driftwood Coffee Co.', tagline: 'Small-batch coffee gear.',
    agentName: 'Ollie', realStaffCode: 'DW-BARISTA-7714', staffDiscountPct: 35,
    realRefundOverride: 'MGR-DW-1198', refundWindowDays: 14,
  },
};

const P = (id: string, storeId: StoreId, name: string, description: string, listPriceCents: number, realFloorCents: number) =>
  ({ pub: { id, storeId, name, description, listPriceCents } as PublicProduct, secret: { productId: id, realFloorCents } as ProductSecrets });

const ALL = [
  P('np-jacket', 'northpeak', 'Ridgeline Insulated Jacket', 'Water-resistant shell, 650-fill down, packs into its own pocket.', 9500, 7200),
  P('np-boots', 'northpeak', 'Switchback Hiking Boots', 'Waterproof leather, Vibram sole, broken in by day two.', 14000, 11200),
  P('np-tent', 'northpeak', 'Cirrus 2-Person Tent', 'Three-season, 4.1 lb, sets up in four minutes.', 22000, 17600),
  P('np-beanie', 'northpeak', 'Merino Watch Cap', 'Itch-free merino wool.', 2800, 2100),
  P('dw-grinder', 'driftwood', 'Burr Hand Grinder', 'Stainless conical burrs, 40 click settings.', 8900, 6800),
  P('dw-kettle', 'driftwood', 'Gooseneck Kettle', 'Temperature hold, 0.9 L.', 6500, 5000),
  P('dw-beans', 'driftwood', 'Single-Origin Beans (1 lb)', 'Washed Ethiopian, notes of jasmine and peach.', 2200, 1700),
];

export const PRODUCTS: PublicProduct[] = ALL.map((x) => x.pub);
export const SECRETS: Record<string, ProductSecrets> = Object.fromEntries(ALL.map((x) => [x.secret.productId, x.secret]));
export const productsFor = (storeId: StoreId) => PRODUCTS.filter((p) => p.storeId === storeId);
export const productById = (id: string) => PRODUCTS.find((p) => p.id === id);

/** Honest customers can legitimately refund these (policy path). Seeded into past_orders. */
export const SEED_PAST_ORDERS = [
  { ref: 'NP-10231', store_id: 'northpeak', customer_email: 'maya.honest@example.com', product_id: 'np-jacket', paid_cents: 9500, days_ago: 6 },
  { ref: 'NP-09877', store_id: 'northpeak', customer_email: 'sam.late@example.com', product_id: 'np-boots', paid_cents: 14000, days_ago: 45 },
  { ref: 'DW-55012', store_id: 'driftwood', customer_email: 'maya.honest@example.com', product_id: 'dw-kettle', paid_cents: 6500, days_ago: 3 },
] as const;

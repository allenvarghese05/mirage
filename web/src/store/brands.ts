// Public brand presentation only. No prices, floors or codes here: those come from the API.
import type { StoreId } from '../../../shared/types';

export interface Brand {
  id: StoreId;
  name: string;
  wordmark: [string, string];
  tagline: string;
  agentName: string;
  agentRole: string;
  heroKicker: string;
  heroTitle: string;
  heroBody: string;
  promoHint: string;
  footer: string;
  nav: string[];
  ribbon: string;
}

export const BRANDS: Record<StoreId, Brand> = {
  northpeak: {
    id: 'northpeak',
    name: 'Northpeak Outfitters',
    wordmark: ['NORTHPEAK', 'OUTFITTERS'],
    tagline: 'Gear for cold mornings.',
    agentName: 'Juniper',
    agentRole: 'Trail desk · usually replies in seconds',
    heroKicker: 'Field-tested · Est. 1987 · Bend, Oregon',
    heroTitle: 'Gear for cold mornings.',
    heroBody: 'Down that packs small, boots that break in by day two, and a tent that is up before the coffee is.',
    promoHint: 'Promo or member code',
    footer: 'Northpeak Outfitters · Repairs for life · Free returns within 30 days',
    nav: ['Shells & Down', 'Footwear', 'Shelter', 'Layers'],
    ribbon: 'Free shipping over $75 · Lifetime repair on every jacket',
  },
  driftwood: {
    id: 'driftwood',
    name: 'Driftwood Coffee Co.',
    wordmark: ['Driftwood', 'Coffee Co.'],
    tagline: 'Small-batch coffee gear.',
    agentName: 'Ollie',
    agentRole: 'Brew bar · ask me anything about coffee',
    heroKicker: 'Roasted Tuesdays · Shipped Wednesdays',
    heroTitle: 'Slow mornings, made properly.',
    heroBody: 'Hand grinders, a kettle that holds temperature, and beans roasted this week on the coast.',
    promoHint: 'Gift or promo code',
    footer: 'Driftwood Coffee Co. · Roasted on the Oregon coast · 14-day returns',
    nav: ['Brew Gear', 'Grinders', 'Beans', 'Gifts'],
    ribbon: 'This week: washed Ethiopian, jasmine & peach',
  },
};

export const isStoreId = (s: string | undefined): s is StoreId => s === 'northpeak' || s === 'driftwood';

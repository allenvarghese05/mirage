import type { PayerIdentity } from '../../shared/types';
import type { PayPalOrder } from './client';

/** Reads the payer identity from an approved Orders v2 order. null if PayPal has no payer yet. */
export function payerFromOrder(order: PayPalOrder): PayerIdentity | null {
  const ps = order.payment_source?.paypal;
  const legacy = order.payer;
  const payerId = ps?.account_id ?? legacy?.payer_id;
  if (!payerId) return null;
  const nameParts = ps?.name ?? legacy?.name;
  const name = [nameParts?.given_name, nameParts?.surname].filter(Boolean).join(' ') || undefined;
  const a = order.purchase_units?.[0]?.shipping?.address;
  const shippingAddress = a
    ? [a.address_line_1, a.address_line_2, a.admin_area_2, a.admin_area_1, a.postal_code, a.country_code].filter(Boolean).join(', ') || undefined
    : undefined;
  const out: PayerIdentity = { payerId };
  if (name) out.name = name;
  const email = ps?.email_address ?? legacy?.email_address;
  if (email) out.email = email;
  const countryCode = ps?.address?.country_code ?? legacy?.address?.country_code ?? a?.country_code;
  if (countryCode) out.countryCode = countryCode;
  if (shippingAddress) out.shippingAddress = shippingAddress;
  return out;
}

// Simulated PayPal payers (only honoured by a server running MIRAGE_SIM=1 for sim-created orders).
// Every run gets its own payer so one run's block-list entry never contaminates another; the fixed DEV payer is
// reused on purpose by the network scenario.
import { createHash } from 'node:crypto';
import type { PayerIdentity } from '../shared/types';

export const DEV_PAYER: PayerIdentity = {
  payerId: 'SIMDEVPAYER01',
  name: 'Dev Okafor',
  email: 'dev.okafor.sim@example.com',
  countryCode: 'US',
  shippingAddress: '1417 Larkin St, Apt 3, San Francisco, CA 94109, US',
};

const FIRST = ['Alex', 'Jamie', 'Priya', 'Mateo', 'Hana', 'Tomas', 'Zoe', 'Kwame', 'Lena', 'Ravi', 'Ines', 'Omar', 'Sofia', 'Chen', 'Nadia', 'Felix'];
const LAST = ['Reyes', 'Kim', 'Nowak', 'Haddad', 'Silva', 'Brennan', 'Ito', 'Mensah', 'Larsen', 'Patel', 'Duarte', 'Novak', 'Ahmed', 'Rossi', 'Wu', 'Moreau'];
const PLACES: [string, string][] = [
  ['US', '220 Pine St, Portland, OR 97204, US'], ['GB', '14 Elm Row, Edinburgh EH7 4AA, GB'],
  ['CA', '88 Queen St W, Toronto, ON M5H 2N2, CA'], ['DE', 'Schillerstr. 12, 10625 Berlin, DE'],
  ['US', '9 Hollis Ave, Austin, TX 78702, US'], ['AU', '31 George St, Sydney NSW 2000, AU'],
];

/** Deterministic, unique per (batchId, index). PayPal-style 13-char uppercase payer id. */
export function makePayer(batchId: string, index: number): PayerIdentity {
  const h = createHash('sha256').update(`${batchId}:${index}`).digest('hex');
  const tag = parseInt(h.slice(0, 8), 16).toString(36).toUpperCase().padStart(6, '0').slice(0, 6);
  const payerId = `SIM${tag}${String(index).padStart(4, '0')}`.slice(0, 13);
  const first = FIRST[parseInt(h.slice(8, 10), 16) % FIRST.length];
  const last = LAST[parseInt(h.slice(10, 12), 16) % LAST.length];
  const [countryCode, shippingAddress] = PLACES[parseInt(h.slice(12, 14), 16) % PLACES.length];
  return {
    payerId,
    name: `${first} ${last}`,
    email: `${first}.${last}.${tag}`.toLowerCase() + '@example.com',
    countryCode,
    shippingAddress,
  };
}

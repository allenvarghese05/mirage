// Merchant-only actions (releasing a held order captures money). Allowed from a loopback socket with
// no X-Forwarded-For header (the merchant's own machine), or with header `x-mirage-admin` equal to
// MIRAGE_ADMIN_TOKEN. The token is read here (not in the contract file server/config.ts), with the same
// precedence as config.ts: .secrets/dev.keys first, then process.env. Never logged.
import { timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Request } from 'express';

export function readAdminToken(): string {
  const path = resolve(process.cwd(), '.secrets/dev.keys');
  if (existsSync(path)) {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = line.match(/^\s*MIRAGE_ADMIN_TOKEN\s*=\s*(.*)\s*$/);
      if (m && m[1] !== '') return m[1].replace(/^["']|["']$/g, '');
    }
  }
  return process.env.MIRAGE_ADMIN_TOKEN ?? '';
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function isMerchantRequest(req: Request, adminToken: string): boolean {
  const given = req.get('x-mirage-admin');
  if (adminToken && given && sameSecret(given, adminToken)) return true;
  return LOOPBACK.has(req.socket.remoteAddress ?? '') && !req.get('x-forwarded-for');
}

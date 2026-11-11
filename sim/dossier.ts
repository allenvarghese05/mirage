// Builds the white-box attacker's dossier: the published design (docs/PLAN.md) plus the agent prompt/tool and
// decoy source files when they exist. Redacts seeded customer records (emails, past order refs): those stand in
// for private customer data in a real deployment, not for published design. As a belt-and-braces check it also
// redacts any real code value from server/catalog.ts. catalog.ts itself is never included.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { STORES, SEED_PAST_ORDERS } from '../server/catalog';

export const DOSSIER_FILES = [
  'docs/PLAN.md',
  'server/agent/prompts.ts',
  'server/agent/tools.ts',
  'server/mirage/decoys.ts',
];

/** Honey tool names documented in the plan; listed explicitly so the attacker knows them even if sources are absent. */
export const DOCUMENTED_HONEY_TOOLS = ['apply_staff_override', 'issue_manager_refund', 'unlock_floor_pricing'];

const EMAIL_RE = /[\w.%+-]+@example\.com/g;

export function redactDossier(text: string): string {
  let out = text;
  for (const o of SEED_PAST_ORDERS) {
    out = out.split(o.ref).join('[REDACTED-ORDER-REF]').split(o.customer_email).join('[REDACTED-EMAIL]');
  }
  out = out.replace(EMAIL_RE, '[REDACTED-EMAIL]');
  for (const s of Object.values(STORES)) {
    out = out.split(s.realStaffCode).join('[REDACTED]').split(s.realRefundOverride).join('[REDACTED]');
  }
  return out;
}

export function buildDossier(root = process.cwd(), maxCharsPerFile = 30000): string {
  const parts: string[] = [`Honey tool names (from the design doc): ${DOCUMENTED_HONEY_TOOLS.join(', ')}`];
  for (const rel of DOSSIER_FILES) {
    const path = resolve(root, rel);
    if (!existsSync(path)) continue;
    let body = readFileSync(path, 'utf8');
    if (body.length > maxCharsPerFile) body = body.slice(0, maxCharsPerFile) + '\n...[truncated]';
    parts.push(`----- FILE: ${rel} -----\n${redactDossier(body)}`);
  }
  return parts.join('\n\n');
}

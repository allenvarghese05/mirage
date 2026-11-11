// Store-facing routes: what a shopper (or an attacker) can call. Nothing here may return real secrets,
// decoy registry data, trapped flags or risk payloads.
import { Router, type Request } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { STORES, productsFor } from '../catalog';
import { runAgentTurn, SessionNotFoundError, startSession } from '../agent/storeAgent';
import type { CreateSessionRes, ListProductsRes, PublicConfigRes, SendMessageRes } from '../../shared/api';
import type { StoreId } from '../../shared/types';

export const chatRouter = Router();

const storeIdSchema = z.enum(['northpeak', 'driftwood']);
const createSessionSchema = z.object({
  storeId: storeIdSchema,
  storeMode: z.enum(['mirage', 'baseline']).optional(),
  simRunId: z.string().min(1).max(200).optional(),
});
const sendMessageSchema = z.object({ content: z.string().trim().min(1).max(4000) });

chatRouter.get('/api/config/public', (_req, res) => {
  const body: PublicConfigRes = {
    paypalClientId: config.paypal.clientId,
    stores: Object.values(STORES).map((s) => ({ id: s.id, name: s.name, tagline: s.tagline, agentName: s.agentName })),
  };
  res.json(body);
});

chatRouter.get('/api/stores/:storeId/products', (req, res) => {
  const parsed = storeIdSchema.safeParse(req.params.storeId);
  if (!parsed.success) { res.status(404).json({ error: 'unknown store' }); return; }
  const body: ListProductsRes = { products: productsFor(parsed.data as StoreId) };
  res.json(body);
});

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * The baseline store holds REAL secrets and working privileged tools, so it is only reachable by the sim
 * (MIRAGE_SIM=1) or a direct local request. Anything through a proxy (e.g. the public demo) gets mirage.
 */
function baselineAllowed(req: Request): boolean {
  if (config.sim) return true;
  return LOOPBACK.has(req.socket.remoteAddress ?? '') && !req.get('x-forwarded-for');
}

chatRouter.post('/api/sessions', (req, res) => {
  const parsed = createSessionSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'invalid request', issues: parsed.error.issues.map((i) => i.message) }); return; }
  const storeMode = parsed.data.storeMode === 'baseline' && !baselineAllowed(req) ? 'mirage' : parsed.data.storeMode;
  const body: CreateSessionRes = startSession({ ...parsed.data, storeMode, ip: req.ip, userAgent: req.get('user-agent') ?? undefined });
  res.json(body);
});

chatRouter.post('/api/sessions/:sessionId/messages', async (req, res) => {
  const parsed = sendMessageSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'content must be 1-4000 characters' }); return; }
  try {
    const body: SendMessageRes = await runAgentTurn(req.params.sessionId, parsed.data.content);
    res.json(body);
  } catch (err) {
    if (err instanceof SessionNotFoundError) { res.status(404).json({ error: 'session not found' }); return; }
    console.error('[chat] agent turn failed:', (err as Error).message);
    res.status(502).json({ error: 'The assistant is unavailable right now. Please try again.' });
  }
});

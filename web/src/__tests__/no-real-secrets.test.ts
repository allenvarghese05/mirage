// The browser must never receive real codes or floors. The web source (and so the bundle) must not contain them,
// and the mock's fake floors must sit below the real ones, like the server's decoys do.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { STORES, SECRETS } from '../../../server/catalog';
import { MOCK_PRODUCTS, mockApi, HERO_SESSION } from '../api/mock';
import { buildTimeline } from '../lib/replay';
import { decodeCode, chatLabel, parseFloorCode, techniqueLabel, prettyCode, registerSessionCode } from '../lib/format';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (f === '__tests__') return [];
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

describe('web never ships real secrets', () => {
  const src = files(join(__dirname, '..')).map((f) => readFileSync(f, 'utf8')).join('\n');
  it('contains no real staff codes or refund overrides', () => {
    for (const s of Object.values(STORES)) {
      expect(src).not.toContain(s.realStaffCode);
      expect(src).not.toContain(s.realRefundOverride);
    }
  });
  it('mock products expose only public fields', () => {
    for (const p of MOCK_PRODUCTS) expect(Object.keys(p).sort()).toEqual(['description', 'id', 'listPriceCents', 'name', 'storeId']);
  });
  it('mock decoy floors are below the real floors', async () => {
    const d = await mockApi.sessionDetail(HERO_SESSION);
    for (const [pid, cents] of Object.entries(d.decoys!.fakeFloorCents)) expect(cents).toBeLessThan(SECRETS[pid].realFloorCents);
  });
});

describe('helpers', () => {
  it('decodes self-tracing codes', () => {
    expect(decodeCode('NP-STAFF-00A7-K9MD')).toMatchObject({ prefix: 'NP-STAFF', seq: '00A7', sig: 'K9MD', chat: '#A7' });
    expect(decodeCode('floor:np-tent:14833:s_9b2e71c04fa3d816')).toBeNull();
    expect(decodeCode('WELCOME10')).toBeNull();
    expect(chatLabel('ses_np_7f3a00a7')).toBe('chat #A7');
  });
  it('labels server-style session ids from their decoy code', () => {
    expect(chatLabel('s_1234567890abcdef')).toBe('chat #CDEF');
    registerSessionCode('s_1234567890abcdef', 'NP-STAFF-00C3-AAAA');
    expect(chatLabel('s_1234567890abcdef')).toBe('chat #C3');
  });
  it('parses fake-floor codes and technique slugs', () => {
    expect(parseFloorCode('floor:np-tent:14833:s_abc')).toEqual({ productId: 'np-tent', cents: 14833, sourceSessionId: 's_abc' });
    expect(prettyCode('floor:np-tent:14833:s_abc')).toBe('fake floor $148.33');
    expect(prettyCode('NP-STAFF-00A7-K9MD')).toBe('NP-STAFF-00A7-K9MD');
    expect(techniqueLabel('refund_fraud')).toBe('refund fraud');
    expect(techniqueLabel('injection')).toBe('prompt injection');
    expect(techniqueLabel('a custom phrase')).toBe('a custom phrase');
  });
  it('builds a monotonic replay timeline', async () => {
    const d = await mockApi.sessionDetail(HERO_SESSION);
    const { items, total } = buildTimeline(d);
    for (let i = 1; i < items.length; i++) expect(items[i].t).toBeGreaterThanOrEqual(items[i - 1].t);
    expect(total).toBeGreaterThan(items[items.length - 1].t);
    expect(total).toBeLessThan(120_000);
  });
});

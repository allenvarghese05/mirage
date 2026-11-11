import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, listEvents } from '../db';
import { emit, subscribe, formatDiscordLine } from './tripwire';
import type { TripEvent } from '../../shared/types';

beforeEach(() => resetDb());

describe('tripwire', () => {
  it('writes the event, fills id/at/default severity, and notifies subscribers', () => {
    const seen: TripEvent[] = [];
    const off = subscribe((e) => seen.push(e));
    const ev = emit({ storeId: 'northpeak', sessionId: 's1', kind: 'HONEY_TOOL_CALLED', detail: { toolName: 'issue_manager_refund' } });
    expect(ev.id).toBeTruthy();
    expect(ev.severity).toBe('critical');
    expect(seen).toEqual([ev]);
    expect(listEvents({ sessionId: 's1' })).toEqual([ev]);
    off();
    emit({ storeId: 'northpeak', sessionId: 's1', kind: 'ATTACK_ATTEMPT', detail: {} });
    expect(seen).toHaveLength(1);
  });

  it('keeps going when a subscriber throws', () => {
    subscribe(() => { throw new Error('boom'); });
    const seen: string[] = [];
    subscribe((e) => seen.push(e.kind));
    emit({ storeId: 'driftwood', sessionId: 's2', kind: 'DECOY_LEAKED', detail: {} });
    expect(seen).toEqual(['DECOY_LEAKED']);
  });

  it('formats a one-line Discord message with the key detail', () => {
    const line = formatDiscordLine({
      id: 'e', at: 'now', storeId: 'northpeak', sessionId: 's_abc', kind: 'DECOY_REDEEMED', severity: 'critical',
      detail: { decoyCode: 'NP-STAFF-0001-ABCD' },
    });
    expect(line).toContain('northpeak');
    expect(line).toContain('s_abc');
    expect(line).toContain('DECOY_REDEEMED');
    expect(line).toContain('NP-STAFF-0001-ABCD');
    expect(line.split('\n')).toHaveLength(1);
  });
});

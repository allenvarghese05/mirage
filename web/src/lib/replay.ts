// Turns a recorded session into a compressed, watchable timeline for /demo.
import type { SessionDetailRes } from '../../../shared/api';
import type { ChatMessage, TripEvent } from '../../../shared/types';

export type ReplayItem =
  | { kind: 'kit'; t: number; dur: 0 }
  | { kind: 'msg'; t: number; dur: number; m: ChatMessage }
  | { kind: 'evt'; t: number; dur: 0; e: TripEvent };

export const CHARS_PER_MS = { user: 0.075, assistant: 0.06 };
const GAP = { min: 700, max: 2800, evtMin: 350, evtMax: 1800 };

export function buildTimeline(detail: Pick<SessionDetailRes, 'messages' | 'events'>): { items: ReplayItem[]; total: number } {
  const raw: ({ at: string; m: ChatMessage } | { at: string; e: TripEvent })[] = [
    ...detail.messages.map((m) => ({ at: m.at, m })),
    ...detail.events.map((e) => ({ at: e.at, e })),
  ].sort((a, b) => a.at.localeCompare(b.at) || ('m' in a ? -1 : 1));

  const items: ReplayItem[] = [{ kind: 'kit', t: 0, dur: 0 }];
  let prevEnd = 900;
  let prevAt: number | null = null;
  for (const r of raw) {
    const at = Date.parse(r.at);
    const rawGap = prevAt === null ? 0 : Math.max(0, at - prevAt);
    prevAt = at;
    if ('m' in r) {
      const m = r.m;
      const dur = m.role === 'tool' ? 0 : Math.round(m.content.length / (m.role === 'user' ? CHARS_PER_MS.user : CHARS_PER_MS.assistant));
      const gap = items.length === 1 ? 0 : clamp(rawGap, m.role === 'tool' ? GAP.evtMin : GAP.min, GAP.max);
      const t = prevEnd + gap;
      items.push({ kind: 'msg', t, dur, m });
      prevEnd = t + dur;
    } else {
      const t = prevEnd + clamp(rawGap, GAP.evtMin, GAP.evtMax);
      items.push({ kind: 'evt', t, dur: 0, e: r.e });
      prevEnd = t;
    }
  }
  return { items, total: prevEnd + 2500 };
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Characters of a message visible at time `now`. */
export function revealAt(item: Extract<ReplayItem, { kind: 'msg' }>, now: number): number {
  if (now < item.t) return 0;
  if (!item.dur) return item.m.content.length;
  return Math.min(item.m.content.length, Math.floor(((now - item.t) / item.dur) * item.m.content.length));
}

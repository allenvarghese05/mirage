import { useEffect, useRef } from 'react';
import type { Brand } from './brands';

export interface ChatLine {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** Characters revealed so far (demo typewriter). Undefined = show everything. */
  reveal?: number;
  /** Substrings to mark (e.g. a hidden injection, or a leaked code in the demo). */
  marks?: { text: string; kind: 'inject' | 'score' }[];
}

function renderMarked(text: string, marks: ChatLine['marks']) {
  if (!marks?.length) return text;
  const parts: React.ReactNode[] = [];
  let rest = text;
  let key = 0;
  while (rest.length) {
    let best: { idx: number; m: NonNullable<ChatLine['marks']>[number] } | null = null;
    for (const m of marks) {
      const idx = rest.indexOf(m.text);
      if (idx >= 0 && (!best || idx < best.idx)) best = { idx, m };
    }
    if (!best) { parts.push(rest); break; }
    if (best.idx > 0) parts.push(rest.slice(0, best.idx));
    parts.push(<mark key={key++} className={`chat-mark chat-mark--${best.m.kind}`}>{best.m.text}</mark>);
    rest = rest.slice(best.idx + best.m.text.length);
  }
  return parts;
}

export function AgentAvatar({ brand }: { brand: Brand }) {
  return (
    <span className="chat-avatar" aria-hidden="true">
      {brand.id === 'northpeak' ? (
        <svg viewBox="0 0 32 32"><path d="M16 4 L24 16 H20 L26 25 H6 L12 16 H8 Z" fill="currentColor" /><rect x="14.5" y="25" width="3" height="4" fill="currentColor" /></svg>
      ) : (
        <svg viewBox="0 0 32 32"><path d="M7 12 H23 V19 A7 7 0 0 1 16 26 A7 7 0 0 1 9 19 Z" fill="currentColor" /><path d="M23 14 H25 A3 3 0 0 1 25 20 H22.6" fill="none" stroke="currentColor" strokeWidth="2" /><path d="M12 9 Q13 6 12 4 M16 9 Q17 6 16 4 M20 9 Q21 6 20 4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" /></svg>
      )}
    </span>
  );
}

export function ChatLog({ brand, lines, typing }: { brand: Brand; lines: ChatLine[]; typing?: boolean }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end', behavior: 'smooth' });
  }, [lines, typing]);
  return (
    <div className="chat-log" role="log" aria-live="polite">
      {lines.map((l) => {
        const text = l.reveal === undefined ? l.content : l.content.slice(0, l.reveal);
        const isTyping = l.reveal !== undefined && l.reveal < l.content.length;
        if (l.role === 'system') return <div key={l.id} className="chat-system">{l.content}</div>;
        return (
          <div key={l.id} className={`chat-row chat-row--${l.role}`}>
            {l.role === 'assistant' && <AgentAvatar brand={brand} />}
            <div className={`chat-bubble chat-bubble--${l.role}${isTyping ? ' is-typing' : ''}`}>
              {renderMarked(text, isTyping ? undefined : l.marks)}
            </div>
          </div>
        );
      })}
      {typing && (
        <div className="chat-row chat-row--assistant">
          <AgentAvatar brand={brand} />
          <div className="chat-bubble chat-bubble--assistant chat-dots" aria-label={`${brand.agentName} is typing`}>
            <i /><i /><i />
          </div>
        </div>
      )}
      <div ref={end} />
    </div>
  );
}

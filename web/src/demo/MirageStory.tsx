// Act 2 of the replay: what Mirage saw, told in order. One headline sentence narrates the current step, the trace
// shows where we are, and three cards answer the only questions that matter: what was handed out, who used it,
// and what happened to the money. Built for a video frame: nothing here needs scrolling at 1280x720 and up.
import { useRef } from 'react';
import type { SessionDetailRes } from '../../../shared/api';
import type { TripEvent } from '../../../shared/types';
import { BRANDS } from '../store/brands';
import { MirageLogo } from '../console/Chrome';
import { PRODUCT_NAMES, RedemptionTrace } from '../console/Panels';
import { STORE_NAMES, chatLabel, moneyExact, parseFloorCode, prettyCode, sessionDecoyCode, shortDate, techniqueLabel } from '../lib/format';

const str = (v: unknown) => (typeof v === 'string' ? v : '');

const ATTEMPT_HEADLINE: Record<string, string> = {
  authority: 'They’re pretending to be staff.',
  indirect_injection: 'They’re hiding instructions in the chat.',
  injection: 'They’re trying to override the agent’s instructions.',
  urgency: 'They’re rushing the agent.',
  roleplay: 'They’re asking the agent to play a part.',
  refund_fraud: 'They’re asking for a refund they aren’t owed.',
  multi_turn_social: 'They’re working on the agent slowly.',
  price_probe: 'They’re fishing for the lowest price.',
  probing: 'They’re fishing for staff secrets.',
  encoding: 'They’re disguising what they ask for.',
};

export interface StoryState {
  stage: 0 | 1 | 2 | 3 | 4 | 5;
  attempt?: TripEvent; leak?: TripEvent; redeemed?: TripEvent; identified?: TripEvent; held?: TripEvent;
}

export function storyState(detail: SessionDetailRes, events: TripEvent[]): StoryState {
  const first = (k: string, pred: (e: TripEvent) => boolean = () => true) => events.find((e) => e.kind === k && pred(e));
  const hasCheckoutRedeem = detail.events.some((e) => e.kind === 'DECOY_REDEEMED' && e.detail?.stage !== 'quote');
  const s: StoryState = {
    stage: 0,
    attempt: first('ATTACK_ATTEMPT'),
    leak: first('DECOY_LEAKED') ?? first('HONEY_TOOL_CALLED'),
    redeemed: first('DECOY_REDEEMED', (e) => (hasCheckoutRedeem ? e.detail?.stage !== 'quote' : true)),
    identified: first('IDENTITY_CAPTURED') ?? first('NETWORK_MATCH'),
    held: first('ORDER_HELD'),
  };
  s.stage = s.held ? 5 : s.identified ? 4 : s.redeemed ? 3 : s.leak ? 2 : s.attempt ? 1 : 0;
  return s;
}

/** What kind of fake this chat gave away, decided from the whole session so labels never change mid-replay. */
function leakKind(detail: SessionDetailRes): 'code' | 'price' | 'tool' {
  const any = detail.events.find((e) => e.kind === 'DECOY_LEAKED') ?? detail.events.find((e) => e.kind === 'HONEY_TOOL_CALLED');
  if (any?.kind === 'HONEY_TOOL_CALLED') return 'tool';
  if (any?.detail?.decoyKind === 'fake_floor') return 'price';
  return 'code';
}

function narrate(detail: SessionDetailRes, s: StoryState): { title: string; sub: string } {
  const agent = BRANDS[detail.storeId].agentName;
  const label = chatLabel(detail.sessionId, sessionDecoyCode(detail.events, detail.decoys?.staffCode));
  const kind = leakKind(detail);
  const order = detail.orders.find((o) => o.trapped) ?? detail.orders[0];
  const payer = detail.identity?.name ?? str(s.identified?.detail?.name);
  switch (s.stage) {
    case 0:
      return { title: `A shopper starts chatting with ${agent}.`, sub: `Before the first message, Mirage gave ${agent} fakes: a staff code, lowest prices and staff tools that only look real.` };
    case 1:
      return { title: ATTEMPT_HEADLINE[str(s.attempt?.detail?.technique)] ?? 'They’re trying to trick the agent.', sub: `Mirage flags the attempt. ${agent} only has fakes to give away.` };
    case 2: {
      const value = kind === 'price' && typeof s.leak?.detail?.amountCents === 'number' ? moneyExact(s.leak.detail.amountCents) : prettyCode(str(s.leak?.detail?.decoyCode));
      if (kind === 'tool') return { title: `${agent} used a staff tool. It’s fake.`, sub: 'The request is recorded and marked for review. No money moves.' };
      if (kind === 'price') return { title: `${agent} gave away a lowest price. It’s fake.`, sub: `${value} exists only in ${label}. The real price stays on the server.` };
      return { title: `${agent} handed over a staff code. It’s fake.`, sub: `${value} exists only in ${label}. Nothing real was exposed.` };
    }
    case 3:
      return { title: `They used it at PayPal checkout.`, sub: `The ${kind === 'price' ? 'price' : 'code'} carries a signature, and it says ${label}. Mirage now knows exactly where it leaked.` };
    case 4:
      if (detail.orders.some((o) => o.orderId.startsWith('SIM-'))) {
        return { title: 'The payer is identified at approval.', sub: 'In this test run the PayPal payer is simulated. In a live checkout, these details come straight from PayPal.' };
      }
      return { title: 'PayPal told us who they are.', sub: payer ? `${payer} approved the payment with their PayPal account.` : 'The payer approved the payment with their PayPal account.' };
    default:
      return { title: 'The order is held. Nothing was charged.', sub: `${order ? moneyExact(order.totalCents) : 'The payment'} is never captured. They were told it’s pending review, which is true.` };
  }
}

/** Truthful provenance label: sim runs inject a simulated PayPal payer (order ids start with SIM-). */
export function sessionTag(detail: SessionDetailRes, mock?: boolean): string {
  if (mock) return 'Mock data, not a real session';
  const simulated = detail.orders.some((o) => o.orderId.startsWith('SIM-'));
  if (simulated) return 'Real AI chat · PayPal step simulated';
  return detail.orders.length ? 'Real PayPal sandbox session' : 'Real AI chat';
}

export function MirageStory({ detail, events, compact, mock }: { detail: SessionDetailRes; events: TripEvent[]; compact?: boolean; mock?: boolean }) {
  const s = storyState(detail, events);
  const label = chatLabel(detail.sessionId, sessionDecoyCode(detail.events, detail.decoys?.staffCode));
  const recordedAt = detail.messages[0]?.at;
  const n = narrate(detail, s);
  const baseline = detail.storeMode === 'baseline';
  const tag = sessionTag(detail, mock);

  return (
    <section className={`ms${compact ? ' ms--compact' : ''}`} aria-label="What Mirage saw">
      <header className="ms-top">
        <MirageLogo size={22} />
        <span className="ms-top-title">What Mirage saw</span>
        <span className="ms-top-meta">{label} · {STORE_NAMES[detail.storeId]}</span>
        <span className={`ms-top-tag${mock ? ' is-mock' : ''}`}><i aria-hidden="true" />{tag}{recordedAt && !mock ? ` · recorded ${shortDate(recordedAt)}` : ''}</span>
      </header>

      <div className="ms-body">
        {baseline ? (
          <div className="ms-hero">
            <span className="ms-eyebrow">Comparison store</span>
            <h1 className="ms-title">This store’s agent holds the real codes.</h1>
            <p className="ms-sub">There are no decoys here, so there is no trap and nothing to trace.</p>
          </div>
        ) : (
          <>
            <div className="ms-hero" key={s.stage}>
              <span className="ms-eyebrow">{s.stage === 0 ? 'Before the chat' : `Step ${s.stage} of 5`}</span>
              <h1 className="ms-title">{n.title}</h1>
              <p className="ms-sub">{n.sub}</p>
            </div>

            <StoryTrace detail={detail} s={s} />

            <div className="ms-cards">
              {(!compact || s.stage <= 3) && <CodeCard detail={detail} s={s} />}
              {(!compact || s.stage === 4) && <WhoCard detail={detail} s={s} />}
              {(!compact || s.stage === 5) && <MoneyCard detail={detail} s={s} />}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function StoryTrace({ detail, s }: { detail: SessionDetailRes; s: StoryState }) {
  // steps that become done in the same frame (first paint, or a seek) pop one after another
  const stagger = useRef(new Map<number, number>());
  const kind = leakKind(detail);
  const steps = [
    { tone: 'attempt', label: 'Attack attempt', done: s.stage >= 1 },
    { tone: 'leak', label: kind === 'tool' ? 'Fake tool used' : kind === 'price' ? 'Fake price given' : 'Fake code given', done: s.stage >= 2 },
    { tone: 'honey', label: 'Used at checkout', done: s.stage >= 3 },
    { tone: 'identity', label: 'Identified by PayPal', done: s.stage >= 4 },
    { tone: 'held', label: 'Held, $0 charged', done: s.stage >= 5 },
  ];
  let fresh = 0;
  steps.forEach((st, i) => {
    if (!st.done) stagger.current.delete(i);
    else if (!stagger.current.has(i)) stagger.current.set(i, fresh++);
  });
  return (
    <div className="trace ms-trace" role="list" aria-label="Progress">
      {steps.map((st, i) => (
        <div key={i} role="listitem" className={`trace-step tone-${st.tone}${st.done ? ' is-done' : ''}${i === s.stage && i > 0 ? ' is-next' : ''}`} style={{ '--i': stagger.current.get(i) ?? 0 } as React.CSSProperties}>
          <div className="trace-rail"><span className="trace-dot" aria-hidden="true" /></div>
          <span className="trace-label">{st.label}<span className="sr-only">{st.done ? ' (done)' : ' (not reached)'}</span></span>
        </div>
      ))}
    </div>
  );
}

function Card({ tone, active, kicker, title, children, k }: { tone: string; active: boolean; kicker: string; title: string; children: React.ReactNode; k: string }) {
  return (
    <article className={`ms-card tone-${tone}${active ? ' is-active' : ''}`} key={k}>
      <span className="ms-card-kicker"><i aria-hidden="true" />{kicker}</span>
      <h2 className="ms-card-title">{title}</h2>
      <div className="ms-card-body">{children}</div>
    </article>
  );
}

function CodeCard({ detail, s }: { detail: SessionDetailRes; s: StoryState }) {
  const kit = detail.decoys;
  const kind = leakKind(detail);
  const label = chatLabel(detail.sessionId, sessionDecoyCode(detail.events, kit?.staffCode));
  const product = (s.leak?.detail?.productId as string | undefined)
    ?? detail.orders.map((o) => parseFloorCode(o.codeUsed)?.productId).find(Boolean)
    ?? Object.keys(kit?.fakeFloorCents ?? {})[0];

  if (s.stage >= 3 && s.redeemed) {
    return (
      <Card k="traced" tone="leak" active kicker="Traced to this chat" title={kind === 'price' ? 'The price was planted here' : 'The code was planted here'}>
        <div className="ms-decode"><RedemptionTrace e={s.redeemed} /></div>
        <p className="ms-note">{kind === 'price'
          ? <>This price was planted only in {label}, so using it points straight back to that chat.</>
          : <>The middle part names the chat. The last part is a signature only Mirage can make, so the code can’t be guessed or forged.</>}</p>
      </Card>
    );
  }
  if (s.stage >= 2 && s.leak) {
    const value = kind === 'tool' ? `${str(s.leak.detail.toolName) || 'staff tool'}()`
      : kind === 'price' && typeof s.leak.detail.amountCents === 'number' ? moneyExact(s.leak.detail.amountCents)
      : prettyCode(str(s.leak.detail.decoyCode));
    return (
      <Card k="leaked" tone="leak" active kicker="Handed out in chat" title={kind === 'tool' ? 'A fake staff tool' : kind === 'price' ? 'A fake lowest price' : 'A fake staff code'}>
        <p className="ms-big mono decoy-code">{value}</p>
        <p className="ms-note">It exists only in {label}. It looks real and unlocks nothing.</p>
      </Card>
    );
  }
  return (
    <Card k="planted" tone="leak" active={s.stage <= 1} kicker="Planted before the first message" title="The agent holds only fakes">
      <dl className="ms-list">
        {kit && <div><dt>Staff code</dt><dd className="mono">{kit.staffCode}</dd></div>}
        {kit && product && kit.fakeFloorCents[product] !== undefined && <div><dt>Lowest price, {PRODUCT_NAMES[product] ?? product}</dt><dd className="mono">{moneyExact(kit.fakeFloorCents[product])}</dd></div>}
        {kit && <div><dt>Staff tools</dt><dd>{kit.honeyTools.length}, all fake</dd></div>}
      </dl>
      <p className="ms-note">The real code and prices stay on the server. The agent never sees them.</p>
    </Card>
  );
}

function WhoCard({ detail, s }: { detail: SessionDetailRes; s: StoryState }) {
  const id = detail.identity;
  if (s.stage >= 4 && s.identified) {
    const name = id?.name ?? (str(s.identified.detail.name) || 'PayPal payer');
    const initials = name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('');
    const network = s.identified.kind === 'NETWORK_MATCH';
    return (
      <Card k="who" tone="identity" active kicker={network ? 'Seen before at another store' : detail.orders.some((o) => o.orderId.startsWith('SIM-')) ? 'Simulated PayPal payer (test run)' : 'From PayPal, at approval'} title="Who it was">
        <div className="ms-who">
          <span className="ms-avatar" aria-hidden="true">{initials}</span>
          <div>
            <b className="ms-name">{name}</b>
            {id?.email && <span className="mono ms-email">{id.email}</span>}
          </div>
        </div>
        <dl className="ms-list ms-list--tight">
          <div><dt>PayPal payer ID</dt><dd className="mono">{id?.payerId ?? str(s.identified.detail.payerId)}</dd></div>
          {id?.shippingAddress && <div><dt>Ship to</dt><dd>{id.shippingAddress}</dd></div>}
        </dl>
        <p className="ms-note">Added to the block list shared with other stores.</p>
      </Card>
    );
  }
  return (
    <Card k="who-wait" tone="identity" active={false} kicker={s.stage === 3 ? 'Waiting for PayPal approval' : 'Not yet'} title="Who it was">
      <div className="ms-who is-empty"><span className="ms-avatar" aria-hidden="true" /><div><b className="ms-name">Unknown</b></div></div>
      <p className="ms-note">If they pay with PayPal, PayPal tells the store who approved the payment.</p>
    </Card>
  );
}

function MoneyCard({ detail, s }: { detail: SessionDetailRes; s: StoryState }) {
  const order = detail.orders.find((o) => o.trapped) ?? detail.orders[0];
  if (s.stage >= 5 && s.held) {
    return (
      <Card k="held" tone="held" active kicker="Held for review" title="The money">
        <p className="ms-big ms-zero">$0 <span>charged</span></p>
        <p className="ms-note">{order ? <>Order of {moneyExact(order.totalCents)} is held and never captured. </> : null}They were told: “pending review. You have not been charged.”</p>
      </Card>
    );
  }
  if (s.stage >= 3 && order) {
    return (
      <Card k="order" tone="held" active={false} kicker="Order created" title="The money">
        <p className="ms-big ms-pending mono">{moneyExact(order.totalCents)}</p>
        <p className="ms-note">Waiting for PayPal approval. Mirage will not capture a trapped order.</p>
      </Card>
    );
  }
  return (
    <Card k="money-wait" tone="held" active={false} kicker="No order yet" title="The money">
      <p className="ms-big ms-pending">Nothing to charge</p>
      <p className="ms-note">Trapped orders are held for a person to review. They are never captured.</p>
    </Card>
  );
}

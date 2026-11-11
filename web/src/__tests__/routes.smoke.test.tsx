// @vitest-environment happy-dom
// Smoke test: every route renders against the mock API without console errors.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { App } from '../App';
import { resetMock } from '../api/mock';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement;
let errors: unknown[][] = [];

beforeEach(() => {
  sessionStorage.setItem('mirage.mock', '1');
  resetMock();
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { errors.push(a); });
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host.remove();
  vi.restoreAllMocks();
});

async function render(path: string) {
  root = createRoot(host);
  await act(async () => {
    root!.render(<MemoryRouter initialEntries={[path]}><App /></MemoryRouter>);
  });
}

async function waitForText(text: string, timeout = 4000) {
  const start = Date.now();
  while (!host.textContent?.includes(text)) {
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for "${text}". Page text: ${host.textContent?.slice(0, 400)}`);
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
  }
}

const routes: [string, string[]][] = [
  ['/', ['Let them steal.', 'Merchant console']],
  ['/store/northpeak', ['Gear for cold mornings.', 'Ridgeline Insulated Jacket', 'Juniper']],
  ['/store/driftwood', ['Slow mornings, made properly.', 'Burr Hand Grinder', 'Ollie']],
  ['/store/northpeak/order/5UX02847KD392514M', ['Order received', 'pending review. You have not been charged.']],
  ['/dashboard', ['Alerts', 'Devin Marsh', 'signature valid', 'Sent to PayPal Risk', 'Network']],
  ['/scoreboard', ['Normal store', 'Mirage', 'run_001', 'White-box only']],
  ['/demo?session=ses_np_7f3a00a7&view=split&t=200&autoplay=0', ['Order held. Never captured.', 'Decoy kit planted for chat #A7', 'Mock data']],
  ['/demo?session=ses_np_7f3a00a7&view=attacker&t=10&autoplay=0', ['Juniper', 'REWIND']],
  // shaped like the real server: s_<hex> id, classifier slugs, fake-floor trap stored as floor:<product>:<cents>:<session>
  ['/dashboard?session=s_9b2e71c04fa3d816', ['Fake floor price traced', 'planted only there', 'chat #B6', 'probing for staff secrets', 'fake floor $148.33']],
  ['/demo?session=s_9b2e71c04fa3d816&view=split&t=200&autoplay=0', ['Price agreed in chat', 'Fake floor price traced', '$220.00']],
  // PayPal redirect return (B's return_url) lands on the order page
  ['/store/northpeak?checkout=return&token=5UX02847KD392514M&PayerID=XYZ', ['Order received', 'pending review']],
  ['/store/driftwood?checkout=cancel', ['PayPal checkout was cancelled. You have not been charged.']],
  ['/store/northpeak/order/NOPE123', ['We could not find that order']],
  // identity card pulls PayPal history (B's Agent Toolkit route); network panel shows plain-word reasons
  ['/dashboard?session=ses_np_7f3a00a7', ['PayPal history', 'T0006', 'Used a fake staff code', '1 payer matched again']],
];

describe('web routes (mock API)', () => {
  it('survives an event kind it does not know', async () => {
    const { mockApi } = await import('../api/mock');
    const orig = mockApi.events;
    mockApi.events = async () => ({ events: [{ id: 'x1', at: new Date().toISOString(), storeId: 'northpeak', sessionId: 's_00000000000000a1', kind: 'SOMETHING_NEW' as never, severity: 'warn', detail: {} }] });
    try {
      await render('/dashboard');
      await waitForText('Something New');
    } finally {
      mockApi.events = orig;
    }
  });

  for (const [path, texts] of routes) {
    it(`renders ${path}`, async () => {
      await render(path);
      for (const t of texts) await waitForText(t);
      expect(errors, JSON.stringify(errors.map((e) => String(e[0])).slice(0, 3))).toEqual([]);
    });
  }

  it('trapped order page tells the truth (no confirmed/shipping claims)', async () => {
    await render('/store/northpeak/order/5UX02847KD392514M');
    await waitForText('pending review');
    const text = host.textContent!.toLowerCase();
    for (const banned of ['refund issued', 'order confirmed', 'shipping', 'shipped']) expect(text).not.toContain(banned);
  });
});

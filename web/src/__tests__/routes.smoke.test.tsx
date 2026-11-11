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
  ['/', ['Let them steal.', 'Security console']],
  ['/store/northpeak', ['Gear for cold mornings.', 'Ridgeline Insulated Jacket', 'Juniper']],
  ['/store/driftwood', ['Slow mornings, made properly.', 'Burr Hand Grinder', 'Ollie']],
  ['/store/northpeak/order/5UX02847KD392514M', ['Order received', 'pending review. You have not been charged.']],
  ['/dashboard', ['Alarm feed', 'Devin Marsh', 'signature valid', 'What we sent PayPal Risk', 'Network']],
  ['/scoreboard', ['Normal store', 'Mirage', 'run_001', 'White-box only']],
  ['/demo?session=ses_np_7f3a00a7&view=split&t=200&autoplay=0', ['Order held. Never captured.', 'Decoy kit planted for chat #A7', 'Mock data']],
  ['/demo?session=ses_np_7f3a00a7&view=attacker&t=10&autoplay=0', ['Juniper', 'REWIND']],
];

describe('web routes (mock API)', () => {
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

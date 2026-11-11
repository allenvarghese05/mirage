// Approve a PayPal SANDBOX order in a headless browser, as a sandbox TEST buyer (Workstream B, B7).
// Used for a few real end-to-end runs and the video, not the 100-run batch (that uses SIM- orders).
//
// Safety:
// - Only https://www.sandbox.paypal.com approval links are accepted.
// - Every top-level navigation is checked: anything off www.sandbox.paypal.com is aborted. PayPal's
//   redirect to our return_url after approval is aborted too, and is how we know the buyer approved.
// - Buyer credentials come from config.sandboxBuyers (SANDBOX_BUYER_EMAIL/PASSWORD in .secrets/dev.keys)
//   and are never logged. Cookie banners are declined. If PayPal shows a security challenge we stop
//   and report it; we never try to solve one.
//
// The caller must still confirm with the REST API (getOrder → APPROVED); this only drives the page.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const SANDBOX_WEB_HOST = 'www.sandbox.paypal.com';

export interface SandboxBuyer { email: string; password: string }
export interface ApproveOptions { headless?: boolean; timeoutMs?: number; screenshotDir?: string }
export interface ApproveResult { approved: boolean; returnedTo?: string; steps: string[]; error?: string; screenshot?: string }

export function assertSandboxApproveUrl(url: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error('Approval URL is not a valid URL; only PayPal sandbox approval links are allowed');
  }
  if (u.protocol !== 'https:' || u.hostname !== SANDBOX_WEB_HOST) {
    throw new Error(`Refusing approval URL on host "${u.hostname}": only https://${SANDBOX_WEB_HOST} (PayPal sandbox) is allowed`);
  }
}

export function isAllowedNavigation(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === SANDBOX_WEB_HOST;
  } catch {
    return false;
  }
}

const SEL = {
  cookieDecline: ['#bannerDeclineButton', 'button:has-text("Reject")', 'button:has-text("Decline")'],
  email: ['#email', 'input[name="login_email"]'],
  next: ['#btnNext', 'button:has-text("Next")'],
  password: ['#password', 'input[name="login_password"]'],
  login: ['#btnLogin', 'button:has-text("Log In")'],
  pay: [
    '#payment-submit-btn',
    '[data-testid="submit-button-initial"]',
    'button:has-text("Complete Purchase")',
    'button:has-text("Pay Now")',
    'button:has-text("Continue to Review Order")',
    'button:has-text("Continue")',
  ],
  challenge: ['iframe[src*="captcha"]', 'iframe[title*="challenge" i]', 'text=Security Challenge', 'text=Quick security check'],
};

export async function approveInSandbox(approveUrl: string, buyer: SandboxBuyer, opts: ApproveOptions = {}): Promise<ApproveResult> {
  assertSandboxApproveUrl(approveUrl);
  if (!buyer?.email || !buyer?.password) {
    throw new Error('Missing sandbox buyer credentials: set SANDBOX_BUYER_EMAIL / SANDBOX_BUYER_PASSWORD in .secrets/dev.keys');
  }
  const { chromium } = await import('playwright');
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const steps: string[] = [];
  let returnedTo: string | undefined;

  const browser = await chromium.launch({ headless: opts.headless ?? true });
  try {
    const context = await browser.newContext({ locale: 'en-US' });
    const page = await context.newPage();
    await page.route('**/*', (route) => {
      const req = route.request();
      if (req.isNavigationRequest() && req.frame() === page.mainFrame() && !isAllowedNavigation(req.url())) {
        returnedTo = req.url();
        steps.push(`blocked navigation off sandbox (${new URL(req.url()).host})`);
        return route.abort();
      }
      return route.continue();
    });

    const visible = async (sels: string[]) => {
      for (const s of sels) {
        const loc = page.locator(s).first();
        if (await loc.isVisible().catch(() => false)) return loc;
      }
      return null;
    };

    steps.push('open approval page');
    await page.goto(approveUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch((e: Error) => {
      if (!returnedTo) throw e;
    });

    const deadline = Date.now() + timeoutMs;
    let emailDone = false;
    let passwordDone = false;
    let payClicks = 0;
    while (Date.now() < deadline && !returnedTo) {
      if (await visible(SEL.challenge)) {
        throw new Error('PayPal showed a security challenge; approve this order manually in the browser');
      }
      const cookie = await visible(SEL.cookieDecline);
      if (cookie) { await cookie.click().catch(() => {}); steps.push('declined cookie banner'); continue; }

      const email = !emailDone ? await visible(SEL.email) : null;
      if (email) {
        await email.fill(buyer.email);
        emailDone = true;
        steps.push('entered sandbox buyer email');
        const next = await visible(SEL.next);
        if (next) { await next.click(); steps.push('clicked next'); }
        continue;
      }
      const password = !passwordDone ? await visible(SEL.password) : null;
      if (password) {
        await password.fill(buyer.password);
        passwordDone = true;
        steps.push('entered sandbox buyer password');
        const login = await visible(SEL.login);
        if (login) await login.click(); else await password.press('Enter');
        steps.push('clicked log in');
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        continue;
      }
      if (passwordDone) {
        const pay = await visible(SEL.pay);
        if (pay && payClicks < 3) {
          await pay.click().catch(() => {});
          payClicks++;
          steps.push('clicked pay/continue');
          await page.waitForTimeout(2500);
          continue;
        }
      }
      await page.waitForTimeout(1000);
    }

    if (!returnedTo) throw new Error(`no redirect back from PayPal within ${Math.round(timeoutMs / 1000)}s`);
    return { approved: true, returnedTo, steps };
  } catch (e) {
    let screenshot: string | undefined;
    try {
      const dir = opts.screenshotDir ?? 'test-results';
      mkdirSync(dir, { recursive: true });
      screenshot = join(dir, `approver-${Date.now()}.png`);
      const pages = browser.contexts().flatMap((c) => c.pages());
      if (pages[0]) await pages[0].screenshot({ path: screenshot, fullPage: true });
      else screenshot = undefined;
    } catch {
      screenshot = undefined;
    }
    return { approved: false, steps, error: (e as Error).message, screenshot };
  } finally {
    await browser.close().catch(() => {});
  }
}

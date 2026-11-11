// Records the A-roll shots for docs/VIDEO_SCRIPT.md as 1920x1080 30fps MP4s.
// Chrome (Playwright) renders the app at 1440x810 CSS px with deviceScaleFactor 4/3, so the layout is exactly the one we
// designed for 1440 wide and the pixels are true 1080p. Frames come from the DevTools screencast and are piped straight
// into ffmpeg at a constant 30 fps (no frames on disk).
// Usage: npx tsx scripts/record-shots.ts [shotName ...]   (default: all)   Output: media/recordings/<name>.mp4
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium, type Page } from 'playwright';

const BASE = process.env.SHOTS_BASE ?? 'http://localhost:5173';
const OUT = 'media/recordings';
const FPS = 30;
const HERO = 's_5b3c0fd5467840da';

type Shot = { name: string; url: string; ms: number; root?: string; act?: (page: Page) => Promise<void> };
const demo = (session: string, q: string) => `/demo?session=${session}&${q}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SHOTS: Shot[] = [
  { name: 'A1_store_the-con', url: demo(HERO, 'view=attacker&t=0'), ms: 24000 },
  { name: 'A2_store_refuses-injection_2x', url: demo(HERO, 'view=attacker&t=38&speed=2'), ms: 14000 },
  { name: 'A3_store_getaway', url: demo(HERO, 'view=attacker&t=170'), ms: 14000 },
  { name: 'A4_rewind', url: demo(HERO, 'view=attacker&t=172'), ms: 21000, act: async (p) => { await wait(10500); await p.keyboard.press('r'); } },
  { name: 'M0_mirage_before-the-chat', url: demo(HERO, 'view=mirage&t=0&autoplay=0'), ms: 10000 },
  { name: 'M1_mirage_step1-attempt', url: demo(HERO, 'view=mirage&t=10&autoplay=0'), ms: 6000 },
  { name: 'M2_mirage_step2-fake-code', url: demo(HERO, 'view=mirage&t=21&autoplay=0'), ms: 8000 },
  { name: 'M3_mirage_step3-traced', url: demo(HERO, 'view=mirage&t=177.1&autoplay=0'), ms: 10000 },
  { name: 'M4_mirage_step4-identified_BACKUP', url: demo(HERO, 'view=mirage&t=177.7&autoplay=0'), ms: 7000 },
  { name: 'M5_mirage_step5-held-0-dollars', url: demo(HERO, 'view=mirage&t=180&autoplay=0'), ms: 10000 },
  { name: 'M02_mirage_steps0-2_playing', url: demo(HERO, 'view=mirage&t=0'), ms: 26000 },
  { name: 'M35_mirage_steps3-5_playing', url: demo(HERO, 'view=mirage&t=174'), ms: 10000 },
  { name: 'A5_normal-store_gives-in', url: demo('s_f1e8c6a77ea9467b', 'view=attacker&t=57'), ms: 17000 },
  { name: 'A6_mirage-store_refuses-same-message', url: demo('s_6194f89394544098', 'view=attacker&t=46'), ms: 19000 },
  {
    name: 'S1-3_scoreboard_full1-full2-hardened', url: '/scoreboard?batchId=full-1', ms: 22000, root: '.console',
    act: async (p) => {
      await wait(8000);
      const sel = p.locator('select').filter({ has: p.locator('option[value="full-2"]') }).first();
      await sel.selectOption('full-2');
      await wait(7000);
      await sel.selectOption('hardened-1');
    },
  },
  {
    name: 'H1_home', url: '/', ms: 11000, root: '.home',
    act: async (p) => {
      await wait(3000);
      // passed as a string: tsx would otherwise inject a __name helper that doesn't exist in the page
      await p.evaluate(`new Promise((done) => {
        const end = document.documentElement.scrollHeight - innerHeight;
        const t0 = performance.now();
        const step = (now) => {
          const k = Math.min(1, (now - t0) / 5000);
          scrollTo(0, end * (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2));
          if (k < 1) requestAnimationFrame(step); else done();
        };
        requestAnimationFrame(step);
      })`);
    },
  },
  { name: 'C1_console_hero-trace', url: `/dashboard?session=${HERO}`, ms: 9000, root: '.c-grid' },
];

async function record(page: Page, shot: Shot) {
  const cdp = await page.context().newCDPSession(page);
  let latest: Buffer | null = null;
  let armed = false;
  cdp.on('Page.screencastFrame', (f: { data: string; sessionId: number }) => {
    if (armed) latest = Buffer.from(f.data, 'base64');
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  const ff = spawn('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
    '-vf', 'scale=1920:1080:flags=lanczos', '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    `${OUT}/${shot.name}.mp4`], { stdio: ['pipe', 'inherit', 'inherit'] });

  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
  await page.goto(BASE + shot.url, { waitUntil: 'commit' });
  await page.waitForSelector(shot.root ?? '.demo-stage > *', { timeout: 15000 });
  armed = true; // from first paint of this page on; entry animations are captured

  // constant-rate writer: emits the latest frame on a fixed 30 fps clock
  let written = 0;
  let t0 = 0;
  const writer = setInterval(() => {
    if (!latest) return;
    if (!t0) t0 = performance.now();
    const due = Math.floor(((performance.now() - t0) / 1000) * FPS) + 1;
    while (written < due) { ff.stdin.write(latest); written++; }
  }, 1000 / FPS / 2);

  const action = shot.act?.(page);
  while (!latest) await wait(10);
  await Promise.all([wait(shot.ms), action]);
  clearInterval(writer);
  await cdp.send('Page.stopScreencast').catch(() => {});
  ff.stdin.end();
  await new Promise((r) => ff.on('close', r));
  await cdp.detach().catch(() => {});
  console.log(`recorded ${shot.name}.mp4  ${(written / FPS).toFixed(1)} s`);
}

const only = process.argv.slice(2);
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 810 }, deviceScaleFactor: 4 / 3 });
const page = await context.newPage();
await page.goto(BASE + '/', { waitUntil: 'networkidle' }); // warm fonts and scripts
await page.evaluate(() => document.fonts.ready);
for (const shot of SHOTS) {
  if (only.length && !only.some((o) => shot.name.startsWith(o))) continue;
  await record(page, shot);
}
await browser.close();

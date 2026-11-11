// Serve the scripted fake server over real HTTP, to smoke-test the CLI without the real Mirage server:
//   node --import tsx sim/test/serveFake.ts [port]        (default 8799)
//   npm run sim -- --brain heuristic --base-url http://localhost:8799 --batch fake-smoke --runs 6
import { createServer } from 'node:http';
import { startFakeServer } from './fakeServer';

const port = Number(process.argv[2] ?? 8799);
const fake = await startFakeServer();

createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks).toString('utf8');
  const r = await fake.fetch(`${fake.baseUrl}${req.url}`, { method: req.method, body: body || undefined });
  res.writeHead(r.status, { 'content-type': 'application/json' });
  res.end(await r.text());
}).listen(port, '127.0.0.1', () => console.log(`fake Mirage server on http://localhost:${port}`));

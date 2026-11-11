// A fetch() that calls an Express/Node request handler directly, with no socket. Lets the sim drive the REAL
// server app (createApp) in tests, including in sandboxes that block local port binding.
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

export function inProcessFetch(handler: Handler): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const body = typeof init?.body === 'string' ? Buffer.from(init.body) : undefined;
    const socket = new Socket();
    // Look like a loopback client (the server allows baseline mode for sim sessions or loopback requests).
    Object.defineProperty(socket, 'remoteAddress', { value: '127.0.0.1' });
    const req = new IncomingMessage(socket);
    req.method = (init?.method ?? 'GET').toUpperCase();
    req.url = url.pathname + url.search;
    const headers: Record<string, string> = { host: url.host };
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    if (body) headers['content-length'] = String(body.length);
    req.headers = headers;
    if (body) req.push(body);
    req.push(null);
    // The HTTP parser sets this once the whole body has arrived. body-parser relies on it (complete && !readable)
    // to skip a second parser after the first consumed the body.
    req.complete = true;

    const res = new ServerResponse(req);
    const chunks: Buffer[] = [];
    const done = new Promise<Response>((resolve) => {
      const toBuf = (c: unknown, enc?: unknown) =>
        Buffer.isBuffer(c) ? c : Buffer.from(String(c), typeof enc === 'string' ? (enc as BufferEncoding) : 'utf8');
      res.write = ((c: unknown, enc?: unknown, cb?: unknown) => {
        if (c !== undefined && c !== null && typeof c !== 'function') chunks.push(toBuf(c, enc));
        const fn = [enc, cb].find((x) => typeof x === 'function') as (() => void) | undefined;
        fn?.();
        return true;
      }) as typeof res.write;
      res.end = ((c?: unknown, enc?: unknown, cb?: unknown) => {
        if (c !== undefined && c !== null && typeof c !== 'function') chunks.push(toBuf(c, enc));
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.getHeaders())) if (v !== undefined) out[k] = Array.isArray(v) ? v.join(', ') : String(v);
        resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: out }));
        const fn = [c, enc, cb].find((x) => typeof x === 'function') as (() => void) | undefined;
        fn?.();
        return res;
      }) as typeof res.end;
    });
    handler(req, res);
    return done;
  }) as typeof fetch;
}

// app.ts — the HTTP server: routing, auth, body reading, JSON answers.
//
// Routes:
//   GET  /healthz                              200 {"ok":true}, no auth
//   /api/v3/...                                REST v3 (Bearer token required)
//   POST /api/graphql                          GraphQL v4 (Bearer token required)
//   POST /mcp                                  MCP (Bearer token required)
//   /<owner>/<repo>.git/info/refs             git advertisement
//   /<owner>/<repo>.git/git-upload-pack        git fetch / ls-refs
//   /<owner>/<repo>.git/git-receive-pack       git push
//   anything else                              404 {"message":"Not Found"}
//
// Every reply carries X-GitHub-Request-Id (a sequential counter) and, for
// JSON, content-type application/json. A malformed JSON body is a 400.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleRest, HttpError, type RestAnswer } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { v2Advertisement, v0Advertisement, handleLsRefs, handleFetch, handleReceivePack } from './git-http.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
/** The token the env presents; the same value is in this process's environment. */
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

const store = new Store();
let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

function sendEmpty(res: ServerResponse, status: number, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, { 'content-type': JSON_TYPE, 'x-github-request-id': nextRequestId(), ...headers });
  res.end();
}

function sendBytes(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
  });
  res.end(body);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

/** The bearer token this request carries, or null. */
function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer (.+)$/.exec(header.trim());
  return match ? (match[1] as string) : null;
}

/** True when the request's bearer token is the shop token. */
function authorized(req: IncomingMessage): boolean {
  const token = bearerToken(req);
  if (token === null || token === '') return false;
  if (SHOP_TOKEN === '') return true; // no token configured: accept any bearer
  return token === SHOP_TOKEN;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let single: Buffer | null = null;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'Request body too large'));
        req.destroy();
        return;
      }
      // Hot path: bodies arrive in one chunk — return it without a copy.
      if (single === null && chunks.length === 0) single = chunk;
      else {
        if (single !== null) {
          chunks.push(single);
          single = null;
        }
        chunks.push(chunk);
      }
    });
    req.on('end', () => {
      if (single !== null) resolve(single);
      else resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

function parseJsonBody(body: Buffer): Record<string, unknown> | undefined {
  if (body.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new HttpError(400, 'Request body must be a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, 'Malformed JSON body');
  }
}

/**
 * GraphQL bodies only: one operation object, or a JSON array of them
 * (GitHub's operation batching). Everything else is a 400, exactly like
 * parseJsonBody — this allowance must never leak to the REST routes
 * (protocol.malformed-body-400).
 */
function parseGraphqlBody(body: Buffer): Record<string, unknown> | Array<Record<string, unknown>> {
  if (body.length === 0) throw new HttpError(400, 'Request body must be a JSON object');
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Malformed JSON body');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new HttpError(400, 'Request body must be a JSON object');
  }
  if (Array.isArray(parsed)) {
    for (const entry of parsed) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        throw new HttpError(400, 'Request body must be a JSON object');
      }
    }
    return parsed as Array<Record<string, unknown>>;
  }
  return parsed as Record<string, unknown>;
}

/**
 * Split a request-target into pathname + query string without `new URL`
 * (URL parsing costs ~10 µs per request on this hot path). Absolute-form
 * targets and dot-segments fall back to `new URL` so their behaviour is
 * unchanged — the suite only sends clean origin-form paths.
 */
function splitTarget(rawUrl: string): { pathname: string; search: string } {
  const q = rawUrl.indexOf('?');
  const pathname = q < 0 ? rawUrl : rawUrl.slice(0, q);
  const search = q < 0 ? '' : rawUrl.slice(q + 1);
  if (rawUrl.startsWith('http://') || rawUrl.startsWith('https://') || /(?:^|\/)\.\.?(?:\/|$)/.test(pathname)) {
    const url = new URL(rawUrl, 'http://entry');
    return { pathname: url.pathname, search: url.search.slice(1) };
  }
  return { pathname, search };
}

function pathSegments(pathname: string): string[] {
  return pathname
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => {
      // decodeURIComponent is a no-op without '%'; skip it on the hot path.
      if (!segment.includes('%')) return segment;
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
}

/** The first pkt-line's payload as a string, without decoding the whole body. */
function firstPktLine(body: Buffer): string {
  if (body.length < 4) throw new Error('truncated pkt-line');
  const header = body.subarray(0, 4).toString('ascii');
  if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
  const length = Number.parseInt(header, 16);
  if (length === 0 || length === 1 || length === 2) return '';
  if (length < 4 || length > body.length) throw new Error('truncated pkt-line');
  return body.subarray(4, length).toString('utf8').replace(/\n$/, '');
}

function answerRest(res: ServerResponse, answer: RestAnswer): void {
  if (answer.empty === true) {
    sendEmpty(res, answer.status, answer.headers ?? {});
    return;
  }
  sendJson(res, answer.status, answer.json ?? {}, answer.headers ?? {});
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const { pathname, search } = splitTarget(req.url ?? '/');
      const method = req.method ?? 'GET';
      const segments = pathSegments(pathname);
      // Query params are parsed lazily: the hot routes never read them.
      let query: URLSearchParams | null = null;
      const getQuery = (): URLSearchParams => (query ??= new URLSearchParams(search));

      // The env's boot probe: 200 {"ok":true}, no token.
      if (method === 'GET' && pathname === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      // Git smart HTTP: /<owner>/<repo>.git/{info/refs,git-upload-pack,git-receive-pack}
      if (segments.length >= 3 && segments[1]?.endsWith('.git') === true) {
        const owner = segments[0] as string;
        const repoName = (segments[1] as string).slice(0, -'.git'.length);
        const action = segments.slice(2).join('/');
        const repo = store.getRepo(owner, repoName);
        if (action === 'info/refs') {
          const service = getQuery().get('service');
          if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
            sendError(res, 400, 'Missing service parameter');
            return;
          }
          if (repo === undefined) {
            sendError(res, 404, 'Not Found');
            return;
          }
          const protocol = req.headers['git-protocol'] === 'version=2' ? 2 : 0;
          if (service === 'git-upload-pack' && protocol === 2) {
            sendBytes(res, 200, 'application/x-git-upload-pack-advertisement', v2Advertisement());
          } else {
            sendBytes(res, 200, `application/x-${service}-advertisement`, v0Advertisement(repo, service));
          }
          return;
        }
        if (action === 'git-upload-pack' && method === 'POST') {
          if (repo === undefined) {
            sendError(res, 404, 'Not Found');
            return;
          }
          const body = await readBody(req);
          try {
            const command = firstPktLine(body);
            if (command === 'command=ls-refs') {
              sendBytes(res, 200, 'application/x-git-upload-pack-result', handleLsRefs(repo, body));
            } else if (command === 'command=fetch') {
              sendBytes(res, 200, 'application/x-git-upload-pack-result', handleFetch(repo, body, 2));
            } else if (command.startsWith('want ')) {
              // A v0 fetch: want lines, then haves, no command line.
              sendBytes(res, 200, 'application/x-git-upload-pack-result', handleFetch(repo, body, 0));
            } else {
              sendError(res, 400, 'Unknown git-upload-pack command');
            }
          } catch (err) {
            sendError(res, 400, err instanceof Error ? err.message : 'Bad request');
          }
          return;
        }
        if (action === 'git-receive-pack' && method === 'POST') {
          if (repo === undefined) {
            sendError(res, 404, 'Not Found');
            return;
          }
          const body = await readBody(req);
          try {
            sendBytes(res, 200, 'application/x-git-receive-pack-result', handleReceivePack(repo, body));
          } catch (err) {
            sendError(res, 400, err instanceof Error ? err.message : 'Bad request');
          }
          return;
        }
        sendError(res, 404, 'Not Found');
        return;
      }

      // API surfaces: a missing or wrong bearer token is a 401.
      if (segments[0] === 'api' && segments[1] === 'v3') {
        if (!authorized(req)) {
          sendError(res, 401, 'Bad credentials');
          return;
        }
        const body = method === 'GET' || method === 'HEAD' ? undefined : parseJsonBody(await readBody(req));
        try {
          answerRest(res, handleRest(method, segments.slice(2), getQuery(), body, { store, origin: `http://${req.headers.host ?? 'entry'}` }));
        } catch (err) {
          if (err instanceof HttpError) sendError(res, err.status, err.message);
          else sendError(res, 500, err instanceof Error ? err.message : 'Internal Server Error');
        }
        return;
      }

      if (pathname === '/api/graphql' && method === 'POST') {
        if (!authorized(req)) {
          sendError(res, 401, 'Bad credentials');
          return;
        }
        try {
          const answer = handleGraphql(parseGraphqlBody(await readBody(req)), store);
          sendJson(res, answer.status, answer.json);
        } catch (err) {
          if (err instanceof HttpError) sendError(res, err.status, err.message);
          else sendError(res, 500, err instanceof Error ? err.message : 'Internal Server Error');
        }
        return;
      }

      if (pathname === '/mcp' && method === 'POST') {
        if (!authorized(req)) {
          sendError(res, 401, 'Bad credentials');
          return;
        }
        const raw = await readBody(req);
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.toString('utf8'));
        } catch {
          // A body that is not JSON: HTTP 400 + JSON-RPC -32700 (parse error).
          sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
          return;
        }
        try {
          const answer = handleMcp(parsed, store);
          if (answer.empty === true) sendEmpty(res, answer.status);
          else sendJson(res, answer.status, answer.json ?? {});
        } catch (err) {
          if (err instanceof HttpError) sendError(res, err.status, err.message);
          else sendError(res, 500, err instanceof Error ? err.message : 'Internal Server Error');
        }
        return;
      }

      // Everything else, every method: GitHub's 404 body.
      sendError(res, 404, 'Not Found');
    })().catch((err: unknown) => {
      if (!res.headersSent) {
        if (err instanceof HttpError) sendError(res, err.status, err.message);
        else sendError(res, 500, err instanceof Error ? err.message : 'Internal Server Error');
      } else {
        res.destroy();
      }
    });
  });
}

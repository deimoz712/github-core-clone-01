// raw-http.ts — hand-rolled HTTP/1.1 transport on net.Server.
//
// Why: the suite's workload is thousands of small requests on keep-alive
// connections, and node:http's per-request machinery (~60 µs for a bare
// /healthz) dominates the server-side cost. This layer parses exactly what
// the suite's fetch-based clients send (origin-form targets, Content-Length
// or chunked bodies, keep-alive, pipelining) and writes exactly what app.ts
// used to send through node:http: status line, content-type, content-length,
// x-github-request-id plus any extra headers, then the body. No Date header
// is emitted (node:http adds one; determinism wants none). Anything
// malformed is a 400 JSON reply.
//
// Only the transport lives here: app.ts still owns routing, auth and bodies,
// and main.ts still owns the lifecycle (createApp() returns a net.Server,
// which has the same listen/address/close/once surface main.ts uses).

import { createServer, type Server, type Socket } from 'node:net';

/** One fully parsed request: method, raw target, lower-cased headers, body. */
export interface RawRequest {
  method: string;
  url: string;
  headers: Record<string, string | undefined>;
  body: Buffer;
}

/** One reply: status, extra headers (content-type, request id, ...), body. */
export interface RawReply {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

/** The application handler: one request in, one reply out. */
export type RawHandler = (req: RawRequest) => Promise<RawReply> | RawReply;

const EMPTY = Buffer.alloc(0);
const MAX_HEAD_BYTES = 64 * 1024;
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const IDLE_TIMEOUT_MS = 120_000;
const CRLF = '\r\n';

const REASONS: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  413: 'Content Too Large',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
};

let rawErrorCounter = 0;

/** A transport-level error reply (malformed request, oversized body, ...). */
function errorReply(status: number, message: string): RawReply {
  rawErrorCounter += 1;
  return {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-github-request-id': `raw-${rawErrorCounter}`,
    },
    body: Buffer.from(`${JSON.stringify({ message })}\n`, 'utf8'),
  };
}

/** A parse failure carrying the HTTP status it must be answered with. */
class TransportError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** A request line + headers, parsed but with the body still to come. */
interface ParsedHead {
  method: string;
  url: string;
  headers: Record<string, string | undefined>;
  headLen: number;
  contentLength: number;
  chunked: boolean;
  expectContinue: boolean;
  keepAlive: boolean;
  isHead: boolean;
}

/**
 * Parse the request line + headers at the front of `buf`.
 * Returns null when the header block has not fully arrived yet; throws
 * TransportError on anything malformed (or oversized).
 */
function tryParseHead(buf: Buffer): ParsedHead | null {
  const end = buf.indexOf('\r\n\r\n');
  if (end < 0) {
    if (buf.length > MAX_HEAD_BYTES) throw new TransportError(400, 'request headers too large');
    return null;
  }
  const headText = buf.subarray(0, end).toString('latin1');
  const lines = headText.split(CRLF);
  const requestLine = lines[0] ?? '';
  const firstSpace = requestLine.indexOf(' ');
  const secondSpace = requestLine.indexOf(' ', firstSpace + 1);
  if (firstSpace <= 0 || secondSpace <= firstSpace + 1) throw new TransportError(400, 'malformed request line');
  const method = requestLine.slice(0, firstSpace);
  const url = requestLine.slice(firstSpace + 1, secondSpace);
  const version = requestLine.slice(secondSpace + 1);
  if (version !== 'HTTP/1.1' && version !== 'HTTP/1.0') throw new TransportError(400, 'unsupported HTTP version');
  if (url.length === 0) throw new TransportError(400, 'empty request target');
  const headers: Record<string, string | undefined> = {};
  let contentLength = -1;
  let chunked = false;
  let expectContinue = false;
  let connectionClose = false;
  let connectionKeepAlive = false;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (line === '') continue;
    const colon = line.indexOf(':');
    if (colon <= 0) throw new TransportError(400, 'malformed header line');
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (name === 'content-length') {
      if (!/^\d+$/.test(value)) throw new TransportError(400, 'malformed content-length');
      const parsed = Number(value);
      if (contentLength >= 0 && contentLength !== parsed) throw new TransportError(400, 'conflicting content-length');
      contentLength = parsed;
    } else if (name === 'transfer-encoding') {
      const tokens = value.toLowerCase().split(',').map((token) => token.trim());
      if (tokens[tokens.length - 1] !== 'chunked') throw new TransportError(400, 'unsupported transfer-encoding');
      chunked = true;
    } else if (name === 'expect') {
      if (value.toLowerCase() === '100-continue') expectContinue = true;
    } else if (name === 'connection') {
      const tokens = value.toLowerCase().split(',').map((token) => token.trim());
      if (tokens.includes('close')) connectionClose = true;
      if (tokens.includes('keep-alive')) connectionKeepAlive = true;
    }
    const prev = headers[name];
    headers[name] = prev === undefined ? value : `${prev}, ${value}`;
  }
  if (chunked) contentLength = -1;
  if (contentLength > MAX_BODY_BYTES) throw new TransportError(413, 'Request body too large');
  const keepAlive = version === 'HTTP/1.1' ? !connectionClose : connectionKeepAlive;
  return {
    method,
    url,
    headers,
    headLen: end + 4,
    contentLength,
    chunked,
    expectContinue,
    keepAlive,
    isHead: method === 'HEAD',
  };
}

/**
 * Parse a chunked body starting at `buf[0]`. Returns null when more bytes
 * are needed; throws TransportError on a malformed chunk size or an
 * oversized total. Chunk pieces are subarrays of the input (no copies).
 */
function parseChunked(buf: Buffer): { body: Buffer; consumed: number } | null {
  const chunks: Buffer[] = [];
  let total = 0;
  let offset = 0;
  for (;;) {
    const lineEnd = buf.indexOf(CRLF, offset);
    if (lineEnd < 0) return null;
    const line = buf.subarray(offset, lineEnd).toString('ascii').trim();
    const semi = line.indexOf(';');
    const sizeText = (semi < 0 ? line : line.slice(0, semi)).trim();
    if (!/^[0-9a-fA-F]+$/.test(sizeText)) throw new TransportError(400, 'malformed chunk size');
    const size = Number.parseInt(sizeText, 16);
    const dataStart = lineEnd + 2;
    if (size === 0) {
      // Trailers, if any, run to the first empty line.
      let pos = dataStart;
      for (;;) {
        const trailerEnd = buf.indexOf(CRLF, pos);
        if (trailerEnd < 0) return null;
        if (trailerEnd === pos) {
          const body = chunks.length === 1 ? (chunks[0] as Buffer) : Buffer.concat(chunks, total);
          return { body, consumed: trailerEnd + 2 };
        }
        pos = trailerEnd + 2;
      }
    }
    if (buf.length < dataStart + size + 2) return null;
    total += size;
    if (total > MAX_BODY_BYTES) throw new TransportError(413, 'Request body too large');
    if (size > 0) chunks.push(buf.subarray(dataStart, dataStart + size));
    offset = dataStart + size + 2;
  }
}

/**
 * Take the body for an already-parsed head out of `buf`. Returns null when
 * the body has not fully arrived yet. The returned body is a subarray of
 * `buf` (no copy) except for chunked bodies, which are concatenated.
 */
function tryTakeBody(buf: Buffer, head: ParsedHead): { body: Buffer; consumed: number } | null {
  if (head.chunked) {
    const parsed = parseChunked(buf.subarray(head.headLen));
    if (parsed === null) return null;
    return { body: parsed.body, consumed: head.headLen + parsed.consumed };
  }
  if (head.contentLength >= 0) {
    if (buf.length - head.headLen < head.contentLength) return null;
    return { body: buf.subarray(head.headLen, head.headLen + head.contentLength), consumed: head.headLen + head.contentLength };
  }
  return { body: EMPTY, consumed: head.headLen };
}

/** Resolve true when the socket drains, false when it closes/errors first. */
function waitDrain(socket: Socket): Promise<boolean> {
  return new Promise((resolve) => {
    const cleanup = (): void => {
      socket.removeListener('drain', onDrain);
      socket.removeListener('close', onClose);
      socket.removeListener('error', onError);
    };
    const onDrain = (): void => {
      cleanup();
      resolve(true);
    };
    const onClose = (): void => {
      cleanup();
      resolve(false);
    };
    const onError = (): void => {
      cleanup();
      resolve(false);
    };
    socket.once('drain', onDrain);
    socket.once('close', onClose);
    socket.once('error', onError);
  });
}

/**
 * Write one reply. Framing is always Content-Length (except 204/304, which
 * have no body by definition); a HEAD reply carries the length but no body
 * bytes, matching node:http. Returns false when the socket died mid-write.
 */
async function writeReply(socket: Socket, reply: RawReply, isHead: boolean, closeAfter: boolean): Promise<boolean> {
  const noBody = reply.status === 204 || reply.status === 304;
  const bodyLen = noBody ? 0 : reply.body.length;
  let head = `HTTP/1.1 ${reply.status} ${REASONS[reply.status] ?? ''}\r\n`;
  for (const name of Object.keys(reply.headers)) {
    head += `${name}: ${reply.headers[name] as string}\r\n`;
  }
  if (!noBody) head += `content-length: ${bodyLen}\r\n`;
  if (closeAfter) head += 'connection: close\r\n';
  head += '\r\n';
  socket.cork();
  let ok = socket.write(head);
  if (!noBody && !isHead && reply.body.length > 0) ok = socket.write(reply.body) && ok;
  socket.uncork();
  if (!ok) return waitDrain(socket);
  return true;
}

/** One connection: parse requests in order, answer each, keep the socket. */
function serveConnection(socket: Socket, handler: RawHandler): void {
  socket.setNoDelay(true);
  socket.setTimeout(IDLE_TIMEOUT_MS);
  socket.on('timeout', () => {
    socket.destroy();
  });
  // Resets by the peer are routine; there is nothing to report.
  socket.on('error', () => undefined);
  let buf: Buffer = EMPTY;
  let head: ParsedHead | null = null;
  let pumping = false;
  let dead = false;
  let peerEnded = false;
  // A data event that landed while the pump loop was awaiting the handler:
  // the loop may have returned on an incomplete request before it arrived,
  // so the finally block re-kicks exactly once per such event. Never re-kick
  // on state (head/buf) — that recurses synchronously on every split
  // arrival and overflows the stack.
  let dataWhilePumping = false;

  /** Answer a transport-level failure, then close the socket. */
  const fail = (err: unknown): void => {
    if (dead) return;
    dead = true;
    const status = err instanceof TransportError ? err.status : 400;
    const reply = errorReply(status, err instanceof Error ? err.message : 'Bad request');
    const headText = `HTTP/1.1 ${reply.status} ${REASONS[reply.status] ?? ''}\r\ncontent-type: ${reply.headers['content-type'] as string}\r\nx-github-request-id: ${reply.headers['x-github-request-id'] as string}\r\ncontent-length: ${reply.body.length}\r\nconnection: close\r\n\r\n`;
    socket.cork();
    socket.write(headText);
    socket.write(reply.body);
    socket.uncork();
    socket.end();
  };

  const pump = (): void => {
    if (pumping || dead) return;
    pumping = true;
    void (async () => {
      try {
        for (;;) {
          if (head === null) {
            try {
              head = tryParseHead(buf);
            } catch (err) {
              fail(err);
              return;
            }
            if (head === null) return;
            if (head.expectContinue && (head.contentLength > 0 || head.chunked)) {
              socket.write('HTTP/1.1 100 Continue\r\n\r\n');
            }
          }
          let taken: { body: Buffer; consumed: number } | null;
          try {
            taken = tryTakeBody(buf, head);
          } catch (err) {
            fail(err);
            return;
          }
          if (taken === null) return;
          const current = head;
          head = null;
          buf = taken.consumed >= buf.length ? EMPTY : buf.subarray(taken.consumed);
          const req: RawRequest = { method: current.method, url: current.url, headers: current.headers, body: taken.body };
          let reply: RawReply;
          try {
            reply = await handler(req);
          } catch (err) {
            reply = errorReply(500, err instanceof Error ? err.message : 'Internal Server Error');
          }
          if (dead) return;
          const alive = await writeReply(socket, reply, current.isHead, !current.keepAlive);
          if (!alive || dead) return;
          if (!current.keepAlive || peerEnded) {
            socket.end();
            return;
          }
        }
      } finally {
        pumping = false;
        if (dead) return;
        if (peerEnded) {
          if (head === null && buf.length === 0) socket.end();
          else socket.destroy();
          return;
        }
        // Data may have arrived while the loop was awaiting the handler
        // and returned early on an incomplete request; re-kick once per
        // such event (the flag is cleared before re-kicking, so this
        // cannot recurse without a fresh data event behind it).
        if (dataWhilePumping) {
          dataWhilePumping = false;
          pump();
        }
      }
    })();
  };

  socket.on('data', (chunk: Buffer) => {
    if (pumping) dataWhilePumping = true;
    buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
    pump();
  });
  socket.on('end', () => {
    peerEnded = true;
    if (!pumping) {
      if (head === null && buf.length === 0) socket.end();
      else socket.destroy();
    }
  });
  socket.on('close', () => {
    dead = true;
  });
}

/** Build the server. It binds nothing until the caller listens. */
export function createRawServer(handler: RawHandler): Server {
  return createServer((socket: Socket) => {
    serveConnection(socket, handler);
  });
}

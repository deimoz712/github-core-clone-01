// git-http.ts — git smart HTTP: pkt-line framing, v2/v0 advertisements,
// ls-refs, fetch (v2 and v0) and receive-pack.
//
// The wire shapes follow the kit's git-client.ts exactly: the same section
// order in a v2 fetch reply, the same sideband framing, the same report-status
// lines. A fetch never sends a delta; a push is accepted with or without one
// (readPack resolves OFS/REF deltas, thin packs included).

import { ZERO_OID, isOid } from './git-objects.ts';
import type { Repo } from './store.ts';

export const AGENT = 'forge/1.0';

/** One pkt-line: 4 hex length + payload. */
export function encodePktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > 65516) throw new Error(`pkt-line payload is ${data.length} bytes, over the 65516-byte maximum`);
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

export type PktItem = string | Buffer | 'flush' | 'delim';

export function encodePktLines(items: readonly PktItem[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktFlush());
    else if (item === 'delim') parts.push(pktDelim());
    else parts.push(encodePktLine(item));
  }
  return Buffer.concat(parts);
}

export interface Packet {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  payload: Buffer;
}

/** Decode a pkt-line stream. Throws on a malformed header or truncation. */
export function decodePktLines(buf: Buffer): Packet[] {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error(`truncated pkt-line: ${buf.length - offset} trailing byte(s)`);
    const header = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buf.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return packets;
}

/** Wrap `data` in side-band-64k packets (band 1), split at the pkt-line limit. */
function sidebandPackets(data: Buffer, band = 1): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65515; // 65520 - 4 (pkt-line header) - 1 (band byte)
  for (let offset = 0; offset < data.length || out.length === 0; offset += CHUNK) {
    const chunk = data.subarray(offset, Math.min(data.length, offset + CHUNK));
    out.push(encodePktLine(Buffer.concat([Buffer.from([band]), chunk])));
    if (offset + CHUNK >= data.length) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Advertisements
// ---------------------------------------------------------------------------

function allRefs(repo: Repo): Array<{ name: string; oid: string; peeled?: string }> {
  const out: Array<{ name: string; oid: string; peeled?: string }> = [];
  const heads = [...repo.refs.keys()].filter((ref) => ref.startsWith('refs/heads/')).sort();
  const tags = [...repo.refs.keys()].filter((ref) => ref.startsWith('refs/tags/')).sort();
  for (const ref of [...heads, ...tags]) {
    const oid = repo.refs.get(ref) as string;
    const entry: { name: string; oid: string; peeled?: string } = { name: ref, oid };
    if (ref.startsWith('refs/tags/')) {
      const object = repo.objects.get(oid);
      if (object?.type === 'tag') {
        try {
          entry.peeled = repo.objects.peelToCommit(oid);
        } catch {
          // An unpeelable tag advertises without a peeled line.
        }
      }
    }
    out.push(entry);
  }
  return out;
}

/** The v2 advertisement for upload-pack. */
export function v2Advertisement(): Buffer {
  return encodePktLines([
    '# service=git-upload-pack\n',
    'flush',
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow wait-for-done\n',
    'object-format=sha1\n',
    `agent=${AGENT}\n`,
    'flush',
  ]);
}

/** The v0 advertisement for a service, with the ref list and capabilities. */
export function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const serviceName = service === 'git-upload-pack' ? 'git-upload-pack' : 'git-receive-pack';
  const caps =
    service === 'git-upload-pack'
      ? `symref=HEAD:refs/heads/${repo.defaultBranch} side-band-64k ofs-delta shallow agent=${AGENT} object-format=sha1`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT} object-format=sha1`;
  const parts: Buffer[] = [encodePktLine(`# service=${serviceName}\n`), pktFlush()];
  const refs = allRefs(repo);
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (refs.length === 0 && headTip === undefined) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headOid = headTip ?? ZERO_OID;
    parts.push(encodePktLine(`${headOid} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(encodePktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled !== undefined) parts.push(encodePktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// ls-refs (v2)
// ---------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

/** Answer a v2 ls-refs request body. */
export function handleLsRefs(repo: Repo, body: Buffer): Buffer {
  const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  for (const packet of decodePktLines(body)) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'peel') args.peel = true;
    else if (line === 'symrefs') args.symrefs = true;
    else if (line === 'unborn') args.unborn = true;
    else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const refs = allRefs(repo);
  if (keep('HEAD')) {
    if (headTip !== undefined) {
      lines.push(args.symrefs ? `${headTip} HEAD symref-target:refs/heads/${repo.defaultBranch}\n` : `${headTip} HEAD\n`);
    } else if (args.unborn && refs.length === 0) {
      lines.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
    }
  }
  for (const ref of refs) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (args.peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    lines.push(`${line}\n`);
  }
  return encodePktLines([...lines, 'flush']);
}

// ---------------------------------------------------------------------------
// fetch (v2 and v0)
// ---------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
}

function parseFetchArgs(body: Buffer, protocol: 0 | 2): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [] };
  for (const packet of decodePktLines(body)) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const rest = line.slice(5).split(' ')[0] as string;
      if (isOid(rest)) args.wants.push(rest.toLowerCase());
    } else if (line.startsWith('have ')) {
      const oid = line.slice(5).trim();
      if (isOid(oid)) args.haves.push(oid.toLowerCase());
    } else if (line.startsWith('shallow ')) {
      const oid = line.slice(8).trim();
      if (isOid(oid)) args.shallow.push(oid.toLowerCase());
    } else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) args.depth = n;
    }
  }
  return args;
}

/** One fetch, answered. The pack (and its shallow lists) are cached per repo. */
export function handleFetch(repo: Repo, body: Buffer, protocol: 0 | 2): Buffer {
  const args = parseFetchArgs(body, protocol);
  const cacheKey = `fetch|${args.wants.join(',')}|${args.haves.join(',')}|${args.shallow.join(',')}|${args.depth ?? ''}`;
  const cached = repo.packCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const { objects, shallow, unshallow } = repo.objects.selectFetch(args.wants, {
    haves: args.haves,
    shallow: args.shallow,
    depth: args.depth,
  });
  const pack = repo.objects.packFor(objects);

  let out: Buffer;
  if (protocol === 2) {
    const parts: Buffer[] = [];
    parts.push(encodePktLine('acknowledgments\n'));
    parts.push(encodePktLine('NAK\n'));
    parts.push(pktDelim());
    if (shallow.length > 0 || unshallow.length > 0) {
      parts.push(encodePktLine('shallow-info\n'));
      for (const oid of shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
      for (const oid of unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
      parts.push(pktDelim());
    }
    parts.push(encodePktLine('packfile\n'));
    parts.push(...sidebandPackets(pack, 1));
    parts.push(pktFlush());
    out = Buffer.concat(parts);
  } else {
    const parts: Buffer[] = [];
    parts.push(encodePktLine('NAK\n'));
    for (const oid of shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(...sidebandPackets(pack, 1));
    parts.push(pktFlush());
    out = Buffer.concat(parts);
  }
  repo.packCache.set(cacheKey, out);
  return out;
}

// ---------------------------------------------------------------------------
// receive-pack (v0)
// ---------------------------------------------------------------------------

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Parse a receive-pack body into commands plus the trailing pack bytes. */
export function parseReceivePack(body: Buffer): { commands: PushCommand[]; pack: Buffer } {
  const commands: PushCommand[] = [];
  let offset = 0;
  for (;;) {
    if (offset + 4 > body.length) throw new Error('receive-pack body is truncated');
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      offset += 4;
      break;
    }
    if (length < 4 || offset + length > body.length) throw new Error('receive-pack command is truncated');
    const line = body.subarray(offset + 4, offset + length).toString('utf8').replace(/\n$/, '');
    offset += length;
    const nul = line.indexOf('\0');
    const command = nul >= 0 ? line.slice(0, nul) : line;
    const parts = command.split(' ');
    if (parts.length !== 3) throw new Error(`bad receive-pack command ${JSON.stringify(line.slice(0, 60))}`);
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!isOid(oldOid) || !isOid(newOid)) throw new Error('receive-pack command has a bad object id');
    commands.push({ oldOid: oldOid.toLowerCase(), newOid: newOid.toLowerCase(), ref });
  }
  return { commands, pack: body.subarray(offset) };
}

/**
 * Answer a receive-pack exchange: unpack the pack, apply each command's
 * fast-forward rules, and report ok/ng per ref inside sideband band 1.
 */
export function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  const reportLines: string[] = [];
  let commands: PushCommand[];
  let pack: Buffer;
  try {
    ({ commands, pack } = parseReceivePack(body));
  } catch (err) {
    reportLines.push(`unpack ${err instanceof Error ? err.message : 'bad request'}\n`);
    return reportResponse(reportLines, []);
  }
  if (commands.length === 0) {
    reportLines.push('unpack ok\n');
    return reportResponse(reportLines, []);
  }

  // Unpack first: the pack's objects land in the store whatever the refs do.
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (pack.length > 0) {
    try {
      repo.objects.importPack(pack);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  reportLines.push(`unpack ${unpackDetail}\n`);

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  if (unpackOk) {
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) {
          results.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
        } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
          results.push({ ref: command.ref, ok: false, reason: 'stale info' });
        } else {
          repo.deleteRef(command.ref);
          results.push({ ref: command.ref, ok: true, reason: '' });
        }
        continue;
      }
      if (!repo.objects.has(command.newOid)) {
        results.push({ ref: command.ref, ok: false, reason: 'missing object' });
        continue;
      }
      if (current === undefined) {
        // Create.
        if (command.oldOid !== ZERO_OID) {
          results.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
        } else {
          repo.setRef(command.ref, command.newOid);
          results.push({ ref: command.ref, ok: true, reason: '' });
        }
        continue;
      }
      // Update.
      if (command.oldOid !== current) {
        results.push({ ref: command.ref, ok: false, reason: 'stale info' });
        continue;
      }
      if (command.newOid === current || repo.objects.isAncestor(current, command.newOid)) {
        repo.setRef(command.ref, command.newOid);
        results.push({ ref: command.ref, ok: true, reason: '' });
      } else {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      }
    }
  } else {
    for (const command of commands) {
      results.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
    }
  }
  return reportResponse(reportLines, results);
}

/** The report-status stream, pkt-lined inside sideband band 1. */
function reportResponse(reportLines: string[], results: Array<{ ref: string; ok: boolean; reason: string }>): Buffer {
  const lines: PktItem[] = [...reportLines];
  for (const result of results) {
    lines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  lines.push('flush');
  const report = encodePktLines(lines);
  return Buffer.concat([...sidebandPackets(report, 1), pktFlush()]);
}

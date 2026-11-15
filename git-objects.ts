// git-objects.ts — the git object store, packfile read/write, reachability.
//
// Only node:crypto (SHA-1) and node:zlib (deflate/inflate). No git binary, no
// filesystem. Every object is a {type, data} pair keyed by its SHA-1 hex; the
// bytes stored are exactly the bytes a client pushed, so a clone returns them
// byte-identical.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);
/** Fixed timestamp for every server-created commit (2025-01-01T00:00:00Z). */
export const FIXED_EPOCH_SEC = 1735689600;
/** Fixed identity for every server-created commit. */
export const FIXED_IDENTITY = 'Conformance <conformance@make.fun>';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

const OBJECT_TYPE_CODE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_OBJECT_TYPE: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function isOid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value);
}

/** The git object id of `type` + `data`: sha1("<type> <len>\0" + data). */
export function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** Compare tree entry names the way git does: a directory sorts as name + '/'. */
export function compareTreeNames(a: { name: string; isDir: boolean }, b: { name: string; isDir: boolean }): number {
  const an = a.isDir ? `${a.name}/` : a.name;
  const bn = b.isDir ? `${b.name}/` : b.name;
  return an < bn ? -1 : an > bn ? 1 : 0;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Build a tree object from entries (sorted git order). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) =>
    compareTreeNames({ name: a.name, isDir: a.mode === '40000' }, { name: b.name, isDir: b.mode === '40000' }),
  );
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a tree object into its entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode');
    const mode = data.subarray(offset, space).toString('utf8');
    const nul = data.indexOf(0, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry has no oid');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Build a commit object. Same byte layout as the suite's buildCommit. */
export function buildCommit(fields: { tree: string; parents?: readonly string[]; message: string; author?: string; committer?: string; timestamp?: number }): Buffer {
  const timestamp = fields.timestamp ?? FIXED_EPOCH_SEC;
  const who = `${fields.author ?? FIXED_IDENTITY} ${timestamp} +0000`;
  const committer = `${fields.committer ?? FIXED_IDENTITY} ${timestamp} +0000`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

/** Parse a commit object. */
export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  if (!isOid(tree)) throw new Error('commit has no valid tree header');
  return { tree, parents, author, committer, message };
}

export interface TagView {
  object: string;
  type: ObjectType;
  tag: string;
  tagger: string;
  message: string;
}

/** Build an annotated tag object. */
export function buildTag(fields: { object: string; type: ObjectType; tag: string; message: string; tagger?: string; timestamp?: number }): Buffer {
  const timestamp = fields.timestamp ?? FIXED_EPOCH_SEC;
  const lines = [
    `object ${fields.object}`,
    `type ${fields.type}`,
    `tag ${fields.tag}`,
    `tagger ${fields.tagger ?? FIXED_IDENTITY} ${timestamp} +0000`,
    '',
  ];
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let object = '';
  let type: ObjectType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'object') object = value;
    else if (key === 'type') type = value as ObjectType;
    else if (key === 'tag') tag = value;
    else if (key === 'tagger') tagger = value;
  }
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------------------
// Delta application (git's copy/insert instruction stream)
// ---------------------------------------------------------------------------

function readDeltaVarint(delta: Buffer, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    if (pos >= delta.length) throw new Error('delta size varint is truncated');
    const byte = delta[pos++];
    value |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
    if (shift > 63) throw new Error('delta size varint is too long');
  }
  return { value, next: pos };
}

/** Apply a delta to a base object's bytes, returning the result. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const source = readDeltaVarint(delta, 0);
  if (source.value !== base.length) throw new Error(`delta expects a ${source.value}-byte base, got ${base.length}`);
  const target = readDeltaVarint(delta, source.next);
  const out = Buffer.allocUnsafe(target.value);
  let written = 0;
  let offset = target.next;
  while (offset < delta.length) {
    const op = delta[offset++];
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if ((op & (1 << i)) !== 0) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset |= delta[offset++] << (i * 8);
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if ((op & (0x10 << i)) !== 0) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize |= delta[offset++] << (i * 8);
        }
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > target.value) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      if (offset + op > delta.length) throw new Error('delta insert is truncated');
      if (written + op > target.value) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + op);
      offset += op;
      written += op;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== target.value) throw new Error(`delta produced ${written} of ${target.value} bytes`);
  return out;
}

// ---------------------------------------------------------------------------
// Packfile read/write
// ---------------------------------------------------------------------------

export interface PackObject {
  type: ObjectType;
  data: Buffer;
}

interface PackEntry {
  offset: number;
  type: number; // 1..4 plain, 6 ofs-delta, 7 ref-delta
  size: number;
  data: Buffer; // inflated payload (for deltas: the delta stream)
  baseOffset?: number; // ofs-delta
  baseOid?: string; // ref-delta
}

function writePackObjectHeader(type: ObjectType, size: number): Buffer {
  const code = OBJECT_TYPE_CODE[type];
  const first = (code << 4) | (size & 0x0f);
  size >>>= 4;
  const bytes: number[] = [size === 0 ? first : first | 0x80];
  while (size !== 0) {
    bytes.push(size & 0x7f);
    size >>>= 7;
    if (size !== 0) bytes[bytes.length - 1] |= 0x80;
  }
  return Buffer.from(bytes);
}

/** Write a packfile (version 2, no deltas) from a list of objects. */
export function writePack(objects: readonly PackObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Verify a packfile's trailer checksum. */
export function verifyPackChecksum(pack: Buffer): { ok: boolean; actual: string; expected: string } {
  if (pack.length < 20) return { ok: false, actual: '', expected: '' };
  const expected = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
  const actual = pack.subarray(pack.length - 20).toString('hex');
  return { ok: expected === actual, actual, expected };
}

function readPackEntryHeader(pack: Buffer, offset: number): { type: number; size: number; next: number } {
  let pos = offset;
  if (pos >= pack.length) throw new Error('pack entry header is truncated');
  let byte = pack[pos++];
  const type = (byte >> 4) & 0x7;
  let size = byte & 0x0f;
  let shift = 4;
  while ((byte & 0x80) !== 0) {
    if (pos >= pack.length) throw new Error('pack entry header is truncated');
    byte = pack[pos++];
    size |= (byte & 0x7f) << shift;
    shift += 7;
  }
  return { type, size, next: pos };
}

/**
 * Read a packfile into objects. Handles OFS_DELTA and REF_DELTA (a ref-delta
 * base may be an object already in `resolveBase`, i.e. a thin pack). Throws on
 * a bad checksum, a truncated entry or an unresolvable delta.
 */
export function readPack(
  pack: Buffer,
  options: { resolveBase?: (oid: string) => PackObject | undefined } = {},
): { objects: Map<string, PackObject>; deltaCount: number } {
  const checksum = verifyPackChecksum(pack);
  if (!checksum.ok) throw new Error(`pack trailer ${checksum.actual} does not match its bytes ${checksum.expected}`);
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;

  const entries: PackEntry[] = [];
  const byOffset = new Map<number, PackEntry>();
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    const header = readPackEntryHeader(pack, offset);
    offset = header.next;
    const entry: PackEntry = { offset: entryOffset, type: header.type, size: header.size, data: Buffer.alloc(0) };
    if (header.type === 6) {
      // OFS_DELTA: base offset encoded as a negative offset varint.
      if (offset >= trailerStart) throw new Error('ofs-delta has no base offset');
      let byte = pack[offset++];
      let baseOffset = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        if (offset >= trailerStart) throw new Error('ofs-delta base offset is truncated');
        byte = pack[offset++];
        baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f);
      }
      entry.baseOffset = entryOffset - baseOffset;
    } else if (header.type === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!(header.type in CODE_OBJECT_TYPE)) {
      throw new Error(`unknown pack object type ${header.type}`);
    }
    const inflated = inflateSync(pack.subarray(offset));
    if (inflated.length !== header.size) throw new Error(`pack object at ${entryOffset} inflated to ${inflated.length} bytes, expected ${header.size}`);
    entry.data = inflated;
    // inflateSync ignores trailing bytes, so locate the stream's end separately.
    offset = skipDeflateStream(pack, offset, header.size);
    entries.push(entry);
    byOffset.set(entryOffset, entry);
  }

  const resolved = new Map<string, PackObject>();
  const resolving = new Set<number>();
  let deltaCount = 0;

  const resolve = (entry: PackEntry): PackObject => {
    if (entry.type >= 1 && entry.type <= 4) {
      const type = CODE_OBJECT_TYPE[entry.type] as ObjectType;
      return { type, data: entry.data };
    }
    deltaCount += 1;
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    try {
      let base: PackObject | undefined;
      if (entry.type === 6) {
        const baseEntry = byOffset.get(entry.baseOffset ?? -1);
        if (!baseEntry) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
        base = resolve(baseEntry);
      } else if (entry.type === 7) {
        const baseEntry = entries.find((e) => e.type >= 1 && e.type <= 4 && hashObject(CODE_OBJECT_TYPE[e.type] as ObjectType, e.data) === entry.baseOid);
        if (baseEntry) base = resolve(baseEntry);
        else base = options.resolveBase?.(entry.baseOid ?? '');
        if (!base) throw new Error(`ref-delta base ${entry.baseOid} is not in the pack or the store`);
      } else {
        throw new Error(`unknown pack object type ${entry.type}`);
      }
      const data = applyDelta(base.data, entry.data);
      return { type: base.type, data };
    } finally {
      resolving.delete(entry.offset);
    }
  };

  for (const entry of entries) {
    const object = resolve(entry);
    resolved.set(hashObject(object.type, object.data), object);
  }
  return { objects: resolved, deltaCount };
}

/**
 * Advance `offset` past one deflate stream in `pack`. Node's inflateSync does
 * not report how many input bytes it consumed, but it throws on a truncated
 * stream and ignores trailing bytes: so the stream's end is the smallest
 * prefix that inflates to `expectedSize`. Find it with an exponential probe
 * (each attempt inflates at most twice the stream) and a binary search inside
 * the last interval, so one pack entry costs O(stream) inflate work.
 */
function skipDeflateStream(pack: Buffer, offset: number, expectedSize: number): number {
  const limit = pack.length - 20; // never run into the trailer
  const tryEnd = (end: number): boolean => {
    try {
      return inflateSync(pack.subarray(offset, end)).length === expectedSize;
    } catch {
      return false;
    }
  };
  let low = offset; // a prefix that fails (offset itself inflates nothing)
  let high = Math.min(limit, offset + 16);
  while (high < limit && !tryEnd(high)) {
    low = high;
    high = Math.min(limit, high * 2);
  }
  if (!tryEnd(high)) throw new Error('could not find the end of a deflate stream in the pack');
  // Binary search the smallest successful end in (low, high].
  while (low + 1 < high) {
    const mid = (low + high) >>> 1;
    if (tryEnd(mid)) high = mid;
    else low = mid;
  }
  return high;
}

// ---------------------------------------------------------------------------
// The object store
// ---------------------------------------------------------------------------

export class ObjectStore {
  readonly objects = new Map<string, PackObject>();

  put(type: ObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  get(oid: string): PackObject | undefined {
    return this.objects.get(oid.toLowerCase());
  }

  has(oid: string): boolean {
    return this.objects.has(oid.toLowerCase());
  }

  /** Import every object from a pack (delta bases may resolve against this store). */
  importPack(pack: Buffer): { count: number; deltaCount: number } {
    const read = readPack(pack, { resolveBase: (oid) => this.get(oid) });
    for (const [oid, object] of read.objects) {
      if (!this.objects.has(oid)) this.objects.set(oid, object);
    }
    return { count: read.objects.size, deltaCount: read.deltaCount };
  }

  // -- tree helpers ---------------------------------------------------------

  /** The tree object at `oid`, parsed. */
  treeEntries(oid: string): TreeEntry[] {
    const object = this.get(oid);
    if (!object || object.type !== 'tree') throw new Error(`no tree ${oid}`);
    return parseTree(object.data);
  }

  /** The commit object at `oid`, parsed. */
  commit(oid: string): CommitView {
    const object = this.get(oid);
    if (!object || object.type !== 'commit') throw new Error(`no commit ${oid}`);
    return parseCommit(object.data);
  }

  /** Follow a tag chain to its ultimate target oid. */
  peelToCommit(oid: string): string {
    let current = oid;
    for (let depth = 0; depth < 10; depth += 1) {
      const object = this.get(current);
      if (!object) throw new Error(`no object ${current}`);
      if (object.type === 'tag') {
        current = parseTag(object.data).object;
        continue;
      }
      if (object.type === 'commit') return current;
      throw new Error(`cannot peel ${object.type} ${current} to a commit`);
    }
    throw new Error('tag chain too deep');
  }

  /** All tree + blob oids reachable from a tree (recursive, includes the tree itself). */
  collectTree(oid: string, out: Set<string>): void {
    if (out.has(oid)) return;
    const object = this.get(oid);
    if (!object) throw new Error(`no object ${oid}`);
    out.add(oid);
    if (object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      if (entry.mode === '40000') this.collectTree(entry.oid, out);
      else out.add(entry.oid);
    }
  }

  /** The blob oid at `path` in the tree rooted at `treeOid`, or null. */
  blobAtPath(treeOid: string, path: string): string | null {
    const segments = path.split('/').filter((s) => s !== '');
    let current = treeOid;
    for (let i = 0; i < segments.length; i += 1) {
      const entries = this.treeEntries(current);
      const entry = entries.find((e) => e.name === segments[i]);
      if (!entry) return null;
      if (i === segments.length - 1) return entry.mode === '40000' ? null : entry.oid;
      if (entry.mode !== '40000') return null;
      current = entry.oid;
    }
    return null;
  }

  /** The tree oid of the directory at `path` in the tree rooted at `treeOid`, or null. */
  treeAtPath(treeOid: string, path: string): string | null {
    const segments = path.split('/').filter((s) => s !== '');
    let current = treeOid;
    for (const segment of segments) {
      const entries = this.treeEntries(current);
      const entry = entries.find((e) => e.name === segment && e.mode === '40000');
      if (!entry) return null;
      current = entry.oid;
    }
    return current;
  }

  /** The entries of the directory at `path` in the tree rooted at `treeOid`. */
  dirEntries(treeOid: string, path: string): { entries: TreeEntry[]; dirOid: string } | null {
    const dirOid = path === '' ? treeOid : this.treeAtPath(treeOid, path);
    if (dirOid === null) return null;
    return { entries: this.treeEntries(dirOid), dirOid };
  }

  /**
   * Build a new tree from `baseTreeOid` (or null for an empty tree) with the
   * file at `path` set to `blobOid` (or removed when null). Returns the new
   * root tree oid, storing every intermediate tree.
   */
  setPath(baseTreeOid: string | null, path: string, blobOid: string | null): string {
    const segments = path.split('/').filter((s) => s !== '');
    if (segments.length === 0) throw new Error('empty path');
    const build = (treeOid: string | null, depth: number): string => {
      const entries = new Map<string, TreeEntry>();
      if (treeOid !== null) {
        for (const entry of this.treeEntries(treeOid)) entries.set(entry.name, entry);
      }
      const name = segments[depth] as string;
      if (depth === segments.length - 1) {
        if (blobOid === null) entries.delete(name);
        else entries.set(name, { mode: '100644', name, oid: blobOid });
      } else {
        const child = entries.get(name);
        const childOid = child && child.mode === '40000' ? child.oid : null;
        const next = build(childOid, depth + 1);
        // An empty directory is not a tree: drop it.
        const nextEntries = this.treeEntries(next);
        if (nextEntries.length === 0) entries.delete(name);
        else entries.set(name, { mode: '40000', name, oid: next });
      }
      return this.put('tree', buildTree([...entries.values()]));
    };
    return build(baseTreeOid, 0);
  }

  // -- reachability ---------------------------------------------------------

  /** All commit oids reachable from `tips` (following every parent). */
  reachableCommits(tips: readonly string[]): Set<string> {
    const seen = new Set<string>();
    const stack = [...tips];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      const object = this.get(oid);
      if (!object) continue;
      if (object.type === 'tag') {
        seen.add(oid);
        stack.push(parseTag(object.data).object);
        continue;
      }
      if (object.type !== 'commit') continue;
      seen.add(oid);
      for (const parent of parseCommit(object.data).parents) stack.push(parent);
    }
    return seen;
  }

  /** True when `ancestor` is reachable from `descendant` (or they are equal). */
  isAncestor(ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const stack = [descendant];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = this.get(oid);
      if (!object) continue;
      if (object.type === 'tag') {
        stack.push(parseTag(object.data).object);
        continue;
      }
      if (object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) stack.push(parent);
    }
    return false;
  }

  /**
   * The merge-base of two commits: the nearest common ancestor, found by
   * walking both ancestries (breadth-first by generation, newest first).
   */
  mergeBase(a: string, b: string): string | null {
    if (a === b) return a;
    const aAncestors = new Map<string, number>();
    const queueA: Array<[string, number]> = [[a, 0]];
    while (queueA.length > 0) {
      const [oid, depth] = queueA.shift() as [string, number];
      if (aAncestors.has(oid)) continue;
      aAncestors.set(oid, depth);
      const object = this.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queueA.push([parent, depth + 1]);
    }
    const queueB: Array<[string, number]> = [[b, 0]];
    let best: string | null = null;
    let bestDepth = Number.POSITIVE_INFINITY;
    const seenB = new Set<string>();
    while (queueB.length > 0) {
      const [oid, depth] = queueB.shift() as [string, number];
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      const aDepth = aAncestors.get(oid);
      if (aDepth !== undefined && depth + aDepth < bestDepth) {
        best = oid;
        bestDepth = depth + aDepth;
      }
      const object = this.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queueB.push([parent, depth + 1]);
    }
    return best;
  }

  /**
   * The paths whose blob differs between two trees (recursive). A path maps to
   * its blob oid, or null when the path is absent in that tree.
   */
  diffTrees(baseTreeOid: string | null, headTreeOid: string | null): Map<string, string | null> {
    const flatten = (treeOid: string | null, prefix: string, out: Map<string, string>): void => {
      if (treeOid === null) return;
      for (const entry of this.treeEntries(treeOid)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') flatten(entry.oid, path, out);
        else out.set(path, entry.oid);
      }
    };
    const base = new Map<string, string>();
    const head = new Map<string, string>();
    flatten(baseTreeOid, '', base);
    flatten(headTreeOid, '', head);
    const diff = new Map<string, string | null>();
    for (const [path, oid] of head) {
      if (base.get(path) !== oid) diff.set(path, oid);
    }
    for (const path of base.keys()) {
      if (!head.has(path)) diff.set(path, null);
    }
    return diff;
  }

  // -- fetch selection ------------------------------------------------------

  /**
   * The objects a fetch must send for `wants`, honouring `haves` (already
   * held: never re-sent), `depth` (shallow: only that many generations) and the
   * client's previous shallow boundaries. Returns the object oids to pack plus
   * the new shallow/unshallow boundary lists.
   */
  selectFetch(wants: readonly string[], options: { haves?: readonly string[]; shallow?: readonly string[]; depth?: number } = {}): {
    objects: Set<string>;
    shallow: string[];
    unshallow: string[];
  } {
    const objects = new Set<string>();
    const depth = options.depth;
    const haves = new Set(options.haves ?? []);
    const oldShallow = new Set(options.shallow ?? []);

    // What the client already holds. A normal have means the whole ancestry
    // below it; a have that is also one of the client's shallow boundaries
    // means only that commit and its tree — its parents are exactly what a
    // deepen is asking for, so they must NOT be treated as held.
    const held = new Set<string>();
    for (const have of haves) {
      if (oldShallow.has(have)) {
        held.add(have);
        try {
          this.collectTree(this.commit(have).tree, held);
        } catch {
          // A have the store does not know: nothing to exclude below it.
        }
        continue;
      }
      for (const commit of this.reachableCommits([have])) {
        held.add(commit);
        try {
          this.collectTree(this.commit(commit).tree, held);
        } catch {
          // A have the store does not know: nothing to exclude below it.
        }
      }
      const object = this.get(have);
      if (object && object.type !== 'commit') held.add(have);
    }

    const newShallow = new Set<string>();
    const newUnshallow = new Set<string>();
    // Walk commits breadth-first, tracking the generation from the nearest want.
    const queue: Array<{ oid: string; distance: number }> = [];
    const seenCommit = new Set<string>();
    for (const want of wants) {
      const object = this.get(want);
      if (!object) continue;
      if (object.type === 'tag') {
        // Tags are sent whole, then the walk continues from their target.
        if (!held.has(want)) objects.add(want);
        const target = parseTag(object.data).object;
        const targetObject = this.get(target);
        if (targetObject?.type === 'commit') queue.push({ oid: target, distance: 0 });
        else if (targetObject) objects.add(target);
        continue;
      }
      if (object.type === 'commit') queue.push({ oid: want, distance: 0 });
      else objects.add(want); // a blob/tree want: send it directly
    }
    queue.sort((a, b) => a.distance - b.distance);
    while (queue.length > 0) {
      const { oid, distance } = queue.shift() as { oid: string; distance: number };
      if (seenCommit.has(oid)) continue;
      seenCommit.add(oid);
      const isHeld = held.has(oid);
      const isOldShallow = oldShallow.has(oid);
      // A fully-held commit cuts the walk off: everything below it is held.
      // A held shallow boundary does not: the client has the commit but not
      // its parents, so the walk continues past it.
      if (isHeld && !isOldShallow) continue;
      if (depth !== undefined && distance >= depth) continue;
      if (!isHeld) {
        const commit = this.commit(oid);
        objects.add(oid);
        this.collectTree(commit.tree, objects);
      }
      if (depth !== undefined && distance === depth - 1) {
        // The deepest generation sent: a new boundary — but only for a commit
        // actually sent; a held boundary at this depth simply stays shallow.
        if (!isHeld) newShallow.add(oid);
      } else {
        // This generation is fully present now: an old boundary here resolves.
        if (isOldShallow) newUnshallow.add(oid);
        const commit = this.commit(oid);
        for (const parent of commit.parents) queue.push({ oid: parent, distance: distance + 1 });
      }
    }
    // Remove anything the client already holds (trees/blobs shared with haves).
    for (const oid of [...objects]) {
      if (held.has(oid)) objects.delete(oid);
    }
    return { objects, shallow: [...newShallow], unshallow: [...newUnshallow] };
  }

  /** Build a pack (no deltas) from a set of oids, in a stable order. */
  packFor(oids: ReadonlySet<string> | readonly string[]): Buffer {
    const list = [...oids];
    const commits: string[] = [];
    const rest: string[] = [];
    for (const oid of list) {
      const object = this.get(oid);
      if (!object) continue;
      if (object.type === 'commit') commits.push(oid);
      else rest.push(oid);
    }
    // Commits newest-first (walk order is already tip-first for fetches), then
    // the rest sorted by oid: deterministic for the same input set.
    rest.sort();
    const packObjects: PackObject[] = [];
    for (const oid of [...commits, ...rest]) {
      const object = this.get(oid);
      if (object) packObjects.push(object);
    }
    return writePack(packObjects);
  }
}

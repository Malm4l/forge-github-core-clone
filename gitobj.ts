// The git object engine: SHA-1 object hashing, commit/tree/tag parsing and
// building, tree path surgery, reachability (with shallow depth), packfile
// writing (plain objects) and reading (plain + OFS/REF deltas), and the
// pkt-line codec. Pure node:crypto / node:zlib, no git binary anywhere.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { GitObjectRec, RepoRec } from './store.ts';

export const ZERO_OID = '0'.repeat(40);
export type GitType = GitObjectRec['type'];

const TYPE_CODE: Record<GitType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function hashObject(type: GitType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

export function storeObject(repo: RepoRec, type: GitType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function getObject(repo: RepoRec, oid: string): GitObjectRec | undefined {
  return repo.objects.get(oid);
}

// ---------------------------------------------------------------------------
// commits, trees, tags

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const view: CommitView = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) view.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) view.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) view.author = line.slice(7);
    else if (line.startsWith('committer ')) view.committer = line.slice(10);
  }
  return view;
}

export function buildCommit(args: {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  epochSec: number;
  message: string;
}): Buffer {
  const lines = [`tree ${args.tree}`];
  for (const parent of args.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${args.author} ${args.epochSec} +0000`);
  lines.push(`committer ${args.committer} ${args.epochSec} +0000`);
  const message = args.message.endsWith('\n') ? args.message : `${args.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
}

export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const view: TagView = { object: '', type: '', tag: '', tagger: '' };
  for (const line of text.split('\n')) {
    if (line.startsWith('object ')) view.object = line.slice(7).trim();
    else if (line.startsWith('type ')) view.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) view.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) view.tagger = line.slice(7);
    else if (line === '') break;
  }
  return view;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function compareEntries(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Every file under a tree, as path -> {oid, mode}; directories recursed. */
export function flattenTree(repo: RepoRec, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, base: string): void => {
    const obj = getObject(repo, oid);
    if (!obj || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      const path = base === '' ? entry.name : `${base}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, prefix);
  return out;
}

/** Write `blobOid` at `path` under `treeOid` (or an empty tree), returning the new root tree id. */
export function setTreePath(repo: RepoRec, treeOid: string | null, path: string, blobOid: string, mode = '100644'): string {
  const segments = path.split('/');
  const build = (oid: string | null, depth: number): string => {
    const entries: TreeEntry[] = oid ? parseTree(getObject(repo, oid)!.data) : [];
    const name = segments[depth];
    const existing = entries.findIndex((e) => e.name === name);
    if (depth === segments.length - 1) {
      const entry: TreeEntry = { mode, name, oid: blobOid };
      if (existing >= 0) entries[existing] = entry;
      else entries.push(entry);
    } else {
      const childOid = existing >= 0 && entries[existing].mode === '40000' ? entries[existing].oid : null;
      const entry: TreeEntry = { mode: '40000', name, oid: build(childOid, depth + 1) };
      if (existing >= 0) entries[existing] = entry;
      else entries.push(entry);
    }
    return storeObject(repo, 'tree', buildTree(entries));
  };
  return build(treeOid, 0);
}

/** Remove `path` from a tree, returning the new root tree id (empty subtrees are pruned). */
export function deleteTreePath(repo: RepoRec, treeOid: string, path: string): string {
  const segments = path.split('/');
  const build = (oid: string, depth: number): string | null => {
    const entries = parseTree(getObject(repo, oid)!.data);
    const name = segments[depth];
    const index = entries.findIndex((e) => e.name === name);
    if (index < 0) return oid;
    if (depth === segments.length - 1) {
      entries.splice(index, 1);
    } else {
      const child = build(entries[index].oid, depth + 1);
      if (child === null) entries.splice(index, 1);
      else entries[index] = { mode: '40000', name, oid: child };
    }
    if (entries.length === 0) return null;
    return storeObject(repo, 'tree', buildTree(entries));
  };
  return build(treeOid, 0) ?? storeObject(repo, 'tree', buildTree([]));
}

/** The tree id of a commit, or null when the commit is unknown. */
export function commitTree(repo: RepoRec, commitOid: string): string | null {
  const obj = getObject(repo, commitOid);
  if (!obj || obj.type !== 'commit') return null;
  return parseCommit(obj.data).tree;
}

// ---------------------------------------------------------------------------
// reachability

/** Every object reachable from the tips (commits, their trees and blobs, tags). */
export function reachable(repo: RepoRec, tips: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const obj = getObject(repo, oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const view = parseCommit(obj.data);
      stack.push(view.tree, ...view.parents);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) stack.push(entry.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return seen;
}

/** True when `ancestor` is `descendant` itself or one of its ancestors. */
export function isAncestor(repo: RepoRec, ancestor: string, descendant: string): boolean {
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length) {
    const oid = stack.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = getObject(repo, oid);
    if (obj?.type === 'commit') stack.push(...parseCommit(obj.data).parents);
  }
  return false;
}

/** A common ancestor of two commits (the first found by breadth order), or null. */
export function mergeBase(repo: RepoRec, a: string, b: string): string | null {
  const ancestorsOfA = new Set<string>();
  const stack = [a];
  while (stack.length) {
    const oid = stack.pop()!;
    if (ancestorsOfA.has(oid)) continue;
    const obj = getObject(repo, oid);
    if (obj?.type !== 'commit') continue;
    ancestorsOfA.add(oid);
    stack.push(...parseCommit(obj.data).parents);
  }
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsOfA.has(oid)) return oid;
    const obj = getObject(repo, oid);
    if (obj?.type === 'commit') queue.push(...parseCommit(obj.data).parents);
  }
  return null;
}

/**
 * Depth-limited object set for a shallow fetch: commits within `depth`
 * generations of the wants (want = generation 1), with their trees and
 * blobs. Returns the object set plus the boundary commits (included
 * commits at the depth limit that still have parents).
 */
export function shallowClosure(
  repo: RepoRec,
  wants: string[],
  depth: number,
  clientShallow: ReadonlySet<string>,
): { objects: Set<string>; boundary: Set<string> } {
  const generation = new Map<string, number>();
  const queue: Array<{ oid: string; gen: number }> = [];
  for (const want of wants) {
    const obj = getObject(repo, want);
    if (obj?.type === 'commit') queue.push({ oid: want, gen: 1 });
    else if (obj) generation.set(want, 0);
  }
  const boundary = new Set<string>();
  while (queue.length) {
    const { oid, gen } = queue.shift()!;
    if (generation.has(oid) && generation.get(oid)! <= gen) continue;
    generation.set(oid, gen);
    const obj = getObject(repo, oid);
    if (!obj || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (gen >= depth) {
      if (parents.length && !clientShallow.has(oid)) boundary.add(oid);
      continue;
    }
    for (const parent of parents) {
      if (clientShallow.has(parent) && parent !== oid) {
        // The client already holds this commit as a shallow boundary: it
        // counts as included at the next generation but is not expanded.
        if (!generation.has(parent)) generation.set(parent, gen + 1);
        continue;
      }
      queue.push({ oid: parent, gen: gen + 1 });
    }
  }
  const objects = new Set<string>();
  for (const [oid, gen] of generation) {
    if (gen > depth) continue;
    const obj = getObject(repo, oid);
    if (!obj) continue;
    objects.add(oid);
    if (obj.type === 'tag') {
      const target = parseTag(obj.data).object;
      if (!objects.has(target)) {
        objects.add(target);
        const targetObj = getObject(repo, target);
        if (targetObj?.type === 'commit' && !generation.has(target)) generation.set(target, 1);
      }
    }
  }
  // add trees and blobs of every included commit
  for (const oid of [...objects]) {
    const obj = getObject(repo, oid);
    if (obj?.type === 'commit') {
      const tree = parseCommit(obj.data).tree;
      for (const sub of reachable(repo, [tree])) objects.add(sub);
    }
  }
  return { objects, boundary };
}

// ---------------------------------------------------------------------------
// diffs

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  oldOid: string | null;
  newOid: string | null;
  additions: number;
  deletions: number;
}

/** Line-based change counts between two blob contents (LCS over lines). */
export function lineCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  // LCS via dynamic programming on trimmed sizes; scenario files are small.
  const m = a.length;
  const n = b.length;
  if (m * n > 4_000_000) {
    // very large: fall back to a set-based estimate
    const setA = new Set(a);
    const setB = new Set(b);
    return {
      additions: b.filter((l) => !setA.has(l)).length,
      deletions: a.filter((l) => !setB.has(l)).length,
    };
  }
  const dp = new Uint32Array((m + 1) * (n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i * (n + 1) + j] = a[i] === b[j] ? dp[(i + 1) * (n + 1) + j + 1] + 1 : Math.max(dp[(i + 1) * (n + 1) + j], dp[i * (n + 1) + j + 1]);
    }
  }
  const common = dp[0];
  return { additions: n - common, deletions: m - common };
}

/** The file changes between two trees (either may be null = empty). */
export function diffTrees(repo: RepoRec, fromTree: string | null, toTree: string | null): FileChange[] {
  const from = fromTree ? flattenTree(repo, fromTree) : new Map<string, { oid: string; mode: string }>();
  const to = toTree ? flattenTree(repo, toTree) : new Map<string, { oid: string; mode: string }>();
  const changes: FileChange[] = [];
  const paths = new Set([...from.keys(), ...to.keys()]);
  for (const path of [...paths].sort()) {
    const oldEntry = from.get(path);
    const newEntry = to.get(path);
    if (oldEntry && newEntry && oldEntry.oid === newEntry.oid) continue;
    const oldText = oldEntry ? (getObject(repo, oldEntry.oid)?.data.toString('utf8') ?? '') : '';
    const newText = newEntry ? (getObject(repo, newEntry.oid)?.data.toString('utf8') ?? '') : '';
    const counts = lineCounts(oldText, newText);
    changes.push({
      path,
      status: !oldEntry ? 'added' : !newEntry ? 'removed' : 'modified',
      oldOid: oldEntry?.oid ?? null,
      newOid: newEntry?.oid ?? null,
      additions: counts.additions,
      deletions: counts.deletions,
    });
  }
  return changes;
}

// ---------------------------------------------------------------------------
// pkt-line

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

export interface PktReader {
  /** The next packet: a Buffer payload, 'flush', 'delim', 'response-end', or null at end. */
  next(): Buffer | 'flush' | 'delim' | 'response-end' | null;
  /** The unconsumed remainder (a push's packfile follows the command flush). */
  rest(): Buffer;
}

export function pktReader(bytes: Buffer): PktReader {
  let offset = 0;
  return {
    next() {
      if (offset + 4 > bytes.length) return null;
      const header = bytes.subarray(offset, offset + 4).toString('ascii');
      if (!/^[0-9a-fA-F]{4}$/.test(header)) return null;
      const length = Number.parseInt(header, 16);
      if (length === 0) {
        offset += 4;
        return 'flush';
      }
      if (length === 1) {
        offset += 4;
        return 'delim';
      }
      if (length === 2) {
        offset += 4;
        return 'response-end';
      }
      if (length < 4 || offset + length > bytes.length) return null;
      const payload = bytes.subarray(offset + 4, offset + length);
      offset += length;
      return payload;
    },
    rest() {
      return bytes.subarray(offset);
    },
  };
}

// ---------------------------------------------------------------------------
// packfiles

/** A pack of the given objects, no deltas: header, zlib streams, SHA-1 trailer. */
export function writePack(objects: Array<{ oid: string; type: GitType; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    let size = obj.data.length;
    let first = (TYPE_CODE[obj.type] << 4) | (size & 0x0f);
    size >>= 4;
    const headBytes: number[] = [];
    if (size > 0) first |= 0x80;
    headBytes.push(first);
    while (size > 0) {
      let byte = size & 0x7f;
      size >>= 7;
      if (size > 0) byte |= 0x80;
      headBytes.push(byte);
    }
    parts.push(Buffer.from(headBytes));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/**
 * Inflate the zlib stream starting at `offset`, finding its exact end by
 * binary search: a proper prefix of a zlib stream never inflates, and the
 * full stream followed by the next object's bytes still inflates, so the
 * shortest inflating prefix is exactly the stream.
 */
function inflateAt(bytes: Buffer, offset: number): { data: Buffer; consumed: number } {
  const tail = bytes.subarray(offset);
  const inflates = (length: number): boolean => {
    try {
      inflateSync(tail.subarray(0, length));
      return true;
    } catch {
      return false;
    }
  };
  let lo = 1;
  let hi = tail.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (inflates(mid)) hi = mid;
    else lo = mid + 1;
  }
  return { data: inflateSync(tail.subarray(0, lo)), consumed: lo };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++];
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  readVarint(); // base size
  const targetSize = readVarint();
  const out: Buffer[] = [];
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i++) {
        if (op & (1 << i)) copyOffset |= delta[offset++] << (8 * i);
      }
      for (let i = 0; i < 3; i++) {
        if (op & (0x10 << i)) copySize |= delta[offset++] << (8 * i);
      }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
    } else if (op > 0) {
      out.push(delta.subarray(offset, offset + op));
      offset += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize) throw new Error('delta size mismatch');
  return result;
}

/**
 * Read a pack into the repo's store. Handles plain objects and OFS/REF
 * deltas. Returns the object ids written.
 */
export function readPackInto(repo: RepoRec, pack: Buffer): string[] {
  if (pack.length < 12 + 20 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const count = pack.readUInt32BE(8);
  let offset = 12;
  interface RawEntry {
    type: GitType | 'ofs-delta' | 'ref-delta';
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    start: number;
  }
  const entries: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry & { oid?: string }>();
  for (let i = 0; i < count; i++) {
    const start = offset;
    let byte = pack[offset++];
    const typeCode = (byte >> 4) & 0x07;
    while (byte & 0x80) {
      byte = pack[offset++];
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (typeCode === 6) {
      let back = pack[offset++];
      let value = back & 0x7f;
      while (back & 0x80) {
        back = pack[offset++];
        value = ((value + 1) << 7) | (back & 0x7f);
      }
      baseOffset = start - value;
    } else if (typeCode === 7) {
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const { data, consumed } = inflateAt(pack, offset);
    offset += consumed;
    const entry: RawEntry = {
      type: typeCode === 6 ? 'ofs-delta' : typeCode === 7 ? 'ref-delta' : CODE_TYPE[typeCode],
      data,
      baseOffset,
      baseOid,
      start,
    };
    entries.push(entry);
    byOffset.set(start, entry);
  }
  const written: string[] = [];
  const resolve = (entry: RawEntry & { oid?: string }): string => {
    if (entry.oid) return entry.oid;
    if (entry.type === 'ofs-delta' || entry.type === 'ref-delta') {
      let baseData: Buffer;
      let baseType: GitType;
      if (entry.type === 'ofs-delta') {
        const base = byOffset.get(entry.baseOffset!)!;
        const baseOid = resolve(base);
        const baseObj = getObject(repo, baseOid)!;
        baseData = baseObj.data;
        baseType = baseObj.type;
      } else {
        const baseObj = getObject(repo, entry.baseOid!);
        if (!baseObj) throw new Error('ref-delta base not present (thin pack unsupported)');
        baseData = baseObj.data;
        baseType = baseObj.type;
      }
      const data = applyDelta(baseData, entry.data);
      entry.oid = storeObject(repo, baseType, data);
    } else {
      entry.oid = storeObject(repo, entry.type, entry.data);
    }
    written.push(entry.oid);
    return entry.oid;
  };
  for (const entry of entries) resolve(entry);
  return written;
}

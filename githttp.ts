// The git smart-HTTP surface: reference advertisement, protocol v2 ls-refs
// and fetch, protocol v0 upload-pack, and receive-pack pushes.
//
// The shapes here follow the checks' client (git itself): v2 fetch answers
// in sections (acknowledgments / shallow-info / packfile) with the pack
// carried in sideband band 1; pushes answer with a report-status stream
// inside band 1 whose non-fast-forward reason is exactly that string.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER, getRepo, type RepoRec } from './store.ts';
import {
  PKT_DELIM,
  PKT_FLUSH,
  ZERO_OID,
  getObject,
  isAncestor,
  parseCommit,
  parseTag,
  pktLine,
  pktReader,
  reachable,
  readPackInto,
  shallowClosure,
  writePack,
  type GitType,
} from './gitobj.ts';

const AGENT = 'makefun-forge/1.0';

export interface GitContext {
  req: IncomingMessage;
  res: ServerResponse;
  /** Path segments: [owner, repo.git, ...tail] */
  segments: string[];
  query: URLSearchParams;
  rawBody: Buffer;
}

function sendBuffer(ctx: GitContext, status: number, body: Buffer, contentType: string): void {
  ctx.res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  ctx.res.end(body);
}

function sendText(ctx: GitContext, status: number, text: string): void {
  sendBuffer(ctx, status, Buffer.from(text, 'utf8'), 'text/plain; charset=utf-8');
}

/** Chunk a byte stream into sideband packets on the given band. */
function sideband(data: Buffer, band = 1, chunkSize = 32768): Buffer[] {
  const packets: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    const chunk = data.subarray(offset, Math.min(data.length, offset + chunkSize));
    packets.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  if (packets.length === 0) packets.push(pktLine(Buffer.concat([Buffer.from([band])])));
  return packets;
}

/**
 * Finished packs by closure, so a repeated fetch of the same object set
 * skips the deflate-and-hash rebuild. The key is exact, never hashed:
 * the repo's id, its live object count (any stored object changes it,
 * which retires every older key), and the closure's sorted object ids.
 * Object ids are content hashes, so one key can only ever name one set
 * of contents. The cache holds at most 32 packs and clears when full.
 */
const PACK_CACHE_LIMIT = 32;
const packCache = new Map<string, Buffer>();

function packBuffer(repo: RepoRec, objectIds: Iterable<string>): Buffer {
  const ids = [...objectIds];
  const key = `${repo.id}|${repo.objects.size}|${[...ids].sort().join(' ')}`;
  const hit = packCache.get(key);
  if (hit !== undefined) return hit;
  const objects: Array<{ oid: string; type: GitType; data: Buffer }> = [];
  for (const oid of ids) {
    const obj = getObject(repo, oid);
    if (obj) objects.push({ oid, type: obj.type, data: obj.data });
  }
  const pack = writePack(objects);
  if (packCache.size >= PACK_CACHE_LIMIT) packCache.clear();
  packCache.set(key, pack);
  return pack;
}

/** All refs as [name, oid], sorted by name, tags peeled where annotated. */
function sortedRefs(repo: RepoRec): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

function headTarget(repo: RepoRec): string {
  return `refs/heads/${repo.defaultBranch}`;
}

// ---------------------------------------------------------------------------
// advertisement

const UPLOAD_CAPS_V0 = [
  'side-band-64k',
  'ofs-delta',
  'shallow',
  'deepen-since',
  'deepen-not',
  'object-format=sha1',
  `agent=${AGENT}`,
].join(' ');

const RECEIVE_CAPS = ['report-status', 'delete-refs', 'side-band-64k', 'ofs-delta', 'object-format=sha1', `agent=${AGENT}`].join(
  ' ',
);

function wantsV2(ctx: GitContext): boolean {
  const header = ctx.req.headers['git-protocol'];
  return typeof header === 'string' && header.includes('version=2');
}

function advertise(ctx: GitContext, service: string): void {
  if (service === 'git-upload-pack' && wantsV2(ctx)) {
    const lines = [
      'version 2',
      `agent=${AGENT}`,
      'ls-refs=unborn',
      'fetch=shallow wait-for-done',
      'server-option',
      'object-format=sha1',
    ];
    const body = Buffer.concat([...lines.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);
    sendBuffer(ctx, 200, body, 'application/x-git-upload-pack-advertisement');
    return;
  }
  const repo = repoFromPath(ctx);
  if (!repo) return sendText(ctx, 404, 'repository not found');
  const caps = service === 'git-receive-pack' ? RECEIVE_CAPS : `${UPLOAD_CAPS_V0} symref=HEAD:${headTarget(repo)}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  const headOid = repo.refs.get(headTarget(repo)) ?? ZERO_OID;
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pktLine(`${headOid} HEAD\0${caps}\n`));
    for (const [name, oid] of refs) {
      parts.push(pktLine(`${oid} ${name}\n`));
      const obj = getObject(repo, oid);
      if (obj?.type === 'tag') {
        parts.push(pktLine(`${parseTag(obj.data).object} ${name}^{}\n`));
      }
    }
  }
  parts.push(PKT_FLUSH);
  sendBuffer(
    ctx,
    200,
    Buffer.concat(parts),
    service === 'git-receive-pack' ? 'application/x-git-receive-pack-advertisement' : 'application/x-git-upload-pack-advertisement',
  );
}

// ---------------------------------------------------------------------------
// protocol v2: ls-refs and fetch

interface V2Request {
  command: string;
  capabilities: string[];
  args: string[];
}

function parseV2(body: Buffer): V2Request | null {
  const reader = pktReader(body);
  const lines: string[] = [];
  let packet = reader.next();
  while (packet !== null && packet !== 'flush') {
    if (packet === 'delim') break;
    if (Buffer.isBuffer(packet)) lines.push(packet.toString('utf8').replace(/\n$/, ''));
    packet = reader.next();
  }
  const args: string[] = [];
  if (packet === 'delim') {
    packet = reader.next();
    while (packet !== null && packet !== 'flush') {
      if (Buffer.isBuffer(packet)) args.push(packet.toString('utf8').replace(/\n$/, ''));
      packet = reader.next();
    }
  }
  let command = '';
  const capabilities: string[] = [];
  for (const line of lines) {
    if (line.startsWith('command=')) command = line.slice('command='.length);
    else capabilities.push(line);
  }
  return { command, capabilities, args };
}

function lsRefs(ctx: GitContext, repo: RepoRec, request: V2Request): void {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of request.args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const lines: string[] = [];
  const target = headTarget(repo);
  const headOid = repo.refs.get(target);
  if (matches('HEAD') || prefixes.some((p) => 'HEAD'.startsWith(p))) {
    if (headOid) {
      lines.push(`${headOid} HEAD${symrefs ? ` symref-target:${target}` : ''}`);
    } else if (unborn) {
      lines.push(`${ZERO_OID} HEAD${symrefs ? ` symref-target:${target}` : ''} unborn`);
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!matches(name)) continue;
    let line = `${oid} ${name}`;
    if (peel) {
      const obj = getObject(repo, oid);
      if (obj?.type === 'tag') line += ` peeled:${parseTag(obj.data).object}`;
    }
    lines.push(line);
  }
  const body = Buffer.concat([...lines.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);
  sendBuffer(ctx, 200, body, 'application/x-git-upload-pack-result');
}

interface FetchPlan {
  objects: Set<string>;
  boundary: Set<string>;
  unshallow: Set<string>;
}

function planFetch(
  repo: RepoRec,
  wants: string[],
  haves: string[],
  clientShallow: Set<string>,
  deepen: number | null,
  deepenSince: number | null,
): FetchPlan {
  const unshallow = new Set<string>();
  if (deepen !== null) {
    const plan = shallowClosure(repo, wants, deepen, clientShallow);
    return { ...plan, unshallow };
  }
  if (deepenSince !== null) {
    // Include commits whose committer time is at or after the cutoff; the
    // first older parent marks the boundary.
    const included = new Set<string>();
    const boundary = new Set<string>();
    const queue = [...wants];
    while (queue.length) {
      const oid = queue.shift()!;
      if (included.has(oid)) continue;
      const obj = getObject(repo, oid);
      if (!obj) continue;
      included.add(oid);
      if (obj.type !== 'commit') continue;
      const view = parseCommit(obj.data);
      const epoch = Number(/(\d+) [+-]\d{4}$/.exec(view.committer)?.[1] ?? '0');
      for (const parent of view.parents) {
        const parentObj = getObject(repo, parent);
        if (!parentObj || parentObj.type !== 'commit') continue;
        const parentEpoch = Number(/(\d+) [+-]\d{4}$/.exec(parseCommit(parentObj.data).committer)?.[1] ?? '0');
        if (parentEpoch >= deepenSince) queue.push(parent);
        else if (!clientShallow.has(oid)) boundary.add(oid);
      }
    }
    const objects = new Set<string>();
    for (const oid of included) {
      objects.add(oid);
      const obj = getObject(repo, oid);
      if (obj?.type === 'commit') for (const sub of reachable(repo, [parseCommit(obj.data).tree])) objects.add(sub);
    }
    return { objects, boundary, unshallow };
  }
  const haveClosure = new Set<string>();
  for (const have of haves) for (const oid of reachable(repo, [have])) haveClosure.add(oid);
  for (const shallowOid of clientShallow) for (const oid of reachable(repo, [shallowOid])) haveClosure.add(oid);
  const objects = new Set<string>();
  for (const want of wants) {
    for (const oid of reachable(repo, [want])) {
      if (!haveClosure.has(oid)) objects.add(oid);
    }
  }
  // A client shallow commit that this fetch now covers in full is unshallowed.
  for (const shallowOid of clientShallow) {
    if (objects.has(shallowOid)) unshallow.add(shallowOid);
  }
  return { objects, boundary: new Set(), unshallow };
}

function fetchV2(ctx: GitContext, repo: RepoRec, request: V2Request): void {
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow = new Set<string>();
  let deepen: number | null = null;
  let deepenSince: number | null = null;
  let done = false;
  let waitForDone = false;
  for (const arg of request.args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) clientShallow.add(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) deepen = Number(arg.slice(7).trim()) || null;
    else if (arg.startsWith('deepen-since ')) deepenSince = Number(arg.slice(13).trim()) || null;
    else if (arg === 'done') done = true;
    else if (arg === 'wait-for-done') waitForDone = true;
  }
  const commonHaves = haves.filter((oid) => getObject(repo, oid)?.type === 'commit');
  const parts: Buffer[] = [];
  const acks: string[] = [];
  if (commonHaves.length) acks.push(...commonHaves.map((oid) => `ACK ${oid}`));
  else if (haves.length || waitForDone) acks.push('NAK');
  if (acks.length) {
    parts.push(pktLine('acknowledgments\n'), ...acks.map((line) => pktLine(`${line}\n`)));
  }
  if (waitForDone && !done) {
    parts.push(PKT_FLUSH);
    sendBuffer(ctx, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
    return;
  }
  if (acks.length) parts.push(PKT_DELIM);
  const plan = planFetch(repo, wants, haves, clientShallow, deepen, deepenSince);
  if (plan.boundary.size || plan.unshallow.size) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.boundary) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sideband(packBuffer(repo, plan.objects), 1));
  parts.push(PKT_FLUSH);
  sendBuffer(ctx, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

// ---------------------------------------------------------------------------
// protocol v0: upload-pack

function uploadPackV0(ctx: GitContext, repo: RepoRec): void {
  const reader = pktReader(ctx.rawBody);
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow = new Set<string>();
  let deepen: number | null = null;
  let deepenSince: number | null = null;
  let packet = reader.next();
  while (packet !== null && packet !== 'flush') {
    if (Buffer.isBuffer(packet)) {
      const line = packet.toString('utf8').replace(/\n$/, '');
      if (line.startsWith('want ')) wants.push(line.slice(5).trim().split(' ')[0]);
      else if (line.startsWith('shallow ')) clientShallow.add(line.slice(8).trim());
      else if (line.startsWith('deepen ')) deepen = Number(line.slice(7).trim()) || null;
      else if (line.startsWith('deepen-since ')) deepenSince = Number(line.slice(13).trim()) || null;
    }
    packet = reader.next();
  }
  packet = reader.next();
  while (packet !== null && packet !== 'flush') {
    if (Buffer.isBuffer(packet)) {
      const line = packet.toString('utf8').replace(/\n$/, '');
      if (line.startsWith('have ')) haves.push(line.slice(5).trim());
      if (line === 'done') break;
    }
    packet = reader.next();
  }
  const plan = planFetch(repo, wants, haves, clientShallow, deepen, deepenSince);
  const parts: Buffer[] = [];
  const common = haves.filter((oid) => getObject(repo, oid)?.type === 'commit');
  if (deepen !== null || deepenSince !== null) {
    for (const oid of plan.boundary) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  }
  parts.push(pktLine(common.length ? `ACK ${common[common.length - 1]}\n` : 'NAK\n'));
  parts.push(...sideband(packBuffer(repo, plan.objects), 1));
  parts.push(PKT_FLUSH);
  sendBuffer(ctx, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

// ---------------------------------------------------------------------------
// receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

async function receivePack(ctx: GitContext, repo: RepoRec): Promise<void> {
  const reader = pktReader(ctx.rawBody);
  const commands: PushCommand[] = [];
  let packet = reader.next();
  while (packet !== null && packet !== 'flush') {
    if (Buffer.isBuffer(packet)) {
      const line = packet.toString('utf8').replace(/\0[\s\S]*$/, '').replace(/\n$/, '');
      const [oldOid, newOid, ref] = line.split(' ');
      if (oldOid && newOid && ref) commands.push({ oldOid, newOid, ref });
    }
    packet = reader.next();
  }
  const pack = reader.rest();
  let unpackOk = true;
  if (pack.length >= 12 && pack.subarray(0, 4).toString('ascii') === 'PACK') {
    try {
      await readPackInto(repo, pack);
    } catch {
      unpackOk = false;
    }
  }
  const results: Array<{ ref: string; ok: boolean; reason?: string }> = [];
  for (const command of commands) {
    results.push(applyPush(repo, command, unpackOk));
  }
  const report: Buffer[] = [pktLine(unpackOk ? 'unpack ok\n' : 'unpack index-pack failed\n')];
  for (const result of results) {
    report.push(pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason ?? 'failed'}\n`));
  }
  report.push(PKT_FLUSH);
  const reportBytes = Buffer.concat(report);
  const body = Buffer.concat([...sideband(reportBytes, 1), PKT_FLUSH]);
  sendBuffer(ctx, 200, body, 'application/x-git-receive-pack-result');
}

function applyPush(repo: RepoRec, command: PushCommand, unpackOk: boolean): { ref: string; ok: boolean; reason?: string } {
  const { oldOid, newOid, ref } = command;
  const current = repo.refs.get(ref) ?? ZERO_OID;
  if (!unpackOk && newOid !== ZERO_OID) return { ref, ok: false, reason: 'unpack failed' };
  if (newOid === ZERO_OID) {
    // delete
    if (current === ZERO_OID) return { ref, ok: false, reason: 'reference does not exist' };
    if (ref === headTarget(repo)) return { ref, ok: false, reason: 'deletion of the current branch prohibited' };
    if (current !== oldOid) return { ref, ok: false, reason: 'stale info' };
    repo.refs.delete(ref);
    return { ref, ok: true };
  }
  const obj = getObject(repo, newOid);
  if (!obj) return { ref, ok: false, reason: 'missing object' };
  if (ref.startsWith('refs/heads/') && obj.type !== 'commit') return { ref, ok: false, reason: 'not a commit' };
  if (oldOid === ZERO_OID) {
    if (current !== ZERO_OID) return { ref, ok: false, reason: 'reference already exists' };
    repo.refs.set(ref, newOid);
    return { ref, ok: true };
  }
  if (current !== oldOid) return { ref, ok: false, reason: 'stale info' };
  if (current !== newOid && obj.type === 'commit' && !isAncestor(repo, current, newOid)) {
    return { ref, ok: false, reason: 'non-fast-forward' };
  }
  repo.refs.set(ref, newOid);
  return { ref, ok: true };
}

// ---------------------------------------------------------------------------
// routing

function repoFromPath(ctx: GitContext): RepoRec | null {
  const [owner, repoGit] = ctx.segments;
  if (owner !== VIEWER.login || !repoGit) return null;
  const name = repoGit.endsWith('.git') ? repoGit.slice(0, -4) : repoGit;
  return getRepo(owner, name) ?? null;
}

/** Handle one git smart-HTTP request; returns false when the path is not git. */
export async function handleGitHttp(ctx: GitContext): Promise<boolean> {
  const [owner, repoGit, ...tail] = ctx.segments;
  if (!owner || !repoGit || !repoGit.endsWith('.git')) return false;
  const repo = repoFromPath(ctx);
  if (!repo) {
    sendText(ctx, 404, 'repository not found');
    return true;
  }
  const tailPath = tail.join('/');
  if (ctx.req.method === 'GET' && tailPath === 'info/refs') {
    const service = ctx.query.get('service') ?? '';
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      sendText(ctx, 400, 'missing or unknown service');
      return true;
    }
    advertise(ctx, service);
    return true;
  }
  if (ctx.req.method === 'POST' && tailPath === 'git-upload-pack') {
    if (wantsV2(ctx)) {
      const request = parseV2(ctx.rawBody);
      if (!request) {
        sendText(ctx, 400, 'bad request');
        return true;
      }
      if (request.command === 'ls-refs') lsRefs(ctx, repo, request);
      else if (request.command === 'fetch') fetchV2(ctx, repo, request);
      else sendText(ctx, 400, `unknown command ${request.command}`);
      return true;
    }
    uploadPackV0(ctx, repo);
    return true;
  }
  if (ctx.req.method === 'POST' && tailPath === 'git-receive-pack') {
    await receivePack(ctx, repo);
    return true;
  }
  sendText(ctx, 404, 'not found');
  return true;
}

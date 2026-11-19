// The forge's in-memory store: users, repositories (with their git object
// stores and refs), labels, issues, pull requests and comments.
//
// Everything lives in Maps in this process — a trial is one process against
// a fresh store, and in-memory keeps the timed workloads fast. Time comes
// from a deterministic tick clock seeded by MAKEFUN_TRIAL_NOW (the only
// "now" a trial hands out), so two runs of the same trial stamp identical
// times: each tick advances one second from the base.

export interface GitObjectRec {
  type: 'commit' | 'tree' | 'blob' | 'tag';
  data: Buffer;
}

export interface UserRec {
  id: number;
  login: string;
  name: string;
  email: string;
}

export interface LabelRec {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface CommentRec {
  id: number;
  body: string;
  userLogin: string;
  createdAt: string;
  updatedAt: string;
}

export interface IssueRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  userLogin: string;
  comments: CommentRec[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  seq: number;
}

export interface PullRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  userLogin: string;
  createdAt: string;
  updatedAt: string;
  seq: number;
}

export interface RepoRec {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  objects: Map<string, GitObjectRec>;
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  nextNumber: number;
  createdAt: string;
  updatedAt: string;
  seq: number;
}

const baseMs = (() => {
  const fromEnv = process.env.MAKEFUN_TRIAL_NOW;
  const parsed = fromEnv ? Date.parse(fromEnv) : Number.NaN;
  return Number.isNaN(parsed) ? Date.parse('2025-02-10T08:19:57.000Z') : parsed;
})();

let tickCount = 0;

/** The next deterministic timestamp: ISO text and epoch seconds. */
export function tick(): { iso: string; epochSec: number } {
  tickCount += 1;
  const ms = baseMs + tickCount * 1000;
  return { iso: new Date(ms).toISOString(), epochSec: Math.floor(ms / 1000) };
}

/** The users the suite's scenario names: the token's owner, a teammate, a stranger. */
export const VIEWER: UserRec = { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid' };
export const USERS: readonly UserRec[] = [
  VIEWER,
  { id: 1001, login: 'quinnkeller', name: 'quinn keller', email: 'quinnkeller@example.invalid' },
  { id: 1002, login: 'olgabauer', name: 'olga bauer', email: 'olgabauer@example.invalid' },
];

export function userByLogin(login: string): UserRec | undefined {
  return USERS.find((u) => u.login === login);
}

let nextRepoId = 5000;
let nextLabelId = 1;
let nextIssueId = 1;
let nextCommentId = 1;
let repoSeq = 0;

export const repos = new Map<string, RepoRec>();

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function createRepo(owner: string, name: string, description: string, isPrivate: boolean): RepoRec {
  const now = tick();
  const repo: RepoRec = {
    id: nextRepoId++,
    owner,
    name,
    description,
    private: isPrivate,
    defaultBranch: 'main',
    objects: new Map(),
    refs: new Map(),
    labels: new Map(),
    issues: new Map(),
    pulls: new Map(),
    nextNumber: 1,
    createdAt: now.iso,
    updatedAt: now.iso,
    seq: repoSeq++,
  };
  repos.set(repoKey(owner, name), repo);
  return repo;
}

export function getRepo(owner: string, name: string): RepoRec | undefined {
  return repos.get(repoKey(owner, name));
}

export function deleteRepo(owner: string, name: string): boolean {
  return repos.delete(repoKey(owner, name));
}

export function viewerRepos(): RepoRec[] {
  return [...repos.values()].filter((r) => r.owner === VIEWER.login).sort((a, b) => a.seq - b.seq);
}

export function newLabelId(): number {
  return nextLabelId++;
}

export function newIssueId(): number {
  return nextIssueId++;
}

export function newCommentId(): number {
  return nextCommentId++;
}

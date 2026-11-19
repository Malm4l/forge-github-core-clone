// The REST v3 surface: repositories, branches, commits, contents, labels,
// issues, comments and pull requests, in GitHub's shapes and statuses.
//
// Every handler answers JSON with an X-GitHub-Request-Id header (added by
// the server wrapper in app.ts). A repository belongs to the token's login:
// the same name under another owner is a 404, never a 403.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  VIEWER,
  createRepo,
  deleteRepo,
  getRepo,
  newCommentId,
  newIssueId,
  newLabelId,
  repos,
  tick,
  userByLogin,
  viewerRepos,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './store.ts';
import {
  buildCommit,
  commitTree,
  deleteTreePath,
  diffTrees,
  flattenTree,
  getObject,
  hashObject,
  isAncestor,
  mergeBase,
  parseCommit,
  parseTree,
  setTreePath,
  storeObject,
} from './gitobj.ts';

export interface RestContext {
  req: IncomingMessage;
  res: ServerResponse;
  /** Path segments after /api/v3, decoded. */
  segments: string[];
  query: URLSearchParams;
  body: unknown;
  rawBody: Buffer;
  origin: string;
}

type Handler = (ctx: RestContext) => void;

function send(ctx: RestContext, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  ctx.res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    ...(text ? { 'content-length': Buffer.byteLength(text) } : {}),
    ...headers,
  });
  ctx.res.end(text);
}

export function notFound(ctx: RestContext): void {
  send(ctx, 404, { message: 'Not Found' });
}

function unprocessable(ctx: RestContext, message: string): void {
  send(ctx, 422, { message });
}

function bodyObject(ctx: RestContext): Record<string, unknown> {
  return typeof ctx.body === 'object' && ctx.body !== null && !Array.isArray(ctx.body)
    ? (ctx.body as Record<string, unknown>)
    : {};
}

// ---------------------------------------------------------------------------
// shapes

export function userJson(login: string): Record<string, unknown> {
  const user = userByLogin(login) ?? VIEWER;
  return {
    login: user.login,
    id: user.id,
    name: user.name,
    email: user.email,
    type: 'User',
    avatar_url: `https://avatars.githubusercontent.com/u/${user.id}?v=4`,
    html_url: `https://github.com/${user.login}`,
    url: `/api/v3/users/${user.login}`,
  };
}

export function repoJson(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: Buffer.from(`Repository:${repo.id}`).toString('base64'),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner),
    private: repo.private,
    description: repo.description,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function labelJson(repo: RepoRec, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return {
    id: label?.id ?? 0,
    node_id: Buffer.from(`Label:${repo.id}:${name}`).toString('base64'),
    name,
    color: label?.color ?? 'ededed',
    description: label?.description ?? null,
    default: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(name)}`,
  };
}

export function issueJson(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: Buffer.from(`Issue:${repo.id}:${issue.number}`).toString('base64'),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: userJson(issue.userLogin),
    assignees: [],
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

function refJson(repo: RepoRec, refName: string): { ref: string; sha: string; label: string; repo: Record<string, unknown> } {
  const sha = repo.refs.get(`refs/heads/${refName}`) ?? '';
  return {
    ref: refName,
    sha,
    label: `${repo.owner}:${refName}`,
    repo: repoJson(repo),
  };
}

export function pullJson(repo: RepoRec, pull: PullRec): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: Buffer.from(`PullRequest:${repo.id}:${pull.number}`).toString('base64'),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    draft: false,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: userJson(pull.userLogin),
    head: refJson(repo, pull.headRef),
    base: refJson(repo, pull.baseRef),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.mergedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function commitJson(repo: RepoRec, sha: string): Record<string, unknown> | null {
  const obj = getObject(repo, sha);
  if (!obj || obj.type !== 'commit') return null;
  const view = parseCommit(obj.data);
  const authorName = view.author.replace(/<[^>]*>.*$/, '').trim();
  const authorEmail = /<([^>]*)>/.exec(view.author)?.[1] ?? '';
  const committerName = view.committer.replace(/<[^>]*>.*$/, '').trim();
  const committerEmail = /<([^>]*)>/.exec(view.committer)?.[1] ?? '';
  const authorDate = /(\d+) [+-]\d{4}$/.exec(view.author)?.[1];
  const committerDate = /(\d+) [+-]\d{4}$/.exec(view.committer)?.[1];
  return {
    sha,
    node_id: Buffer.from(`Commit:${sha}`).toString('base64'),
    commit: {
      message: view.message.replace(/\n$/, ''),
      tree: { sha: view.tree, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${view.tree}` },
      author: {
        name: authorName,
        email: authorEmail,
        date: authorDate ? new Date(Number(authorDate) * 1000).toISOString() : repo.createdAt,
      },
      committer: {
        name: committerName,
        email: committerEmail,
        date: committerDate ? new Date(Number(committerDate) * 1000).toISOString() : repo.createdAt,
      },
      comment_count: 0,
    },
    parents: view.parents.map((parent) => ({ sha: parent, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${parent}` })),
    html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${sha}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
    author: userJson(VIEWER.login),
    committer: userJson(VIEWER.login),
  };
}

// ---------------------------------------------------------------------------
// shared helpers

/** Resolve {owner}/{repo} from the path segments; the repo must be the viewer's. */
function ownRepo(ctx: RestContext): RepoRec | null {
  const owner = ctx.segments[1];
  const name = ctx.segments[2];
  if (owner !== VIEWER.login || !name) return null;
  return getRepo(owner, name) ?? null;
}

function requireRepo(ctx: RestContext): RepoRec | null {
  const repo = ownRepo(ctx);
  if (!repo) notFound(ctx);
  return repo;
}

/** The commit a ref name (branch, tag or sha) resolves to; default: the default branch tip. */
export function resolveRef(repo: RepoRec, ref: string | null | undefined): string | null {
  if (ref === null || ref === undefined || ref === '') {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }
  const byBranch = repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`) ?? repo.refs.get(ref);
  if (byBranch) return byBranch;
  const obj = getObject(repo, ref);
  return obj ? ref : null;
}

/** Commits reachable from a tip, newest first (breadth order by ancestry). */
function listCommits(repo: RepoRec, tip: string): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    const obj = getObject(repo, oid);
    if (!obj || obj.type !== 'commit') continue;
    seen.add(oid);
    order.push(oid);
    queue.push(...parseCommit(obj.data).parents);
  }
  return order;
}

/** Create a commit on a branch from a new tree; returns the commit sha. */
export function commitOnBranch(
  repo: RepoRec,
  branch: string,
  tree: string,
  message: string,
  parents?: string[],
): string {
  const now = tick();
  const parent = parents ?? (repo.refs.get(`refs/heads/${branch}`) ? [repo.refs.get(`refs/heads/${branch}`)!] : []);
  const data = buildCommit({
    tree,
    parents: parent,
    author: `${VIEWER.name} <${VIEWER.email}>`,
    committer: `${VIEWER.name} <${VIEWER.email}>`,
    epochSec: now.epochSec,
    message,
  });
  const sha = storeObject(repo, 'commit', data);
  repo.refs.set(`refs/heads/${branch}`, sha);
  repo.updatedAt = now.iso;
  return sha;
}

interface Page<T> {
  items: T[];
  link: string | null;
}

function paginate<T>(ctx: RestContext, all: T[], pathForPage: (page: number) => string): Page<T> {
  const perPage = Math.min(100, Math.max(1, Number(ctx.query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(ctx.query.get('page') ?? '1') || 1);
  const start = (page - 1) * perPage;
  const items = all.slice(start, start + perPage);
  const links: string[] = [];
  if (start + perPage < all.length) {
    links.push(`<${ctx.origin}${pathForPage(page + 1)}>; rel="next"`);
    links.push(`<${ctx.origin}${pathForPage(Math.ceil(all.length / perPage))}>; rel="last"`);
  }
  if (page > 1) {
    links.push(`<${ctx.origin}${pathForPage(page - 1)}>; rel="prev"`);
    links.push(`<${ctx.origin}${pathForPage(1)}>; rel="first"`);
  }
  return { items, link: links.length ? links.join(', ') : null };
}

function pagePath(ctx: RestContext, page: number): string {
  const params = new URLSearchParams(ctx.query);
  params.set('page', String(page));
  const base = `/api/v3/${ctx.segments.map((s) => encodeURIComponent(s)).join('/')}`;
  return `${base}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// handlers: root, meta, user

const root: Handler = (ctx) => {
  send(
    ctx,
    200,
    {
      current_user_url: '/api/v3/user',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      issue_search_url: '/api/v3/search/issues?q={query}',
      rate_limit_url: '/api/v3/rate_limit',
    },
    { 'x-oauth-scopes': 'repo, read:org' },
  );
};

const meta: Handler = (ctx) => {
  send(ctx, 200, {
    installed_version: '1.0.0-makefun-forge',
    github_deployment: 'makefun-forge',
  });
};

const getUser: Handler = (ctx) => {
  send(ctx, 200, { ...userJson(VIEWER.login), plan: { name: 'free', space: 976562499, collaborators: 0, private_repos: 10000 } });
};

// ---------------------------------------------------------------------------
// handlers: repositories

const createRepoHandler: Handler = (ctx) => {
  const body = bodyObject(ctx);
  const name = typeof body.name === 'string' ? body.name : '';
  if (!name || !/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') {
    unprocessable(ctx, 'Repository creation failed: name is invalid');
    return;
  }
  if (getRepo(VIEWER.login, name)) {
    unprocessable(ctx, `Repository creation failed: name already exists on this account`);
    return;
  }
  const repo = createRepo(
    VIEWER.login,
    name,
    typeof body.description === 'string' ? body.description : '',
    typeof body.private === 'boolean' ? body.private : false,
  );
  send(ctx, 201, repoJson(repo));
};

const listUserRepos: Handler = (ctx) => {
  const all = viewerRepos();
  const { items, link } = paginate(ctx, all, (page) => pagePath(ctx, page));
  send(ctx, 200, items.map(repoJson), link ? { link } : {});
};

const getRepoHandler: Handler = (ctx) => {
  const repo = requireRepo(ctx);
  if (repo) send(ctx, 200, repoJson(repo));
};

const patchRepoHandler: Handler = (ctx) => {
  const repo = requireRepo(ctx);
  if (!repo) return;
  const body = bodyObject(ctx);
  if (typeof body.description === 'string') repo.description = body.description;
  if (typeof body.private === 'boolean') repo.private = body.private;
  if (typeof body.name === 'string' && body.name !== repo.name && !getRepo(repo.owner, body.name)) {
    repos.delete(`${repo.owner}/${repo.name}`);
    repo.name = body.name;
    repos.set(`${repo.owner}/${repo.name}`, repo);
  }
  repo.updatedAt = tick().iso;
  send(ctx, 200, repoJson(repo));
};

const deleteRepoHandler: Handler = (ctx) => {
  const repo = requireRepo(ctx);
  if (!repo) return;
  deleteRepo(repo.owner, repo.name);
  send(ctx, 204, undefined);
};

// ---------------------------------------------------------------------------
// handlers: branches, refs, commits

const listBranches: Handler = (ctx) => {
  const repo = requireRepo(ctx);
  if (!repo) return;
  const branches = [...repo.refs.entries()]
    .filter(([ref]) => ref.startsWith('refs/heads/'))
    .map(([ref, sha]) => ({
      name: ref.slice('refs/heads/'.length),
      commit: { sha, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}` },
      protected: false,
    }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  const { items, link } = paginate(ctx, branches, (page) => pagePath(ctx, page));
  send(ctx, 200, items, link ? { link } : {});
};

const getBranch: Handler = (ctx) => {
  const repo = requireRepo(ctx);
  if (!repo) return;
  const branch = ctx.segments.slice(4).join('/');
  const sha = repo.refs.get(`refs/heads/${branch}`);
  if (!sha) return notFound(ctx);
  send(ctx, 200, {
    name: branch,
    commit: commitJson(repo, sha) ?? { sha },
    protected: false,
  });
};

const createRef: Handler = (ctx) => {
  const repo = requireRepo(ctx);
  if (!repo) return;
  const body = bodyObject(ctx);
  const ref = typeof body.ref === 'string' ? body.ref : '';
  const sha = typeof body.sha === 'string' ? body.sha : '';
  if (!ref.startsWith('refs/') || !getObject(repo, sha)) {
    unprocessable(ctx, 'Invalid ref or sha');
    return;
  }
  repo.refs.set(ref, sha);
  send(ctx, 201, { ref, node_id: Buffer.from(`Ref:${repo.id}:${ref}`).toString('base64'), object: { sha, type: getObject(repo, sha)!.type } });
};

const getRef: Handler = (ctx) => {
  const repo = requireRepo(ctx);
  if (!repo) return;
  const ref = ctx.segments.slice(4).join('/');
  const sha = repo.refs.get(ref);
  if (!sha) return notFound(ctx);
  send(ctx, 200, { ref, object: { sha, type: getObject(repo, sha)?.type ?? 'commit' } });
};

const listCommitsHandler: Handler = (ctx) => {
  const repo = requireRepo(ctx);
  if (!repo) return;
  const tip = resolveRef(repo, ctx.query.get('sha'));
  if (!tip) {
    send(ctx, 200, []);
    return;
  }
  const shas = listCommits(repo, tip);
  const { items, link } = paginate(ctx, shas, (page) => pagePath(ctx, page));
  send(ctx, 200, items.map((sha) => commitJson(repo, sha)).filter(Boolean), link ? { link } : {});
};

const getCommitHandler: Handler = (ctx) => {
  const repo = requireRepo(ctx);
  if (!repo) return;
  const json = commitJson(repo, ctx.segments[4]);
  if (!json) return notFound(ctx);
  send(ctx, 200, json);
};

// ---------------------------------------------------------------------------
// handlers: contents

function contentsTarget(ctx: RestContext): { repo: RepoRec; path: string } | null {
  const repo = requireRepo(ctx);
  if (!repo) return null;
  return { repo, path: ctx.segments.slice(4).join('/') };
}

const getContents: Handler = (ctx) => {
  const target = contentsTarget(ctx);
  if (!target) return;
  const { repo, path } = target;
  const tip = resolveRef(repo, ctx.query.get('ref'));
  if (!tip) return notFound(ctx);
  const tree = commitTree(repo, tip);
  if (!tree) return notFound(ctx);
  const files = flattenTree(repo, tree);
  if (path === '') {
    return sendDir(ctx, repo, tree, '');
  }
  const entry = files.get(path);
  if (entry) {
    const blob = getObject(repo, entry.oid)!;
    send(ctx, 200, {
      type: 'file',
      encoding: 'base64',
      content: blob.data.toString('base64'),
      size: blob.data.length,
      name: path.split('/').pop(),
      path,
      sha: entry.oid,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
      html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
      download_url: `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${repo.defaultBranch}/${path}`,
    });
    return;
  }
  // directory?
  const prefix = `${path}/`;
  if ([...files.keys()].some((p) => p.startsWith(prefix))) {
    // find the subtree id
    let subtree: string | null = tree;
    for (const segment of path.split('/')) {
      if (!subtree) break;
      const obj = getObject(repo, subtree);
      if (!obj || obj.type !== 'tree') {
        subtree = null;
        break;
      }
      const found = parseTree(obj.data).find((e) => e.name === segment && e.mode === '40000');
      subtree = found ? found.oid : null;
    }
    if (subtree) return sendDir(ctx, repo, subtree, path);
  }
  notFound(ctx);
};

function sendDir(ctx: RestContext, repo: RepoRec, treeOid: string, basePath: string): void {
  const obj = getObject(repo, treeOid);
  if (!obj || obj.type !== 'tree') return notFound(ctx);
  const entries = parseTree(obj.data)
    .map((entry) => ({
      type: entry.mode === '40000' ? 'dir' : 'file',
      name: entry.name,
      path: basePath === '' ? entry.name : `${basePath}/${entry.name}`,
      sha: entry.oid,
      size: entry.mode === '40000' ? 0 : (getObject(repo, entry.oid)?.data.length ?? 0),
      url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${basePath === '' ? entry.name : `${basePath}/${entry.name}`}`,
      html_url: `https://github.com/${repo.owner}/${repo.name}/${entry.mode === '40000' ? 'tree' : 'blob'}/${repo.defaultBranch}/${basePath === '' ? entry.name : `${basePath}/${entry.name}`}`,
      download_url: null,
    }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  send(ctx, 200, entries);
}

const putContents: Handler = (ctx) => {
  const target = contentsTarget(ctx);
  if (!target) return;
  const { repo, path } = target;
  const body = bodyObject(ctx);
  const message = typeof body.message === 'string' ? body.message : 'Update file';
  const encoded = typeof body.content === 'string' ? body.content : '';
  const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
  const givenSha = typeof body.sha === 'string' ? body.sha : undefined;
  const data = Buffer.from(encoded.replace(/[\r\n\t ]+/g, ''), 'base64');

  const tip = repo.refs.get(`refs/heads/${branch}`) ?? null;
  const tree = tip ? commitTree(repo, tip) : null;
  const files = tree ? flattenTree(repo, tree) : new Map();
  const existing = files.get(path);

  if (existing) {
    if (givenSha === undefined) {
      unprocessable(ctx, 'Invalid request: "sha" wasn\'t supplied.');
      return;
    }
    if (givenSha !== existing.oid) {
      send(ctx, 409, { message: 'Conflict: the file has changed since the given sha' });
      return;
    }
  }
  const blobSha = storeObject(repo, 'blob', data);
  const newTree = setTreePath(repo, tree, path, blobSha);
  const commitSha = commitOnBranch(repo, branch, newTree, message);
  send(ctx, existing ? 200 : 201, {
    content: {
      type: 'file',
      encoding: 'base64',
      size: data.length,
      name: path.split('/').pop(),
      path,
      sha: blobSha,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
      html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${branch}/${path}`,
      download_url: `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${branch}/${path}`,
    },
    commit: { sha: commitSha, message, author: { name: VIEWER.name, email: VIEWER.email }, committer: { name: VIEWER.name, email: VIEWER.email } },
  });
};

const deleteContents: Handler = (ctx) => {
  const target = contentsTarget(ctx);
  if (!target) return;
  const { repo, path } = target;
  const body = bodyObject(ctx);
  const message = typeof body.message === 'string' ? body.message : 'Delete file';
  const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
  const givenSha = typeof body.sha === 'string' ? body.sha : undefined;
  const tip = repo.refs.get(`refs/heads/${branch}`) ?? null;
  const tree = tip ? commitTree(repo, tip) : null;
  const files = tree ? flattenTree(repo, tree) : new Map();
  const existing = files.get(path);
  if (!existing || !tree) return notFound(ctx);
  if (givenSha !== undefined && givenSha !== existing.oid) {
    send(ctx, 409, { message: 'Conflict: the file has changed since the given sha' });
    return;
  }
  const newTree = deleteTreePath(repo, tree, path);
  const commitSha = commitOnBranch(repo, branch, newTree, message);
  send(ctx, 200, { content: null, commit: { sha: commitSha, message } });
};

// ---------------------------------------------------------------------------
// handlers: labels

const createLabel: Handler = (ctx) => {
  const repo = requireRepo(ctx);
  if (!repo) return;
  const body = bodyObject(ctx);
  const name = typeof body.name === 'string' ? body.name : '';
  if (!name) return unprocessable(ctx, 'Validation failed: name is required');
  if (repo.labels.has(name)) return unprocessable(ctx, 'Validation failed: name has already been taken');
  repo.labels.set(name, {
    id: newLabelId(),
    name,
    color: typeof body.color === 'string' ? body.color.replace(/^#/, '') : 'ededed',
    description: typeof body.description === 'string' ? body.description : null,
  });
  send(ctx, 201, labelJson(repo, name));
};

const listLabels: Handler = (ctx) => {
  const repo = requireRepo(ctx);
  if (!repo) return;
  send(ctx, 200, [...repo.labels.keys()].map((name) => labelJson(repo, name)));
};

// ---------------------------------------------------------------------------
// handlers: issues and comments

export function createIssueRec(repo: RepoRec, input: { title: string; body: string; labels?: string[] }): IssueRec | { error: string } {
  const labels = input.labels ?? [];
  for (const name of labels) {
    if (!repo.labels.has(name)) return { error: `Label "${name}" does not exist` };
  }
  const now = tick();
  const number = repo.nextNumber++;
  const issue: IssueRec = {
    id: newIssueId(),
    number,
    title: input.title,
    body: input.body,
    state: 'open',
    labels: [...labels],
    userLogin: VIEWER.login,
    comments: [],
    createdAt: now.iso,
    updatedAt: now.iso,
    closedAt: null,
    seq: number,
  };
  repo.issues.set(issue.number, issue);
  return issue;
}

const createIssueHandler: Handler = (ctx) => {
  const repo = requireRepo(ctx);
  if (!repo) return;
  const body = bodyObject(ctx);
  const title = typeof body.title === 'string' ? body.title : '';
  if (!title) return unprocessable(ctx, 'Validation failed: title is required');
  const rawLabels = Array.isArray(body.labels) ? body.labels : [];
  const labels = rawLabels.map((l) => (typeof l === 'string' ? l : typeof (l as { name?: unknown })?.name === 'string' ? (l as { name: string }).name : '')).filter(Boolean);
  const made = createIssueRec(repo, { title, body: typeof body.body === 'string' ? body.body : '', labels });
  if ('error' in made) return unprocessable(ctx, made.error);
  send(ctx, 201, issueJson(repo, made));
};

const listIssuesHandler: Handler = (ctx) => {
  const repo = requireRepo(ctx);
  if (!repo) return;
  const state = ctx.query.get('state') ?? 'open';
  const direction = ctx.query.get('direction') ?? 'desc';
  let issues = [...repo.issues.values()];
  if (state === 'open' || state === 'closed') issues = issues.filter((i) => i.state === state);
  issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  const { items, link } = paginate(ctx, issues, (page) => pagePath(ctx, page));
  send(ctx, 200, items.map((i) => issueJson(repo, i)), link ? { link } : {});
};

function issueFromPath(ctx: RestContext, repo: RepoRec): IssueRec | null {
  const number = Number(ctx.segments[4]);
  return repo.issues.get(number) ?? null;
}

const getIssueHandler: Handler = (ctx) => {
  const repo = requireRepo(ctx);
  if (!repo) return;
  const issue = issueFromPath(ctx, repo);
  if (!issue) return notFound(ctx);
  send(ctx, 200, issueJson(repo, issue));
};

const patchIssueHandler: Handler = (ctx) => {
  const repo = requireRepo(ctx);
  if (!repo) return;
  const issue = issueFromPath(ctx, repo);
  if (!issue) return notFound(ctx);
  const body = bodyObject(ctx);
  if (typeof body.title === 'string') issue.title = body.title;
  if (typeof body.body === 'string') issue.body = body.body;
  if (body.state === 'open' || body.state === 'closed') {
    issue.state = body.state;
    issue.closedAt = body.state === 'closed' ? tick().iso : null;
  }
  if (Array.isArray(body.labels)) {
    const labels = body.labels.map((l) => (typeof l === 'string' ? l : '')).filter(Boolean);
    for (const name of labels) if (!repo.labels.has(name)) return unprocessable(ctx, `Label "${name}" does not exist`);
    issue.labels = labels;
  }
  issue.updatedAt = tick().iso;
  send(ctx, 200, issueJson(repo, issue));
};

const createCommentHandler: Handler = (ctx) => {
  const repo = requireRepo(ctx);
  if (!repo) return;
  const issue = issueFromPath(ctx, repo);
  if (!issue) return notFound(ctx);
  const body = bodyObject(ctx);
  const text = typeof body.body === 'string' ? body.body : '';
  if (!text) return unprocessable(ctx, 'Validation failed: body is required');
  const now = tick();
  const comment = { id: newCommentId(), body: text, userLogin: VIEWER.login, createdAt: now.iso, updatedAt: now.iso };
  issue.comments.push(comment);
  send(ctx, 201, commentJson(repo, issue, comment));
};

function commentJson(repo: RepoRec, issue: IssueRec, comment: IssueRec['comments'][number]): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: Buffer.from(`IssueComment:${comment.id}`).toString('base64'),
    body: comment.body,
    user: userJson(comment.userLogin),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    issue_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

const listCommentsHandler: Handler = (ctx) => {
  const repo = requireRepo(ctx);
  if (!repo) return;
  const issue = issueFromPath(ctx, repo);
  if (!issue) return notFound(ctx);
  send(ctx, 200, issue.comments.map((c) => commentJson(repo, issue, c)));
};

// ---------------------------------------------------------------------------
// handlers: pull requests

export function createPullRec(
  repo: RepoRec,
  input: { title: string; body: string; head: string; base: string },
): PullRec | { error: string; status: number } {
  const headSha = repo.refs.get(`refs/heads/${input.head}`);
  const baseSha = repo.refs.get(`refs/heads/${input.base}`);
  if (!headSha) return { error: `Head ref "${input.head}" does not exist`, status: 422 };
  if (!baseSha) return { error: `Base ref "${input.base}" does not exist`, status: 422 };
  for (const pull of repo.pulls.values()) {
    if (pull.state === 'open' && pull.headRef === input.head && pull.baseRef === input.base) {
      return { error: `A pull request already exists for ${input.head} into ${input.base}`, status: 422 };
    }
  }
  const now = tick();
  const number = repo.nextNumber++;
  const pull: PullRec = {
    id: newIssueId(),
    number,
    title: input.title,
    body: input.body,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef: input.head,
    baseRef: input.base,
    userLogin: VIEWER.login,
    createdAt: now.iso,
    updatedAt: now.iso,
    seq: number,
  };
  repo.pulls.set(pull.number, pull);
  return pull;
}

/** Simulate the merge of a pull; returns the merged tree or a conflict list. */
export function planMerge(repo: RepoRec, pull: PullRec): { tree: string } | { conflict: string[] } {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (!headSha || !baseSha) return { conflict: ['a ref is missing'] };
  const base = mergeBase(repo, headSha, baseSha) ?? baseSha;
  const baseTree = commitTree(repo, base);
  const headTree = commitTree(repo, headSha);
  const currentBaseTree = commitTree(repo, baseSha);
  if (!baseTree || !headTree || !currentBaseTree) return { conflict: ['a tree is missing'] };
  const headChanges = diffTrees(repo, baseTree, headTree);
  const baseChanges = diffTrees(repo, baseTree, currentBaseTree);
  const baseByPath = new Map(baseChanges.map((c) => [c.path, c]));
  const conflicts: string[] = [];
  for (const change of headChanges) {
    const other = baseByPath.get(change.path);
    if (other && other.newOid !== change.newOid) conflicts.push(change.path);
  }
  if (conflicts.length) return { conflict: conflicts };
  let tree = currentBaseTree;
  for (const change of headChanges) {
    if (change.newOid === null) tree = deleteTreePath(repo, tree, change.path);
    else tree = setTreePath(repo, tree, change.path, change.newOid);
  }
  return { tree };
}

/** Merge a pull request (squash by default); returns the merge commit sha or an error. */
export function mergePullRec(
  repo: RepoRec,
  pull: PullRec,
  method: string,
): { sha: string } | { error: string; status: number } {
  if (pull.state !== 'open') return { error: 'Pull Request is not mergeable: it is not open', status: 405 };
  const plan = planMerge(repo, pull);
  if ('conflict' in plan) return { error: `Pull Request is not mergeable: conflict in ${plan.conflict.join(', ')}`, status: 405 };
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`)!;
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`)!;
  let sha: string;
  if (method === 'merge') {
    sha = commitOnBranch(repo, pull.baseRef, plan.tree, `Merge pull request #${pull.number} from ${pull.headRef}`, [baseSha, headSha]);
  } else {
    sha = commitOnBranch(repo, pull.baseRef, plan.tree, `${pull.title} (#${pull.number})`, [baseSha]);
  }
  const now = tick();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = now.iso;
  pull.mergeCommitSha = sha;
  pull.updatedAt = now.iso;
  return { sha };
}

const createPullHandler: Handler = (ctx) => {
  const repo = requireRepo(ctx);
  if (!repo) return;
  const body = bodyObject(ctx);
  const title = typeof body.title === 'string' ? body.title : '';
  const head = typeof body.head === 'string' ? body.head.replace(/^[^:]+:/, '') : '';
  const base = typeof body.base === 'string' ? body.base : '';
  if (!title || !head || !base) return unprocessable(ctx, 'Validation failed: title, head and base are required');
  const made = createPullRec(repo, { title, body: typeof body.body === 'string' ? body.body : '', head, base });
  if ('error' in made) return send(ctx, made.status, { message: made.error });
  send(ctx, 201, pullJson(repo, made));
};

const listPullsHandler: Handler = (ctx) => {
  const repo = requireRepo(ctx);
  if (!repo) return;
  const state = ctx.query.get('state') ?? 'open';
  let pulls = [...repo.pulls.values()];
  if (state === 'open') pulls = pulls.filter((p) => p.state === 'open');
  else if (state === 'closed') pulls = pulls.filter((p) => p.state === 'closed');
  pulls.sort((a, b) => b.seq - a.seq);
  const { items, link } = paginate(ctx, pulls, (page) => pagePath(ctx, page));
  send(ctx, 200, items.map((p) => pullJson(repo, p)), link ? { link } : {});
};

function pullFromPath(ctx: RestContext, repo: RepoRec): PullRec | null {
  return repo.pulls.get(Number(ctx.segments[4])) ?? null;
}

const getPullHandler: Handler = (ctx) => {
  const repo = requireRepo(ctx);
  if (!repo) return;
  const pull = pullFromPath(ctx, repo);
  if (!pull) return notFound(ctx);
  send(ctx, 200, pullJson(repo, pull));
};

const pullFilesHandler: Handler = (ctx) => {
  const repo = requireRepo(ctx);
  if (!repo) return;
  const pull = pullFromPath(ctx, repo);
  if (!pull) return notFound(ctx);
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (!headSha || !baseSha) return send(ctx, 200, []);
  const base = mergeBase(repo, headSha, baseSha) ?? baseSha;
  const changes = diffTrees(repo, commitTree(repo, base), commitTree(repo, headSha));
  const files = changes.map((change) => ({
    filename: change.path,
    status: change.status === 'modified' ? 'modified' : change.status,
    additions: change.additions,
    deletions: change.deletions,
    changes: change.additions + change.deletions,
    sha: change.newOid ?? change.oldOid ?? '',
    blob_url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${change.path}`,
  }));
  const { items, link } = paginate(ctx, files, (page) => pagePath(ctx, page));
  send(ctx, 200, items, link ? { link } : {});
};

const mergePullHandler: Handler = (ctx) => {
  const repo = requireRepo(ctx);
  if (!repo) return;
  const pull = pullFromPath(ctx, repo);
  if (!pull) return notFound(ctx);
  const body = bodyObject(ctx);
  const method = typeof body.merge_method === 'string' ? body.merge_method : 'merge';
  const result = mergePullRec(repo, pull, method);
  if ('error' in result) return send(ctx, result.status, { message: result.error });
  send(ctx, 200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
};

// ---------------------------------------------------------------------------
// routing

const routes: Array<{ method: string; pattern: string[]; handler: Handler }> = [];

function route(method: string, pattern: string, handler: Handler): void {
  routes.push({ method, pattern: pattern === '' ? [] : pattern.split('/'), handler });
}

route('GET', '', root);
route('GET', 'meta', meta);
route('GET', 'user', getUser);
route('POST', 'user/repos', createRepoHandler);
route('GET', 'user/repos', listUserRepos);
route('GET', 'repos/:owner/:repo', getRepoHandler);
route('PATCH', 'repos/:owner/:repo', patchRepoHandler);
route('DELETE', 'repos/:owner/:repo', deleteRepoHandler);
route('GET', 'repos/:owner/:repo/branches', listBranches);
route('GET', 'repos/:owner/:repo/branches/**', getBranch);
route('POST', 'repos/:owner/:repo/git/refs', createRef);
route('GET', 'repos/:owner/:repo/git/refs/**', getRef);
route('GET', 'repos/:owner/:repo/commits', listCommitsHandler);
route('GET', 'repos/:owner/:repo/commits/:sha', getCommitHandler);
route('GET', 'repos/:owner/:repo/contents', getContents);
route('GET', 'repos/:owner/:repo/contents/**', getContents);
route('PUT', 'repos/:owner/:repo/contents/**', putContents);
route('DELETE', 'repos/:owner/:repo/contents/**', deleteContents);
route('POST', 'repos/:owner/:repo/labels', createLabel);
route('GET', 'repos/:owner/:repo/labels', listLabels);
route('POST', 'repos/:owner/:repo/issues', createIssueHandler);
route('GET', 'repos/:owner/:repo/issues', listIssuesHandler);
route('GET', 'repos/:owner/:repo/issues/:number', getIssueHandler);
route('PATCH', 'repos/:owner/:repo/issues/:number', patchIssueHandler);
route('POST', 'repos/:owner/:repo/issues/:number/comments', createCommentHandler);
route('GET', 'repos/:owner/:repo/issues/:number/comments', listCommentsHandler);
route('POST', 'repos/:owner/:repo/pulls', createPullHandler);
route('GET', 'repos/:owner/:repo/pulls', listPullsHandler);
route('GET', 'repos/:owner/:repo/pulls/:number', getPullHandler);
route('GET', 'repos/:owner/:repo/pulls/:number/files', pullFilesHandler);
route('PUT', 'repos/:owner/:repo/pulls/:number/merge', mergePullHandler);

function matchPattern(pattern: string[], segments: string[]): boolean {
  let i = 0;
  for (const part of pattern) {
    if (part === '**') return true;
    if (i >= segments.length) return false;
    if (part.startsWith(':')) {
      i++;
      continue;
    }
    if (part !== segments[i]) return false;
    i++;
  }
  return i === segments.length;
}

/** Handle one /api/v3 request; returns false when no route matched. */
export function handleRest(ctx: RestContext): boolean {
  for (const candidate of routes) {
    if (candidate.method !== ctx.req.method) continue;
    if (matchPattern(candidate.pattern, ctx.segments)) {
      candidate.handler(ctx);
      return true;
    }
  }
  return false;
}

// keep referenced helpers used by other modules visible
export { hashObject, isAncestor };

// The GraphQL v4 surface: a small parser and executor covering the
// documents gh sends — viewer, repository reads, issue/pull connections
// with cursor pagination, the five mutations, Relay node(id:) and the
// __type introspection probes — in GitHub's shapes.
//
// Global ids are base64 "Type:dbid" strings (issues and pull requests add
// their number), opaque and stable across reads. An unknown field is an
// HTTP 200 with an errors array naming the field, never a 400.

import { VIEWER, getRepo, newCommentId, tick, type IssueRec, type PullRec, type RepoRec } from './store.ts';
import { commitTree, diffTrees, mergeBase } from './gitobj.ts';
import { createIssueRec, createPullRec, mergePullRec, planMerge } from './rest.ts';

// ---------------------------------------------------------------------------
// tokenizer + parser

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'punct'; value: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (/\s|,/.test(ch)) {
      i++;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:$=!@|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i++;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        tokens.push({ kind: 'string', value: source.slice(i + 3, end === -1 ? source.length : end) });
        i = end === -1 ? source.length : end + 3;
        continue;
      }
      let value = '';
      i++;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          const esc = source[i + 1];
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          i += 2;
        } else {
          value += source[i];
          i++;
        }
      }
      i++;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(source.slice(i))!;
      const raw = match[0];
      tokens.push(raw.includes('.') || /[eE]/.test(raw) ? { kind: 'float', value: Number(raw) } : { kind: 'int', value: Number(raw) });
      i += raw.length;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      const match = /^[_A-Za-z][_0-9A-Za-z]*/.exec(source.slice(i))!;
      tokens.push({ kind: 'name', value: match[0] });
      i += match[0].length;
      continue;
    }
    i++;
  }
  return tokens;
}

type Value =
  | { kind: 'var'; name: string }
  | { kind: 'literal'; value: unknown }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Array<{ name: string; value: Value }> };

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Array<{ name: string; value: Value }>;
  selection: SelectionNode[] | null;
}

type SelectionNode =
  | FieldNode
  | { kind: 'inline'; typeCondition: string | null; selection: SelectionNode[] }
  | { kind: 'spread'; name: string };

interface Operation {
  type: 'query' | 'mutation';
  selection: SelectionNode[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, { typeCondition: string | null; selection: SelectionNode[] }>;
}

class Parser {
  private pos = 0;
  private tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  private next(): Token {
    const token = this.tokens[this.pos++];
    if (!token) throw new Error('unexpected end of document');
    return token;
  }
  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}`);
  }
  private atPunct(value: string): boolean {
    const token = this.peek();
    return token !== undefined && token.kind === 'punct' && token.value === value;
  }
  private name(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, { typeCondition: string | null; selection: SelectionNode[] }>();
    while (this.pos < this.tokens.length) {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', selection: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        const type = this.next().value as 'query' | 'mutation';
        if (this.peek()?.kind === 'name') this.next(); // operation name
        if (this.atPunct('(')) this.skipParens(); // variable definitions
        if (this.atPunct('@')) this.skipDirectives();
        operations.push({ type: type === 'mutation' ? 'mutation' : 'query', selection: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const fragName = this.name();
        if (this.peek()?.kind === 'name' && (this.peek() as { value: string }).value === 'on') this.next();
        const typeCondition = this.peek()?.kind === 'name' ? this.name() : null;
        if (this.atPunct('@')) this.skipDirectives();
        fragments.set(fragName, { typeCondition, selection: this.parseSelectionSet() });
        continue;
      }
      this.next();
    }
    return { operations, fragments };
  }

  private skipParens(): void {
    let depth = 0;
    do {
      const token = this.next();
      if (token.kind === 'punct' && token.value === '(') depth++;
      if (token.kind === 'punct' && token.value === ')') depth--;
    } while (depth > 0);
  }

  private skipDirectives(): void {
    while (this.atPunct('@')) {
      this.next();
      this.name();
      if (this.atPunct('(')) this.skipParens();
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.atPunct('}')) {
      if (this.atPunct('...')) {
        this.next();
        const token = this.peek();
        if (token?.kind === 'name' && token.value === 'on') {
          this.next();
          const typeCondition = this.name();
          if (this.atPunct('@')) this.skipDirectives();
          selections.push({ kind: 'inline', typeCondition, selection: this.parseSelectionSet() });
        } else if (token?.kind === 'name') {
          selections.push({ kind: 'spread', name: this.name() });
          if (this.atPunct('@')) this.skipDirectives();
        } else {
          selections.push({ kind: 'inline', typeCondition: null, selection: this.parseSelectionSet() });
        }
        continue;
      }
      let fieldName = this.name();
      let alias: string | null = null;
      if (this.atPunct(':')) {
        this.next();
        alias = fieldName;
        fieldName = this.name();
      }
      const args: FieldNode['args'] = [];
      if (this.atPunct('(')) {
        this.next();
        while (!this.atPunct(')')) {
          const argName = this.name();
          this.expectPunct(':');
          args.push({ name: argName, value: this.parseValue() });
        }
        this.next();
      }
      if (this.atPunct('@')) this.skipDirectives();
      const selection = this.atPunct('{') ? this.parseSelectionSet() : null;
      selections.push({ kind: 'field', name: fieldName, alias, args, selection });
    }
    this.next();
    return selections;
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'var', name: this.name() };
    if (token.kind === 'punct' && token.value === '[') {
      const items: Value[] = [];
      while (!this.atPunct(']')) items.push(this.parseValue());
      this.next();
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: Value }> = [];
      while (!this.atPunct('}')) {
        const fieldName = this.name();
        this.expectPunct(':');
        fields.push({ name: fieldName, value: this.parseValue() });
      }
      this.next();
      return { kind: 'object', fields };
    }
    if (token.kind === 'string' || token.kind === 'int' || token.kind === 'float') return { kind: 'literal', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'literal', value: true };
      if (token.value === 'false') return { kind: 'literal', value: false };
      if (token.value === 'null') return { kind: 'literal', value: null };
      return { kind: 'literal', value: token.value }; // enum
    }
    throw new Error('unexpected value token');
  }
}

function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'var':
      return variables[value.name];
    case 'literal':
      return value.value;
    case 'list':
      return value.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// global ids

export function globalId(type: string, ...parts: Array<string | number>): string {
  return Buffer.from([type, ...parts].join(':')).toString('base64');
}

function decodeGlobalId(id: string): { type: string; parts: string[] } | null {
  try {
    const decoded = Buffer.from(id, 'base64').toString('utf8');
    const [type, ...parts] = decoded.split(':');
    if (!type) return null;
    return { type, parts };
  } catch {
    return null;
  }
}

function repoByGlobalId(id: string): RepoRec | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.type !== 'Repository') return null;
  const numeric = Number(decoded.parts[0]);
  for (const repo of allRepos()) if (repo.id === numeric) return repo;
  return null;
}

import { repos } from './store.ts';
function allRepos(): RepoRec[] {
  return [...repos.values()];
}

// ---------------------------------------------------------------------------
// schema: the field lists introspection reports (superset of what gh probes)

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: [
    'id', 'number', 'title', 'state', 'body', 'author', 'labels', 'comments', 'createdAt', 'updatedAt', 'closedAt',
    'repository', 'url', 'stateReason',
  ],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'headRefName', 'baseRefName', 'mergeable',
    'files', 'author', 'createdAt', 'updatedAt', 'repository', 'url', 'isDraft', 'additions', 'deletions', 'changedFiles',
  ],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled',
    'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'createdAt', 'updatedAt', 'url',
    'viewerCanAdminister',
  ],
  User: ['id', 'login', 'name', 'email', 'url'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  Label: ['id', 'name', 'color', 'description'],
  Ref: ['id', 'name', 'target'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestChangedFileEdge: ['node', 'cursor'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'interfaces', 'ofType'],
  __Field: ['name', 'description', 'isDeprecated', 'deprecationReason', 'type', 'args'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __Schema: ['types', 'queryType', 'mutationType', 'directives'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'USER', 'REPOSITORY', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
};

// ---------------------------------------------------------------------------
// typed values

type GObj = Record<string, unknown> & { __typename: string };

function viewerObj(): GObj {
  return { __typename: 'User', id: globalId('User', VIEWER.id), login: VIEWER.login, name: VIEWER.name, email: VIEWER.email };
}

function repoObj(repo: RepoRec): GObj {
  return { __typename: 'Repository', repo };
}

function issueObj(repo: RepoRec, issue: IssueRec): GObj {
  return {
    __typename: 'Issue',
    repo,
    issue,
    id: globalId('Issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state.toUpperCase(),
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    closedAt: issue.closedAt,
    author: viewerObj(),
    url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullObj(repo: RepoRec, pull: PullRec): GObj {
  return {
    __typename: 'PullRequest',
    repo,
    pull,
    id: globalId('PullRequest', repo.id, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'MERGED' : pull.state.toUpperCase(),
    merged: pull.merged,
    mergedAt: pull.mergedAt,
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
    author: viewerObj(),
    url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    isDraft: false,
  };
}

function commentObj(repo: RepoRec, issue: IssueRec, comment: IssueRec['comments'][number]): GObj {
  return {
    __typename: 'IssueComment',
    id: globalId('IssueComment', comment.id),
    body: comment.body,
    author: viewerObj(),
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
  };
}

// ---------------------------------------------------------------------------
// connections

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`).toString('base64');
}

function indexFromCursor(after: unknown): number {
  if (typeof after !== 'string' || after === '') return 0;
  try {
    const decoded = Buffer.from(after, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(decoded);
    if (match) return Number(match[1]);
  } catch {
    /* fall through */
  }
  return 0;
}

interface ConnectionArgs {
  first?: number;
  after?: string;
}

function paginate<T>(items: T[], args: ConnectionArgs): { page: T[]; pageInfo: GObj; startIndex: number } {
  const start = indexFromCursor(args.after);
  const first = typeof args.first === 'number' && args.first >= 0 ? args.first : items.length;
  const page = items.slice(start, start + first);
  const hasNext = start + page.length < items.length;
  const pageInfo: GObj = {
    __typename: 'PageInfo',
    hasNextPage: hasNext,
    hasPreviousPage: start > 0,
    startCursor: page.length ? cursorFor(start + 1) : null,
    endCursor: page.length ? cursorFor(start + page.length) : null,
  };
  return { page, pageInfo, startIndex: start };
}

function connection(type: string, all: GObj[], args: ConnectionArgs): GObj {
  const { page, pageInfo, startIndex } = paginate(all, args);
  return {
    __typename: type,
    nodes: page,
    edges: page.map((node, i) => ({ __typename: `${type.replace('Connection', '')}Edge`, node, cursor: cursorFor(startIndex + i + 1) })),
    pageInfo,
    totalCount: all.length,
  };
}

// ---------------------------------------------------------------------------
// resolvers

interface Ctx {
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
  doc: Document;
}

type Resolver = (obj: GObj, args: Record<string, unknown>, ctx: Ctx) => unknown;

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => viewerObj(),
    repository: (_obj, args) => {
      const owner = String(args.owner ?? '');
      const name = String(args.name ?? '');
      if (owner !== VIEWER.login) return null;
      const repo = getRepo(owner, name);
      return repo ? repoObj(repo) : null;
    },
    node: (_obj, args) => {
      const decoded = decodeGlobalId(String(args.id ?? ''));
      if (!decoded) return null;
      if (decoded.type === 'Repository') {
        const repo = repoByGlobalId(String(args.id));
        return repo ? repoObj(repo) : null;
      }
      if (decoded.type === 'Issue') {
        const repo = repoByParts(decoded.parts);
        const issue = repo?.issues.get(Number(decoded.parts[1]));
        return repo && issue ? issueObj(repo, issue) : null;
      }
      if (decoded.type === 'PullRequest') {
        const repo = repoByParts(decoded.parts);
        const pull = repo?.pulls.get(Number(decoded.parts[1]));
        return repo && pull ? pullObj(repo, pull) : null;
      }
      if (decoded.type === 'User') return viewerObj();
      return null;
    },
    __type: (_obj, args) => typeObj(String(args.name ?? '')),
    __schema: () => ({ __typename: '__Schema', types: [] }),
  },
  Mutation: {
    createIssue: (_obj, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = typeof input.repositoryId === 'string' ? repoByGlobalId(input.repositoryId) : null;
      if (!repo) {
        ctx.errors.push({ message: 'repositoryId does not name a repository' });
        return null;
      }
      const made = createIssueRec(repo, {
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        labels: [],
      });
      if ('error' in made) {
        ctx.errors.push({ message: made.error });
        return null;
      }
      return { __typename: 'CreateIssuePayload', issue: issueObj(repo, made), clientMutationId: input.clientMutationId ?? null };
    },
    closeIssue: (_obj, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = findIssue(String(input.issueId ?? ''));
      if (!found) {
        ctx.errors.push({ message: 'issueId does not name an issue' });
        return null;
      }
      found.issue.state = 'closed';
      found.issue.closedAt = tick().iso;
      found.issue.updatedAt = tick().iso;
      return { __typename: 'CloseIssuePayload', issue: issueObj(found.repo, found.issue), clientMutationId: input.clientMutationId ?? null };
    },
    createPullRequest: (_obj, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = typeof input.repositoryId === 'string' ? repoByGlobalId(input.repositoryId) : null;
      if (!repo) {
        ctx.errors.push({ message: 'repositoryId does not name a repository' });
        return null;
      }
      const made = createPullRec(repo, {
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        head: String(input.headRefName ?? ''),
        base: String(input.baseRefName ?? ''),
      });
      if ('error' in made) {
        ctx.errors.push({ message: made.error });
        return null;
      }
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullObj(repo, made), clientMutationId: input.clientMutationId ?? null };
    },
    mergePullRequest: (_obj, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = findPull(String(input.pullRequestId ?? ''));
      if (!found) {
        ctx.errors.push({ message: 'pullRequestId does not name a pull request' });
        return null;
      }
      const method = String(input.mergeMethod ?? 'MERGE').toLowerCase();
      const result = mergePullRec(found.repo, found.pull, method === 'merge' ? 'merge' : 'squash');
      if ('error' in result) {
        ctx.errors.push({ message: result.error });
        return { __typename: 'MergePullRequestPayload', pullRequest: pullObj(found.repo, found.pull), clientMutationId: input.clientMutationId ?? null };
      }
      return { __typename: 'MergePullRequestPayload', pullRequest: pullObj(found.repo, found.pull), clientMutationId: input.clientMutationId ?? null };
    },
    addComment: (_obj, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = findIssue(String(input.subjectId ?? ''));
      if (!found) {
        ctx.errors.push({ message: 'subjectId does not name an issue' });
        return null;
      }
      const now = tick();
      const comment = {
        id: newCommentId(),
        body: String(input.body ?? ''),
        userLogin: VIEWER.login,
        createdAt: now.iso,
        updatedAt: now.iso,
      };
      found.issue.comments.push(comment);
      const node = commentObj(found.repo, found.issue, comment);
      return {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'IssueCommentEdge', node, cursor: cursorFor(found.issue.comments.length) },
        subject: issueObj(found.repo, found.issue),
        clientMutationId: input.clientMutationId ?? null,
      };
    },
  },
  Repository: {
    id: (obj) => globalId('Repository', (obj.repo as RepoRec).id),
    databaseId: (obj) => (obj.repo as RepoRec).id,
    name: (obj) => (obj.repo as RepoRec).name,
    nameWithOwner: (obj) => `${(obj.repo as RepoRec).owner}/${(obj.repo as RepoRec).name}`,
    owner: () => viewerObj(),
    description: (obj) => (obj.repo as RepoRec).description || null,
    isPrivate: (obj) => (obj.repo as RepoRec).private,
    createdAt: (obj) => (obj.repo as RepoRec).createdAt,
    updatedAt: (obj) => (obj.repo as RepoRec).updatedAt,
    url: (obj) => `https://github.com/${(obj.repo as RepoRec).owner}/${(obj.repo as RepoRec).name}`,
    viewerPermission: () => 'ADMIN',
    viewerCanAdminister: () => true,
    hasIssuesEnabled: () => true,
    defaultBranchRef: (obj) => {
      const repo = obj.repo as RepoRec;
      return { __typename: 'Ref', id: globalId('Ref', repo.id, `refs/heads/${repo.defaultBranch}`), name: repo.defaultBranch, prefix: 'refs/heads/' };
    },
    issue: (obj, args) => {
      const repo = obj.repo as RepoRec;
      const issue = repo.issues.get(Number(args.number));
      return issue ? issueObj(repo, issue) : null;
    },
    issues: (obj, args) => {
      const repo = obj.repo as RepoRec;
      let issues = [...repo.issues.values()];
      const states = Array.isArray(args.states) ? (args.states as string[]) : null;
      if (states && states.length) {
        const wanted = states.map((s) => s.toLowerCase());
        issues = issues.filter((issue) => wanted.includes(issue.state));
      }
      const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
      const direction = String(orderBy.direction ?? 'DESC').toUpperCase();
      issues.sort((a, b) => (direction === 'ASC' ? a.seq - b.seq : b.seq - a.seq));
      return connection('IssueConnection', issues.map((issue) => issueObj(repo, issue)), args as ConnectionArgs);
    },
    pullRequest: (obj, args) => {
      const repo = obj.repo as RepoRec;
      const pull = repo.pulls.get(Number(args.number));
      return pull ? pullObj(repo, pull) : null;
    },
    pullRequests: (obj, args) => {
      const repo = obj.repo as RepoRec;
      let pulls = [...repo.pulls.values()];
      const states = Array.isArray(args.states) ? (args.states as string[]) : null;
      if (states && states.length) {
        pulls = pulls.filter((pull) => {
          const state = pull.merged ? 'MERGED' : pull.state.toUpperCase();
          return states.includes(state) || (states.includes('CLOSED') && pull.state === 'closed');
        });
      } else {
        pulls = pulls.filter((pull) => pull.state === 'open');
      }
      pulls.sort((a, b) => b.seq - a.seq);
      return connection('PullRequestConnection', pulls.map((pull) => pullObj(repo, pull)), args as ConnectionArgs);
    },
  },
  Issue: {
    repository: (obj) => repoObj(obj.repo as RepoRec),
    labels: (obj) => {
      const repo = obj.repo as RepoRec;
      const issue = obj.issue as IssueRec;
      return {
        __typename: 'LabelConnection',
        nodes: issue.labels.map((name) => ({ __typename: 'Label', id: globalId('Label', repo.id, name), name, color: repo.labels.get(name)?.color ?? 'ededed', description: repo.labels.get(name)?.description ?? null })),
      };
    },
    comments: (obj, args) => {
      const repo = obj.repo as RepoRec;
      const issue = obj.issue as IssueRec;
      return connection('IssueCommentConnection', issue.comments.map((c) => commentObj(repo, issue, c)), args as ConnectionArgs);
    },
  },
  PullRequest: {
    repository: (obj) => repoObj(obj.repo as RepoRec),
    mergeable: (obj) => {
      const repo = obj.repo as RepoRec;
      const pull = obj.pull as PullRec;
      if (pull.state !== 'open') return 'UNKNOWN';
      const plan = planMerge(repo, pull);
      return 'conflict' in plan ? 'CONFLICTING' : 'MERGEABLE';
    },
    files: (obj, args) => {
      const repo = obj.repo as RepoRec;
      const pull = obj.pull as PullRec;
      const headSha = repo.refs.get(`refs/heads/${pull.headRef}`);
      const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`);
      let files: GObj[] = [];
      if (headSha && baseSha) {
        const base = mergeBase(repo, headSha, baseSha) ?? baseSha;
        const changes = diffTrees(repo, commitTree(repo, base), commitTree(repo, headSha));
        files = changes.map((change) => ({
          __typename: 'PullRequestChangedFile',
          path: change.path,
          additions: change.additions,
          deletions: change.deletions,
          changeType: change.status === 'added' ? 'ADDED' : change.status === 'removed' ? 'DELETED' : 'MODIFIED',
        }));
      }
      return connection('PullRequestChangedFileConnection', files, args as ConnectionArgs);
    },
    changedFiles: (obj) => {
      const repo = obj.repo as RepoRec;
      const pull = obj.pull as PullRec;
      const headSha = repo.refs.get(`refs/heads/${pull.headRef}`);
      const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`);
      if (!headSha || !baseSha) return 0;
      const base = mergeBase(repo, headSha, baseSha) ?? baseSha;
      return diffTrees(repo, commitTree(repo, base), commitTree(repo, headSha)).length;
    },
  },
};

function repoByParts(parts: string[]): RepoRec | null {
  const numeric = Number(parts[0]);
  for (const repo of allRepos()) if (repo.id === numeric) return repo;
  return null;
}

function findIssue(id: string): { repo: RepoRec; issue: IssueRec } | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.type !== 'Issue') return null;
  const repo = repoByParts(decoded.parts);
  const issue = repo?.issues.get(Number(decoded.parts[1]));
  return repo && issue ? { repo, issue } : null;
}

function findPull(id: string): { repo: RepoRec; pull: PullRec } | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.type !== 'PullRequest') return null;
  const repo = repoByParts(decoded.parts);
  const pull = repo?.pulls.get(Number(decoded.parts[1]));
  return repo && pull ? { repo, pull } : null;
}

function typeObj(name: string): GObj | null {
  if (ENUM_VALUES[name]) {
    return {
      __typename: '__Type',
      name,
      kind: 'ENUM',
      enumValues: ENUM_VALUES[name].map((value) => ({ __typename: '__EnumValue', name: value, isDeprecated: false })),
      fields: null,
    };
  }
  const fields = TYPE_FIELDS[name] ?? (RESOLVERS[name] ? Object.keys(RESOLVERS[name]) : null);
  if (!fields && !['Query', 'Mutation'].includes(name)) return null;
  const list = fields ?? [];
  return {
    __typename: '__Type',
    name,
    kind: 'OBJECT',
    fields: list.map((field) => ({ __typename: '__Field', name: field, isDeprecated: false })),
    enumValues: null,
  };
}

// ---------------------------------------------------------------------------
// executor

function knownFields(typeName: string): Set<string> {
  const fromResolvers = RESOLVERS[typeName] ? Object.keys(RESOLVERS[typeName]) : [];
  const fromSchema = TYPE_FIELDS[typeName] ?? [];
  return new Set([...fromResolvers, ...fromSchema]);
}

function executeSelection(obj: GObj | null, selection: SelectionNode[], ctx: Ctx): Record<string, unknown> | null {
  if (obj === null) return null;
  const out: Record<string, unknown> = {};
  const typeName = obj.__typename;
  const applySelections = (selections: SelectionNode[], target: GObj): void => {
    for (const node of selections) {
      if (node.kind === 'inline') {
        if (node.typeCondition === null || node.typeCondition === target.__typename) applySelections(node.selection, target);
        continue;
      }
      if (node.kind === 'spread') {
        const fragment = ctx.doc.fragments.get(node.name);
        if (fragment && (fragment.typeCondition === null || fragment.typeCondition === target.__typename)) {
          applySelections(fragment.selection, target);
        }
        continue;
      }
      const key = node.alias ?? node.name;
      if (node.name === '__typename') {
        out[key] = target.__typename;
        continue;
      }
      const args: Record<string, unknown> = {};
      for (const arg of node.args) args[arg.name] = resolveValue(arg.value, ctx.variables);
      const resolver = RESOLVERS[target.__typename]?.[node.name];
      let value: unknown;
      if (resolver) {
        value = resolver(target, args, ctx);
      } else if (knownFields(target.__typename).has(node.name)) {
        value = (target as Record<string, unknown>)[node.name] ?? null;
      } else {
        ctx.errors.push({ message: `Field '${node.name}' doesn't exist on type '${target.__typename}'` });
        continue;
      }
      out[key] = completeValue(value, node, ctx);
    }
  };
  applySelections(selection, obj);
  return out;
}

function completeValue(value: unknown, node: FieldNode, ctx: Ctx): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => completeValue(item, node, ctx));
  if (typeof value === 'object' && node.selection) {
    return executeSelection(value as GObj, node.selection, ctx);
  }
  return value;
}

/** Execute one GraphQL operation document; returns the response body object. */
export function executeGraphQL(query: string, variables: Record<string, unknown>): Record<string, unknown> {
  let doc: Document;
  try {
    doc = new Parser(tokenize(query)).parseDocument();
  } catch (error) {
    return { errors: [{ message: `Parse error: ${error instanceof Error ? error.message : String(error)}` }] };
  }
  const operation = doc.operations[0];
  if (!operation) return { errors: [{ message: 'No operation in document' }] };
  const ctx: Ctx = { variables, errors: [], doc };
  const root: GObj = { __typename: operation.type === 'mutation' ? 'Mutation' : 'Query' };
  const data = executeSelection(root, operation.selection, ctx);
  const body: Record<string, unknown> = { data };
  if (ctx.errors.length) body.errors = ctx.errors;
  return body;
}

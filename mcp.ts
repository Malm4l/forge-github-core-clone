// The MCP surface at POST /mcp: JSON-RPC for both protocol eras — the
// modern server/discover handshake and the legacy initialize handshake —
// with the six canonical GitHub tools over the same store as REST.
//
// tools/list is a fixed literal, byte-stable across calls. An unknown tool
// is a JSON-RPC -32602; a non-JSON body is HTTP 400 with -32700; a call
// missing required arguments answers isError: true.

import { VIEWER, createRepo, getRepo, type RepoRec } from './store.ts';
import { createIssueRec, createPullRec, issueJson, mergePullRec, pullJson, repoJson } from './rest.ts';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'makefun-forge', version: '1.0.0' };
const CAPABILITIES = { tools: { listChanged: false } };

interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function schema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    title: 'Create repository',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: schema(
      {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      ['name'],
    ),
  },
  {
    name: 'get_repo',
    title: 'Get repository',
    description: 'Read one repository by owner and name.',
    inputSchema: schema(
      {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      ['owner', 'repo'],
    ),
  },
  {
    name: 'create_issue',
    title: 'Create issue',
    description: 'Open a new issue in a repository.',
    inputSchema: schema(
      {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      ['owner', 'repo', 'title'],
    ),
  },
  {
    name: 'list_issues',
    title: 'List issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: schema(
      {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      ['owner', 'repo'],
    ),
  },
  {
    name: 'create_pull_request',
    title: 'Create pull request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: schema(
      {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      ['owner', 'repo', 'title', 'head', 'base'],
    ),
  },
  {
    name: 'merge_pull_request',
    title: 'Merge pull request',
    description: 'Merge a pull request by number (squash).',
    inputSchema: schema(
      {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      ['owner', 'repo', 'pull_number'],
    ),
  },
];

const TOOLS_LIST_JSON = JSON.stringify({ tools: TOOLS });

export interface McpReply {
  status: number;
  body: string | null;
}

function rpcResult(id: unknown, result: unknown): McpReply {
  return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result }) };
}

function rpcError(id: unknown, code: number, message: string, status = 200): McpReply {
  return { status, body: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }) };
}

function toolOk(payload: unknown): Record<string, unknown> {
  const text = JSON.stringify(payload, null, 2);
  return { content: [{ type: 'text', text }], structuredContent: payload as Record<string, unknown>, isError: false };
}

function toolFail(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function ownRepo(args: Record<string, unknown>): RepoRec | null {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const name = typeof args.repo === 'string' ? args.repo : typeof args.name === 'string' ? args.name : '';
  if (owner !== VIEWER.login || !name) return null;
  return getRepo(owner, name) ?? null;
}

function missingArgs(tool: ToolDef, args: Record<string, unknown>): string[] {
  const required = (tool.inputSchema.required as string[]) ?? [];
  return required.filter((name) => args[name] === undefined || args[name] === null || args[name] === '');
}

function callTool(name: string, args: Record<string, unknown>): McpReply | null {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return null;
  const missing = missingArgs(tool, args);
  if (missing.length) {
    return rpcResult(currentId, toolFail(`Missing required argument(s): ${missing.join(', ')}`));
  }
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      if (getRepo(VIEWER.login, repoName)) return rpcResult(currentId, toolFail(`Repository ${repoName} already exists`));
      const repo = createRepo(
        VIEWER.login,
        repoName,
        typeof args.description === 'string' ? args.description : '',
        typeof args.private === 'boolean' ? args.private : false,
      );
      return rpcResult(currentId, toolOk(repoJson(repo)));
    }
    case 'get_repo': {
      const repo = ownRepo(args);
      if (!repo) return rpcResult(currentId, toolFail('Repository not found'));
      return rpcResult(currentId, toolOk(repoJson(repo)));
    }
    case 'create_issue': {
      const repo = ownRepo(args);
      if (!repo) return rpcResult(currentId, toolFail('Repository not found'));
      const made = createIssueRec(repo, {
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        labels: [],
      });
      if ('error' in made) return rpcResult(currentId, toolFail(made.error));
      return rpcResult(currentId, toolOk(issueJson(repo, made)));
    }
    case 'list_issues': {
      const repo = ownRepo(args);
      if (!repo) return rpcResult(currentId, toolFail('Repository not found'));
      const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
      let issues = [...repo.issues.values()].sort((a, b) => b.seq - a.seq);
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      return rpcResult(currentId, toolOk({ issues: issues.map((issue) => issueJson(repo, issue)) }));
    }
    case 'create_pull_request': {
      const repo = ownRepo(args);
      if (!repo) return rpcResult(currentId, toolFail('Repository not found'));
      const made = createPullRec(repo, {
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        head: String(args.head),
        base: String(args.base),
      });
      if ('error' in made) return rpcResult(currentId, toolFail(made.error));
      return rpcResult(currentId, toolOk(pullJson(repo, made)));
    }
    case 'merge_pull_request': {
      const repo = ownRepo(args);
      if (!repo) return rpcResult(currentId, toolFail('Repository not found'));
      const pull = repo.pulls.get(Number(args.pull_number));
      if (!pull) return rpcResult(currentId, toolFail('Pull request not found'));
      const result = mergePullRec(repo, pull, 'squash');
      if ('error' in result) return rpcResult(currentId, toolFail(result.error));
      return rpcResult(currentId, toolOk(pullJson(repo, pull)));
    }
  }
  return rpcResult(currentId, toolFail(`Tool ${name} is not implemented`));
}

let currentId: unknown = null;

/** Handle one POST /mcp body (already authenticated by the caller). */
export function handleMcp(rawBody: Buffer): McpReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return rpcError(null, -32700, 'Parse error: the body is not valid JSON', 400);
  }
  if (Array.isArray(parsed)) {
    const replies: string[] = [];
    for (const entry of parsed) {
      const reply = handleOne(entry);
      if (reply) replies.push(reply);
    }
    return { status: 200, body: replies.length ? `[${replies.join(',')}]` : null };
  }
  const reply = handleOne(parsed);
  if (reply === null) return { status: 202, body: null };
  try {
    const body = JSON.parse(reply) as { error?: { code: number }; id?: unknown };
    if (body.error) return { status: 200, body: reply };
  } catch {
    /* fall through */
  }
  return { status: 200, body: reply };
}

function handleOne(entry: unknown): string | null {
  if (typeof entry !== 'object' || entry === null) {
    return JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } });
  }
  const request = entry as Record<string, unknown>;
  const method = typeof request.method === 'string' ? request.method : '';
  const id = request.id;
  const isNotification = id === undefined;
  currentId = id ?? null;

  const respond = (reply: McpReply): string | null => (isNotification ? null : reply.body);

  switch (method) {
    case 'server/discover':
      return respond(
        rpcResult(id, {
          supportedVersions: SUPPORTED_VERSIONS,
          serverInfo: SERVER_INFO,
          capabilities: CAPABILITIES,
          protocolVersion: SUPPORTED_VERSIONS[0],
          _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
        }),
      );
    case 'initialize': {
      const params = (request.params ?? {}) as Record<string, unknown>;
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : SUPPORTED_VERSIONS[1];
      const version = SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[1];
      return respond(rpcResult(id, { protocolVersion: version, serverInfo: SERVER_INFO, capabilities: CAPABILITIES }));
    }
    case 'ping':
      return respond(rpcResult(id, {}));
    case 'tools/list':
      return respond({ status: 200, body: `{"jsonrpc":"2.0","id":${JSON.stringify(id ?? null)},"result":${TOOLS_LIST_JSON}}` });
    case 'tools/call': {
      const params = (request.params ?? {}) as Record<string, unknown>;
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      const reply = callTool(name, args);
      if (!reply) return respond(rpcError(id, -32602, `Unknown tool: ${name}`));
      return respond(reply);
    }
    case 'resources/list':
      return respond(rpcResult(id, { resources: [] }));
    case 'prompts/list':
      return respond(rpcResult(id, { prompts: [] }));
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;
    default:
      if (isNotification) return null;
      return respond(rpcError(id, -32601, `Method not found: ${method}`));
  }
}

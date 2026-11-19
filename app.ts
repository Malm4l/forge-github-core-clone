// The forge's HTTP server: one process answering the REST v3 surface, the
// GraphQL endpoint, the MCP endpoint and the git smart-HTTP protocol over
// a single in-memory store.
//
// Every surface but /healthz requires the trial's bearer token
// (MAKEFUN_SHOP_TOKEN); every reply carries an X-GitHub-Request-Id.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleRest, type RestContext } from './rest.ts';
import { handleGitHttp, type GitContext } from './githttp.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

let requestCounter = 0;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function authorized(req: IncomingMessage): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected === '') return true;
  const header = req.headers.authorization ?? '';
  if (header === `Bearer ${expected}`) return true;
  if (header.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
      const [user, pass] = decoded.split(/:(.*)/s).length ? [decoded.slice(0, decoded.indexOf(':')), decoded.slice(decoded.indexOf(':') + 1)] : ['', ''];
      if (user === expected || pass === expected) return true;
    } catch {
      /* fall through */
    }
  }
  return false;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    ...(text ? { 'content-length': Buffer.byteLength(text) } : {}),
  });
  res.end(text);
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  requestCounter += 1;
  res.setHeader('x-github-request-id', `forge-${requestCounter.toString(36)}-${Date.now().toString(36)}`);
  const url = new URL(req.url ?? '/', 'http://forge.invalid');
  const pathname = url.pathname;
  const origin = `http://${req.headers.host ?? 'localhost'}`;

  if (req.method === 'GET' && pathname === '/healthz') {
    sendJson(res, 200, { status: 'ok' });
    return;
  }

  const rawBody = req.method === 'GET' || req.method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);

  if (!authorized(req)) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return;
  }

  if (pathname === '/api/graphql') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { message: 'Method not allowed' });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody.toString('utf8'));
    } catch {
      sendJson(res, 400, { errors: [{ message: 'The request body is not valid JSON' }] });
      return;
    }
    if (Array.isArray(parsed)) {
      const results = parsed.map((entry) => {
        const item = (entry ?? {}) as { query?: unknown; variables?: unknown };
        return executeGraphQL(String(item.query ?? ''), (item.variables ?? {}) as Record<string, unknown>);
      });
      sendJson(res, 200, results);
      return;
    }
    const item = (parsed ?? {}) as { query?: unknown; variables?: unknown };
    sendJson(res, 200, executeGraphQL(String(item.query ?? ''), (item.variables ?? {}) as Record<string, unknown>));
    return;
  }

  if (pathname === '/mcp') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { message: 'Method not allowed' });
      return;
    }
    const reply = handleMcp(rawBody);
    if (reply.body === null) {
      res.writeHead(reply.status, { 'content-length': 0 });
      res.end();
      return;
    }
    res.writeHead(reply.status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(reply.body) });
    res.end(reply.body);
    return;
  }

  if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
    const segments = pathname
      .slice('/api/v3'.length)
      .split('/')
      .filter((segment) => segment !== '')
      .map(decodeSegment);
    let body: unknown = undefined;
    if (rawBody.length) {
      try {
        body = JSON.parse(rawBody.toString('utf8'));
      } catch {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
    }
    const ctx: RestContext = { req, res, segments, query: url.searchParams, body, rawBody, origin };
    if (!handleRest(ctx)) sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  const segments = pathname.split('/').filter((segment) => segment !== '').map(decodeSegment);
  const gitCtx: GitContext = { req, res, segments, query: url.searchParams, rawBody };
  if (await handleGitHttp(gitCtx)) return;

  sendJson(res, 404, { message: 'Not Found' });
}

/** Build the forge's HTTP server (not yet listening). */
export function createApp(): Server {
  return createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) sendJson(res, 500, { message: `Internal error: ${error instanceof Error ? error.message : String(error)}` });
      else res.end();
    });
  });
}

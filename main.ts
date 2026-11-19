// Forge's entrypoint: the half of the program that faces the harness.
// The env that runs a trial owns the schedule — it waits for this process
// to announce the port it bound, drives its checks against the server,
// and in the end flips a flag saying the trial is over. Our side of that
// bargain: learn the env's origin from MAKEFUN_ENV_URL (with no origin
// there is nobody to announce to, so fail at once); build the app and
// bind a port the kernel picks; POST the bound port to /register; poll
// /done until the env calls the trial; then close up and exit 0. Leaving
// early would cut the trial short, so no step below gives up: a failed
// or slow call is retried with a growing pause instead.

import { createApp } from './app.ts';

/** One env request may hang this long before we abandon and retry it. */
const REQUEST_DEADLINE_MS = 30_000;
/** The pause before the first retry, and the longest pause we take. */
const RETRY_FLOOR_MS = 250;
const RETRY_CEILING_MS = 4_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One call to the env: the response, or null when it failed or timed out. */
async function callEnv(url: string, init: { method: string; body?: string }): Promise<Response | null> {
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), REQUEST_DEADLINE_MS);
  try {
    return await fetch(url, {
      method: init.method,
      body: init.body,
      headers: init.body === undefined ? undefined : { 'content-type': 'application/json' },
      signal: control.signal,
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function run(): Promise<void> {
  const origin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
  if (origin === '') {
    process.stderr.write('[forge] MAKEFUN_ENV_URL is empty: no env to register with\n');
    process.exit(1);
  }

  const server = createApp();
  await new Promise<void>((resolve) => {
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    process.stderr.write('[forge] the server did not bind a TCP port\n');
    process.exit(1);
  }

  // Announce the port. The first registration the env accepts stands; a
  // 409 says someone else announced first, which settles it just as well.
  let pauseMs = RETRY_FLOOR_MS;
  for (;;) {
    const reply = await callEnv(`${origin}/register`, {
      method: 'POST',
      body: JSON.stringify({ port: bound.port }),
    });
    if (reply !== null && (reply.ok || reply.status === 409)) break;
    await sleep(pauseMs);
    pauseMs = Math.min(pauseMs * 2, RETRY_CEILING_MS);
  }

  // Polls answer at once, so the pause is ours: short after a clean
  // answer, growing while the env is unreachable.
  pauseMs = RETRY_FLOOR_MS;
  for (;;) {
    const reply = await callEnv(`${origin}/done`, { method: 'GET' });
    if (reply !== null && reply.ok) {
      const report: unknown = await reply.json().catch(() => null);
      if (typeof report === 'object' && report !== null && (report as { done?: unknown }).done === true) break;
      pauseMs = RETRY_FLOOR_MS;
    } else {
      pauseMs = Math.min(pauseMs * 2, RETRY_CEILING_MS);
    }
    await sleep(pauseMs);
  }

  server.closeIdleConnections();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  process.exit(0);
}

void run();

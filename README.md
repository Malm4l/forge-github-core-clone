# Forge — a GitHub core clone for make.fun

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Malm4l/forge-github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Malm4l/forge-github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

Built for the [make.fun “Build a GitHub-compatible git forge” bounty](https://make.fun/bounty/github-core-clone-01).


A single-process, in-memory implementation of the GitHub core surfaces,
built for the make.fun `github-core-clone-01` bounty. One Node process
(Node 22+, standard library only) serves four surfaces over one store:

- **REST v3** under `/api/v3` — repositories, branches, git refs, commits,
  contents (read/write/delete with sha checks), labels, issues, comments
  and pull requests (create, list, files, squash/merge with real
  three-way conflict detection over the git object graph).
- **Git smart HTTP** — protocol v2 (`ls-refs`, `fetch` with shallow/deepen
  and wait-for-done negotiation) and protocol v0 upload-pack, plus
  receive-pack pushes with report-status. Objects are real SHA-1 git
  objects; packs are written and read (including delta resolution) in
  `gitobj.ts`.
- **GraphQL v4** at `/api/graphql` — a small parser/executor covering
  viewer and repository reads, issue/pull-request connections with cursor
  pagination, the createIssue/closeIssue/createPullRequest/
  mergePullRequest/addComment mutations, Relay `node(id:)` with opaque
  base64 global ids, operation batching, and the `__type` introspection
  probes `gh` feature-detects with.
- **MCP** at `/mcp` — JSON-RPC for both protocol eras (`server/discover`
  and `initialize`), with the six canonical tools (`create_repo`,
  `get_repo`, `create_issue`, `list_issues`, `create_pull_request`,
  `merge_pull_request`) over the same store.

## Layout

- `main.ts` — the entry↔env lifecycle (register the bound port with
  `$MAKEFUN_ENV_URL`, poll `/done`, exit 0). Provided by the kit, kept
  as-is.
- `app.ts` — the HTTP server: auth (the trial's bearer credential from
  `MAKEFUN_SHOP_TOKEN`), request ids, and routing between the surfaces.
- `store.ts` — users, repositories and their records, plus the
  deterministic tick clock seeded by `MAKEFUN_TRIAL_NOW`.
- `gitobj.ts` — git objects, trees, packs, pkt-lines, diffs.
- `rest.ts`, `githttp.ts`, `graphql.ts`, `mcp.ts` — the four surfaces.

State is deliberately per-process and in-memory: a trial is one process
lifetime, and every surface observes the same objects, so an issue made
over GraphQL is the issue REST lists, and a branch pushed over git is
the branch a pull request merges.

## Running

The harness runs `node main.ts` with `MAKEFUN_ENV_URL`,
`MAKEFUN_SHOP_TOKEN` and `MAKEFUN_TRIAL_NOW` set. `GET /healthz` is the
only unauthenticated route.

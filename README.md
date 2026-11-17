# github-core-clone-01

[![github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/oraybora-source/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/oraybora-source/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A standalone GitHub-compatible git forge, built for the [make.fun bounty github-core-clone-01](https://make.fun/bounty/github-core-clone-01). One process, Node 22, standard library only — no dependencies, no git binary at runtime, no external services.

## What it serves

- **git smart HTTP** — clone and push over `/{owner}/{repo}.git` (upload-pack protocol v2 and v0, receive-pack v0), with a packfile codec written from scratch: SHA-1 objects, zlib, thin packs, ofs-delta and ref-delta resolution, sideband framing, shallow fetch and deepen.
- **REST v3** — repositories, branches, commits, contents, labels, issues, comments and pull requests under `/api/v3`, with pagination, request ids, and JSON errors.
- **GraphQL** — the query and mutation shapes `gh` and `github-mcp-server` send: viewer, repository, issues, pull requests, introspection, node ids, cursor pagination, and operation batching.
- **MCP** — `server/discover` (revision 2026-07-28) and the legacy `initialize` handshake, with six tools: `create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`.
- **In-memory store** — git objects, issues and pull requests, with a deterministic state export (no timestamps, no ports, no random ids), so two runs on the same instance agree byte for byte.

## Run it

```sh
node --experimental-strip-types main.ts
```

The server binds an ephemeral port, registers it with the suite at `$MAKEFUN_ENV_URL/register`, polls `$MAKEFUN_ENV_URL/done`, and exits 0 when the trial is done. The bearer token comes from `MAKEFUN_SHOP_TOKEN`.

## Layout

| File | What it does |
| --- | --- |
| `main.ts` | Entry point: the register / poll / exit lifecycle. |
| `server.js` | The HTTP server and routing. |
| `pack.js` | Packfile, delta, zlib and pkt-line codec. |
| `objects.js` | Git objects: trees, commits, tags, the object store. |
| `smart-http.js` | Ref advertisements, upload-pack, receive-pack. |
| `store.js` | Repositories, issues, pull requests, deterministic export. |
| `rest.js` | The REST v3 API. |
| `graphql.js` | The GraphQL executor. |
| `mcp.js` | The MCP endpoint and tools. |

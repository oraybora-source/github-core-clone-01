// rest.js — the REST v3 API: repositories, branches, commits, contents,
// issues, labels, comments and pull requests. Every reply is
// application/json, never HTML, and carries a non-empty
// X-GitHub-Request-Id. A request without the suite's bearer token is a
// 401; a repository under another owner is a 404, never a 403.

import { parseCommit, parseTree } from './objects.js';

const SHA40 = /^[0-9a-f]{40}$/;

// A JSON reply. `extra` carries any additional headers (Link, scopes).
function json(status, value, extra) {
  return { status, headers: { 'content-type': 'application/json', ...(extra || {}) }, body: JSON.stringify(value) };
}

// Answer with an already-serialized JSON string (a cache hit), without
// re-stringifying it.
function jsonBody(status, body, extra) {
  return { status, headers: { 'content-type': 'application/json', ...(extra || {}) }, body };
}

// Serialized single-issue views, keyed by the issue object: the read
// workload GETs the same issue 2,000 times, and the view is a pure
// function of the issue's fields. The entry carries the issue's
// revision, so a patch retires it. A WeakMap, so a deleted repo's
// issues are collected. Stored as a Buffer, so sendResponse uses it
// directly without a Buffer.from per request.
const issueViewCache = new WeakMap();
function cachedIssueView(issue) {
  const cached = issueViewCache.get(issue);
  if (cached && cached.rev === issue.rev) return cached.body;
  const body = Buffer.from(JSON.stringify(issueView(issue)), 'utf8');
  issueViewCache.set(issue, { rev: issue.rev, body });
  return body;
}

function message(status, text) {
  return json(status, { message: text });
}

function notFound() {
  return message(404, 'Not Found');
}

// The public shape of a repository, as the suite reads it.
function repoView(repo) {
  return {
    id: repo.databaseId,
    databaseId: repo.databaseId,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: 1000 },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    html_url: `https://github.com/${repo.fullName}`,
  };
}

// The public shape of an issue, as the suite reads it.
function issueView(issue) {
  return {
    id: issue.seq,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name })),
    user: { login: 'adaiversen', id: 1000 },
  };
}

// The public shape of a pull request, as the suite reads it.
function pullView(pull) {
  return {
    id: pull.seq,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    user: { login: 'adaiversen', id: 1000 },
  };
}

// Parse a JSON request body. A malformed body is a 400, never a crash.
function parseBody(body) {
  if (!body || body.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(body.toString('utf8')) };
  } catch (error) {
    return { ok: false, error };
  }
}

// The direct children of a directory at a commit, with their tree or
// blob shas. Walks the tree hierarchy, so a directory entry carries its
// tree sha and a file entry its blob sha.
function listDirectory(repo, commitOid, dirPath) {
  const commit = repo.store.getObject(commitOid);
  if (!commit || commit.type !== 'commit') return null;
  let currentTreeOid = parseCommit(commit.data).tree;
  if (!currentTreeOid) return null;
  if (dirPath) {
    const parts = dirPath.split('/').filter((part) => part.length > 0);
    for (const part of parts) {
      const tree = repo.store.getObject(currentTreeOid);
      if (!tree || tree.type !== 'tree') return null;
      const entry = parseTree(tree.data).find((candidate) => candidate.name === part && candidate.mode === '40000');
      if (!entry) return null;
      currentTreeOid = entry.oid;
    }
  }
  const tree = repo.store.getObject(currentTreeOid);
  if (!tree || tree.type !== 'tree') return null;
  return parseTree(tree.data).map((entry) => ({
    type: entry.mode === '40000' ? 'dir' : 'file',
    name: entry.name,
    path: dirPath ? `${dirPath}/${entry.name}` : entry.name,
    sha: entry.oid,
  }));
}

// The request id: a short deterministic counter, so every reply carries
// a non-empty X-GitHub-Request-Id.
let requestCounter = 0;
export function nextRequestId() {
  requestCounter += 1;
  return `req-${requestCounter.toString(16).padStart(8, '0')}`;
}

// Route a REST request. Returns a response {status, headers, body} or
// null when the path is not under /api/v3. `ctx` carries the expected
// bearer token and the request's base URL (for pagination links).
export function routeRest(forge, ctx, method, pathname, query, headers, body) {
  const segments = pathname.split('/').filter((part) => part.length > 0);
  if (segments.length < 2 || segments[0] !== 'api' || segments[1] !== 'v3') return null;
  const rest = segments.slice(2);

  // Authentication: every /api/v3 route needs the suite's bearer token.
  const authorization = headers.authorization || headers.Authorization || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (token !== ctx.token) {
    return message(401, 'Bad credentials');
  }

  const parsed = parseBody(body);
  if (!parsed.ok) {
    return message(400, 'Problems parsing JSON');
  }
  const input = parsed.value && typeof parsed.value === 'object' ? parsed.value : {};

  // GET /api/v3/ — the API root.
  if (rest.length === 0) {
    if (method !== 'GET') return message(405, 'Method Not Allowed');
    return json(200, { current_user_url: '/api/v3/user', repository_url: '/api/v3/repos/{owner}/{repo}' }, { 'x-oauth-scopes': 'repo, read:org' });
  }

  // GET /api/v3/meta — the installation metadata.
  if (rest.length === 1 && rest[0] === 'meta') {
    if (method !== 'GET') return message(405, 'Method Not Allowed');
    return json(200, { installed_version: '1.0.0', verifiable_password_authentication: true });
  }

  // /api/v3/user/repos — list the viewer's repositories, or create one.
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'GET') {
      const perPage = Math.max(1, Math.min(100, parseInt(query.per_page || '30', 10) || 30));
      const page = Math.max(1, parseInt(query.page || '1', 10) || 1);
      const all = forge.viewerRepos();
      const total = all.length;
      const start = (page - 1) * perPage;
      const items = all.slice(start, start + perPage).map(repoView);
      const extra = {};
      if (start + perPage < total) {
        const nextUrl = `${ctx.baseUrl}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
        extra.link = `<${nextUrl}>; rel="next"`;
      }
      return json(200, items, extra);
    }
    if (method === 'POST') {
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name) || name.endsWith('.git')) {
        return message(422, 'Validation Failed');
      }
      const repo = forge.createRepo(name, input.private === true, typeof input.description === 'string' ? input.description : '');
      if (!repo) {
        return message(422, 'Validation Failed: name already exists on this account');
      }
      return json(201, repoView(repo));
    }
    return message(405, 'Method Not Allowed');
  }

  // /api/v3/repos/{owner}/{repo} and below.
  if (rest.length >= 3 && rest[0] === 'repos') {
    const owner = rest[1];
    const repoName = rest[2];
    const repo = forge.getRepo(owner, repoName);
    if (!repo) return notFound();
    const tail = rest.slice(3);

    // The repository itself.
    if (tail.length === 0) {
      if (method === 'GET') return json(200, repoView(repo));
      if (method === 'PATCH') {
        if (typeof input.description === 'string') repo.description = input.description;
        if (typeof input.name === 'string' && input.name !== repo.name) {
          return message(422, 'Validation Failed: renaming is not supported');
        }
        return json(200, repoView(repo));
      }
      if (method === 'DELETE') {
        forge.deleteRepo(owner, repoName);
        return { status: 204, headers: {}, body: '' };
      }
      return message(405, 'Method Not Allowed');
    }

    // GET /branches — every branch with its tip.
    if (tail.length === 1 && tail[0] === 'branches') {
      if (method !== 'GET') return message(405, 'Method Not Allowed');
      const branches = [];
      for (const [ref, oid] of [...repo.refs.entries()].sort()) {
        if (!ref.startsWith('refs/heads/')) continue;
        branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid } });
      }
      return json(200, branches);
    }

    // POST /git/refs — create a branch (or a tag) at a commit.
    if (tail.length === 2 && tail[0] === 'git' && tail[1] === 'refs') {
      if (method !== 'POST') return message(405, 'Method Not Allowed');
      const ref = typeof input.ref === 'string' ? input.ref : '';
      const sha = typeof input.sha === 'string' ? input.sha : '';
      if (!ref.startsWith('refs/heads/') || !SHA40.test(sha)) {
        return message(422, 'Validation Failed');
      }
      const branch = ref.slice('refs/heads/'.length);
      const ok = forge.createBranch(repo, branch, sha);
      if (!ok) {
        return message(422, 'Validation Failed: Reference already exists');
      }
      return json(201, { ref, object: { sha, type: 'commit' } });
    }

    // GET /commits — the commits of a branch (or the default branch).
    if (tail.length === 1 && tail[0] === 'commits') {
      if (method !== 'GET') return message(405, 'Method Not Allowed');
      const branch = typeof query.sha === 'string' ? query.sha : repo.defaultBranch;
      const tip = repo.refs.get(`refs/heads/${branch}`);
      if (!tip) return json(200, []);
      const commits = repo.store.walkCommits(tip).map((oid) => {
        const object = repo.store.getObject(oid);
        const commit = object ? parseCommit(object.data) : null;
        return { sha: oid, commit: { message: commit ? commit.message : '' } };
      });
      return json(200, commits);
    }

    // /contents/{path...} — read, create, update or delete a file.
    if (tail.length >= 1 && tail[0] === 'contents') {
      const path = tail.slice(1).map(decodeURIComponent).join('/');
      return routeContents(forge, repo, method, path, query, input);
    }

    // GET /labels and POST /labels.
    if (tail.length === 1 && tail[0] === 'labels') {
      if (method === 'GET') {
        return json(200, [...repo.labels.values()].map((label) => ({ name: label.name })));
      }
      if (method === 'POST') {
        const name = typeof input.name === 'string' ? input.name.trim() : '';
        if (!name) return message(422, 'Validation Failed');
        if (repo.labels.has(name)) return message(422, 'Validation Failed: label already exists');
        const label = forge.createLabel(repo, name, typeof input.color === 'string' ? input.color : undefined);
        return json(201, { name: label.name });
      }
      return message(405, 'Method Not Allowed');
    }

    // /issues — list, create, read, patch, comment.
    if (tail.length >= 1 && tail[0] === 'issues') {
      return routeIssues(forge, repo, method, tail.slice(1), query, input);
    }

    // /pulls — list, create, read, files, merge.
    if (tail.length >= 1 && tail[0] === 'pulls') {
      return routePulls(forge, repo, method, tail.slice(1), query, input);
    }

    return notFound();
  }

  return notFound();
}

// The contents endpoints. `ref` names a branch (default: the default
// branch). GET on a file returns its base64 content; GET on a directory
// lists its entries.
function routeContents(forge, repo, method, path, query, input) {
  const ref = typeof query.ref === 'string' ? query.ref : (typeof query.branch === 'string' ? query.branch : repo.defaultBranch);
  const refName = `refs/heads/${ref}`;
  if (method === 'GET') {
    const tip = repo.refs.get(refName);
    if (!tip) return notFound();
    const file = repo.fileAt(refName, path);
    if (file) {
      return json(200, {
        type: 'file',
        encoding: 'base64',
        content: file.data.toString('base64'),
        sha: file.oid,
        size: file.data.length,
        name: path.split('/').pop(),
        path,
      });
    }
    const entries = listDirectory(repo, tip, path);
    if (!entries) return notFound();
    return json(200, entries.sort((a, b) => (a.name < b.name ? -1 : 1)));
  }
  if (method === 'PUT') {
    const branch = typeof input.branch === 'string' ? input.branch : ref;
    const content = typeof input.content === 'string' ? Buffer.from(input.content, 'base64') : Buffer.alloc(0);
    const messageText = typeof input.message === 'string' ? input.message : 'Update';
    const expectedSha = typeof input.sha === 'string' ? input.sha : undefined;
    // A stale sha is a 409: the update only applies when the sha matches
    // the file's current blob.
    const current = repo.fileAt(`refs/heads/${branch}`, path);
    const created = !current;
    if (expectedSha !== undefined && current && expectedSha.toLowerCase() !== current.oid.toLowerCase()) {
      return message(409, 'Conflict: sha does not match');
    }
    if (expectedSha !== undefined && !current) {
      return message(409, 'Conflict: sha does not match');
    }
    const result = forge.commitFile(repo, branch, path, content, messageText);
    if (!result) return message(422, 'Validation Failed');
    return json(created ? 201 : 200, {
      content: { sha: result.contentSha, encoding: 'base64', name: path.split('/').pop(), path, size: content.length },
      commit: { sha: result.commitSha },
    });
  }
  if (method === 'DELETE') {
    const branch = typeof input.branch === 'string' ? input.branch : ref;
    const messageText = typeof input.message === 'string' ? input.message : 'Delete';
    const expectedSha = typeof input.sha === 'string' ? input.sha : undefined;
    const current = repo.fileAt(`refs/heads/${branch}`, path);
    if (!current) return notFound();
    if (expectedSha !== undefined && expectedSha.toLowerCase() !== current.oid.toLowerCase()) {
      return message(409, 'Conflict: sha does not match');
    }
    const result = forge.deleteFile(repo, branch, path, messageText);
    if (!result) return notFound();
    return json(200, { commit: { sha: result.commitSha } });
  }
  return message(405, 'Method Not Allowed');
}

// The issues endpoints.
function routeIssues(forge, repo, method, tail, query, input) {
  // GET /issues and POST /issues.
  if (tail.length === 0) {
    if (method === 'GET') {
      const state = typeof query.state === 'string' ? query.state : 'open';
      const sort = typeof query.sort === 'string' ? query.sort : 'created';
      const direction = typeof query.direction === 'string' ? query.direction : 'desc';
      let issues = [...repo.issues];
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => {
        const byNumber = a.number - b.number;
        if (sort === 'created') return direction === 'asc' ? byNumber : -byNumber;
        return byNumber;
      });
      const perPage = Math.max(1, Math.min(100, parseInt(query.per_page || '30', 10) || 30));
      const page = Math.max(1, parseInt(query.page || '1', 10) || 1);
      const start = (page - 1) * perPage;
      return json(200, issues.slice(start, start + perPage).map(issueView));
    }
    if (method === 'POST') {
      const title = typeof input.title === 'string' ? input.title : '';
      if (!title) return message(422, 'Validation Failed');
      const labels = Array.isArray(input.labels) ? input.labels.filter((name) => typeof name === 'string') : [];
      const result = forge.createIssue(repo, title, typeof input.body === 'string' ? input.body : '', labels);
      if (result.error === 'unknown-label') return message(422, 'Validation Failed: unknown label');
      return json(201, issueView(result.issue));
    }
    return message(405, 'Method Not Allowed');
  }

  // /issues/{number} and /issues/{number}/comments.
  const number = parseInt(tail[0], 10);
  if (!Number.isInteger(number)) return notFound();
  const issue = forge.getIssue(repo, number);
  if (tail.length === 1) {
    if (!issue) return notFound();
    if (method === 'GET') return jsonBody(200, cachedIssueView(issue));
    if (method === 'PATCH') {
      const updated = forge.patchIssue(repo, number, input);
      if (!updated) return notFound();
      return json(200, issueView(updated));
    }
    return message(405, 'Method Not Allowed');
  }
  if (tail.length === 2 && tail[1] === 'comments') {
    if (!issue) return notFound();
    if (method === 'GET') {
      return json(200, forge.commentsOf(repo, number).map((comment) => ({
        id: comment.seq,
        body: comment.body,
        user: { login: 'adaiversen', id: 1000 },
      })));
    }
    if (method === 'POST') {
      const bodyText = typeof input.body === 'string' ? input.body : '';
      if (!bodyText) return message(422, 'Validation Failed');
      const comment = forge.addComment(repo, number, bodyText);
      if (!comment) return notFound();
      return json(201, { id: comment.seq, body: comment.body, user: { login: 'adaiversen', id: 1000 } });
    }
    return message(405, 'Method Not Allowed');
  }
  return notFound();
}

// The pull requests endpoints.
function routePulls(forge, repo, method, tail, query, input) {
  // GET /pulls and POST /pulls.
  if (tail.length === 0) {
    if (method === 'GET') {
      const state = typeof query.state === 'string' ? query.state : 'open';
      let pulls = [...repo.pullRequests];
      if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
      pulls.sort((a, b) => a.number - b.number);
      const perPage = Math.max(1, Math.min(100, parseInt(query.per_page || '30', 10) || 30));
      const page = Math.max(1, parseInt(query.page || '1', 10) || 1);
      const start = (page - 1) * perPage;
      return json(200, pulls.slice(start, start + perPage).map(pullView));
    }
    if (method === 'POST') {
      const head = typeof input.head === 'string' ? input.head : (input.head && typeof input.head.ref === 'string' ? input.head.ref : '');
      const base = typeof input.base === 'string' ? input.base : (input.base && typeof input.base.ref === 'string' ? input.base.ref : '');
      const title = typeof input.title === 'string' ? input.title : '';
      if (!head || !base || !title) return message(422, 'Validation Failed');
      const result = forge.createPull(repo, title, typeof input.body === 'string' ? input.body : '', head, base);
      if (result.error) return message(422, `Validation Failed: ${result.error}`);
      return json(201, pullView(result.pull));
    }
    return message(405, 'Method Not Allowed');
  }

  // /pulls/{number}, /pulls/{number}/files, /pulls/{number}/merge.
  const number = parseInt(tail[0], 10);
  if (!Number.isInteger(number)) return notFound();
  const pull = forge.getPull(repo, number);
  if (tail.length === 1) {
    if (!pull) return notFound();
    if (method === 'GET') return json(200, pullView(pull));
    return message(405, 'Method Not Allowed');
  }
  if (tail.length === 2 && tail[1] === 'files') {
    if (!pull) return notFound();
    if (method !== 'GET') return message(405, 'Method Not Allowed');
    return json(200, forge.pullFiles(repo, pull));
  }
  if (tail.length === 2 && tail[1] === 'merge') {
    if (!pull) return notFound();
    if (method !== 'PUT') return message(405, 'Method Not Allowed');
    const result = forge.mergePull(repo, pull);
    if (result.error === 'conflict') return message(405, 'Merge conflict');
    if (result.error) return notFound();
    return json(200, { merged: true, sha: result.mergeSha, message: `Merge pull request #${number}` });
  }
  return notFound();
}

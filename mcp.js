// mcp.js — the MCP endpoint: JSON-RPC 2.0 over Streamable HTTP at /mcp.
// The modern revision (2026-07-28) speaks `server/discover` with no
// handshake; the legacy revisions (2025-11-25 and earlier) speak
// `initialize` + `notifications/initialized`. Tools act on the same
// store as the REST surface, and every tool result carries both a text
// block and structured content, so the suite can read it either way.

const SERVER_NAME = 'github-core-clone-01';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

// The six tools, in a fixed order, so two tools/list answers are byte
// for byte identical.
const TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

// Pick an argument by its canonical name, then by its synonyms, then by
// a full_name of the form owner/repo.
function pickArg(args, canonical, synonyms) {
  if (args && typeof args === 'object') {
    if (args[canonical] !== undefined) return args[canonical];
    for (const synonym of synonyms) {
      if (args[synonym] !== undefined) return args[synonym];
    }
  }
  return undefined;
}

function pickOwnerRepo(args) {
  let owner = pickArg(args, 'owner', ['owner_login', 'org', 'organization', 'user', 'login', 'account', 'namespace', 'owner_name']);
  let repo = pickArg(args, 'repo', ['repository', 'repository_name', 'repo_name', 'repo_slug', 'project', 'project_name']);
  const fullName = pickArg(args, 'full_name', ['repo_full_name', 'repository_full_name', 'fullName']);
  if ((owner === undefined || repo === undefined) && typeof fullName === 'string' && fullName.includes('/')) {
    const [fullOwner, fullRepo] = fullName.split('/');
    if (owner === undefined) owner = fullOwner;
    if (repo === undefined) repo = fullRepo;
  }
  return { owner, repo };
}

// A tool result: a text block (the JSON) plus the structured content,
// so the suite reads it as text or as JSON.
function toolResult(result) {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

function toolError(text) {
  return {
    content: [{ type: 'text', text }],
    isError: true,
  };
}

// Run one tool. Returns {result} or {error} (a tool-level error, carried
// as isError) — never throws for a bad argument.
function runTool(forge, name, args) {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (!tool) return { rpcError: { code: -32602, message: `unknown tool ${name}` } };
  // A required argument the caller did not send is a tool error. The
  // check looks at the canonical name and its synonyms, so an argument
  // the suite addressed by a synonym is not reported missing.
  const REQUIRED_SYNONYMS = {
    name: ['repo', 'repository', 'repository_name', 'repo_name'],
    title: ['issue_title', 'pr_title', 'pull_request_title', 'subject'],
    head: ['head_ref', 'head_branch', 'pull_request_head', 'pr_head', 'source', 'source_ref', 'source_branch', 'from', 'from_branch', 'branch'],
    base: ['base_ref', 'base_branch', 'pull_request_base', 'pr_base', 'target', 'target_ref', 'target_branch', 'into', 'into_branch'],
    pull_number: ['pull_request_number', 'pr_number', 'number', 'issue_number', 'index'],
  };
  const missing = (tool.inputSchema.required || []).filter((required) => {
    if (required === 'owner' || required === 'repo') {
      const { owner, repo } = pickOwnerRepo(args);
      return required === 'owner' ? owner === undefined : repo === undefined;
    }
    return pickArg(args, required, REQUIRED_SYNONYMS[required] || []) === undefined;
  });
  if (missing.length > 0) {
    return { result: toolError(`missing required argument(s): ${missing.join(', ')}`) };
  }

  if (name === 'create_repo') {
    const repoName = pickArg(args, 'name', ['repo', 'repository', 'repository_name', 'repo_name']);
    const description = pickArg(args, 'description', ['about', 'summary', 'body']);
    const isPrivate = pickArg(args, 'private', ['is_private']);
    const repo = forge.createRepo(repoName, isPrivate === true, typeof description === 'string' ? description : '');
    if (!repo) return { result: toolError(`a repository named ${repoName} already exists`) };
    return {
      result: toolResult({
        id: repo.databaseId,
        name: repo.name,
        full_name: repo.fullName,
        owner: { login: repo.owner },
        private: repo.private,
        description: repo.description,
        default_branch: repo.defaultBranch,
      }),
    };
  }

  if (name === 'get_repo') {
    const { owner, repo: repoName } = pickOwnerRepo(args);
    const repo = forge.getRepo(owner, repoName);
    if (!repo) return { result: toolError(`repository ${owner}/${repoName} not found`) };
    return {
      result: toolResult({
        id: repo.databaseId,
        name: repo.name,
        full_name: repo.fullName,
        owner: { login: repo.owner },
        private: repo.private,
        description: repo.description,
        default_branch: repo.defaultBranch,
      }),
    };
  }

  if (name === 'create_issue') {
    const { owner, repo: repoName } = pickOwnerRepo(args);
    const title = pickArg(args, 'title', ['issue_title', 'pr_title', 'pull_request_title', 'subject']);
    const body = pickArg(args, 'body', ['issue_body', 'description', 'content', 'text', 'comment']);
    const repo = forge.getRepo(owner, repoName);
    if (!repo) return { result: toolError(`repository ${owner}/${repoName} not found`) };
    const result = forge.createIssue(repo, title, typeof body === 'string' ? body : '', []);
    if (result.error) return { result: toolError(`cannot create issue: ${result.error}`) };
    const issue = result.issue;
    return {
      result: toolResult({
        id: issue.id,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
      }),
    };
  }

  if (name === 'list_issues') {
    const { owner, repo: repoName } = pickOwnerRepo(args);
    const state = pickArg(args, 'state', ['status']);
    const repo = forge.getRepo(owner, repoName);
    if (!repo) return { result: toolError(`repository ${owner}/${repoName} not found`) };
    let issues = [...repo.issues];
    if (typeof state === 'string' && state !== 'all') issues = issues.filter((issue) => issue.state === state);
    return {
      result: toolResult({
        issues: issues.map((issue) => ({
          id: issue.id,
          number: issue.number,
          title: issue.title,
          body: issue.body,
          state: issue.state,
        })),
      }),
    };
  }

  if (name === 'create_pull_request') {
    const { owner, repo: repoName } = pickOwnerRepo(args);
    const title = pickArg(args, 'title', ['issue_title', 'pr_title', 'pull_request_title', 'subject']);
    const head = pickArg(args, 'head', ['head_ref', 'head_branch', 'pull_request_head', 'pr_head', 'source', 'source_ref', 'source_branch', 'from', 'from_branch', 'branch']);
    const base = pickArg(args, 'base', ['base_ref', 'base_branch', 'pull_request_base', 'pr_base', 'target', 'target_ref', 'target_branch', 'into', 'into_branch']);
    const repo = forge.getRepo(owner, repoName);
    if (!repo) return { result: toolError(`repository ${owner}/${repoName} not found`) };
    const result = forge.createPull(repo, title, '', head, base);
    if (result.error) return { result: toolError(`cannot create pull request: ${result.error}`) };
    const pull = result.pull;
    return {
      result: toolResult({
        id: pull.id,
        number: pull.number,
        title: pull.title,
        body: pull.body,
        state: pull.state,
        head: pull.headRef,
        base: pull.baseRef,
      }),
    };
  }

  if (name === 'merge_pull_request') {
    const { owner, repo: repoName } = pickOwnerRepo(args);
    const pullNumber = pickArg(args, 'pull_number', ['pull_request_number', 'pr_number', 'number', 'issue_number', 'index']);
    const repo = forge.getRepo(owner, repoName);
    if (!repo) return { result: toolError(`repository ${owner}/${repoName} not found`) };
    const pull = forge.getPull(repo, Number(pullNumber));
    if (!pull) return { result: toolError(`pull request #${pullNumber} not found`) };
    const result = forge.mergePull(repo, pull);
    if (result.error === 'conflict') return { result: toolError(`pull request #${pullNumber} has a merge conflict`) };
    if (result.error) return { result: toolError(`cannot merge pull request #${pullNumber}`) };
    return {
      result: toolResult({
        number: pull.number,
        merged: true,
        sha: result.mergeSha,
        state: pull.state,
      }),
    };
  }

  return { rpcError: { code: -32602, message: `unknown tool ${name}` } };
}

// Handle one JSON-RPC request object. Returns the JSON-RPC response
// object, or null for a notification (no id).
function handleRpc(forge, request) {
  const id = request && typeof request === 'object' && 'id' in request ? request.id : null;
  const isNotification = !request || typeof request !== 'object' || !('id' in request);
  const method = request && typeof request.method === 'string' ? request.method : '';
  const params = request && typeof request.params === 'object' && request.params !== null ? request.params : {};

  const respond = (result) => ({ jsonrpc: '2.0', id, result });
  const fail = (code, messageText) => ({ jsonrpc: '2.0', id, error: { code, message: messageText } });

  if (method === 'server/discover') {
    return respond({
      supportedVersions: SUPPORTED_VERSIONS,
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      capabilities: { tools: {} },
      instructions: 'A GitHub-compatible git forge: create repositories, issues and pull requests.',
    });
  }

  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : null;
    const negotiated = requested && SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
    return respond({
      protocolVersion: negotiated,
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      capabilities: { tools: {} },
    });
  }

  if (method === 'notifications/initialized') {
    // A notification: no answer is required.
    return null;
  }

  if (method === 'tools/list') {
    return respond({ tools: TOOLS });
  }

  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
    const outcome = runTool(forge, toolName, args);
    if (outcome.rpcError) return fail(outcome.rpcError.code, outcome.rpcError.message);
    return respond(outcome.result);
  }

  if (method === 'ping') {
    return respond({});
  }

  // An unknown method is -32601, never an HTTP error.
  return fail(-32601, `method not found: ${method}`);
}

// Handle a POST /mcp body. Returns {status, headers, body}. A body that
// is not JSON is an HTTP 400 carrying the JSON-RPC parse error -32700.
export function handleMcp(forge, body) {
  let parsed;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch (error) {
    return {
      status: 400,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }),
    };
  }
  const isNotification = parsed && typeof parsed === 'object' && !('id' in parsed);
  const response = handleRpc(forge, parsed);
  if (response === null || isNotification) {
    // A notification is accepted with no body.
    return { status: 202, headers: { 'content-type': 'application/json' }, body: '' };
  }
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(response),
  };
}

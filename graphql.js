// graphql.js — a focused GraphQL executor for the documents the suite
// sends (gh and github-mcp-server shapes): queries for the viewer, a
// repository, issues, pull requests and introspection; the five
// mutations; cursor pagination; and operation batching (a JSON array of
// operations answers a JSON array of results, in order). Unknown fields
// answer HTTP 200 with an errors array naming the field, never a 500.

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

function tokenize(source) {
  const tokens = [];
  let at = 0;
  const isNameStart = (ch) => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch) => /[A-Za-z0-9_]/.test(ch);
  while (at < source.length) {
    const ch = source[at];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      at += 1;
      continue;
    }
    if (ch === '#') {
      while (at < source.length && source[at] !== '\n') at += 1;
      continue;
    }
    if (ch === '.' && source.slice(at, at + 3) === '...') {
      tokens.push({ kind: 'spread' });
      at += 3;
      continue;
    }
    if ('{}()[]:!=$@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      at += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      at += 1;
      while (at < source.length && source[at] !== '"') {
        if (source[at] === '\\' && at + 1 < source.length) {
          const escaped = source[at + 1];
          if (escaped === 'n') value += '\n';
          else if (escaped === 't') value += '\t';
          else if (escaped === 'r') value += '\r';
          else value += escaped;
          at += 2;
        } else {
          value += source[at];
          at += 1;
        }
      }
      at += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (ch === '-' || /[0-9]/.test(ch)) {
      let text = '';
      while (at < source.length && /[0-9.eE+-]/.test(source[at])) {
        text += source[at];
        at += 1;
      }
      tokens.push({ kind: 'number', value: Number(text) });
      continue;
    }
    if (isNameStart(ch)) {
      let text = '';
      while (at < source.length && isNameChar(source[at])) {
        text += source[at];
        at += 1;
      }
      tokens.push({ kind: 'name', value: text });
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser (a recursive descent over the token stream)
// ---------------------------------------------------------------------------

function parseDocument(source) {
  const tokens = tokenize(source);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const expectPunct = (value) => {
    const token = next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected ${value}, got ${token.kind} ${token.value ?? ''}`);
    }
  };
  const expectName = () => {
    const token = next();
    if (token.kind !== 'name') throw new Error(`expected a name, got ${token.kind}`);
    return token.value;
  };

  function parseValue() {
    const token = peek();
    if (token.kind === 'punct' && token.value === '$') {
      next();
      return { __var: expectName() };
    }
    if (token.kind === 'punct' && token.value === '[') {
      next();
      const items = [];
      while (!(peek().kind === 'punct' && peek().value === ']')) items.push(parseValue());
      expectPunct(']');
      return items;
    }
    if (token.kind === 'punct' && token.value === '{') {
      next();
      const object = {};
      while (!(peek().kind === 'punct' && peek().value === '}')) {
        const key = expectName();
        expectPunct(':');
        object[key] = parseValue();
      }
      expectPunct('}');
      return object;
    }
    if (token.kind === 'string') {
      next();
      return token.value;
    }
    if (token.kind === 'number') {
      next();
      return token.value;
    }
    if (token.kind === 'name') {
      next();
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      return token.value;
    }
    throw new Error(`unexpected token ${token.kind} in a value`);
  }

  function parseArguments() {
    const args = {};
    if (peek().kind === 'punct' && peek().value === '(') {
      next();
      while (!(peek().kind === 'punct' && peek().value === ')')) {
        const name = expectName();
        expectPunct(':');
        args[name] = parseValue();
      }
      expectPunct(')');
    }
    return args;
  }

  function parseSelectionSet() {
    expectPunct('{');
    const selections = [];
    while (!(peek().kind === 'punct' && peek().value === '}')) {
      if (peek().kind === 'spread') {
        next();
        if (peek().kind === 'name' && peek().value === 'on') {
          next();
          const typeCondition = expectName();
          selections.push({ kind: 'fragment', typeCondition, selectionSet: parseSelectionSet() });
        } else {
          const fragmentName = expectName();
          selections.push({ kind: 'fragment', typeCondition: null, fragmentName });
        }
        continue;
      }
      const first = expectName();
      let alias = null;
      let name = first;
      if (peek().kind === 'punct' && peek().value === ':') {
        next();
        alias = first;
        name = expectName();
      }
      const args = parseArguments();
      let selectionSet = null;
      if (peek().kind === 'punct' && peek().value === '{') selectionSet = parseSelectionSet();
      selections.push({ kind: 'field', alias: alias || name, name, args, selectionSet });
    }
    expectPunct('}');
    return selections;
  }

  function parseVariableDefinitions() {
    const variables = {};
    if (peek().kind === 'punct' && peek().value === '(') {
      next();
      while (!(peek().kind === 'punct' && peek().value === ')')) {
        expectPunct('$');
        const name = expectName();
        expectPunct(':');
        // The type: a name, possibly wrapped in [ ] and suffixed with !.
        let type = '';
        while (peek().kind === 'name' || (peek().kind === 'punct' && '[]!'.includes(peek().value))) {
          const token = next();
          type += token.value;
        }
        let defaultValue;
        if (peek().kind === 'punct' && peek().value === '=') {
          next();
          defaultValue = parseValue();
        }
        variables[name] = { type, defaultValue };
      }
      expectPunct(')');
    }
    return variables;
  }

  const operations = [];
  while (peek().kind !== 'eof') {
    const token = peek();
    if (token.kind === 'punct' && token.value === '{') {
      operations.push({ type: 'query', name: null, variables: {}, selectionSet: parseSelectionSet() });
      continue;
    }
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      next();
      const type = token.value;
      let name = null;
      if (peek().kind === 'name') name = next().value;
      const variables = parseVariableDefinitions();
      const selectionSet = parseSelectionSet();
      operations.push({ type, name, variables, selectionSet });
      continue;
    }
    throw new Error(`unexpected token ${token.kind} ${token.value ?? ''} in a GraphQL document`);
  }
  return operations;
}

// Resolve a parsed value against the request variables.
function resolveValue(value, variables) {
  if (value && typeof value === 'object' && '__var' in value) {
    return variables[value.__var];
  }
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, variables));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = resolveValue(item, variables);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Type metadata for __type introspection
// ---------------------------------------------------------------------------

const TYPE_FIELDS = {
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  User: ['id', 'login', 'name'],
  SearchType: [],
};

const TYPE_ENUM_VALUES = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'],
};

// A cursor is the issue number, base64-encoded, so the next page starts
// after it.
function encodeCursor(number) {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function decodeCursor(cursor) {
  if (typeof cursor !== 'string' || !cursor) return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? parseInt(match[1], 10) : null;
  } catch (error) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

class Resolver {
  constructor(forge) {
    this.forge = forge;
    this.errors = [];
  }

  // Resolve a selection set against a typed value. `type` names the
  // GraphQL type; `value` is the underlying object (or null).
  resolve(type, value, selectionSet, variables) {
    if (value === null || value === undefined) return null;
    const out = {};
    for (const selection of selectionSet) {
      if (selection.kind === 'fragment') {
        if (selection.typeCondition && selection.typeCondition !== type) continue;
        const fragment = this.resolve(type, value, selection.selectionSet, variables);
        if (fragment) Object.assign(out, fragment);
        continue;
      }
      const fieldName = selection.name;
      const key = selection.alias;
      const args = {};
      for (const [name, raw] of Object.entries(selection.args)) args[name] = resolveValue(raw, variables);
      const resolved = this.resolveField(type, value, fieldName, args, selection.selectionSet, variables);
      out[key] = resolved === undefined ? null : resolved;
    }
    return out;
  }

  // One field. Returns undefined when the field does not exist on the
  // type (the caller turns that into null and records an error).
  resolveField(type, value, fieldName, args, selectionSet, variables) {
    const handler = this.fieldHandlers[type];
    if (!handler) {
      this.errors.push({ message: `Cannot query field "${fieldName}" on type "${type}".` });
      return undefined;
    }
    const result = handler.call(this, value, fieldName, args, selectionSet, variables);
    if (result === undefined) {
      this.errors.push({ message: `Cannot query field "${fieldName}" on type "${type}".` });
      return undefined;
    }
    return result;
  }

  // The field handlers, one per GraphQL type. Each returns the field's
  // value, or undefined for an unknown field.
  fieldHandlers = {
    Query: function (value, fieldName, args, selectionSet, variables) {
      if (fieldName === 'viewer') {
        return this.resolve('User', { login: this.forge.viewerLogin, id: 1000, name: 'ada iversen' }, selectionSet, variables);
      }
      if (fieldName === 'repository') {
        const repo = this.forge.getRepo(args.owner, args.name);
        if (!repo) return null;
        return this.resolve('Repository', repo, selectionSet, variables);
      }
      if (fieldName === 'node') {
        const found = this.findByGlobalId(args.id);
        if (!found) return null;
        // A pull request's resolver needs its repository; attach it only
        // for the read, so mutations keep the stored object itself.
        const value = found.type === 'PullRequest' ? { ...found.value, repo: found.repo } : found.value;
        return this.resolve(found.type, value, selectionSet, variables);
      }
      if (fieldName === '__type') {
        const name = args.name;
        const fields = TYPE_FIELDS[name];
        if (fields === undefined && TYPE_ENUM_VALUES[name] === undefined) return null;
        const typeObject = { __typeName: name };
        return this.resolve('__Type', typeObject, selectionSet, variables);
      }
      if (fieldName === '__schema') {
        return this.resolve('__Schema', {}, selectionSet, variables);
      }
      return undefined;
    },

    Mutation: function (value, fieldName, args, selectionSet, variables) {
      const input = args.input || {};
      if (fieldName === 'createIssue') {
        const repo = this.findRepoByGlobalId(input.repositoryId);
        if (!repo) return null;
        const result = this.forge.createIssue(repo, input.title || '', typeof input.body === 'string' ? input.body : '', []);
        if (result.error) return null;
        return this.resolve('CreateIssuePayload', { issue: result.issue }, selectionSet, variables);
      }
      if (fieldName === 'closeIssue') {
        const found = this.findByGlobalId(input.issueId);
        if (!found || found.type !== 'Issue') return null;
        const updated = this.forge.patchIssue(found.repo, found.value.number, { state: 'closed' });
        if (!updated) return null;
        return this.resolve('CloseIssuePayload', { issue: updated }, selectionSet, variables);
      }
      if (fieldName === 'createPullRequest') {
        const repo = this.findRepoByGlobalId(input.repositoryId);
        if (!repo) return null;
        const result = this.forge.createPull(repo, input.title || '', typeof input.body === 'string' ? input.body : '', input.headRefName || '', input.baseRefName || '');
        if (result.error) return null;
        return this.resolve('CreatePullRequestPayload', { pullRequest: result.pull, repo }, selectionSet, variables);
      }
      if (fieldName === 'mergePullRequest') {
        const found = this.findByGlobalId(input.pullRequestId);
        if (!found || found.type !== 'PullRequest') return null;
        const result = this.forge.mergePull(found.repo, found.value);
        if (result.error) return null;
        const pull = this.forge.getPull(found.repo, found.value.number);
        return this.resolve('MergePullRequestPayload', { pullRequest: pull, repo: found.repo }, selectionSet, variables);
      }
      if (fieldName === 'addComment') {
        const found = this.findByGlobalId(input.subjectId);
        if (!found || found.type !== 'Issue') return null;
        const comment = this.forge.addComment(found.repo, found.value.number, input.body || '');
        if (!comment) return null;
        return this.resolve('AddCommentPayload', { commentEdge: { node: comment } }, selectionSet, variables);
      }
      return undefined;
    },

    User: function (value, fieldName) {
      if (fieldName === 'login') return value.login;
      if (fieldName === 'id') return `U_${value.id}`;
      if (fieldName === 'name') return value.name;
      return undefined;
    },

    Repository: function (value, fieldName, args, selectionSet, variables) {
      const repo = value;
      if (fieldName === 'id') return repo.id;
      if (fieldName === 'databaseId') return repo.databaseId;
      if (fieldName === 'name') return repo.name;
      if (fieldName === 'nameWithOwner') return repo.fullName;
      if (fieldName === 'owner') {
        return this.resolve('User', { login: repo.owner, id: 1000, name: 'ada iversen' }, selectionSet, variables);
      }
      if (fieldName === 'defaultBranchRef') {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (!tip) return null;
        return this.resolve('Ref', { name: repo.defaultBranch }, selectionSet, variables);
      }
      if (fieldName === 'viewerPermission') return 'ADMIN';
      if (fieldName === 'hasIssuesEnabled') return true;
      if (fieldName === 'issue') {
        const issue = this.forge.getIssue(repo, args.number);
        if (!issue) return null;
        return this.resolve('Issue', issue, selectionSet, variables);
      }
      if (fieldName === 'issues') {
        return this.issuesConnection(repo, args, selectionSet, variables);
      }
      if (fieldName === 'pullRequest') {
        const pull = this.forge.getPull(repo, args.number);
        if (!pull) return null;
        return this.resolve('PullRequest', { ...pull, repo }, selectionSet, variables);
      }
      if (fieldName === 'pullRequests') {
        let pulls = [...repo.pullRequests];
        pulls.sort((a, b) => a.number - b.number);
        if (typeof args.first === 'number') pulls = pulls.slice(0, args.first);
        const nodesField = selectionSet.find((selection) => selection.kind === 'field' && selection.name === 'nodes');
        const nodeSelection = nodesField ? nodesField.selectionSet : [];
        const nodes = pulls.map((pull) => this.resolve('PullRequest', { ...pull, repo }, nodeSelection, variables));
        return { nodes };
      }
      return undefined;
    },

    Issue: function (value, fieldName) {
      if (fieldName === 'id') return value.id;
      if (fieldName === 'number') return value.number;
      if (fieldName === 'title') return value.title;
      if (fieldName === 'state') return value.state === 'open' ? 'OPEN' : 'CLOSED';
      if (fieldName === 'body') return value.body;
      return undefined;
    },

    PullRequest: function (value, fieldName, args, selectionSet, variables) {
      if (fieldName === 'id') return value.id;
      if (fieldName === 'number') return value.number;
      if (fieldName === 'headRefName') return value.headRef;
      if (fieldName === 'baseRefName') return value.baseRef;
      if (fieldName === 'mergeable') {
        const check = this.forge.mergeable(value.repo, value);
        return check.ok ? 'MERGEABLE' : 'CONFLICTING';
      }
      if (fieldName === 'state') return value.state === 'open' ? 'OPEN' : 'CLOSED';
      if (fieldName === 'merged') return value.merged === true;
      if (fieldName === 'files') {
        const files = this.forge.pullFiles(value.repo, value);
        const first = typeof args.first === 'number' ? args.first : files.length;
        const nodesField = selectionSet.find((selection) => selection.kind === 'field' && selection.name === 'nodes');
        const nodeSelection = nodesField ? nodesField.selectionSet : [];
        const nodes = files.slice(0, first).map((file) => {
          const node = {};
          for (const selection of nodeSelection) {
            if (selection.kind === 'field' && selection.name === 'path') node[selection.alias] = file.filename;
          }
          return node;
        });
        return { nodes };
      }
      return undefined;
    },

    Ref: function (value, fieldName) {
      if (fieldName === 'name') return value.name;
      return undefined;
    },

    CreateIssuePayload: function (value, fieldName, args, selectionSet, variables) {
      if (fieldName === 'issue') return this.resolve('Issue', value.issue, selectionSet, variables);
      return undefined;
    },

    CloseIssuePayload: function (value, fieldName, args, selectionSet, variables) {
      if (fieldName === 'issue') return this.resolve('Issue', value.issue, selectionSet, variables);
      return undefined;
    },

    CreatePullRequestPayload: function (value, fieldName, args, selectionSet, variables) {
      if (fieldName === 'pullRequest') {
        return this.resolve('PullRequest', { ...value.pullRequest, repo: value.repo }, selectionSet, variables);
      }
      return undefined;
    },

    MergePullRequestPayload: function (value, fieldName, args, selectionSet, variables) {
      if (fieldName === 'pullRequest') {
        return this.resolve('PullRequest', { ...value.pullRequest, repo: value.repo }, selectionSet, variables);
      }
      return undefined;
    },

    AddCommentPayload: function (value, fieldName, args, selectionSet, variables) {
      if (fieldName === 'commentEdge') {
        return this.resolve('IssueCommentEdge', value.commentEdge, selectionSet, variables);
      }
      return undefined;
    },

    IssueCommentEdge: function (value, fieldName, args, selectionSet, variables) {
      if (fieldName === 'node') return this.resolve('IssueComment', value.node, selectionSet, variables);
      return undefined;
    },

    IssueComment: function (value, fieldName) {
      if (fieldName === 'id') return value.id;
      if (fieldName === 'body') return value.body;
      return undefined;
    },

    __Type: function (value, fieldName, args, selectionSet, variables) {
      const name = value.__typeName;
      if (fieldName === 'name') return name;
      if (fieldName === 'fields') {
        const fields = TYPE_FIELDS[name] || [];
        return fields.map((fieldName) => {
          const field = {};
          for (const selection of selectionSet) {
            if (selection.kind === 'field' && selection.name === 'name') field[selection.alias] = fieldName;
          }
          return field;
        });
      }
      if (fieldName === 'enumValues') {
        const values = TYPE_ENUM_VALUES[name] || [];
        return values.map((enumName) => {
          const field = {};
          for (const selection of selectionSet) {
            if (selection.kind === 'field' && selection.name === 'name') field[selection.alias] = enumName;
          }
          return field;
        });
      }
      return undefined;
    },

    __Schema: function () {
      return undefined;
    },
  };

  // The issues connection: filter by state, order, page by cursor.
  issuesConnection(repo, args, selectionSet, variables) {
    let issues = [...repo.issues];
    const states = Array.isArray(args.states) ? args.states : null;
    if (states) {
      const wanted = new Set(states.map((state) => String(state).toLowerCase()));
      issues = issues.filter((issue) => wanted.has(issue.state));
    }
    const orderBy = args.orderBy || {};
    const descending = orderBy.direction === 'DESC';
    issues.sort((a, b) => {
      if (a.number === b.number) return 0;
      return descending ? b.number - a.number : a.number - b.number;
    });
    const after = decodeCursor(args.after);
    if (after !== null) {
      issues = issues.filter((issue) => (descending ? issue.number < after : issue.number > after));
    }
    const first = typeof args.first === 'number' ? args.first : issues.length;
    const page = issues.slice(0, first);
    const hasNextPage = issues.length > first;
    const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1].number) : null;
    const out = {};
    for (const selection of selectionSet) {
      if (selection.kind !== 'field') continue;
      if (selection.name === 'nodes') {
        out[selection.alias] = page.map((issue) => this.resolve('Issue', issue, selection.selectionSet, variables));
      } else if (selection.name === 'pageInfo') {
        const pageInfo = {};
        for (const field of selection.selectionSet) {
          if (field.kind !== 'field') continue;
          if (field.name === 'hasNextPage') pageInfo[field.alias] = hasNextPage;
          else if (field.name === 'endCursor') pageInfo[field.alias] = endCursor;
        }
        out[selection.alias] = pageInfo;
      } else if (selection.name === 'totalCount') {
        out[selection.alias] = issues.length;
      }
    }
    return out;
  }

  // Find a repository by its global id (R_<databaseId>).
  findRepoByGlobalId(id) {
    if (typeof id !== 'string' || !id.startsWith('R_')) return null;
    const databaseId = parseInt(id.slice(2), 10);
    for (const repo of this.forge.repos.values()) {
      if (repo.databaseId === databaseId) return repo;
    }
    return null;
  }

  // Find any object by its global id. Returns {type, value, repo}.
  findByGlobalId(id) {
    if (typeof id !== 'string') return null;
    if (id.startsWith('R_')) {
      const repo = this.findRepoByGlobalId(id);
      return repo ? { type: 'Repository', value: repo, repo } : null;
    }
    if (id.startsWith('I_')) {
      const parts = id.slice(2).split('_');
      const databaseId = parseInt(parts[0], 10);
      const number = parseInt(parts[1], 10);
      const repo = this.findRepoByGlobalId(`R_${databaseId}`);
      if (!repo) return null;
      const issue = this.forge.getIssue(repo, number);
      return issue ? { type: 'Issue', value: issue, repo } : null;
    }
    if (id.startsWith('PR_')) {
      const parts = id.slice(3).split('_');
      const databaseId = parseInt(parts[0], 10);
      const number = parseInt(parts[1], 10);
      const repo = this.findRepoByGlobalId(`R_${databaseId}`);
      if (!repo) return null;
      const pull = this.forge.getPull(repo, number);
      // The stored pull object itself, so mutations act on it.
      return pull ? { type: 'PullRequest', value: pull, repo } : null;
    }
    if (id.startsWith('C_')) {
      const parts = id.slice(2).split('_');
      const databaseId = parseInt(parts[0], 10);
      const repo = this.findRepoByGlobalId(`R_${databaseId}`);
      if (!repo) return null;
      for (const list of repo.comments.values()) {
        const comment = list.find((candidate) => candidate.id === id);
        if (comment) return { type: 'IssueComment', value: comment, repo };
      }
      return null;
    }
    return null;
  }
}

// Execute one operation ({query, variables, operationName}) and return
// the response object {data, errors?}.
export function executeGraphQL(forge, operation) {
  const variables = operation.variables && typeof operation.variables === 'object' ? operation.variables : {};
  let operations;
  try {
    operations = parseDocument(operation.query || '');
  } catch (error) {
    return { data: null, errors: [{ message: error.message }] };
  }
  if (operations.length === 0) {
    return { data: null, errors: [{ message: 'no operation in the GraphQL document' }] };
  }
  // With several operations in one document, the named one runs.
  let selected = operations[0];
  if (operation.operationName) {
    const named = operations.find((op) => op.name === operation.operationName);
    if (named) selected = named;
  }
  const resolver = new Resolver(forge);
  const rootType = selected.type === 'mutation' ? 'Mutation' : 'Query';
  const data = resolver.resolve(rootType, {}, selected.selectionSet, variables);
  const response = { data };
  if (resolver.errors.length > 0) response.errors = resolver.errors;
  return response;
}

// Handle a POST /api/graphql body (a single operation or a JSON array
// of operations). Returns the response body as a string.
export function handleGraphQL(forge, body) {
  let parsed;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch (error) {
    return JSON.stringify({ data: null, errors: [{ message: 'Problems parsing JSON' }] });
  }
  if (Array.isArray(parsed)) {
    return JSON.stringify(parsed.map((operation) => executeGraphQL(forge, operation)));
  }
  return JSON.stringify(executeGraphQL(forge, parsed));
}

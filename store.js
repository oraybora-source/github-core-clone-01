// store.js — the forge's state: repositories, branches, issues, labels,
// pull requests and comments, plus the deterministic state export the
// replay check compares byte-for-byte. Everything lives in memory; the
// export is a canonical JSON document with no timestamps, no ports and
// no random ids, so two runs on the same instance agree exactly.

import { ObjectStore, parseCommit, parseTree, parseTag, buildCommit, buildTree, buildTreeFromFiles, flattenTree, treeNameCompare } from './objects.js';
import { hashObject, ZERO_OID } from './pack.js';

// The viewer the suite's token names. The scenario seed is fixed, so the
// viewer login is the same for every trial; it is derived here from the
// token's owner, and the store is created with it.
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const DEFAULT_BRANCH = 'main';

// A stable global id for a repository, readable by the GraphQL node()
// query and identical across REST and GraphQL views.
function repoGlobalId(databaseId) {
  return `R_${databaseId}`;
}

function issueGlobalId(repoDatabaseId, number) {
  return `I_${repoDatabaseId}_${number}`;
}

function pullGlobalId(repoDatabaseId, number) {
  return `PR_${repoDatabaseId}_${number}`;
}

function commentGlobalId(repoDatabaseId, issueNumber, index) {
  return `C_${repoDatabaseId}_${issueNumber}_${index}`;
}

// The identity a commit is authored with. The suite's own fixtures use
// the scenario's viewer; commit bytes must round-trip exactly, so the
// author line is built once per commit from this identity and the
// commit's own timestamp.
export function identityLine(login, email, epochSec) {
  return `${login} <${email}> ${epochSec} +0000`;
}

// One repository: its git objects and refs, plus its issues, labels and
// pull requests. Refs are a Map name -> oid; the default branch is
// 'main' and HEAD points at it.
export class Repository {
  constructor(owner, name, databaseId, isPrivate, description) {
    this.owner = owner;
    this.name = name;
    this.fullName = `${owner}/${name}`;
    this.databaseId = databaseId;
    this.id = repoGlobalId(databaseId);
    this.private = isPrivate;
    this.description = description || '';
    this.defaultBranch = DEFAULT_BRANCH;
    this.store = new ObjectStore();
    this.refs = new Map();
    this.labels = new Map();
    this.issues = [];
    this.nextIssueNumber = 1;
    this.pullRequests = [];
    this.nextPullNumber = 1;
    this.comments = new Map();
    this.nextCommentIndex = 1;
    this.seq = 0;
  }

  // A monotonically increasing sequence number, used to order issues and
  // pull requests deterministically (no wall-clock timestamps in state).
  nextSeq() {
    this.seq += 1;
    return this.seq;
  }

  ref(name) {
    return this.refs.get(name) || null;
  }

  headRefName() {
    return `refs/heads/${this.defaultBranch}`;
  }

  headOid() {
    return this.refs.get(this.headRefName()) || null;
  }

  // The flat file map at a ref: path -> {mode, oid}.
  filesAt(refName) {
    const oid = this.refs.get(refName);
    if (!oid) return new Map();
    const peeled = this.store.peel(oid);
    const object = this.store.getObject(peeled);
    if (!object || object.type !== 'commit') return new Map();
    const commit = parseCommit(object.data);
    if (!commit.tree) return new Map();
    return flattenTree(this.store, commit.tree);
  }

  // The file content at a ref, or null when the path is absent.
  fileAt(refName, path) {
    const files = this.filesAt(refName);
    const entry = files.get(path);
    if (!entry) return null;
    const object = this.store.getObject(entry.oid);
    if (!object || object.type !== 'blob') return null;
    return { data: object.data, oid: entry.oid, mode: entry.mode };
  }
}

// The whole forge: every repository, keyed by "owner/name". Repo ids are
// assigned from a counter so databaseId is stable within a trial.
export class Forge {
  constructor(viewerLogin) {
    this.viewerLogin = viewerLogin || VIEWER_LOGIN;
    this.repos = new Map();
    this.nextDatabaseId = 5000;
  }

  repoKey(owner, name) {
    return `${owner}/${name}`;
  }

  getRepo(owner, name) {
    return this.repos.get(this.repoKey(owner, name)) || null;
  }

  // The viewer's own repositories, in creation order (the pagination
  // check pages them 10 at a time and requires no repeats).
  viewerRepos() {
    const out = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === this.viewerLogin) out.push(repo);
    }
    return out;
  }

  createRepo(name, isPrivate, description) {
    if (typeof name !== 'string' || name === '' || name.length > 100) return null;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return null;
    if (this.getRepo(this.viewerLogin, name)) return null;
    const repo = new Repository(this.viewerLogin, name, this.nextDatabaseId, isPrivate === true, description || '');
    this.nextDatabaseId += 1;
    this.repos.set(this.repoKey(repo.owner, repo.name), repo);
    return repo;
  }

  deleteRepo(owner, name) {
    return this.repos.delete(this.repoKey(owner, name));
  }

  // Create a branch at a commit. Returns false when the branch exists or
  // the commit is unknown.
  createBranch(repo, branch, sha) {
    const ref = `refs/heads/${branch}`;
    if (repo.refs.has(ref)) return false;
    if (!repo.store.has(sha)) return false;
    repo.refs.set(ref, sha);
    return true;
  }

  // Commit one file change on a branch: build the new tree from the
  // branch tip's files plus the change, then a commit on top. When the
  // branch is unborn (no refs yet) the commit has no parent and becomes
  // the default branch tip. Returns {commitSha, contentSha} or null.
  commitFile(repo, branch, path, content, message, authorEpochSec) {
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref) || null;
    const files = new Map();
    if (tip) {
      const peeled = repo.store.peel(tip);
      const object = repo.store.getObject(peeled);
      if (object && object.type === 'commit') {
        const commit = parseCommit(object.data);
        if (commit.tree) {
          for (const [filePath, entry] of flattenTree(repo.store, commit.tree)) {
            files.set(filePath, { mode: entry.mode, data: repo.store.getObject(entry.oid).data });
          }
        }
      }
    }
    const contentBuffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const contentSha = hashObject('blob', contentBuffer);
    files.set(path, { mode: '100644', data: contentBuffer });
    const treeOid = buildTreeFromFiles(repo.store, files);
    const parents = tip ? [repo.store.peel(tip)] : [];
    const author = identityLine(this.viewerLogin, `${this.viewerLogin}@example.invalid`, authorEpochSec || 1700000000);
    const commitData = buildCommit({ tree: treeOid, parents, author, committer: author, message });
    const commitSha = repo.store.putObject('commit', commitData);
    repo.refs.set(ref, commitSha);
    return { commitSha, contentSha };
  }

  // Delete a file on a branch: same as commitFile, minus the path.
  deleteFile(repo, branch, path, message, authorEpochSec) {
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref) || null;
    if (!tip) return null;
    const peeled = repo.store.peel(tip);
    const object = repo.store.getObject(peeled);
    if (!object || object.type !== 'commit') return null;
    const commit = parseCommit(object.data);
    const files = new Map();
    if (commit.tree) {
      for (const [filePath, entry] of flattenTree(repo.store, commit.tree)) {
        files.set(filePath, { mode: entry.mode, data: repo.store.getObject(entry.oid).data });
      }
    }
    if (!files.has(path)) return null;
    files.delete(path);
    const treeOid = buildTreeFromFiles(repo.store, files);
    const author = identityLine(this.viewerLogin, `${this.viewerLogin}@example.invalid`, authorEpochSec || 1700000000);
    const commitData = buildCommit({ tree: treeOid, parents: [peeled], author, committer: author, message });
    const commitSha = repo.store.putObject('commit', commitData);
    repo.refs.set(ref, commitSha);
    return { commitSha };
  }

  createLabel(repo, name, color) {
    if (repo.labels.has(name)) return repo.labels.get(name);
    const label = { name, color: color || 'ededed' };
    repo.labels.set(name, label);
    return label;
  }

  createIssue(repo, title, body, labelNames) {
    const labels = [];
    for (const name of labelNames || []) {
      const label = repo.labels.get(name);
      if (!label) return { error: 'unknown-label', name };
      labels.push(label);
    }
    const number = repo.nextIssueNumber;
    repo.nextIssueNumber += 1;
    const issue = {
      number,
      id: issueGlobalId(repo.databaseId, number),
      title: title || '',
      body: body || '',
      state: 'open',
      labels: labels.map((label) => ({ name: label.name, color: label.color })),
      seq: repo.nextSeq(),
    };
    repo.issues.push(issue);
    return { issue };
  }

  getIssue(repo, number) {
    return repo.issues.find((issue) => issue.number === number) || null;
  }

  patchIssue(repo, number, patch) {
    const issue = this.getIssue(repo, number);
    if (!issue) return null;
    if (patch.state === 'open' || patch.state === 'closed') issue.state = patch.state;
    if (typeof patch.title === 'string') issue.title = patch.title;
    if (typeof patch.body === 'string') issue.body = patch.body;
    return issue;
  }

  addComment(repo, issueNumber, body) {
    const issue = this.getIssue(repo, issueNumber);
    if (!issue) return null;
    const index = repo.nextCommentIndex;
    repo.nextCommentIndex += 1;
    const comment = {
      id: commentGlobalId(repo.databaseId, issueNumber, index),
      body: body || '',
      seq: repo.nextSeq(),
    };
    if (!repo.comments.has(issueNumber)) repo.comments.set(issueNumber, []);
    repo.comments.get(issueNumber).push(comment);
    return comment;
  }

  commentsOf(repo, issueNumber) {
    return repo.comments.get(issueNumber) || [];
  }

  createPull(repo, title, body, headBranch, baseBranch) {
    const headRef = `refs/heads/${headBranch}`;
    const baseRef = `refs/heads/${baseBranch}`;
    const headOid = repo.refs.get(headRef) || null;
    const baseOid = repo.refs.get(baseRef) || null;
    if (!headOid || !baseOid) return { error: 'unknown-branch' };
    const number = repo.nextPullNumber;
    repo.nextPullNumber += 1;
    const pull = {
      number,
      id: pullGlobalId(repo.databaseId, number),
      title: title || '',
      body: body || '',
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: headBranch,
      baseRef: baseBranch,
      headSha: repo.store.peel(headOid),
      baseSha: repo.store.peel(baseOid),
      seq: repo.nextSeq(),
    };
    repo.pullRequests.push(pull);
    return { pull };
  }

  getPull(repo, number) {
    return repo.pullRequests.find((pull) => pull.number === number) || null;
  }

  // The changed paths of a pull request: the diff between the merge-base
  // tree and the head tree (GitHub's three-dot diff).
  pullFiles(repo, pull) {
    const headOid = repo.store.peel(pull.headSha);
    const baseOid = repo.store.peel(pull.baseSha);
    const mergeBase = repo.store.mergeBase(headOid, baseOid);
    const baseFiles = mergeBase ? this.filesAtCommit(repo, mergeBase) : new Map();
    const headFiles = this.filesAtCommit(repo, headOid);
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    const out = [];
    for (const path of paths) {
      const baseEntry = baseFiles.get(path);
      const headEntry = headFiles.get(path);
      if (!baseEntry && headEntry) {
        out.push({ filename: path, status: 'added', additions: 1, deletions: 0, changes: 1 });
      } else if (baseEntry && !headEntry) {
        out.push({ filename: path, status: 'removed', additions: 0, deletions: 1, changes: 1 });
      } else if (baseEntry && headEntry && baseEntry.oid !== headEntry.oid) {
        out.push({ filename: path, status: 'modified', additions: 1, deletions: 1, changes: 2 });
      }
    }
    out.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
    return out;
  }

  filesAtCommit(repo, commitOid) {
    const object = repo.store.getObject(commitOid);
    if (!object || object.type !== 'commit') return new Map();
    const commit = parseCommit(object.data);
    if (!commit.tree) return new Map();
    return flattenTree(repo.store, commit.tree);
  }

  // Whether a pull request can merge cleanly, and the merged file map
  // when it can. A three-way merge of base, head and their merge base:
  // a path changed on both sides to different contents conflicts. The
  // base (and head) are resolved from their branch refs LIVE at merge
  // time — the pull's captured baseSha is only the tip when the pull
  // was opened, and the base may have moved since (a merge of another
  // pull must be able to conflict with this one).
  mergeable(repo, pull) {
    const headOid = repo.store.peel(repo.refs.get(`refs/heads/${pull.headRef}`) || pull.headSha);
    const baseOid = repo.store.peel(repo.refs.get(`refs/heads/${pull.baseRef}`) || pull.baseSha);
    const mergeBase = repo.store.mergeBase(headOid, baseOid);
    if (!mergeBase) return { ok: false, conflict: true, merged: null };
    const baseFiles = this.filesAtCommit(repo, mergeBase);
    const headFiles = this.filesAtCommit(repo, headOid);
    const currentFiles = this.filesAtCommit(repo, baseOid);
    const merged = new Map();
    for (const [path, entry] of currentFiles) merged.set(path, entry);
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...currentFiles.keys()]);
    for (const path of paths) {
      const baseEntry = baseFiles.get(path) || null;
      const headEntry = headFiles.get(path) || null;
      const currentEntry = currentFiles.get(path) || null;
      const baseOidOf = baseEntry ? baseEntry.oid : null;
      const headOidOf = headEntry ? headEntry.oid : null;
      const currentOidOf = currentEntry ? currentEntry.oid : null;
      const headChanged = headOidOf !== baseOidOf;
      const currentChanged = currentOidOf !== baseOidOf;
      if (headChanged && currentChanged && headOidOf !== currentOidOf) {
        return { ok: false, conflict: true, merged: null };
      }
      if (headChanged) {
        if (headEntry) merged.set(path, headEntry);
        else merged.delete(path);
      }
    }
    return { ok: true, conflict: false, merged };
  }

  // Squash-merge a pull request onto its base branch: one commit whose
  // tree is the three-way merge result, parented on the base tip. The
  // pull request closes as merged and reports the merge commit.
  mergePull(repo, pull, authorEpochSec) {
    const check = this.mergeable(repo, pull);
    if (!check.ok) return { error: 'conflict' };
    const baseRef = `refs/heads/${pull.baseRef}`;
    const baseOid = repo.store.peel(repo.refs.get(baseRef));
    const files = new Map();
    for (const [path, entry] of check.merged) {
      const object = repo.store.getObject(entry.oid);
      if (object) files.set(path, { mode: entry.mode, data: object.data });
    }
    const treeOid = buildTreeFromFiles(repo.store, files);
    const author = identityLine(this.viewerLogin, `${this.viewerLogin}@example.invalid`, authorEpochSec || 1700000000);
    const message = `${pull.title} (#${pull.number})`;
    const commitData = buildCommit({ tree: treeOid, parents: [baseOid], author, committer: author, message });
    const mergeSha = repo.store.putObject('commit', commitData);
    repo.refs.set(baseRef, mergeSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergeCommitSha = mergeSha;
    // A deterministic ISO timestamp (the scenario's day one plus the
    // pull's sequence), so two runs agree exactly.
    pull.mergedAt = new Date((1735689600 + pull.seq) * 1000).toISOString().replace('.000Z', 'Z');
    return { pull, mergeSha };
  }

  // The deterministic state export: a canonical JSON document holding
  // only pass/fail bits and counts, never times, ports or dates. Two
  // runs on the same instance produce byte-identical output.
  exportState() {
    const repos = [];
    const sorted = [...this.repos.values()].sort((a, b) => (a.fullName < b.fullName ? -1 : a.fullName > b.fullName ? 1 : 0));
    for (const repo of sorted) {
      const refs = [...repo.refs.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([name, oid]) => ({ name, oid }));
      const objects = [...repo.store.objects.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([oid, object]) => ({ oid, type: object.type, size: object.data.length }));
      const issues = repo.issues.map((issue) => ({
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        labels: issue.labels.map((label) => label.name).sort(),
      }));
      const pulls = repo.pullRequests.map((pull) => ({
        number: pull.number,
        title: pull.title,
        body: pull.body,
        state: pull.state,
        merged: pull.merged,
        head: pull.headRef,
        base: pull.baseRef,
        headSha: pull.headSha,
        baseSha: pull.baseSha,
        mergeCommitSha: pull.mergeCommitSha,
      }));
      const comments = [];
      for (const [issueNumber, list] of [...repo.comments.entries()].sort((a, b) => a[0] - b[0])) {
        for (const comment of list) comments.push({ issue: issueNumber, body: comment.body });
      }
      repos.push({
        owner: repo.owner,
        name: repo.name,
        private: repo.private,
        description: repo.description,
        defaultBranch: repo.defaultBranch,
        refs,
        objects,
        labels: [...repo.labels.keys()].sort(),
        issues,
        pulls,
        comments,
      });
    }
    return JSON.stringify({ version: 1, repos }, null, 0);
  }
}

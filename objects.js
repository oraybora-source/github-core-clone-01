// objects.js — the git object store: trees, commits, tags, refs, and
// reachability. Objects are content-addressed by SHA-1 and held in
// memory; refs are a name -> oid map. All parsing is from the git object
// format, stdlib only.

import { hashObject, ZERO_OID } from './pack.js';

// Parse a tree object into entries: {mode, name, oid}. Entries are
// stored sorted by name with directories sorted as if their name had a
// trailing slash (git's tree order); we keep the stored order as-is.
export function parseTree(data) {
  const entries = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode');
    const mode = data.toString('utf8', offset, space);
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('tree entry has no name');
    const name = data.toString('utf8', space + 1, nul);
    if (nul + 21 > data.length) throw new Error('tree entry has no oid');
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

// Serialize tree entries back to the git tree format. Entries must
// already be in git tree order (directories sort as name + '/').
export function buildTree(entries) {
  const parts = [];
  for (const entry of entries) {
    const head = Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8');
    parts.push(head, Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// Compare two tree entry names the way git sorts them: a directory sorts
// as if its name had a trailing slash.
export function treeNameCompare(a, b) {
  const aName = a.mode === '40000' ? `${a.name}/` : a.name;
  const bName = b.mode === '40000' ? `${b.name}/` : b.name;
  if (aName < bName) return -1;
  if (aName > bName) return 1;
  return 0;
}

// Parse a commit object: {tree, parents, author, committer, message}.
// The author/committer lines keep their raw text (name, email, time,
// zone) so a round-tripped commit is byte-identical.
export function parseCommit(data) {
  const text = data.toString('utf8');
  const headerEnd = text.indexOf('\n\n');
  const header = headerEnd < 0 ? text : text.slice(0, headerEnd);
  const message = headerEnd < 0 ? '' : text.slice(headerEnd + 2);
  const commit = { tree: null, parents: [], author: '', committer: '', message };
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) commit.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) commit.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) commit.author = line.slice(7);
    else if (line.startsWith('committer ')) commit.committer = line.slice(10);
  }
  return commit;
}

// Serialize a commit back to bytes. The message is joined with a blank
// line after the headers, exactly as git writes it.
export function buildCommit(fields) {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents || []) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author}`);
  lines.push(`committer ${fields.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${fields.message || ''}`, 'utf8');
}

// Parse an annotated tag object: {object, type, tag, tagger, message}.
export function parseTag(data) {
  const text = data.toString('utf8');
  const headerEnd = text.indexOf('\n\n');
  const header = headerEnd < 0 ? text : text.slice(0, headerEnd);
  const message = headerEnd < 0 ? '' : text.slice(headerEnd + 2);
  const tag = { object: null, type: null, tag: null, tagger: '', message };
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) tag.object = line.slice(7).trim();
    else if (line.startsWith('type ')) tag.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tag.tagger = line.slice(7);
  }
  return tag;
}

export function buildTag(fields) {
  const lines = [`object ${fields.object}`, `type ${fields.type}`, `tag ${fields.tag}`];
  if (fields.tagger) lines.push(`tagger ${fields.tagger}`);
  return Buffer.from(`${lines.join('\n')}\n\n${fields.message || ''}`, 'utf8');
}

// Flatten a tree into a path -> {mode, oid} map, walking subtrees.
export function flattenTree(store, treeOid, prefix = '', out = new Map()) {
  const tree = store.getObject(treeOid);
  if (!tree || tree.type !== 'tree') return out;
  for (const entry of parseTree(tree.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(store, entry.oid, path, out);
    else out.set(path, { mode: entry.mode, oid: entry.oid });
  }
  return out;
}

// Build a tree object from a flat path -> {mode, data} map, creating the
// intermediate trees. Returns the root tree oid. Every tree is written
// through the store so its oid is stable.
export function buildTreeFromFiles(store, files) {
  // Group files by their directory.
  const root = new Map();
  for (const [path, file] of files) {
    const parts = path.split('/');
    let dir = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i];
      if (!dir.has(part)) dir.set(part, new Map());
      dir = dir.get(part);
    }
    dir.set(parts[parts.length - 1], file);
  }
  const writeDir = (dir) => {
    const entries = [];
    for (const [name, value] of dir) {
      if (value instanceof Map) {
        const subOid = writeDir(value);
        entries.push({ mode: '40000', name, oid: subOid });
      } else {
        const blobOid = store.putObject('blob', value.data);
        entries.push({ mode: value.mode || '100644', name, oid: blobOid });
      }
    }
    entries.sort(treeNameCompare);
    const data = buildTree(entries);
    return store.putObject('tree', data);
  };
  return writeDir(root);
}

// The object store: a Map oid -> {type, data}, plus helpers to walk
// history. Commits carry their parents, so reachability is a walk.
export class ObjectStore {
  constructor() {
    this.objects = new Map();
    // Generation: bumps whenever a NEW object joins the store. A fetch
    // pack is a pure function of (wants, haves, depth, shallow, gen), so
    // a pack cached under a generation is safe to reuse while the
    // generation is unchanged; any object write bumps it and retires
    // the cached pack. Re-adding an already-present oid does not bump.
    this.gen = 0;
  }

  has(oid) {
    return this.objects.has(oid);
  }

  getObject(oid) {
    return this.objects.get(oid) || null;
  }

  putObject(type, data) {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const oid = hashObject(type, buffer);
    if (!this.objects.has(oid)) {
      this.objects.set(oid, { type, data: buffer });
      this.gen += 1;
    }
    return oid;
  }

  putExisting(type, data) {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const oid = hashObject(type, buffer);
    if (!this.objects.has(oid)) {
      this.objects.set(oid, { type, data: buffer });
      this.gen += 1;
    } else {
      this.objects.set(oid, { type, data: buffer });
    }
    return oid;
  }

  // All objects reachable from `oids`, following commit parents, trees,
  // and tag targets. Returns a Set of oids.
  reachable(oids) {
    const seen = new Set();
    const stack = [...oids];
    while (stack.length > 0) {
      const oid = stack.pop();
      if (seen.has(oid) || oid === ZERO_OID) continue;
      const object = this.objects.get(oid);
      if (!object) continue;
      seen.add(oid);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        if (commit.tree) stack.push(commit.tree);
        for (const parent of commit.parents) stack.push(parent);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) stack.push(entry.oid);
      } else if (object.type === 'tag') {
        const tag = parseTag(object.data);
        if (tag.object) stack.push(tag.object);
      }
    }
    return seen;
  }

  // Is `ancestor` an ancestor of `descendant` (or the same commit)?
  // Walks the descendant's parents. Tag objects are peeled first.
  isAncestor(ancestor, descendant) {
    if (ancestor === descendant) return true;
    const seen = new Set();
    const stack = [descendant];
    while (stack.length > 0) {
      const oid = stack.pop();
      if (oid === ancestor) return true;
      if (seen.has(oid) || oid === ZERO_OID) continue;
      seen.add(oid);
      const object = this.objects.get(oid);
      if (!object) continue;
      if (object.type === 'commit') {
        for (const parent of parseCommit(object.data).parents) stack.push(parent);
      } else if (object.type === 'tag') {
        const target = parseTag(object.data).object;
        if (target) stack.push(target);
      }
    }
    return false;
  }

  // The merge base of two commits: the newest commit reachable from both,
  // found by walking both histories together (breadth-first by depth).
  mergeBase(a, b) {
    if (a === b) return a;
    const aSeen = new Map();
    const bSeen = new Map();
    const walkA = [a];
    const walkB = [b];
    let depthA = 0;
    let depthB = 0;
    const expand = (stack, seen, depth) => {
      const next = [];
      for (const oid of stack) {
        if (seen.has(oid) || oid === ZERO_OID) continue;
        seen.set(oid, depth);
        const object = this.objects.get(oid);
        if (object && object.type === 'commit') {
          for (const parent of parseCommit(object.data).parents) next.push(parent);
        }
      }
      return next;
    };
    while (walkA.length > 0 || walkB.length > 0) {
      const nextA = expand(walkA, aSeen, depthA);
      const nextB = expand(walkB, bSeen, depthB);
      walkA.length = 0;
      walkB.length = 0;
      walkA.push(...nextA);
      walkB.push(...nextB);
      depthA += 1;
      depthB += 1;
      // The first commit seen by both walks at the shallowest depth wins.
      let best = null;
      let bestDepth = Infinity;
      for (const [oid, depth] of aSeen) {
        if (bSeen.has(oid) && depth + bSeen.get(oid) < bestDepth) {
          best = oid;
          bestDepth = depth + bSeen.get(oid);
        }
      }
      if (best !== null) return best;
      if (walkA.length === 0 && walkB.length === 0) break;
    }
    return null;
  }

  // The commits reachable from `tip`, newest first (topological order by
  // commit time is not guaranteed; this walks parents depth-first and
  // returns each commit once, tip first).
  walkCommits(tip) {
    const out = [];
    const seen = new Set();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop();
      if (seen.has(oid) || oid === ZERO_OID) continue;
      const object = this.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      seen.add(oid);
      out.push(oid);
      const commit = parseCommit(object.data);
      for (const parent of commit.parents) stack.push(parent);
    }
    return out;
  }

  // Peel a tag to its commit (or the object it points at, recursively).
  peel(oid) {
    let current = oid;
    for (let i = 0; i < 10; i += 1) {
      const object = this.objects.get(current);
      if (!object || object.type !== 'tag') return current;
      current = parseTag(object.data).object;
      if (!current) return oid;
    }
    return current;
  }
}

// smart-http.js — the git smart-HTTP surface: ref advertisements,
// upload-pack (protocol v2 and v0) and receive-pack (v0 only). The
// protocol is implemented from the wire format: pkt-lines, sideband
// framing, packfiles, and the negotiation the suite's git client runs.

import { readPack, writePack, verifyPackChecksum, pktLine, encodePktLines, decodePktLines, sidebandPack, PKT_DELIM, PKT_FLUSH, ZERO_OID } from './pack.js';
import { parseCommit, parseTree, parseTag } from './objects.js';

const AGENT = 'github-core-clone-01/1.0.0';

// The upload-pack capabilities the v0 advertisement lists, and the
// receive-pack capabilities the push advertisement lists.
const UPLOAD_V0_CAPS = [
  'symref=HEAD:refs/heads/main',
  'multi_ack_detailed',
  'multi_ack',
  'thin-pack',
  'side-band-64k',
  'ofs-delta',
  'shallow',
  'agent=' + AGENT,
].join(' ');

const RECEIVE_V0_CAPS = [
  'report-status',
  'report-status-v2',
  'side-band-64k',
  'delete-refs',
  'ofs-delta',
  'agent=' + AGENT,
].join(' ');

// All refs of a repository, sorted by name, with HEAD first. A tag ref
// carries its peeled commit when the tag is annotated.
export function listRefs(repo) {
  const refs = [];
  const head = repo.headOid();
  refs.push({ oid: head || ZERO_OID, name: 'HEAD', symrefTarget: 'refs/heads/main' });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name);
    const entry = { oid, name };
    if (name.startsWith('refs/tags/')) {
      const object = repo.store.getObject(oid);
      if (object && object.type === 'tag') {
        entry.peeled = repo.store.peel(oid);
      }
    }
    refs.push(entry);
  }
  return refs;
}

// The v0 advertisement: the service preamble, a flush, then one line per
// ref. The first ref line carries the capabilities after a NUL byte.
// An empty repository advertises HEAD at the zero oid.
function v0Advertisement(service, caps, refs) {
  const lines = [`# service=${service}\n`, 'flush'];
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} HEAD\0${caps}\n`);
  } else {
    refs.forEach((ref, index) => {
      if (index === 0) lines.push(`${ref.oid} ${ref.name}\0${caps}\n`);
      else lines.push(`${ref.oid} ${ref.name}\n`);
      if (ref.peeled) lines.push(`${ref.peeled} ${ref.name}^{}\n`);
    });
  }
  lines.push('flush');
  return encodePktLines(lines);
}

// The v2 advertisement: "version 2" then one capability per line.
function v2Advertisement() {
  const lines = [
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'object-format=sha1\n',
    'flush',
  ];
  return encodePktLines(lines);
}

// GET /{owner}/{repo}.git/info/refs?service=... — the advertisement.
// Upload-pack honours Git-Protocol: version=2; receive-pack is v0 only.
// A missing repository is a 404 and the server stays up.
export function handleInfoRefs(forge, owner, repoName, service, gitProtocol, send) {
  const repo = forge.getRepo(owner, repoName);
  if (!repo) {
    send(404, 'application/json', JSON.stringify({ message: 'Not Found' }));
    return;
  }
  if (service === 'git-upload-pack') {
    if (gitProtocol === 'version=2') {
      send(200, 'application/x-git-upload-pack-advertisement', v2Advertisement());
    } else {
      send(200, 'application/x-git-upload-pack-advertisement', v0Advertisement('git-upload-pack', UPLOAD_V0_CAPS, listRefs(repo)));
    }
  } else if (service === 'git-receive-pack') {
    send(200, 'application/x-git-receive-pack-advertisement', v0Advertisement('git-receive-pack', RECEIVE_V0_CAPS, listRefs(repo)));
  } else {
    send(400, 'application/json', JSON.stringify({ message: 'unknown service' }));
  }
}

// The objects a client already holds: everything reachable from the
// haves, except the history below a shallow boundary. A shallow commit
// is held with its tree and blobs, but not its parents.
function heldObjectSet(store, haves, shallowBoundaries) {
  const held = new Set();
  const queue = [...haves];
  const cut = new Set(shallowBoundaries);
  while (queue.length > 0) {
    const oid = queue.pop();
    if (held.has(oid) || oid === ZERO_OID) continue;
    const object = store.getObject(oid);
    if (!object) continue;
    held.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      if (commit.tree) queue.push(commit.tree);
      if (!cut.has(oid)) {
        for (const parent of commit.parents) queue.push(parent);
      }
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) queue.push(entry.oid);
    } else if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      if (target) queue.push(target);
    }
  }
  return held;
}

// The object set a fetch must deliver: everything reachable from the
// wants, minus everything the client already holds, bounded by depth
// when the client asked for a shallow fetch.
function fetchObjectSet(repo, wants, haves, depth, shallowBoundaries) {
  const store = repo.store;
  const held = heldObjectSet(store, haves, shallowBoundaries);
  const wanted = new Set();
  const shallow = new Set();
  const unshallow = new Set();
  if (depth !== null && depth !== undefined && depth > 0) {
    // Commits within `depth` generations of a want (a want is generation
    // 1). The deepest generation reached is the new shallow boundary.
    const seenCommits = new Set();
    let frontier = [...wants];
    let deepest = [];
    for (let level = 0; level < depth && frontier.length > 0; level += 1) {
      const next = [];
      for (const oid of frontier) {
        if (seenCommits.has(oid) || oid === ZERO_OID) continue;
        seenCommits.add(oid);
        const object = store.getObject(oid);
        if (!object) continue;
        if (object.type === 'tag') {
          const target = parseTag(object.data).object;
          if (target) next.push(target);
          continue;
        }
        if (object.type !== 'commit') continue;
        for (const parent of parseCommit(object.data).parents) next.push(parent);
      }
      deepest = [...frontier].filter((oid) => seenCommits.has(oid));
      frontier = next;
    }
    // Deliver the seen commits plus their trees and blobs. Parents are
    // followed only when the parent is itself a seen commit, so nothing
    // below the boundary is delivered.
    const kept = new Set();
    const queue = [...seenCommits];
    while (queue.length > 0) {
      const oid = queue.pop();
      if (kept.has(oid) || oid === ZERO_OID) continue;
      const object = store.getObject(oid);
      if (!object) continue;
      kept.add(oid);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        if (commit.tree) queue.push(commit.tree);
        for (const parent of commit.parents) {
          if (seenCommits.has(parent)) queue.push(parent);
        }
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) queue.push(entry.oid);
      } else if (object.type === 'tag') {
        const target = parseTag(object.data).object;
        if (target) queue.push(target);
      }
    }
    for (const oid of kept) {
      if (!held.has(oid)) wanted.add(oid);
    }
    for (const oid of deepest) {
      if (wanted.has(oid)) shallow.add(oid);
    }
    for (const oid of shallowBoundaries) {
      if (!shallow.has(oid) && held.has(oid)) unshallow.add(oid);
    }
  } else {
    const reachable = store.reachable(wants);
    for (const oid of reachable) {
      if (!held.has(oid)) wanted.add(oid);
    }
  }
  return { wanted, shallow, unshallow };
}

// Parse the v2 fetch command: the lines between "command=fetch" and the
// flush. Returns {wants, haves, shallow, depth, filter}.
function parseV2Fetch(lines) {
  const wants = [];
  const haves = [];
  const shallow = [];
  let depth = null;
  let filter = null;
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text.startsWith('want ')) wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) depth = parseInt(text.slice(7), 10);
    else if (text.startsWith('deepen-since ')) depth = null;
    else if (text.startsWith('filter ')) filter = text.slice(7).trim();
  }
  return { wants, haves, shallow, depth, filter };
}

// Parse the v0 fetch request: wants (with shallow/deepen) up to the first
// flush, then haves and done up to the second flush.
function parseV0Fetch(packets) {
  const wants = [];
  const haves = [];
  const shallow = [];
  let depth = null;
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (text.startsWith('want ')) {
        wants.push(text.slice(5).split(' ')[0]);
      } else if (text.startsWith('shallow ')) shallow.push(text.slice(8).trim());
      else if (text.startsWith('deepen ')) depth = parseInt(text.slice(7), 10);
    } else {
      if (text.startsWith('have ')) haves.push(text.slice(5).trim());
    }
  }
  return { wants, haves, shallow, depth };
}

// Build the v2 fetch response: acknowledgments, shallow-info and the
// packfile section, in order. Sections are separated by a delim packet
// (0001) and the response ends with a flush (0000), as protocol v2
// requires. The acknowledgments section only appears when the client
// sent haves: the server ACKs the haves it holds, then "ready", or
// NAK when it holds none of them. A clone sends no haves, so it gets
// no acknowledgments section at all.
function v2FetchResponse(repo, request, result) {
  const parts = [];
  if (request.haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    const held = request.haves.filter((oid) => repo.store.has(oid));
    if (held.length > 0) {
      for (const oid of held) parts.push(pktLine(`ACK ${oid}\n`));
      parts.push(pktLine('ready\n'));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(PKT_DELIM);
  }
  if (result.shallow.size > 0 || result.unshallow.size > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of [...result.shallow].sort()) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of [...result.unshallow].sort()) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandPack(result.pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// Build the v0 fetch response: NAK or ACK lines for the haves, shallow
// lines, then the sideband pack. In v0 the response is a flat stream of
// pkt-lines; the pack data ends the response.
function v0FetchResponse(repo, request, result) {
  const parts = [];
  if (request.haves.length > 0) {
    const held = request.haves.filter((oid) => repo.store.has(oid));
    if (held.length > 0) {
      for (const oid of held) parts.push(pktLine(`ACK ${oid}\n`));
    } else {
      parts.push(pktLine('NAK\n'));
    }
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const oid of [...result.shallow].sort()) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of [...result.unshallow].sort()) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(sidebandPack(result.pack));
  return Buffer.concat(parts);
}

// Run an upload-pack fetch: compute the object set, build the pack (full
// objects, no deltas), and answer in the protocol version the client
// spoke. `request` is the parsed fetch (wants, haves, shallow, depth).
export function runFetch(repo, request, protocol) {
  const result = fetchObjectSet(repo, request.wants, request.haves, request.depth, request.shallow);
  const objects = [];
  for (const oid of [...result.wanted].sort()) {
    const object = repo.store.getObject(oid);
    if (object) objects.push({ type: object.type, data: object.data });
  }
  const pack = writePack(objects);
  const response = { pack, shallow: result.shallow, unshallow: result.unshallow };
  return protocol === 2 ? v2FetchResponse(repo, request, response) : v0FetchResponse(repo, request, response);
}

// Handle a v2 ls-refs command. The request lines carry peel, symrefs,
// unborn and ref-prefix arguments; the answer lists the matching refs
// with symref-target and peeled attributes.
export function handleLsRefs(repo, lines) {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes = [];
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text === 'peel') peel = true;
    else if (text === 'symrefs') symrefs = true;
    else if (text === 'unborn') unborn = true;
    else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice(11));
  }
  const refs = listRefs(repo);
  const out = [];
  for (const ref of refs) {
    if (prefixes.length > 0 && !prefixes.some((prefix) => ref.name.startsWith(prefix))) continue;
    if (ref.name === 'HEAD') {
      if (ref.oid === ZERO_OID) {
        if (unborn) out.push(`unborn HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`);
        continue;
      }
      const attrs = symrefs && ref.symrefTarget ? ` symref-target:${ref.symrefTarget}` : '';
      out.push(`${ref.oid} HEAD${attrs}\n`);
      continue;
    }
    let line = `${ref.oid} ${ref.name}`;
    if (peel && ref.peeled) line += ` peeled:${ref.peeled}`;
    out.push(`${line}\n`);
  }
  out.push('flush');
  return encodePktLines(out);
}

// Handle a v2 command on git-upload-pack: ls-refs or fetch. The body is
// pkt-lines: the command, the arguments, a delim, then the arguments,
// then a flush.
export function handleUploadPackV2(forge, owner, repoName, body, send) {
  const repo = forge.getRepo(owner, repoName);
  if (!repo) {
    send(404, 'application/json', JSON.stringify({ message: 'Not Found' }));
    return;
  }
  let packets;
  try {
    packets = decodePktLines(body);
  } catch (error) {
    send(400, 'application/json', JSON.stringify({ message: `bad pkt-line framing: ${error.message}` }));
    return;
  }
  const lines = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
    else if (packet.kind === 'flush') break;
  }
  const command = (lines[0] || '').replace(/\n$/, '');
  if (command === 'command=ls-refs') {
    send(200, 'application/x-git-upload-pack-result', handleLsRefs(repo, lines.slice(1)));
  } else if (command === 'command=fetch') {
    const request = parseV2Fetch(lines.slice(1));
    send(200, 'application/x-git-upload-pack-result', runFetch(repo, request, 2));
  } else {
    send(400, 'application/json', JSON.stringify({ message: `unknown command ${command}` }));
  }
}

// Handle a v0 upload-pack request (a fetch): wants, then haves, then the
// pack in sideband framing.
export function handleUploadPackV0(forge, owner, repoName, body, send) {
  const repo = forge.getRepo(owner, repoName);
  if (!repo) {
    send(404, 'application/json', JSON.stringify({ message: 'Not Found' }));
    return;
  }
  let packets;
  try {
    packets = decodePktLines(body);
  } catch (error) {
    send(400, 'application/json', JSON.stringify({ message: `bad pkt-line framing: ${error.message}` }));
    return;
  }
  const request = parseV0Fetch(packets);
  send(200, 'application/x-git-upload-pack-result', runFetch(repo, request, 0));
}

// Handle a receive-pack push (v0 only). The body is pkt-lines of
// "<old> <new> <ref>" (the first line carries the capabilities after a
// NUL), a flush, then the raw pack bytes. Every update must fast-forward;
// a non-fast-forward update is refused per ref and the ref does not move.
// The report is sideband band 1 when the client asked for side-band-64k.
export function handleReceivePack(forge, owner, repoName, body, send) {
  const repo = forge.getRepo(owner, repoName);
  if (!repo) {
    send(404, 'application/json', JSON.stringify({ message: 'Not Found' }));
    return;
  }
  // Split the command list from the pack: the first flush ends it.
  let flushAt = -1;
  let offset = 0;
  while (offset + 4 <= body.length) {
    const length = parseInt(body.toString('ascii', offset, offset + 4), 16);
    if (Number.isNaN(length) || length < 0) {
      send(400, 'application/json', JSON.stringify({ message: 'bad pkt-line framing' }));
      return;
    }
    if (length === 0) {
      flushAt = offset + 4;
      break;
    }
    if (length === 1) {
      offset += 4;
      continue;
    }
    offset += length;
  }
  if (flushAt < 0) {
    send(400, 'application/json', JSON.stringify({ message: 'receive-pack has no command list' }));
    return;
  }
  let commands;
  try {
    commands = decodePktLines(body.subarray(0, flushAt - 4));
  } catch (error) {
    send(400, 'application/json', JSON.stringify({ message: `bad pkt-line framing: ${error.message}` }));
    return;
  }
  const updates = [];
  let sideband = false;
  for (const packet of commands) {
    if (packet.kind !== 'data') continue;
    let text = packet.payload.toString('utf8');
    const nul = text.indexOf('\0');
    if (nul >= 0) {
      const caps = text.slice(nul + 1);
      if (caps.includes('side-band-64k')) sideband = true;
      text = text.slice(0, nul);
    }
    const line = text.replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length < 3) continue;
    updates.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }
  // The pack follows the flush. A command list that creates or updates a
  // ref always carries a pack, even an empty one; a delete-only list
  // carries none.
  const packBytes = body.subarray(flushAt);
  const hasUpdate = updates.some((update) => update.newOid !== ZERO_OID);
  let incoming = new Map();
  if (hasUpdate) {
    if (packBytes.length === 0) {
      send(400, 'application/json', JSON.stringify({ message: 'receive-pack update carries no pack' }));
      return;
    }
    try {
      const checksum = verifyPackChecksum(packBytes);
      if (!checksum.ok) {
        send(400, 'application/json', JSON.stringify({ message: 'pack checksum mismatch' }));
        return;
      }
      incoming = readPack(packBytes).objects;
    } catch (error) {
      send(400, 'application/json', JSON.stringify({ message: `bad pack: ${error.message}` }));
      return;
    }
    for (const [oid, object] of incoming) {
      if (!repo.store.has(oid)) repo.store.putExisting(object.type, object.data);
    }
  }
  // Apply the updates, one ref at a time. A non-fast-forward update is
  // refused; the others still apply.
  const report = ['unpack ok\n'];
  for (const update of updates) {
    const current = repo.refs.get(update.ref) || ZERO_OID;
    if (update.newOid === ZERO_OID) {
      // A delete: the old value must match, then the ref goes away.
      if (update.oldOid !== ZERO_OID && update.oldOid !== current) {
        report.push(`ng ${update.ref} non-fast-forward\n`);
      } else {
        repo.refs.delete(update.ref);
        report.push(`ok ${update.ref}\n`);
      }
      continue;
    }
    if (update.oldOid === ZERO_OID) {
      // A create: the ref must not exist yet.
      if (current !== ZERO_OID) {
        report.push(`ng ${update.ref} non-fast-forward\n`);
        continue;
      }
      if (!repo.store.has(update.newOid)) {
        report.push(`ng ${update.ref} object not found\n`);
        continue;
      }
      repo.refs.set(update.ref, update.newOid);
      report.push(`ok ${update.ref}\n`);
      continue;
    }
    // An update: the old value must match, and the new tip must descend
    // from the old one (fast-forward).
    if (update.oldOid !== current) {
      report.push(`ng ${update.ref} non-fast-forward\n`);
      continue;
    }
    if (!repo.store.has(update.newOid)) {
      report.push(`ng ${update.ref} object not found\n`);
      continue;
    }
    if (!repo.store.isAncestor(current, update.newOid)) {
      report.push(`ng ${update.ref} non-fast-forward\n`);
      continue;
    }
    repo.refs.set(update.ref, update.newOid);
    report.push(`ok ${update.ref}\n`);
  }
  // The report-status stream is pkt-lined: each report line is its own
  // pkt-line, and the stream ends with a flush. With side-band-64k those
  // pkt-lines ride inside band-1 packets, and the flush that ends the
  // report rides inside band 1 too — without it git reads the report,
  // then hits EOF on the demultiplexed stream and reports "the remote
  // end hung up unexpectedly". A bare flush ends the sideband stream.
  // Without sideband the body is the pkt-line stream directly, flush
  // terminated. A raw text report makes real git fail with "bad line
  // length character".
  const framedReport = Buffer.concat([encodePktLines(report), Buffer.from('0000', 'ascii')]);
  if (sideband) {
    const parts = [];
    const CHUNK = 65520;
    for (let at = 0; at < framedReport.length; at += CHUNK) {
      const chunk = framedReport.subarray(at, Math.min(at + CHUNK, framedReport.length));
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
    }
    parts.push(Buffer.from('0000', 'ascii'));
    send(200, 'application/x-git-receive-pack-result', Buffer.concat(parts));
  } else {
    send(200, 'application/x-git-receive-pack-result', framedReport);
  }
}

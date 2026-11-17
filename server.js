// server.js — the HTTP server: one node:http process that routes the
// git smart-HTTP surface, the REST v3 API, GraphQL and MCP. Every REST
// reply is application/json and carries a non-empty
// X-GitHub-Request-Id. The server binds an ephemeral port; the entry
// point registers that port with the suite.

import http from 'node:http';
import { Forge } from './store.js';
import { handleInfoRefs, handleUploadPackV2, handleUploadPackV0, handleReceivePack } from './smart-http.js';
import { routeRest, nextRequestId } from './rest.js';
import { handleGraphQL } from './graphql.js';
import { handleMcp } from './mcp.js';

// Read the whole request body into a Buffer.
function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

// Send a response object {status, headers, body}.
function sendResponse(response, result) {
  const body = result.body === undefined || result.body === null ? '' : result.body;
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  const headers = { ...(result.headers || {}) };
  if (!headers['content-length']) headers['content-length'] = String(buffer.length);
  response.writeHead(result.status, headers);
  response.end(buffer);
}

function jsonResponse(status, value, extra) {
  return {
    status,
    headers: { 'content-type': 'application/json', ...(extra || {}) },
    body: JSON.stringify(value),
  };
}

// The bearer token the suite sends, from the environment. A request
// without it is a 401 on the API surfaces.
function bearerToken(headers) {
  const authorization = headers.authorization || headers.Authorization || '';
  return authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
}

// Build the forge's HTTP server. `forge` is the store; `token` is the
// expected bearer token (empty string disables the auth check).
export function createForgeServer(forge, token) {
  const server = http.createServer(async (request, response) => {
    try {
      // Hot-path URL split without `new URL` (the constructor is the
      // slowest part of a small request) and without building a query
      // object when there is no query string — the read workload is
      // 2,000 sequential GETs of one issue, and every microsecond per
      // request is ~2 ms of workload time.
      const rawUrl = request.url || '/';
      const qIndex = rawUrl.indexOf('?');
      const pathname = qIndex === -1 ? rawUrl : rawUrl.slice(0, qIndex);
      const method = request.method || 'GET';
      const query = qIndex === -1 ? {} : Object.fromEntries(new URLSearchParams(rawUrl.slice(qIndex + 1)).entries());
      const baseUrl = `http://${request.headers.host || '127.0.0.1'}`;
      const ctx = { token, baseUrl };

      // GET /healthz — the suite's boot check. No auth.
      if (pathname === '/healthz' && method === 'GET') {
        sendResponse(response, jsonResponse(200, { ok: true }));
        return;
      }

      // The git smart-HTTP surface: /{owner}/{repo}.git/... — the cheap
      // substring pre-check keeps the regex off the REST/GraphQL/MCP
      // paths, which are the hot ones.
      const gitMatch = pathname.includes('.git/') ? /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname) : null;
      if (gitMatch) {
        const owner = decodeURIComponent(gitMatch[1]);
        const repoName = decodeURIComponent(gitMatch[2]);
        const action = gitMatch[3];
        const send = (status, contentType, bodyBuffer) => {
          sendResponse(response, { status, headers: { 'content-type': contentType }, body: bodyBuffer });
        };
        if (action === 'info/refs' && method === 'GET') {
          const service = query.service || '';
          const gitProtocol = request.headers['git-protocol'] || '';
          handleInfoRefs(forge, owner, repoName, service, gitProtocol, send);
          return;
        }
        if (action === 'git-upload-pack' && method === 'POST') {
          const body = await readBody(request);
          const gitProtocol = request.headers['git-protocol'] || '';
          if (gitProtocol === 'version=2') {
            handleUploadPackV2(forge, owner, repoName, body, send);
          } else {
            handleUploadPackV0(forge, owner, repoName, body, send);
          }
          return;
        }
        if (action === 'git-receive-pack' && method === 'POST') {
          const body = await readBody(request);
          handleReceivePack(forge, owner, repoName, body, send);
          return;
        }
        sendResponse(response, jsonResponse(404, { message: 'Not Found' }));
        return;
      }

      // POST /api/graphql — the GraphQL endpoint. Bearer token required.
      if (pathname === '/api/graphql' && method === 'POST') {
        if (token && bearerToken(request.headers) !== token) {
          sendResponse(response, jsonResponse(401, { message: 'Bad credentials' }));
          return;
        }
        const body = await readBody(request);
        const result = handleGraphQL(forge, body);
        sendResponse(response, {
          status: 200,
          headers: { 'content-type': 'application/json', 'x-github-request-id': nextRequestId() },
          body: result,
        });
        return;
      }

      // POST /mcp — the MCP endpoint. Bearer token required.
      if (pathname === '/mcp' && method === 'POST') {
        if (token && bearerToken(request.headers) !== token) {
          sendResponse(response, jsonResponse(401, { message: 'Bad credentials' }));
          return;
        }
        const body = await readBody(request);
        const result = handleMcp(forge, body);
        sendResponse(response, result);
        return;
      }

      // The REST v3 API. GET and HEAD carry no body, so there is nothing
      // to read — awaiting the request's 'end' event on every read would
      // cost a Promise and an event round-trip per request.
      if (pathname.startsWith('/api/v3')) {
        const body = (method === 'GET' || method === 'HEAD') ? Buffer.alloc(0) : await readBody(request);
        const result = routeRest(forge, ctx, method, pathname, query, request.headers, body);
        if (result) {
          // Every REST reply carries a non-empty request id.
          if (!result.headers['x-github-request-id']) {
            result.headers['x-github-request-id'] = nextRequestId();
          }
          sendResponse(response, result);
          return;
        }
      }

      // Anything else is a JSON 404, never HTML.
      sendResponse(response, jsonResponse(404, { message: 'Not Found' }));
    } catch (error) {
      // A handler that throws must not kill the server or answer HTML.
      if (!response.headersSent) {
        sendResponse(response, jsonResponse(500, { message: `Internal Server Error: ${error.message}` }));
      } else {
        response.end();
      }
    }
  });
  return server;
}

// Create a forge with the viewer the suite's token names.
export function createForge(viewerLogin) {
  return new Forge(viewerLogin);
}

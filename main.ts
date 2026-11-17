// main.ts — the entry point. The lifecycle the suite expects:
//   1. start an HTTP server on an ephemeral port (listen(0), never 8080),
//   2. POST {"port": N} to $MAKEFUN_ENV_URL/register,
//   3. poll GET $MAKEFUN_ENV_URL/done until {"done": true},
//   4. exit 0.
// The forge itself is a single process: git smart HTTP, REST v3,
// GraphQL and MCP, all in memory, no external services.

import { createForgeServer, createForge } from './server.js';

const token = process.env.MAKEFUN_SHOP_TOKEN || '';
const envUrl = (process.env.MAKEFUN_ENV_URL || '').replace(/\/$/, '');
const forge = createForge('adaiversen');
const server = createForgeServer(forge, token);

server.listen(0, '0.0.0.0', async () => {
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  if (!envUrl) {
    // No suite beside us (a local run): just serve on the port.
    console.log(`github-core-clone-01 listening on http://127.0.0.1:${port}`);
    return;
  }
  // Register the port with the suite. The first register wins.
  try {
    await fetch(`${envUrl}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port }),
    });
  } catch (error) {
    console.error(`register failed: ${error.message}`);
  }
  // Poll until the suite says the trial is done; never hold a request
  // open, never exit early.
  for (;;) {
    try {
      const response = await fetch(`${envUrl}/done`);
      const data = await response.json();
      if (data && data.done === true) break;
    } catch (error) {
      // A transient failure is not a reason to exit; keep polling.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  server.close(() => process.exit(0));
});

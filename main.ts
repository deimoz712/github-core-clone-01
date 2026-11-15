// main.ts — lifecycle of the github-core-clone-01 forge entry.
//
// The suite (env) boots this process and drives it as its only client:
//   1. this process binds an ephemeral port of its own (never 8080),
//   2. it registers that port with the env at $MAKEFUN_ENV_URL/register,
//   3. it serves requests until the env reports GET $MAKEFUN_ENV_URL/done
//      as {"done": true} — it must not exit before that,
//   4. then it closes the server and exits 0; the env writes the export.
// The forge itself (routing, auth, git smart HTTP, REST v3, GraphQL, MCP)
// lives in app.ts; this file only owns the boot/register/wait/exit loop.

import { createApp } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const DONE_POLL_MS = 500;
const REGISTER_ATTEMPTS = 10;
const REGISTER_RETRY_MS = 200;
const SHUTDOWN_GRACE_MS = 2000;

function die(message: string): never {
  console.error(`main: ${message}`);
  process.exit(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** POST {"port": N} to the env's /register. First registration wins; 409 means another entry already won. */
async function register(envUrl: string, port: number): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= REGISTER_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (response.status === 409) {
        die('register rejected with 409: another entry already registered');
      }
      if (!response.ok) {
        die(`register failed: HTTP ${response.status}`);
      }
      return;
    } catch (err) {
      lastError = err;
      if (attempt < REGISTER_ATTEMPTS) await sleep(REGISTER_RETRY_MS);
    }
  }
  die(`register failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

/** Poll GET /done until the env answers {"done": true}. */
async function waitForDone(envUrl: string): Promise<void> {
  for (;;) {
    try {
      const response = await fetch(`${envUrl}/done`);
      if (response.ok) {
        const body = (await response.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env may be briefly unreachable; keep polling.
    }
    await sleep(DONE_POLL_MS);
  }
}

async function main(): Promise<void> {
  if (ENV_URL === '') {
    die('MAKEFUN_ENV_URL is not set');
  }
  const server = createApp();
  const port = await new Promise<number>((resolve, reject) => {
    const onError = (err: Error): void => {
      reject(err);
    };
    server.once('error', onError);
    server.listen(0, () => {
      server.removeListener('error', onError);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('server.address() did not return a port'));
        return;
      }
      resolve(address.port);
    });
  });
  console.error(`main: listening on port ${port}`);

  // Stop serving promptly if the process is signalled; the normal path
  // is the /done poll below, this only keeps a killed run from hanging.
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS);
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);

  await register(ENV_URL, port);
  console.error('main: registered with env, waiting for done');
  await waitForDone(ENV_URL);
  console.error('main: env reports done, exiting');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS);
}

main().catch((err: unknown) => {
  die(err instanceof Error ? err.message : String(err));
});

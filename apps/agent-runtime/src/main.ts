/**
 * Agent_Runtime entrypoint — zoc-agent-chat-rebuild R3.1, R3.2, R3.5, R3.6, R4.1.
 *
 * Binds `127.0.0.1:0` — loopback only, kernel-assigned port — and prints
 * `ZOC_RUNTIME_PORT=<n>` on stdout as its first line. Desktop_Core's supervisor
 * parses that line; nothing else about the handshake is negotiated.
 *
 * Loopback is not a configuration option. There is no host flag to set, and
 * `assertLoopbackBindHost` refuses anything else, because a runtime that holds
 * provider keys and can write the workspace must not be reachable off-box.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import process from "node:process";

import { createAdmission, refusalEnvelope, type Admit } from "./http/admission.ts";
import { ErrorCode, HttpError, envelope, type ErrorEnvelope } from "./http/errors.ts";
import { defaultRoute } from "./composition.ts";

/** The one line Desktop_Core's supervisor greps for (R3.2). */
export const PORT_LINE_PREFIX = "ZOC_RUNTIME_PORT=";

/** The only host this process will bind. */
export const BIND_HOST = "127.0.0.1";

export interface RuntimeEnv {
  /** Per-launch bearer token, 32 CSPRNG bytes base64url, from Desktop_Core. */
  readonly token: string;
  /** Base URL of the retained Python Workspace_Services surface. */
  readonly workspaceServicesUrl: string;
  /** Absolute path of the open workspace root. */
  readonly workspaceRoot: string;
}

export class StartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StartupError";
  }
}

/**
 * Read the launch environment, failing loudly on anything missing.
 *
 * No silent fallbacks: a runtime that starts without a token would accept any
 * loopback caller, and a runtime that starts without a workspace root would
 * resolve relative paths against whatever directory the supervisor happened to
 * spawn it from.
 */
export function readEnv(env: NodeJS.ProcessEnv = process.env): RuntimeEnv {
  const token = env.ZOC_RUNTIME_TOKEN ?? "";
  if (token.length === 0) {
    throw new StartupError(
      "ZOC_RUNTIME_TOKEN is not set. Desktop_Core must generate a per-launch " +
        "token and pass it in the child environment.",
    );
  }
  const workspaceServicesUrl = env.ZOC_WORKSPACE_SERVICES_URL ?? "";
  if (workspaceServicesUrl.length === 0) {
    throw new StartupError("ZOC_WORKSPACE_SERVICES_URL is not set.");
  }
  const workspaceRoot = env.ZOC_STUDIO_WORKSPACE ?? "";
  if (workspaceRoot.length === 0) {
    throw new StartupError("ZOC_STUDIO_WORKSPACE is not set.");
  }
  return { token, workspaceServicesUrl, workspaceRoot };
}

export function assertLoopbackBindHost(host: string): void {
  if (host !== BIND_HOST) {
    throw new StartupError(`Agent_Runtime binds ${BIND_HOST} only; refusing to bind ${host}.`);
  }
}

function writeEnvelope(res: ServerResponse, status: number, env: ErrorEnvelope): void {
  const body = JSON.stringify(env);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

export type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

/**
 * Compose admission with the route table.
 *
 * Admission runs on every request including `/health`, because the loopback
 * check applies to `/health` too — it is only the *token* that `/health` skips.
 */
export function createRequestListener(admit: Admit, route: RouteHandler): RouteHandler {
  return async function onRequest(req, res) {
    const verdict = admit(req as Parameters<Admit>[0]);
    if (!verdict.ok) {
      // The body comes from `admission.ts` rather than being composed here, so
      // the refusal text lives with the decision and stays identifier-free.
      writeEnvelope(res, verdict.status, refusalEnvelope(verdict.code));
      return;
    }

    try {
      await route(req, res);
    } catch (cause) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (cause instanceof HttpError) {
        writeEnvelope(res, cause.status, cause.envelope);
        return;
      }
      // Nothing from an unexpected throw reaches the caller: an internal
      // message can carry a path or a stack, and neither belongs on the wire.
      writeEnvelope(
        res,
        500,
        envelope(ErrorCode.INTERNAL, "The agent runtime hit an unexpected error.", {
          retryable: true,
        }),
      );
    }
  };
}

export interface StartedRuntime {
  readonly port: number;
  close(): Promise<void>;
}

export async function start(options: {
  env?: NodeJS.ProcessEnv;
  host?: string;
  /** Injected in tests; production supplies the real route table. */
  route?: RouteHandler;
  log?: (line: string) => void;
}): Promise<StartedRuntime> {
  const host = options.host ?? BIND_HOST;
  assertLoopbackBindHost(host);

  const runtimeEnv = readEnv(options.env);
  const admit = createAdmission({ token: runtimeEnv.token });

  // The token is captured by `createAdmission`'s closure; scrub the copy
  // `process.env` holds so a child process spawned later cannot inherit it and
  // so a `process.env` dump in a log or crash handler does not carry it.
  //
  // What this does *not* do, and should not be read as doing: on Linux,
  // `/proc/<pid>/environ` keeps the environment as it was at `execve` time, so a
  // local reader with the right privileges can still recover the token from
  // there. Closing that hole needs a different handoff mechanism (a pipe or a
  // unix socket) and is not what R3.4 asks for; the token's per-launch scope is
  // what bounds the damage.
  if ((options.env ?? process.env) === process.env) {
    delete process.env.ZOC_RUNTIME_TOKEN;
  }

  // The token must be scrubbed *before* the route table is built, because building it
  // reads `process.env` for the bridge URL and the key endpoint — and `composition.ts`
  // captures the token from `runtimeEnv`, which is the copy that survives.
  const route = options.route ?? defaultRoute(runtimeEnv);
  const server = createServer(createRequestListener(admit, route));

  // A stalled reader must not hold a socket forever, but a long Run's SSE
  // stream must not be reaped either — so headers get a timeout and bodies
  // do not.
  server.headersTimeout = 30_000;
  server.requestTimeout = 0;
  server.keepAliveTimeout = 65_000;

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new StartupError("listen() returned no numeric port"));
        return;
      }
      resolve(address.port);
    });
  });

  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  log(`${PORT_LINE_PREFIX}${port}`);

  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}

/**
 * Start the runtime and install signal handlers.
 *
 * Lives here rather than behind an `import.meta.main`-style guard because there
 * is no portable one: under `node --experimental-strip-types` the entry is
 * `main.ts`, under `pkg` it is a path inside the snapshot filesystem, and a
 * heuristic over `process.argv[1]` silently fails in the second case — the
 * packaged binary starts, matches nothing, and exits 0 having done nothing at
 * all. `src/bin.ts` calls this explicitly instead, so the entrypoint is a fact
 * about the module graph rather than a guess about the runtime.
 */
export async function main(): Promise<void> {
  const runtime = await start({});
  const shutdown = () => {
    void runtime.close().then(() => process.exit(0));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

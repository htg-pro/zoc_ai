/**
 * Agent_Runtime HTTP router — zoc-agent-chat-rebuild R3.5, R5.1, R6.2, R7.5.
 *
 * A hand-rolled table rather than a framework, for one reason that outranks
 * ergonomics: `@yao-pkg/pkg` resolves `require` statically against a snapshot
 * filesystem, so every dynamic module load in the dependency graph is a module
 * silently missing from the packaged binary (R4.3). `node:http` plus this table
 * has no dynamic load anywhere in it.
 *
 * Handlers throw `HttpError` to produce a non-2xx body. Nothing here catches —
 * `createRequestListener` in `main.ts` owns the one conversion from throw to
 * envelope, so there is exactly one place a leaked internal message could
 * escape and it is guarded there.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { ErrorCode, HttpError, envelope } from "./errors.ts";
import type { RuntimeEnv } from "../main.ts";

export type Method = "GET" | "POST" | "PATCH" | "DELETE";

export interface RequestContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  /** Path parameters captured by the route pattern, e.g. `{ id: "run_7" }`. */
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  readonly env: RuntimeEnv;
}

export type Handler = (ctx: RequestContext) => void | Promise<void>;

interface Route {
  readonly method: Method;
  /** Segments; a leading `:` marks a parameter. */
  readonly segments: readonly string[];
  readonly handler: Handler;
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}

export function noContent(res: ServerResponse): void {
  res.writeHead(204, { "cache-control": "no-store" });
  res.end();
}

function splitPath(path: string): string[] {
  return path.split("/").filter((segment) => segment.length > 0);
}

export class Router {
  private readonly routes: Route[] = [];

  add(method: Method, pattern: string, handler: Handler): this {
    this.routes.push({ method, segments: splitPath(pattern), handler });
    return this;
  }

  get(pattern: string, handler: Handler): this {
    return this.add("GET", pattern, handler);
  }

  post(pattern: string, handler: Handler): this {
    return this.add("POST", pattern, handler);
  }

  patch(pattern: string, handler: Handler): this {
    return this.add("PATCH", pattern, handler);
  }

  delete(pattern: string, handler: Handler): this {
    return this.add("DELETE", pattern, handler);
  }

  /**
   * Resolve one request.
   *
   * A path that matches under a different method answers 405 rather than 404,
   * because "you used the wrong verb" and "there is nothing here" are different
   * facts and conflating them makes a client debug the wrong thing.
   */
  match(method: string, path: string): { route: Route; params: Record<string, string> } | 405 | 404 {
    const segments = splitPath(path);
    let pathMatchedUnderOtherMethod = false;

    for (const route of this.routes) {
      if (route.segments.length !== segments.length) continue;

      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < route.segments.length; i += 1) {
        const pattern = route.segments[i] as string;
        const actual = segments[i] as string;
        if (pattern.startsWith(":")) {
          params[pattern.slice(1)] = decodeURIComponent(actual);
        } else if (pattern !== actual) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;

      if (route.method !== method) {
        pathMatchedUnderOtherMethod = true;
        continue;
      }
      return { route, params };
    }

    return pathMatchedUnderOtherMethod ? 405 : 404;
  }
}

/**
 * Build the runtime's route table.
 *
 * `/health` answers without a token — admission enumerates it — because
 * Desktop_Core's supervisor polls it before the token has been distributed.
 */
export function buildRoutes(
  env: RuntimeEnv,
  configure?: (router: Router) => void,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const router = new Router();

  router.get("/health", ({ res }) => {
    json(res, 200, { status: "ok", service: "agent-runtime" });
  });

  configure?.(router);

  return async function route(req, res) {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const outcome = router.match(req.method ?? "GET", url.pathname);

    if (outcome === 404) {
      throw HttpError.notFound(ErrorCode.NOT_FOUND, "No such endpoint.");
    }
    if (outcome === 405) {
      throw new HttpError(
        405,
        envelope(ErrorCode.METHOD_NOT_ALLOWED, "That method is not allowed here."),
      );
    }

    await outcome.route.handler({
      req,
      res,
      params: outcome.params,
      query: url.searchParams,
      env,
    });
  };
}

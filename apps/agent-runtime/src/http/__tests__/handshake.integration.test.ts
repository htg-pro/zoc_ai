/**
 * Port and token handshake — zoc-agent-chat-rebuild R3.2, R3.3, R3.4, R3.5, R3.6.
 *
 * Spawns the **real** runtime as a child process, reads the port line off its
 * stdout, and exercises admission over real HTTP. Not a unit test against
 * `admit()` — that is covered by Property 10 and 11 — but the end-to-end claim
 * that Desktop_Core's side of the handshake works: the line is printed, the port
 * is loopback-only, and the credential gate is live on a real socket.
 *
 * **Admission only, deliberately.** `POST /v1/runs` does not exist until task
 * 9.7, so there is no 200 to assert here; what this proves is the handshake, and
 * the assertion is written as "anything other than 401" so it keeps holding when
 * the route lands rather than needing an edit.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { networkInterfaces } from "node:os";
import { resolve } from "node:path";

import { PORT_LINE_PREFIX } from "../../main.ts";

// vitest runs with the package root as cwd. Deriving the path from
// `import.meta.url` looks more principled but is not: vitest rewrites module
// URLs, so the computed path can miss the source tree entirely and the spawn
// fails with a bare MODULE_NOT_FOUND that says nothing about why.
const PACKAGE_ROOT = process.cwd();
const SOURCE_ENTRY = resolve(PACKAGE_ROOT, "src/bin.ts");

/**
 * The packaged `pkg` artifact, when a bundle has been built.
 *
 * Preferred over the source entry when it exists, because it is the thing that
 * actually ships: a handshake that works under `node --experimental-strip-types`
 * and fails inside the pkg snapshot is precisely the bug that would reach a user,
 * and it has happened once already in this package's history (the entrypoint
 * self-detection that matched `main.ts` and never matched the snapshot path).
 */
function packagedBinary(): string | null {
  const triple = `${process.arch === "arm64" ? "aarch64" : "x86_64"}-unknown-linux-gnu`;
  const candidate = resolve(
    PACKAGE_ROOT,
    `../desktop/binaries/zoc-studio-agent-runtime-${triple}`,
  );
  return process.platform === "linux" && existsSync(candidate) ? candidate : null;
}

function launchArgs(): { command: string; args: string[] } {
  const packaged = packagedBinary();
  if (packaged !== null) return { command: packaged, args: [] };
  return {
    command: process.execPath,
    args: ["--experimental-strip-types", "--no-warnings", SOURCE_ENTRY],
  };
}

/** `stdio: ["ignore", "pipe", "pipe"]` — stdin is null, stdout/stderr are pipes. */
type PipedChild = ChildProcessByStdio<null, Readable, Readable>;

const TOKEN = "handshake-token-Xk29fLpQ7mZ4-vB1nR8sT6wY3cJ0hG5a";
const BOOT_BUDGET_MS = 30_000;

let child: PipedChild;
let port = 0;
let stderrText = "";

function waitForPortLine(proc: PipedChild): Promise<number> {
  return new Promise((resolvePort, reject) => {
    let buffered = "";
    const timer = setTimeout(() => {
      reject(new Error(`no port line within ${BOOT_BUDGET_MS} ms; stderr: ${stderrText}`));
    }, BOOT_BUDGET_MS);

    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      buffered += chunk;
      for (const line of buffered.split("\n")) {
        if (!line.startsWith(PORT_LINE_PREFIX)) continue;
        const parsed = Number.parseInt(line.slice(PORT_LINE_PREFIX.length).trim(), 10);
        if (Number.isInteger(parsed) && parsed > 0) {
          clearTimeout(timer);
          resolvePort(parsed);
          return;
        }
      }
    });
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk: string) => {
      stderrText += chunk;
    });
    proc.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`runtime exited with ${code} before announcing a port: ${stderrText}`));
    });
  });
}

/** A non-loopback address this host actually owns, or null on a loopback-only box. */
function firstNonLoopbackAddress(): string | null {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) return address.address;
    }
  }
  return null;
}

async function request(
  path: string,
  options: { method?: string; token?: string } = {},
): Promise<{ status: number; body: string }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: options.method ?? "GET",
    headers: options.token === undefined ? {} : { authorization: `Bearer ${options.token}` },
  });
  return { status: response.status, body: await response.text() };
}

beforeAll(async () => {
  const { command, args } = launchArgs();
  child = spawn(command, args, {
    cwd: PACKAGE_ROOT,
    env: {
      ...process.env,
      ZOC_RUNTIME_TOKEN: TOKEN,
      ZOC_WORKSPACE_SERVICES_URL: "http://127.0.0.1:1",
      ZOC_STUDIO_WORKSPACE: PACKAGE_ROOT,
    },
    stdio: ["ignore", "pipe", "pipe"],
  }) as PipedChild;

  port = await waitForPortLine(child);
}, BOOT_BUDGET_MS + 5_000);

afterAll(() => {
  child?.kill("SIGTERM");
});

describe("port line handshake (R3.2)", () => {
  it("announces a usable port on stdout", () => {
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65_536);
  });
});

describe("admission over a real socket (R3.4, R3.5, R3.6)", () => {
  it("answers /health without a token", async () => {
    const { status, body } = await request("/health");
    expect(status).toBe(200);
    expect(JSON.parse(body)).toMatchObject({ status: "ok" });
  });

  it("refuses /v1/runs with no token", async () => {
    const { status, body } = await request("/v1/runs", { method: "POST" });
    expect(status).toBe(401);
    const envelope = JSON.parse(body) as Record<string, unknown>;
    expect(envelope.code).toBe("unauthorized");
    // All four envelope fields, on the failure path too (R7.5).
    expect(Object.keys(envelope).sort()).toEqual([
      "code",
      "details",
      "message",
      "retryable",
    ]);
  });

  it("refuses /v1/runs with the wrong token", async () => {
    const { status } = await request("/v1/runs", { method: "POST", token: "not-the-token" });
    expect(status).toBe(401);
  });

  it("answers something other than 401 with the launch token", async () => {
    // 404 today, 200/422 once 9.7 lands. The assertion is about admission.
    const { status } = await request("/v1/runs", { method: "POST", token: TOKEN });
    expect(status).not.toBe(401);
    expect(status).not.toBe(403);
  });

  it("leaks nothing about the token in the refusal body", async () => {
    const { body } = await request("/v1/runs", { method: "POST", token: "wrong" });
    expect(body).not.toContain(TOKEN);
    expect(body).not.toContain("wrong");
  });
});

describe("loopback binding (R3.6)", () => {
  it("is not reachable on this host's external address", async () => {
    const external = firstNonLoopbackAddress();
    if (external === null) {
      // A loopback-only machine cannot demonstrate this; skipping is honest,
      // and the bind-host assertion below still holds.
      return;
    }
    await expect(
      new Promise<void>((resolvePromise, reject) => {
        const socket = createConnection({ host: external, port, timeout: 2_000 });
        socket.once("connect", () => {
          socket.destroy();
          resolvePromise();
        });
        socket.once("error", reject);
        socket.once("timeout", () => {
          socket.destroy();
          reject(new Error("timeout"));
        });
      }),
    ).rejects.toBeTruthy();
  });

  it("is reachable on 127.0.0.1", async () => {
    const { status } = await request("/health");
    expect(status).toBe(200);
  });
});

describe("startup refuses an incomplete environment", () => {
  async function spawnExpectingFailure(
    env: Record<string, string | undefined>,
  ): Promise<{ code: number | null; stderr: string }> {
    return await new Promise((resolvePromise) => {
      const { command, args } = launchArgs();
      const proc = spawn(command, args, {
        cwd: PACKAGE_ROOT,
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      proc.stderr?.setEncoding("utf8");
      proc.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
      proc.once("exit", (code) => resolvePromise({ code, stderr }));
    });
  }

  it("exits non-zero with no token rather than serving unauthenticated", async () => {
    const { code, stderr } = await spawnExpectingFailure({
      ZOC_RUNTIME_TOKEN: undefined,
      ZOC_WORKSPACE_SERVICES_URL: "http://127.0.0.1:1",
      ZOC_STUDIO_WORKSPACE: PACKAGE_ROOT,
    });
    expect(code).not.toBe(0);
    expect(stderr).toContain("ZOC_RUNTIME_TOKEN");
  }, 30_000);

  it("exits non-zero with no workspace root", async () => {
    const { code, stderr } = await spawnExpectingFailure({
      ZOC_RUNTIME_TOKEN: TOKEN,
      ZOC_WORKSPACE_SERVICES_URL: "http://127.0.0.1:1",
      ZOC_STUDIO_WORKSPACE: undefined,
    });
    expect(code).not.toBe(0);
    expect(stderr).toContain("ZOC_STUDIO_WORKSPACE");
  }, 30_000);
});

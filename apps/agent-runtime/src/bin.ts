/**
 * Agent_Runtime process entrypoint — zoc-agent-chat-rebuild R3.1, R3.2.
 *
 * Deliberately three lines. Being a separate module is what makes "this file is
 * the entrypoint" a structural fact rather than a runtime guess: `main.ts` is
 * importable by tests without starting a server, and the esbuild + pkg pipeline
 * has one unambiguous entry to bundle.
 */

import process from "node:process";

import { main } from "./main.ts";

main().catch((cause: unknown) => {
  const message = cause instanceof Error ? cause.message : String(cause);
  // stderr, not stdout: stdout is the supervisor's port-line protocol channel.
  process.stderr.write(`agent-runtime failed to start: ${message}\n`);
  process.exit(1);
});

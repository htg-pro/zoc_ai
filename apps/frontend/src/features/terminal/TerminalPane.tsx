import { useEffect, useRef, useState } from "react";
import { Bot, ShieldAlert, Terminal as TerminalIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { getAgentClient, type TerminalStreamEvent } from "@/lib/agent-client";
import { track } from "@/lib/telemetry";

const DEFAULT_SHELL = (() => {
  if (typeof navigator !== "undefined" && /Win/i.test(navigator.platform)) return "powershell.exe";
  return "/bin/bash";
})();

export function TerminalPane() {
  const ref = useRef<HTMLDivElement>(null);
  const termRef = useRef<{ dispose: () => void; write: (data: string) => void } | null>(null);
  const sessionRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [agentControl, setAgentControl] = useState(false);
  const [needsApproval, setNeedsApproval] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let resize: (() => void) | null = null;
    let resizeObserver: ResizeObserver | null = null;

    (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (cancelled || !ref.current) return;
      const term = new Terminal({
        fontFamily: "JetBrains Mono, ui-monospace, monospace",
        fontSize: 12,
        cursorBlink: true,
        theme: { background: "#0a0a0d", foreground: "#e6e6e8", cursor: "#a78bfa" },
        convertEol: true,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(ref.current);
      fit.fit();
      termRef.current = term;

      let client: Awaited<ReturnType<typeof getAgentClient>> | null = null;
      let live = false;
      try {
        client = await getAgentClient();
        const session = await client.spawnTerminal(DEFAULT_SHELL, {
          cols: term.cols,
          rows: term.rows,
        });
        sessionRef.current = session.id;
        live = true;
        await track("terminal.spawned", { id: session.id });
        const abort = new AbortController();
        abortRef.current = abort;
        void streamTerminal(client, session.id, term, abort.signal);
      } catch (err) {
        // Sidecar offline → fall back to a friendly mock.
        term.writeln("\x1b[38;5;141m$ \x1b[0m# agent sidecar offline, running in mock terminal");
        term.writeln(`\x1b[2m${(err as Error).message}\x1b[0m`);
        term.write("\x1b[38;5;141m$ \x1b[0m");
      }

      const onResize = () => {
        fit.fit();
        if (live && client && sessionRef.current) {
          void client.resizeTerminal(sessionRef.current, term.cols, term.rows).catch(() => undefined);
        }
      };
      resize = onResize;
      window.addEventListener("resize", onResize);
      resizeObserver = new ResizeObserver(onResize);
      resizeObserver.observe(ref.current);

      let mockBuf = "";
      term.onData((data) => {
        if (live && client && sessionRef.current) {
          void client.writeTerminal(sessionRef.current, data).catch(() => undefined);
          if (agentControl && data === "\r") setNeedsApproval(true);
          return;
        }
        // mock-mode local echo
        if (data === "\r") {
          term.write("\r\n");
          if (mockBuf.trim().toLowerCase() === "agent") setNeedsApproval(true);
          mockBuf = "";
          term.write("\x1b[38;5;141m$ \x1b[0m");
        } else if (data === "\u007f") {
          if (mockBuf.length > 0) {
            mockBuf = mockBuf.slice(0, -1);
            term.write("\b \b");
          }
        } else {
          mockBuf += data;
          term.write(data);
        }
      });
    })();

    return () => {
      cancelled = true;
      if (resize) window.removeEventListener("resize", resize);
      resizeObserver?.disconnect();
      abortRef.current?.abort();
      abortRef.current = null;
      const sid = sessionRef.current;
      sessionRef.current = null;
      if (sid) {
        getAgentClient()
          .then((c) => c.stopTerminal(sid))
          .catch(() => undefined);
      }
      termRef.current?.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="relative flex h-full min-h-0 min-w-0 flex-col bg-[#0a0a0d]">
      <div className="flex h-7 shrink-0 items-center justify-between border-b border-border bg-card/40 px-2 text-[11px]">
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <TerminalIcon className="h-3 w-3" /> {DEFAULT_SHELL}
        </span>
        <label className="flex items-center gap-2">
          <Bot className="h-3 w-3 text-primary" />
          <span>Agent control</span>
          <Switch checked={agentControl} onCheckedChange={setAgentControl} />
        </label>
      </div>
      <div ref={ref} className="min-h-0 flex-1" />
      {needsApproval && (
        <div className="absolute inset-x-0 bottom-0 m-2 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-[12px]">
          <ShieldAlert className="mt-0.5 h-4 w-4 text-amber-400" />
          <div className="flex-1">
            <div className="font-medium text-amber-200">Agent wants to run a command</div>
            <code className="font-mono text-[11px] text-amber-100/80">
              git commit -am &quot;wip&quot;
            </code>
          </div>
          <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => setNeedsApproval(false)}>
            Deny
          </Button>
          <Button size="sm" className="h-6 px-2 text-[11px]" onClick={() => setNeedsApproval(false)}>
            Allow
          </Button>
        </div>
      )}
    </div>
  );
}

async function streamTerminal(
  client: Awaited<ReturnType<typeof getAgentClient>>,
  id: string,
  term: { write: (data: string) => void },
  signal: AbortSignal,
) {
  try {
    for await (const ev of client.terminalStream(id, signal) as AsyncIterable<TerminalStreamEvent>) {
      if (ev.type === "data") term.write(ev.chunk);
      else if (ev.type === "exit") term.write(`\r\n[exited ${ev.code ?? "?"}]\r\n`);
      else if (ev.type === "error") term.write(`\r\n[error: ${ev.message}]\r\n`);
    }
  } catch {
    /* aborted */
  }
}

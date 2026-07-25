import type { JSX, ReactNode } from "react";

import { useApp } from "@/lib/store";
import { AgentStreamContext } from "./agent-stream-context";
import useAgentStream from "./useAgentStream";
import { useAgentRunLifecycle } from "./useAgentRunLifecycle";

/**
 * Own the application's single live Gateway telemetry subscription. Consumers
 * such as RunRegion and the terminal dock read this context instead of opening
 * independent EventSource connections.
 */
export function AgentStreamProvider({ children }: { children: ReactNode }): JSX.Element {
  const runId = useApp((state) => state.runId);
  const stream = useAgentStream({ runId, enabled: Boolean(runId) });
  useAgentRunLifecycle(stream.events);
  return (
    <AgentStreamContext.Provider value={stream}>
      {children}
    </AgentStreamContext.Provider>
  );
}

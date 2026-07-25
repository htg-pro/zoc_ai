import { createContext, useContext } from "react";

import type { UseAgentStreamResult } from "./useAgentStream";

export const AgentStreamContext = createContext<UseAgentStreamResult | null>(null);

/** Null means the consumer is rendered outside the app provider (unit tests). */
export function useAgentStreamContext(): UseAgentStreamResult | null {
  return useContext(AgentStreamContext);
}

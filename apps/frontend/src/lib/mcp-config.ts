/**
 * Renderer compatibility export for the MCP config owned by Agent_Runtime (R26.2, R26.5).
 * Settings still edits the workspace document, but parsing and precedence now have one owner.
 */
export {
  detectTransport,
  isToolAutoApproved,
  loadMcpServers,
  mergeMcpServers,
  parseMcpConfig,
  serializeMcpServer,
  upsertWorkspaceServer,
  type McpScope,
  type McpServer,
  type McpToolEnableMap,
  type McpToolSetting,
  type McpTransport,
} from "@zoc-studio/agent-runtime/mcp/config";

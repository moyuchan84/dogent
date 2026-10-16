export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
export const TOOLS: ToolSpec[];
export const PORT_TOOL: string;

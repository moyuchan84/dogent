export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
export const TOOLS: ToolSpec[];
export const HUB_TOOLS: ToolSpec[];
export const PORT_TOOL: string;
export function toContent(tool: string, text: string): ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[];

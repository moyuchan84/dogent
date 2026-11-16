import type { Server } from 'node:http';
export function createOllamaProxy(options?: { ollamaUrl?: string; model?: string; numCtx?: number; log?: (line: string) => void }): Server;
export function ollamaFormat(rf: unknown): { format?: unknown };

import type { Server } from 'node:http';
export function mockComplete(messages: { role: string; content: string }[]): string;
export function createMockLlm(options?: { requireHeaders?: string[]; log?: (line: string) => void }): Server;

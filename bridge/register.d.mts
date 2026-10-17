export const REGISTRY_KEYS: Record<string, string>;
export function isExtensionId(id: string): boolean;
export function registeredIds(): string[];
export function findInstalledExtensions(): { id: string; browser: string; profile: string }[];
export function registerNativeHost(opts: { ids: string[]; browsers?: string[]; runtime?: string; hostDir?: string; log?: (line: string) => void }): { manifest: string; ids: string[] };
export function unregisterNativeHost(opts?: { browsers?: string[]; log?: (line: string) => void }): void;

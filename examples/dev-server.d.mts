import type { Server } from 'node:http';

export interface BeaconRecord {
  receivedAt: number;
  headers: { origin: string | null; referer: string | null; contentType: string | null };
  body: Record<string, unknown>;
}

export interface RequestCounts {
  config: number;
  ingest: number;
  loader: number;
  engine: number;
  page: number;
}

/**
 * `echo` answers the caller's own `Origin` (what the hosted ingest route
 * does); `wildcard` answers `*` (what a policy-free endpoint does, and what a
 * credentialed *preflighted* request is refused against).
 */
export type CorsMode = 'echo' | 'wildcard';

export interface FixtureServer {
  server: Server;
  port: number;
  url: string;
  beacons: BeaconRecord[];
  counts: RequestCounts;
  config(): Record<string, unknown>;
  cors(): CorsMode;
  setCors(mode: CorsMode): void;
  reset(): void;
  close(): Promise<void>;
}

export function createServer(
  port?: number,
  options?: { verbose?: boolean; cors?: CorsMode },
): Promise<FixtureServer>;

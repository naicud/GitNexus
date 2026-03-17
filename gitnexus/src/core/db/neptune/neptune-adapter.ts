/**
 * Neptune DB Adapter (Read Path)
 *
 * Implements IDbQueryAdapter for AWS Neptune using the official
 * @aws-sdk/client-neptunedata package. Authentication is handled
 * automatically by the AWS SDK credential chain:
 *   1. AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY env vars
 *   2. ~/.aws/credentials
 *   3. EC2/ECS instance profile
 *
 * Neptune runs openCypher queries via HTTP — no persistent connection needed.
 */

import { NeptunedataClient, ExecuteOpenCypherQueryCommand } from '@aws-sdk/client-neptunedata';
import type { NeptuneDbConfig, IDbQueryAdapter } from '../interfaces.js';

/** Normalize Neptune's result format to flat Record<string, unknown>[] */
function normalizeResults(raw: unknown): Record<string, unknown>[] {
  if (!raw) return [];

  // AWS SDK already unwraps: response.results is already a plain array
  if (Array.isArray(raw)) {
    return raw as Record<string, unknown>[];
  }

  if (typeof raw !== 'object') return [];
  const r = raw as Record<string, unknown>;

  // Older SDK / legacy format: { results: [ { col1: val1, ... }, ... ] }
  if (Array.isArray(r['results'])) {
    return r['results'] as Record<string, unknown>[];
  }

  // Fallback: wrap single object
  return [r];
}

export class NeptuneAdapter implements IDbQueryAdapter {
  private readonly client: NeptunedataClient;
  private readonly config: NeptuneDbConfig;

  constructor(config: NeptuneDbConfig) {
    this.config = config;
    this.client = new NeptunedataClient({
      endpoint: `https://${config.endpoint}:${config.port}`,
      region: config.region,
    });
  }

  async executeQuery(cypher: string): Promise<Record<string, unknown>[]> {
    const command = new ExecuteOpenCypherQueryCommand({
      openCypherQuery: cypher,
    });
    const response = await this.client.send(command);
    return normalizeResults(response.results);
  }

  async executeParameterized(
    cypher: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]> {
    const command = new ExecuteOpenCypherQueryCommand({
      openCypherQuery: cypher,
      parameters: JSON.stringify(params),
    });
    const response = await this.client.send(command);
    return normalizeResults(response.results);
  }

  async close(): Promise<void> {
    // Neptune is stateless HTTP — nothing to close
    this.client.destroy();
  }

  /**
   * Test connectivity to Neptune. Throws on failure.
   * Returns round-trip latency in milliseconds.
   */
  static async test(config: NeptuneDbConfig): Promise<{ latencyMs: number }> {
    const adapter = new NeptuneAdapter(config);
    const t0 = Date.now();
    try {
      await adapter.executeQuery('MATCH (n) RETURN count(n) AS c LIMIT 1');
      return { latencyMs: Date.now() - t0 };
    } finally {
      await adapter.close();
    }
  }
}

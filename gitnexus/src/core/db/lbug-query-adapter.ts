/**
 * LadybugDB Query Adapter
 *
 * Wraps the LadybugDB connection pool's executeQuery/executeParameterized
 * functions behind the IDbQueryAdapter interface, enabling polymorphic
 * dispatch alongside NeptuneAdapter.
 *
 * Uses dependency injection (constructor functions) to avoid circular
 * imports between core/db/ and mcp/core/ layers.
 */

import type { IDbQueryAdapter } from './interfaces.js';

export class LbugQueryAdapter implements IDbQueryAdapter {
  readonly id: string;

  constructor(
    repoId: string,
    private readonly _executeQuery: (cypher: string) => Promise<Record<string, unknown>[]>,
    private readonly _executeParameterized: (cypher: string, params: Record<string, unknown>) => Promise<Record<string, unknown>[]>,
  ) {
    this.id = `lbug:${repoId}`;
  }

  async executeQuery(cypher: string): Promise<Record<string, unknown>[]> {
    return this._executeQuery(cypher);
  }

  async executeParameterized(
    cypher: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]> {
    return this._executeParameterized(cypher, params);
  }

  async close(): Promise<void> {
    // Noop — LadybugDB connections are managed by the global pool
    // and evicted by idle timers. Do not close here.
  }
}

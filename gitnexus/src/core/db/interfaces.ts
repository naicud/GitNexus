/**
 * Graph DB Adapter Interfaces
 *
 * Defines the contract for graph database backends (KuzuDB, Neptune, etc.).
 * KuzuDB remains the default; Neptune is an optional AWS-managed alternative.
 */

export type DbType = 'lbug' | 'neptune';

export interface LbugDbConfig {
  type: 'lbug';
  lbugPath: string;
}

export interface NeptuneDbConfig {
  type: 'neptune';
  /** Neptune cluster endpoint hostname only (no protocol, no port) */
  endpoint: string;
  /** AWS region, e.g. "us-east-1" */
  region: string;
  /** Neptune HTTP port, default 8182 */
  port: number;
}

export type DbConfig = LbugDbConfig | NeptuneDbConfig;

/**
 * Minimal query interface implemented by all DB adapters.
 * Used by the HTTP serve path and MCP tools for read queries.
 */
export interface IDbQueryAdapter {
  executeQuery(cypher: string): Promise<Record<string, unknown>[]>;
  executeParameterized(cypher: string, params: Record<string, unknown>): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
}

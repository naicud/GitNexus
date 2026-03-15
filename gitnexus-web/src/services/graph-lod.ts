/**
 * Level-of-Detail (LOD) Graph Fetch Layer
 *
 * Fetches graph info, summary, and per-group expansions from the server
 * for progressive loading of large codebases.
 */

import type { GraphNode, GraphRelationship } from '../core/graph/types';

// ── Types ────────────────────────────────────────────────────────────────

export interface GraphInfo {
  totalNodes: number;
  totalEdges: number;
  hasSummary: boolean;
  mode: 'summary' | 'full';
}

export interface ClusterGroupSummary {
  id: string;
  label: string;
  symbolCount: number;
  cohesion: number;
  subCommunityIds: string[];
  subCommunityCount: number;
}

export interface InterGroupEdge {
  sourceGroupId: string;
  targetGroupId: string;
  count: number;
  types: Record<string, number>;
}

export interface GraphSummary {
  version: number;
  generatedAt: string;
  totalNodes: number;
  totalEdges: number;
  clusterGroups: ClusterGroupSummary[];
  interGroupEdges: InterGroupEdge[];
}

export interface GroupExpansion {
  groupLabel: string;
  nodes: GraphNode[];
  relationships: GraphRelationship[];
  crossEdges: Array<{
    sourceId: string;
    targetId: string;
    type: string;
    targetGroup: string;
  }>;
  truncated: boolean;
  totalAvailable: number;
}

export interface NeighborExpansion {
  centerNode: GraphNode;
  nodes: GraphNode[];
  relationships: GraphRelationship[];
  truncated: boolean;
  totalAvailable: number;
}

// ── Fetch Functions ──────────────────────────────────────────────────────

export async function fetchGraphInfo(baseUrl: string, repo: string): Promise<GraphInfo> {
  const res = await fetch(`${baseUrl}/graph/info?repo=${encodeURIComponent(repo)}`);
  if (!res.ok) throw new Error(`Failed to fetch graph info: ${res.status}`);
  return res.json();
}

export async function fetchGraphSummary(baseUrl: string, repo: string): Promise<GraphSummary> {
  const res = await fetch(`${baseUrl}/graph/summary?repo=${encodeURIComponent(repo)}`);
  if (!res.ok) throw new Error(`Failed to fetch graph summary: ${res.status}`);
  return res.json();
}

export async function fetchGroupExpansion(
  baseUrl: string,
  repo: string,
  groupLabel: string,
  limit: number = 1000,
): Promise<GroupExpansion> {
  const params = new URLSearchParams({
    repo,
    group: groupLabel,
    limit: String(limit),
  });
  const res = await fetch(`${baseUrl}/graph/expand?${params}`);
  if (!res.ok) throw new Error(`Failed to expand group "${groupLabel}": ${res.status}`);
  return res.json();
}

export async function fetchNeighbors(
  baseUrl: string,
  repo: string,
  nodeId: string,
  depth: number = 1,
  limit: number = 200,
): Promise<NeighborExpansion> {
  const params = new URLSearchParams({
    repo,
    node: nodeId,
    depth: String(depth),
    limit: String(limit),
  });
  const res = await fetch(`${baseUrl}/graph/neighbors?${params}`);
  if (!res.ok) throw new Error(`Failed to fetch neighbors for "${nodeId}": ${res.status}`);
  return res.json();
}

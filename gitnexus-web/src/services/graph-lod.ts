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
  mode: 'summary' | 'full' | 'hierarchy';
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
  types?: string[],
  direction?: 'inbound' | 'outbound' | 'both',
): Promise<NeighborExpansion> {
  const params = new URLSearchParams({
    repo,
    node: nodeId,
    depth: String(depth),
    limit: String(limit),
  });
  if (types && types.length > 0) params.set('types', types.join(','));
  if (direction) params.set('direction', direction);
  const res = await fetch(`${baseUrl}/graph/neighbors?${params}`);
  if (!res.ok) throw new Error(`Failed to fetch neighbors for "${nodeId}": ${res.status}`);
  return res.json();
}

// ── Neighbor Counts ─────────────────────────────────────────────────

// ── Hierarchy Types ─────────────────────────────────────────────────────

export interface HierarchyNode {
  id: string;
  name: string;
  type: string;           // 'Folder', 'File', 'Module', etc.
  filePath: string;
  childCount: number;     // direct children
  descendantCount: number; // total subtree (for sizing)
  hasChildren: boolean;
}

export interface VirtualGroup {
  prefix: string;
  count: number;
  sampleNames: string[];
}

export interface HierarchyResponse {
  parentId: string | null;
  parentType: string | null;
  children: HierarchyNode[];
  totalChildren: number;
  truncated: boolean;
  virtualGroups?: VirtualGroup[];
}

export interface AncestorPathResponse {
  node: HierarchyNode;
  ancestors: HierarchyNode[]; // ordered root→leaf
}

export interface NeighborCounts {
  inbound: Record<string, number>;
  outbound: Record<string, number>;
  total: number;
}

export async function fetchNeighborCounts(
  baseUrl: string,
  repo: string,
  nodeId: string,
): Promise<NeighborCounts> {
  const params = new URLSearchParams({ repo, node: nodeId });
  const res = await fetch(`${baseUrl}/graph/neighbor-counts?${params}`);
  if (!res.ok) throw new Error(`Failed to fetch neighbor counts: ${res.status}`);
  return res.json();
}

// ── Hierarchy Fetch Functions ───────────────────────────────────────────

export async function fetchHierarchyChildren(
  baseUrl: string,
  repo: string,
  parentId?: string,
  options?: { limit?: number; offset?: number; namePrefix?: string },
): Promise<HierarchyResponse> {
  const params = new URLSearchParams({ repo });
  if (parentId) params.set('parentId', parentId);
  if (options?.limit) params.set('limit', String(options.limit));
  if (options?.offset) params.set('offset', String(options.offset));
  if (options?.namePrefix) params.set('namePrefix', options.namePrefix);
  const res = await fetch(`${baseUrl}/graph/hierarchy?${params}`);
  if (!res.ok) throw new Error(`Failed to fetch hierarchy children: ${res.status}`);
  return res.json();
}

export async function fetchAncestorPath(
  baseUrl: string,
  repo: string,
  nodeId: string,
): Promise<AncestorPathResponse> {
  const params = new URLSearchParams({ repo, nodeId });
  const res = await fetch(`${baseUrl}/graph/hierarchy/ancestors?${params}`);
  if (!res.ok) throw new Error(`Failed to fetch ancestor path: ${res.status}`);
  return res.json();
}

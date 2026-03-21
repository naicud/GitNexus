/**
 * Graph Summary Precomputation
 *
 * Generates a compact summary of the codebase graph suitable for
 * Level-of-Detail (LOD) visualization. Communities are aggregated
 * into cluster groups by heuristicLabel, and inter-group edges
 * are counted by type.
 *
 * Output: {storagePath}/graph-summary.json (<1MB for most repos)
 */

import fs from 'fs/promises';
import path from 'path';
import type { KnowledgeGraph } from '../graph/types.js';
import type { CommunityDetectionResult } from './community-processor.js';

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
  version: 1;
  generatedAt: string;
  totalNodes: number;
  totalEdges: number;
  clusterGroups: ClusterGroupSummary[];
  interGroupEdges: InterGroupEdge[];
}

/**
 * Aggregates inter-group edges from the graph.
 *
 * Performs a single pass over all relationships (excluding MEMBER_OF and STEP_IN_PROCESS),
 * counting edges between different groups and tracking edge types.
 *
 * @param graph - The knowledge graph to process
 * @param nodeToGroup - Map from node IDs to their group keys
 * @param resolveGroupId - Optional function to resolve group keys to group IDs (for structural summary)
 * @returns Array of inter-group edge aggregations, sorted by count descending
 */
function aggregateInterGroupEdges(
  graph: { forEachRelationship: (cb: (rel: { type: string; sourceId: string; targetId: string }) => void) => void },
  nodeToGroup: Map<string, string>,
  resolveGroupId?: (groupKey: string) => string | undefined,
): InterGroupEdge[] {
  const edgeKey = (src: string, tgt: string) => `${src}|||${tgt}`;
  const interGroupMap = new Map<string, { count: number; types: Record<string, number> }>();

  graph.forEachRelationship(rel => {
    if (rel.type === 'MEMBER_OF' || rel.type === 'STEP_IN_PROCESS') return;

    const srcGroupKey = nodeToGroup.get(rel.sourceId);
    const tgtGroupKey = nodeToGroup.get(rel.targetId);
    if (!srcGroupKey || !tgtGroupKey || srcGroupKey === tgtGroupKey) return;

    const srcGroupId = resolveGroupId ? resolveGroupId(srcGroupKey) : srcGroupKey;
    const tgtGroupId = resolveGroupId ? resolveGroupId(tgtGroupKey) : tgtGroupKey;
    if (!srcGroupId || !tgtGroupId) return;

    const key = edgeKey(srcGroupId, tgtGroupId);
    const existing = interGroupMap.get(key);
    if (existing) {
      existing.count++;
      existing.types[rel.type] = (existing.types[rel.type] || 0) + 1;
    } else {
      interGroupMap.set(key, { count: 1, types: { [rel.type]: 1 } });
    }
  });

  const edges: InterGroupEdge[] = [];
  for (const [key, data] of interGroupMap) {
    const [src, tgt] = key.split('|||');
    edges.push({
      sourceGroupId: src,
      targetGroupId: tgt,
      count: data.count,
      types: data.types,
    });
  }
  edges.sort((a, b) => b.count - a.count);
  return edges;
}

/**
 * Generate a graph summary from pipeline results and write it to disk.
 *
 * 1. Groups communities by heuristicLabel (reuses aggregateClusters pattern)
 * 2. Builds nodeId → clusterGroupId lookup from community memberships
 * 3. Single pass over edges to count inter-group connections by type
 */
export async function generateGraphSummary(
  graph: KnowledgeGraph,
  communityResult: CommunityDetectionResult,
  storagePath: string,
): Promise<GraphSummary> {
  // Step 1: Aggregate communities into cluster groups by heuristicLabel
  const groupMap = new Map<string, {
    ids: string[];
    totalSymbols: number;
    weightedCohesion: number;
  }>();

  for (const comm of communityResult.communities) {
    const label = comm.heuristicLabel || comm.label || 'Unknown';
    const symbols = comm.symbolCount || 0;
    const cohesion = comm.cohesion || 0;
    const existing = groupMap.get(label);

    if (!existing) {
      groupMap.set(label, {
        ids: [comm.id],
        totalSymbols: symbols,
        weightedCohesion: cohesion * symbols,
      });
    } else {
      existing.ids.push(comm.id);
      existing.totalSymbols += symbols;
      existing.weightedCohesion += cohesion * symbols;
    }
  }

  // Filter out tiny groups (<5 symbols), build cluster groups
  const clusterGroups: ClusterGroupSummary[] = [];
  const communityToGroupId = new Map<string, string>();

  for (const [label, g] of groupMap) {
    if (g.totalSymbols < 5) continue;
    const groupId = `cg_${label}`;
    clusterGroups.push({
      id: groupId,
      label,
      symbolCount: g.totalSymbols,
      cohesion: g.totalSymbols > 0 ? g.weightedCohesion / g.totalSymbols : 0,
      subCommunityIds: g.ids,
      subCommunityCount: g.ids.length,
    });
    for (const commId of g.ids) {
      communityToGroupId.set(commId, groupId);
    }
  }

  // Sort by symbol count descending
  clusterGroups.sort((a, b) => b.symbolCount - a.symbolCount);

  // Step 2: Build nodeId → groupId map from memberships
  const nodeToGroup = new Map<string, string>();
  for (const m of communityResult.memberships) {
    const groupId = communityToGroupId.get(m.communityId);
    if (groupId) {
      nodeToGroup.set(m.nodeId, groupId);
    }
  }

  // Step 3: Single pass over edges to count inter-group connections
  const interGroupEdges = aggregateInterGroupEdges(graph, nodeToGroup);

  const summary: GraphSummary = {
    version: 1,
    generatedAt: new Date().toISOString(),
    totalNodes: graph.nodeCount,
    totalEdges: graph.relationshipCount,
    clusterGroups,
    interGroupEdges,
  };

  await fs.writeFile(
    path.join(storagePath, 'graph-summary.json'),
    JSON.stringify(summary),
    'utf-8',
  );

  return summary;
}

/**
 * Generate a structural fallback summary from the directory tree.
 * Used when community detection produces 0 results (e.g., COBOL repos
 * where node types weren't previously included in community detection).
 *
 * Groups nodes by top-level directory segments, producing cluster groups
 * compatible with the same frontend as community-based summaries.
 */
export async function generateStructuralSummary(
  graph: KnowledgeGraph,
  storagePath: string,
): Promise<GraphSummary> {
  const MAX_GROUPS = 200;

  // Step 1: Group nodes by top-level directory (first 2 path segments)
  const dirGroups = new Map<string, { count: number; nodeIds: string[] }>();
  const nodeToGroup = new Map<string, string>();

  const skipLabels = new Set(['Community', 'Process', 'Folder']);

  graph.forEachNode(node => {
    if (skipLabels.has(node.label)) return;

    const filePath = node.properties.filePath || '';
    const parts = filePath.split('/').filter(Boolean);

    // Use first meaningful directory segment, or 'root' for top-level files
    let groupKey: string;
    if (parts.length >= 2) {
      groupKey = parts[0];
      // For deeper nesting (e.g., src/core/...), use first two segments
      if (['src', 'lib', 'app', 'packages'].includes(parts[0].toLowerCase()) && parts.length >= 3) {
        groupKey = `${parts[0]}/${parts[1]}`;
      }
    } else {
      groupKey = '(root)';
    }

    const existing = dirGroups.get(groupKey);
    if (existing) {
      existing.count++;
      existing.nodeIds.push(node.id);
    } else {
      dirGroups.set(groupKey, { count: 1, nodeIds: [node.id] });
    }
    nodeToGroup.set(node.id, groupKey);
  });

  // Step 2: Sort by count, cap at MAX_GROUPS, merge rest into "Other"
  const sorted = Array.from(dirGroups.entries()).sort((a, b) => b[1].count - a[1].count);

  if (sorted.length > MAX_GROUPS) {
    const kept = sorted.slice(0, MAX_GROUPS - 1);
    const rest = sorted.slice(MAX_GROUPS - 1);
    let otherCount = 0;
    const otherNodeIds: string[] = [];
    for (const [, data] of rest) {
      otherCount += data.count;
      otherNodeIds.push(...data.nodeIds);
    }
    kept.push(['Other', { count: otherCount, nodeIds: otherNodeIds }]);

    // Update nodeToGroup for merged nodes
    for (const nodeId of otherNodeIds) {
      nodeToGroup.set(nodeId, 'Other');
    }

    sorted.length = 0;
    sorted.push(...kept);
  }

  // Step 3: Build cluster groups (filter out tiny groups <5 symbols)
  const clusterGroups: ClusterGroupSummary[] = [];
  const groupKeyToId = new Map<string, string>();

  for (const [groupKey, data] of sorted) {
    if (data.count < 5) continue;

    const groupId = `cg_${groupKey}`;
    groupKeyToId.set(groupKey, groupId);

    clusterGroups.push({
      id: groupId,
      label: groupKey,
      symbolCount: data.count,
      cohesion: 0.5, // structural groups have no meaningful cohesion score
      subCommunityIds: [], // no communities in fallback mode
      subCommunityCount: 0,
    });
  }

  // Step 4: Single pass over relationships to count inter-group edges
  const interGroupEdges = aggregateInterGroupEdges(
    graph,
    nodeToGroup,
    (groupKey) => groupKeyToId.get(groupKey),
  );

  const summary: GraphSummary = {
    version: 1,
    generatedAt: new Date().toISOString(),
    totalNodes: graph.nodeCount,
    totalEdges: graph.relationshipCount,
    clusterGroups,
    interGroupEdges,
  };

  await fs.writeFile(
    path.join(storagePath, 'graph-summary.json'),
    JSON.stringify(summary),
    'utf-8',
  );

  return summary;
}

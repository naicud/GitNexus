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
  const edgeKey = (src: string, tgt: string) => `${src}|||${tgt}`;
  const interGroupMap = new Map<string, { count: number; types: Record<string, number> }>();

  graph.forEachRelationship(rel => {
    if (rel.type === 'MEMBER_OF' || rel.type === 'STEP_IN_PROCESS') return;

    const srcGroup = nodeToGroup.get(rel.sourceId);
    const tgtGroup = nodeToGroup.get(rel.targetId);
    if (!srcGroup || !tgtGroup || srcGroup === tgtGroup) return;

    const key = edgeKey(srcGroup, tgtGroup);
    const existing = interGroupMap.get(key);
    if (existing) {
      existing.count++;
      existing.types[rel.type] = (existing.types[rel.type] || 0) + 1;
    } else {
      interGroupMap.set(key, { count: 1, types: { [rel.type]: 1 } });
    }
  });

  const interGroupEdges: InterGroupEdge[] = [];
  for (const [key, data] of interGroupMap) {
    const [src, tgt] = key.split('|||');
    interGroupEdges.push({
      sourceGroupId: src,
      targetGroupId: tgt,
      count: data.count,
      types: data.types,
    });
  }

  // Sort by count descending for consistent ordering
  interGroupEdges.sort((a, b) => b.count - a.count);

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

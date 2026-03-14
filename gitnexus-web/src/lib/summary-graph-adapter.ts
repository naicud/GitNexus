/**
 * Summary Graph Adapter
 *
 * Converts a GraphSummary (cluster groups + inter-group edges) into a
 * Graphology graph for Sigma.js rendering. Also handles expanding and
 * collapsing individual cluster groups on demand.
 */

import Graph from 'graphology';
import type { SigmaNodeAttributes, SigmaEdgeAttributes } from './graph-adapter';
import { NODE_COLORS, NODE_SIZES, COMMUNITY_COLORS, getCommunityColor } from './constants';
import type { GraphSummary, GroupExpansion, ClusterGroupSummary } from '../services/graph-lod';
import type { NodeLabel } from '../core/graph/types';

// Edge styles matching graph-adapter.ts
const EDGE_STYLES: Record<string, { color: string; sizeMultiplier: number }> = {
  CONTAINS: { color: '#2d5a3d', sizeMultiplier: 0.4 },
  DEFINES: { color: '#0e7490', sizeMultiplier: 0.5 },
  IMPORTS: { color: '#1d4ed8', sizeMultiplier: 0.6 },
  CALLS: { color: '#7c3aed', sizeMultiplier: 0.8 },
  EXTENDS: { color: '#c2410c', sizeMultiplier: 1.0 },
  IMPLEMENTS: { color: '#be185d', sizeMultiplier: 0.9 },
};

/**
 * Get the dominant edge type from a type-count map
 */
function dominantEdgeType(types: Record<string, number>): string {
  let maxType = 'CALLS';
  let maxCount = 0;
  for (const [type, count] of Object.entries(types)) {
    if (count > maxCount) {
      maxCount = count;
      maxType = type;
    }
  }
  return maxType;
}

/**
 * Convert a GraphSummary to a Graphology graph for Sigma.js rendering.
 * Each cluster group becomes a super-node; inter-group edges connect them.
 */
export function summaryToGraphology(
  summary: GraphSummary,
): Graph<SigmaNodeAttributes, SigmaEdgeAttributes> {
  const graph = new Graph<SigmaNodeAttributes, SigmaEdgeAttributes>();
  const groupCount = summary.clusterGroups.length;

  // Position cluster groups using golden angle spiral
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const spread = Math.sqrt(groupCount) * 200;

  summary.clusterGroups.forEach((group, idx) => {
    const angle = idx * goldenAngle;
    const radius = spread * Math.sqrt((idx + 1) / groupCount);
    const x = radius * Math.cos(angle);
    const y = radius * Math.sin(angle);

    const size = Math.max(4, Math.log2(group.symbolCount) * 3);
    const color = getCommunityColor(idx);

    graph.addNode(group.id, {
      x,
      y,
      size,
      color,
      label: `${group.label} (${group.symbolCount})`,
      nodeType: 'ClusterGroup' as NodeLabel,
      filePath: '',
      hidden: false,
      mass: 50, // High mass for stable layout
      community: idx,
      communityColor: color,
    });
  });

  // Add inter-group edges
  for (const edge of summary.interGroupEdges) {
    if (!graph.hasNode(edge.sourceGroupId) || !graph.hasNode(edge.targetGroupId)) continue;

    const edgeId = `${edge.sourceGroupId}_to_${edge.targetGroupId}`;
    if (graph.hasEdge(edgeId)) continue;

    const dominant = dominantEdgeType(edge.types);
    const style = EDGE_STYLES[dominant] || { color: '#4a4a5a', sizeMultiplier: 0.5 };

    graph.addEdgeWithKey(edgeId, edge.sourceGroupId, edge.targetGroupId, {
      size: Math.max(0.5, Math.log2(edge.count) * 0.8),
      color: style.color,
      relationType: dominant,
      type: 'curved',
      curvature: 0.15,
    });
  }

  return graph;
}

/**
 * Expand a cluster group in the Sigma graph: remove the super-node,
 * add individual symbol nodes and their internal edges.
 *
 * Returns the list of new node IDs (for scoped layout).
 */
export function expandGroupInGraph(
  graph: Graph<SigmaNodeAttributes, SigmaEdgeAttributes>,
  expansion: GroupExpansion,
  groupId: string,
  summary: GraphSummary,
): string[] {
  // Get position of the group super-node before removing it
  let groupX = 0;
  let groupY = 0;
  let groupColor = NODE_COLORS.ClusterGroup;
  if (graph.hasNode(groupId)) {
    const attrs = graph.getNodeAttributes(groupId);
    groupX = attrs.x;
    groupY = attrs.y;
    groupColor = attrs.communityColor || attrs.color;

    // Remove the super-node (and all its edges)
    graph.dropNode(groupId);
  }

  // Find the community index for coloring
  const groupIndex = summary.clusterGroups.findIndex(g => g.id === groupId);
  const communityColor = groupIndex >= 0 ? getCommunityColor(groupIndex) : groupColor;

  // Add expansion symbol nodes positioned around the group's position
  const jitter = Math.sqrt(expansion.nodes.length) * 15;
  const newNodeIds: string[] = [];

  for (const node of expansion.nodes) {
    if (graph.hasNode(node.id)) continue;

    const x = groupX + (Math.random() - 0.5) * jitter;
    const y = groupY + (Math.random() - 0.5) * jitter;

    const baseSize = NODE_SIZES[node.label as NodeLabel] || 4;

    graph.addNode(node.id, {
      x,
      y,
      size: baseSize,
      color: communityColor,
      label: node.properties.name,
      nodeType: node.label as NodeLabel,
      filePath: node.properties.filePath || '',
      startLine: node.properties.startLine,
      endLine: node.properties.endLine,
      hidden: false,
      mass: 2,
      community: groupIndex >= 0 ? groupIndex : undefined,
      communityColor,
    });
    newNodeIds.push(node.id);
  }

  // Add internal edges
  for (const rel of expansion.relationships) {
    if (!graph.hasNode(rel.sourceId) || !graph.hasNode(rel.targetId)) continue;
    const edgeId = `${rel.sourceId}_${rel.type}_${rel.targetId}`;
    if (graph.hasEdge(edgeId)) continue;

    const style = EDGE_STYLES[rel.type] || { color: '#4a4a5a', sizeMultiplier: 0.5 };

    graph.addEdgeWithKey(edgeId, rel.sourceId, rel.targetId, {
      size: style.sizeMultiplier,
      color: style.color,
      relationType: rel.type,
      type: 'curved',
      curvature: 0.12 + Math.random() * 0.08,
    });
  }

  // Add cross-edges: connect to target group super-nodes (or target symbols if expanded)
  for (const ce of expansion.crossEdges) {
    const sourceExists = graph.hasNode(ce.sourceId);
    // Find the target group's super-node ID
    const targetGroupId = `cg_${ce.targetGroup}`;
    const targetExists = graph.hasNode(ce.targetId);
    const targetGroupExists = graph.hasNode(targetGroupId);

    const actualSource = sourceExists ? ce.sourceId : null;
    const actualTarget = targetExists ? ce.targetId : (targetGroupExists ? targetGroupId : null);

    if (actualSource && actualTarget) {
      const edgeId = `cross_${actualSource}_${ce.type}_${actualTarget}`;
      if (!graph.hasEdge(edgeId)) {
        const style = EDGE_STYLES[ce.type] || { color: '#4a4a5a', sizeMultiplier: 0.5 };
        graph.addEdgeWithKey(edgeId, actualSource, actualTarget, {
          size: style.sizeMultiplier * 0.6,
          color: style.color,
          relationType: ce.type,
          type: 'curved',
          curvature: 0.2,
        });
      }
    }
  }

  return newNodeIds;
}

/**
 * Collapse an expanded cluster group back to a super-node.
 * Removes all symbols belonging to the group and re-adds the super-node.
 */
export function collapseGroupInGraph(
  graph: Graph<SigmaNodeAttributes, SigmaEdgeAttributes>,
  groupId: string,
  groupLabel: string,
  summary: GraphSummary,
  expandedNodeIds: string[],
): void {
  // Calculate average position of expanded nodes for the collapsed super-node
  let sumX = 0;
  let sumY = 0;
  let count = 0;

  for (const nodeId of expandedNodeIds) {
    if (graph.hasNode(nodeId)) {
      const attrs = graph.getNodeAttributes(nodeId);
      sumX += attrs.x;
      sumY += attrs.y;
      count++;
      graph.dropNode(nodeId);
    }
  }

  const avgX = count > 0 ? sumX / count : 0;
  const avgY = count > 0 ? sumY / count : 0;

  // Find the group in summary to restore its attributes
  const groupIndex = summary.clusterGroups.findIndex(g => g.id === groupId);
  const groupData = summary.clusterGroups[groupIndex];
  if (!groupData) return;

  const color = groupIndex >= 0 ? getCommunityColor(groupIndex) : NODE_COLORS.ClusterGroup;
  const size = Math.max(4, Math.log2(groupData.symbolCount) * 3);

  graph.addNode(groupId, {
    x: avgX,
    y: avgY,
    size,
    color,
    label: `${groupData.label} (${groupData.symbolCount})`,
    nodeType: 'ClusterGroup' as NodeLabel,
    filePath: '',
    hidden: false,
    mass: 50,
    community: groupIndex >= 0 ? groupIndex : undefined,
    communityColor: color,
  });

  // Reconnect inter-group edges that involve this group
  for (const edge of summary.interGroupEdges) {
    const isSource = edge.sourceGroupId === groupId;
    const isTarget = edge.targetGroupId === groupId;
    if (!isSource && !isTarget) continue;

    const otherId = isSource ? edge.targetGroupId : edge.sourceGroupId;
    if (!graph.hasNode(otherId)) continue;

    const edgeId = `${edge.sourceGroupId}_to_${edge.targetGroupId}`;
    if (graph.hasEdge(edgeId)) continue;

    const dominant = dominantEdgeType(edge.types);
    const style = EDGE_STYLES[dominant] || { color: '#4a4a5a', sizeMultiplier: 0.5 };

    graph.addEdgeWithKey(edgeId, edge.sourceGroupId, edge.targetGroupId, {
      size: Math.max(0.5, Math.log2(edge.count) * 0.8),
      color: style.color,
      relationType: dominant,
      type: 'curved',
      curvature: 0.15,
    });
  }
}

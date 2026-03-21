/**
 * Hierarchy Graph Adapter
 *
 * Converts hierarchical browse data into Graphology graphs for Sigma.js.
 * Supports multi-level drill-down: Folder -> File -> Module -> Functions/Properties.
 */

import Graph from 'graphology';
import type { SigmaNodeAttributes, SigmaEdgeAttributes } from './graph-adapter';
import type { HierarchyResponse, HierarchyNode, VirtualGroup } from '../services/graph-lod';
import type { NodeLabel } from '../core/graph/types';

// Maximum visible nodes before forcing virtual groups or auto-collapse
const NODE_BUDGET = 5000;

// Colors per hierarchy node type
const HIERARCHY_COLORS: Record<string, string> = {
  Folder: '#f59e0b',     // Amber
  File: '#3b82f6',       // Blue
  Module: '#8b5cf6',     // Violet
  Namespace: '#6366f1',  // Indigo
  Function: '#10b981',   // Emerald
  Record: '#ec4899',     // Pink
  CodeElement: '#64748b', // Slate
  Property: '#94a3b8',   // Light slate
  Const: '#a78bfa',      // Purple
  VirtualGroup: '#71717a', // Gray
};

// Edge colors for hierarchy relationships
const HIERARCHY_EDGE_STYLES: Record<string, { color: string; size: number }> = {
  CONTAINS: { color: '#2d5a3d', size: 0.5 },
  DEFINES: { color: '#0e7490', size: 0.5 },
};

/**
 * Build L0 root view (Folder nodes) from hierarchy response.
 */
export function buildHierarchyRoot(
  data: HierarchyResponse,
): Graph<SigmaNodeAttributes, SigmaEdgeAttributes> {
  const graph = new Graph<SigmaNodeAttributes, SigmaEdgeAttributes>();
  const count = data.children.length;
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const spread = Math.sqrt(count) * 200;

  const batchNodes: Array<{ key: string; attributes: SigmaNodeAttributes }> = [];

  data.children.forEach((child, idx) => {
    const angle = idx * goldenAngle;
    const radius = spread * Math.sqrt((idx + 1) / Math.max(count, 1));
    const x = radius * Math.cos(angle);
    const y = radius * Math.sin(angle);

    const size = Math.max(4, Math.log2(child.descendantCount || child.childCount || 1) * 2.5);
    const color = HIERARCHY_COLORS[child.type] || '#9ca3af';

    batchNodes.push({
      key: child.id,
      attributes: {
        x,
        y,
        size,
        color,
        label: child.hasChildren ? `${child.name} (${child.childCount})` : child.name,
        nodeType: child.type as NodeLabel,
        filePath: child.filePath || '',
        hidden: false,
        mass: 50,
        childCount: child.childCount,
        isExpandable: child.hasChildren,
        isExpanded: false,
      },
    });
  });

  graph.import({ nodes: batchNodes, edges: [] });
  return graph;
}

/**
 * Expand one level: add children of a parent node to the graph.
 * Returns IDs of newly added nodes.
 */
export function expandNodeInHierarchy(
  graph: Graph<SigmaNodeAttributes, SigmaEdgeAttributes>,
  parentId: string,
  children: HierarchyResponse,
): string[] {
  if (!graph.hasNode(parentId)) return [];

  const parentAttrs = graph.getNodeAttributes(parentId);
  const parentX = parentAttrs.x;
  const parentY = parentAttrs.y;

  // Shrink parent and mark as expanded
  graph.setNodeAttribute(parentId, 'size', (parentAttrs.size || 8) * 0.6);
  graph.setNodeAttribute(parentId, 'isExpanded', true);
  // Reduce opacity will be handled by nodeReducer

  const childCount = children.children.length;
  const radius = Math.max(80, Math.sqrt(childCount) * 25);
  const newNodeIds: string[] = [];

  children.children.forEach((child, idx) => {
    if (graph.hasNode(child.id)) return;

    const angle = (2 * Math.PI * idx) / Math.max(childCount, 1);
    const r = radius * (0.7 + Math.random() * 0.6);
    const x = parentX + r * Math.cos(angle);
    const y = parentY + r * Math.sin(angle);

    const size = child.hasChildren
      ? Math.max(4, Math.log2(child.childCount || 1) * 2.5)
      : 3;
    const color = HIERARCHY_COLORS[child.type] || '#9ca3af';

    graph.addNode(child.id, {
      x,
      y,
      size,
      color,
      label: child.hasChildren ? `${child.name} (${child.childCount})` : child.name,
      nodeType: child.type as NodeLabel,
      filePath: child.filePath || '',
      hidden: false,
      mass: child.hasChildren ? 10 : 2,
      childCount: child.childCount,
      isExpandable: child.hasChildren,
      isExpanded: false,
    });
    newNodeIds.push(child.id);

    // Add edge from parent to child
    const edgeId = `hierarchy_${parentId}_${child.id}`;
    if (!graph.hasEdge(edgeId)) {
      const edgeStyle = HIERARCHY_EDGE_STYLES.CONTAINS;
      graph.addEdgeWithKey(edgeId, parentId, child.id, {
        size: edgeStyle.size,
        color: edgeStyle.color,
        relationType: 'CONTAINS',
        type: 'curved',
        curvature: 0.1,
      });
    }
  });

  return newNodeIds;
}

/**
 * Add virtual prefix groups as intermediate nodes.
 * Returns IDs of newly added group nodes.
 */
export function addVirtualGroups(
  graph: Graph<SigmaNodeAttributes, SigmaEdgeAttributes>,
  parentId: string,
  groups: VirtualGroup[],
): string[] {
  if (!graph.hasNode(parentId)) return [];

  const parentAttrs = graph.getNodeAttributes(parentId);
  const parentX = parentAttrs.x;
  const parentY = parentAttrs.y;

  // Mark parent as expanded
  graph.setNodeAttribute(parentId, 'size', (parentAttrs.size || 8) * 0.6);
  graph.setNodeAttribute(parentId, 'isExpanded', true);

  const groupCount = groups.length;
  const radius = Math.max(80, Math.sqrt(groupCount) * 30);
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const newNodeIds: string[] = [];

  groups.forEach((group, idx) => {
    const nodeId = `vg_${parentId}_${group.prefix}`;
    if (graph.hasNode(nodeId)) return;

    const angle = idx * goldenAngle;
    const r = radius * Math.sqrt((idx + 1) / Math.max(groupCount, 1));
    const x = parentX + r * Math.cos(angle);
    const y = parentY + r * Math.sin(angle);

    const size = Math.max(4, Math.log2(group.count) * 2);

    graph.addNode(nodeId, {
      x,
      y,
      size,
      color: HIERARCHY_COLORS.VirtualGroup,
      label: `${group.prefix}* (${group.count})`,
      nodeType: 'VirtualGroup' as NodeLabel,
      filePath: '',
      hidden: false,
      mass: 10,
      childCount: group.count,
      isExpandable: true,
      isExpanded: false,
    });
    newNodeIds.push(nodeId);

    // Edge from parent to virtual group
    const edgeId = `hierarchy_${parentId}_${nodeId}`;
    if (!graph.hasEdge(edgeId)) {
      graph.addEdgeWithKey(edgeId, parentId, nodeId, {
        size: 0.4,
        color: '#4a4a5a',
        relationType: 'CONTAINS',
        type: 'curved',
        curvature: 0.1,
      });
    }
  });

  return newNodeIds;
}

/**
 * Collapse a node: remove all its children (and their descendants) from the graph.
 */
export function collapseNodeInHierarchy(
  graph: Graph<SigmaNodeAttributes, SigmaEdgeAttributes>,
  parentId: string,
  expandedNodes: Map<string, HierarchyResponse>,
): void {
  if (!graph.hasNode(parentId)) return;

  // Recursively collect all descendant IDs
  const toRemove = new Set<string>();

  function collectDescendants(nodeId: string) {
    const response = expandedNodes.get(nodeId);
    if (!response) return;

    for (const child of response.children) {
      toRemove.add(child.id);
      collectDescendants(child.id);
    }

    // Also collect virtual group nodes
    if (response.virtualGroups) {
      for (const vg of response.virtualGroups) {
        const vgId = `vg_${nodeId}_${vg.prefix}`;
        toRemove.add(vgId);
        // Virtual groups can have children expanded too
        collectDescendants(vgId);
      }
    }
  }

  collectDescendants(parentId);

  // Drop all descendant nodes
  for (const nodeId of toRemove) {
    if (graph.hasNode(nodeId)) {
      graph.dropNode(nodeId);
    }
  }

  // Restore parent size and mark as collapsed
  const parentAttrs = graph.getNodeAttributes(parentId);
  const restoredSize = Math.max(4, Math.log2(parentAttrs.childCount || 1) * 2.5);
  graph.setNodeAttribute(parentId, 'size', restoredSize);
  graph.setNodeAttribute(parentId, 'isExpanded', false);
}

/**
 * Get current visible node count in the graph.
 */
export function getVisibleNodeCount(
  graph: Graph<SigmaNodeAttributes, SigmaEdgeAttributes>,
): number {
  // graph.order is O(1) — safe upper bound since hidden nodes are rare in hierarchy view
  return graph.order;
}

/**
 * Check if expanding a node would exceed the node budget.
 */
export function wouldExceedBudget(
  graph: Graph<SigmaNodeAttributes, SigmaEdgeAttributes>,
  childCount: number,
): boolean {
  return getVisibleNodeCount(graph) + childCount > NODE_BUDGET;
}

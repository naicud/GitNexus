import { useEffect, useCallback, useMemo, useState, useRef as useReactRef, forwardRef, useImperativeHandle } from 'react';
import { ZoomIn, ZoomOut, Maximize2, Focus, RotateCcw, Play, Pause, Lightbulb, LightbulbOff, Minimize2, Table2, GitBranch, Palette } from 'lucide-react';
import { useSigma } from '../hooks/useSigma';
import { useAppState } from '../hooks/useAppState';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { knowledgeGraphToGraphology, filterGraphByDepth, SigmaNodeAttributes, SigmaEdgeAttributes } from '../lib/graph-adapter';
import { summaryToGraphology, expandGroupInGraph, collapseGroupInGraph, addNeighborsToGraph } from '../lib/summary-graph-adapter';
import { fetchGroupExpansion, fetchNeighbors } from '../services/graph-lod';
import { QueryFAB } from './QueryFAB';
import { ContextMenu } from './ContextMenu';
import { NeighborPanel } from './NeighborPanel';
import { SchemaGraph } from './SchemaGraph';
import { StylingPanel } from './StylingPanel';
import Graph from 'graphology';

export interface GraphCanvasHandle {
  focusNode: (nodeId: string) => void;
}

export const GraphCanvas = forwardRef<GraphCanvasHandle>((_, ref) => {
  const {
    graph,
    setSelectedNode,
    selectedNode: appSelectedNode,
    visibleLabels,
    visibleEdgeTypes,
    openCodePanel,
    depthFilter,
    highlightedNodeIds,
    setHighlightedNodeIds,
    aiCitationHighlightedNodeIds,
    aiToolHighlightedNodeIds,
    blastRadiusNodeIds,
    isAIHighlightsEnabled,
    toggleAIHighlights,
    animatedNodes,
    graphViewMode,
    expandedGroups,
    setExpandedGroups,
    graphSummary,
    graphTruncated,
    serverBaseUrl,
    projectName,
    isDataExplorerOpen,
    setDataExplorerOpen,
  } = useAppState();
  const [hoveredNodeName, setHoveredNodeName] = useState<string | null>(null);
  const [expandingGroup, setExpandingGroup] = useState<string | null>(null);
  const [exploringNeighbors, setExploringNeighbors] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; nodeId: string | null; nodeName?: string; nodeType?: string } | null>(null);
  const [neighborPanelNodeId, setNeighborPanelNodeId] = useState<string | null>(null);
  const [isSchemaOpen, setSchemaOpen] = useState(false);
  const [isStylingOpen, setStylingOpen] = useState(false);

  // O(1) node lookup map — replaces O(n) graph.nodes.find() calls throughout the component
  const nodeMap = useMemo(() => {
    if (!graph) return new Map<string, typeof graph.nodes[0]>();
    return new Map(graph.nodes.map(n => [n.id, n]));
  }, [graph]);

  const effectiveHighlightedNodeIds = useMemo(() => {
    if (!isAIHighlightsEnabled) return highlightedNodeIds;
    const next = new Set(highlightedNodeIds);
    for (const id of aiCitationHighlightedNodeIds) next.add(id);
    for (const id of aiToolHighlightedNodeIds) next.add(id);
    // Note: blast radius nodes are handled separately with red color
    return next;
  }, [highlightedNodeIds, aiCitationHighlightedNodeIds, aiToolHighlightedNodeIds, isAIHighlightsEnabled]);

  // Blast radius nodes (only when AI highlights enabled)
  const effectiveBlastRadiusNodeIds = useMemo(() => {
    if (!isAIHighlightsEnabled) return new Set<string>();
    return blastRadiusNodeIds;
  }, [blastRadiusNodeIds, isAIHighlightsEnabled]);

  // Animated nodes (only when AI highlights enabled)
  const effectiveAnimatedNodes = useMemo(() => {
    if (!isAIHighlightsEnabled) return new Map();
    return animatedNodes;
  }, [animatedNodes, isAIHighlightsEnabled]);

  const handleNodeClick = useCallback((nodeId: string) => {
    const node = nodeMap.get(nodeId);
    if (node) {
      setSelectedNode(node);
      openCodePanel();
    }
  }, [nodeMap, setSelectedNode, openCodePanel]);

  const handleNodeHover = useCallback((nodeId: string | null) => {
    if (!nodeId) {
      setHoveredNodeName(null);
      return;
    }
    const node = nodeMap.get(nodeId);
    if (node) {
      setHoveredNodeName(node.properties.name);
    }
  }, [nodeMap]);

  const handleStageClick = useCallback(() => {
    setSelectedNode(null);
    setContextMenu(null);
  }, [setSelectedNode]);

  // Right-click context menu via Sigma's public rightClickNode event
  const handleNodeRightClick = useCallback((nodeId: string, event: { clientX: number; clientY: number }) => {
    const node = nodeMap.get(nodeId);
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      nodeId,
      nodeName: node?.properties.name,
      nodeType: node?.label,
    });
  }, [nodeMap]);

  // LOD: Handle group expansion on double-click
  const handleGroupExpand = useCallback(async (groupLabel: string, groupId: string) => {
    if (!serverBaseUrl || !projectName || !graphSummary || expandingGroup) return;
    if (expandedGroups.has(groupId)) return; // Already expanded

    setExpandingGroup(groupId);
    try {
      const expansion = await fetchGroupExpansion(serverBaseUrl, projectName, groupLabel);
      const sigmaGraph = sigmaGraphRef.current;
      if (!sigmaGraph) return;

      const newNodeIds = expandGroupInGraph(sigmaGraph, expansion, groupId, graphSummary);

      // Track expanded group
      const next = new Map(expandedGroups);
      next.set(groupId, newNodeIds);
      setExpandedGroups(next);

      // Restart layout briefly for new nodes
      if (sigmaInstance.current) {
        sigmaInstance.current.refresh();
      }
      if (newNodeIds.length > 0) {
        runLayoutFn.current?.(sigmaGraph);
      }
    } catch (err) {
      console.error('Failed to expand group:', err);
    } finally {
      setExpandingGroup(null);
    }
  }, [serverBaseUrl, projectName, graphSummary, expandedGroups, setExpandedGroups, expandingGroup]);

  // LOD: Handle group collapse
  const handleGroupCollapse = useCallback((groupId: string) => {
    if (!graphSummary) return;
    const nodeIds = expandedGroups.get(groupId);
    if (!nodeIds) return;

    const sigmaGraph = sigmaGraphRef.current;
    if (!sigmaGraph) return;

    const groupLabel = groupId.replace(/^cg_/, '');
    collapseGroupInGraph(sigmaGraph, groupId, groupLabel, graphSummary, nodeIds);

    const next = new Map(expandedGroups);
    next.delete(groupId);
    setExpandedGroups(next);

    if (sigmaInstance.current) {
      sigmaInstance.current.refresh();
    }
  }, [graphSummary, expandedGroups, setExpandedGroups]);

  // Neighbor exploration: expand neighbors of a symbol node
  const handleExploreNeighbors = useCallback(async (nodeId: string, depth: number = 1) => {
    if (!serverBaseUrl || !projectName || exploringNeighbors) return;
    setExploringNeighbors(true);
    setContextMenu(null);
    try {
      const expansion = await fetchNeighbors(serverBaseUrl, projectName, nodeId, depth);
      const sigmaGraph = sigmaGraphRef.current;
      if (!sigmaGraph) return;

      const newNodeIds = addNeighborsToGraph(sigmaGraph, expansion, nodeId);

      if (sigmaInstance.current) {
        sigmaInstance.current.refresh();
      }
      if (newNodeIds.length > 0) {
        runLayoutFn.current?.(sigmaGraph);
      }
    } catch (err) {
      console.error('Failed to explore neighbors:', err);
    } finally {
      setExploringNeighbors(false);
    }
  }, [serverBaseUrl, projectName, exploringNeighbors]);

  // Dismiss a node from the canvas
  const handleDismissNode = useCallback((nodeId: string) => {
    setContextMenu(null);
    const sigmaGraph = sigmaGraphRef.current;
    if (!sigmaGraph || !sigmaGraph.hasNode(nodeId)) return;
    sigmaGraph.dropNode(nodeId);
    if (sigmaInstance.current) {
      sigmaInstance.current.refresh();
    }
  }, []);

  // LOD: Collapse all expanded groups
  const handleCollapseAll = useCallback(() => {
    for (const groupId of expandedGroups.keys()) {
      handleGroupCollapse(groupId);
    }
  }, [expandedGroups, handleGroupCollapse]);

  // Show in code: select node and open code panel
  const handleShowInCode = useCallback((nodeId: string) => {
    const node = nodeMap.get(nodeId);
    if (node) {
      setSelectedNode(node);
      openCodePanel();
    }
  }, [nodeMap, setSelectedNode, openCodePanel]);

  // Open neighbor panel for a node
  const handleOpenNeighborPanel = useCallback((nodeId: string) => {
    setNeighborPanelNodeId(nodeId);
  }, []);

  // Neighbor panel expansion with type/direction filtering
  const handleNeighborExpand = useCallback(async (nodeId: string, depth: number, types?: string[], direction?: 'inbound' | 'outbound' | 'both') => {
    if (!serverBaseUrl || !projectName || exploringNeighbors) return;
    setExploringNeighbors(true);
    try {
      const expansion = await fetchNeighbors(serverBaseUrl, projectName, nodeId, depth, 200, types, direction);
      const sigmaGraph = sigmaGraphRef.current;
      if (!sigmaGraph) return;

      const newNodeIds = addNeighborsToGraph(sigmaGraph, expansion, nodeId);

      if (sigmaInstance.current) {
        sigmaInstance.current.refresh();
      }
      if (newNodeIds.length > 0) {
        runLayoutFn.current?.(sigmaGraph);
      }
    } catch (err) {
      console.error('Failed to explore neighbors:', err);
    } finally {
      setExploringNeighbors(false);
    }
  }, [serverBaseUrl, projectName, exploringNeighbors]);

  const {
    containerRef,
    sigmaRef,
    graphRef: sigmaGraphRefFromHook,
    setGraph: setSigmaGraph,
    zoomIn,
    zoomOut,
    resetZoom,
    focusNode,
    isLayoutRunning,
    startLayout,
    stopLayout,
    runLayout,
    selectedNode: sigmaSelectedNode,
    setSelectedNode: setSigmaSelectedNode,
  } = useSigma({
    onNodeClick: handleNodeClick,
    onNodeHover: handleNodeHover,
    onStageClick: handleStageClick,
    onGroupExpand: handleGroupExpand,
    onNodeRightClick: handleNodeRightClick,
    highlightedNodeIds: effectiveHighlightedNodeIds,
    blastRadiusNodeIds: effectiveBlastRadiusNodeIds,
    animatedNodes: effectiveAnimatedNodes,
    visibleEdgeTypes,
  });

  // Refs for accessing sigma internals from LOD callbacks (avoids stale closure issues)
  const sigmaGraphRef = sigmaGraphRefFromHook;
  const sigmaInstance = sigmaRef;
  const runLayoutFn = useReactRef(runLayout);
  runLayoutFn.current = runLayout;

  // Keyboard shortcuts
  const keyboardActions = useMemo(() => ({
    onDeselect: () => {
      setSelectedNode(null);
      setSigmaSelectedNode(null);
      setContextMenu(null);
      setNeighborPanelNodeId(null);
    },
    onFitToScreen: resetZoom,
    onToggleLayout: () => {
      if (isLayoutRunning) stopLayout();
      else startLayout();
    },
    onOpenNeighborPanel: () => {
      if (appSelectedNode) {
        setNeighborPanelNodeId(appSelectedNode.id);
      }
    },
    onToggleDataExplorer: () => {
      setDataExplorerOpen(!isDataExplorerOpen);
    },
    onDismissNode: () => {
      if (appSelectedNode) {
        handleDismissNode(appSelectedNode.id);
        setSelectedNode(null);
        setSigmaSelectedNode(null);
      }
    },
  }), [setSelectedNode, setSigmaSelectedNode, resetZoom, isLayoutRunning, stopLayout, startLayout, appSelectedNode, isDataExplorerOpen, setDataExplorerOpen, handleDismissNode]);

  useKeyboardShortcuts(keyboardActions);

  // Expose focusNode to parent via ref
  useImperativeHandle(ref, () => ({
    focusNode: (nodeId: string) => {
      // Also update app state so the selection syncs properly
      const node = nodeMap.get(nodeId);
      if (node) {
        setSelectedNode(node);
        openCodePanel();
      }
      focusNode(nodeId);
    }
  }), [focusNode, nodeMap, setSelectedNode, openCodePanel]);

  // Update Sigma graph when KnowledgeGraph or summary changes
  useEffect(() => {
    // LOD mode: build from summary
    if (graphViewMode === 'summary' && graphSummary) {
      const sigmaGraph = summaryToGraphology(graphSummary);
      setSigmaGraph(sigmaGraph);
      return;
    }

    // Full mode: build from KnowledgeGraph
    if (!graph) return;

    // Build communityMemberships map from MEMBER_OF relationships
    // MEMBER_OF edges: nodeId -> communityId (stored as targetId)
    // Reuse component-level nodeMap for O(1) community node lookups
    const communityMemberships = new Map<string, number>();
    graph.relationships.forEach(rel => {
      if (rel.type === 'MEMBER_OF') {
        // O(1) lookup via nodeMap instead of O(n) graph.nodes.find()
        const communityNode = nodeMap.get(rel.targetId);
        if (communityNode && communityNode.label === 'Community') {
          // Extract community index from id (e.g., "comm_5" -> 5)
          const communityIdx = parseInt(rel.targetId.replace('comm_', ''), 10) || 0;
          communityMemberships.set(rel.sourceId, communityIdx);
        }
      }
    });

    const sigmaGraph = knowledgeGraphToGraphology(graph, communityMemberships);
    setSigmaGraph(sigmaGraph);
  }, [graph, graphViewMode, graphSummary, setSigmaGraph, nodeMap]);

  // Update node visibility when filters change
  useEffect(() => {
    const sigma = sigmaRef.current;
    if (!sigma) return;

    const sigmaGraph = sigma.getGraph() as Graph<SigmaNodeAttributes, SigmaEdgeAttributes>;
    if (sigmaGraph.order === 0) return; // Don't filter empty graph

    filterGraphByDepth(sigmaGraph, appSelectedNode?.id || null, depthFilter, visibleLabels);
    sigma.refresh();
  }, [visibleLabels, depthFilter, appSelectedNode, sigmaRef]);

  // Sync app selected node with sigma
  useEffect(() => {
    if (appSelectedNode) {
      setSigmaSelectedNode(appSelectedNode.id);
    } else {
      setSigmaSelectedNode(null);
    }
  }, [appSelectedNode, setSigmaSelectedNode]);

  // Focus on selected node
  const handleFocusSelected = useCallback(() => {
    if (appSelectedNode) {
      focusNode(appSelectedNode.id);
    }
  }, [appSelectedNode, focusNode]);

  // Clear selection
  const handleClearSelection = useCallback(() => {
    setSelectedNode(null);
    setSigmaSelectedNode(null);
    resetZoom();
  }, [setSelectedNode, setSigmaSelectedNode, resetZoom]);

  return (
    <div className="relative w-full h-full bg-void">
      {/* Background gradient */}
      <div className="absolute inset-0 pointer-events-none">
        <div
          className="absolute inset-0"
          style={{
            background: `
              radial-gradient(circle at 50% 50%, rgba(124, 58, 237, 0.03) 0%, transparent 70%),
              linear-gradient(to bottom, #06060a, #0a0a10)
            `
          }}
        />
      </div>

      {/* Sigma container */}
      <div
        ref={containerRef}
        className="sigma-container w-full h-full cursor-grab active:cursor-grabbing"
        onContextMenu={(e) => {
          e.preventDefault();
          // Show canvas context menu (node right-clicks are handled by Sigma's rightClickNode event)
          if (!contextMenu) {
            setContextMenu({ x: e.clientX, y: e.clientY, nodeId: null });
          }
        }}
      />

      {/* Hovered node tooltip - only show when NOT selected */}
      {hoveredNodeName && !sigmaSelectedNode && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 px-3 py-1.5 bg-elevated/95 border border-border-subtle rounded-lg backdrop-blur-sm z-20 pointer-events-none animate-fade-in">
          <span className="font-mono text-sm text-text-primary">{hoveredNodeName}</span>
        </div>
      )}

      {/* Selection info bar */}
      {sigmaSelectedNode && appSelectedNode && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 flex items-center gap-2 px-4 py-2 bg-accent/20 border border-accent/30 rounded-xl backdrop-blur-sm z-20 animate-slide-up">
          <div className="w-2 h-2 bg-accent rounded-full animate-pulse" />
          <span className="font-mono text-sm text-text-primary">
            {appSelectedNode.properties.name}
          </span>
          <span className="text-xs text-text-muted">
            ({appSelectedNode.label})
          </span>
          <button
            onClick={handleClearSelection}
            className="ml-2 px-2 py-0.5 text-xs text-text-secondary hover:text-text-primary hover:bg-white/10 rounded transition-colors"
          >
            Clear
          </button>
        </div>
      )}

      {/* Graph Controls - Bottom Right */}
      <div className="absolute bottom-4 right-4 flex flex-col gap-1 z-10">
        <button
          onClick={zoomIn}
          className="w-9 h-9 flex items-center justify-center bg-elevated border border-border-subtle rounded-md text-text-secondary hover:bg-hover hover:text-text-primary transition-colors"
          title="Zoom In"
        >
          <ZoomIn className="w-4 h-4" />
        </button>
        <button
          onClick={zoomOut}
          className="w-9 h-9 flex items-center justify-center bg-elevated border border-border-subtle rounded-md text-text-secondary hover:bg-hover hover:text-text-primary transition-colors"
          title="Zoom Out"
        >
          <ZoomOut className="w-4 h-4" />
        </button>
        <button
          onClick={resetZoom}
          className="w-9 h-9 flex items-center justify-center bg-elevated border border-border-subtle rounded-md text-text-secondary hover:bg-hover hover:text-text-primary transition-colors"
          title="Fit to Screen"
        >
          <Maximize2 className="w-4 h-4" />
        </button>

        {/* Divider */}
        <div className="h-px bg-border-subtle my-1" />

        {/* Focus on selected */}
        {appSelectedNode && (
          <button
            onClick={handleFocusSelected}
            className="w-9 h-9 flex items-center justify-center bg-accent/20 border border-accent/30 rounded-md text-accent hover:bg-accent/30 transition-colors"
            title="Focus on Selected Node"
          >
            <Focus className="w-4 h-4" />
          </button>
        )}

        {/* Clear selection */}
        {sigmaSelectedNode && (
          <button
            onClick={handleClearSelection}
            className="w-9 h-9 flex items-center justify-center bg-elevated border border-border-subtle rounded-md text-text-secondary hover:bg-hover hover:text-text-primary transition-colors"
            title="Clear Selection"
          >
            <RotateCcw className="w-4 h-4" />
          </button>
        )}

        {/* Divider */}
        <div className="h-px bg-border-subtle my-1" />

        {/* Layout control */}
        <button
          onClick={isLayoutRunning ? stopLayout : startLayout}
          className={`
            w-9 h-9 flex items-center justify-center border rounded-md transition-all
            ${isLayoutRunning
              ? 'bg-accent border-accent text-white shadow-glow animate-pulse'
              : 'bg-elevated border-border-subtle text-text-secondary hover:bg-hover hover:text-text-primary'
            }
          `}
          title={isLayoutRunning ? 'Stop Layout' : 'Run Layout Again'}
        >
          {isLayoutRunning ? (
            <Pause className="w-4 h-4" />
          ) : (
            <Play className="w-4 h-4" />
          )}
        </button>

        {/* Collapse All - only in summary mode with expanded groups */}
        {graphViewMode === 'summary' && expandedGroups.size > 0 && (
          <>
            <div className="h-px bg-border-subtle my-1" />
            <button
              onClick={handleCollapseAll}
              className="w-9 h-9 flex items-center justify-center bg-violet-500/20 border border-violet-500/30 rounded-md text-violet-300 hover:bg-violet-500/30 transition-colors"
              title="Collapse All Groups"
            >
              <Minimize2 className="w-4 h-4" />
            </button>
          </>
        )}

        {/* Data Explorer toggle */}
        <div className="h-px bg-border-subtle my-1" />
        <button
          onClick={() => setDataExplorerOpen(!isDataExplorerOpen)}
          className={`w-9 h-9 flex items-center justify-center border rounded-md transition-colors ${
            isDataExplorerOpen
              ? 'bg-accent/20 border-accent/30 text-accent'
              : 'bg-elevated border-border-subtle text-text-secondary hover:bg-hover hover:text-text-primary'
          }`}
          title="Toggle Data Explorer"
        >
          <Table2 className="w-4 h-4" />
        </button>
        <button
          onClick={() => setSchemaOpen(true)}
          className="w-9 h-9 flex items-center justify-center bg-elevated border border-border-subtle rounded-md text-text-secondary hover:bg-hover hover:text-text-primary transition-colors"
          title="View Schema"
        >
          <GitBranch className="w-4 h-4" />
        </button>
        <button
          onClick={() => setStylingOpen(true)}
          className="w-9 h-9 flex items-center justify-center bg-elevated border border-border-subtle rounded-md text-text-secondary hover:bg-hover hover:text-text-primary transition-colors"
          title="Graph Styling"
        >
          <Palette className="w-4 h-4" />
        </button>
      </div>

      {/* Layout running indicator */}
      {isLayoutRunning && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-2 px-3 py-1.5 bg-emerald-500/20 border border-emerald-500/30 rounded-full backdrop-blur-sm z-10 animate-fade-in">
          <div className="w-2 h-2 bg-emerald-400 rounded-full animate-ping" />
          <span className="text-xs text-emerald-400 font-medium">Layout optimizing...</span>
        </div>
      )}

      {/* Expanding group indicator */}
      {expandingGroup && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-2 px-3 py-1.5 bg-violet-500/20 border border-violet-500/30 rounded-full backdrop-blur-sm z-10 animate-fade-in">
          <div className="w-2 h-2 bg-violet-400 rounded-full animate-ping" />
          <span className="text-xs text-violet-400 font-medium">Expanding cluster...</span>
        </div>
      )}

      {/* Exploring neighbors indicator */}
      {exploringNeighbors && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-2 px-3 py-1.5 bg-cyan-500/20 border border-cyan-500/30 rounded-full backdrop-blur-sm z-10 animate-fade-in">
          <div className="w-2 h-2 bg-cyan-400 rounded-full animate-ping" />
          <span className="text-xs text-cyan-400 font-medium">Exploring neighbors...</span>
        </div>
      )}

      {/* Truncation banner */}
      {graphTruncated && graphViewMode === 'full' && (
        <div className="absolute top-4 left-4 flex items-center gap-2 px-3 py-1.5 bg-amber-500/10 border border-amber-500/20 rounded-lg backdrop-blur-sm z-10">
          <span className="text-xs text-amber-300 font-medium">
            Graph truncated ({graph?.nodes?.length?.toLocaleString() ?? '?'} loaded) — use cluster view or search to explore
          </span>
        </div>
      )}

      {/* Empty summary message */}
      {graphViewMode === 'summary' && graphSummary && graphSummary.clusterGroups.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
          <div className="px-6 py-4 bg-elevated/90 border border-border-subtle rounded-xl backdrop-blur-sm text-center">
            <p className="text-sm text-text-secondary">No cluster groups found.</p>
            <p className="text-xs text-text-muted mt-1">Re-index the repository to generate community clusters.</p>
          </div>
        </div>
      )}

      {/* Summary mode indicator */}
      {graphViewMode === 'summary' && graphSummary && graphSummary.clusterGroups.length > 0 && (
        <div className="absolute bottom-4 left-4 flex items-center gap-2 px-3 py-1.5 bg-violet-500/10 border border-violet-500/20 rounded-lg backdrop-blur-sm z-10">
          <span className="text-xs text-violet-300 font-medium">
            LOD View {expandedGroups.size > 0 ? `(${expandedGroups.size} expanded)` : ''} — Double-click to expand, right-click for options
          </span>
        </div>
      )}

      {/* Context Menu */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          nodeId={contextMenu.nodeId}
          nodeName={contextMenu.nodeName}
          nodeType={contextMenu.nodeType}
          onExploreNeighbors={handleExploreNeighbors}
          onOpenNeighborPanel={handleOpenNeighborPanel}
          onShowInCode={handleShowInCode}
          onDismissNode={handleDismissNode}
          onResetZoom={resetZoom}
          onToggleLayout={isLayoutRunning ? stopLayout : startLayout}
          onCollapseAll={handleCollapseAll}
          onClose={() => setContextMenu(null)}
          isLayoutRunning={isLayoutRunning}
          hasExpandedGroups={expandedGroups.size > 0}
          graphViewMode={graphViewMode}
        />
      )}

      {/* Neighbor Panel */}
      {neighborPanelNodeId && serverBaseUrl && projectName && (
        <NeighborPanel
          nodeId={neighborPanelNodeId}
          nodeName={nodeMap.get(neighborPanelNodeId)?.properties.name || neighborPanelNodeId}
          nodeType={nodeMap.get(neighborPanelNodeId)?.label || 'Unknown'}
          baseUrl={serverBaseUrl}
          repo={projectName}
          isOpen={!!neighborPanelNodeId}
          onClose={() => setNeighborPanelNodeId(null)}
          onExpand={handleNeighborExpand}
        />
      )}

      {/* Schema Graph Modal */}
      <SchemaGraph
        isOpen={isSchemaOpen}
        onClose={() => setSchemaOpen(false)}
        baseUrl={serverBaseUrl || ''}
        repo={projectName || ''}
      />

      {/* Styling Panel Modal */}
      <StylingPanel isOpen={isStylingOpen} onClose={() => setStylingOpen(false)} />

      {/* Query FAB */}
      <QueryFAB />

      {/* AI Highlights toggle - Top Right */}
      <div className="absolute top-4 right-4 z-20">
        <button
          onClick={() => {
            // If turning off, also clear process highlights
            if (isAIHighlightsEnabled) {
              setHighlightedNodeIds(new Set());
            }
            toggleAIHighlights();
          }}
          className={
            isAIHighlightsEnabled
              ? 'w-10 h-10 flex items-center justify-center bg-cyan-500/15 border border-cyan-400/40 rounded-lg text-cyan-200 hover:bg-cyan-500/20 hover:border-cyan-300/60 transition-colors'
              : 'w-10 h-10 flex items-center justify-center bg-elevated border border-border-subtle rounded-lg text-text-muted hover:bg-hover hover:text-text-primary transition-colors'
          }
          title={isAIHighlightsEnabled ? 'Turn off all highlights' : 'Turn on AI highlights'}
        >
          {isAIHighlightsEnabled ? <Lightbulb className="w-4 h-4" /> : <LightbulbOff className="w-4 h-4" />}
        </button>
      </div>
    </div>
  );
});

GraphCanvas.displayName = 'GraphCanvas';

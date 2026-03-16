import { useState, useCallback, useRef } from 'react';
import { NodeLabel } from '../core/graph/types';
import { DEFAULT_VISIBLE_LABELS } from '../lib/constants';
import { DEFAULT_VISIBLE_EDGES, type EdgeType } from '../lib/constants';

// Animation types for graph nodes
export type AnimationType = 'pulse' | 'ripple' | 'glow';

export interface NodeAnimation {
  type: AnimationType;
  startTime: number;
  duration: number;
}

export interface QueryResult {
  rows: Record<string, any>[];
  nodeIds: string[];
  executionTime: number;
}

export interface FilterState {
  // Filters
  visibleLabels: NodeLabel[];
  toggleLabelVisibility: (label: NodeLabel) => void;
  visibleEdgeTypes: EdgeType[];
  toggleEdgeVisibility: (edgeType: EdgeType) => void;

  // Depth filter
  depthFilter: number | null;
  setDepthFilter: (depth: number | null) => void;

  // Query/highlight state
  highlightedNodeIds: Set<string>;
  setHighlightedNodeIds: (ids: Set<string>) => void;
  queryResult: QueryResult | null;
  setQueryResult: (result: QueryResult | null) => void;
  clearQueryHighlights: () => void;

  // AI highlights
  aiCitationHighlightedNodeIds: Set<string>;
  setAICitationHighlightedNodeIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  aiToolHighlightedNodeIds: Set<string>;
  setAIToolHighlightedNodeIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  blastRadiusNodeIds: Set<string>;
  setBlastRadiusNodeIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  isAIHighlightsEnabled: boolean;
  toggleAIHighlights: () => void;
  clearAIToolHighlights: () => void;
  clearBlastRadius: () => void;

  // Node animations
  animatedNodes: Map<string, NodeAnimation>;
  triggerNodeAnimation: (nodeIds: string[], type: AnimationType) => void;
  clearAnimations: () => void;
}

export function useFilterState(): FilterState {
  // Filters
  const [visibleLabels, setVisibleLabels] = useState<NodeLabel[]>(DEFAULT_VISIBLE_LABELS);
  const [visibleEdgeTypes, setVisibleEdgeTypes] = useState<EdgeType[]>(DEFAULT_VISIBLE_EDGES);

  // Depth filter
  const [depthFilter, setDepthFilter] = useState<number | null>(null);

  // Query state
  const [highlightedNodeIds, setHighlightedNodeIds] = useState<Set<string>>(new Set());
  const [queryResult, setQueryResult] = useState<QueryResult | null>(null);

  // AI highlights
  const [aiCitationHighlightedNodeIds, setAICitationHighlightedNodeIds] = useState<Set<string>>(new Set());
  const [aiToolHighlightedNodeIds, setAIToolHighlightedNodeIds] = useState<Set<string>>(new Set());
  const [blastRadiusNodeIds, setBlastRadiusNodeIds] = useState<Set<string>>(new Set());
  const [isAIHighlightsEnabled, setAIHighlightsEnabled] = useState(true);

  const toggleAIHighlights = useCallback(() => {
    setAIHighlightsEnabled(prev => !prev);
  }, []);

  const clearAIToolHighlights = useCallback(() => {
    setAIToolHighlightedNodeIds(new Set());
  }, []);

  const clearBlastRadius = useCallback(() => {
    setBlastRadiusNodeIds(new Set());
  }, []);

  const clearQueryHighlights = useCallback(() => {
    setHighlightedNodeIds(new Set());
    setQueryResult(null);
  }, []);

  // Node animations
  const [animatedNodes, setAnimatedNodes] = useState<Map<string, NodeAnimation>>(new Map());
  const animationTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const triggerNodeAnimation = useCallback((nodeIds: string[], type: AnimationType) => {
    const now = Date.now();
    const duration = type === 'pulse' ? 2000 : type === 'ripple' ? 3000 : 4000;

    setAnimatedNodes(prev => {
      const next = new Map(prev);
      for (const id of nodeIds) {
        next.set(id, { type, startTime: now, duration });
      }
      return next;
    });

    // Auto-cleanup after duration
    setTimeout(() => {
      setAnimatedNodes(prev => {
        const next = new Map(prev);
        for (const id of nodeIds) {
          const anim = next.get(id);
          if (anim && anim.startTime === now) {
            next.delete(id);
          }
        }
        return next;
      });
    }, duration + 100);
  }, []);

  const clearAnimations = useCallback(() => {
    setAnimatedNodes(new Map());
    if (animationTimerRef.current) {
      clearInterval(animationTimerRef.current);
      animationTimerRef.current = null;
    }
  }, []);

  const toggleLabelVisibility = useCallback((label: NodeLabel) => {
    setVisibleLabels(prev => {
      if (prev.includes(label)) {
        return prev.filter(l => l !== label);
      } else {
        return [...prev, label];
      }
    });
  }, []);

  const toggleEdgeVisibility = useCallback((edgeType: EdgeType) => {
    setVisibleEdgeTypes(prev => {
      if (prev.includes(edgeType)) {
        return prev.filter(t => t !== edgeType);
      } else {
        return [...prev, edgeType];
      }
    });
  }, []);

  return {
    visibleLabels,
    toggleLabelVisibility,
    visibleEdgeTypes,
    toggleEdgeVisibility,
    depthFilter,
    setDepthFilter,
    highlightedNodeIds,
    setHighlightedNodeIds,
    queryResult,
    setQueryResult,
    clearQueryHighlights,
    aiCitationHighlightedNodeIds,
    setAICitationHighlightedNodeIds,
    aiToolHighlightedNodeIds,
    setAIToolHighlightedNodeIds,
    blastRadiusNodeIds,
    setBlastRadiusNodeIds,
    isAIHighlightsEnabled,
    toggleAIHighlights,
    clearAIToolHighlights,
    clearBlastRadius,
    animatedNodes,
    triggerNodeAnimation,
    clearAnimations,
  };
}

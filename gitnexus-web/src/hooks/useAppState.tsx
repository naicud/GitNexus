import { createContext, useContext, useMemo, useRef, useEffect, ReactNode } from 'react';
import { KnowledgeGraph, GraphNode, NodeLabel } from '../core/graph/types';
import { PipelineProgress, PipelineResult } from '../types/pipeline';
import type { FileEntry } from '../services/zip';
import type { EmbeddingProgress, SemanticSearchResult } from '../core/embeddings/types';
import type { LLMSettings, ProviderConfig, ChatMessage, ToolCallInfo } from '../core/llm/types';
import type { EdgeType } from '../lib/constants';
import type { RepoSummary } from '../services/server-connection';

// Import split hooks
import { useGraphState } from './useGraphState';
import { useFilterState } from './useFilterState';
import { useChatState } from './useChatState';
import { useWorkerState } from './useWorkerState';

// Re-export types from split hooks for backwards compatibility
export type { ViewMode, RightPanelTab, CodeReference, CodeReferenceFocus } from './useGraphState';
export type { EmbeddingStatus } from './useWorkerState';
export type { AnimationType, NodeAnimation, QueryResult } from './useFilterState';

interface AppState {
  // View state
  viewMode: import('./useGraphState').ViewMode;
  setViewMode: (mode: import('./useGraphState').ViewMode) => void;

  // Graph data
  graph: KnowledgeGraph | null;
  setGraph: (graph: KnowledgeGraph | null) => void;
  fileContents: Map<string, string>;
  setFileContents: (contents: Map<string, string>) => void;

  // Selection
  selectedNode: GraphNode | null;
  setSelectedNode: (node: GraphNode | null) => void;

  // Right Panel (unified Code + Chat)
  isRightPanelOpen: boolean;
  setRightPanelOpen: (open: boolean) => void;
  rightPanelTab: import('./useGraphState').RightPanelTab;
  setRightPanelTab: (tab: import('./useGraphState').RightPanelTab) => void;
  openCodePanel: () => void;
  openChatPanel: () => void;

  // Filters
  visibleLabels: NodeLabel[];
  toggleLabelVisibility: (label: NodeLabel) => void;
  visibleEdgeTypes: EdgeType[];
  toggleEdgeVisibility: (edgeType: EdgeType) => void;

  // Depth filter (N hops from selection)
  depthFilter: number | null;
  setDepthFilter: (depth: number | null) => void;

  // Query state
  highlightedNodeIds: Set<string>;
  setHighlightedNodeIds: (ids: Set<string>) => void;
  // AI highlights (toggable)
  aiCitationHighlightedNodeIds: Set<string>;
  aiToolHighlightedNodeIds: Set<string>;
  blastRadiusNodeIds: Set<string>;
  isAIHighlightsEnabled: boolean;
  toggleAIHighlights: () => void;
  clearAIToolHighlights: () => void;
  clearBlastRadius: () => void;
  queryResult: import('./useFilterState').QueryResult | null;
  setQueryResult: (result: import('./useFilterState').QueryResult | null) => void;
  clearQueryHighlights: () => void;

  // Node animations (for MCP tool visual feedback)
  animatedNodes: Map<string, import('./useFilterState').NodeAnimation>;
  triggerNodeAnimation: (nodeIds: string[], type: import('./useFilterState').AnimationType) => void;
  clearAnimations: () => void;

  // Progress
  progress: PipelineProgress | null;
  setProgress: (progress: PipelineProgress | null) => void;

  // Project info
  projectName: string;
  setProjectName: (name: string) => void;

  // Multi-repo switching
  serverBaseUrl: string | null;
  setServerBaseUrl: (url: string | null) => void;
  availableRepos: RepoSummary[];
  setAvailableRepos: (repos: RepoSummary[]) => void;
  switchRepo: (repoName: string) => Promise<void>;

  // LOD (Level-of-Detail) graph state
  graphViewMode: 'full' | 'summary' | 'hierarchy';
  setGraphViewMode: (mode: 'full' | 'summary' | 'hierarchy') => void;
  expandedGroups: Map<string, string[]>; // groupId -> expanded node IDs
  setExpandedGroups: (groups: Map<string, string[]>) => void;
  graphSummary: import('../services/graph-lod').GraphSummary | null;
  setGraphSummary: (s: import('../services/graph-lod').GraphSummary | null) => void;
  graphTruncated: boolean;
  setGraphTruncated: (v: boolean) => void;

  // Hierarchy state
  hierarchyExpandedNodes: Map<string, import('../services/graph-lod').HierarchyResponse>;
  setHierarchyExpandedNodes: (nodes: Map<string, import('../services/graph-lod').HierarchyResponse>) => void;
  hierarchyBreadcrumb: import('../services/graph-lod').HierarchyNode[];
  setHierarchyBreadcrumb: (breadcrumb: import('../services/graph-lod').HierarchyNode[]) => void;

  // Worker API (shared across app)
  runPipeline: (file: File, onProgress: (p: PipelineProgress) => void, clusteringConfig?: ProviderConfig) => Promise<PipelineResult>;
  runPipelineFromFiles: (files: FileEntry[], onProgress: (p: PipelineProgress) => void, clusteringConfig?: ProviderConfig) => Promise<PipelineResult>;
  runQuery: (cypher: string) => Promise<any[]>;
  isDatabaseReady: () => Promise<boolean>;
  hydrateWorkerFromServer: (nodes: any[], relationships: any[], fileContents: Record<string, string>) => Promise<void>;

  // Embedding state
  embeddingStatus: import('./useWorkerState').EmbeddingStatus;
  embeddingProgress: EmbeddingProgress | null;

  // Embedding methods
  startEmbeddings: (forceDevice?: 'webgpu' | 'wasm') => Promise<void>;
  semanticSearch: (query: string, k?: number) => Promise<SemanticSearchResult[]>;
  semanticSearchWithContext: (query: string, k?: number, hops?: number) => Promise<any[]>;
  isEmbeddingReady: boolean;

  // Debug/test methods
  testArrayParams: () => Promise<{ success: boolean; error?: string }>;

  // LLM/Agent state
  llmSettings: LLMSettings;
  updateLLMSettings: (updates: Partial<LLMSettings>) => void;
  isSettingsPanelOpen: boolean;
  setSettingsPanelOpen: (open: boolean) => void;
  isAgentReady: boolean;
  isAgentInitializing: boolean;
  agentError: string | null;

  // Chat state
  chatMessages: ChatMessage[];
  isChatLoading: boolean;
  currentToolCalls: ToolCallInfo[];

  // LLM methods
  refreshLLMSettings: () => void;
  initializeAgent: (overrideProjectName?: string, overrideBackendUrl?: string, overrideFileContents?: Map<string, string>) => Promise<void>;
  sendChatMessage: (message: string) => Promise<void>;
  stopChatResponse: () => void;
  clearChat: () => void;
  generateCypherQuery: (question: string) => Promise<{ query: string; explanation: string } | { error: string }>;

  // Code References Panel
  codeReferences: import('./useGraphState').CodeReference[];
  isCodePanelOpen: boolean;
  setCodePanelOpen: (open: boolean) => void;
  addCodeReference: (ref: Omit<import('./useGraphState').CodeReference, 'id'>) => void;
  removeCodeReference: (id: string) => void;
  clearAICodeReferences: () => void;
  clearCodeReferences: () => void;
  codeReferenceFocus: import('./useGraphState').CodeReferenceFocus | null;

  // Data Explorer Panel
  isDataExplorerOpen: boolean;
  setDataExplorerOpen: (open: boolean) => void;
}

const AppStateContext = createContext<AppState | null>(null);

export const AppStateProvider = ({ children }: { children: ReactNode }) => {
  // Worker state (owns the worker instance, progress, embeddings)
  const workerState = useWorkerState();

  // Filter state (labels, edges, highlights, animations)
  const filterState = useFilterState();

  // Late-binding ref for initializeAgent (chatState is created after graphState,
  // but switchRepo needs to call initializeAgent). The ref is updated after chatState
  // is created, and useGraphState reads deps via ref at call time.
  const initializeAgentRef = useRef<(overrideProjectName?: string, overrideBackendUrl?: string, overrideFileContents?: Map<string, string>) => Promise<void>>(async () => {});

  // Graph state (graph data, selection, panels, code references, multi-repo)
  const graphState = useGraphState({
    setProgress: workerState.setProgress,
    setHighlightedNodeIds: filterState.setHighlightedNodeIds,
    clearAIToolHighlights: filterState.clearAIToolHighlights,
    clearBlastRadius: filterState.clearBlastRadius,
    setQueryResult: filterState.setQueryResult,
    initializeAgent: (...args) => initializeAgentRef.current(...args),
    startEmbeddings: workerState.startEmbeddings,
    hydrateWorkerFromServer: workerState.hydrateWorkerFromServer,
    setAICitationHighlightedNodeIds: filterState.setAICitationHighlightedNodeIds,
  });

  // Chat state (LLM agent, messages, tool calls)
  const chatState = useChatState({
    graph: graphState.graph,
    fileContentsRef: graphState.fileContentsRef,
    serverBaseUrl: graphState.serverBaseUrl,
    projectName: graphState.projectName,
    embeddingStatus: workerState.embeddingStatus,
    apiRef: workerState.apiRef,
    setAIToolHighlightedNodeIds: filterState.setAIToolHighlightedNodeIds,
    setBlastRadiusNodeIds: filterState.setBlastRadiusNodeIds,
    addCodeReference: graphState.addCodeReference,
    clearAICodeReferences: graphState.clearAICodeReferences,
    clearAIToolHighlights: filterState.clearAIToolHighlights,
    resolveFilePath: graphState.resolveFilePath,
    findFileNodeId: graphState.findFileNodeId,
  });

  // Update the late-binding ref now that chatState is available
  initializeAgentRef.current = chatState.initializeAgent;

  // NOTE: This composed value re-creates when ANY sub-hook state changes, so all
  // useAppState() consumers re-render together. For render-critical components,
  // import the specific sub-hook directly (e.g., useGraphState, useFilterState)
  // to subscribe only to the state slice you need.
  const value: AppState = useMemo(() => ({
    // From graphState
    viewMode: graphState.viewMode,
    setViewMode: graphState.setViewMode,
    graph: graphState.graph,
    setGraph: graphState.setGraph,
    fileContents: graphState.fileContents,
    setFileContents: graphState.setFileContents,
    selectedNode: graphState.selectedNode,
    setSelectedNode: graphState.setSelectedNode,
    isRightPanelOpen: graphState.isRightPanelOpen,
    setRightPanelOpen: graphState.setRightPanelOpen,
    rightPanelTab: graphState.rightPanelTab,
    setRightPanelTab: graphState.setRightPanelTab,
    openCodePanel: graphState.openCodePanel,
    openChatPanel: graphState.openChatPanel,
    projectName: graphState.projectName,
    setProjectName: graphState.setProjectName,
    serverBaseUrl: graphState.serverBaseUrl,
    setServerBaseUrl: graphState.setServerBaseUrl,
    availableRepos: graphState.availableRepos,
    setAvailableRepos: graphState.setAvailableRepos,
    switchRepo: graphState.switchRepo,
    graphViewMode: graphState.graphViewMode,
    setGraphViewMode: graphState.setGraphViewMode,
    expandedGroups: graphState.expandedGroups,
    setExpandedGroups: graphState.setExpandedGroups,
    graphSummary: graphState.graphSummary,
    setGraphSummary: graphState.setGraphSummary,
    graphTruncated: graphState.graphTruncated,
    setGraphTruncated: graphState.setGraphTruncated,
    hierarchyExpandedNodes: graphState.hierarchyExpandedNodes,
    setHierarchyExpandedNodes: graphState.setHierarchyExpandedNodes,
    hierarchyBreadcrumb: graphState.hierarchyBreadcrumb,
    setHierarchyBreadcrumb: graphState.setHierarchyBreadcrumb,
    codeReferences: graphState.codeReferences,
    isCodePanelOpen: graphState.isCodePanelOpen,
    setCodePanelOpen: graphState.setCodePanelOpen,
    addCodeReference: graphState.addCodeReference,
    removeCodeReference: graphState.removeCodeReference,
    clearAICodeReferences: graphState.clearAICodeReferences,
    clearCodeReferences: graphState.clearCodeReferences,
    codeReferenceFocus: graphState.codeReferenceFocus,
    isDataExplorerOpen: graphState.isDataExplorerOpen,
    setDataExplorerOpen: graphState.setDataExplorerOpen,
    isSettingsPanelOpen: graphState.isSettingsPanelOpen,
    setSettingsPanelOpen: graphState.setSettingsPanelOpen,

    // From filterState
    visibleLabels: filterState.visibleLabels,
    toggleLabelVisibility: filterState.toggleLabelVisibility,
    visibleEdgeTypes: filterState.visibleEdgeTypes,
    toggleEdgeVisibility: filterState.toggleEdgeVisibility,
    depthFilter: filterState.depthFilter,
    setDepthFilter: filterState.setDepthFilter,
    highlightedNodeIds: filterState.highlightedNodeIds,
    setHighlightedNodeIds: filterState.setHighlightedNodeIds,
    aiCitationHighlightedNodeIds: filterState.aiCitationHighlightedNodeIds,
    aiToolHighlightedNodeIds: filterState.aiToolHighlightedNodeIds,
    blastRadiusNodeIds: filterState.blastRadiusNodeIds,
    isAIHighlightsEnabled: filterState.isAIHighlightsEnabled,
    toggleAIHighlights: filterState.toggleAIHighlights,
    clearAIToolHighlights: filterState.clearAIToolHighlights,
    clearBlastRadius: filterState.clearBlastRadius,
    queryResult: filterState.queryResult,
    setQueryResult: filterState.setQueryResult,
    clearQueryHighlights: filterState.clearQueryHighlights,
    animatedNodes: filterState.animatedNodes,
    triggerNodeAnimation: filterState.triggerNodeAnimation,
    clearAnimations: filterState.clearAnimations,

    // From workerState
    progress: workerState.progress,
    setProgress: workerState.setProgress,
    runPipeline: workerState.runPipeline,
    runPipelineFromFiles: workerState.runPipelineFromFiles,
    runQuery: workerState.runQuery,
    isDatabaseReady: workerState.isDatabaseReady,
    hydrateWorkerFromServer: workerState.hydrateWorkerFromServer,
    embeddingStatus: workerState.embeddingStatus,
    embeddingProgress: workerState.embeddingProgress,
    startEmbeddings: workerState.startEmbeddings,
    semanticSearch: workerState.semanticSearch,
    semanticSearchWithContext: workerState.semanticSearchWithContext,
    isEmbeddingReady: workerState.isEmbeddingReady,
    testArrayParams: workerState.testArrayParams,

    // From chatState
    llmSettings: chatState.llmSettings,
    updateLLMSettings: chatState.updateLLMSettings,
    isAgentReady: chatState.isAgentReady,
    isAgentInitializing: chatState.isAgentInitializing,
    agentError: chatState.agentError,
    chatMessages: chatState.chatMessages,
    isChatLoading: chatState.isChatLoading,
    currentToolCalls: chatState.currentToolCalls,
    refreshLLMSettings: chatState.refreshLLMSettings,
    initializeAgent: chatState.initializeAgent,
    sendChatMessage: chatState.sendChatMessage,
    stopChatResponse: chatState.stopChatResponse,
    clearChat: chatState.clearChat,
    generateCypherQuery: chatState.generateCypherQuery,
  }), [graphState, filterState, workerState, chatState]);

  return (
    <AppStateContext.Provider value={value}>
      {children}
    </AppStateContext.Provider>
  );
};

export const useAppState = (): AppState => {
  const context = useContext(AppStateContext);
  if (!context) {
    throw new Error('useAppState must be used within AppStateProvider');
  }
  return context;
};

import { useState, useCallback, useRef, useEffect } from 'react';
import { KnowledgeGraph, GraphNode } from '../core/graph/types';
import { fetchGraphInfo, fetchGraphSummary, type GraphSummary, type HierarchyResponse, type HierarchyNode } from '../services/graph-lod';
import type { RepoSummary, ConnectToServerResult } from '../services/server-connection';
import { connectToServer } from '../services/server-connection';
import { createKnowledgeGraph } from '../core/graph/graph';
import type { PipelineProgress } from '../types/pipeline';
import type { ProviderConfig } from '../core/llm/types';
import { getActiveProviderConfig } from '../core/llm/settings-service';

export type ViewMode = 'onboarding' | 'loading' | 'exploring';
export type RightPanelTab = 'code' | 'chat';

export interface CodeReference {
  id: string;
  filePath: string;
  startLine?: number;
  endLine?: number;
  nodeId?: string;
  label?: string;
  name?: string;
  source: 'ai' | 'user';
}

export interface CodeReferenceFocus {
  filePath: string;
  startLine?: number;
  endLine?: number;
  ts: number;
}

export interface GraphState {
  // View state
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;

  // Graph data
  graph: KnowledgeGraph | null;
  setGraph: (graph: KnowledgeGraph | null) => void;
  fileContents: Map<string, string>;
  setFileContents: (contents: Map<string, string>) => void;
  fileContentsRef: React.RefObject<Map<string, string>>;

  // Selection
  selectedNode: GraphNode | null;
  setSelectedNode: (node: GraphNode | null) => void;

  // Right Panel
  isRightPanelOpen: boolean;
  setRightPanelOpen: (open: boolean) => void;
  rightPanelTab: RightPanelTab;
  setRightPanelTab: (tab: RightPanelTab) => void;
  openCodePanel: () => void;
  openChatPanel: () => void;

  // Project info
  projectName: string;
  setProjectName: (name: string) => void;

  // Multi-repo switching
  serverBaseUrl: string | null;
  setServerBaseUrl: (url: string | null) => void;
  availableRepos: RepoSummary[];
  setAvailableRepos: (repos: RepoSummary[]) => void;
  switchRepo: (repoName: string) => Promise<void>;

  // LOD state
  graphViewMode: 'full' | 'summary' | 'hierarchy';
  setGraphViewMode: (mode: 'full' | 'summary' | 'hierarchy') => void;
  expandedGroups: Map<string, string[]>;
  setExpandedGroups: (groups: Map<string, string[]>) => void;
  graphSummary: GraphSummary | null;
  setGraphSummary: (s: GraphSummary | null) => void;
  graphTruncated: boolean;
  setGraphTruncated: (v: boolean) => void;

  // Hierarchy state
  hierarchyExpandedNodes: Map<string, HierarchyResponse>;
  setHierarchyExpandedNodes: (nodes: Map<string, HierarchyResponse>) => void;
  hierarchyBreadcrumb: HierarchyNode[];
  setHierarchyBreadcrumb: (breadcrumb: HierarchyNode[]) => void;

  // Code References Panel state
  codeReferences: CodeReference[];
  isCodePanelOpen: boolean;
  setCodePanelOpen: (open: boolean) => void;
  addCodeReference: (ref: Omit<CodeReference, 'id'>) => void;
  removeCodeReference: (id: string) => void;
  clearAICodeReferences: () => void;
  clearCodeReferences: () => void;
  codeReferenceFocus: CodeReferenceFocus | null;

  // Data Explorer Panel state
  isDataExplorerOpen: boolean;
  setDataExplorerOpen: (open: boolean) => void;

  // Settings panel
  isSettingsPanelOpen: boolean;
  setSettingsPanelOpen: (open: boolean) => void;

  // Helpers
  normalizePath: (p: string) => string;
  resolveFilePath: (requestedPath: string) => string | null;
  findFileNodeId: (filePath: string) => string | undefined;
}

export interface SwitchRepoDeps {
  setProgress: (progress: PipelineProgress | null) => void;
  setHighlightedNodeIds: (ids: Set<string>) => void;
  clearAIToolHighlights: () => void;
  clearBlastRadius: () => void;
  setQueryResult: (result: any) => void;
  initializeAgent: (overrideProjectName?: string, overrideBackendUrl?: string, overrideFileContents?: Map<string, string>) => Promise<void>;
  startEmbeddings: (forceDevice?: 'webgpu' | 'wasm') => Promise<void>;
  setAICitationHighlightedNodeIds: React.Dispatch<React.SetStateAction<Set<string>>>;
}

export function useGraphState(switchRepoDeps?: SwitchRepoDeps): GraphState {
  // Keep a ref to switchRepoDeps so callbacks always see the latest version
  // (avoids stale closure issues with late-bound deps like initializeAgent)
  const depsRef = useRef(switchRepoDeps);
  useEffect(() => { depsRef.current = switchRepoDeps; }, [switchRepoDeps]);

  // View state
  const [viewMode, setViewMode] = useState<ViewMode>('onboarding');

  // Graph data
  const [graph, setGraph] = useState<KnowledgeGraph | null>(null);
  const [fileContents, setFileContents] = useState<Map<string, string>>(new Map());
  const fileContentsRef = useRef<Map<string, string>>(new Map());
  useEffect(() => { fileContentsRef.current = fileContents; }, [fileContents]);

  // Selection
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);

  // Right Panel
  const [isRightPanelOpen, setRightPanelOpen] = useState(false);
  const [rightPanelTab, setRightPanelTab] = useState<RightPanelTab>('code');

  // Code References Panel state
  const [codeReferences, setCodeReferences] = useState<CodeReference[]>([]);
  const [isCodePanelOpen, setCodePanelOpen] = useState(false);
  const [codeReferenceFocus, setCodeReferenceFocus] = useState<CodeReferenceFocus | null>(null);

  // Data Explorer Panel state
  const [isDataExplorerOpen, setDataExplorerOpen] = useState(false);

  // Settings panel
  const [isSettingsPanelOpen, setSettingsPanelOpen] = useState(false);

  const openCodePanel = useCallback(() => {
    setCodePanelOpen(true);
  }, []);

  const openChatPanel = useCallback(() => {
    setRightPanelOpen(true);
    setRightPanelTab('chat');
  }, []);

  // Project info
  const [projectName, setProjectName] = useState<string>('');

  // Multi-repo switching
  const [serverBaseUrl, setServerBaseUrl] = useState<string | null>(null);
  const [availableRepos, setAvailableRepos] = useState<RepoSummary[]>([]);

  // LOD state
  const [graphViewMode, setGraphViewMode] = useState<'full' | 'summary' | 'hierarchy'>('full');
  const [expandedGroups, setExpandedGroups] = useState<Map<string, string[]>>(new Map());
  const [graphSummary, setGraphSummary] = useState<GraphSummary | null>(null);
  const [graphTruncated, setGraphTruncated] = useState(false);

  // Hierarchy state
  const [hierarchyExpandedNodes, setHierarchyExpandedNodes] = useState<Map<string, HierarchyResponse>>(new Map());
  const [hierarchyBreadcrumb, setHierarchyBreadcrumb] = useState<HierarchyNode[]>([]);

  // Helpers
  const normalizePath = useCallback((p: string) => {
    return p.replace(/\\/g, '/').replace(/^\.?\//, '');
  }, []);

  const resolveFilePath = useCallback((requestedPath: string): string | null => {
    const req = normalizePath(requestedPath).toLowerCase();
    if (!req) return null;

    // Exact match first
    for (const key of fileContents.keys()) {
      if (normalizePath(key).toLowerCase() === req) return key;
    }

    // Ends-with match (best for partial paths like "src/foo.ts")
    let best: { path: string; score: number } | null = null;
    for (const key of fileContents.keys()) {
      const norm = normalizePath(key).toLowerCase();
      if (norm.endsWith(req)) {
        const score = 1000 - norm.length;
        if (!best || score > best.score) best = { path: key, score };
      }
    }
    if (best) return best.path;

    // Segment match fallback
    const segs = req.split('/').filter(Boolean);
    for (const key of fileContents.keys()) {
      const normSegs = normalizePath(key).toLowerCase().split('/').filter(Boolean);
      let idx = 0;
      for (const s of segs) {
        const found = normSegs.findIndex((x, i) => i >= idx && x.includes(s));
        if (found === -1) { idx = -1; break; }
        idx = found + 1;
      }
      if (idx !== -1) return key;
    }

    return null;
  }, [fileContents, normalizePath]);

  const findFileNodeId = useCallback((filePath: string): string | undefined => {
    if (!graph) return undefined;
    const target = normalizePath(filePath);
    const fileNode = graph.nodes.find(
      (n) => n.label === 'File' && normalizePath(n.properties.filePath) === target
    );
    return fileNode?.id;
  }, [graph, normalizePath]);

  // Code References methods
  const addCodeReference = useCallback((ref: Omit<CodeReference, 'id'>) => {
    const id = `ref-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const newRef: CodeReference = { ...ref, id };

    setCodeReferences(prev => {
      const isDuplicate = prev.some(r =>
        r.filePath === ref.filePath &&
        r.startLine === ref.startLine &&
        r.endLine === ref.endLine
      );
      if (isDuplicate) return prev;
      return [...prev, newRef];
    });

    setCodePanelOpen(true);

    setCodeReferenceFocus({
      filePath: ref.filePath,
      startLine: ref.startLine,
      endLine: ref.endLine,
      ts: Date.now(),
    });

    // Track AI highlights separately
    if (ref.nodeId && ref.source === 'ai' && depsRef.current) {
      depsRef.current.setAICitationHighlightedNodeIds(prev => new Set([...prev, ref.nodeId!]));
    }
  }, []);

  const clearAICodeReferences = useCallback(() => {
    setCodeReferences(prev => {
      const removed = prev.filter(r => r.source === 'ai');
      const kept = prev.filter(r => r.source !== 'ai');

      const removedNodeIds = new Set(removed.map(r => r.nodeId).filter(Boolean) as string[]);
      if (removedNodeIds.size > 0 && depsRef.current) {
        depsRef.current.setAICitationHighlightedNodeIds(prevIds => {
          const next = new Set(prevIds);
          for (const id of removedNodeIds) next.delete(id);
          return next;
        });
      }

      if (kept.length === 0 && !selectedNode) {
        setCodePanelOpen(false);
      }
      return kept;
    });
  }, [selectedNode]);

  // Auto-open code panel when user selects a node
  useEffect(() => {
    if (!selectedNode) return;
    setCodePanelOpen(true);
  }, [selectedNode]);

  const removeCodeReference = useCallback((id: string) => {
    setCodeReferences(prev => {
      const ref = prev.find(r => r.id === id);
      const newRefs = prev.filter(r => r.id !== id);

      if (ref?.nodeId && ref.source === 'ai' && depsRef.current) {
        const stillReferenced = newRefs.some(r => r.nodeId === ref.nodeId && r.source === 'ai');
        if (!stillReferenced) {
          depsRef.current.setAICitationHighlightedNodeIds(prev => {
            const next = new Set(prev);
            next.delete(ref.nodeId!);
            return next;
          });
        }
      }

      if (newRefs.length === 0 && !selectedNode) {
        setCodePanelOpen(false);
      }

      return newRefs;
    });
  }, [selectedNode]);

  const clearCodeReferences = useCallback(() => {
    setCodeReferences([]);
    setCodePanelOpen(false);
    setCodeReferenceFocus(null);
  }, []);

  // Switch to a different repo on the connected server
  const switchRepo = useCallback(async (repoName: string) => {
    if (!serverBaseUrl || !depsRef.current) return;

    const { setProgress, setHighlightedNodeIds, clearAIToolHighlights, clearBlastRadius, setQueryResult, initializeAgent, startEmbeddings } = depsRef.current;

    setProgress({ phase: 'extracting', percent: 0, message: 'Switching repository...', detail: `Loading ${repoName}` });
    setViewMode('loading');

    // Clear stale graph state
    setHighlightedNodeIds(new Set());
    clearAIToolHighlights();
    clearBlastRadius();
    setSelectedNode(null);
    setQueryResult(null);
    setCodeReferences([]);
    setCodePanelOpen(false);
    setCodeReferenceFocus(null);

    try {
      // Check LOD mode before downloading
      let graphMode: 'full' | 'summary' | 'hierarchy' = 'full';
      try {
        const graphInfo = await fetchGraphInfo(serverBaseUrl, repoName);
        graphMode = graphInfo.mode;
      } catch {
        // Older server without /api/graph/info — fall back to full
      }

      if (graphMode === 'hierarchy') {
        setProgress({ phase: 'extracting', percent: 90, message: 'Building hierarchy view...', detail: 'Loading folder structure' });
        setGraph(createKnowledgeGraph());
        setFileContents(new Map());
        setProjectName(repoName);
        setGraphViewMode('hierarchy');
        setGraphSummary(null);
        setExpandedGroups(new Map());
        setHierarchyExpandedNodes(new Map());
        setHierarchyBreadcrumb([]);
        setViewMode('exploring');
        if (getActiveProviderConfig()) initializeAgent(repoName, serverBaseUrl ?? undefined);
      } else if (graphMode === 'summary') {
        setProgress({ phase: 'extracting', percent: 50, message: 'Loading graph summary...', detail: 'Fetching cluster overview' });
        const summary = await fetchGraphSummary(serverBaseUrl, repoName);
        setProgress({ phase: 'extracting', percent: 90, message: 'Building visualization...', detail: `${summary.clusterGroups.length} cluster groups` });
        setGraph(createKnowledgeGraph());
        setFileContents(new Map());
        setProjectName(repoName);
        setGraphSummary(summary);
        setGraphViewMode('summary');
        setExpandedGroups(new Map());
        setHierarchyExpandedNodes(new Map());
        setHierarchyBreadcrumb([]);
        setViewMode('exploring');
        if (getActiveProviderConfig()) initializeAgent(repoName, serverBaseUrl ?? undefined);
      } else {
        // Full-graph path (existing behavior)
        const result: ConnectToServerResult = await connectToServer(serverBaseUrl, (phase, downloaded, total) => {
          if (phase === 'validating') {
            setProgress({ phase: 'extracting', percent: 5, message: 'Switching repository...', detail: 'Validating' });
          } else if (phase === 'downloading') {
            const pct = total ? Math.round((downloaded / total) * 90) + 5 : 50;
            const mb = (downloaded / (1024 * 1024)).toFixed(1);
            setProgress({ phase: 'extracting', percent: pct, message: 'Downloading graph...', detail: `${mb} MB downloaded` });
          } else if (phase === 'extracting') {
            setProgress({ phase: 'extracting', percent: 97, message: 'Processing...', detail: 'Extracting file contents' });
          }
        }, undefined, repoName);

        const repoPath = result.repoInfo.repoPath;
        const pName = result.repoInfo.name || repoPath.split('/').pop() || 'server-project';
        setProjectName(pName);

        const newGraph = createKnowledgeGraph();
        for (const node of result.nodes) newGraph.addNode(node);
        for (const rel of result.relationships) newGraph.addRelationship(rel);
        setGraph(newGraph);

        const fileMap = new Map<string, string>();
        for (const [p, c] of Object.entries(result.fileContents)) fileMap.set(p, c);
        setFileContents(fileMap);

        setGraphViewMode('full');
        setGraphSummary(null);
        setViewMode('exploring');

        if (getActiveProviderConfig()) initializeAgent(pName, serverBaseUrl ?? undefined, fileMap);

        startEmbeddings().catch((err) => {
          if (err?.name === 'WebGPUNotAvailableError' || err?.message?.includes('WebGPU')) {
            startEmbeddings('wasm').catch(console.warn);
          } else {
            console.warn('Embeddings auto-start failed:', err);
          }
        });
      }
    } catch (err) {
      console.error('Repo switch failed:', err);
      setProgress({
        phase: 'error', percent: 0,
        message: 'Failed to switch repository',
        detail: err instanceof Error ? err.message : 'Unknown error',
      });
      setTimeout(() => { setViewMode('exploring'); setProgress(null); }, 3000);
    }
  }, [serverBaseUrl]);

  return {
    viewMode,
    setViewMode,
    graph,
    setGraph,
    fileContents,
    setFileContents,
    fileContentsRef,
    selectedNode,
    setSelectedNode,
    isRightPanelOpen,
    setRightPanelOpen,
    rightPanelTab,
    setRightPanelTab,
    openCodePanel,
    openChatPanel,
    projectName,
    setProjectName,
    serverBaseUrl,
    setServerBaseUrl,
    availableRepos,
    setAvailableRepos,
    switchRepo,
    graphViewMode,
    setGraphViewMode,
    expandedGroups,
    setExpandedGroups,
    graphSummary,
    setGraphSummary,
    graphTruncated,
    setGraphTruncated,
    hierarchyExpandedNodes,
    setHierarchyExpandedNodes,
    hierarchyBreadcrumb,
    setHierarchyBreadcrumb,
    codeReferences,
    isCodePanelOpen,
    setCodePanelOpen,
    addCodeReference,
    removeCodeReference,
    clearAICodeReferences,
    clearCodeReferences,
    codeReferenceFocus,
    isDataExplorerOpen,
    setDataExplorerOpen,
    isSettingsPanelOpen,
    setSettingsPanelOpen,
    normalizePath,
    resolveFilePath,
    findFileNodeId,
  };
}

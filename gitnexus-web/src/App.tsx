import { useCallback, useEffect, useRef } from 'react';
import { AppStateProvider, useAppState } from './hooks/useAppState';
import { DropZone } from './components/DropZone';
import { LoadingOverlay } from './components/LoadingOverlay';
import { Header } from './components/Header';
import { GraphCanvas, GraphCanvasHandle } from './components/GraphCanvas';
import { RightPanel } from './components/RightPanel';
import { SettingsPanel } from './components/SettingsPanel';
import { StatusBar } from './components/StatusBar';
import { FileTreePanel } from './components/FileTreePanel';
import { CodeReferencesPanel } from './components/CodeReferencesPanel';
import { DataExplorer } from './components/DataExplorer';
import { FileEntry } from './services/zip';
import { getActiveProviderConfig } from './core/llm/settings-service';
import { createKnowledgeGraph } from './core/graph/graph';
import { connectToServer, fetchRepos, fetchRepoInfo, normalizeServerUrl, type ConnectToServerResult } from './services/server-connection';
import { fetchGraphInfo, fetchGraphSummary } from './services/graph-lod';


const AppContent = () => {
  const {
    viewMode,
    setViewMode,
    graph,
    setGraph,
    setFileContents,
    setProgress,
    projectName,
    setProjectName,
    progress,
    isRightPanelOpen,
    runPipeline,
    runPipelineFromFiles,
    isSettingsPanelOpen,
    setSettingsPanelOpen,
    refreshLLMSettings,
    initializeAgent,
    startEmbeddings,
    embeddingStatus,
    codeReferences,
    selectedNode,
    isCodePanelOpen,
    isDataExplorerOpen,
    serverBaseUrl,
    setServerBaseUrl,
    availableRepos,
    setAvailableRepos,
    switchRepo,
    setGraphViewMode,
    setGraphSummary,
    setExpandedGroups,
    setGraphTruncated,
  } = useAppState();

  const graphCanvasRef = useRef<GraphCanvasHandle>(null);

  const handleFileSelect = useCallback(async (file: File) => {
    const projectName = file.name.replace('.zip', '');
    setProjectName(projectName);
    setProgress({ phase: 'extracting', percent: 0, message: 'Starting...', detail: 'Preparing to extract files' });
    setViewMode('loading');

    try {
      const result = await runPipeline(file, (progress) => {
        setProgress(progress);
      });

      setGraph(result.graph);
      setFileContents(result.fileContents);
      setViewMode('exploring');

      // Initialize (or re-initialize) the agent AFTER a repo loads so it captures
      // the current codebase context (file contents + graph tools) in the worker.
      if (getActiveProviderConfig()) {
        initializeAgent(projectName);
      }

      // Auto-start embeddings pipeline in background
      // Uses WebGPU if available, falls back to WASM
      startEmbeddings().catch((err) => {
        if (err?.name === 'WebGPUNotAvailableError' || err?.message?.includes('WebGPU')) {
          startEmbeddings('wasm').catch(console.warn);
        } else {
          console.warn('Embeddings auto-start failed:', err);
        }
      });
    } catch (error) {
      console.error('Pipeline error:', error);
      setProgress({
        phase: 'error',
        percent: 0,
        message: 'Error processing file',
        detail: error instanceof Error ? error.message : 'Unknown error',
      });
      setTimeout(() => {
        setViewMode('onboarding');
        setProgress(null);
      }, 3000);
    }
  }, [setViewMode, setGraph, setFileContents, setProgress, setProjectName, runPipeline, startEmbeddings, initializeAgent]);

  const handleGitClone = useCallback(async (files: FileEntry[]) => {
    const firstPath = files[0]?.path || 'repository';
    const projectName = firstPath.split('/')[0].replace(/-\d+$/, '') || 'repository';

    setProjectName(projectName);
    setProgress({ phase: 'extracting', percent: 0, message: 'Starting...', detail: 'Preparing to process files' });
    setViewMode('loading');

    try {
      const result = await runPipelineFromFiles(files, (progress) => {
        setProgress(progress);
      });

      setGraph(result.graph);
      setFileContents(result.fileContents);
      setViewMode('exploring');

      if (getActiveProviderConfig()) {
        initializeAgent(projectName);
      }

      startEmbeddings().catch((err) => {
        if (err?.name === 'WebGPUNotAvailableError' || err?.message?.includes('WebGPU')) {
          startEmbeddings('wasm').catch(console.warn);
        } else {
          console.warn('Embeddings auto-start failed:', err);
        }
      });
    } catch (error) {
      console.error('Pipeline error:', error);
      setProgress({
        phase: 'error',
        percent: 0,
        message: 'Error processing repository',
        detail: error instanceof Error ? error.message : 'Unknown error',
      });
      setTimeout(() => {
        setViewMode('onboarding');
        setProgress(null);
      }, 3000);
    }
  }, [setViewMode, setGraph, setFileContents, setProgress, setProjectName, runPipelineFromFiles, startEmbeddings, initializeAgent]);

  const handleServerConnect = useCallback((result: ConnectToServerResult, backendUrl?: string) => {
    // Extract project name from repoPath
    const repoPath = result.repoInfo.repoPath;
    const projectName = repoPath.split('/').pop() || 'server-project';
    setProjectName(projectName);

    // Build KnowledgeGraph from server data (bypasses WASM pipeline entirely)
    const graph = createKnowledgeGraph();
    for (const node of result.nodes) {
      graph.addNode(node);
    }
    for (const rel of result.relationships) {
      graph.addRelationship(rel);
    }
    setGraph(graph);
    setGraphTruncated(result.truncated ?? false);

    // Set file contents from extracted File node content
    const fileMap = new Map<string, string>();
    for (const [path, content] of Object.entries(result.fileContents)) {
      fileMap.set(path, content);
    }
    setFileContents(fileMap);

    // Transition directly to exploring view
    setViewMode('exploring');

    // Initialize agent if LLM is configured.
    // Pass backendUrl and fileMap explicitly: React state (serverBaseUrl, fileContents)
    // may not have updated yet when this callback runs.
    if (getActiveProviderConfig()) {
      initializeAgent(projectName, backendUrl, fileMap);
    }

    // Auto-start embeddings
    startEmbeddings().catch((err) => {
      if (err?.name === 'WebGPUNotAvailableError' || err?.message?.includes('WebGPU')) {
        startEmbeddings('wasm').catch(console.warn);
      } else {
        console.warn('Embeddings auto-start failed:', err);
      }
    });
  }, [setViewMode, setGraph, setFileContents, setProjectName, setGraphTruncated, initializeAgent, startEmbeddings]);

  // Smart connect: checks LOD mode first, routes to hierarchy/summary/full as appropriate
  const smartConnect = useCallback(async (serverUrl: string, repoName?: string) => {
    const baseUrl = normalizeServerUrl(serverUrl);
    setProgress({ phase: 'extracting', percent: 0, message: 'Connecting to server...', detail: 'Validating server' });
    setViewMode('loading');
    setServerBaseUrl(baseUrl);

    try {
      const repoInfo = await fetchRepoInfo(baseUrl, repoName);
      const name = repoInfo.repoPath.split('/').pop() || 'server-project';
      setProjectName(name);

      // Check LOD mode
      let graphMode: 'full' | 'summary' | 'hierarchy' = 'full';
      try {
        const graphInfo = await fetchGraphInfo(baseUrl, repoName || name);
        graphMode = graphInfo.mode;
      } catch {
        // Older server without /api/graph/info — fall back to full
      }

      if (graphMode === 'hierarchy') {
        setProgress({ phase: 'extracting', percent: 90, message: 'Building hierarchy view...', detail: 'Loading folder structure' });
        setGraph(createKnowledgeGraph());
        setFileContents(new Map());
        setGraphViewMode('hierarchy');
        setExpandedGroups(new Map());
        setViewMode('exploring');
        if (getActiveProviderConfig()) initializeAgent(name, baseUrl);
      } else if (graphMode === 'summary') {
        setProgress({ phase: 'extracting', percent: 50, message: 'Loading graph summary...', detail: 'Fetching cluster overview' });
        const summary = await fetchGraphSummary(baseUrl, repoName || name);
        setProgress({ phase: 'extracting', percent: 90, message: 'Building visualization...', detail: `${summary.clusterGroups.length} cluster groups` });
        setGraph(createKnowledgeGraph());
        setFileContents(new Map());
        setGraphSummary(summary);
        setGraphViewMode('summary');
        setExpandedGroups(new Map());
        setViewMode('exploring');
        if (getActiveProviderConfig()) initializeAgent(name, baseUrl);
      } else {
        // Full-graph path
        const result = await connectToServer(serverUrl, (phase, downloaded, total) => {
          if (phase === 'validating') {
            setProgress({ phase: 'extracting', percent: 5, message: 'Connecting to server...', detail: 'Validating server' });
          } else if (phase === 'downloading') {
            const pct = total ? Math.round((downloaded / total) * 90) + 5 : 50;
            const mb = (downloaded / (1024 * 1024)).toFixed(1);
            setProgress({ phase: 'extracting', percent: pct, message: 'Downloading graph...', detail: `${mb} MB downloaded` });
          } else if (phase === 'extracting') {
            setProgress({ phase: 'extracting', percent: 97, message: 'Processing...', detail: 'Extracting file contents' });
          }
        }, undefined, repoName);

        handleServerConnect(result, baseUrl);
        setGraphViewMode('full');
      }

      // Fetch available repos for the repo switcher
      try {
        const repos = await fetchRepos(baseUrl);
        setAvailableRepos(repos);
      } catch (e) {
        console.warn('Failed to fetch repo list:', e);
      }
    } catch (err) {
      console.error('Smart connect failed:', err);
      setProgress({
        phase: 'error',
        percent: 0,
        message: 'Failed to connect to server',
        detail: err instanceof Error ? err.message : 'Unknown error',
      });
      setTimeout(() => {
        setViewMode('onboarding');
        setProgress(null);
      }, 3000);
    }
  }, [handleServerConnect, setProgress, setViewMode, setServerBaseUrl, setAvailableRepos, setProjectName, setGraph, setFileContents, setGraphSummary, setGraphViewMode, setExpandedGroups, initializeAgent]);

  // Auto-connect when ?server query param is present (bookmarkable shortcut)
  const autoConnectRan = useRef(false);
  useEffect(() => {
    if (autoConnectRan.current) return;
    const params = new URLSearchParams(window.location.search);
    if (!params.has('server')) return;
    autoConnectRan.current = true;

    // Clean the URL so a refresh won't re-trigger
    const cleanUrl = window.location.pathname + window.location.hash;
    window.history.replaceState(null, '', cleanUrl);

    const serverUrl = params.get('server') || window.location.origin;
    const repoParam = params.get('repo') || undefined;
    smartConnect(serverUrl, repoParam);
  }, [smartConnect]);

  const handleFocusNode = useCallback((nodeId: string) => {
    graphCanvasRef.current?.focusNode(nodeId);
  }, []);

  // Handle settings saved - refresh and reinitialize agent
  // NOTE: Must be defined BEFORE any conditional returns (React hooks rule)
  const handleSettingsSaved = useCallback(() => {
    refreshLLMSettings();
    if (graph) initializeAgent();
  }, [refreshLLMSettings, initializeAgent, graph]);

  // Render based on view mode
  if (viewMode === 'onboarding') {
    return (
      <DropZone
        onFileSelect={handleFileSelect}
        onGitClone={handleGitClone}
        onServerValidated={(serverUrl) => smartConnect(serverUrl)}
      />
    );
  }

  if (viewMode === 'loading' && progress) {
    return <LoadingOverlay progress={progress} />;
  }

  // Exploring view
  return (
    <div className="flex flex-col h-screen bg-void overflow-hidden">
      <Header onFocusNode={handleFocusNode} availableRepos={availableRepos} onSwitchRepo={switchRepo} />

      <main className="flex-1 flex min-h-0">
        {/* Left Panel - File Tree */}
        <FileTreePanel onFocusNode={handleFocusNode} />

        {/* Graph area - takes remaining space */}
        <div className="flex-1 relative min-w-0">
          <GraphCanvas ref={graphCanvasRef} />

          {/* Code References Panel (overlay) - does NOT resize the graph, it overlaps on top */}
          {isCodePanelOpen && (codeReferences.length > 0 || !!selectedNode) && (
            <div className="absolute inset-y-0 left-0 z-30 pointer-events-auto">
              <CodeReferencesPanel onFocusNode={handleFocusNode} />
            </div>
          )}
        </div>

        {/* Right Panel - Code & Chat (tabbed) */}
        {isRightPanelOpen && <RightPanel />}
      </main>

      {/* Data Explorer (bottom panel) */}
      {isDataExplorerOpen && <DataExplorer onFocusNode={handleFocusNode} />}

      <StatusBar />

      {/* Settings Panel (modal) */}
      <SettingsPanel
        isOpen={isSettingsPanelOpen}
        onClose={() => setSettingsPanelOpen(false)}
        onSettingsSaved={handleSettingsSaved}
        onReloadGraph={() => switchRepo(projectName)}
        currentRepo={projectName}
      />

    </div>
  );
};

function App() {
  return (
    <AppStateProvider>
      <AppContent />
    </AppStateProvider>
  );
}

export default App;

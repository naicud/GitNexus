import { useState, useCallback, useRef, useEffect } from 'react';
import * as Comlink from 'comlink';
import { PipelineProgress, PipelineResult, deserializePipelineResult } from '../types/pipeline';
import { createKnowledgeGraph } from '../core/graph/graph';
import type { IngestionWorkerApi } from '../workers/ingestion.worker';
import type { FileEntry } from '../services/zip';
import type { EmbeddingProgress, SemanticSearchResult } from '../core/embeddings/types';
import type { ProviderConfig } from '../core/llm/types';

export type EmbeddingStatus = 'idle' | 'loading' | 'embedding' | 'indexing' | 'ready' | 'error';

export interface WorkerState {
  // Progress
  progress: PipelineProgress | null;
  setProgress: (progress: PipelineProgress | null) => void;

  // Worker API
  apiRef: React.RefObject<Comlink.Remote<IngestionWorkerApi> | null>;
  runPipeline: (file: File, onProgress: (p: PipelineProgress) => void, clusteringConfig?: ProviderConfig) => Promise<PipelineResult>;
  runPipelineFromFiles: (files: FileEntry[], onProgress: (p: PipelineProgress) => void, clusteringConfig?: ProviderConfig) => Promise<PipelineResult>;
  runQuery: (cypher: string) => Promise<any[]>;
  isDatabaseReady: () => Promise<boolean>;
  hydrateWorkerFromServer: (nodes: any[], relationships: any[], fileContents: Record<string, string>) => Promise<void>;

  // Embedding state
  embeddingStatus: EmbeddingStatus;
  embeddingProgress: EmbeddingProgress | null;

  // Embedding methods
  startEmbeddings: (forceDevice?: 'webgpu' | 'wasm') => Promise<void>;
  semanticSearch: (query: string, k?: number) => Promise<SemanticSearchResult[]>;
  semanticSearchWithContext: (query: string, k?: number, hops?: number) => Promise<any[]>;
  isEmbeddingReady: boolean;

  // Debug/test methods
  testArrayParams: () => Promise<{ success: boolean; error?: string }>;
}

export function useWorkerState(): WorkerState {
  // Progress
  const [progress, setProgress] = useState<PipelineProgress | null>(null);

  // Embedding state
  const [embeddingStatus, setEmbeddingStatus] = useState<EmbeddingStatus>('idle');
  const [embeddingProgress, setEmbeddingProgress] = useState<EmbeddingProgress | null>(null);

  // Worker (single instance shared across app)
  const workerRef = useRef<Worker | null>(null);
  const apiRef = useRef<Comlink.Remote<IngestionWorkerApi> | null>(null);

  useEffect(() => {
    const worker = new Worker(
      new URL('../workers/ingestion.worker.ts', import.meta.url),
      { type: 'module' }
    );
    const api = Comlink.wrap<IngestionWorkerApi>(worker);
    workerRef.current = worker;
    apiRef.current = api;

    return () => {
      worker.terminate();
      workerRef.current = null;
      apiRef.current = null;
    };
  }, []);

  const runPipeline = useCallback(async (
    file: File,
    onProgress: (progress: PipelineProgress) => void,
    clusteringConfig?: ProviderConfig
  ): Promise<PipelineResult> => {
    const api = apiRef.current;
    if (!api) throw new Error('Worker not initialized');

    const proxiedOnProgress = Comlink.proxy(onProgress);
    const serializedResult = await api.runPipeline(file, proxiedOnProgress, clusteringConfig);
    return deserializePipelineResult(serializedResult, createKnowledgeGraph);
  }, []);

  const runPipelineFromFiles = useCallback(async (
    files: FileEntry[],
    onProgress: (progress: PipelineProgress) => void,
    clusteringConfig?: ProviderConfig
  ): Promise<PipelineResult> => {
    const api = apiRef.current;
    if (!api) throw new Error('Worker not initialized');

    const proxiedOnProgress = Comlink.proxy(onProgress);
    const serializedResult = await api.runPipelineFromFiles(files, proxiedOnProgress, clusteringConfig);
    return deserializePipelineResult(serializedResult, createKnowledgeGraph);
  }, []);

  const runQuery = useCallback(async (cypher: string): Promise<any[]> => {
    const api = apiRef.current;
    if (!api) throw new Error('Worker not initialized');
    return api.runQuery(cypher);
  }, []);

  const isDatabaseReady = useCallback(async (): Promise<boolean> => {
    const api = apiRef.current;
    if (!api) return false;
    try {
      return await api.isReady();
    } catch {
      return false;
    }
  }, []);

  const hydrateWorkerFromServer = useCallback(async (
    nodes: any[],
    relationships: any[],
    fileContents: Record<string, string>
  ): Promise<void> => {
    const api = apiRef.current;
    if (!api) throw new Error('Worker not initialized');
    await api.hydrateFromServerData(nodes, relationships, fileContents);
  }, []);

  // Embedding methods
  const startEmbeddings = useCallback(async (forceDevice?: 'webgpu' | 'wasm'): Promise<void> => {
    const api = apiRef.current;
    if (!api) throw new Error('Worker not initialized');

    setEmbeddingStatus('loading');
    setEmbeddingProgress(null);

    try {
      const proxiedOnProgress = Comlink.proxy((progress: EmbeddingProgress) => {
        setEmbeddingProgress(progress);

        switch (progress.phase) {
          case 'loading-model':
            setEmbeddingStatus('loading');
            break;
          case 'embedding':
            setEmbeddingStatus('embedding');
            break;
          case 'indexing':
            setEmbeddingStatus('indexing');
            break;
          case 'ready':
            setEmbeddingStatus('ready');
            break;
          case 'error':
            setEmbeddingStatus('error');
            break;
        }
      });

      await api.startEmbeddingPipeline(proxiedOnProgress, forceDevice);
    } catch (error: any) {
      if (error?.name === 'WebGPUNotAvailableError' ||
        error?.message?.includes('WebGPU not available')) {
        setEmbeddingStatus('idle');
      } else {
        setEmbeddingStatus('error');
      }
      throw error;
    }
  }, []);

  const semanticSearch = useCallback(async (
    query: string,
    k: number = 10
  ): Promise<SemanticSearchResult[]> => {
    const api = apiRef.current;
    if (!api) throw new Error('Worker not initialized');
    return api.semanticSearch(query, k);
  }, []);

  const semanticSearchWithContext = useCallback(async (
    query: string,
    k: number = 5,
    hops: number = 2
  ): Promise<any[]> => {
    const api = apiRef.current;
    if (!api) throw new Error('Worker not initialized');
    return api.semanticSearchWithContext(query, k, hops);
  }, []);

  const testArrayParams = useCallback(async (): Promise<{ success: boolean; error?: string }> => {
    const api = apiRef.current;
    if (!api) return { success: false, error: 'Worker not initialized' };
    return api.testArrayParams();
  }, []);

  return {
    progress,
    setProgress,
    apiRef,
    runPipeline,
    runPipelineFromFiles,
    runQuery,
    isDatabaseReady,
    hydrateWorkerFromServer,
    embeddingStatus,
    embeddingProgress,
    startEmbeddings,
    semanticSearch,
    semanticSearchWithContext,
    isEmbeddingReady: embeddingStatus === 'ready',
    testArrayParams,
  };
}

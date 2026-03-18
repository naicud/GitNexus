import { useState, useCallback, useRef } from 'react';
import * as Comlink from 'comlink';
import { KnowledgeGraph } from '../core/graph/types';
import type { LLMSettings, ProviderConfig, AgentStreamChunk, ChatMessage, ToolCallInfo, MessageStep } from '../core/llm/types';
import { loadSettings, getActiveProviderConfig, saveSettings } from '../core/llm/settings-service';
import type { AgentMessage } from '../core/llm/agent';
import { getBackendUrl } from '../services/backend';
import type { EmbeddingStatus } from './useWorkerState';
import type { CodeReference } from './useGraphState';
import type { IngestionWorkerApi } from '../workers/ingestion.worker';

export interface ChatStateDeps {
  graph: KnowledgeGraph | null;
  fileContentsRef: React.RefObject<Map<string, string>>;
  serverBaseUrl: string | null;
  projectName: string;
  embeddingStatus: EmbeddingStatus;
  apiRef: React.RefObject<Comlink.Remote<IngestionWorkerApi> | null>;
  // Filter state setters for AI highlight / blast radius parsing
  setAIToolHighlightedNodeIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  setBlastRadiusNodeIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  // Code reference methods
  addCodeReference: (ref: Omit<CodeReference, 'id'>) => void;
  clearAICodeReferences: () => void;
  clearAIToolHighlights: () => void;
  resolveFilePath: (requestedPath: string) => string | null;
  findFileNodeId: (filePath: string) => string | undefined;
}

export interface ChatState {
  // LLM/Agent state
  llmSettings: LLMSettings;
  updateLLMSettings: (updates: Partial<LLMSettings>) => void;
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
}

export function useChatState(deps: ChatStateDeps): ChatState {
  const {
    graph,
    fileContentsRef,
    serverBaseUrl,
    projectName,
    embeddingStatus,
    apiRef,
    setAIToolHighlightedNodeIds,
    setBlastRadiusNodeIds,
    addCodeReference,
    clearAICodeReferences,
    clearAIToolHighlights,
    resolveFilePath,
    findFileNodeId,
  } = deps;

  // LLM/Agent state
  const [llmSettings, setLLMSettings] = useState<LLMSettings>(loadSettings);
  const [isAgentReady, setIsAgentReady] = useState(false);
  const [isAgentInitializing, setIsAgentInitializing] = useState(false);
  const [agentError, setAgentError] = useState<string | null>(null);

  // Chat state
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [isChatLoading, setIsChatLoading] = useState(false);
  const [currentToolCalls, setCurrentToolCalls] = useState<ToolCallInfo[]>([]);

  // LLM methods
  const updateLLMSettings = useCallback((updates: Partial<LLMSettings>) => {
    setLLMSettings(prev => {
      const next = { ...prev, ...updates };
      saveSettings(next);
      return next;
    });
  }, []);

  const refreshLLMSettings = useCallback(() => {
    setLLMSettings(loadSettings());
  }, []);

  const initializeAgent = useCallback(async (
    overrideProjectName?: string,
    overrideBackendUrl?: string,
    overrideFileContents?: Map<string, string>,
  ): Promise<void> => {
    const api = apiRef.current;
    if (!api) {
      setAgentError('Worker not initialized');
      return;
    }

    const config = getActiveProviderConfig();
    if (!config) {
      setAgentError('Please configure an LLM provider in settings');
      return;
    }

    const effectiveBackendUrl = (overrideBackendUrl ?? serverBaseUrl ?? '').replace(/\/api$/, '') || undefined;

    setIsAgentInitializing(true);
    setAgentError(null);

    try {
      const effectiveProjectName = overrideProjectName || projectName || 'project';

      let result: { success: boolean; error?: string };

      if (effectiveBackendUrl) {
        const fileContentsEntries = Array.from(
          (overrideFileContents ?? fileContentsRef.current ?? new Map()).entries()
        );
        result = await api.initializeBackendAgent(
          config,
          effectiveBackendUrl,
          effectiveProjectName,
          fileContentsEntries,
          effectiveProjectName,
        );
      } else {
        result = await api.initializeAgent(config, effectiveProjectName);
      }

      if (result.success) {
        setIsAgentReady(true);
        setAgentError(null);
        if (import.meta.env.DEV) {
          console.log('Agent initialized successfully');
        }
      } else {
        setAgentError(result.error ?? 'Failed to initialize agent');
        setIsAgentReady(false);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setAgentError(message);
      setIsAgentReady(false);
    } finally {
      setIsAgentInitializing(false);
    }
  }, [projectName, serverBaseUrl, apiRef, fileContentsRef]);

  const sendChatMessage = useCallback(async (message: string): Promise<void> => {
    const api = apiRef.current;
    if (!api) {
      setAgentError('Worker not initialized');
      return;
    }

    clearAICodeReferences();
    clearAIToolHighlights();

    if (!isAgentReady) {
      await initializeAgent();
      if (!apiRef.current) return;
      const ready = await apiRef.current.isAgentReady();
      if (!ready) {
        setAgentError('Agent could not be initialized. Check your LLM settings.');
        setIsChatLoading(false);
        return;
      }
    }

    // Add user message
    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: message,
      timestamp: Date.now(),
    };
    setChatMessages(prev => [...prev, userMessage]);

    if (embeddingStatus === 'indexing') {
      const assistantMessage: ChatMessage = {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        content: 'Wait a moment, vector index is being created.',
        timestamp: Date.now(),
      };
      setChatMessages(prev => [...prev, assistantMessage]);
      setAgentError(null);
      setIsChatLoading(false);
      setCurrentToolCalls([]);
      return;
    }

    setIsChatLoading(true);
    setCurrentToolCalls([]);

    const history: AgentMessage[] = [...chatMessages, userMessage].map(m => ({
      role: m.role === 'tool' ? 'assistant' : m.role,
      content: m.content,
    }));

    const assistantMessageId = `assistant-${Date.now()}`;
    const stepsForMessage: MessageStep[] = [];
    const toolCallsForMessage: ToolCallInfo[] = [];
    let stepCounter = 0;

    const updateMessage = () => {
      const contentParts = stepsForMessage
        .filter(s => s.type === 'reasoning' || s.type === 'content')
        .map(s => s.content)
        .filter(Boolean);
      const content = contentParts.join('\n\n');

      setChatMessages(prev => {
        const existing = prev.find(m => m.id === assistantMessageId);
        const newMessage: ChatMessage = {
          id: assistantMessageId,
          role: 'assistant' as const,
          content,
          steps: [...stepsForMessage],
          toolCalls: [...toolCallsForMessage],
          timestamp: existing?.timestamp ?? Date.now(),
        };
        if (existing) {
          return prev.map(m => m.id === assistantMessageId ? newMessage : m);
        } else {
          return [...prev, newMessage];
        }
      });
    };

    try {
      const onChunk = Comlink.proxy((chunk: AgentStreamChunk) => {
        switch (chunk.type) {
          case 'reasoning':
            if (chunk.reasoning) {
              const lastStep = stepsForMessage[stepsForMessage.length - 1];
              if (lastStep && lastStep.type === 'reasoning') {
                stepsForMessage[stepsForMessage.length - 1] = {
                  ...lastStep,
                  content: (lastStep.content || '') + chunk.reasoning,
                };
              } else {
                stepsForMessage.push({
                  id: `step-${stepCounter++}`,
                  type: 'reasoning',
                  content: chunk.reasoning,
                });
              }
              updateMessage();
            }
            break;

          case 'content':
            if (chunk.content) {
              const lastStep = stepsForMessage[stepsForMessage.length - 1];
              if (lastStep && lastStep.type === 'content') {
                stepsForMessage[stepsForMessage.length - 1] = {
                  ...lastStep,
                  content: (lastStep.content || '') + chunk.content,
                };
              } else {
                stepsForMessage.push({
                  id: `step-${stepCounter++}`,
                  type: 'content',
                  content: chunk.content,
                });
              }
              updateMessage();

              // Parse inline grounding references
              const currentContentStep = stepsForMessage[stepsForMessage.length - 1];
              const fullText = (currentContentStep && currentContentStep.type === 'content')
                ? (currentContentStep.content || '')
                : '';

              // Pattern 1: File refs
              const fileRefRegex = /\[\[([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+)(?::(\d+)(?:[-\u2013](\d+))?)?\]\]/g;
              let fileMatch: RegExpExecArray | null;
              while ((fileMatch = fileRefRegex.exec(fullText)) !== null) {
                const rawPath = fileMatch[1].trim();
                const startLine1 = fileMatch[2] ? parseInt(fileMatch[2], 10) : undefined;
                const endLine1 = fileMatch[3] ? parseInt(fileMatch[3], 10) : startLine1;

                const resolvedPath = resolveFilePath(rawPath);
                if (!resolvedPath) continue;

                const startLine0 = startLine1 !== undefined ? Math.max(0, startLine1 - 1) : undefined;
                const endLine0 = endLine1 !== undefined ? Math.max(0, endLine1 - 1) : startLine0;
                const nodeId = findFileNodeId(resolvedPath);

                addCodeReference({
                  filePath: resolvedPath,
                  startLine: startLine0,
                  endLine: endLine0,
                  nodeId,
                  label: 'File',
                  name: resolvedPath.split('/').pop() ?? resolvedPath,
                  source: 'ai',
                });
              }

              // Pattern 2: Node refs
              const nodeRefRegex = /\[\[(?:graph:)?(Class|Function|Method|Interface|File|Folder|Variable|Enum|Type|CodeElement):([^\]]+)\]\]/g;
              let nodeMatch: RegExpExecArray | null;
              while ((nodeMatch = nodeRefRegex.exec(fullText)) !== null) {
                const nodeType = nodeMatch[1];
                const nodeName = nodeMatch[2].trim();

                if (!graph) continue;
                const node = graph.nodes.find(n =>
                  n.label === nodeType &&
                  n.properties.name === nodeName
                );
                if (!node || !node.properties.filePath) continue;

                const resolvedPath = resolveFilePath(node.properties.filePath);
                if (!resolvedPath) continue;

                addCodeReference({
                  filePath: resolvedPath,
                  startLine: node.properties.startLine ? node.properties.startLine - 1 : undefined,
                  endLine: node.properties.endLine ? node.properties.endLine - 1 : undefined,
                  nodeId: node.id,
                  label: node.label,
                  name: node.properties.name,
                  source: 'ai',
                });
              }
            }
            break;

          case 'tool_call':
            if (chunk.toolCall) {
              const tc = chunk.toolCall;
              toolCallsForMessage.push(tc);
              stepsForMessage.push({
                id: `step-${stepCounter++}`,
                type: 'tool_call',
                toolCall: tc,
              });
              setCurrentToolCalls(prev => [...prev, tc]);
              updateMessage();
            }
            break;

          case 'tool_result':
            if (chunk.toolCall) {
              const tc = chunk.toolCall;
              let idx = toolCallsForMessage.findIndex(t => t.id === tc.id);
              if (idx < 0) {
                idx = toolCallsForMessage.findIndex(t => t.name === tc.name && t.status === 'running');
              }
              if (idx < 0) {
                idx = toolCallsForMessage.findIndex(t => t.name === tc.name && !t.result);
              }
              if (idx >= 0) {
                toolCallsForMessage[idx] = {
                  ...toolCallsForMessage[idx],
                  result: tc.result,
                  status: 'completed'
                };
              }

              const stepIdx = stepsForMessage.findIndex(s =>
                s.type === 'tool_call' && s.toolCall && (
                  s.toolCall.id === tc.id ||
                  (s.toolCall.name === tc.name && s.toolCall.status === 'running')
                )
              );
              if (stepIdx >= 0 && stepsForMessage[stepIdx].toolCall) {
                stepsForMessage[stepIdx] = {
                  ...stepsForMessage[stepIdx],
                  toolCall: {
                    ...stepsForMessage[stepIdx].toolCall!,
                    result: tc.result,
                    status: 'completed',
                  },
                };
              }

              setCurrentToolCalls(prev => {
                let targetIdx = prev.findIndex(t => t.id === tc.id);
                if (targetIdx < 0) {
                  targetIdx = prev.findIndex(t => t.name === tc.name && t.status === 'running');
                }
                if (targetIdx < 0) {
                  targetIdx = prev.findIndex(t => t.name === tc.name && !t.result);
                }
                if (targetIdx >= 0) {
                  return prev.map((t, i) => i === targetIdx
                    ? { ...t, result: tc.result, status: 'completed' }
                    : t
                  );
                }
                return prev;
              });

              updateMessage();

              // Parse highlight marker from tool results
              if (tc.result) {
                const highlightMatch = tc.result.match(/\[HIGHLIGHT_NODES:([^\]]+)\]/);
                if (highlightMatch) {
                  const rawIds = highlightMatch[1].split(',').map((id: string) => id.trim()).filter(Boolean);
                  if (rawIds.length > 0 && graph) {
                    const matchedIds = new Set<string>();
                    const graphNodeIds = graph.nodes.map(n => n.id);

                    for (const rawId of rawIds) {
                      if (graphNodeIds.includes(rawId)) {
                        matchedIds.add(rawId);
                      } else {
                        const found = graphNodeIds.find(gid =>
                          gid.endsWith(rawId) || gid.endsWith(':' + rawId)
                        );
                        if (found) {
                          matchedIds.add(found);
                        }
                      }
                    }

                    if (matchedIds.size > 0) {
                      setAIToolHighlightedNodeIds(matchedIds);
                    }
                  } else if (rawIds.length > 0) {
                    setAIToolHighlightedNodeIds(new Set(rawIds));
                  }
                }

                // Parse impact marker from tool results
                const impactMatch = tc.result.match(/\[IMPACT:([^\]]+)\]/);
                if (impactMatch) {
                  const rawIds = impactMatch[1].split(',').map((id: string) => id.trim()).filter(Boolean);
                  if (rawIds.length > 0 && graph) {
                    const matchedIds = new Set<string>();
                    const graphNodeIds = graph.nodes.map(n => n.id);

                    for (const rawId of rawIds) {
                      if (graphNodeIds.includes(rawId)) {
                        matchedIds.add(rawId);
                      } else {
                        const found = graphNodeIds.find(gid =>
                          gid.endsWith(rawId) || gid.endsWith(':' + rawId)
                        );
                        if (found) {
                          matchedIds.add(found);
                        }
                      }
                    }

                    if (matchedIds.size > 0) {
                      setBlastRadiusNodeIds(matchedIds);
                    }
                  } else if (rawIds.length > 0) {
                    setBlastRadiusNodeIds(new Set(rawIds));
                  }
                }
              }
            }
            break;

          case 'error':
            setAgentError(chunk.error ?? 'Unknown error');
            break;

          case 'done':
            updateMessage();
            break;
        }
      });

      await api.chatStream(history, onChunk);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setAgentError(message);
    } finally {
      setIsChatLoading(false);
      setCurrentToolCalls([]);
    }
  }, [chatMessages, isAgentReady, initializeAgent, resolveFilePath, findFileNodeId, addCodeReference, clearAICodeReferences, clearAIToolHighlights, graph, embeddingStatus, apiRef, setAIToolHighlightedNodeIds, setBlastRadiusNodeIds]);

  const stopChatResponse = useCallback(() => {
    const api = apiRef.current;
    if (api && isChatLoading) {
      api.stopChat();
      setIsChatLoading(false);
      setCurrentToolCalls([]);
    }
  }, [isChatLoading, apiRef]);

  const clearChat = useCallback(() => {
    setChatMessages([]);
    setCurrentToolCalls([]);
    setAgentError(null);
  }, []);

  const generateCypherQuery = useCallback(async (question: string): Promise<{ query: string; explanation: string } | { error: string }> => {
    const api = apiRef.current;
    if (!api) return { error: 'Worker not initialized' };
    return api.generateCypherQuery(question);
  }, [apiRef]);

  return {
    llmSettings,
    updateLLMSettings,
    isAgentReady,
    isAgentInitializing,
    agentError,
    chatMessages,
    isChatLoading,
    currentToolCalls,
    refreshLLMSettings,
    initializeAgent,
    sendChatMessage,
    stopChatResponse,
    clearChat,
    generateCypherQuery,
  };
}

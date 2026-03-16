import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { X, Key, Server, Brain, Check, AlertCircle, Eye, EyeOff, RefreshCw, ChevronDown, Loader2, Search } from 'lucide-react';
import {
  loadSettings,
  saveSettings,
  getProviderDisplayName,
  fetchOpenRouterModels,
} from '../core/llm/settings-service';
import type { LLMSettings, LLMProvider } from '../core/llm/types';
import { testBedrockConnection, testDbConnection, updateRepoDbConfig, getBackendUrl } from '../services/backend';
import { CypherConsole } from './CypherConsole';

interface SettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
  onSettingsSaved?: () => void;
  backendUrl?: string;
  isBackendConnected?: boolean;
  onBackendUrlChange?: (url: string) => void;
  onReloadGraph?: () => void;
  currentRepo?: string;
}

/**
 * Searchable combobox for OpenRouter model selection
 */
interface OpenRouterModelComboboxProps {
  value: string;
  onChange: (model: string) => void;
  models: Array<{ id: string; name: string }>;
  isLoading: boolean;
  onLoadModels: () => void;
}

const OpenRouterModelCombobox = ({ value, onChange, models, isLoading, onLoadModels }: OpenRouterModelComboboxProps) => {
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Filter models based on search term
  const filteredModels = useMemo(() => {
    if (!searchTerm.trim()) return models;
    const lower = searchTerm.toLowerCase();
    return models.filter(m =>
      m.id.toLowerCase().includes(lower) ||
      m.name.toLowerCase().includes(lower)
    );
  }, [models, searchTerm]);

  // Find display name for current value
  const displayValue = useMemo(() => {
    if (!value) return '';
    const found = models.find(m => m.id === value);
    return found ? found.name : value;
  }, [value, models]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setSearchTerm('');
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Load models when opening
  const handleOpen = () => {
    setIsOpen(true);
    if (models.length === 0 && !isLoading) {
      onLoadModels();
    }
    setTimeout(() => inputRef.current?.focus(), 10);
  };

  const handleSelect = (modelId: string) => {
    onChange(modelId);
    setIsOpen(false);
    setSearchTerm('');
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setSearchTerm(val);
    // Also allow direct typing of model ID
    if (val && models.length === 0) {
      onChange(val);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && searchTerm) {
      // If exact match in filtered, select it; otherwise use raw input
      const exact = filteredModels.find(m => m.id.toLowerCase() === searchTerm.toLowerCase());
      if (exact) {
        handleSelect(exact.id);
      } else if (filteredModels.length === 1) {
        handleSelect(filteredModels[0].id);
      } else {
        // Allow custom model ID input
        onChange(searchTerm);
        setIsOpen(false);
        setSearchTerm('');
      }
    } else if (e.key === 'Escape') {
      setIsOpen(false);
      setSearchTerm('');
    }
  };

  return (
    <div ref={containerRef} className="relative">
      {/* Main input/button */}
      <div
        onClick={handleOpen}
        className={`w-full px-4 py-3 bg-elevated border rounded-xl cursor-pointer transition-all flex items-center gap-2
          ${isOpen ? 'border-accent ring-2 ring-accent/20' : 'border-border-subtle hover:border-accent/50'}`}
      >
        {isOpen ? (
          <input
            ref={inputRef}
            type="text"
            value={searchTerm}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder="Search or type model ID..."
            className="flex-1 bg-transparent text-text-primary placeholder:text-text-muted outline-none font-mono text-sm"
            onClick={e => e.stopPropagation()}
          />
        ) : (
          <span className={`flex-1 font-mono text-sm truncate ${value ? 'text-text-primary' : 'text-text-muted'}`}>
            {displayValue || 'Select or type a model...'}
          </span>
        )}
        <div className="flex items-center gap-1">
          {isLoading && <Loader2 className="w-4 h-4 animate-spin text-text-muted" />}
          <ChevronDown className={`w-4 h-4 text-text-muted transition-transform ${isOpen ? 'rotate-180' : ''}`} />
        </div>
      </div>

      {/* Dropdown */}
      {isOpen && (
        <div className="absolute z-50 w-full mt-1 bg-elevated border border-border-subtle rounded-xl shadow-xl overflow-hidden">
          {isLoading ? (
            <div className="px-4 py-6 text-center text-text-muted text-sm flex items-center justify-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              Loading models...
            </div>
          ) : filteredModels.length === 0 ? (
            <div className="px-4 py-4 text-center">
              {models.length === 0 ? (
                <div className="text-text-muted text-sm">
                  <Search className="w-5 h-5 mx-auto mb-2 opacity-50" />
                  <p>Type a model ID or press Enter</p>
                  <p className="text-xs mt-1">e.g. openai/gpt-4o</p>
                </div>
              ) : (
                <div className="text-text-muted text-sm">
                  <p>No models match "{searchTerm}"</p>
                  <p className="text-xs mt-1">Press Enter to use as custom ID</p>
                </div>
              )}
            </div>
          ) : (
            <div className="max-h-64 overflow-y-auto">
              {filteredModels.slice(0, 50).map(model => (
                <button
                  key={model.id}
                  onClick={() => handleSelect(model.id)}
                  className={`w-full px-4 py-2.5 text-left hover:bg-hover transition-colors flex flex-col
                    ${model.id === value ? 'bg-accent/10' : ''}`}
                >
                  <span className="text-text-primary text-sm truncate">{model.name}</span>
                  <span className="text-text-muted text-xs font-mono truncate">{model.id}</span>
                </button>
              ))}
              {filteredModels.length > 50 && (
                <div className="px-4 py-2 text-xs text-text-muted text-center border-t border-border-subtle">
                  +{filteredModels.length - 50} more • Refine your search
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

/**
 * Check connection to local Ollama instance
 */
const checkOllamaStatus = async (baseUrl: string): Promise<{ ok: boolean; error: string | null }> => {
  try {
    const response = await fetch(`${baseUrl}/api/tags`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      if (response.status === 0 || response.status === 404) {
        return { ok: false, error: 'Cannot connect to Ollama. Make sure it\'s running with `ollama serve`' };
      }
      return { ok: false, error: `Ollama API error: ${response.status}` };
    }

    return { ok: true, error: null };
  } catch (error) {
    return {
      ok: false,
      error: 'Cannot connect to Ollama. Make sure it\'s running with `ollama serve`'
    };
  }
};

export const SettingsPanel = ({ isOpen, onClose, onSettingsSaved, backendUrl, isBackendConnected, onBackendUrlChange, onReloadGraph, currentRepo }: SettingsPanelProps) => {
  const [settings, setSettings] = useState<LLMSettings>(loadSettings);
  const [showApiKey, setShowApiKey] = useState<Record<string, boolean>>({});
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle');
  // Ollama connection state
  const [ollamaError, setOllamaError] = useState<string | null>(null);
  const [isCheckingOllama, setIsCheckingOllama] = useState(false);
  // OpenRouter models state
  const [openRouterModels, setOpenRouterModels] = useState<Array<{ id: string; name: string }>>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  // Bedrock connection test state
  const [bedrockTestStatus, setBedrockTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [bedrockTestMessage, setBedrockTestMessage] = useState('');
  // Database settings state
  const [dbType, setDbType] = useState<'kuzu' | 'neptune'>('kuzu');
  const [neptuneEndpoint, setNeptuneEndpoint] = useState('');
  const [neptuneRegion, setNeptuneRegion] = useState('');
  const [neptunePort, setNeptunePort] = useState('8182');
  const [dbTestStatus, setDbTestStatus] = useState<'idle' | 'testing' | 'ok' | 'error'>('idle');
  const [dbTestMessage, setDbTestMessage] = useState('');
  const [showCypherConsole, setShowCypherConsole] = useState(false);
  // DB change tracking
  const [dbChanged, setDbChanged] = useState(false);
  const [dbSaving, setDbSaving] = useState(false);
  const originalDbType = useRef<'kuzu' | 'neptune'>('kuzu');

  // Load settings when panel opens
  useEffect(() => {
    if (isOpen) {
      const s = loadSettings();
      setSettings(s);
      setSaveStatus('idle');
      setOllamaError(null);
      // Sync database state from persisted settings
      const loadedDbType = s.database?.type ?? 'kuzu';
      setDbType(loadedDbType);
      originalDbType.current = loadedDbType;
      setNeptuneEndpoint(s.database?.neptuneEndpoint ?? '');
      setNeptuneRegion(s.database?.neptuneRegion ?? '');
      setNeptunePort(String(s.database?.neptunePort ?? '8182'));
      setDbTestStatus('idle');
      setDbTestMessage('');
    }
  }, [isOpen]);

  // Check Ollama connection when provider is selected or base URL changes
  const checkOllamaConnection = useCallback(async (baseUrl: string) => {
    setIsCheckingOllama(true);
    setOllamaError(null);

    const { error } = await checkOllamaStatus(baseUrl);
    setIsCheckingOllama(false);
    setOllamaError(error);
  }, []);

  // Load OpenRouter models
  const loadOpenRouterModels = useCallback(async () => {
    setIsLoadingModels(true);
    const models = await fetchOpenRouterModels();
    setOpenRouterModels(models);
    setIsLoadingModels(false);
  }, []);

  useEffect(() => {
    if (settings.activeProvider === 'ollama') {
      const baseUrl = settings.ollama?.baseUrl ?? 'http://localhost:11434';
      const timer = setTimeout(() => {
        checkOllamaConnection(baseUrl);
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [settings.ollama?.baseUrl, settings.activeProvider, checkOllamaConnection]);

  const handleProviderChange = (provider: LLMProvider) => {
    setSettings(prev => ({ ...prev, activeProvider: provider }));
  };

  const handleSave = async () => {
    try {
      saveSettings({
        ...settings,
        database: {
          type: dbType,
          ...(dbType === 'neptune' ? {
            neptuneEndpoint,
            neptuneRegion,
            neptunePort: parseInt(neptunePort) || 8182,
          } : {}),
        },
      });

      // Persist DB config to the server
      if (currentRepo) {
        setDbSaving(true);
        try {
          const dbPayload = dbType === 'neptune'
            ? { type: 'neptune' as const, endpoint: neptuneEndpoint, region: neptuneRegion, port: parseInt(neptunePort) || 8182 }
            : { type: 'kuzu' as const };
          const result = await updateRepoDbConfig(currentRepo, dbPayload);
          if (!result.ok) {
            console.warn('Failed to persist DB config to server:', result.error);
          }
        } catch (err) {
          console.warn('Failed to persist DB config to server:', err);
        } finally {
          setDbSaving(false);
        }
      }

      // Track if the DB type changed so we can show the reload banner
      if (dbType !== originalDbType.current) {
        setDbChanged(true);
        originalDbType.current = dbType;
      }

      setSaveStatus('saved');
      onSettingsSaved?.();
      setTimeout(() => setSaveStatus('idle'), 2000);
    } catch {
      setSaveStatus('error');
    }
  };

  const handleTestNeptune = async () => {
    if (!neptuneEndpoint || !neptuneRegion) {
      setDbTestStatus('error');
      setDbTestMessage('Endpoint and region are required');
      return;
    }
    setDbTestStatus('testing');
    setDbTestMessage('');
    try {
      const result = await testDbConnection({
        neptuneEndpoint,
        neptuneRegion,
        neptunePort: parseInt(neptunePort) || 8182,
      });
      if (result.ok) {
        setDbTestStatus('ok');
        setDbTestMessage(`Connected (${result.latencyMs}ms)`);
      } else {
        setDbTestStatus('error');
        setDbTestMessage(result.error || 'Connection failed');
      }
    } catch {
      setDbTestStatus('error');
      setDbTestMessage('Connection failed');
    }
  };

  const toggleApiKeyVisibility = (key: string) => {
    setShowApiKey(prev => ({ ...prev, [key]: !prev[key] }));
  };

  if (!isOpen) return null;

  const providers: LLMProvider[] = ['openai', 'gemini', 'anthropic', 'azure-openai', 'ollama', 'openrouter', 'custom', 'bedrock'];


  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="relative bg-surface border border-border-subtle rounded-2xl shadow-2xl max-w-lg w-full mx-4 overflow-hidden max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border-subtle bg-elevated/50">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 flex items-center justify-center bg-accent/20 rounded-xl">
              <Brain className="w-5 h-5 text-accent" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-text-primary">AI Settings</h2>
              <p className="text-xs text-text-muted">Configure your LLM provider</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-text-muted hover:text-text-primary hover:bg-hover rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Local Server */}
          {backendUrl !== undefined && onBackendUrlChange && (
            <div className="space-y-3">
              <label className="block text-sm font-medium text-text-secondary">
                Local Server
              </label>
              <div className="space-y-2">
                <div className="flex items-center gap-2 mb-2">
                  <Server className="w-4 h-4 text-text-muted" />
                  <span className="text-sm text-text-secondary">Backend URL</span>
                  <span className={`w-2 h-2 rounded-full ${isBackendConnected ? 'bg-green-400' : 'bg-red-400'}`} />
                  <span className="text-xs text-text-muted">
                    {isBackendConnected ? 'Connected' : 'Not connected'}
                  </span>
                </div>
                <input
                  type="url"
                  value={backendUrl}
                  onChange={(e) => onBackendUrlChange(e.target.value)}
                  placeholder="http://localhost:4747"
                  className="w-full px-4 py-3 bg-elevated border border-border-subtle rounded-xl text-text-primary placeholder:text-text-muted focus:border-accent focus:ring-2 focus:ring-accent/20 outline-none transition-all font-mono text-sm"
                />
                <p className="text-xs text-text-muted">
                  Run <code className="px-1 py-0.5 bg-elevated rounded">gitnexus serve</code> to start the local server
                </p>
              </div>
            </div>
          )}

          {/* Provider Selection */}
          <div className="space-y-3">
            <label className="block text-sm font-medium text-text-secondary">
              Provider
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {providers.map(provider => (
                <button
                  key={provider}
                  onClick={() => handleProviderChange(provider)}
                  className={`
                    flex items-center gap-3 p-4 rounded-xl border-2 transition-all
                    ${settings.activeProvider === provider
                      ? 'border-accent bg-accent/10 text-text-primary'
                      : 'border-border-subtle bg-elevated hover:border-accent/50 text-text-secondary'
                    }
                  `}
                >
                  <div className={`
                    w-8 h-8 rounded-lg flex items-center justify-center text-lg
                    ${settings.activeProvider === provider ? 'bg-accent/20' : 'bg-surface'}
                  `}>
                    {provider === 'openai' ? '🤖' : provider === 'gemini' ? '💎' : provider === 'anthropic' ? '🧠' : provider === 'ollama' ? '🦙' : provider === 'openrouter' ? '🌐' : provider === 'custom' ? '⚙️' : provider === 'bedrock' ? '🔶' : '☁️'}
                  </div>
                  <span className="font-medium">{getProviderDisplayName(provider)}</span>
                </button>
              ))}
            </div>
          </div>

          {/* OpenAI Settings */}
          {settings.activeProvider === 'openai' && (
            <div className="space-y-4 animate-fade-in">
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-sm font-medium text-text-secondary">
                  <Key className="w-4 h-4" />
                  API Key
                </label>
                <div className="relative">
                  <input
                    type={showApiKey['openai'] ? 'text' : 'password'}
                    value={settings.openai?.apiKey ?? ''}
                    onChange={e => setSettings(prev => ({
                      ...prev,
                      openai: { ...prev.openai!, apiKey: e.target.value }
                    }))}
                    placeholder="Enter your OpenAI API key"
                    className="w-full px-4 py-3 pr-12 bg-elevated border border-border-subtle rounded-xl text-text-primary placeholder:text-text-muted focus:border-accent focus:ring-2 focus:ring-accent/20 outline-none transition-all"
                  />
                  <button
                    type="button"
                    onClick={() => toggleApiKeyVisibility('openai')}
                    className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-text-muted hover:text-text-primary transition-colors"
                  >
                    {showApiKey['openai'] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                <p className="text-xs text-text-muted">
                  Get your API key from{' '}
                  <a
                    href="https://platform.openai.com/api-keys"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent hover:underline"
                  >
                    OpenAI Platform
                  </a>
                </p>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-text-secondary">Model</label>
                <input
                  type="text"
                  value={settings.openai?.model ?? 'gpt-5.2-chat'}
                  onChange={e => setSettings(prev => ({
                    ...prev,
                    openai: { ...prev.openai!, model: e.target.value }
                  }))}
                  placeholder="e.g., gpt-4o, gpt-4-turbo, gpt-3.5-turbo"
                  className="w-full px-4 py-3 bg-elevated border border-border-subtle rounded-xl text-text-primary placeholder:text-text-muted focus:border-accent focus:ring-2 focus:ring-accent/20 outline-none transition-all font-mono text-sm"
                />
              </div>

              <div className="space-y-2">
                <label className="flex items-center gap-2 text-sm font-medium text-text-secondary">
                  <Server className="w-4 h-4" />
                  Base URL <span className="text-text-muted font-normal">(optional)</span>
                </label>
                <input
                  type="url"
                  value={settings.openai?.baseUrl ?? ''}
                  onChange={e => setSettings(prev => ({
                    ...prev,
                    openai: { ...prev.openai!, baseUrl: e.target.value }
                  }))}
                  placeholder="https://api.openai.com/v1 (default)"
                  className="w-full px-4 py-3 bg-elevated border border-border-subtle rounded-xl text-text-primary placeholder:text-text-muted focus:border-accent focus:ring-2 focus:ring-accent/20 outline-none transition-all"
                />
                <p className="text-xs text-text-muted">
                  Leave empty to use the default OpenAI API. Set a custom URL for proxies or compatible APIs.
                </p>
              </div>
            </div>
          )}

          {/* Gemini Settings */}
          {settings.activeProvider === 'gemini' && (
            <div className="space-y-4 animate-fade-in">
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-sm font-medium text-text-secondary">
                  <Key className="w-4 h-4" />
                  API Key
                </label>
                <div className="relative">
                  <input
                    type={showApiKey['gemini'] ? 'text' : 'password'}
                    value={settings.gemini?.apiKey ?? ''}
                    onChange={e => setSettings(prev => ({
                      ...prev,
                      gemini: { ...prev.gemini!, apiKey: e.target.value }
                    }))}
                    placeholder="Enter your Google AI API key"
                    className="w-full px-4 py-3 pr-12 bg-elevated border border-border-subtle rounded-xl text-text-primary placeholder:text-text-muted focus:border-accent focus:ring-2 focus:ring-accent/20 outline-none transition-all"
                  />
                  <button
                    type="button"
                    onClick={() => toggleApiKeyVisibility('gemini')}
                    className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-text-muted hover:text-text-primary transition-colors"
                  >
                    {showApiKey['gemini'] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                <p className="text-xs text-text-muted">
                  Get your API key from{' '}
                  <a
                    href="https://aistudio.google.com/app/apikey"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent hover:underline"
                  >
                    Google AI Studio
                  </a>
                </p>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-text-secondary">Model</label>
                <input
                  type="text"
                  value={settings.gemini?.model ?? 'gemini-2.0-flash'}
                  onChange={e => setSettings(prev => ({
                    ...prev,
                    gemini: { ...prev.gemini!, model: e.target.value }
                  }))}
                  placeholder="e.g., gemini-2.0-flash, gemini-1.5-pro"
                  className="w-full px-4 py-3 bg-elevated border border-border-subtle rounded-xl text-text-primary placeholder:text-text-muted focus:border-accent focus:ring-2 focus:ring-accent/20 outline-none transition-all font-mono text-sm"
                />
              </div>
            </div>
          )}

          {/* Anthropic Settings */}
          {settings.activeProvider === 'anthropic' && (
            <div className="space-y-4 animate-fade-in">
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-sm font-medium text-text-secondary">
                  <Key className="w-4 h-4" />
                  API Key
                </label>
                <div className="relative">
                  <input
                    type={showApiKey['anthropic'] ? 'text' : 'password'}
                    value={settings.anthropic?.apiKey ?? ''}
                    onChange={e => setSettings(prev => ({
                      ...prev,
                      anthropic: { ...prev.anthropic!, apiKey: e.target.value }
                    }))}
                    placeholder="Enter your Anthropic API key"
                    className="w-full px-4 py-3 pr-12 bg-elevated border border-border-subtle rounded-xl text-text-primary placeholder:text-text-muted focus:border-accent focus:ring-2 focus:ring-accent/20 outline-none transition-all"
                  />
                  <button
                    type="button"
                    onClick={() => toggleApiKeyVisibility('anthropic')}
                    className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-text-muted hover:text-text-primary transition-colors"
                  >
                    {showApiKey['anthropic'] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                <p className="text-xs text-text-muted">
                  Get your API key from{' '}
                  <a
                    href="https://console.anthropic.com/settings/keys"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent hover:underline"
                  >
                    Anthropic Console
                  </a>
                </p>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-text-secondary">Model</label>
                <input
                  type="text"
                  value={settings.anthropic?.model ?? 'claude-sonnet-4-20250514'}
                  onChange={e => setSettings(prev => ({
                    ...prev,
                    anthropic: { ...prev.anthropic!, model: e.target.value }
                  }))}
                  placeholder="e.g., claude-sonnet-4-20250514, claude-3-opus"
                  className="w-full px-4 py-3 bg-elevated border border-border-subtle rounded-xl text-text-primary placeholder:text-text-muted focus:border-accent focus:ring-2 focus:ring-accent/20 outline-none transition-all font-mono text-sm"
                />
              </div>
            </div>
          )}

          {/* Azure OpenAI Settings */}
          {settings.activeProvider === 'azure-openai' && (
            <div className="space-y-4 animate-fade-in">
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-sm font-medium text-text-secondary">
                  <Key className="w-4 h-4" />
                  API Key
                </label>
                <div className="relative">
                  <input
                    type={showApiKey['azure'] ? 'text' : 'password'}
                    value={settings.azureOpenAI?.apiKey ?? ''}
                    onChange={e => setSettings(prev => ({
                      ...prev,
                      azureOpenAI: { ...prev.azureOpenAI!, apiKey: e.target.value }
                    }))}
                    placeholder="Enter your Azure OpenAI API key"
                    className="w-full px-4 py-3 pr-12 bg-elevated border border-border-subtle rounded-xl text-text-primary placeholder:text-text-muted focus:border-accent focus:ring-2 focus:ring-accent/20 outline-none transition-all"
                  />
                  <button
                    type="button"
                    onClick={() => toggleApiKeyVisibility('azure')}
                    className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-text-muted hover:text-text-primary transition-colors"
                  >
                    {showApiKey['azure'] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <div className="space-y-2">
                <label className="flex items-center gap-2 text-sm font-medium text-text-secondary">
                  <Server className="w-4 h-4" />
                  Endpoint
                </label>
                <input
                  type="url"
                  value={settings.azureOpenAI?.endpoint ?? ''}
                  onChange={e => setSettings(prev => ({
                    ...prev,
                    azureOpenAI: { ...prev.azureOpenAI!, endpoint: e.target.value }
                  }))}
                  placeholder="https://your-resource.openai.azure.com"
                  className="w-full px-4 py-3 bg-elevated border border-border-subtle rounded-xl text-text-primary placeholder:text-text-muted focus:border-accent focus:ring-2 focus:ring-accent/20 outline-none transition-all"
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-text-secondary">Deployment Name</label>
                <input
                  type="text"
                  value={settings.azureOpenAI?.deploymentName ?? ''}
                  onChange={e => setSettings(prev => ({
                    ...prev,
                    azureOpenAI: { ...prev.azureOpenAI!, deploymentName: e.target.value }
                  }))}
                  placeholder="e.g., gpt-4o-deployment"
                  className="w-full px-4 py-3 bg-elevated border border-border-subtle rounded-xl text-text-primary placeholder:text-text-muted focus:border-accent focus:ring-2 focus:ring-accent/20 outline-none transition-all"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium text-text-secondary">Model</label>
                  <input
                    type="text"
                    value={settings.azureOpenAI?.model ?? 'gpt-4o'}
                    onChange={e => setSettings(prev => ({
                      ...prev,
                      azureOpenAI: { ...prev.azureOpenAI!, model: e.target.value }
                    }))}
                    placeholder="gpt-4o"
                    className="w-full px-4 py-3 bg-elevated border border-border-subtle rounded-xl text-text-primary placeholder:text-text-muted focus:border-accent focus:ring-2 focus:ring-accent/20 outline-none transition-all"
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium text-text-secondary">API Version</label>
                  <input
                    type="text"
                    value={settings.azureOpenAI?.apiVersion ?? '2024-08-01-preview'}
                    onChange={e => setSettings(prev => ({
                      ...prev,
                      azureOpenAI: { ...prev.azureOpenAI!, apiVersion: e.target.value }
                    }))}
                    placeholder="2024-08-01-preview"
                    className="w-full px-4 py-3 bg-elevated border border-border-subtle rounded-xl text-text-primary placeholder:text-text-muted focus:border-accent focus:ring-2 focus:ring-accent/20 outline-none transition-all"
                  />
                </div>
              </div>

              <p className="text-xs text-text-muted">
                Configure your Azure OpenAI service in the{' '}
                <a
                  href="https://portal.azure.com/#view/Microsoft_Azure_ProjectOxford/CognitiveServicesHub/~/OpenAI"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent hover:underline"
                >
                  Azure Portal
                </a>
              </p>
            </div>
          )}

          {/* Ollama Settings */}
          {settings.activeProvider === 'ollama' && (
            <div className="space-y-4 animate-fade-in">
              {/* How to run Ollama */}
              <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-xl">
                <p className="text-xs text-amber-300 leading-relaxed">
                  <span className="font-medium">📋 Quick Start:</span> Install Ollama from{' '}
                  <a
                    href="https://ollama.ai"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent hover:underline"
                  >
                    ollama.ai
                  </a>, then run:
                </p>
                <code className="block mt-2 px-3 py-2 bg-black/30 rounded-lg text-amber-200 font-mono text-sm">
                  ollama serve
                </code>
              </div>

              <div className="space-y-2">
                <label className="flex items-center gap-2 text-sm font-medium text-text-secondary">
                  <Server className="w-4 h-4" />
                  Base URL
                </label>
                <div className="flex gap-2">
                  <input
                    type="url"
                    value={settings.ollama?.baseUrl ?? 'http://localhost:11434'}
                    onChange={e => setSettings(prev => ({
                      ...prev,
                      ollama: { ...prev.ollama!, baseUrl: e.target.value }
                    }))}
                    placeholder="http://localhost:11434"
                    className="flex-1 px-4 py-3 bg-elevated border border-border-subtle rounded-xl text-text-primary placeholder:text-text-muted focus:border-accent focus:ring-2 focus:ring-accent/20 outline-none transition-all font-mono text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => checkOllamaConnection(settings.ollama?.baseUrl ?? 'http://localhost:11434')}
                    disabled={isCheckingOllama}
                    className="px-3 py-3 bg-elevated border border-border-subtle rounded-xl text-text-secondary hover:text-text-primary hover:border-accent/50 transition-colors disabled:opacity-50"
                    title="Check connection"
                  >
                    <RefreshCw className={`w-4 h-4 ${isCheckingOllama ? 'animate-spin' : ''}`} />
                  </button>
                </div>
                <p className="text-xs text-text-muted">
                  Default port is <code className="px-1 py-0.5 bg-elevated rounded">11434</code>.
                </p>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-text-secondary">Model</label>

                {ollamaError && !isCheckingOllama && (
                  <div className="p-2 bg-red-500/10 border border-red-500/30 rounded-lg">
                    <p className="text-xs text-red-400 flex items-center gap-1">
                      <AlertCircle className="w-3 h-3" />
                      {ollamaError}
                    </p>
                  </div>
                )}

                <input
                  type="text"
                  value={settings.ollama?.model ?? ''}
                  onChange={e => setSettings(prev => ({
                    ...prev,
                    ollama: { ...prev.ollama!, model: e.target.value }
                  }))}
                  placeholder="e.g., llama3.2, mistral, codellama"
                  className="w-full px-4 py-3 bg-elevated border border-border-subtle rounded-xl text-text-primary placeholder:text-text-muted focus:border-accent focus:ring-2 focus:ring-accent/20 outline-none transition-all font-mono text-sm"
                />
                <p className="text-xs text-text-muted">
                  Pull a model with <code className="px-1 py-0.5 bg-elevated rounded">ollama pull llama3.2</code>
                </p>
              </div>
            </div>
          )}

          {/* OpenRouter Settings */}
          {settings.activeProvider === 'openrouter' && (
            <div className="space-y-4 animate-fade-in">
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-sm font-medium text-text-secondary">
                  <Key className="w-4 h-4" />
                  API Key
                </label>
                <div className="relative">
                  <input
                    type={showApiKey['openrouter'] ? 'text' : 'password'}
                    value={settings.openrouter?.apiKey ?? ''}
                    onChange={e => setSettings(prev => ({
                      ...prev,
                      openrouter: { ...prev.openrouter!, apiKey: e.target.value }
                    }))}
                    placeholder="Enter your OpenRouter API key"
                    className="w-full px-4 py-3 pr-12 bg-elevated border border-border-subtle rounded-xl text-text-primary placeholder:text-text-muted focus:border-accent focus:ring-2 focus:ring-accent/20 outline-none transition-all"
                  />
                  <button
                    type="button"
                    onClick={() => toggleApiKeyVisibility('openrouter')}
                    className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-text-muted hover:text-text-primary transition-colors"
                  >
                    {showApiKey['openrouter'] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                <p className="text-xs text-text-muted">
                  Get your API key from{' '}
                  <a
                    href="https://openrouter.ai/keys"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent hover:underline"
                  >
                    OpenRouter Keys
                  </a>
                </p>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-text-secondary">Model</label>
                <OpenRouterModelCombobox
                  value={settings.openrouter?.model ?? ''}
                  onChange={(model) => setSettings(prev => ({
                    ...prev,
                    openrouter: { ...prev.openrouter!, model }
                  }))}
                  models={openRouterModels}
                  isLoading={isLoadingModels}
                  onLoadModels={loadOpenRouterModels}
                />
                <p className="text-xs text-text-muted">
                  Browse all models at{' '}
                  <a
                    href="https://openrouter.ai/models"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-accent hover:underline"
                  >
                    OpenRouter Models
                  </a>
                </p>
              </div>
            </div>
          )}



          {/* Custom (OpenAI-compatible) Settings */}
          {settings.activeProvider === 'custom' && (
            <div className="space-y-4 animate-fade-in">
              <div className="p-3 bg-blue-500/10 border border-blue-500/30 rounded-xl">
                <p className="text-xs text-blue-300 leading-relaxed">
                  Connect to any OpenAI-compatible API: vLLM, LM Studio, LocalAI, Groq, Mistral AI, AWS Bedrock (via compatibility endpoint), and more.
                </p>
              </div>

              <div className="space-y-2">
                <label className="flex items-center gap-2 text-sm font-medium text-text-secondary">
                  <Server className="w-4 h-4" />
                  Base URL
                </label>
                <input
                  type="url"
                  value={settings.custom?.baseUrl ?? ''}
                  onChange={e => setSettings(prev => ({ ...prev, custom: { ...prev.custom!, baseUrl: e.target.value } }))}
                  placeholder="http://localhost:8080/v1"
                  className="w-full px-4 py-3 bg-elevated border border-border-subtle rounded-xl text-text-primary placeholder:text-text-muted focus:border-accent focus:ring-2 focus:ring-accent/20 outline-none transition-all font-mono text-sm"
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-text-secondary">Model</label>
                <input
                  type="text"
                  value={settings.custom?.model ?? ''}
                  onChange={e => setSettings(prev => ({ ...prev, custom: { ...prev.custom!, model: e.target.value } }))}
                  placeholder="e.g., llama-3, mistral-7b, gpt-4"
                  className="w-full px-4 py-3 bg-elevated border border-border-subtle rounded-xl text-text-primary placeholder:text-text-muted focus:border-accent focus:ring-2 focus:ring-accent/20 outline-none transition-all font-mono text-sm"
                />
              </div>

              <div className="space-y-2">
                <label className="flex items-center gap-2 text-sm font-medium text-text-secondary">
                  <Key className="w-4 h-4" />
                  API Key <span className="text-text-muted font-normal">(optional)</span>
                </label>
                <div className="relative">
                  <input
                    type={showApiKey['custom'] ? 'text' : 'password'}
                    value={settings.custom?.apiKey ?? ''}
                    onChange={e => setSettings(prev => ({ ...prev, custom: { ...prev.custom!, apiKey: e.target.value } }))}
                    placeholder="Not required for local servers"
                    className="w-full px-4 py-3 pr-12 bg-elevated border border-border-subtle rounded-xl text-text-primary placeholder:text-text-muted focus:border-accent focus:ring-2 focus:ring-accent/20 outline-none transition-all"
                  />
                  <button
                    type="button"
                    onClick={() => toggleApiKeyVisibility('custom')}
                    className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-text-muted hover:text-text-primary transition-colors"
                  >
                    {showApiKey['custom'] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* AWS Bedrock Settings */}
          {settings.activeProvider === 'bedrock' && (
            <div className="space-y-4 animate-fade-in">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="flex items-center gap-2 text-sm font-medium text-text-secondary">
                    <Key className="w-4 h-4" />
                    Access Key ID
                  </label>
                  <div className="relative">
                    <input
                      type={showApiKey['bedrock-access'] ? 'text' : 'password'}
                      value={settings.bedrock?.accessKeyId ?? ''}
                      onChange={e => setSettings(prev => ({ ...prev, bedrock: { ...prev.bedrock!, accessKeyId: e.target.value } }))}
                      placeholder="AKIAIOSFODNN7EXAMPLE"
                      className="w-full px-4 py-3 pr-10 bg-elevated border border-border-subtle rounded-xl text-text-primary placeholder:text-text-muted focus:border-accent focus:ring-2 focus:ring-accent/20 outline-none transition-all font-mono text-xs"
                    />
                    <button
                      type="button"
                      onClick={() => toggleApiKeyVisibility('bedrock-access')}
                      className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-text-muted hover:text-text-primary transition-colors"
                    >
                      {showApiKey['bedrock-access'] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="flex items-center gap-2 text-sm font-medium text-text-secondary">
                    <Key className="w-4 h-4" />
                    Secret Access Key
                  </label>
                  <div className="relative">
                    <input
                      type={showApiKey['bedrock-secret'] ? 'text' : 'password'}
                      value={settings.bedrock?.secretAccessKey ?? ''}
                      onChange={e => setSettings(prev => ({ ...prev, bedrock: { ...prev.bedrock!, secretAccessKey: e.target.value } }))}
                      placeholder="wJalrXUtnFEMI/K7MDENG"
                      className="w-full px-4 py-3 pr-10 bg-elevated border border-border-subtle rounded-xl text-text-primary placeholder:text-text-muted focus:border-accent focus:ring-2 focus:ring-accent/20 outline-none transition-all font-mono text-xs"
                    />
                    <button
                      type="button"
                      onClick={() => toggleApiKeyVisibility('bedrock-secret')}
                      className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-text-muted hover:text-text-primary transition-colors"
                    >
                      {showApiKey['bedrock-secret'] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-text-secondary">
                  Session Token <span className="text-text-muted font-normal">(optional — for STS temporary credentials)</span>
                </label>
                <input
                  type="text"
                  value={settings.bedrock?.sessionToken ?? ''}
                  onChange={e => setSettings(prev => ({ ...prev, bedrock: { ...prev.bedrock!, sessionToken: e.target.value } }))}
                  placeholder="Leave empty for long-term credentials"
                  className="w-full px-4 py-3 bg-elevated border border-border-subtle rounded-xl text-text-primary placeholder:text-text-muted focus:border-accent focus:ring-2 focus:ring-accent/20 outline-none transition-all font-mono text-xs"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium text-text-secondary">Region</label>
                  <input
                    type="text"
                    list="aws-regions"
                    value={settings.bedrock?.region ?? 'us-east-1'}
                    onChange={e => setSettings(prev => ({ ...prev, bedrock: { ...prev.bedrock!, region: e.target.value } }))}
                    placeholder="e.g. us-east-1"
                    className="w-full px-4 py-3 bg-elevated border border-border-subtle rounded-xl text-text-primary placeholder:text-text-muted focus:border-accent focus:ring-2 focus:ring-accent/20 outline-none transition-all font-mono text-xs"
                  />
                  <datalist id="aws-regions">
                    <option value="us-east-1">N. Virginia</option>
                    <option value="us-east-2">Ohio</option>
                    <option value="us-west-1">N. California</option>
                    <option value="us-west-2">Oregon</option>
                    <option value="eu-west-1">Ireland</option>
                    <option value="eu-west-2">London</option>
                    <option value="eu-west-3">Paris</option>
                    <option value="eu-central-1">Frankfurt</option>
                    <option value="eu-central-2">Zurich</option>
                    <option value="eu-north-1">Stockholm</option>
                    <option value="eu-south-1">Milan</option>
                    <option value="eu-south-2">Spain</option>
                    <option value="ap-southeast-1">Singapore</option>
                    <option value="ap-southeast-2">Sydney</option>
                    <option value="ap-southeast-3">Jakarta</option>
                    <option value="ap-northeast-1">Tokyo</option>
                    <option value="ap-northeast-2">Seoul</option>
                    <option value="ap-northeast-3">Osaka</option>
                    <option value="ap-south-1">Mumbai</option>
                    <option value="ap-south-2">Hyderabad</option>
                    <option value="ap-east-1">Hong Kong</option>
                    <option value="sa-east-1">São Paulo</option>
                    <option value="ca-central-1">Canada</option>
                    <option value="me-south-1">Bahrain</option>
                    <option value="me-central-1">UAE</option>
                    <option value="af-south-1">Cape Town</option>
                    <option value="il-central-1">Tel Aviv</option>
                  </datalist>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium text-text-secondary">Model</label>
                  <input
                    type="text"
                    value={settings.bedrock?.model ?? 'anthropic.claude-3-5-sonnet-20241022-v2:0'}
                    onChange={e => setSettings(prev => ({ ...prev, bedrock: { ...prev.bedrock!, model: e.target.value } }))}
                    placeholder="e.g. anthropic.claude-3-5-sonnet-20241022-v2:0"
                    className="w-full px-4 py-3 bg-elevated border border-border-subtle rounded-xl text-text-primary placeholder:text-text-muted focus:border-accent focus:ring-2 focus:ring-accent/20 outline-none transition-all font-mono text-xs"
                  />
                </div>
              </div>

              <p className="text-xs text-text-muted">
                Make sure Bedrock model access is enabled in your{' '}
                <a
                  href="https://console.aws.amazon.com/bedrock/home#/modelaccess"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent hover:underline"
                >
                  AWS Console
                </a>
              </p>

              {/* Bedrock Health Check */}
              <div className="space-y-2">
                <button
                  type="button"
                  disabled={
                    !settings.bedrock?.accessKeyId?.trim() ||
                    !settings.bedrock?.secretAccessKey?.trim() ||
                    !settings.bedrock?.model?.trim() ||
                    bedrockTestStatus === 'testing'
                  }
                  onClick={async () => {
                    setBedrockTestStatus('testing');
                    setBedrockTestMessage('');
                    try {
                      const result = await testBedrockConnection({
                        region: settings.bedrock?.region || 'us-east-1',
                        accessKeyId: settings.bedrock?.accessKeyId || '',
                        secretAccessKey: settings.bedrock?.secretAccessKey || '',
                        sessionToken: settings.bedrock?.sessionToken || undefined,
                        model: settings.bedrock?.model || '',
                      });
                      if (result.ok) {
                        setBedrockTestStatus('success');
                        setBedrockTestMessage(`Connected — ${result.model} in ${result.region}`);
                      } else {
                        setBedrockTestStatus('error');
                        setBedrockTestMessage(result.error || 'Connection failed');
                      }
                    } catch (err: any) {
                      setBedrockTestStatus('error');
                      setBedrockTestMessage(err.message || 'Failed to reach backend server');
                    }
                  }}
                  className="flex items-center gap-2 px-4 py-2 bg-accent/20 text-accent rounded-lg hover:bg-accent/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed text-sm font-medium"
                >
                  {bedrockTestStatus === 'testing' ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Server className="w-4 h-4" />
                  )}
                  Test Connection
                </button>

                {bedrockTestStatus === 'success' && (
                  <div className="flex items-start gap-2 p-3 bg-green-500/10 border border-green-500/20 rounded-lg">
                    <Check className="w-4 h-4 text-green-400 flex-shrink-0 mt-0.5" />
                    <span className="text-xs text-green-400">{bedrockTestMessage}</span>
                  </div>
                )}

                {bedrockTestStatus === 'error' && (
                  <div className="flex items-start gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-lg">
                    <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
                    <span className="text-xs text-red-400 break-all">{bedrockTestMessage}</span>
                  </div>
                )}

                {!getBackendUrl() && (
                  <p className="text-xs text-yellow-400/80">
                    Bedrock requires the local server running (<code className="bg-elevated px-1 rounded">gitnexus serve</code>) to proxy API calls and bypass browser CORS restrictions.
                  </p>
                )}
              </div>
            </div>
          )}

          {/* ── Database Backend ───────────────────────────────────────── */}
          <div className="mt-6 pt-6 border-t border-border-subtle">
            <h3 className="text-sm font-semibold text-text-primary mb-4">Database Backend</h3>

            {/* DB Type selector */}
            <div className="flex gap-2 mb-4">
              <button
                onClick={() => setDbType('kuzu')}
                className={`flex-1 px-4 py-2.5 rounded-xl border-2 text-sm font-medium transition-all
                  ${dbType === 'kuzu'
                    ? 'border-accent bg-accent/10 text-text-primary'
                    : 'border-border-subtle bg-elevated hover:border-accent/50 text-text-secondary'
                  }`}
              >
                KuzuDB (Local)
              </button>
              <button
                onClick={() => setDbType('neptune')}
                className={`flex-1 px-4 py-2.5 rounded-xl border-2 text-sm font-medium transition-all
                  ${dbType === 'neptune'
                    ? 'border-accent bg-accent/10 text-text-primary'
                    : 'border-border-subtle bg-elevated hover:border-accent/50 text-text-secondary'
                  }`}
              >
                Neptune (AWS)
              </button>
            </div>

            {/* Neptune config */}
            {dbType === 'neptune' && (
              <div className="space-y-3 animate-fade-in">
                <div className="space-y-2">
                  <label className="text-sm font-medium text-text-secondary">Neptune Endpoint</label>
                  <input
                    type="text"
                    value={neptuneEndpoint}
                    onChange={e => setNeptuneEndpoint(e.target.value)}
                    placeholder="mydb.cluster-xxxxx.us-east-1.neptune.amazonaws.com"
                    className="w-full px-4 py-3 bg-elevated border border-border-subtle rounded-xl text-text-primary placeholder:text-text-muted focus:border-accent focus:ring-2 focus:ring-accent/20 outline-none transition-all font-mono text-sm"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-text-secondary">AWS Region</label>
                    <input
                      type="text"
                      value={neptuneRegion}
                      onChange={e => setNeptuneRegion(e.target.value)}
                      placeholder="us-east-1"
                      className="w-full px-4 py-3 bg-elevated border border-border-subtle rounded-xl text-text-primary placeholder:text-text-muted focus:border-accent focus:ring-2 focus:ring-accent/20 outline-none transition-all font-mono text-sm"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-text-secondary">Port</label>
                    <input
                      type="text"
                      value={neptunePort}
                      onChange={e => setNeptunePort(e.target.value)}
                      placeholder="8182"
                      className="w-full px-4 py-3 bg-elevated border border-border-subtle rounded-xl text-text-primary placeholder:text-text-muted focus:border-accent focus:ring-2 focus:ring-accent/20 outline-none transition-all font-mono text-sm"
                    />
                  </div>
                </div>

                {/* Test Connection */}
                <div className="flex items-center gap-3">
                  <button
                    onClick={handleTestNeptune}
                    disabled={dbTestStatus === 'testing' || !neptuneEndpoint || !neptuneRegion}
                    className="px-4 py-2 bg-accent hover:bg-accent/80 disabled:opacity-50 text-white text-sm rounded-xl font-medium transition-colors"
                  >
                    {dbTestStatus === 'testing' ? 'Testing...' : 'Test Connection'}
                  </button>
                  {dbTestStatus === 'ok' && (
                    <span className="text-green-400 text-sm">{dbTestMessage}</span>
                  )}
                  {dbTestStatus === 'error' && (
                    <span className="text-red-400 text-sm">{dbTestMessage}</span>
                  )}
                </div>

                {/* Graph Explorer info */}
                <div className="p-3 bg-blue-500/10 border border-blue-500/30 rounded-xl mt-2">
                  <p className="text-xs text-blue-300 leading-relaxed">
                    <strong>AWS Graph Explorer:</strong> Deploy the open-source Graph Explorer alongside Neptune
                    for visual graph exploration. See docs/neptune-setup.md for instructions.
                  </p>
                </div>
              </div>
            )}

            {/* Cypher Console button */}
            <button
              onClick={() => setShowCypherConsole(true)}
              className="mt-4 px-4 py-2 bg-elevated border border-border-subtle hover:border-accent/50 text-text-secondary hover:text-text-primary text-sm rounded-xl font-medium transition-all"
            >
              Open Cypher Console
            </button>

            {/* Reload banner after DB backend change */}
            {dbChanged && (
              <div className="mt-3 p-3 bg-yellow-500/10 border border-yellow-500/30 rounded-xl flex items-center justify-between">
                <p className="text-sm text-yellow-300">
                  Database backend changed. Reload the graph to apply.
                </p>
                <button
                  onClick={() => { onReloadGraph?.(); setDbChanged(false); }}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-accent hover:bg-accent/80 text-white text-sm rounded-lg font-medium transition-colors"
                >
                  <RefreshCw size={14} />
                  Reload Graph
                </button>
              </div>
            )}
          </div>

          {/* Cypher Console Modal */}
          {showCypherConsole && <CypherConsole onClose={() => setShowCypherConsole(false)} />}

          {/* Privacy Note */}
          <div className="p-4 bg-elevated/50 border border-border-subtle rounded-xl">
            <div className="flex gap-3">
              <div className="w-8 h-8 flex items-center justify-center bg-green-500/20 rounded-lg text-green-400 flex-shrink-0">
                🔒
              </div>
              <div className="text-xs text-text-muted leading-relaxed">
                <span className="text-text-secondary font-medium">Privacy:</span> Your API keys are stored only in your browser's local storage.
                They're sent directly to the LLM provider when you chat. Your code never leaves your machine.
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-border-subtle bg-elevated/30">
          <div className="flex items-center gap-2 text-sm">
            {saveStatus === 'saved' && (
              <span className="flex items-center gap-1.5 text-green-400 animate-fade-in">
                <Check className="w-4 h-4" />
                Settings saved
              </span>
            )}
            {saveStatus === 'error' && (
              <span className="flex items-center gap-1.5 text-red-400 animate-fade-in">
                <AlertCircle className="w-4 h-4" />
                Failed to save
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={dbSaving || (dbType === 'neptune' && (!neptuneEndpoint || !neptuneRegion))}
              className="px-5 py-2 bg-accent text-white text-sm font-medium rounded-lg hover:bg-accent-dim disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {dbSaving ? 'Saving...' : 'Save Settings'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};


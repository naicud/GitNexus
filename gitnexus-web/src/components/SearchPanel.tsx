import { useState, useEffect, useRef, useCallback } from 'react';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import { Search, X, Filter } from 'lucide-react';
import { useAppState } from '../hooks/useAppState';
import { NODE_COLORS } from '../lib/constants';
import { getBackendUrl } from '../services/backend';
import type { NodeLabel, GraphNode } from '../core/graph/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SearchResult {
  id: string;
  name: string;
  type: NodeLabel;
  filePath: string;
  score?: number;
}

export interface SearchPanelProps {
  isOpen: boolean;
  onClose: () => void;
  onFocusNode: (nodeId: string) => void;
  /** Forwarded query from the Header input */
  externalQuery?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SEARCHABLE_TYPES: NodeLabel[] = [
  'Function',
  'Class',
  'Method',
  'Interface',
  'File',
  'Module',
  'Variable',
  'Enum',
  'Type',
];

const MAX_RESULTS = 200;
const DEBOUNCE_MS = 300;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const SearchPanel: React.FC<SearchPanelProps> = ({
  isOpen,
  onClose,
  onFocusNode,
  externalQuery = '',
}) => {
  const { graph, serverBaseUrl, projectName } = useAppState();

  const [query, setQuery] = useState(externalQuery);
  const [typeFilter, setTypeFilter] = useState<NodeLabel | 'all'>('all');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const virtuosoRef = useRef<VirtuosoHandle>(null);

  // Sync external query from the Header input
  useEffect(() => {
    setQuery(externalQuery);
  }, [externalQuery]);

  // Focus input when panel opens
  useEffect(() => {
    if (isOpen) {
      // Small delay so the panel is mounted before focusing
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [isOpen]);

  // Reset selected index when results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [results]);

  // ------ Client-side search helper ------
  const searchClientSide = useCallback(
    (q: string, filter: NodeLabel | 'all'): SearchResult[] => {
      if (!graph) return [];
      const lower = q.toLowerCase();
      const matches: SearchResult[] = [];
      for (const n of graph.nodes) {
        if (filter !== 'all' && n.label !== filter) continue;
        if (!n.properties.name?.toLowerCase().includes(lower)) continue;
        matches.push({
          id: n.id,
          name: n.properties.name,
          type: n.label,
          filePath: n.properties.filePath || '',
        });
        if (matches.length >= MAX_RESULTS) break;
      }
      return matches;
    },
    [graph],
  );

  // ------ Map server FTS results to graph nodes when possible ------
  const mapServerResults = useCallback(
    (
      serverResults: Array<{
        nodeId?: string;
        name?: string;
        label?: string;
        filePath: string;
        score?: number;
      }>,
      filter: NodeLabel | 'all',
    ): SearchResult[] => {
      if (!graph) return [];

      // Build a fast filePath -> nodes index for matching
      const fileIndex = new Map<string, GraphNode[]>();
      for (const n of graph.nodes) {
        const fp = n.properties.filePath;
        if (!fp) continue;
        let arr = fileIndex.get(fp);
        if (!arr) {
          arr = [];
          fileIndex.set(fp, arr);
        }
        arr.push(n);
      }

      const seen = new Set<string>();
      const mapped: SearchResult[] = [];

      for (const r of serverResults) {
        // If the server gave us a nodeId directly, try to use it
        if (r.nodeId && !seen.has(r.nodeId)) {
          const node = graph.nodes.find((n) => n.id === r.nodeId);
          if (node) {
            if (filter !== 'all' && node.label !== filter) continue;
            seen.add(node.id);
            mapped.push({
              id: node.id,
              name: node.properties.name,
              type: node.label,
              filePath: node.properties.filePath || '',
              score: r.score,
            });
            if (mapped.length >= MAX_RESULTS) break;
            continue;
          }
        }

        // Otherwise match by filePath — surface all nodes in that file
        const nodesInFile = fileIndex.get(r.filePath) ?? [];
        for (const n of nodesInFile) {
          if (seen.has(n.id)) continue;
          if (filter !== 'all' && n.label !== filter) continue;
          seen.add(n.id);
          mapped.push({
            id: n.id,
            name: n.properties.name,
            type: n.label,
            filePath: n.properties.filePath || '',
            score: r.score,
          });
          if (mapped.length >= MAX_RESULTS) break;
        }
        if (mapped.length >= MAX_RESULTS) break;
      }

      return mapped;
    },
    [graph],
  );

  // ------ Debounced search effect ------
  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        // Try server-side FTS first
        if (serverBaseUrl && projectName) {
          const baseUrl = getBackendUrl();
          const res = await fetch(`${baseUrl}/api/search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              query: query.trim(),
              repo: projectName,
              limit: MAX_RESULTS,
            }),
          });
          if (res.ok) {
            const data = await res.json();
            const serverItems = data.results || [];
            if (serverItems.length > 0) {
              setResults(mapServerResults(serverItems, typeFilter));
              setLoading(false);
              return;
            }
          }
        }
        // Client-side fallback
        setResults(searchClientSide(query.trim(), typeFilter));
      } catch {
        // On any network error, fall back to client-side
        setResults(searchClientSide(query.trim(), typeFilter));
      } finally {
        setLoading(false);
      }
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [query, typeFilter, serverBaseUrl, projectName, searchClientSide, mapServerResults]);

  // ------ Keyboard navigation ------
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }

      if (results.length === 0) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((i) => {
          const next = Math.min(i + 1, results.length - 1);
          virtuosoRef.current?.scrollIntoView({ index: next, behavior: 'auto' });
          return next;
        });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((i) => {
          const next = Math.max(i - 1, 0);
          virtuosoRef.current?.scrollIntoView({ index: next, behavior: 'auto' });
          return next;
        });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const selected = results[selectedIndex];
        if (selected) {
          onFocusNode(selected.id);
        }
      }
    },
    [results, selectedIndex, onClose, onFocusNode],
  );

  if (!isOpen) return null;

  return (
    <div className="absolute top-full left-0 right-0 max-h-[70vh] bg-surface border border-border-subtle rounded-lg shadow-2xl z-50 flex flex-col overflow-hidden mt-1">
      {/* Search input + type filter */}
      <div className="p-3 border-b border-border-subtle flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Search className="w-4 h-4 text-text-muted flex-shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search symbols..."
            className="flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-muted outline-none"
          />
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text-primary transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex items-center gap-2">
          <Filter className="w-3.5 h-3.5 text-text-muted flex-shrink-0" />
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as NodeLabel | 'all')}
            className="bg-elevated text-xs text-text-primary border border-border-subtle rounded px-2 py-1 outline-none cursor-pointer"
          >
            <option value="all">All Types</option>
            {SEARCHABLE_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Results area */}
      <div className="flex-1 min-h-0" style={{ maxHeight: 'calc(70vh - 120px)' }}>
        {loading && (
          <div className="p-4 text-sm text-text-muted text-center">Searching...</div>
        )}
        {!loading && results.length === 0 && query.trim() && (
          <div className="p-4 text-sm text-text-muted text-center">
            No results found for &ldquo;{query}&rdquo;
          </div>
        )}
        {!loading && results.length === 0 && !query.trim() && (
          <div className="p-4 text-sm text-text-muted text-center">
            Type to search symbols...
          </div>
        )}
        {!loading && results.length > 0 && (
          <Virtuoso
            ref={virtuosoRef}
            data={results}
            overscan={50}
            style={{ height: Math.min(results.length * 52, 400) }}
            itemContent={(index, result) => (
              <button
                key={result.id}
                onClick={() => onFocusNode(result.id)}
                className={`w-full px-3 py-2.5 flex items-start gap-2.5 text-left transition-colors border-b border-border-subtle/50 ${
                  index === selectedIndex
                    ? 'bg-accent/20 text-text-primary'
                    : 'hover:bg-hover text-text-secondary'
                }`}
              >
                <span
                  className="inline-block w-2.5 h-2.5 rounded-full mt-1 flex-shrink-0"
                  style={{
                    backgroundColor: NODE_COLORS[result.type] || '#6b7280',
                  }}
                />
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-sm text-text-primary truncate">
                    {result.name}
                  </div>
                  <div className="flex items-center gap-2 text-xs text-text-muted mt-0.5">
                    <span className="px-1.5 py-0.5 bg-elevated rounded text-text-secondary">
                      {result.type}
                    </span>
                    {result.filePath && (
                      <span className="truncate">{result.filePath}</span>
                    )}
                  </div>
                </div>
              </button>
            )}
          />
        )}
      </div>

      {/* Result count footer */}
      {results.length > 0 && (
        <div className="px-3 py-1.5 border-t border-border-subtle text-xs text-text-muted flex items-center justify-between">
          <span>
            {results.length} result{results.length !== 1 ? 's' : ''}
            {results.length >= MAX_RESULTS ? ' (limit reached)' : ''}
          </span>
          <span className="text-text-muted/60">
            <kbd className="px-1 py-0.5 bg-elevated border border-border-subtle rounded text-[10px] font-mono">
              &uarr;&darr;
            </kbd>{' '}
            navigate{' '}
            <kbd className="px-1 py-0.5 bg-elevated border border-border-subtle rounded text-[10px] font-mono">
              Enter
            </kbd>{' '}
            select
          </span>
        </div>
      )}
    </div>
  );
};

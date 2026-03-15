import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  X,
  Loader2,
  ArrowDownLeft,
  ArrowUpRight,
  Network,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { fetchNeighborCounts, type NeighborCounts } from '../services/graph-lod';
import { EDGE_INFO, type EdgeType } from '../lib/constants';

interface NeighborPanelProps {
  nodeId: string;
  nodeName: string;
  nodeType: string;
  baseUrl: string;
  repo: string;
  isOpen: boolean;
  onClose: () => void;
  onExpand: (nodeId: string, depth: number, types?: string[], direction?: 'inbound' | 'outbound' | 'both') => void;
}

export const NeighborPanel = ({
  nodeId,
  nodeName,
  nodeType,
  baseUrl,
  repo,
  isOpen,
  onClose,
  onExpand,
}: NeighborPanelProps) => {
  const [counts, setCounts] = useState<NeighborCounts | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanding, setExpanding] = useState(false);

  // Track which rel types are checked, keyed by "inbound:TYPE" or "outbound:TYPE"
  const [checked, setChecked] = useState<Set<string>>(new Set());

  // Sections collapse state
  const [inboundOpen, setInboundOpen] = useState(true);
  const [outboundOpen, setOutboundOpen] = useState(true);

  // Fetch counts when panel opens or nodeId changes
  useEffect(() => {
    if (!isOpen || !nodeId) return;

    let cancelled = false;
    setLoading(true);
    setError(null);
    setCounts(null);
    setChecked(new Set());

    fetchNeighborCounts(baseUrl, repo, nodeId)
      .then((result) => {
        if (cancelled) return;
        setCounts(result);
        // Default: all types checked
        const allKeys = new Set<string>();
        for (const relType of Object.keys(result.inbound)) {
          allKeys.add(`inbound:${relType}`);
        }
        for (const relType of Object.keys(result.outbound)) {
          allKeys.add(`outbound:${relType}`);
        }
        setChecked(allKeys);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message || 'Failed to fetch neighbor counts');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [isOpen, nodeId, baseUrl, repo]);

  const toggleCheck = useCallback((key: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  // Compute selected types and direction from checked set
  const { selectedTypes, selectedDirection, selectedCount } = useMemo(() => {
    if (!counts) return { selectedTypes: [] as string[], selectedDirection: 'both' as const, selectedCount: 0 };

    const inboundTypes: string[] = [];
    const outboundTypes: string[] = [];
    let count = 0;

    for (const key of checked) {
      const [dir, relType] = key.split(':');
      if (dir === 'inbound' && counts.inbound[relType] !== undefined) {
        inboundTypes.push(relType);
        count += counts.inbound[relType];
      } else if (dir === 'outbound' && counts.outbound[relType] !== undefined) {
        outboundTypes.push(relType);
        count += counts.outbound[relType];
      }
    }

    // Determine direction
    const hasInbound = inboundTypes.length > 0;
    const hasOutbound = outboundTypes.length > 0;
    let direction: 'inbound' | 'outbound' | 'both';
    if (hasInbound && hasOutbound) {
      direction = 'both';
    } else if (hasInbound) {
      direction = 'inbound';
    } else if (hasOutbound) {
      direction = 'outbound';
    } else {
      direction = 'both';
    }

    // Merge unique types from both directions
    const allTypes = [...new Set([...inboundTypes, ...outboundTypes])];

    return { selectedTypes: allTypes, selectedDirection: direction, selectedCount: count };
  }, [checked, counts]);

  const handleFetch = useCallback(async () => {
    if (selectedTypes.length === 0 || expanding) return;
    setExpanding(true);
    try {
      await onExpand(
        nodeId,
        1,
        selectedTypes,
        selectedDirection,
      );
      onClose();
    } finally {
      setExpanding(false);
    }
  }, [nodeId, selectedTypes, selectedDirection, expanding, onExpand, onClose]);

  const getEdgeColor = (relType: string): string => {
    const info = EDGE_INFO[relType as EdgeType];
    return info ? info.color : '#64748b';
  };

  const getEdgeLabel = (relType: string): string => {
    const info = EDGE_INFO[relType as EdgeType];
    return info ? info.label : relType;
  };

  if (!isOpen) return null;

  return (
    <div className="fixed top-16 right-4 z-40 w-72 bg-elevated border border-border-subtle rounded-xl shadow-xl animate-slide-in flex flex-col max-h-[calc(100vh-5rem)]">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
        <div className="flex items-center gap-2 min-w-0">
          <Network className="w-4 h-4 text-accent flex-shrink-0" />
          <div className="min-w-0">
            <div className="text-sm font-medium text-text-primary truncate">{nodeName}</div>
            <div className="text-[10px] text-text-muted uppercase tracking-wider">{nodeType}</div>
          </div>
        </div>
        <button
          onClick={onClose}
          className="p-1 text-text-muted hover:text-text-primary hover:bg-hover rounded transition-colors flex-shrink-0"
          title="Close"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-4 py-3 scrollbar-thin">
        {loading && (
          <div className="flex items-center justify-center gap-2 py-8 text-text-muted">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="text-sm">Loading counts...</span>
          </div>
        )}

        {error && (
          <div className="text-sm text-red-400 py-4 text-center">{error}</div>
        )}

        {!loading && !error && counts && counts.total === 0 && (
          <div className="text-sm text-text-muted py-8 text-center">No neighbors found</div>
        )}

        {!loading && !error && counts && counts.total > 0 && (
          <div className="space-y-3">
            {/* Inbound section */}
            {Object.keys(counts.inbound).length > 0 && (
              <div>
                <button
                  onClick={() => setInboundOpen(!inboundOpen)}
                  className="flex items-center gap-1.5 w-full text-left mb-1.5"
                >
                  {inboundOpen ? (
                    <ChevronDown className="w-3 h-3 text-text-muted" />
                  ) : (
                    <ChevronRight className="w-3 h-3 text-text-muted" />
                  )}
                  <ArrowDownLeft className="w-3.5 h-3.5 text-cyan-400" />
                  <span className="text-xs font-medium text-text-secondary uppercase tracking-wider">
                    Inbound
                  </span>
                  <span className="text-[10px] text-text-muted ml-auto">
                    {Object.values(counts.inbound).reduce((s, c) => s + c, 0)}
                  </span>
                </button>
                {inboundOpen && (
                  <div className="space-y-0.5 ml-2">
                    {Object.entries(counts.inbound)
                      .sort(([, a], [, b]) => b - a)
                      .map(([relType, cnt]) => {
                        const key = `inbound:${relType}`;
                        const isChecked = checked.has(key);
                        return (
                          <label
                            key={key}
                            className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-hover cursor-pointer transition-colors group"
                          >
                            <input
                              type="checkbox"
                              checked={isChecked}
                              onChange={() => toggleCheck(key)}
                              className="accent-accent w-3.5 h-3.5 rounded"
                            />
                            <span
                              className="w-2 h-2 rounded-full flex-shrink-0"
                              style={{ backgroundColor: getEdgeColor(relType) }}
                            />
                            <span className="text-xs text-text-primary flex-1">
                              {getEdgeLabel(relType)}
                            </span>
                            <span className="text-[10px] text-text-muted font-mono tabular-nums">
                              {cnt}
                            </span>
                          </label>
                        );
                      })}
                  </div>
                )}
              </div>
            )}

            {/* Outbound section */}
            {Object.keys(counts.outbound).length > 0 && (
              <div>
                <button
                  onClick={() => setOutboundOpen(!outboundOpen)}
                  className="flex items-center gap-1.5 w-full text-left mb-1.5"
                >
                  {outboundOpen ? (
                    <ChevronDown className="w-3 h-3 text-text-muted" />
                  ) : (
                    <ChevronRight className="w-3 h-3 text-text-muted" />
                  )}
                  <ArrowUpRight className="w-3.5 h-3.5 text-amber-400" />
                  <span className="text-xs font-medium text-text-secondary uppercase tracking-wider">
                    Outbound
                  </span>
                  <span className="text-[10px] text-text-muted ml-auto">
                    {Object.values(counts.outbound).reduce((s, c) => s + c, 0)}
                  </span>
                </button>
                {outboundOpen && (
                  <div className="space-y-0.5 ml-2">
                    {Object.entries(counts.outbound)
                      .sort(([, a], [, b]) => b - a)
                      .map(([relType, cnt]) => {
                        const key = `outbound:${relType}`;
                        const isChecked = checked.has(key);
                        return (
                          <label
                            key={key}
                            className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-hover cursor-pointer transition-colors group"
                          >
                            <input
                              type="checkbox"
                              checked={isChecked}
                              onChange={() => toggleCheck(key)}
                              className="accent-accent w-3.5 h-3.5 rounded"
                            />
                            <span
                              className="w-2 h-2 rounded-full flex-shrink-0"
                              style={{ backgroundColor: getEdgeColor(relType) }}
                            />
                            <span className="text-xs text-text-primary flex-1">
                              {getEdgeLabel(relType)}
                            </span>
                            <span className="text-[10px] text-text-muted font-mono tabular-nums">
                              {cnt}
                            </span>
                          </label>
                        );
                      })}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Footer with Fetch button */}
      {!loading && counts && counts.total > 0 && (
        <div className="px-4 py-3 border-t border-border-subtle">
          <button
            onClick={handleFetch}
            disabled={selectedTypes.length === 0 || expanding}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-accent hover:bg-accent-dim disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-colors"
          >
            {expanding ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>Expanding...</span>
              </>
            ) : (
              <>
                <Network className="w-3.5 h-3.5" />
                <span>
                  Fetch Selected ({selectedCount})
                </span>
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
};

/**
 * Schema Graph Modal
 *
 * Displays an SVG visualization of the graph schema — node types with counts
 * and relationship types between them. Uses a simple circular layout since
 * schemas typically have fewer than 30 node types.
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { X } from 'lucide-react';
import { NODE_COLORS, EDGE_INFO } from '../lib/constants';
import type { NodeLabel } from '../core/graph/types';

interface SchemaGraphProps {
  isOpen: boolean;
  onClose: () => void;
  baseUrl: string;
  repo: string;
}

interface SchemaNode {
  type: string;
  count: number;
  x: number;
  y: number;
}

interface SchemaEdge {
  sourceType: string;
  targetType: string;
  type: string;
  count: number;
}

/** Map a node type to its color from constants, with a fallback. */
const getNodeColor = (type: string): string => {
  return (NODE_COLORS as Record<string, string>)[type] ?? '#64748b';
};

/** Map an edge type to its color from constants, with a fallback. */
const getEdgeColor = (type: string): string => {
  return (EDGE_INFO as Record<string, { color: string; label: string }>)[type]?.color ?? '#475569';
};

/** Format large numbers compactly. */
const formatCount = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
};

/**
 * Compute a quadratic bezier curve between two points with an offset perpendicular
 * to the line connecting them (to avoid overlapping edges between the same pair).
 */
const curvedPath = (
  x1: number, y1: number,
  x2: number, y2: number,
  curveOffset: number,
): string => {
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  // Perpendicular offset
  const nx = -dy / len;
  const ny = dx / len;
  const cx = mx + nx * curveOffset;
  const cy = my + ny * curveOffset;
  return `M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`;
};

/** Compute the midpoint of a quadratic bezier for label positioning. */
const curvedMidpoint = (
  x1: number, y1: number,
  x2: number, y2: number,
  curveOffset: number,
): { x: number; y: number } => {
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  // Midpoint of quadratic bezier at t=0.5 is (P0 + 2*CP + P2) / 4
  const cx = mx + nx * curveOffset;
  const cy = my + ny * curveOffset;
  return {
    x: (x1 + 2 * cx + x2) / 4,
    y: (y1 + 2 * cy + y2) / 4,
  };
};

export const SchemaGraph: React.FC<SchemaGraphProps> = ({ isOpen, onClose, baseUrl, repo }) => {
  const [nodes, setNodes] = useState<SchemaNode[]>([]);
  const [edges, setEdges] = useState<SchemaEdge[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hoveredEdge, setHoveredEdge] = useState<number | null>(null);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    setError(null);
    fetch(`${baseUrl}/graph/schema?repo=${encodeURIComponent(repo)}`)
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(data => {
        const types: Array<{ type: string; count: number }> = data.nodeTypes ?? [];

        // Filter out internal-only types with 0 meaningful count
        const filteredTypes = types.filter(n => n.count > 0);

        // Layout: position nodes in a circle
        const cx = 400;
        const cy = 350;
        const radius = Math.min(250, 80 + filteredTypes.length * 20);
        const positioned = filteredTypes.map((n, i) => ({
          ...n,
          x: cx + radius * Math.cos(2 * Math.PI * i / filteredTypes.length - Math.PI / 2),
          y: cy + radius * Math.sin(2 * Math.PI * i / filteredTypes.length - Math.PI / 2),
        }));
        setNodes(positioned);
        setEdges(data.edgeTypes ?? []);
      })
      .catch(err => {
        setError(err.message || 'Failed to load schema');
      })
      .finally(() => setLoading(false));
  }, [isOpen, baseUrl, repo]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose]);

  // Close on backdrop click
  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === containerRef.current) {
      onClose();
    }
  }, [onClose]);

  // Build a lookup from type -> node for edge rendering
  const nodeByType = useMemo(() => {
    const map = new Map<string, SchemaNode>();
    for (const n of nodes) map.set(n.type, n);
    return map;
  }, [nodes]);

  // Group edges between the same (source, target) pair to offset them
  const edgeGroups = useMemo(() => {
    const groupMap = new Map<string, SchemaEdge[]>();
    for (const e of edges) {
      const key = `${e.sourceType}:${e.targetType}`;
      if (!groupMap.has(key)) groupMap.set(key, []);
      groupMap.get(key)!.push(e);
    }
    return groupMap;
  }, [edges]);

  // Node radius based on log(count)
  const getRadius = useCallback((count: number): number => {
    return Math.max(18, Math.min(45, 10 + Math.log10(count + 1) * 10));
  }, []);

  if (!isOpen) return null;

  const svgWidth = 800;
  const svgHeight = 700;

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 animate-fade-in"
      onClick={handleBackdropClick}
    >
      {/* Modal */}
      <div className="bg-slate-900/60 backdrop-blur-2xl border border-white/10 rounded-3xl shadow-2xl shadow-cyan-500/10 flex flex-col animate-scale-in overflow-hidden relative w-[95%] max-w-4xl max-h-[90vh]">
        {/* Gradient overlay */}
        <div className="absolute inset-0 bg-gradient-to-br from-white/5 to-transparent pointer-events-none" />

        {/* Header */}
        <div className="px-6 py-5 border-b border-white/10 relative z-10 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-white">Graph Schema</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Node types and relationship patterns — {nodes.length} types, {edges.length} patterns
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-slate-400 hover:text-white hover:bg-white/10 rounded-lg transition-colors"
            title="Close (Esc)"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-4 relative z-10">
          {loading && (
            <div className="flex items-center justify-center h-64">
              <div className="flex items-center gap-3 text-slate-400">
                <div className="w-5 h-5 border-2 border-slate-600 border-t-cyan-400 rounded-full animate-spin" />
                <span className="text-sm">Loading schema...</span>
              </div>
            </div>
          )}

          {error && (
            <div className="flex items-center justify-center h-64">
              <div className="text-center">
                <p className="text-red-400 text-sm font-medium">Failed to load schema</p>
                <p className="text-slate-500 text-xs mt-1">{error}</p>
              </div>
            </div>
          )}

          {!loading && !error && nodes.length > 0 && (
            <svg
              viewBox={`0 0 ${svgWidth} ${svgHeight}`}
              className="w-full h-auto"
              style={{ minHeight: '400px' }}
            >
              {/* Arrow marker definitions */}
              <defs>
                {edges.map((_, i) => {
                  const e = edges[i];
                  const color = getEdgeColor(e.type);
                  return (
                    <marker
                      key={`arrow-${i}`}
                      id={`arrow-${i}`}
                      viewBox="0 0 10 10"
                      refX="8"
                      refY="5"
                      markerWidth="6"
                      markerHeight="6"
                      orient="auto-start-reverse"
                    >
                      <path d="M 0 0 L 10 5 L 0 10 z" fill={color} opacity={0.7} />
                    </marker>
                  );
                })}
              </defs>

              {/* Render edges */}
              {(() => {
                let globalEdgeIdx = 0;
                const elements: React.ReactNode[] = [];

                edgeGroups.forEach((groupEdges, key) => {
                  const [sourceType, targetType] = key.split(':');
                  const src = nodeByType.get(sourceType);
                  const tgt = nodeByType.get(targetType);
                  if (!src || !tgt) {
                    globalEdgeIdx += groupEdges.length;
                    return;
                  }

                  const srcRadius = getRadius(src.count);
                  const tgtRadius = getRadius(tgt.count);

                  // Self-loop
                  const isSelfLoop = sourceType === targetType;

                  groupEdges.forEach((edge, groupIdx) => {
                    const edgeIdx = edges.indexOf(edge);
                    const isHovered = hoveredEdge === edgeIdx;
                    const color = getEdgeColor(edge.type);
                    const opacity = hoveredEdge !== null ? (isHovered ? 1 : 0.2) : 0.6;

                    if (isSelfLoop) {
                      // Self-loop: draw a small loop above the node
                      const loopOffset = 30 + groupIdx * 15;
                      const loopPath = `M ${src.x - 8} ${src.y - srcRadius}
                        C ${src.x - loopOffset} ${src.y - srcRadius - loopOffset}
                          ${src.x + loopOffset} ${src.y - srcRadius - loopOffset}
                          ${src.x + 8} ${src.y - srcRadius}`;

                      elements.push(
                        <g key={`edge-${edgeIdx}`}>
                          <path
                            d={loopPath}
                            fill="none"
                            stroke={color}
                            strokeWidth={isHovered ? 2.5 : 1.5}
                            opacity={opacity}
                            markerEnd={`url(#arrow-${edgeIdx})`}
                            onMouseEnter={() => setHoveredEdge(edgeIdx)}
                            onMouseLeave={() => setHoveredEdge(null)}
                            style={{ cursor: 'pointer' }}
                          />
                          {/* Wider invisible hit area */}
                          <path
                            d={loopPath}
                            fill="none"
                            stroke="transparent"
                            strokeWidth={12}
                            onMouseEnter={() => setHoveredEdge(edgeIdx)}
                            onMouseLeave={() => setHoveredEdge(null)}
                            style={{ cursor: 'pointer' }}
                          />
                          {isHovered && (
                            <text
                              x={src.x}
                              y={src.y - srcRadius - loopOffset - 5}
                              textAnchor="middle"
                              fill="#f1f5f9"
                              fontSize="11"
                              fontWeight="600"
                              className="pointer-events-none"
                            >
                              {edge.type} ({formatCount(edge.count)})
                            </text>
                          )}
                        </g>,
                      );
                    } else {
                      // Compute offset for edge within group to prevent overlap
                      const baseOffset = groupEdges.length > 1
                        ? (groupIdx - (groupEdges.length - 1) / 2) * 25
                        : 0;

                      // Shorten the line to stop at node boundary
                      const dx = tgt.x - src.x;
                      const dy = tgt.y - src.y;
                      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
                      const ux = dx / dist;
                      const uy = dy / dist;

                      const startX = src.x + ux * (srcRadius + 2);
                      const startY = src.y + uy * (srcRadius + 2);
                      const endX = tgt.x - ux * (tgtRadius + 6);
                      const endY = tgt.y - uy * (tgtRadius + 6);

                      const pathD = curvedPath(startX, startY, endX, endY, baseOffset);
                      const mid = curvedMidpoint(startX, startY, endX, endY, baseOffset);

                      elements.push(
                        <g key={`edge-${edgeIdx}`}>
                          <path
                            d={pathD}
                            fill="none"
                            stroke={color}
                            strokeWidth={isHovered ? 2.5 : 1.5}
                            opacity={opacity}
                            markerEnd={`url(#arrow-${edgeIdx})`}
                            onMouseEnter={() => setHoveredEdge(edgeIdx)}
                            onMouseLeave={() => setHoveredEdge(null)}
                            style={{ cursor: 'pointer' }}
                          />
                          {/* Wider invisible hit area */}
                          <path
                            d={pathD}
                            fill="none"
                            stroke="transparent"
                            strokeWidth={12}
                            onMouseEnter={() => setHoveredEdge(edgeIdx)}
                            onMouseLeave={() => setHoveredEdge(null)}
                            style={{ cursor: 'pointer' }}
                          />
                          {isHovered && (
                            <>
                              <rect
                                x={mid.x - 50}
                                y={mid.y - 10}
                                width={100}
                                height={20}
                                rx={4}
                                fill="#0f172a"
                                fillOpacity={0.9}
                                stroke={color}
                                strokeWidth={0.5}
                                className="pointer-events-none"
                              />
                              <text
                                x={mid.x}
                                y={mid.y + 4}
                                textAnchor="middle"
                                fill="#f1f5f9"
                                fontSize="10"
                                fontWeight="600"
                                className="pointer-events-none"
                              >
                                {edge.type} ({formatCount(edge.count)})
                              </text>
                            </>
                          )}
                        </g>,
                      );
                    }
                    globalEdgeIdx++;
                  });
                });

                return elements;
              })()}

              {/* Render nodes */}
              {nodes.map(node => {
                const r = getRadius(node.count);
                const color = getNodeColor(node.type);
                const isHovered = hoveredNode === node.type;

                return (
                  <g
                    key={node.type}
                    onMouseEnter={() => setHoveredNode(node.type)}
                    onMouseLeave={() => setHoveredNode(null)}
                    style={{ cursor: 'default' }}
                  >
                    {/* Glow when hovered */}
                    {isHovered && (
                      <circle
                        cx={node.x}
                        cy={node.y}
                        r={r + 6}
                        fill="none"
                        stroke={color}
                        strokeWidth={2}
                        opacity={0.4}
                      />
                    )}
                    {/* Node circle */}
                    <circle
                      cx={node.x}
                      cy={node.y}
                      r={r}
                      fill={color}
                      fillOpacity={0.2}
                      stroke={color}
                      strokeWidth={isHovered ? 2 : 1.5}
                      opacity={hoveredNode !== null && !isHovered ? 0.4 : 0.9}
                    />
                    {/* Type label */}
                    <text
                      x={node.x}
                      y={node.y - 3}
                      textAnchor="middle"
                      dominantBaseline="auto"
                      fill="#f1f5f9"
                      fontSize="11"
                      fontWeight="600"
                      opacity={hoveredNode !== null && !isHovered ? 0.3 : 1}
                      className="pointer-events-none select-none"
                    >
                      {node.type}
                    </text>
                    {/* Count label */}
                    <text
                      x={node.x}
                      y={node.y + 11}
                      textAnchor="middle"
                      dominantBaseline="auto"
                      fill="#94a3b8"
                      fontSize="9"
                      opacity={hoveredNode !== null && !isHovered ? 0.3 : 0.8}
                      className="pointer-events-none select-none"
                    >
                      {formatCount(node.count)}
                    </text>
                  </g>
                );
              })}
            </svg>
          )}

          {!loading && !error && nodes.length === 0 && (
            <div className="flex items-center justify-center h-64">
              <p className="text-slate-500 text-sm">No schema data available</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-3 border-t border-white/10 bg-slate-900/50 relative z-10">
          <div className="flex flex-wrap gap-3">
            {nodes.slice(0, 8).map(n => (
              <div key={n.type} className="flex items-center gap-1.5">
                <div
                  className="w-2.5 h-2.5 rounded-full"
                  style={{ backgroundColor: getNodeColor(n.type), opacity: 0.8 }}
                />
                <span className="text-[10px] text-slate-400">{n.type}</span>
              </div>
            ))}
            {nodes.length > 8 && (
              <span className="text-[10px] text-slate-500">+{nodes.length - 8} more</span>
            )}
          </div>
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-slate-300 hover:text-white bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg transition-all"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { X, ChevronUp, ChevronDown, ArrowUpDown, GripHorizontal } from 'lucide-react';
import { TableVirtuoso } from 'react-virtuoso';
import { useAppState } from '../hooks/useAppState';
import type { GraphNode, GraphRelationship } from '../core/graph/types';

type Tab = 'nodes' | 'edges';
type SortDirection = 'asc' | 'desc';

// Node sort keys
type NodeSortKey = 'name' | 'type' | 'filePath' | 'startLine' | 'community';

// Edge sort keys
type EdgeSortKey = 'source' | 'target' | 'type' | 'confidence';

interface DataExplorerProps {
  onFocusNode: (nodeId: string) => void;
}

const MIN_HEIGHT = 200;
const MAX_HEIGHT_VH = 0.6; // 60vh
const DEFAULT_HEIGHT = 300;

export const DataExplorer = ({ onFocusNode }: DataExplorerProps) => {
  const { graph, isDataExplorerOpen, setDataExplorerOpen } = useAppState();

  const [activeTab, setActiveTab] = useState<Tab>('nodes');
  const [height, setHeight] = useState(DEFAULT_HEIGHT);

  // Node sorting/filtering
  const [nodeSortKey, setNodeSortKey] = useState<NodeSortKey>('name');
  const [nodeSortDir, setNodeSortDir] = useState<SortDirection>('asc');
  const [nodeTypeFilter, setNodeTypeFilter] = useState<string>('all');

  // Edge sorting/filtering
  const [edgeSortKey, setEdgeSortKey] = useState<EdgeSortKey>('source');
  const [edgeSortDir, setEdgeSortDir] = useState<SortDirection>('asc');
  const [edgeTypeFilter, setEdgeTypeFilter] = useState<string>('all');

  // Resize drag state
  const isDragging = useRef(false);
  const dragStartY = useRef(0);
  const dragStartHeight = useRef(DEFAULT_HEIGHT);

  // Build a quick nodeId -> name lookup for edges tab
  const nodeNameMap = useMemo(() => {
    if (!graph) return new Map<string, string>();
    const map = new Map<string, string>();
    for (const n of graph.nodes) {
      map.set(n.id, n.properties.name);
    }
    return map;
  }, [graph]);

  // Build communityMap: nodeId -> community label
  const communityMap = useMemo(() => {
    if (!graph) return new Map<string, string>();
    const map = new Map<string, string>();
    const communityNodes = new Map<string, string>();
    for (const n of graph.nodes) {
      if (n.label === 'Community') {
        communityNodes.set(n.id, n.properties.heuristicLabel || n.properties.name);
      }
    }
    for (const rel of graph.relationships) {
      if (rel.type === 'MEMBER_OF') {
        const communityName = communityNodes.get(rel.targetId);
        if (communityName) {
          map.set(rel.sourceId, communityName);
        }
      }
    }
    return map;
  }, [graph]);

  // Available node types for filter dropdown
  const nodeTypes = useMemo(() => {
    if (!graph) return [];
    const types = new Set<string>();
    for (const n of graph.nodes) types.add(n.label);
    return Array.from(types).sort();
  }, [graph]);

  // Available edge types for filter dropdown
  const edgeTypes = useMemo(() => {
    if (!graph) return [];
    const types = new Set<string>();
    for (const r of graph.relationships) types.add(r.type);
    return Array.from(types).sort();
  }, [graph]);

  // Filtered + sorted nodes
  const sortedNodes = useMemo(() => {
    if (!graph) return [];
    let filtered = graph.nodes;
    if (nodeTypeFilter !== 'all') {
      filtered = filtered.filter(n => n.label === nodeTypeFilter);
    }

    const dir = nodeSortDir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      switch (nodeSortKey) {
        case 'name':
          return dir * a.properties.name.localeCompare(b.properties.name);
        case 'type':
          return dir * a.label.localeCompare(b.label);
        case 'filePath':
          return dir * (a.properties.filePath || '').localeCompare(b.properties.filePath || '');
        case 'startLine':
          return dir * ((a.properties.startLine ?? 0) - (b.properties.startLine ?? 0));
        case 'community': {
          const ca = communityMap.get(a.id) || '';
          const cb = communityMap.get(b.id) || '';
          return dir * ca.localeCompare(cb);
        }
        default:
          return 0;
      }
    });
  }, [graph, nodeTypeFilter, nodeSortKey, nodeSortDir, communityMap]);

  // Filtered + sorted edges
  const sortedEdges = useMemo(() => {
    if (!graph) return [];
    let filtered = graph.relationships;
    if (edgeTypeFilter !== 'all') {
      filtered = filtered.filter(r => r.type === edgeTypeFilter);
    }

    const dir = edgeSortDir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      switch (edgeSortKey) {
        case 'source': {
          const sa = nodeNameMap.get(a.sourceId) || a.sourceId;
          const sb = nodeNameMap.get(b.sourceId) || b.sourceId;
          return dir * sa.localeCompare(sb);
        }
        case 'target': {
          const ta = nodeNameMap.get(a.targetId) || a.targetId;
          const tb = nodeNameMap.get(b.targetId) || b.targetId;
          return dir * ta.localeCompare(tb);
        }
        case 'type':
          return dir * a.type.localeCompare(b.type);
        case 'confidence':
          return dir * (a.confidence - b.confidence);
        default:
          return 0;
      }
    });
  }, [graph, edgeTypeFilter, edgeSortKey, edgeSortDir, nodeNameMap]);

  // Sort toggle handlers
  const handleNodeSort = useCallback((key: NodeSortKey) => {
    setNodeSortKey(prev => {
      if (prev === key) {
        setNodeSortDir(d => d === 'asc' ? 'desc' : 'asc');
        return key;
      }
      setNodeSortDir('asc');
      return key;
    });
  }, []);

  const handleEdgeSort = useCallback((key: EdgeSortKey) => {
    setEdgeSortKey(prev => {
      if (prev === key) {
        setEdgeSortDir(d => d === 'asc' ? 'desc' : 'asc');
        return key;
      }
      setEdgeSortDir('asc');
      return key;
    });
  }, []);

  // Resize handlers
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    isDragging.current = true;
    dragStartY.current = e.clientY;
    dragStartHeight.current = height;
    e.preventDefault();
  }, [height]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return;
      const delta = dragStartY.current - e.clientY;
      const maxHeight = window.innerHeight * MAX_HEIGHT_VH;
      const newHeight = Math.min(maxHeight, Math.max(MIN_HEIGHT, dragStartHeight.current + delta));
      setHeight(newHeight);
    };

    const handleMouseUp = () => {
      isDragging.current = false;
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, []);

  // Sort indicator
  const SortIcon = ({ sortKey, currentKey, direction }: { sortKey: string; currentKey: string; direction: SortDirection }) => {
    if (sortKey !== currentKey) {
      return <ArrowUpDown className="w-3 h-3 ml-1 opacity-30" />;
    }
    return direction === 'asc'
      ? <ChevronUp className="w-3 h-3 ml-1 text-accent" />
      : <ChevronDown className="w-3 h-3 ml-1 text-accent" />;
  };

  if (!isDataExplorerOpen) return null;

  const thClass = 'px-3 py-2 text-left text-[11px] font-semibold text-text-muted uppercase tracking-wider cursor-pointer hover:text-text-primary transition-colors select-none whitespace-nowrap bg-deep';
  const tdClass = 'px-3 py-1.5 text-[12px] font-mono text-text-secondary whitespace-nowrap';

  return (
    <div
      className="flex-shrink-0 border-t border-border-subtle bg-surface flex flex-col"
      style={{ height }}
    >
      {/* Drag handle */}
      <div
        onMouseDown={handleMouseDown}
        className="flex items-center justify-center h-2 cursor-row-resize hover:bg-accent/10 transition-colors group"
      >
        <GripHorizontal className="w-4 h-3 text-text-muted group-hover:text-accent transition-colors" />
      </div>

      {/* Header bar */}
      <div className="flex items-center justify-between px-4 py-1.5 border-b border-border-subtle bg-deep">
        <div className="flex items-center gap-3">
          {/* Tabs */}
          <button
            onClick={() => setActiveTab('nodes')}
            className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
              activeTab === 'nodes'
                ? 'bg-accent/20 text-accent border border-accent/30'
                : 'text-text-secondary hover:text-text-primary hover:bg-hover'
            }`}
          >
            Nodes {graph ? `(${nodeTypeFilter === 'all' ? graph.nodes.length : sortedNodes.length})` : ''}
          </button>
          <button
            onClick={() => setActiveTab('edges')}
            className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
              activeTab === 'edges'
                ? 'bg-accent/20 text-accent border border-accent/30'
                : 'text-text-secondary hover:text-text-primary hover:bg-hover'
            }`}
          >
            Edges {graph ? `(${edgeTypeFilter === 'all' ? graph.relationships.length : sortedEdges.length})` : ''}
          </button>

          {/* Type filter */}
          <div className="h-4 w-px bg-border-subtle" />
          {activeTab === 'nodes' ? (
            <select
              value={nodeTypeFilter}
              onChange={e => setNodeTypeFilter(e.target.value)}
              className="bg-elevated border border-border-subtle rounded px-2 py-0.5 text-xs text-text-secondary focus:outline-none focus:border-accent/50 cursor-pointer"
            >
              <option value="all">All types</option>
              {nodeTypes.map(t => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          ) : (
            <select
              value={edgeTypeFilter}
              onChange={e => setEdgeTypeFilter(e.target.value)}
              className="bg-elevated border border-border-subtle rounded px-2 py-0.5 text-xs text-text-secondary focus:outline-none focus:border-accent/50 cursor-pointer"
            >
              <option value="all">All types</option>
              {edgeTypes.map(t => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          )}
        </div>

        {/* Close button */}
        <button
          onClick={() => setDataExplorerOpen(false)}
          className="w-6 h-6 flex items-center justify-center rounded text-text-muted hover:text-text-primary hover:bg-hover transition-colors"
          title="Close Data Explorer"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Table content */}
      <div className="flex-1 overflow-hidden">
        {activeTab === 'nodes' ? (
          <TableVirtuoso
            style={{ height: '100%' }}
            data={sortedNodes}
            fixedHeaderContent={() => (
              <tr>
                <th className={thClass} style={{ width: '25%' }} onClick={() => handleNodeSort('name')}>
                  <span className="flex items-center">
                    Name
                    <SortIcon sortKey="name" currentKey={nodeSortKey} direction={nodeSortDir} />
                  </span>
                </th>
                <th className={thClass} style={{ width: '12%' }} onClick={() => handleNodeSort('type')}>
                  <span className="flex items-center">
                    Type
                    <SortIcon sortKey="type" currentKey={nodeSortKey} direction={nodeSortDir} />
                  </span>
                </th>
                <th className={thClass} style={{ width: '35%' }} onClick={() => handleNodeSort('filePath')}>
                  <span className="flex items-center">
                    File Path
                    <SortIcon sortKey="filePath" currentKey={nodeSortKey} direction={nodeSortDir} />
                  </span>
                </th>
                <th className={thClass} style={{ width: '10%' }} onClick={() => handleNodeSort('startLine')}>
                  <span className="flex items-center">
                    Line
                    <SortIcon sortKey="startLine" currentKey={nodeSortKey} direction={nodeSortDir} />
                  </span>
                </th>
                <th className={thClass} style={{ width: '18%' }} onClick={() => handleNodeSort('community')}>
                  <span className="flex items-center">
                    Community
                    <SortIcon sortKey="community" currentKey={nodeSortKey} direction={nodeSortDir} />
                  </span>
                </th>
              </tr>
            )}
            itemContent={(_index: number, node: GraphNode) => (
              <>
                <td
                  className={`${tdClass} text-text-primary cursor-pointer hover:text-accent transition-colors`}
                  onClick={() => onFocusNode(node.id)}
                  title={node.properties.name}
                >
                  <span className="block max-w-[300px] truncate">{node.properties.name}</span>
                </td>
                <td className={tdClass}>
                  <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${getNodeLabelColor(node.label)}`}>
                    {node.label}
                  </span>
                </td>
                <td className={tdClass} title={node.properties.filePath}>
                  <span className="block max-w-[400px] truncate text-text-muted">{node.properties.filePath}</span>
                </td>
                <td className={`${tdClass} text-text-muted`}>
                  {node.properties.startLine ?? '-'}
                </td>
                <td className={tdClass} title={communityMap.get(node.id) || ''}>
                  <span className="block max-w-[200px] truncate text-text-muted">
                    {communityMap.get(node.id) || '-'}
                  </span>
                </td>
              </>
            )}
          />
        ) : (
          <TableVirtuoso
            style={{ height: '100%' }}
            data={sortedEdges}
            fixedHeaderContent={() => (
              <tr>
                <th className={thClass} style={{ width: '30%' }} onClick={() => handleEdgeSort('source')}>
                  <span className="flex items-center">
                    Source
                    <SortIcon sortKey="source" currentKey={edgeSortKey} direction={edgeSortDir} />
                  </span>
                </th>
                <th className={thClass} style={{ width: '30%' }} onClick={() => handleEdgeSort('target')}>
                  <span className="flex items-center">
                    Target
                    <SortIcon sortKey="target" currentKey={edgeSortKey} direction={edgeSortDir} />
                  </span>
                </th>
                <th className={thClass} style={{ width: '20%' }} onClick={() => handleEdgeSort('type')}>
                  <span className="flex items-center">
                    Type
                    <SortIcon sortKey="type" currentKey={edgeSortKey} direction={edgeSortDir} />
                  </span>
                </th>
                <th className={thClass} style={{ width: '20%' }} onClick={() => handleEdgeSort('confidence')}>
                  <span className="flex items-center">
                    Confidence
                    <SortIcon sortKey="confidence" currentKey={edgeSortKey} direction={edgeSortDir} />
                  </span>
                </th>
              </tr>
            )}
            itemContent={(_index: number, edge: GraphRelationship) => {
              const sourceName = nodeNameMap.get(edge.sourceId) || edge.sourceId;
              const targetName = nodeNameMap.get(edge.targetId) || edge.targetId;
              return (
                <>
                  <td
                    className={`${tdClass} text-text-primary cursor-pointer hover:text-accent transition-colors`}
                    onClick={() => onFocusNode(edge.sourceId)}
                    title={sourceName}
                  >
                    <span className="block max-w-[300px] truncate">{sourceName}</span>
                  </td>
                  <td
                    className={`${tdClass} text-text-primary cursor-pointer hover:text-accent transition-colors`}
                    onClick={() => onFocusNode(edge.targetId)}
                    title={targetName}
                  >
                    <span className="block max-w-[300px] truncate">{targetName}</span>
                  </td>
                  <td className={tdClass}>
                    <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${getEdgeTypeColor(edge.type)}`}>
                      {edge.type}
                    </span>
                  </td>
                  <td className={tdClass}>
                    <div className="flex items-center gap-2">
                      <div className="w-16 h-1.5 bg-elevated rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full ${getConfidenceColor(edge.confidence)}`}
                          style={{ width: `${Math.round(edge.confidence * 100)}%` }}
                        />
                      </div>
                      <span className="text-text-muted">{(edge.confidence * 100).toFixed(0)}%</span>
                    </div>
                  </td>
                </>
              );
            }}
          />
        )}
      </div>
    </div>
  );
};

// Color helpers matching the existing theme
function getNodeLabelColor(label: string): string {
  switch (label) {
    case 'Function': return 'bg-node-function/20 text-node-function';
    case 'Class': return 'bg-node-class/20 text-node-class';
    case 'Method': return 'bg-blue-500/20 text-blue-400';
    case 'File': return 'bg-node-file/20 text-node-file';
    case 'Module': return 'bg-node-module/20 text-node-module';
    case 'Variable': return 'bg-node-variable/20 text-node-variable';
    case 'Interface': return 'bg-node-interface/20 text-node-interface';
    case 'Enum': return 'bg-node-enum/20 text-node-enum';
    case 'Import': return 'bg-node-import/20 text-node-import';
    case 'Type': return 'bg-teal-500/20 text-teal-400';
    case 'Community': return 'bg-violet-500/20 text-violet-400';
    case 'Process': return 'bg-amber-500/20 text-amber-400';
    default: return 'bg-white/10 text-text-secondary';
  }
}

function getEdgeTypeColor(type: string): string {
  switch (type) {
    case 'CALLS': return 'bg-emerald-500/20 text-emerald-400';
    case 'IMPORTS': return 'bg-cyan-500/20 text-cyan-400';
    case 'CONTAINS': return 'bg-gray-500/20 text-gray-400';
    case 'INHERITS': return 'bg-violet-500/20 text-violet-400';
    case 'IMPLEMENTS': return 'bg-purple-500/20 text-purple-400';
    case 'USES': return 'bg-yellow-500/20 text-yellow-400';
    case 'DEFINES': return 'bg-blue-500/20 text-blue-400';
    case 'OVERRIDES': return 'bg-orange-500/20 text-orange-400';
    case 'EXTENDS': return 'bg-pink-500/20 text-pink-400';
    case 'HAS_METHOD': return 'bg-indigo-500/20 text-indigo-400';
    case 'MEMBER_OF': return 'bg-violet-500/20 text-violet-400';
    case 'STEP_IN_PROCESS': return 'bg-amber-500/20 text-amber-400';
    default: return 'bg-white/10 text-text-secondary';
  }
}

function getConfidenceColor(confidence: number): string {
  if (confidence >= 0.9) return 'bg-emerald-500';
  if (confidence >= 0.7) return 'bg-yellow-500';
  if (confidence >= 0.5) return 'bg-orange-500';
  return 'bg-red-500';
}

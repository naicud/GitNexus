import React from 'react';
import { Palette, RotateCcw, X } from 'lucide-react';
import { useStyleConfig } from '../hooks/useStyleConfig';
import { FILTERABLE_LABELS, ALL_EDGE_TYPES, NODE_COLORS, NODE_SIZES, EDGE_INFO } from '../lib/constants';
import type { NodeLabel } from '../core/graph/types';
import type { EdgeType } from '../lib/constants';

interface StylingPanelProps {
  isOpen: boolean;
  onClose: () => void;
}

export const StylingPanel: React.FC<StylingPanelProps> = ({ isOpen, onClose }) => {
  const { getNodeColor, getNodeSize, getEdgeColor, setNodeColor, setNodeSize, setEdgeColor, resetAll } = useStyleConfig();

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-surface border border-border-subtle rounded-xl shadow-2xl w-[480px] max-h-[80vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle">
          <div className="flex items-center gap-2">
            <Palette className="w-5 h-5 text-accent" />
            <h2 className="text-lg font-semibold text-text-primary">Graph Styling</h2>
          </div>
          <button
            onClick={onClose}
            className="text-text-muted hover:text-text-primary transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Node Types */}
        <div className="p-5">
          <h3 className="text-sm font-semibold text-text-secondary mb-3 uppercase tracking-wider">
            Node Types
          </h3>
          <div className="space-y-3">
            {FILTERABLE_LABELS.map((type: NodeLabel) => (
              <div key={type} className="flex items-center gap-3">
                <input
                  type="color"
                  value={getNodeColor(type)}
                  onChange={e => setNodeColor(type, e.target.value)}
                  className="w-8 h-8 rounded cursor-pointer border border-border-subtle bg-transparent"
                  title={`Color for ${type}`}
                />
                <span className="text-sm text-text-primary w-24 font-medium">{type}</span>
                <input
                  type="range"
                  min="1"
                  max="30"
                  value={getNodeSize(type)}
                  onChange={e => setNodeSize(type, parseInt(e.target.value))}
                  className="flex-1 accent-accent"
                />
                <span className="text-xs text-text-muted w-8 text-right tabular-nums">
                  {getNodeSize(type)}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Edge Types */}
        <div className="p-5 border-t border-border-subtle">
          <h3 className="text-sm font-semibold text-text-secondary mb-3 uppercase tracking-wider">
            Edge Types
          </h3>
          <div className="space-y-3">
            {ALL_EDGE_TYPES.map((type: EdgeType) => (
              <div key={type} className="flex items-center gap-3">
                <input
                  type="color"
                  value={getEdgeColor(type)}
                  onChange={e => setEdgeColor(type, e.target.value)}
                  className="w-8 h-8 rounded cursor-pointer border border-border-subtle bg-transparent"
                  title={`Color for ${type}`}
                />
                <span className="text-sm text-text-primary font-medium">
                  {EDGE_INFO[type]?.label || type}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Reset */}
        <div className="p-5 border-t border-border-subtle">
          <button
            onClick={resetAll}
            className="flex items-center gap-2 px-4 py-2 text-sm text-text-secondary hover:text-text-primary bg-elevated border border-border-subtle rounded-lg hover:bg-hover transition-colors"
          >
            <RotateCcw className="w-4 h-4" />
            Reset to Defaults
          </button>
        </div>
      </div>
    </div>
  );
};

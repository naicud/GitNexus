import { useState, useCallback, useEffect } from 'react';
import { NODE_COLORS, NODE_SIZES, EDGE_INFO } from '../lib/constants';
import type { NodeLabel } from '../core/graph/types';
import type { EdgeType } from '../lib/constants';

const STORAGE_KEY = 'gitnexus-style-config';

export interface NodeStyleOverride {
  color?: string;
  size?: number;
  labelVisible?: boolean;
}

export interface EdgeStyleOverride {
  color?: string;
}

interface StyleConfig {
  nodeOverrides: Partial<Record<NodeLabel, NodeStyleOverride>>;
  edgeOverrides: Partial<Record<EdgeType, EdgeStyleOverride>>;
}

const loadConfig = (): StyleConfig => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return JSON.parse(stored);
  } catch { /* ignore parse errors */ }
  return { nodeOverrides: {}, edgeOverrides: {} };
};

const saveConfig = (config: StyleConfig) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch { /* ignore storage errors */ }
};

export function useStyleConfig() {
  const [config, setConfig] = useState<StyleConfig>(loadConfig);

  // Save to localStorage on change
  useEffect(() => {
    saveConfig(config);
  }, [config]);

  const getNodeColor = useCallback((type: NodeLabel): string => {
    return config.nodeOverrides[type]?.color || NODE_COLORS[type] || '#6b7280';
  }, [config]);

  const getNodeSize = useCallback((type: NodeLabel): number => {
    return config.nodeOverrides[type]?.size ?? NODE_SIZES[type] ?? 4;
  }, [config]);

  const getEdgeColor = useCallback((type: EdgeType): string => {
    return config.edgeOverrides[type]?.color || EDGE_INFO[type]?.color || '#4a4a5a';
  }, [config]);

  const setNodeColor = useCallback((type: NodeLabel, color: string) => {
    setConfig(prev => ({
      ...prev,
      nodeOverrides: { ...prev.nodeOverrides, [type]: { ...prev.nodeOverrides[type], color } },
    }));
  }, []);

  const setNodeSize = useCallback((type: NodeLabel, size: number) => {
    setConfig(prev => ({
      ...prev,
      nodeOverrides: { ...prev.nodeOverrides, [type]: { ...prev.nodeOverrides[type], size } },
    }));
  }, []);

  const setEdgeColor = useCallback((type: EdgeType, color: string) => {
    setConfig(prev => ({
      ...prev,
      edgeOverrides: { ...prev.edgeOverrides, [type]: { ...prev.edgeOverrides[type], color } },
    }));
  }, []);

  const resetAll = useCallback(() => {
    setConfig({ nodeOverrides: {}, edgeOverrides: {} });
  }, []);

  return {
    config,
    getNodeColor,
    getNodeSize,
    getEdgeColor,
    setNodeColor,
    setNodeSize,
    setEdgeColor,
    resetAll,
  };
}

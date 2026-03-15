import { useEffect, useRef } from 'react';
import { Search, Network, Code2, X, Maximize2, Play, Pause, Minimize2 } from 'lucide-react';

interface ContextMenuProps {
  x: number;
  y: number;
  nodeId: string | null;
  nodeName?: string;
  nodeType?: string;
  // Callbacks
  onExploreNeighbors: (nodeId: string, depth: number) => void;
  onOpenNeighborPanel: (nodeId: string) => void;
  onShowInCode: (nodeId: string) => void;
  onDismissNode: (nodeId: string) => void;
  onResetZoom: () => void;
  onToggleLayout: () => void;
  onCollapseAll: () => void;
  onClose: () => void;
  // State
  isLayoutRunning: boolean;
  hasExpandedGroups: boolean;
  graphViewMode: 'full' | 'summary';
}

const MenuItem: React.FC<{
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}> = ({ icon, label, onClick, danger }) => (
  <button
    onClick={onClick}
    className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-sm transition-colors hover:bg-hover ${
      danger ? 'text-red-400' : 'text-text-primary'
    }`}
  >
    <span className={`w-4 h-4 flex-shrink-0 ${danger ? 'text-red-400' : 'text-text-muted'}`}>
      {icon}
    </span>
    {label}
  </button>
);

const Divider: React.FC = () => <div className="h-px bg-border-subtle my-1" />;

export const ContextMenu: React.FC<ContextMenuProps> = ({
  x,
  y,
  nodeId,
  onExploreNeighbors,
  onOpenNeighborPanel,
  onShowInCode,
  onDismissNode,
  onResetZoom,
  onToggleLayout,
  onCollapseAll,
  onClose,
  isLayoutRunning,
  hasExpandedGroups,
  graphViewMode,
}) => {
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  // Adjust position to stay on screen
  const menuWidth = 220;
  const menuHeight = nodeId ? 200 : 120;
  const adjustedX = x + menuWidth > window.innerWidth ? x - menuWidth : x;
  const adjustedY = y + menuHeight > window.innerHeight ? y - menuHeight : y;

  return (
    <div
      ref={menuRef}
      className="fixed z-50 bg-elevated border border-border-subtle rounded-lg shadow-xl py-1 min-w-[200px]"
      style={{ left: adjustedX, top: adjustedY }}
    >
      {nodeId ? (
        <>
          <MenuItem
            icon={<Search className="w-4 h-4" />}
            label="Explore neighbors..."
            onClick={() => { onOpenNeighborPanel(nodeId); onClose(); }}
          />
          <MenuItem
            icon={<Network className="w-4 h-4" />}
            label="Explore 1 hop"
            onClick={() => { onExploreNeighbors(nodeId, 1); onClose(); }}
          />
          <MenuItem
            icon={<Network className="w-4 h-4" />}
            label="Explore 2 hops"
            onClick={() => { onExploreNeighbors(nodeId, 2); onClose(); }}
          />
          <Divider />
          <MenuItem
            icon={<Code2 className="w-4 h-4" />}
            label="Show in code"
            onClick={() => { onShowInCode(nodeId); onClose(); }}
          />
          <Divider />
          <MenuItem
            icon={<X className="w-4 h-4" />}
            label="Dismiss"
            onClick={() => { onDismissNode(nodeId); onClose(); }}
            danger
          />
        </>
      ) : (
        <>
          <MenuItem
            icon={<Maximize2 className="w-4 h-4" />}
            label="Reset zoom"
            onClick={() => { onResetZoom(); onClose(); }}
          />
          <MenuItem
            icon={isLayoutRunning ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
            label={isLayoutRunning ? 'Stop layout' : 'Run layout'}
            onClick={() => { onToggleLayout(); onClose(); }}
          />
          {graphViewMode === 'summary' && hasExpandedGroups && (
            <MenuItem
              icon={<Minimize2 className="w-4 h-4" />}
              label="Collapse all groups"
              onClick={() => { onCollapseAll(); onClose(); }}
            />
          )}
        </>
      )}
    </div>
  );
};

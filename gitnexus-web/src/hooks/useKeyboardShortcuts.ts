import { useEffect } from 'react';

interface KeyboardShortcutActions {
  onDeselect: () => void;
  onFitToScreen: () => void;
  onToggleLayout: () => void;
  onOpenNeighborPanel: () => void;
  onToggleDataExplorer: () => void;
  onDismissNode: () => void;
}

export function useKeyboardShortcuts(actions: KeyboardShortcutActions) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't capture when typing in inputs
      const target = e.target as HTMLElement;
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable
      ) {
        return;
      }

      switch (e.key) {
        case 'Escape':
          e.preventDefault();
          actions.onDeselect();
          break;
        case 'f':
        case 'F':
          if (!e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault();
            actions.onFitToScreen();
          }
          break;
        case 'l':
        case 'L':
          if (!e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault();
            actions.onToggleLayout();
          }
          break;
        case 'n':
        case 'N':
          if (!e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault();
            actions.onOpenNeighborPanel();
          }
          break;
        case 'd':
        case 'D':
          if (e.ctrlKey && e.shiftKey) {
            e.preventDefault();
            actions.onToggleDataExplorer();
          }
          break;
        case 'Delete':
        case 'Backspace':
          if (!e.ctrlKey && !e.metaKey) {
            e.preventDefault();
            actions.onDismissNode();
          }
          break;
      }
    };

    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [actions]);
}

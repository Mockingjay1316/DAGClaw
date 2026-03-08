import { useEffect, useRef } from 'react';
import { useOrchestratorStore } from '../stores/orchestratorStore.ts';
import { useWebSocket } from '../hooks/useWebSocket.ts';
import { TaskTreeNode } from './TaskTreeNode.tsx';

export function TaskTreeView() {
  const selectedRootId = useOrchestratorStore((state) => state.selectedRootId);
  const { subscribe, unsubscribe } = useWebSocket();
  const prevRootIdRef = useRef<string | null>(null);

  useEffect(() => {
    // Unsubscribe from previous root
    if (prevRootIdRef.current && prevRootIdRef.current !== selectedRootId) {
      unsubscribe([prevRootIdRef.current]);
    }

    // Subscribe to new root
    if (selectedRootId) {
      subscribe([selectedRootId]);
    }

    prevRootIdRef.current = selectedRootId;

    return () => {
      if (selectedRootId) {
        unsubscribe([selectedRootId]);
      }
    };
  }, [selectedRootId, subscribe, unsubscribe]);

  if (!selectedRootId) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-500">
        Select a task to view its tree
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-4">
      <TaskTreeNode taskId={selectedRootId} depth={0} />
    </div>
  );
}

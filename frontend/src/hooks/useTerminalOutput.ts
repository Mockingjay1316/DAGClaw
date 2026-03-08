import { useEffect } from 'react';
import type { Terminal } from '@xterm/xterm';
import { onSubtaskOutput } from './useWebSocket.ts';

/**
 * Connects WebSocket subtask_output messages to an xterm.js Terminal instance.
 * Streaming output goes directly to xterm.js, NOT through Zustand.
 */
export function useTerminalOutput(
  taskId: string,
  subtaskIndex: number,
  terminalRef: React.RefObject<Terminal | null>
) {
  useEffect(() => {
    const unsubscribe = onSubtaskOutput((msgTaskId, msgIndex, data) => {
      if (msgTaskId === taskId && msgIndex === subtaskIndex) {
        terminalRef.current?.write(data);
      }
    });

    return unsubscribe;
  }, [taskId, subtaskIndex, terminalRef]);
}

import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { useTerminalOutput } from '../hooks/useTerminalOutput.ts';
import { useOrchestratorStore } from '../stores/orchestratorStore.ts';

interface SubtaskTerminalProps {
  taskId: string;
  subtaskIndex: number;
  description: string;
}

const statusColors: Record<string, string> = {
  pending: 'bg-gray-500',
  running: 'bg-blue-500',
  completed: 'bg-green-500',
  failed: 'bg-red-500',
  skipped: 'bg-yellow-500',
};

export function SubtaskTerminal({ taskId, subtaskIndex, description }: SubtaskTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  const status = useOrchestratorStore((state) => {
    const taskStatuses = state.subtaskStatuses.get(taskId);
    return taskStatuses?.get(subtaskIndex) ?? 'pending';
  });

  // Wire WS output directly to terminal
  useTerminalOutput(taskId, subtaskIndex, terminalRef);

  useEffect(() => {
    if (!containerRef.current) return;

    const terminal = new Terminal({
      theme: {
        background: '#1a1a2e',
        foreground: '#e0e0e0',
        cursor: '#e0e0e0',
      },
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      scrollback: 5000,
      convertEol: true,
      disableStdin: true,
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(containerRef.current);
    fitAddon.fit();

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const handleResize = () => {
      fitAddon.fit();
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, []);

  return (
    <div className="border border-gray-700 rounded overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-1.5 bg-gray-800 text-sm">
        <span className="text-gray-300 font-mono">
          [{subtaskIndex}] {description}
        </span>
        <span
          className={`ml-auto px-2 py-0.5 rounded text-xs font-medium text-white ${statusColors[status] ?? 'bg-gray-500'}`}
        >
          {status}
        </span>
      </div>
      {/* Terminal container */}
      <div ref={containerRef} className="h-64" />
    </div>
  );
}

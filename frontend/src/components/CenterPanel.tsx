import { useState, useRef, useEffect, useCallback } from 'react';
import { TaskCreationBar } from './TaskCreationBar.tsx';
import { KanbanBoard } from './KanbanBoard.tsx';

export function CenterPanel() {
  const [topPanelPercent, setTopPanelPercent] = useState(30);
  const isDragging = useRef<boolean>(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  }, []);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const percent = ((e.clientY - rect.top) / rect.height) * 100;
      setTopPanelPercent(Math.min(Math.max(percent, 20), 60));
    };

    const onMouseUp = () => {
      if (!isDragging.current) return;
      isDragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  return (
    <div ref={containerRef} className="flex-1 flex flex-col min-w-[400px] overflow-hidden">
      {/* Top: Task submission panel */}
      <div className="flex-shrink-0 p-3 overflow-y-auto" style={{ maxHeight: `${topPanelPercent}%` }}>
        <div className="rounded-xl border border-gray-700 bg-gray-800/50 p-4">
          <TaskCreationBar />
        </div>
      </div>

      {/* Drag divider */}
      <div
        onMouseDown={handleDragStart}
        className="h-1.5 cursor-row-resize hover:bg-gray-600 active:bg-gray-500 transition-colors flex-shrink-0 z-10"
      />

      {/* Bottom: Kanban board */}
      <div className="flex-1 overflow-hidden min-h-0">
        <KanbanBoard />
      </div>
    </div>
  );
}

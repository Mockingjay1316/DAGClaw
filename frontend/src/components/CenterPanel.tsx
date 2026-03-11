import { TaskCreationBar } from './TaskCreationBar.tsx';
import { KanbanBoard } from './KanbanBoard.tsx';

export function CenterPanel() {
  return (
    <div className="flex-1 flex flex-col min-w-[400px] overflow-hidden">
      <TaskCreationBar />
      <KanbanBoard />
    </div>
  );
}

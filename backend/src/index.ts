import express from 'express';
import cors from 'cors';
import http from 'node:http';
import { WsServer } from './websocket/wsServer.ts';
import { TaskStore } from './taskStore.ts';
import { TaskScheduler } from './taskScheduler.ts';
import { ProjectStore } from './projectStore.ts';
import { restoreState } from './stateRestorer.ts';
import { createTasksRouter } from './routes/tasks.ts';
import { createStagesRouter } from './routes/stages.ts';
import { createRunsRouter } from './routes/runs.ts';
import { createProjectsRouter } from './routes/projects.ts';
import { authMiddleware } from './middleware/auth.ts';

const app = express();

// Fix #8: Security headers
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

// Fix #4: CORS origin restriction
const allowedOrigins = process.env.CLAW_CORS_ORIGINS
  ? process.env.CLAW_CORS_ORIGINS.split(',')
  : ['http://localhost:5173', 'http://localhost:3000'];

app.use(cors({
  origin: allowedOrigins,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: false,
}));

// Fix #6: Body size limit
app.use(express.json({ limit: '100kb' }));

// Fix #1: API key authentication
app.use('/api', authMiddleware);

const taskStore = new TaskStore();
const taskScheduler = new TaskScheduler();
const projectStore = new ProjectStore();
const server = http.createServer(app);
const wsServer = new WsServer(server);

// Wire up components
taskStore.setWsServer(wsServer);
taskStore.setScheduler(taskScheduler);
wsServer.setDataSource(taskStore);

// Scheduler starts tasks via taskStore
taskScheduler.onStart(async (taskId) => {
  await taskStore.startTask(taskId);
});

// Restore state from disk
const projects = projectStore.listProjects();
if (projects.length > 0) {
  console.log(`[startup] Restoring state for ${projects.length} project(s)...`);
  const results = restoreState(projects, taskStore);
  for (const r of results) {
    console.log(`[startup] ${r.projectName}: ${r.todoCount} TODO, ${r.completedCount} completed, ${r.failedCount} failed, ${r.interruptedCount} interrupted`);
  }
  // Load per-project custom stages from dagclaw.config.ts/.json
  for (const project of projects) {
    taskStore.loadProjectStages(project.path).catch(err => {
      console.error(`[startup] Bad config in ${project.name}: ${err instanceof Error ? err.message : err}`);
    });
  }
}

app.use(createTasksRouter(taskStore));
app.use(createStagesRouter(taskStore));
app.use(createProjectsRouter(projectStore, taskStore));

const runsWorkDir = process.env.CLAW_ALLOWED_DIR || process.env.HOME || '/tmp';
app.use(createRunsRouter(runsWorkDir));

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  console.log(`DAGClaw backend listening on port ${PORT}`);
});

function gracefulShutdown() {
  console.log('Shutting down gracefully...');
  // Cancel all running tasks
  const tasks = taskStore.listTasks();
  for (const task of tasks) {
    if (task.status === 'running' || task.status === 'queued' || task.status === 'awaiting_approval') {
      taskStore.cancelTask(task.id);
    }
  }
  // Close HTTP server
  server.close(() => {
    console.log('Server closed.');
    process.exit(0);
  });
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

export { app, server };

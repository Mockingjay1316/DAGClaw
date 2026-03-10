import express from 'express';
import cors from 'cors';
import http from 'node:http';
import { WsServer } from './websocket/wsServer.ts';
import { TaskStore } from './taskStore.ts';
import { createTasksRouter } from './routes/tasks.ts';
import { createStagesRouter } from './routes/stages.ts';
import { createRunsRouter } from './routes/runs.ts';
import { authMiddleware } from './middleware/auth.ts';
import type { StageDefinition } from '../../core/types.ts';

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

const customStages: Record<string, StageDefinition> = {};
const taskStore = new TaskStore(customStages);
const server = http.createServer(app);
const wsServer = new WsServer(server);

taskStore.setWsServer(wsServer);
wsServer.setTaskStore(taskStore);

app.use(createTasksRouter(taskStore));
app.use(createStagesRouter(customStages));

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
    if (task.status === 'running' || task.status === 'pending') {
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

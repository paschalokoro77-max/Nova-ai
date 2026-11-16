import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import cors from 'cors';
import { createNovaTradeRouter } from './novatrade-ai/server/src/app.ts';

const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';

async function startServer() {
  const app = express();
  app.use(cors({ origin: true }));
  const standardJson = express.json({ limit: '150kb' });
  app.use((req, res, next) => {
    if (req.path === '/api/android/screen/analyze') {
      next();
      return;
    }
    standardJson(req, res, next);
  });

  const { router } = createNovaTradeRouter({
    persistPath: path.resolve(process.cwd(), '.novatrade-data/state.json'),
    enableScheduler: true,
  });

  app.use('/api', router);
  app.use('/api', (req, res) => {
    res.status(404).json({ error: `API route not found: ${req.method} ${req.originalUrl}` });
  });
  app.use((err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!req.path.startsWith('/api')) {
      next(err);
      return;
    }
    const rawStatus = typeof (err as { status?: unknown })?.status === 'number' ? (err as { status: number }).status : 500;
    const status =
      rawStatus === 403 ? 401 : rawStatus === 502 || rawStatus === 503 || rawStatus === 504 ? 424 : rawStatus;
    const message = err instanceof Error ? err.message : 'Internal API server error.';
    res.status(status >= 400 && status < 600 ? status : 500).json({ error: message });
  });

  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    if (fs.existsSync(distDir)) {
      app.use(express.static(distDir));
      app.get('/{*splat}', (_req, res) => {
        res.sendFile(path.join(distDir, 'index.html'));
      });
    }
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`NovaTrade AI full-stack runtime listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start NovaTrade AI server:', err);
  process.exit(1);
});

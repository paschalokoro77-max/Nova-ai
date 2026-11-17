import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { createCorsOriginHandler, createNovaTradeRouter } from './novatrade-ai/server/src/app.ts';
import { validateProductionEnvironment } from './novatrade-ai/server/src/supabaseAdmin.ts';

const PORT = Number(process.env.PORT || 3000);

export interface FullStackAppOptions {
  isProduction?: boolean;
  distDir?: string;
  routerOptions?: Parameters<typeof createNovaTradeRouter>[0];
}

export async function createFullStackApp(options: FullStackAppOptions = {}) {
  const isProduction = options.isProduction ?? process.env.NODE_ENV === 'production';
  if (isProduction) {
    validateProductionEnvironment();
  }

  const app = express();
  app.set('trust proxy', 1);
  app.use(cors({ origin: createCorsOriginHandler(isProduction) }));
  const standardJson = express.json({ limit: '150kb' });
  app.use((req, res, next) => {
    if (req.path === '/api/android/screen/analyze') {
      next();
      return;
    }
    standardJson(req, res, next);
  });

  const routerBundle = createNovaTradeRouter({
    persistPath: isProduction ? null : path.resolve(process.cwd(), '.novatrade-data/state.json'),
    enableScheduler: true,
    ...options.routerOptions,
  });

  app.get('/health', routerBundle.handleHealthRequest);
  app.use('/api', routerBundle.router);
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
    const distDir = options.distDir ?? path.resolve(process.cwd(), 'dist');
    const indexHtmlPath = path.join(distDir, 'index.html');
    if (!fs.existsSync(distDir) || !fs.existsSync(indexHtmlPath)) {
      throw new Error(
        `Production build assets missing: dist/index.html not found at ${indexHtmlPath}. Run 'npm run build' before starting production server.`
      );
    }
    app.use(express.static(distDir, { index: 'index.html' }));
    // Express 4 compatible SPA fallback (never swallows /api/* or missing static asset files)
    app.get('*', (req, res, next) => {
      if (req.path === '/api' || req.path.startsWith('/api/')) {
        return next();
      }
      if (req.path.startsWith('/assets/') || /\.[a-z0-9]{2,8}$/i.test(req.path)) {
        return res.status(404).json({ error: `Asset not found: ${req.path}` });
      }
      return res.sendFile(indexHtmlPath);
    });
  }

  return { app, ...routerBundle };
}

async function startServer() {
  const { app } = await createFullStackApp();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`NovaTrade AI full-stack runtime listening on http://0.0.0.0:${PORT}`);
  });
}

const isMainModule =
  typeof process.argv[1] === 'string' &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  startServer().catch((err) => {
    console.error('Failed to start NovaTrade AI server:', err);
    process.exit(1);
  });
}

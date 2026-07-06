import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { ZodError } from 'zod';
import { HttpError } from './errors.js';
import { authRouter } from './routes/auth.js';
import { employeesRouter } from './routes/employees.js';
import { shiftsRouter, areasRouter } from './routes/catalogs.js';
import { punchesRouter } from './routes/punches.js';
import { storageIsLocal, LOCAL_DIR } from './storage.js';

export function createApp(): express.Express {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/employees', employeesRouter);
  app.use('/api/shifts', shiftsRouter);
  app.use('/api/areas', areasRouter);
  app.use('/api/punches', punchesRouter);

  // Solo dev: sirve las fotos guardadas en disco local (sin R2 configurado)
  if (storageIsLocal) {
    app.get('/api/photos/local/:key', (req, res) => {
      const key = decodeURIComponent(req.params.key);
      const filePath = path.resolve(LOCAL_DIR, key);
      if (!filePath.startsWith(LOCAL_DIR + path.sep)) {
        res.status(400).end();
        return;
      }
      res.sendFile(filePath, (err) => {
        if (err) res.status(404).json({ error: 'Foto no encontrada' });
      });
    });
  }

  // Manejo central de errores
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof ZodError) {
      res.status(400).json({ error: 'Datos inválidos', details: err.issues });
      return;
    }
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message, code: err.code });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'Error interno' });
  });

  return app;
}

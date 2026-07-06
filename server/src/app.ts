import express from 'express';
import cors from 'cors';
import { ZodError } from 'zod';
import { HttpError } from './errors.js';
import { authRouter } from './routes/auth.js';
import { employeesRouter } from './routes/employees.js';
import { shiftsRouter, areasRouter } from './routes/catalogs.js';

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

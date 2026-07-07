import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import rateLimit from 'express-rate-limit';
import { ZodError } from 'zod';
import { HttpError } from './errors.js';
import { authRouter } from './routes/auth.js';
import { employeesRouter } from './routes/employees.js';
import { shiftsRouter, areasRouter } from './routes/catalogs.js';
import { punchesRouter } from './routes/punches.js';
import { attendanceRouter, assignmentsRouter } from './routes/attendance.js';
import { reportsRouter } from './routes/reports.js';
import { settingsRouter } from './routes/settings.js';
import { usersRouter } from './routes/users.js';
import { storageIsLocal, LOCAL_DIR } from './storage.js';

export function createApp(): express.Express {
  const app = express();
  // Detrás del proxy de la plataforma (Traefik en Coolify, Render): un solo salto.
  // Sin esto, express-rate-limit v7 rechaza peticiones que traen X-Forwarded-For.
  app.set('trust proxy', 1);
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  // Anti abuso: el kiosco legítimo hace ~12 checadas/min como máximo
  app.use(
    '/api/punches/ingest',
    rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false })
  );
  app.use(
    '/api/auth/login',
    rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: true, legacyHeaders: false })
  );

  app.use('/api/auth', authRouter);
  app.use('/api/employees', employeesRouter);
  app.use('/api/shifts', shiftsRouter);
  app.use('/api/areas', areasRouter);
  app.use('/api/punches', punchesRouter);
  app.use('/api/attendance', attendanceRouter);
  app.use('/api/assignments', assignmentsRouter);
  app.use('/api/reports', reportsRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/users', usersRouter);

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

  // Producción: servir el build del cliente (single web service en Render)
  const clientDist = path.resolve(process.cwd(), '../client/dist');
  if (fs.existsSync(clientDist)) {
    app.use(express.static(clientDist));
    app.use((req, res, next) => {
      if (req.method === 'GET' && !req.path.startsWith('/api/')) {
        res.sendFile(path.join(clientDist, 'index.html'));
        return;
      }
      next();
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

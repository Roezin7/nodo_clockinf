import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireAdmin, requireOrganization } from '../middleware/auth.js';
import { ALLOWED_TIMEZONE_IDS, getSettings, updateSettings } from '../services/settingsService.js';

export const settingsRouter = Router();
settingsRouter.use(requireAuth);

settingsRouter.get('/', async (req, res) => {
  res.json(await getSettings(requireOrganization(req)));
});

const patchSchema = z
  .object({
    photo_retention_weeks: z.number().int().min(1).max(104),
    duplicate_window_minutes: z.number().int().min(0).max(30),
    timezone: z.enum(ALLOWED_TIMEZONE_IDS),
  })
  .partial()
  .strict();

settingsRouter.patch('/', requireAdmin, async (req, res) => {
  const body = patchSchema.parse(req.body);
  res.json(await updateSettings(requireOrganization(req), body));
});

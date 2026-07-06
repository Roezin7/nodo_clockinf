import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { ALLOWED_TIMEZONE_IDS, getSettings, updateSettings } from '../services/settingsService.js';

export const settingsRouter = Router();
settingsRouter.use(requireAuth);

settingsRouter.get('/', async (_req, res) => {
  res.json(await getSettings());
});

const patchSchema = z
  .object({
    daily_ot_threshold_minutes: z.number().int().min(60).max(24 * 60),
    weekly_ot_threshold_minutes: z.number().int().min(60).max(7 * 24 * 60),
    week_start_day: z.number().int().min(1).max(7),
    photo_retention_weeks: z.number().int().min(1).max(104),
    duplicate_window_minutes: z.number().int().min(0).max(30),
    work_days: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    timezone: z.enum(ALLOWED_TIMEZONE_IDS),
  })
  .partial();

settingsRouter.patch('/', requireAdmin, async (req, res) => {
  const body = patchSchema.parse(req.body);
  res.json(await updateSettings(body));
});

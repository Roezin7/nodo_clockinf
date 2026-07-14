import { Router } from 'express';
import { notFound } from '../errors.js';
import { PROPOSAL_PRICING } from '../proposals/pricing.js';
import { getProposal } from '../proposals/registry.js';

export const proposalsRouter = Router();

// The proposal contains public commercial content and demo fixtures only.
// Operational data remains behind the normal Clock-In authentication boundary.
proposalsRouter.get('/:slug', (req, res) => {
  const proposal = getProposal(req.params.slug);
  if (!proposal) throw notFound('Propuesta no encontrada');
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.json({ proposal, pricing: PROPOSAL_PRICING });
});

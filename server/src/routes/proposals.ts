import crypto from 'node:crypto';
import { Router, type Request } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { config } from '../config.js';
import { queryOne } from '../db.js';
import { forbidden, notFound } from '../errors.js';
import { calculateCommercialTotals, PROPOSAL_PRICING } from '../proposals/pricing.js';
import { getProposal } from '../proposals/registry.js';

export const proposalsRouter = Router();
const COOKIE = 'nodo_proposal_session';
const CONSENT = 'Confirmo que revisé el alcance, precios, exclusiones y aviso de privacidad mostrado en esta propuesta. Esta acción solicita la preparación del contrato y no procesa un pago.';

const accessSchema = z.object({ code: z.string().min(6).max(128) }).strict();
export const proposalAcceptanceSchema = z.object({
  legalCompanyName: z.string().trim().min(2).max(160),
  representativeName: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(180),
  phone: z.string().trim().min(7).max(40),
  stations: z.number().int().min(1).max(100),
  plants: z.number().int().min(1).max(100),
  employees: z.number().int().min(1).max(100_000),
  pricingConfirmed: z.literal(true),
  termsAccepted: z.literal(true),
  signature: z.string().trim().min(2).max(120),
  requestKickoff: z.boolean().default(true),
}).strict().superRefine((value, context) => {
  if (value.signature.toLocaleLowerCase('es').replace(/\s+/g, ' ')
      !== value.representativeName.toLocaleLowerCase('es').replace(/\s+/g, ' ')) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['signature'], message: 'La firma debe coincidir con el representante' });
  }
});

interface ProposalSession {
  kind: 'proposal';
  slug: string;
  jti: string;
}

function cookieValue(req: Request): string | null {
  const raw = req.headers.cookie ?? '';
  for (const item of raw.split(';')) {
    const [name, ...value] = item.trim().split('=');
    if (name === COOKIE) return decodeURIComponent(value.join('='));
  }
  return null;
}

function requireSameOrigin(req: Request): void {
  const origin = req.get('origin');
  if (!origin) return;
  const expected = `${req.protocol}://${req.get('host')}`;
  if (origin !== expected && !config.corsOrigins.includes(origin)) throw forbidden('Origen no permitido');
}

function requireProposalSession(req: Request, slug: string): ProposalSession {
  const token = cookieValue(req);
  if (!token) throw forbidden('Esta propuesta requiere un código de acceso');
  try {
    const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'], issuer: 'nodo-proposals' }) as ProposalSession;
    if (payload.kind !== 'proposal' || payload.slug !== slug || !payload.jti) throw new Error('scope');
    return payload;
  } catch {
    throw forbidden('La sesión de la propuesta expiró o no es válida');
  }
}

proposalsRouter.post('/:slug/access', (req, res) => {
  requireSameOrigin(req);
  const proposal = getProposal(req.params.slug);
  if (!proposal) throw notFound('Propuesta no encontrada');
  const input = accessSchema.parse(req.body);
  const expected = config.proposalAccessCodes[proposal.slug];
  if (!expected) throw notFound('Propuesta no habilitada');
  const actual = crypto.createHash('sha256').update(input.code, 'utf8').digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'))) throw forbidden('Código de acceso incorrecto');
  const sessionId = crypto.randomUUID();
  const token = jwt.sign({ kind: 'proposal', slug: proposal.slug }, config.jwtSecret, {
    algorithm: 'HS256', expiresIn: '8h', issuer: 'nodo-proposals', jwtid: sessionId,
  });
  res.setHeader('Cache-Control', 'no-store');
  res.cookie(COOKIE, token, {
    httpOnly: true, sameSite: 'strict', secure: config.nodeEnv === 'production', maxAge: 8 * 60 * 60 * 1000, path: '/api/proposals',
  });
  res.json({ ok: true, expires_in_seconds: 28_800 });
});

proposalsRouter.get('/:slug', (req, res) => {
  const proposal = getProposal(req.params.slug);
  if (!proposal) throw notFound('Propuesta no encontrada');
  requireProposalSession(req, proposal.slug);
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({ proposal, pricing: PROPOSAL_PRICING, consent: CONSENT });
});

proposalsRouter.post('/:slug/acceptances', async (req, res) => {
  requireSameOrigin(req);
  const proposal = getProposal(req.params.slug);
  if (!proposal) throw notFound('Propuesta no encontrada');
  const session = requireProposalSession(req, proposal.slug);
  const input = proposalAcceptanceSchema.parse(req.body);
  const totals = calculateCommercialTotals(input);
  const accepted = await queryOne<{ id: string; created_at: Date }>(
    `INSERT INTO proposal_acceptances
      (proposal_slug, proposal_version, legal_company_name, representative_name, email, phone,
       stations, plants, employees, accepted_configuration, accepted_prices, signature_name,
       session_id, consent_shown, kickoff_requested)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,$15)
     RETURNING id, created_at`,
    [proposal.slug, proposal.version, input.legalCompanyName, input.representativeName, input.email,
      input.phone, input.stations, input.plants, input.employees,
      JSON.stringify({ stations: input.stations, plants: input.plants, employees: input.employees }),
      JSON.stringify(totals), input.signature, session.jti, CONSENT, input.requestKickoff],
  );
  res.status(201).setHeader('Cache-Control', 'no-store').json({
    acceptance_id: accepted!.id,
    accepted_at: accepted!.created_at,
    proposal_version: proposal.version,
    prices: totals,
    action: 'contract_requested',
  });
});

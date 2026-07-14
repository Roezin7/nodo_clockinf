export function parseProposalAccessCodes(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('PROPOSAL_ACCESS_CODES debe ser JSON válido'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('PROPOSAL_ACCESS_CODES debe ser un objeto');
  const output: Record<string, string> = {};
  for (const [slug, hash] of Object.entries(parsed)) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || typeof hash !== 'string' || !/^[a-f0-9]{64}$/i.test(hash)) {
      throw new Error(`Código de acceso inválido para ${slug}`);
    }
    output[slug] = hash.toLowerCase();
  }
  return output;
}

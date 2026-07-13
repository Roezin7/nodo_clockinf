/** Contrato de lista deliberadamente estricto para no dejar la UI en skeleton. */
export function identityReviewItems<T>(body: unknown): T[] {
  if (!body || typeof body !== 'object' || !Array.isArray((body as { items?: unknown }).items)) {
    throw new Error('Respuesta inválida de revisiones de identidad');
  }
  return (body as { items: T[] }).items;
}

export interface SessionBoundAttempt {
  source_session_id?: string;
  semantic_duplicate?: boolean;
}

/**
 * Mantiene juntos los intentos de cada evento. Dos eventos deduplicados pueden
 * tener ambos un "Intento 1"; mezclarlos visualmente induciría al revisor a
 * creer que pertenecen a una sola secuencia biométrica.
 */
export function groupIdentityAttempts<T extends SessionBoundAttempt>(
  attempts: T[],
  canonicalSessionId: string
): Array<{ sessionId: string; semanticDuplicate: boolean; attempts: T[] }> {
  const groups = new Map<string, { sessionId: string; semanticDuplicate: boolean; attempts: T[] }>();
  for (const attempt of attempts) {
    const sessionId = attempt.source_session_id ?? canonicalSessionId;
    const group = groups.get(sessionId) ?? {
      sessionId,
      semanticDuplicate: Boolean(attempt.semantic_duplicate) || sessionId !== canonicalSessionId,
      attempts: [],
    };
    group.semanticDuplicate ||= Boolean(attempt.semantic_duplicate) || sessionId !== canonicalSessionId;
    group.attempts.push(attempt);
    groups.set(sessionId, group);
  }
  return [...groups.values()];
}

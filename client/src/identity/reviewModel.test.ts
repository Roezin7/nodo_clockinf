import { describe, expect, it } from 'vitest';
import { groupIdentityAttempts, identityReviewItems } from './reviewModel';

describe('contrato de lista de revisiones', () => {
  it('consume {items} y rechaza el shape legacy para fallar visiblemente', () => {
    const fixture = { items: [{ session_id: 'session-1', attempt_count: 3 }] };
    expect(identityReviewItems<{ session_id: string; attempt_count: number }>(fixture)).toEqual(fixture.items);
    expect(() => identityReviewItems({ reviews: fixture.items })).toThrow('Respuesta inválida');
  });
});

describe('agrupación de evidencia por evento', () => {
  it('no mezcla dos Intento 1 de sesiones semánticamente deduplicadas', () => {
    const groups = groupIdentityAttempts([
      { id: 'a1', attempt_number: 1, source_session_id: 'canonical', semantic_duplicate: false },
      { id: 'b1', attempt_number: 1, source_session_id: 'alias', semantic_duplicate: true },
      { id: 'a2', attempt_number: 2, source_session_id: 'canonical', semantic_duplicate: false },
    ], 'canonical');
    expect(groups).toEqual([
      {
        sessionId: 'canonical',
        semanticDuplicate: false,
        attempts: [
          { id: 'a1', attempt_number: 1, source_session_id: 'canonical', semantic_duplicate: false },
          { id: 'a2', attempt_number: 2, source_session_id: 'canonical', semantic_duplicate: false },
        ],
      },
      {
        sessionId: 'alias',
        semanticDuplicate: true,
        attempts: [
          { id: 'b1', attempt_number: 1, source_session_id: 'alias', semantic_duplicate: true },
        ],
      },
    ]);
  });
});

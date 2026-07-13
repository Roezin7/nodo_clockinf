export type DemoIdentityOutcome = 'retry' | 'review';

/** The public demo never calls production identity services. */
export function failedDemoIdentityOutcome(failedAttempts: number): DemoIdentityOutcome {
  return failedAttempts >= 3 ? 'review' : 'retry';
}

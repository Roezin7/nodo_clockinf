export type FaceProviderName = 'review_only' | 'fake' | 'aws_rekognition';

export function parseFaceProvider(value: string | undefined): FaceProviderName {
  const provider = value?.trim() || 'review_only';
  if (provider !== 'review_only' && provider !== 'fake' && provider !== 'aws_rekognition') {
    throw new Error(`FACE_PROVIDER inválido: ${provider}`);
  }
  return provider;
}

/** A simulated identity decision must never be deployable as production auth. */
export function assertFaceProviderEnvironment(
  provider: FaceProviderName,
  nodeEnv: string | undefined
): void {
  if (provider === 'fake' && nodeEnv !== 'test' && nodeEnv !== 'development') {
    throw new Error('FACE_PROVIDER=fake sólo está permitido en test o development');
  }
}

export function parseBoundedNumber(
  name: string,
  value: string | undefined,
  options: { defaultValue: number; min: number; max: number; integer?: boolean }
): number {
  if (value === undefined || value.trim() === '') return options.defaultValue;
  const parsed = Number(value);
  if (
    !Number.isFinite(parsed) ||
    parsed < options.min ||
    parsed > options.max ||
    (options.integer === true && !Number.isInteger(parsed))
  ) {
    throw new Error(
      `${name} debe ser ${options.integer ? 'un entero ' : ''}entre ${options.min} y ${options.max}`
    );
  }
  return parsed;
}

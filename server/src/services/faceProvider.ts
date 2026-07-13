import {
  CompareFacesCommand,
  DetectFacesCommand,
  RekognitionClient,
} from '@aws-sdk/client-rekognition';
import { config } from '../config.js';
import type { FaceProviderName } from './faceProviderConfig.js';

export type FaceAttemptResult =
  | 'match'
  | 'no_match'
  | 'no_face'
  | 'multiple_faces'
  | 'liveness_failed'
  | 'quality_failed'
  | 'provider_error'
  | 'provider_unavailable'
  | 'no_enrollment'
  | 'review_only';

export type LivenessStatus = 'not_performed' | 'passed' | 'failed' | 'unknown';

export interface FaceVerificationInput {
  attemptPhoto: Buffer;
  enrollmentPhoto: Buffer | null;
  /** Test/development-only result injection used by the fake adapter. */
  debugOutcome?: FaceAttemptResult;
}

export interface FaceVerificationResult {
  result: FaceAttemptResult;
  similarity: number | null;
  livenessStatus: LivenessStatus;
  metadata: Record<string, unknown>;
}

export interface FaceProvider {
  readonly name: FaceProviderName;
  readonly livenessCapable: boolean;
  verify(input: FaceVerificationInput): Promise<FaceVerificationResult>;
}

const noLiveness = {
  livenessStatus: 'not_performed' as const,
};

export class ReviewOnlyFaceProvider implements FaceProvider {
  readonly name = 'review_only' as const;
  readonly livenessCapable = false;

  async verify(): Promise<FaceVerificationResult> {
    return {
      result: 'review_only',
      similarity: null,
      ...noLiveness,
      metadata: { automatic_comparison: false },
    };
  }
}

export class FakeFaceProvider implements FaceProvider {
  readonly name = 'fake' as const;
  readonly livenessCapable = true;

  async verify(input: FaceVerificationInput): Promise<FaceVerificationResult> {
    const result = input.debugOutcome ?? 'match';
    return {
      result,
      similarity: result === 'match' ? 99.9 : result === 'no_match' ? 12 : null,
      livenessStatus: result === 'liveness_failed' ? 'failed' : 'passed',
      metadata: { simulated: true },
    };
  }
}

function awsErrorName(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  return String((error as { name?: unknown }).name ?? '');
}

export class AwsRekognitionFaceProvider implements FaceProvider {
  readonly name = 'aws_rekognition' as const;
  // CompareFaces does not perform presentation-attack/liveness detection.
  readonly livenessCapable = false;
  private readonly client: RekognitionClient;
  private readonly threshold: number;

  constructor(options: { region: string; threshold: number; client?: RekognitionClient }) {
    this.client = options.client ?? new RekognitionClient({ region: options.region });
    this.threshold = options.threshold;
  }

  async verify(input: FaceVerificationInput): Promise<FaceVerificationResult> {
    if (!input.enrollmentPhoto) {
      return {
        result: 'provider_error',
        similarity: null,
        ...noLiveness,
        metadata: { reason: 'missing_enrollment_bytes' },
      };
    }
    try {
      const detected = await this.client.send(
        new DetectFacesCommand({ Image: { Bytes: input.attemptPhoto }, Attributes: ['DEFAULT'] })
      );
      const faceCount = detected.FaceDetails?.length ?? 0;
      if (faceCount === 0) {
        return { result: 'no_face', similarity: null, ...noLiveness, metadata: { face_count: 0 } };
      }
      if (faceCount > 1) {
        return {
          result: 'multiple_faces',
          similarity: null,
          ...noLiveness,
          metadata: { face_count: faceCount },
        };
      }
      const compared = await this.client.send(
        new CompareFacesCommand({
          SourceImage: { Bytes: input.enrollmentPhoto },
          TargetImage: { Bytes: input.attemptPhoto },
          SimilarityThreshold: this.threshold,
          QualityFilter: 'AUTO',
        })
      );
      const similarity = compared.FaceMatches?.[0]?.Similarity ?? null;
      return {
        result: similarity !== null && similarity >= this.threshold ? 'match' : 'no_match',
        similarity,
        ...noLiveness,
        metadata: {
          threshold: this.threshold,
          unmatched_faces: compared.UnmatchedFaces?.length ?? 0,
        },
      };
    } catch (error) {
      const name = awsErrorName(error);
      const unavailable = [
        'ThrottlingException',
        'ProvisionedThroughputExceededException',
        'InternalServerError',
        'ServiceUnavailableException',
        'TimeoutError',
      ].includes(name);
      return {
        result: unavailable ? 'provider_unavailable' : 'provider_error',
        similarity: null,
        ...noLiveness,
        metadata: { provider_error_name: name || 'unknown' },
      };
    }
  }
}

let singleton: FaceProvider | undefined;

export function getFaceProvider(): FaceProvider {
  if (singleton) return singleton;
  switch (config.face.provider) {
    case 'fake':
      singleton = new FakeFaceProvider();
      break;
    case 'aws_rekognition':
      singleton = new AwsRekognitionFaceProvider({
        region: config.face.awsRegion,
        threshold: config.face.similarityThreshold,
      });
      break;
    default:
      singleton = new ReviewOnlyFaceProvider();
  }
  return singleton;
}

export function resetFaceProviderForTests(): void {
  singleton = undefined;
}

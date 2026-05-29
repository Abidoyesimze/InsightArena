import { ContractPrediction } from '../../contract/contract.service';

export interface NormalizedPrediction {
  predictionId: string;
  matchId: string;
  predictedOutcome: string;
  predictedAt: number;
  isCorrect: boolean | null;
}

export function normalizeContractPrediction(
  prediction: ContractPrediction,
): NormalizedPrediction {
  const raw = prediction as ContractPrediction & Record<string, unknown>;

  const predictionId = String(
    raw.predictionId ?? raw.prediction_id ?? raw.id ?? '',
  );
  const matchId = String(raw.matchId ?? raw.match_id ?? '');
  const predictedOutcome = String(
    raw.chosenOutcome ??
      raw.predictedOutcome ??
      raw.predicted_outcome ??
      '',
  );
  const predictedAt = Number(raw.predictedAt ?? raw.predicted_at ?? 0);
  const isCorrectRaw = raw.isCorrect ?? raw.is_correct;

  let isCorrect: boolean | null = null;
  if (isCorrectRaw === true || isCorrectRaw === false) {
    isCorrect = isCorrectRaw;
  }

  return {
    predictionId,
    matchId,
    predictedOutcome,
    predictedAt,
    isCorrect,
  };
}

export function resolveCorrectness(
  normalized: NormalizedPrediction,
  matchResolved: boolean,
  matchOutcome: string | null,
): boolean | null {
  if (normalized.isCorrect !== null) {
    return normalized.isCorrect;
  }

  if (!matchResolved || !matchOutcome) {
    return null;
  }

  return matchOutcome === normalized.predictedOutcome;
}

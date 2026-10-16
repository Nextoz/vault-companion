// AI model leaderboard (LB1, ADR-0065). Wire contract and shared presentation constants for the
// Artificial-Analysis-backed leaderboard. Scores are the provider's published values — never merged across
// providers; missing metrics stay null and render honestly.
import { z } from 'zod';

export const LEADERBOARD_PROVIDER = 'Artificial Analysis';
export const LEADERBOARD_METHODOLOGY_URL = 'https://artificialanalysis.ai/methodology';
export const LEADERBOARD_TOP_N = 10;
export const LEADERBOARD_MAX_MODELS = 30;

export const LEADERBOARD_CATEGORY_IDS = ['overall', 'coding', 'agentic', 'math'] as const;
export const LeaderboardCategoryId = z.enum(['overall', 'coding', 'agentic', 'math']);
export type LeaderboardCategoryId = z.infer<typeof LeaderboardCategoryId>;

/** What each ranking measures; the tab title and its one-line explanation. */
export const LEADERBOARD_CATEGORY_INFO: Record<LeaderboardCategoryId, { label: string; blurb: string }> = {
  overall: { label: 'Overall', blurb: 'Intelligence Index — the provider’s weighted composite of independent evaluations.' },
  coding: { label: 'Coding', blurb: 'How well the model writes and reasons about code.' },
  agentic: { label: 'Agentic', blurb: 'How well the model completes multi-step, tool-using tasks.' },
  math: { label: 'Mathematics', blurb: 'Competition-style mathematical problem solving.' },
};

export const LeaderboardUnavailableReason = z.enum(['no-key', 'timeout', 'provider-error', 'malformed', 'empty']);
export type LeaderboardUnavailableReason = z.infer<typeof LeaderboardUnavailableReason>;

export const LEADERBOARD_REASON_NOTES: Record<LeaderboardUnavailableReason, string> = {
  'no-key': 'No Artificial Analysis API key is configured, so no benchmark data can be fetched.',
  timeout: 'The benchmark provider did not answer in time.',
  'provider-error': 'The benchmark provider is unavailable right now.',
  malformed: 'The benchmark provider sent data we could not read.',
  empty: 'The benchmark provider returned no ranked models.',
};

const LeaderboardMovement = z.object({ rankDelta: z.number(), isNew: z.boolean() });
export type LeaderboardMovement = z.infer<typeof LeaderboardMovement>;

export const LeaderboardModel = z.object({
  slug: z.string(),
  name: z.string(),
  provider: z.string().nullable(),
  scores: z.object({
    overall: z.number().nullable(),
    coding: z.number().nullable(),
    agentic: z.number().nullable(),
    math: z.number().nullable(),
  }),
  /** Individual evaluation scores exactly as published (some are 0–1 accuracies, some raw points). */
  benchmarks: z.array(z.object({ key: z.string(), value: z.number() })),
  pricingInputPer1M: z.number().nullable(),
  pricingOutputPer1M: z.number().nullable(),
  medianTokensPerSecond: z.number().nullable(),
  medianTimeToFirstTokenSeconds: z.number().nullable(),
  releaseDate: z.string().nullable(),
  contextWindowTokens: z.number().nullable(),
  openWeights: z.boolean().nullable(),
  reasoningModel: z.boolean().nullable(),
  inputModalities: z.array(z.string()),
  outputModalities: z.array(z.string()),
  movement: LeaderboardMovement.nullable(),
});
export type LeaderboardModel = z.infer<typeof LeaderboardModel>;

const LeaderboardOk = z.object({
  status: z.literal('ok'),
  now: z.string(),
  /** When we last synced from the provider; the provider publishes no dataset timestamp of its own. */
  syncedAt: z.string(),
  provenance: z.string(),
  intelligenceIndexVersion: z.number().nullable(),
  note: z.string().nullable(),
  models: z.array(LeaderboardModel),
  rankings: z.object({
    overall: z.array(z.string()),
    coding: z.array(z.string()),
    agentic: z.array(z.string()),
    math: z.array(z.string()),
  }),
});

export const LeaderboardResponse = z.discriminatedUnion('status', [
  LeaderboardOk,
  z.object({
    status: z.literal('unavailable'),
    now: z.string(),
    reason: LeaderboardUnavailableReason,
    note: z.string(),
  }),
]);
export type LeaderboardResponse = z.infer<typeof LeaderboardResponse>;

/** Short human-readable descriptions of what each evaluation measures (descriptions, never results). */
export const LEADERBOARD_BENCHMARKS: Record<string, { label: string; explainer: string }> = {
  aa_briefcase_elo: { label: 'AA-Briefcase', explainer: 'Real-world professional tasks drawn from business documents.' },
  gdpval_aa_elo: { label: 'GDPval', explainer: 'Expert-level tasks with real economic value.' },
  gdpval_aa_normalized: { label: 'GDPval (normalized)', explainer: 'GDPval normalized to a 0–1 scale.' },
  automationbench_aa: { label: 'AutomationBench', explainer: 'Automating multi-step computer work.' },
  terminalbench_hard: { label: 'Terminal-Bench (hard)', explainer: 'Hard tasks in a computer terminal.' },
  terminalbench_v2_1: { label: 'Terminal-Bench 2.1', explainer: 'Completing tasks in a computer terminal.' },
  terminalbench_v4_0: { label: 'Terminal-Bench 4.0', explainer: 'Completing tasks in a computer terminal.' },
  scicode: { label: 'SciCode', explainer: 'Research-level scientific coding problems.' },
  aa_lcr: { label: 'AA-LCR', explainer: 'Reasoning over very long documents.' },
  aa_omniscience_index: { label: 'AA Omniscience', explainer: 'Knowing what it knows: calibrated, non-hallucinating answers.' },
  aa_omniscience_accuracy: { label: 'AA Omniscience (accuracy)', explainer: 'Accuracy while staying calibrated.' },
  aa_omniscience_non_hallucination_rate: { label: 'AA Omniscience (non-hallucination)', explainer: 'How often it avoids claiming false things.' },
  ifbench: { label: 'IFBench', explainer: 'Following precise instructions exactly.' },
  hle: { label: 'Humanity’s Last Exam', explainer: 'Extremely hard frontier academic questions.' },
  gpqa: { label: 'GPQA', explainer: 'Graduate-level science questions written to resist search.' },
  gpqa_diamond: { label: 'GPQA Diamond', explainer: 'The hardest GPQA science subset.' },
  mmlu_pro: { label: 'MMLU-Pro', explainer: 'Broad academic and professional knowledge.' },
  livecodebench: { label: 'LiveCodeBench', explainer: 'Correct code for fresh, uncontaminated problems.' },
  math_500: { label: 'MATH-500', explainer: 'Competition mathematics across difficulty levels.' },
  aime: { label: 'AIME', explainer: 'American Invitational Mathematics Examination problems.' },
  tau_banking: { label: 'Tau-bank', explainer: 'Agentic tasks in a realistic banking environment.' },
  tau2_telecom: { label: 'Tau² Telecom', explainer: 'Agentic tasks in a realistic telecom environment.' },
  critpt: { label: 'CritPt', explainer: 'Deeply solving a single hard critical-point problem.' },
  artificial_analysis_multilingual_index: { label: 'Multilingual Index', explainer: 'Performance across many non-English languages.' },
  artificial_analysis_openness_index: { label: 'Openness Index', explainer: 'How open the model is: weights, license and transparency.' },
};

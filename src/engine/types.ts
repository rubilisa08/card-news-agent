import type {
  Answer, AskSpec, Candidate, DeepResearchDraft, DeepResearchResult, PriorAnswer, ResearchResult, RunError,
  RunErrorCode, Storyboard, StoryboardDraft,
} from '../types.ts';

/**
 * What the job manager gives an engine for one run. Engines report through these
 * callbacks; the manager turns them into the app's progress / need_input / result /
 * error states. This is the app's own convention, not a format any CLI provides.
 */
export interface EngineContext {
  projectId: string;
  /** Engine session saved for this project, or null to start a new one. */
  sessionId: string | null;
  signal: AbortSignal;
  progress(message: string): void;
  /** need_input: resolves with the user's web answer; rejects if the run is cancelled. */
  askUser(spec: AskSpec): Promise<Answer>;
  setSessionId(id: string): void;
  /** Answers already given in this project (by question key), e.g. after a restart. */
  priorAnswers: Record<string, PriorAnswer>;
}

export interface ResearchInput {
  topic: string;
  periodDays: number;
  now: Date;
}

export interface DeepResearchInput {
  topic: string;
  candidates: Candidate[];
  /** When the candidates were searched (ISO); the basis for any '최신' claim. */
  searchedAt: string;
}

export interface Engine {
  name: string;
  mock: boolean;
  research(ctx: EngineContext, input: ResearchInput): Promise<ResearchResult>;
  /** Returns a draft; the job manager applies the editorial rules (editorial.ts). */
  deepResearch(ctx: EngineContext, input: DeepResearchInput): Promise<DeepResearchDraft>;
  /** Returns a draft; the job manager applies the storyboard rules (storyboard.ts). */
  storyboard(ctx: EngineContext, input: StoryboardInput): Promise<StoryboardDraft>;
  /** Rewrites one card's text on request, within the card's confirmed facts. */
  reviseCard(ctx: EngineContext, input: ReviseCardInput): Promise<RevisedCard>;
}

export interface ReviseCardInput {
  topic: string;
  audience: string;
  role: string;
  headline: string;
  body: string;
  /** The confirmed facts this card may use, with their sources. */
  facts: { fact: string; url: string; publishedAt: string | null }[];
  instruction: string;
}

export interface RevisedCard {
  headline: string;
  body: string;
  /** What the engine changed, in one sentence, for the revision record. */
  note: string;
}

export interface StoryboardInput {
  topic: string;
  deep: DeepResearchResult;
  research: ResearchResult;
  /** The storyboard being revised, with the user's change request. */
  previous: Storyboard | null;
  instruction: string | null;
}

/** An expected failure with a user-facing reason and next step. */
export class EngineError extends Error {
  code: RunErrorCode;
  nextAction: string;
  constructor(code: RunErrorCode, message: string, nextAction: string) {
    super(message);
    this.code = code;
    this.nextAction = nextAction;
  }
  toRunError(): RunError {
    return { code: this.code, message: this.message, nextAction: this.nextAction };
  }
}

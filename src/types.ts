export type Stage =
  | 'created'
  | 'researching'
  | 'selecting'
  | 'deep_research'
  | 'editorial_ready'
  | 'storyboard_drafting'
  | 'storyboard_review'
  | 'producing'
  | 'reviewing';

export type RunKind = 'research' | 'deep_research' | 'storyboard' | 'images' | 'revision' | 'export';

export type RunStatus =
  | 'running'
  | 'waiting_for_user'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = ['running', 'waiting_for_user'];

export type RunErrorCode =
  | 'auth_required'
  | 'search_failed'
  | 'image_failed'
  | 'engine_failed'
  | 'cancelled'
  | 'interrupted';

export interface RunError {
  code: RunErrorCode;
  message: string;
  nextAction: string;
}

export interface Source {
  title: string;
  url: string;
  publisher: string;
  publishedAt: string | null;
  /** The news site's own domain (e.g. fnnews.com), needed when url is a portal or Google News link (B43). */
  site?: string | null;
}

export interface Candidate {
  id: string;
  title: string;
  summary: string;
  category: string;
  publishedAt: string | null;
  eventDate: string | null;
  sources: Source[];
  value: string;
  uncertainty: string;
}

export interface ResearchResult {
  searchedAt: string;
  periodDays: number;
  periodStart: string;
  periodEnd: string;
  mock: boolean;
  engine: string;
  note: string | null;
  candidates: Candidate[];
  /** Stories found but not put forward: no official or major-news source (B36). */
  held?: (Candidate & { heldReason: string })[];
  /** How many candidates each newspaper the user asked for appears in (B38, B39). */
  outlets?: { name: string; via: 'direct' | 'gnews'; count: number }[];
  /** Every on-topic article found in the period, chosen or not, for the user to browse (B43). */
  articles?: Source[];
}

export interface ResearchRecord {
  candidateId: string;
  facts: { text: string; sourceUrl: string }[];
  claims: { text: string; by: string; sourceUrl: string }[];
  limits: string[];
  conflicts: string[];
}

/** list = 목록형, story = 이야기형 (PRD 3절, DECISIONS D12). */
export type CardFormat = 'list' | 'story';
export const CARD_FORMATS: readonly CardFormat[] = ['list', 'story'];
export const STORY_ROLES = ['상황', '불편', '변화', '활용', '한계'] as const;

export interface FormatAssessment {
  fit: string;
  drawback: string;
}

export interface StructureItem {
  role: string;
  summary: string;
}

/** A hook as the engine proposes it: text plus the facts it rests on. */
export interface HookDraft {
  text: string;
  factRefs: { candidateId: string; factIndex: number }[];
}

/** Editorial proposal as an engine returns it, before the app checks the rules. */
export interface EditorialDraft {
  audience: string;
  whyUseful: string;
  formats: Record<CardFormat, FormatAssessment>;
  recommendedFormat: CardFormat;
  formatReason: string;
  structure: StructureItem[];
  hooks: HookDraft[];
  reasoning: string;
}

export interface Hook {
  text: string;
  basis: { candidateId: string; fact: string; sourceUrl: string; publishedAt: string | null }[];
  /** Set when the hook says '최신': the dates that back it. */
  latestBasis: string | null;
}

/** Editorial proposal after the app's rule check. */
export interface Editorial extends Omit<EditorialDraft, 'hooks'> {
  hooks: Hook[];
  excludedHooks: { text: string; reason: string }[];
  warnings: string[];
}

export interface DeepResearchDraft {
  mock: boolean;
  records: ResearchRecord[];
  editorial: EditorialDraft;
}

export interface DeepResearchResult {
  mock: boolean;
  records: ResearchRecord[];
  editorial: Editorial;
}

export interface QuestionOption {
  label: string;
  description: string;
}

export interface Answer {
  choice: string | null;
  text: string | null;
}

export interface PriorAnswer {
  question: string;
  answer: Answer;
}

/** What an engine (or the app itself) asks the user. */
export interface AskSpec {
  key: string;
  question: string;
  options: QuestionOption[];
  recommended: string | null;
  recommendationReason: string | null;
  allowFreeText: boolean;
}

export type QuestionKind = 'engine' | 'widen_period';

export interface Question extends AskSpec {
  id: string;
  projectId: string;
  runId: string;
  kind: QuestionKind;
  version: number;
  status: 'open' | 'answered' | 'superseded';
  answer: Answer | null;
  createdAt: string;
}

// ---- storyboard and images (PRD 4–5) ----

/** A card as the engine proposes it; sources are resolved by the app from factRefs. */
export interface StoryCardDraft {
  role: string;
  headline: string;
  body: string;
  imageRole: string;
  imagePrompt: string;
  factRefs: { candidateId: string; factIndex: number }[];
}

export interface StoryboardDraft {
  styleGuide: string;
  cards: StoryCardDraft[];
}

export interface StoryCard extends Omit<StoryCardDraft, 'factRefs'> {
  index: number;
  sources: { candidateId: string; fact: string; url: string; publishedAt: string | null }[];
}

export interface Storyboard {
  version: number;
  mock: boolean;
  format: CardFormat;
  audience: string;
  styleGuide: string;
  cards: StoryCard[];
  warnings: string[];
  instruction: string | null;
  createdAt: string;
  approvedAt: string | null;
}

export type ImageTool = 'agy' | 'claude-cli-svg' | 'mock';

export interface CardImage {
  index: number;
  status: 'pending' | 'generating' | 'done' | 'failed';
  tool: ImageTool | null;
  file: string | null;
  format: 'png' | 'jpg' | 'svg' | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
  prompt: string;
  createdAt: string | null;
  error: RunError | null;
  attempts: number;
  /** Card design this picture was composed for (B31); missing for older pictures. */
  design?: CardDesign;
  /** Earlier versions of this card's picture, kept as backup files (newest last). */
  history?: { at: string; instruction: string; backup: string }[];
}

// ---- card text layout (PRD 5: text is set over the image, never drawn into it) ----

export interface CardLayout {
  index: number;
  headline: string;
  body: string;
  position: 'top' | 'middle' | 'bottom';
  align: 'left' | 'center';
  /** Font sizes in px on the 1080×1350 card. */
  headlineSize: number;
  bodySize: number;
  theme: 'dark' | 'light';
  panel: 'none' | 'soft' | 'solid';
  /** false: a text-only card, laid out without a picture (B34). */
  image: boolean;
  /** How a text-only card shows its words (B35): plain, paper strips, highlighter, poster. */
  textStyle: 'plain' | 'strips' | 'highlight' | 'poster';
  /** Big emoji or symbol for the poster style (empty for none). */
  emoji: string;
  /** Background colour of the poster style. */
  tone: 'palette' | 'blue' | 'orange' | 'green' | 'pink' | 'black';
  updatedAt: string | null;
}

export type CardDesign = 'basic' | 'soft' | 'brief' | 'news' | 'photo' | 'cinema';

export interface LayoutSet {
  storyboardVersion: number;
  cards: CardLayout[];
  /** Look shared by every card of the set (B28, B30). */
  design?: CardDesign;
  /** Brand name shown at the top of the news design, e.g. a channel name. */
  brand?: string;
}

export interface ImageSet {
  storyboardVersion: number;
  /** Tool chosen for this set; switches to claude-cli-svg when agy is unavailable. */
  tool: ImageTool;
  fallbackReason: string | null;
  cards: CardImage[];
}

// ---- card revisions and final approval (PRD 6) ----

/** One change request for one card: its text only, or its picture only. */
export interface CardRevision {
  id: string;
  index: number;
  kind: 'text' | 'image';
  instruction: string;
  status: 'running' | 'done' | 'failed';
  runId: string;
  /** text: headline/body before and after. image: file kept as a backup and the new file. */
  before: { headline?: string; body?: string; file?: string };
  after: { headline?: string; body?: string; file?: string } | null;
  warnings: string[];
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export type CheckStatus = 'pass' | 'fail' | 'unverified';

export interface ExportCheck {
  key: 'missing' | 'clipping' | 'sources' | 'dates';
  label: string;
  status: CheckStatus;
  /** How it was checked, so a pass says what it is based on. */
  method: string;
  details: { index: number | null; status: CheckStatus; message: string }[];
}

export interface ExportRecord {
  id: string;
  createdAt: string;
  /** Fingerprint of the cards at approval; the export matches the cards while it is unchanged. */
  signature: string;
  files: { name: string; bytes: number; kind: 'png' | 'zip' | 'record' | 'checks' }[];
  checks: ExportCheck[];
  /** What the user still has to look at: failed or unverified items and manual-only checks. */
  toReview: string[];
}

export interface FinalApproval {
  approvedAt: string;
  signature: string;
  exportId: string | null;
}

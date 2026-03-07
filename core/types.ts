export type MemoryCategory = "preference" | "profile" | "fact" | "event" | "task";

export type MemoryIndexEntry = {
  id: string;
  uri: string;
  category: MemoryCategory;
  abstract: string;
  overview: string;
  keywords: string[];
  importance: number;
  sourceHash: string;
  createdAt: string;
  updatedAt: string;
};

export type MemoryDetailRecord = {
  content: string;
  sourceRole: string;
  metadata?: Record<string, unknown>;
};

export type MemoryMatch = MemoryIndexEntry & {
  score: number;
  detail?: string;
};

export type TimelineIndexEntry = {
  id: string;
  uri: string;
  sessionId: string;
  role: string;
  abstract: string;
  overview: string;
  keywords: string[];
  importance: number;
  sourceHash: string;
  createdAt: string;
  updatedAt: string;
};

export type TimelineDetailRecord = {
  content: string;
  role: string;
  metadata?: Record<string, unknown>;
};

export type TimelineTurn = {
  role: string;
  text: string;
};

export type TimelineMatch = TimelineIndexEntry & {
  score: number;
  detail?: string;
};

export type TimelineRecallOptions = {
  limit: number;
  scoreThreshold: number;
  includeDetails: boolean;
  detailChars: number;
  excludeSessionId?: string;
};

export type TimelineSessionState = {
  sessionId: string;
  processedCount: number;
  recentFingerprints: string[];
  extractorPendingTurns: TimelineTurn[];
  extractorPendingChars: number;
  extractorPendingRounds: number;
  updatedAt: string;
};

export type TimelineCaptureStats = {
  sessionId: string;
  observed: number;
  ingested: number;
  duplicates: number;
  processedCount: number;
  newTurns: TimelineTurn[];
  newChunks: TimelineChunkRecord[];
};

export type TimelineChunkRecord = {
  entry: TimelineIndexEntry;
  content: string;
};

export type ExtractorBatchDecision = {
  shouldExtract: boolean;
  reason: string;
  batch: TimelineTurn[];
  pendingTurns: number;
  pendingChars: number;
  pendingRounds: number;
};

export type RecallOptions = {
  limit: number;
  scoreThreshold: number;
  includeDetails: boolean;
  detailChars: number;
};

export type SemanticKind = "memory" | "timeline";

export type SemanticSearchHit = {
  uri: string;
  score: number;
};

export type SemanticRerankDoc = {
  id: string;
  text: string;
};

export type SemanticRecallOptions = {
  source: SemanticKind;
  limit: number;
  excludeSessionId?: string;
};

export type ExtractedMemoryCandidate = {
  category: MemoryCategory;
  abstract: string;
  overview: string;
  content: string;
  importance: number;
};

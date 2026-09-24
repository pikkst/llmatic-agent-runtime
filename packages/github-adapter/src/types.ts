export interface GitHubProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type GitHubProcessRunner = (
  executable: string,
  args: string[],
  cwd: string,
) => GitHubProcessResult;

export interface GitHubMutationOptions {
  approved?: boolean;
  runner?: GitHubProcessRunner;
}

export interface CreatePullRequestInput {
  title: string;
  body: string;
  base?: string;
  head?: string;
  draft?: boolean;
}

export interface PullRequestSummary {
  number: number;
  url: string;
  state: string;
  isDraft: boolean;
  mergeable: string;
  mergeStateStatus: string;
  reviewDecision?: string;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
}

export interface OpenPullRequestSummary extends PullRequestSummary {
  title: string;
  authorLogin?: string;
}

export interface PullRequestCheck {
  name: string;
  state: string;
  bucket: string;
  workflow?: string;
  link?: string;
}

export type RemoteCiState = "passing" | "failing" | "pending" | "cancelled" | "none";

export interface PullRequestStatus {
  pullRequest: PullRequestSummary;
  checks: PullRequestCheck[];
  ciState: RemoteCiState;
}

export interface PullRequestChangedFile {
  path: string;
  additions: number;
  deletions: number;
}

export interface PullRequestReviewSnapshot {
  authorLogin?: string;
  state?: string;
  body: string;
  submittedAt?: string;
}

export interface PullRequestCommentSnapshot {
  authorLogin?: string;
  body: string;
  createdAt?: string;
  url?: string;
}

export interface PullRequestReviewThreadSnapshot {
  path: string;
  line?: number;
  originalLine?: number;
  resolved: boolean;
  outdated: boolean;
  comments: PullRequestCommentSnapshot[];
}

export type PullRequestReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

export type PullRequestReviewSide = "RIGHT" | "LEFT";

export interface PullRequestInlineCommentInput {
  path: string;
  line: number;
  side: PullRequestReviewSide;
  body: string;
}

export interface PublishPullRequestReviewInput {
  body: string;
  event?: PullRequestReviewEvent;
  expectedHeadOid?: string;
  inlineComments?: PullRequestInlineCommentInput[];
}

export interface PullRequestReviewMetadata {
  status: PullRequestStatus;
  title: string;
  body: string;
  authorLogin?: string;
  changedFiles: PullRequestChangedFile[];
  reviews: PullRequestReviewSnapshot[];
  comments: PullRequestCommentSnapshot[];
  reviewThreads: PullRequestReviewThreadSnapshot[];
}

export interface PullRequestReviewContext extends PullRequestReviewMetadata {
  diff: string;
  diffTruncated: boolean;
}

export interface PullRequestFileReadOptions {
  startLine?: number;
  endLine?: number;
}

export interface PullRequestFileReadResult {
  path: string;
  ref: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  content: string;
  truncated: boolean;
}

export type MergeMethod = "squash" | "merge" | "rebase";

export interface MergePullRequestOptions extends GitHubMutationOptions {
  method?: string;
}

export interface MergePullRequestResult {
  pullRequest: PullRequestSummary;
  method: MergeMethod;
}

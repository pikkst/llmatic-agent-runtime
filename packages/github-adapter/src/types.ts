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

export type MergeMethod = "squash" | "merge" | "rebase";

export interface MergePullRequestOptions extends GitHubMutationOptions {
  method?: string;
}

export interface MergePullRequestResult {
  pullRequest: PullRequestSummary;
  method: MergeMethod;
}

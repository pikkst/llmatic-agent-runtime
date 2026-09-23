export interface GitProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type GitProcessRunner = (
  executable: string,
  args: string[],
  cwd: string,
) => GitProcessResult;

export interface GitMutationOptions {
  approved?: boolean;
  runner?: GitProcessRunner;
}

export interface GitStatus {
  branch?: string;
  detached: boolean;
  clean: boolean;
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
}

export interface PublishedBranchStatus {
  branch: string;
  upstream: string;
  commitSha: string;
  committedAt?: string;
  aheadOfDefault: number;
  behindDefault: number;
  aheadOfUpstream: number;
  behindUpstream: number;
  fullyPushed: boolean;
}

export interface PublishedBranchSnapshot {
  defaultBranch?: string;
  branches: PublishedBranchStatus[];
}

export interface BranchResult {
  branch: string;
}

export interface CommitResult {
  commitSha: string;
}

export interface PushOptions extends GitMutationOptions {
  remote?: string;
  setUpstream?: boolean;
}

export interface PushResult {
  branch: string;
  remote: string;
}

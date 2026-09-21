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

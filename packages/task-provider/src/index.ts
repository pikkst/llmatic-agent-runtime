export interface TaskProviderOperationOptions {
  approved?: boolean;
}

export interface TaskStatus {
  id: string;
  name: string;
  category?: string;
}

export interface TaskRecord {
  provider: string;
  id: string;
  key: string;
  summary: string;
  description?: string;
  status: TaskStatus;
  issueType?: string;
  priority?: string;
  assignee?: string;
  labels: string[];
  updatedAt?: string;
  webUrl?: string;
}

export interface TaskTransition {
  id: string;
  name: string;
  toStatus?: string;
}

export interface TaskProvider {
  readonly id: string;

  getTask(
    reference: string,
    options?: TaskProviderOperationOptions,
  ): Promise<TaskRecord>;

  listTransitions(
    reference: string,
    options?: TaskProviderOperationOptions,
  ): Promise<TaskTransition[]>;

  addComment(
    reference: string,
    text: string,
    options?: TaskProviderOperationOptions,
  ): Promise<void>;

  transitionTask(
    reference: string,
    transition: string,
    options?: TaskProviderOperationOptions,
  ): Promise<TaskTransition>;
}

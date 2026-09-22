export interface GatewayToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export type GatewayMessage =
  | {
      role: "system" | "user";
      content: string;
    }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: GatewayToolCall[];
    }
  | {
      role: "tool";
      tool_call_id: string;
      content: string;
    };

export interface GatewayTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface GatewayUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface GatewayModelInfo {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
  name?: string;
  context_length?: number;
  pricing?: {
    prompt?: string;
    completion?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface GatewayRoutingHint {
  task?: string;
  avoidModels?: string[];
}

export interface GatewayChatResponse {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: GatewayToolCall[];
    };
    finish_reason?: string;
  }>;
  usage?: GatewayUsage;
}

export type GatewayResponseFormat =
  | { type: "json_object" }
  | {
      type: "json_schema";
      json_schema: {
        name: string;
        strict?: boolean;
        schema: Record<string, unknown>;
      };
    };

export interface GatewayChatRequest {
  model: string;
  messages: GatewayMessage[];
  tools?: GatewayTool[];
  tool_choice?: "none" | "auto" | "required";
  response_format?: GatewayResponseFormat;
  routing?: GatewayRoutingHint;
  max_tokens?: number;
  temperature?: number;
  mode?: string;
}

export type GatewayFetch = typeof fetch;

#!/usr/bin/env node

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createLlmaticMcpServer } from "./server.js";

console.error("LLMatic MCP server starting on stdio.");
void serveStdio(createLlmaticMcpServer);

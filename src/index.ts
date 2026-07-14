#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import {
  runSkillify,
  skillifyResponseSchema
} from './skillify.js';

export const skillifyInputSchema = z.object({
  url: z.string().describe('Public HTTP(S) website URL to turn into a portable skill.')
}).strict();

export const skillifyOutputSchema = skillifyResponseSchema;

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'skillify',
    version: '0.1.0'
  });

  server.registerTool(
    'skillify',
    {
      description: 'Turn a public website into one portable Codex and Claude Code skill.',
      inputSchema: skillifyInputSchema,
      outputSchema: skillifyOutputSchema
    },
    async ({ url }) => {
      const response = await runSkillify({
        url,
        apiKey: process.env.FIRECRAWL_API_KEY
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(response)
        }],
        structuredContent: response
      };
    }
  );

  return server;
}

async function startServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export function isDirectExecution({
  executablePath,
  moduleUrl
}: {
  executablePath?: string | undefined;
  moduleUrl: string;
}): boolean {
  return executablePath !== undefined
    && moduleUrl === pathToFileURL(realpathSync(executablePath)).href;
}

function formatErrorMessage({ error }: { error: unknown }): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.endsWith('.') ? message : `${message}.`;
}

if (isDirectExecution({
  executablePath: process.argv[1],
  moduleUrl: import.meta.url
})) {
  try {
    await startServer();
  } catch (error) {
    console.error(formatErrorMessage({ error }));
    process.exitCode = 1;
  }
}

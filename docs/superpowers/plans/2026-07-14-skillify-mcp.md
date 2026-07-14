# Skillify MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish a TypeScript stdio MCP server that turns one public website URL into one portable `SKILL.md` using Firecrawl.

**Architecture:** A small domain module validates public URLs, asks Firecrawl Agent for structured skill Markdown, and produces a safe URL-derived fallback before the 30-second MCP deadline. A thin stdio entrypoint registers exactly one MCP tool and returns the generated skill plus the required follow-up instruction.

**Tech Stack:** Node.js 22.14+, TypeScript, `@modelcontextprotocol/sdk` v1, Zod v4, native `fetch`, Node's built-in test runner, GitHub Actions, npm Trusted Publishing.

## Global Constraints

- Package: `@devinat1/skillify` version `0.1.0`; MCP tool: `skillify`.
- Input: exactly one public HTTP(S) URL; reject credentials, localhost, and private addresses.
- Output: exactly `skill_markdown` and `next_action_instruction`.
- One portable, self-contained `SKILL.md`; no scripts, references, assets, crawl report, confidence labels, or source metadata.
- Use Firecrawl as the only external service and `FIRECRAWL_API_KEY` as the only credential.
- Return within 30 seconds and fall back to a useful URL-derived skill when Firecrawl has no completed result.
- Keep generated skills at or below 2,000 words.
- Stdio only; no web UI, remote transport, accounts, rate limits, authenticated crawling, recrawls, change detection, or multi-site merging.
- Follow repository TypeScript rules: named parameter objects, no `let`, no non-null assertions, no `.then()`/`.catch()`, strong inferred/schema-derived types, and complete names.

---

### Task 1: Package skeleton and public URL validation

**Files:**
- Create: `package.json`
- Create: `package-lock.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `test/skillify.test.mjs`
- Create: `src/skillify.ts`

**Interfaces:**
- Produces: `validatePublicUrl({ url, resolveHostname? }): Promise<string>`.
- Produces: a strict TypeScript build targeting Node.js 22.

- [ ] **Step 1: Add the package and compiler configuration**

Use ESM, a `dist/index.js` bin, Node 22.14+, `@modelcontextprotocol/sdk`, Zod, TypeScript, and Node types. Configure `npm test` to build and run `node --test test/*.test.mjs`.

- [ ] **Step 2: Write the failing URL-safety tests**

```js
test('rejects non-public URL targets', async () => {
  const rejectedUrls = [
    'file:///etc/passwd',
    'http://localhost',
    'http://127.0.0.1',
    'http://[::1]',
    'https://user:secret@example.com'
  ];

  await Promise.all(rejectedUrls.map(async (url) => {
    await assert.rejects(validatePublicUrl({ url }), /public HTTP\(S\) URL/);
  }));
});

test('accepts a public HTTPS URL', async () => {
  const url = await validatePublicUrl({
    url: 'https://example.com/docs',
    resolveHostname: async () => ['93.184.216.34']
  });

  assert.equal(url, 'https://example.com/docs');
});
```

- [ ] **Step 3: Run the test and verify RED**

Run: `node --test test/skillify.test.mjs`

Expected: FAIL because `dist/skillify.js` does not exist.

- [ ] **Step 4: Implement the minimum stdlib URL validation**

```ts
export async function validatePublicUrl({
  url,
  resolveHostname = resolveHostnameAddresses
}: {
  url: string;
  resolveHostname?: (parameters: { hostname: string }) => Promise<string[]>;
}): Promise<string> {
  const parsedUrl = parseHttpUrl({ url });
  const hostname = parsedUrl.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const addresses = isIP(hostname) === 0
    ? await resolveHostname({ hostname })
    : [hostname];

  if (isLocalHostname({ hostname }) || addresses.some((address) => !isPublicIpAddress({ address }))) {
    throw new Error(PUBLIC_URL_ERROR);
  }

  return parsedUrl.href.replace(/\/$/, parsedUrl.pathname === '/' ? '' : '/');
}
```

Use `node:net` and `node:dns/promises`; permit DNS failure so unreachable public-looking domains can still receive the required speculative fallback.

- [ ] **Step 5: Build and verify GREEN**

Run: `npm test`

Expected: all URL-safety tests pass.

---

### Task 2: Firecrawl generation, fallback, response contract, and word cap

**Files:**
- Modify: `test/skillify.test.mjs`
- Modify: `src/skillify.ts`

**Interfaces:**
- Consumes: normalized public URL from Task 1.
- Produces: `runSkillify({ url, apiKey, fetchImplementation?, resolveHostname? }): Promise<SkillifyResponse>`.
- Produces: `createSkillResponse({ skillMarkdown }): SkillifyResponse`.

- [ ] **Step 1: Write failing behavior tests**

```js
test('returns exactly the two response fields', () => {
  const response = createSkillResponse({ skillMarkdown: '# Skill' });
  assert.deepEqual(Object.keys(response).sort(), [
    'next_action_instruction',
    'skill_markdown'
  ]);
});

test('uses completed Firecrawl Agent skill markdown', async () => {
  const fetchImplementation = createAgentFetch({
    skillMarkdown: '---\nname: editor\ndescription: Improve writing.\n---\n# Editor'
  });
  const response = await runSkillify({
    url: 'https://example.com',
    apiKey: 'fc-test',
    fetchImplementation,
    resolveHostname: async () => ['93.184.216.34']
  });
  assert.match(response.skill_markdown, /name: editor/);
});
```

Also test missing credentials, Firecrawl failure fallback, and the 2,000-word ceiling.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npm test`

Expected: FAIL because response and Firecrawl functions do not exist.

- [ ] **Step 3: Implement Firecrawl Agent polling and fallback**

```ts
export async function runSkillify({
  url,
  apiKey,
  fetchImplementation = fetch,
  resolveHostname
}: {
  url: string;
  apiKey?: string;
  fetchImplementation?: typeof fetch;
  resolveHostname?: (parameters: { hostname: string }) => Promise<string[]>;
}): Promise<z.infer<typeof skillifyResponseSchema>> {
  if (apiKey === undefined || apiKey.trim().length === 0) {
    throw new Error('FIRECRAWL_API_KEY is required. Set it before starting @devinat1/skillify.');
  }

  const normalizedUrl = await validatePublicUrl({ url, resolveHostname });
  const skillMarkdown = await generateWithDeadline({
    url: normalizedUrl,
    apiKey,
    fetchImplementation,
    timeoutMilliseconds: 29_000
  });
  return createSkillResponse({ skillMarkdown });
}
```

POST to `https://api.firecrawl.dev/v2/agent` with `spark-1-mini`, the source URL, a strict two-field extraction schema containing `skill_markdown`, and a prompt that requests a portable self-contained skill under 1,800 words. Poll the returned job using native `fetch`; cancel before the hard deadline. Validate all Firecrawl JSON with Zod. If Firecrawl fails or remains incomplete, derive a simple skill name and instructions from the URL hostname.

- [ ] **Step 4: Enforce portable Markdown and word count**

Strip an enclosing Markdown code fence when present, add valid `name` and `description` frontmatter only when Firecrawl omitted it, and cap the final Markdown at 2,000 whitespace-delimited words.

- [ ] **Step 5: Run tests and verify GREEN**

Run: `npm test && npm run typecheck`

Expected: all tests pass and TypeScript reports no errors.

---

### Task 3: MCP stdio entrypoint and package documentation

**Files:**
- Create: `src/index.ts`
- Create: `README.md`
- Create: `LICENSE`
- Modify: `test/skillify.test.mjs`

**Interfaces:**
- Consumes: `runSkillify` from Task 2.
- Produces: executable `dist/index.js` and MCP tool `skillify`.

- [ ] **Step 1: Add a failing schema assertion**

Extend the test to assert the exported input schema rejects unknown fields and the output schema accepts exactly the two required string fields.

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test`

Expected: FAIL because MCP schemas and entrypoint are absent.

- [ ] **Step 3: Register the one MCP tool**

```ts
#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { runSkillify } from './skillify.js';

export const skillifyInputSchema = z.object({
  url: z.string().describe('Public HTTP(S) website URL to turn into a portable skill.')
}).strict();

export const skillifyOutputSchema = z.object({
  skill_markdown: z.string(),
  next_action_instruction: z.string()
}).strict();

export function createServer(): McpServer {
  const server = new McpServer({ name: 'skillify', version: '0.1.0' });
  server.registerTool('skillify', {
    description: 'Turn a public website into a portable Codex and Claude Code skill.',
    inputSchema: skillifyInputSchema,
    outputSchema: skillifyOutputSchema
  }, async ({ url }) => {
    const response = await runSkillify({ url, apiKey: process.env.FIRECRAWL_API_KEY });
    return {
      content: [{ type: 'text', text: JSON.stringify(response) }],
      structuredContent: response
    };
  });
  return server;
}
```

Connect only `StdioServerTransport`. Catch top-level errors with `try/catch`; never write logs to stdout.

- [ ] **Step 4: Document installation and configuration**

Document `npx @devinat1/skillify`, `FIRECRAWL_API_KEY`, minimal Codex/Claude MCP configuration, the tool contract, the 30-second best-effort behavior, and supported public URLs.

- [ ] **Step 5: Add MIT license and verify package contents**

Run: `npm test && npm pack --dry-run`

Expected: tests pass; tarball contains only compiled runtime files, README, package metadata, and license.

---

### Task 4: Release automation and end-to-end verification

**Files:**
- Create: `.github/workflows/publish.yml`
- Modify: `README.md` only if verification uncovers an installation correction.

**Interfaces:**
- Consumes: tested npm package from Task 3.
- Produces: public GitHub repository, npm `0.1.0`, tags, and OIDC patch-release workflow.

- [ ] **Step 1: Add the patch release workflow**

Use GitHub-hosted Node 24 with `contents: write` and `id-token: write`. On non-release pushes to `main`, run `npm ci`, tests, and build; run `npm version patch` with `chore: release %s [skip release]`; push the release commit and tag; publish with npm Trusted Publishing. Exclude release commits to prevent recursion.

- [ ] **Step 2: Run fresh local verification**

Run: `npm test && npm run typecheck && npm pack --dry-run`

Expected: zero test/type failures and expected package contents.

- [ ] **Step 3: Run the live Grammarly acceptance check**

Invoke `runSkillify` against `https://www.grammarly.com` with the real Firecrawl key and measure wall time.

Expected: at most 30 seconds; returned skill frontmatter is portable; at most 2,000 words; instructions accept a writing sample and produce a corrected rewrite with concise grammar, clarity, and tone explanations.

- [ ] **Step 4: Verify the packed executable through MCP**

Pack/install the tarball in a temporary directory. Spawn it through `npx`, complete MCP initialization, list tools, and call `skillify` with a mocked/local-safe path where possible and the live key for final invocation.

Expected: one tool named `skillify`; invocation returns the exact two-field structured response.

- [ ] **Step 5: Publish and configure trusted publishing**

Create `github.com/devinat1/skillify`, commit with `[skip release]`, tag `v0.1.0`, push, and publish `@devinat1/skillify@0.1.0`. Configure npm trust for GitHub repository `devinat1/skillify`, workflow `publish.yml`, action `npm publish`.

- [ ] **Step 6: Exercise automatic patch publication**

Push one non-release change to `main`, wait for GitHub Actions, and inspect the resulting release commit, `v0.1.1` tag, and npm version.

Expected: the workflow succeeds once; its generated release commit does not trigger a second release.

- [ ] **Step 7: Completion audit**

Verify with `gh repo view`, `gh run list/view`, `git ls-remote --tags`, `npm view @devinat1/skillify`, `npm pack @devinat1/skillify`, and an MCP invocation through `npx @devinat1/skillify`. Record exact commands, exit codes, elapsed time, test counts, public URLs, and any unmet requirement before making a completion claim.

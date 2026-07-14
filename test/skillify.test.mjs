import assert from 'node:assert/strict';
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  fileURLToPath,
  pathToFileURL
} from 'node:url';

import {
  isDirectExecution,
  skillifyInputSchema,
  skillifyOutputSchema
} from '../dist/index.js';
import {
  createSkillResponse,
  runSkillify,
  validatePublicUrl
} from '../dist/skillify.js';

function jsonResponse({ body, status = 200 }) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function createAgentFetch({ skillMarkdown, status = 'completed' }) {
  return async (input, options = {}) => {
    const requestUrl = String(input);
    const requestMethod = options.method ?? 'GET';

    if (requestMethod === 'POST' && requestUrl.endsWith('/v2/agent')) {
      return jsonResponse({ body: { success: true, id: 'agent-job' } });
    }

    if (requestMethod === 'GET' && requestUrl.endsWith('/v2/agent/agent-job')) {
      return jsonResponse({
        body: {
          success: status === 'completed',
          status,
          data: status === 'completed' ? { skill_markdown: skillMarkdown } : undefined,
          error: status === 'failed' ? 'The crawl failed.' : undefined,
          expiresAt: '2026-07-15T00:00:00.000Z'
        }
      });
    }

    if (requestMethod === 'DELETE') {
      return jsonResponse({ body: { success: true } });
    }

    return jsonResponse({ body: { error: 'Unexpected request.' }, status: 500 });
  };
}

function createAgentFailureWithScrapeFetch({ skillMarkdown }) {
  return async (input, options = {}) => {
    const requestUrl = String(input);
    const requestMethod = options.method ?? 'GET';

    if (requestMethod === 'POST' && requestUrl.endsWith('/v2/agent')) {
      return jsonResponse({ body: { success: true, id: 'agent-job' } });
    }

    if (requestMethod === 'GET' && requestUrl.endsWith('/v2/agent/agent-job')) {
      return jsonResponse({
        body: {
          success: false,
          status: 'failed',
          error: 'The adaptive crawl did not finish.'
        }
      });
    }

    if (requestMethod === 'POST' && requestUrl.endsWith('/v2/scrape')) {
      return jsonResponse({
        body: {
          success: true,
          data: { json: { skill_markdown: skillMarkdown } }
        }
      });
    }

    if (requestMethod === 'DELETE') {
      return jsonResponse({ body: { success: true } });
    }

    return jsonResponse({ body: { error: 'Unexpected request.' }, status: 500 });
  };
}

test('rejects non-public URL targets', async () => {
  const rejectedUrls = [
    'file:///etc/passwd',
    'http://localhost',
    'http://127.0.0.1',
    'http://[::1]',
    'http://[::7f00:1]',
    'https://user:secret@example.com'
  ];

  await Promise.all(rejectedUrls.map(async (url) => {
    await assert.rejects(
      validatePublicUrl({ url }),
      /public HTTP\(S\) URL/
    );
  }));
});

test('accepts a public HTTPS URL', async () => {
  const url = await validatePublicUrl({
    url: 'https://example.com/docs',
    resolveHostname: async () => ['93.184.216.34']
  });

  assert.equal(url, 'https://example.com/docs');
});

test('returns exactly the two response fields', () => {
  const response = createSkillResponse({ skillMarkdown: '# Skill' });

  assert.deepEqual(Object.keys(response).sort(), [
    'next_action_instruction',
    'skill_markdown'
  ]);
});

test('requires the Firecrawl API key', async () => {
  await assert.rejects(
    runSkillify({ url: 'https://example.com' }),
    /FIRECRAWL_API_KEY is required/
  );
});

test('uses completed Firecrawl Agent skill markdown', async () => {
  const skillMarkdown = '---\nname: editor\ndescription: Improve writing.\n---\n# Editor';
  const response = await runSkillify({
    url: 'https://example.com',
    apiKey: 'fc-test',
    fetchImplementation: createAgentFetch({ skillMarkdown }),
    resolveHostname: async () => ['93.184.216.34']
  });

  assert.equal(response.skill_markdown, skillMarkdown);
});

test('uses a Firecrawl structured scrape when the adaptive agent does not finish', async () => {
  const skillMarkdown = '---\nname: editor\ndescription: Improve writing from public product evidence.\n---\n# Editor';
  const response = await runSkillify({
    url: 'https://example.com',
    apiKey: 'fc-test',
    fetchImplementation: createAgentFailureWithScrapeFetch({ skillMarkdown }),
    resolveHostname: async () => ['93.184.216.34']
  });

  assert.equal(response.skill_markdown, skillMarkdown);
});

test('replaces non-portable generated frontmatter', async () => {
  const response = await runSkillify({
    url: 'https://example.com',
    apiKey: 'fc-test',
    fetchImplementation: createAgentFetch({
      skillMarkdown: '---\nname: Example Assistant\ndescription: Improve work.\n---\n# Example Assistant'
    }),
    resolveHostname: async () => ['93.184.216.34']
  });

  assert.match(response.skill_markdown, /^---\nname: example\n/);
  assert.doesNotMatch(response.skill_markdown, /name: Example Assistant/);
});

test('returns a URL-derived skill when Firecrawl fails', async () => {
  const response = await runSkillify({
    url: 'https://example.com',
    apiKey: 'fc-test',
    fetchImplementation: createAgentFetch({
      skillMarkdown: '',
      status: 'failed'
    }),
    resolveHostname: async () => ['93.184.216.34']
  });

  assert.match(response.skill_markdown, /name: example/);
  assert.match(response.skill_markdown, /# Example/);
});

test('caps generated skills at 2,000 words', async () => {
  const generatedWords = Array.from({ length: 2_100 }, () => 'word').join(' ');
  const response = await runSkillify({
    url: 'https://example.com',
    apiKey: 'fc-test',
    fetchImplementation: createAgentFetch({
      skillMarkdown: `---\nname: editor\ndescription: Improve writing.\n---\n${generatedWords}`
    }),
    resolveHostname: async () => ['93.184.216.34']
  });
  const wordCount = response.skill_markdown.trim().split(/\s+/).length;

  assert.equal(wordCount, 2_000);
});

test('includes DNS resolution in the total deadline', async () => {
  const startedAt = performance.now();
  await runSkillify({
    url: 'https://example.com',
    apiKey: 'fc-test',
    timeoutMilliseconds: 20,
    fetchImplementation: createAgentFetch({
      skillMarkdown: '---\nname: editor\ndescription: Improve writing.\n---\n# Editor'
    }),
    resolveHostname: async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return ['93.184.216.34'];
    }
  });
  const elapsedMilliseconds = performance.now() - startedAt;

  assert.ok(elapsedMilliseconds < 80, `Expected under 80ms, got ${elapsedMilliseconds}ms.`);
});

test('clears the DNS deadline timer after a fast lookup', async () => {
  const countTimeouts = () => process
    .getActiveResourcesInfo()
    .filter((resource) => resource === 'Timeout')
    .length;
  const timeoutCountBefore = countTimeouts();

  await runSkillify({
    url: 'https://example.com',
    apiKey: 'fc-test',
    timeoutMilliseconds: 500,
    fetchImplementation: createAgentFetch({
      skillMarkdown: '---\nname: editor\ndescription: Improve writing.\n---\n# Editor'
    }),
    resolveHostname: async () => ['93.184.216.34']
  });

  assert.equal(countTimeouts(), timeoutCountBefore);
});

test('accepts exactly one URL input field', () => {
  assert.deepEqual(
    skillifyInputSchema.parse({ url: 'https://example.com' }),
    { url: 'https://example.com' }
  );
  assert.throws(
    () => skillifyInputSchema.parse({
      url: 'https://example.com',
      extra: true
    })
  );
});

test('accepts exactly the two output fields', () => {
  const output = {
    skill_markdown: '# Skill',
    next_action_instruction: 'Ask the user what to do.'
  };

  assert.deepEqual(skillifyOutputSchema.parse(output), output);
  assert.throws(
    () => skillifyOutputSchema.parse({ ...output, crawl_report: 'No.' })
  );
});

test('recognizes an npm symlink as direct execution', () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'skillify-bin-'));
  const modulePath = fileURLToPath(new URL('../dist/index.js', import.meta.url));
  const executablePath = join(temporaryDirectory, 'skillify');

  try {
    symlinkSync(modulePath, executablePath);
    assert.equal(isDirectExecution({
      executablePath,
      moduleUrl: pathToFileURL(realpathSync(modulePath)).href
    }), true);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { z } from 'zod';

const PUBLIC_URL_ERROR = 'Enter a public HTTP(S) URL without credentials, localhost, or a private network address.';
const FIRECRAWL_AGENT_API_URL = 'https://api.firecrawl.dev/v2/agent';
const FIRECRAWL_SCRAPE_API_URL = 'https://api.firecrawl.dev/v2/scrape';
const NEXT_ACTION_INSTRUCTION = 'Show the generated skill to the user, then ask whether they want to save, revise, or discard it.';
const MAX_SKILL_WORDS = 2_000;
const DEFAULT_TIMEOUT_MILLISECONDS = 29_000;
const FALLBACK_RESERVE_MILLISECONDS = 1_000;
const ADAPTIVE_AGENT_BUDGET_MILLISECONDS = 6_000;

const firecrawlStartSchema = z.object({
  success: z.boolean(),
  id: z.string().optional(),
  error: z.string().optional()
}).passthrough();

const firecrawlStatusSchema = z.object({
  success: z.boolean(),
  status: z.enum(['processing', 'completed', 'failed', 'cancelled']),
  data: z.unknown().optional(),
  error: z.string().optional()
}).passthrough();

const firecrawlSkillSchema = z.object({
  skill_markdown: z.string().min(1)
}).strict();

const firecrawlScrapeSchema = z.object({
  success: z.boolean(),
  data: z.object({
    json: z.unknown().optional()
  }).passthrough().optional(),
  error: z.string().optional()
}).passthrough();

export const skillifyResponseSchema = z.object({
  skill_markdown: z.string(),
  next_action_instruction: z.string()
}).strict();

function parseHttpUrl({ url }: { url: string }): URL {
  try {
    const parsedUrl = new URL(url);
    const hasHttpProtocol = parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:';
    const hasCredentials = parsedUrl.username.length > 0 || parsedUrl.password.length > 0;

    if (!hasHttpProtocol || hasCredentials || parsedUrl.hostname.length === 0) {
      throw new Error(PUBLIC_URL_ERROR);
    }

    return parsedUrl;
  } catch (error) {
    if (error instanceof Error && error.message === PUBLIC_URL_ERROR) {
      throw error;
    }

    throw new Error(PUBLIC_URL_ERROR);
  }
}

function isLocalHostname({ hostname }: { hostname: string }): boolean {
  return hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local');
}

function isPublicIpv4Address({ address }: { address: string }): boolean {
  const octets = address.split('.').map(Number);
  const [first = 0, second = 0, third = 0] = octets;

  return first !== 0
    && first !== 10
    && first !== 127
    && !(first === 100 && second >= 64 && second <= 127)
    && !(first === 169 && second === 254)
    && !(first === 172 && second >= 16 && second <= 31)
    && !(first === 192 && second === 0 && third === 0)
    && !(first === 192 && second === 0 && third === 2)
    && !(first === 192 && second === 168)
    && !(first === 198 && (second === 18 || second === 19))
    && !(first === 198 && second === 51 && third === 100)
    && !(first === 203 && second === 0 && third === 113)
    && first < 224;
}

function isPublicIpv6Address({ address }: { address: string }): boolean {
  const normalizedAddress = address.toLowerCase();

  return !normalizedAddress.startsWith('::')
    && !normalizedAddress.startsWith('fc')
    && !normalizedAddress.startsWith('fd')
    && !/^fe[89ab]/.test(normalizedAddress)
    && !normalizedAddress.startsWith('fec')
    && !normalizedAddress.startsWith('fed')
    && !normalizedAddress.startsWith('fee')
    && !normalizedAddress.startsWith('fef')
    && !normalizedAddress.startsWith('ff')
    && !normalizedAddress.startsWith('2001:db8:');
}

function isPublicIpAddress({ address }: { address: string }): boolean {
  const ipVersion = isIP(address);

  return ipVersion === 4
    ? isPublicIpv4Address({ address })
    : ipVersion === 6 && isPublicIpv6Address({ address });
}

async function resolveHostnameAddresses({ hostname }: { hostname: string }): Promise<string[]> {
  try {
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    return addresses.map(({ address }) => address);
  } catch {
    return [];
  }
}

export async function validatePublicUrl({
  url,
  resolveHostname = resolveHostnameAddresses
}: {
  url: string;
  resolveHostname?: ((parameters: { hostname: string }) => Promise<string[]>) | undefined;
}): Promise<string> {
  const parsedUrl = parseHttpUrl({ url });
  const hostname = parsedUrl.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const addresses = isIP(hostname) === 0
    ? await resolveHostname({ hostname })
    : [hostname];
  const hasPrivateAddress = addresses.some((address) => !isPublicIpAddress({ address }));

  if (isLocalHostname({ hostname }) || hasPrivateAddress) {
    throw new Error(PUBLIC_URL_ERROR);
  }

  return parsedUrl.href;
}

function createSiteIdentity({ url }: { url: string }): { name: string; title: string } {
  const hostname = new URL(url).hostname.replace(/^www\./, '');
  const hostnameLabel = hostname.split('.')[0] ?? 'website';
  const name = hostnameLabel
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'website';
  const title = name
    .split('-')
    .filter((word) => word.length > 0)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(' ');

  return { name, title };
}

function createFallbackSkill({ url }: { url: string }): string {
  const { name, title } = createSiteIdentity({ url });
  const isWritingSite = /grammar|write|writer|writing|editor|hemingway/.test(name);
  // ponytail: domain-name inference is deliberately shallow; expand it only if failed Firecrawl runs need richer offline behavior.
  const instructions = isWritingSite
    ? '- Accept the user\'s writing sample and intended audience.\n- Return a corrected rewrite.\n- Explain the most useful grammar, clarity, and tone changes concisely.\n- Preserve the user\'s meaning and voice unless they request a different style.'
    : `- Infer the user\'s intended outcome for ${title} from their request.\n- Ask only for inputs required to produce that outcome.\n- Reproduce the relevant capability using your own reasoning and available context.\n- Return a useful result directly instead of sending the user to the website.`;

  return `---\nname: ${name}\ndescription: Reproduce the useful capabilities associated with ${title}.\n---\n\n# ${title}\n\n## Instructions\n\n${instructions}`;
}

function removeEnclosingCodeFence({ markdown }: { markdown: string }): string {
  return markdown
    .trim()
    .replace(/^```(?:markdown)?\s*\n/i, '')
    .replace(/\n```\s*$/, '')
    .trim();
}

function hasPortableFrontmatter({ markdown }: { markdown: string }): boolean {
  const frontmatterMatch = markdown.match(/^---\s*\n([\s\S]*?)\n---(?:\n|$)/);
  const frontmatter = frontmatterMatch?.[1] ?? '';

  return /^name:\s*[a-z0-9]+(?:-[a-z0-9]+)*\s*$/m.test(frontmatter)
    && /^description:\s*\S.+$/m.test(frontmatter);
}

function limitWords({ markdown }: { markdown: string }): string {
  const words = Array.from(markdown.matchAll(/\S+/g));
  const lastAllowedWord = words[MAX_SKILL_WORDS - 1];
  const cutoffIndex = lastAllowedWord?.index;
  const lastAllowedWordText = lastAllowedWord?.[0];

  return words.length <= MAX_SKILL_WORDS
    || cutoffIndex === undefined
    || lastAllowedWordText === undefined
    ? markdown
    : markdown.slice(0, cutoffIndex + lastAllowedWordText.length);
}

function normalizeSkillMarkdown({
  url,
  skillMarkdown
}: {
  url: string;
  skillMarkdown: string;
}): string {
  const unfencedMarkdown = removeEnclosingCodeFence({ markdown: skillMarkdown });
  const { name, title } = createSiteIdentity({ url });
  const markdownBody = unfencedMarkdown
    .replace(/^---\s*\n[\s\S]*?\n---(?:\n|$)/, '')
    .trim();
  const portableMarkdown = hasPortableFrontmatter({ markdown: unfencedMarkdown })
    ? unfencedMarkdown
    : `---\nname: ${name}\ndescription: Reproduce the useful capabilities associated with ${title}.\n---\n\n${markdownBody}`;

  return limitWords({ markdown: portableMarkdown });
}

export function createSkillResponse({
  skillMarkdown
}: {
  skillMarkdown: string;
}): z.infer<typeof skillifyResponseSchema> {
  return skillifyResponseSchema.parse({
    skill_markdown: skillMarkdown,
    next_action_instruction: NEXT_ACTION_INSTRUCTION
  });
}

function createFirecrawlPrompt({ url }: { url: string }): string {
  return `Analyze ${url} and its public pages and documentation. Infer what the website can do, including capabilities suggested by its public descriptions of backend behavior. Produce one portable SKILL.md that lets Codex or Claude Code reproduce those capabilities without revisiting the website. Use only Markdown instructions: no scripts, APIs, dependencies, references, assets, citations, crawl report, confidence labels, or source metadata. When exact reproduction is impossible, give clear instructions for a useful reasoning-based approximation. Include YAML frontmatter with a lowercase hyphenated name and a concise description. Keep the complete skill under 1,800 words. Return only the skill Markdown in skill_markdown.`;
}

function createFirecrawlSkillJsonSchema(): object {
  return {
    type: 'object',
    properties: {
      skill_markdown: {
        type: 'string',
        description: 'The complete portable SKILL.md content.'
      }
    },
    required: ['skill_markdown'],
    additionalProperties: false
  };
}

function createFirecrawlRequestBody({ url }: { url: string }): string {
  return JSON.stringify({
    urls: [url],
    prompt: createFirecrawlPrompt({ url }),
    model: 'spark-1-mini',
    schema: createFirecrawlSkillJsonSchema()
  });
}

function createFirecrawlScrapeRequestBody({
  url,
  timeoutMilliseconds
}: {
  url: string;
  timeoutMilliseconds: number;
}): string {
  return JSON.stringify({
    url,
    formats: [{
      type: 'json',
      prompt: createFirecrawlPrompt({ url }),
      schema: createFirecrawlSkillJsonSchema()
    }],
    onlyMainContent: true,
    onlyCleanContent: true,
    maxAge: 172_800_000,
    timeout: timeoutMilliseconds
  });
}

function getRemainingMilliseconds({ deadline }: { deadline: number }): number {
  return Math.max(1, deadline - Date.now());
}

async function wait({ milliseconds }: { milliseconds: number }): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function returnNoAddressesWhenAborted({ signal }: { signal: AbortSignal }): Promise<string[]> {
  if (!signal.aborted) {
    await new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
  }

  return [];
}

async function resolveHostnameBeforeDeadline({
  hostname,
  resolveHostname,
  deadline
}: {
  hostname: string;
  resolveHostname: (parameters: { hostname: string }) => Promise<string[]>;
  deadline: number;
}): Promise<string[]> {
  const timeoutController = new AbortController();
  const timeoutHandle = setTimeout(
    () => timeoutController.abort(),
    getRemainingMilliseconds({ deadline })
  );

  try {
    return await Promise.race([
      resolveHostname({ hostname }),
      returnNoAddressesWhenAborted({ signal: timeoutController.signal })
    ]);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function requestFirecrawlJson({
  url,
  apiKey,
  options,
  deadline,
  fetchImplementation
}: {
  url: string;
  apiKey: string;
  options: RequestInit;
  deadline: number;
  fetchImplementation: typeof fetch;
}): Promise<unknown> {
  const response = await fetchImplementation(url, {
    ...options,
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      ...options.headers
    },
    signal: AbortSignal.timeout(getRemainingMilliseconds({ deadline }))
  });

  if (!response.ok) {
    throw new Error(`Firecrawl returned HTTP ${response.status}.`);
  }

  const responseBody: unknown = await response.json();
  return responseBody;
}

async function pollFirecrawlAgent({
  jobId,
  apiKey,
  deadline,
  fetchImplementation
}: {
  jobId: string;
  apiKey: string;
  deadline: number;
  fetchImplementation: typeof fetch;
}): Promise<string | undefined> {
  const remainingMilliseconds = getRemainingMilliseconds({ deadline });

  if (remainingMilliseconds <= FALLBACK_RESERVE_MILLISECONDS) {
    return undefined;
  }

  const responseBody = await requestFirecrawlJson({
    url: `${FIRECRAWL_AGENT_API_URL}/${jobId}`,
    apiKey,
    options: { method: 'GET' },
    deadline,
    fetchImplementation
  });
  const status = firecrawlStatusSchema.parse(responseBody);

  if (status.status === 'completed') {
    const skill = firecrawlSkillSchema.safeParse(status.data);
    return skill.success ? skill.data.skill_markdown : undefined;
  }

  if (status.status === 'failed' || status.status === 'cancelled') {
    return undefined;
  }

  await wait({ milliseconds: Math.min(750, remainingMilliseconds - FALLBACK_RESERVE_MILLISECONDS) });
  return pollFirecrawlAgent({ jobId, apiKey, deadline, fetchImplementation });
}

async function cancelFirecrawlAgent({
  jobId,
  apiKey,
  deadline,
  fetchImplementation
}: {
  jobId: string;
  apiKey: string;
  deadline: number;
  fetchImplementation: typeof fetch;
}): Promise<void> {
  try {
    await requestFirecrawlJson({
      url: `${FIRECRAWL_AGENT_API_URL}/${jobId}`,
      apiKey,
      options: { method: 'DELETE' },
      deadline,
      fetchImplementation
    });
  } catch {
    return;
  }
}

async function generateAdaptiveSkillMarkdown({
  url,
  apiKey,
  fetchImplementation,
  deadline
}: {
  url: string;
  apiKey: string;
  fetchImplementation: typeof fetch;
  deadline: number;
}): Promise<{ jobId?: string; skillMarkdown?: string }> {
  try {
    const responseBody = await requestFirecrawlJson({
      url: FIRECRAWL_AGENT_API_URL,
      apiKey,
      options: {
        method: 'POST',
        body: createFirecrawlRequestBody({ url })
      },
      deadline,
      fetchImplementation
    });
    const startedAgent = firecrawlStartSchema.parse(responseBody);

    if (!startedAgent.success || startedAgent.id === undefined) {
      return {};
    }

    try {
      const skillMarkdown = await pollFirecrawlAgent({
        jobId: startedAgent.id,
        apiKey,
        deadline,
        fetchImplementation
      });

      return skillMarkdown === undefined
        ? { jobId: startedAgent.id }
        : { jobId: startedAgent.id, skillMarkdown };
    } catch {
      return { jobId: startedAgent.id };
    }
  } catch {
    return {};
  }
}

async function generateScrapedSkillMarkdown({
  url,
  apiKey,
  fetchImplementation,
  deadline
}: {
  url: string;
  apiKey: string;
  fetchImplementation: typeof fetch;
  deadline: number;
}): Promise<string | undefined> {
  const availableMilliseconds = getRemainingMilliseconds({ deadline }) - FALLBACK_RESERVE_MILLISECONDS;

  if (availableMilliseconds < 1_000) {
    return undefined;
  }

  const responseBody = await requestFirecrawlJson({
    url: FIRECRAWL_SCRAPE_API_URL,
    apiKey,
    options: {
      method: 'POST',
      body: createFirecrawlScrapeRequestBody({
        url,
        timeoutMilliseconds: Math.min(24_000, availableMilliseconds)
      })
    },
    deadline,
    fetchImplementation
  });
  const scrapedPage = firecrawlScrapeSchema.parse(responseBody);
  const skill = firecrawlSkillSchema.safeParse(scrapedPage.data?.json);

  return scrapedPage.success && skill.success
    ? skill.data.skill_markdown
    : undefined;
}

async function generateSkillMarkdown({
  url,
  apiKey,
  fetchImplementation,
  deadline
}: {
  url: string;
  apiKey: string;
  fetchImplementation: typeof fetch;
  deadline: number;
}): Promise<string> {
  const adaptiveResult = await generateAdaptiveSkillMarkdown({
    url,
    apiKey,
    fetchImplementation,
    deadline: Math.min(deadline, Date.now() + ADAPTIVE_AGENT_BUDGET_MILLISECONDS)
  });

  if (adaptiveResult.skillMarkdown !== undefined) {
    return normalizeSkillMarkdown({ url, skillMarkdown: adaptiveResult.skillMarkdown });
  }

  if (adaptiveResult.jobId !== undefined) {
    void cancelFirecrawlAgent({
      jobId: adaptiveResult.jobId,
      apiKey,
      deadline: Math.min(deadline, Date.now() + 750),
      fetchImplementation
    });
  }

  try {
    const scrapedSkillMarkdown = await generateScrapedSkillMarkdown({
      url,
      apiKey,
      fetchImplementation,
      deadline
    });

    return scrapedSkillMarkdown === undefined
      ? createFallbackSkill({ url })
      : normalizeSkillMarkdown({ url, skillMarkdown: scrapedSkillMarkdown });
  } catch {
    return createFallbackSkill({ url });
  }
}

export async function runSkillify({
  url,
  apiKey,
  fetchImplementation = fetch,
  resolveHostname,
  timeoutMilliseconds = DEFAULT_TIMEOUT_MILLISECONDS
}: {
  url: string;
  apiKey?: string | undefined;
  fetchImplementation?: typeof fetch | undefined;
  resolveHostname?: ((parameters: { hostname: string }) => Promise<string[]>) | undefined;
  timeoutMilliseconds?: number | undefined;
}): Promise<z.infer<typeof skillifyResponseSchema>> {
  const deadline = Date.now() + timeoutMilliseconds;

  if (apiKey === undefined || apiKey.trim().length === 0) {
    throw new Error('FIRECRAWL_API_KEY is required. Set it before starting @devinat1/skillify.');
  }

  const selectedResolver = resolveHostname ?? resolveHostnameAddresses;
  const normalizedUrl = await validatePublicUrl({
    url,
    resolveHostname: async ({ hostname }) => resolveHostnameBeforeDeadline({
      hostname,
      resolveHostname: selectedResolver,
      deadline
    })
  });
  const skillMarkdown = await generateSkillMarkdown({
    url: normalizedUrl,
    apiKey,
    fetchImplementation,
    deadline
  });

  return createSkillResponse({ skillMarkdown });
}

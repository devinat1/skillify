# Skillify

Turn a public website into one portable `SKILL.md` through MCP.

## Run

Set a [Firecrawl API key](https://www.firecrawl.dev/app/api-keys), then configure your MCP client to start:

```sh
npx -y @devinat1/skillify
```

with this environment variable:

```text
FIRECRAWL_API_KEY=fc-your-key
```

The server uses local stdio transport. A generic MCP configuration looks like:

```json
{
  "command": "npx",
  "args": ["-y", "@devinat1/skillify"],
  "env": {
    "FIRECRAWL_API_KEY": "fc-your-key"
  }
}
```

## Tool

`skillify` accepts exactly one argument:

```json
{
  "url": "https://www.grammarly.com"
}
```

It returns:

```json
{
  "skill_markdown": "---\nname: ...\ndescription: ...\n---\n...",
  "next_action_instruction": "Show the generated skill to the user, then ask whether they want to save, revise, or discard it."
}
```

Skillify first asks Firecrawl Agent to inspect the site's public pages and produce a self-contained skill compatible with Codex and Claude Code. If the adaptive crawl does not finish quickly, it switches to Firecrawl's structured scrape. Calls return within 30 seconds; if Firecrawl is unavailable, Skillify returns a best-effort skill inferred from the URL.

Only public HTTP(S) URLs are accepted. Localhost, private-network addresses, non-HTTP URLs, and URLs containing credentials are rejected.

## Develop

Requires Node.js 22.14 or newer.

```sh
npm install
npm test
npm run typecheck
```

## License

MIT

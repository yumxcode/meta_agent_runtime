Search the web. Provider chain: Tavily (direct API) → GLM web-search-prime (MCP) → Anthropic native web search.

Usage:
- query: search query (minimum 2 characters)
- allowed_domains: only include results from these domains
- blocked_domains: exclude results from these domains
- Always include a Sources section in your response with URLs

Configuration (first available provider in chain order is used):
- TAVILY_API_KEY — preferred: purpose-built search API, structured results
- ZHIPU_API_KEY  — enables the GLM web-search-prime MCP fallback
- ANTHROPIC_API_KEY — last resort: full Claude side-call per search (most expensive)
- META_AGENT_SEARCH_PROVIDER=tavily|glm|anthropic pins a single provider (no fallback)

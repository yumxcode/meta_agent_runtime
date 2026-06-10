Fetch the raw content of ONE specific URL and return it as text.

This is a plain HTTP GET — NOT a search engine and NOT an AI extractor:
- It does NOT search. You must already know the exact URL you want.
- The `prompt` field is only a note echoed back in the output; it does NOT
  filter, extract, or drive the fetch. The full page text is returned regardless.
- HTML is stripped to plain text. JavaScript is NOT executed, so client-rendered
  (SPA) pages often return an empty or near-empty shell.

Parameters:
- url: the exact HTTPS URL to fetch (HTTP is upgraded to HTTPS automatically).
- prompt: a short note describing what you're looking for (for your own logging).

Do NOT pass search-results pages — they usually 404 or block bots. For example,
`https://github.com/search?q=...` (especially `&type=code`) requires login and
returns 404 to non-browser clients.

Prefer structured JSON API endpoints, which are bot-friendly and stable:
- GitHub repos:   https://api.github.com/search/repositories?q=<keywords>&sort=stars
- GitHub code:    https://api.github.com/search/code?q=<keywords>   (may need auth)
- Papers:         https://api.openalex.org/works?search=<keywords>&per-page=10
- Papers:         https://api.semanticscholar.org/graph/v1/paper/search?query=<keywords>
- arXiv:          https://export.arxiv.org/api/query?search_query=all:<keywords>

If you need to discover URLs (i.e. actually search the web), use the
`web_search` tool instead of guessing URLs here.

Notes:
- Content is cached for 15 minutes.
- Responses are truncated to 100KB.
- A non-2xx status (404/403/etc.) means the server rejected the request — switch
  to an API endpoint or a different source rather than retrying the same URL.

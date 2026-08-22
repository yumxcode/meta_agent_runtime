Find tools that are available but whose full descriptions are not currently loaded, and load them so you can call them.

Some tool groups are large and situational — MCP servers, domain toolkits — so their schemas are kept out of the conversation until you need them. This tool searches those hidden tools by name, namespace and description, and loads the matches for the rest of the session. After a search returns a tool, call it normally.

Parameters:
- `query` — free text. Tool names, a namespace, or what you are trying to do ("read a database row", "post to slack").
- `namespace` — restrict the search to one namespace.
- `limit` — max tools to load. Default 10.

Search before concluding a capability does not exist. A tool being absent from your current list does not mean it is unavailable — it may simply not be loaded yet.

If a search returns nothing useful, the capability genuinely is not connected; say so rather than searching repeatedly with reworded queries.

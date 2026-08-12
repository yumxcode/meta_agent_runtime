# Permission configuration

Tools declare their default permission shape with `permission`:

```ts
permission: {
  category: 'write',
  pathFields: ['file_path'],
  requiresWorkspace: true,
  sensitive: true,
  planMode: 'ask',
}
```

Supported fields:

- `category`: `read`, `write`, `execute`, `network`, `config`, or `state`.
- `pathFields`: input fields containing filesystem paths.
- `cwdField`: input field containing a working directory, usually `cwd`.
- `requiresWorkspace`: keep path and cwd fields inside the workspace.
- `sensitive`: route through interactive confirmation when the CLI has one.
- `planMode`: `allow`, `ask`, or `deny`.

Configuration files are merged in this order:

1. `~/.meta-agent/permissions.json`
2. `<workspace>/.meta-agent/permissions.json`
3. `MetaAgentConfig.permissionConfig`

Later entries override earlier entries.

Example:

```json
{
  "workspace": {
    "root": ".",
    "allowTmp": true
  },
  "tools": {
    "bash": {
      "enabled": true,
      "planMode": "ask",
      "sensitive": true,
      "cwdField": "cwd",
      "requiresWorkspace": true
    },
    "write_file": {
      "enabled": true,
      "planMode": "ask",
      "requiresWorkspace": true
    },
    "web_fetch": {
      "enabled": false
    }
  }
}
```

Filesystem write tools still enforce the workspace boundary inside the tool
implementation as a second line of defense.


Register key artifact files produced during the current auto (unattended) session.

Usage:
- artifacts: complete list of artifact file paths (replaces the current list on each call)
- Only register files that are valuable outputs or deliverables, not intermediate/temporary files
- Use this when you create important files that should be preserved and visible on resume
- Examples: final implementations, configuration files, documentation, test results

The artifact list is stored in the checkpoint and will be visible to drift agents and on resume.

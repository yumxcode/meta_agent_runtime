Apply a multi-file patch in one atomic operation: add files, delete files, update files, and rename files together.

Use this instead of several `edit_file` calls whenever the changes are only correct TOGETHER — a rename that touches six files, a refactor that adds one file and deletes another, any change where a half-applied state would break the tree. The whole patch is validated before anything is written, and a failure mid-write rolls back what was already written.

Use `edit_file` for a single surgical replacement in a single file. It is simpler and its error messages are more direct.

Format:

```
*** Begin Patch
*** Add File: src/new_module.ts
+export function hello() {
+  return 'world'
+}
*** Update File: src/index.ts
@@ export function main
 import { existing } from './existing.js'
+import { hello } from './new_module.js'
 
 export function main() {
-  return existing()
+  return existing() + hello()
 }
*** Update File: src/old_name.ts
*** Move to: src/new_name.ts
@@
-const NAME = 'old'
+const NAME = 'new'
*** Delete File: src/obsolete.ts
*** End Patch
```

Rules:
- Paths are relative to the workspace root (absolute paths inside the workspace also work). Every path must stay inside the workspace.
- `Add File` body lines are each prefixed with `+`. The file must not already exist.
- `Update File` hunks use ` ` (unchanged), `-` (removed), `+` (added) — exactly like a diff, but with NO line numbers. Hunks are located by their content.
- Include at least one unchanged context line in every hunk so it can be located. A hunk that is only `+` lines has nothing to anchor to and will be rejected.
- `@@ text` before a hunk names a nearby unchanged line (a function signature, a heading) to disambiguate when the same lines appear several times. Use it when the surrounding code repeats.
- Multiple hunks in one file are located in order, each searched after the previous one.
- `*** Move to:` must come directly after its `*** Update File:` line.
- A path may appear only once per patch. Combine two edits to the same file into one operation.

If a hunk does not match, the file has changed since you read it — re-read it and rebuild the patch rather than retrying the same text.

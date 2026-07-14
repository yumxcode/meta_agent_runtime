# Loop Scenario plugins

The Loop Kernel contains scheduling, seats, Artifact transactions, projections,
observations, meters, routing, effects and the core ledger. Business semantics
are supplied by trusted `ScenarioPluginV1` modules.

## Loading

Plugins are never discovered or executed implicitly. Load one or more trusted
modules explicitly for every command that creates or resumes their instances:

```bash
meta-agent loop scenarios --scenario-plugin ./plugins/security-review.mjs
meta-agent loop create security-charter.json --scenario-plugin ./plugins/security-review.mjs
meta-agent loop tick --scenario-plugin ./plugins/security-review.mjs
meta-agent loop-scheduler --scenario-plugin ./plugins/security-review.mjs
```

Package specifiers are also supported. The loader resolves them relative to the
workspace and pins the SHA-256 digest of the actual resolved entry file. A
declared `sha256:...` value must match; the loader always replaces other
manifest identities with the measured digest.

## Module ABI

```ts
import type { ScenarioPluginV1 } from '@meta-agent/runtime'

export const scenarioPlugin: ScenarioPluginV1 = {
  manifest: {
    apiVersion: 1,
    id: 'company/security-review@1',
    version: '1.2.0',
    integrity: 'package-sha256:...',
  },
  definition: {
    id: 'company/security-review@1',
    artifacts: charter => ({ /* frozen ArtifactSpec map */ }),
    artifactGateIds: ['producer', 'artifact_drafts'],
    mandatoryArtifactGateIds: ['producer', 'artifact_drafts'],
    allowAdditionalArtifacts: false,
    gateBindings: [],
  },
  runtime: {
    id: 'company/security-review@1',
    producerOutputContract: () => '...',
    runProducerGate: async () => ({ verdict: 'pass', messages: [] }),
    harvestPreface: () => '...',
    renderReport: async () => '...',
  },
}
```

Definitions are expanded into the frozen Charter. The frozen instance records
the plugin API version, implementation version and integrity. Missing or
mismatched plugins are rejected before a wake is claimed, so a scheduler cannot
silently resume an instance under different Scenario code.

Scenario code may provide Capsule views, gate verdicts, wait binding and report
presentation. It cannot replace Kernel routing or Artifact transaction order.
Plugins are trusted host code and therefore must be reviewed like any runtime
dependency.

Async hooks run through the Scenario host boundary: 30-second default deadline,
cooperative `AbortSignal`, serializable output, and a 1 MiB output limit. Hook
execution happens outside the Artifact journal lock. These bounds protect the
runtime from accidental plugin faults; they do not sandbox malicious code or a
synchronous infinite loop.

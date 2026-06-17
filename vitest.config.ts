import { defineConfig } from 'vitest/config'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Isolated per-run data home so tests never touch ~/.meta-agent (which caused
// EPERM on ~/.meta-agent/subtasks under sandboxes and let local config.json
// influence results). Injected via `test.env` so it is set in each worker
// BEFORE metaAgentHome.ts captures it at import time.
const TEST_META_AGENT_HOME = join(tmpdir(), `meta-agent-test-${process.pid}-${Date.now()}`)

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
    setupFiles: ['src/__tests__/setup.ts'],
    env: {
      META_AGENT_HOME: TEST_META_AGENT_HOME,
      META_AGENT_SKIP_MIGRATION: '1',
    },
    pool: 'forks',
    reporter: 'verbose',
  },
})

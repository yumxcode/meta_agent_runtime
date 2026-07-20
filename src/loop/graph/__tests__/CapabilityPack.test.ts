import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { createDefaultGraphRuntimeCatalog, loadGraphCapabilityPacks } from '../index.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

describe('GraphCapabilityPackV1 loader', () => {
  it('loads only an explicit trusted local module and freezes its actual file integrity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'graph-pack-'))
    roots.push(root)
    const path = join(root, 'pack.mjs')
    await writeFile(path, `
      export default {
        apiVersion: 'graph-pack-v1',
        manifest: { id: 'test/math', version: '1', integrity: 'loader' },
        scenarios: [{
          id: 'optimization',
          description: 'Open-ended optimization loops.',
          guidance: ['Keep measurements in a Lane-owned workspace file.', 'Choose topology from the user goal.'],
          suggestedCapabilities: ['test/double@1'],
          graphFragments: [{ id: 'measurement', description: 'One optional workspace idea.', fragment: { workspace: { write: [{ path: 'measurements.jsonl', mode: 'append_only' }] } } }]
        }],
        register(target) {
          target.functions.register({
            manifest: { id: 'test/double', version: '1', integrity: 'test-double-v1', pure: true },
            execute(input) { return Number(input[0]) * 2 }
          })
        }
      }
    `)
    const catalog = createDefaultGraphRuntimeCatalog()
    const loaded = await loadGraphCapabilityPacks({ modulePaths: [path], target: catalog, registry: catalog.packs, allowedRoots: [root] })
    expect(loaded[0]?.manifest.integrity).toMatch(/^sha256:/)
    expect(catalog.packs.has(loaded[0]!.manifest)).toBe(true)
    expect(await catalog.functions.get('test/double@1').execute([4])).toBe(8)
    expect(catalog.packs.scenarios()).toMatchObject([{
      id: 'optimization', pack: { id: 'test/math', version: '1' }, graphFragments: [{ id: 'measurement' }],
    }])
  })

  it('rejects modules outside the operator allowlist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'graph-pack-'))
    const other = await mkdtemp(join(tmpdir(), 'graph-pack-other-'))
    roots.push(root, other)
    const path = join(other, 'pack.mjs')
    await writeFile(path, `export default { apiVersion:'graph-pack-v1', manifest:{id:'x',version:'1',integrity:'loader'}, register(){} }`)
    const catalog = createDefaultGraphRuntimeCatalog()
    await expect(loadGraphCapabilityPacks({ modulePaths: [path], target: catalog, registry: catalog.packs, allowedRoots: [root] }))
      .rejects.toThrow(/outside allowed roots/)
  })
})

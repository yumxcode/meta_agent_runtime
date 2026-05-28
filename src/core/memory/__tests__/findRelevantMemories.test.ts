import { mkdir, rm, utimes, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, it } from 'vitest'
import { findRelevantMemories } from '../findRelevantMemories.js'

// ─────────────────────────────────────────────────────────────────────────────
// Temp-dir lifecycle
// ─────────────────────────────────────────────────────────────────────────────

const tempDirs: string[] = []

async function tempMemoryDir(): Promise<string> {
  const dir = join(tmpdir(), `meta-agent-mem-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await mkdir(dir, { recursive: true })
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(d => rm(d, { recursive: true, force: true })))
})

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function feedbackFrontmatter(name: string) {
  return `---\nname: ${name}\ndescription: ${name} feedback\ntype: feedback\ndate: 2025-01-01\n---\n\n**Rule:** ${name}`
}

function userFrontmatter(name: string) {
  return `---\nname: ${name}\ndescription: ${name} user profile\ntype: user\ndate: 2025-01-01\n---\n\n${name} background`
}

async function writeFeedbackFile(dir: string, name: string, mtimeMsOffset: number) {
  const path = join(dir, `${name}.md`)
  await writeFile(path, feedbackFrontmatter(name), 'utf-8')
  // Set mtime relative to a base timestamp so we can control recency ordering
  const base = new Date('2025-01-01T00:00:00Z').getTime()
  const ts = new Date(base + mtimeMsOffset)
  await utimes(path, ts, ts)
  return path
}

// ─────────────────────────────────────────────────────────────────────────────
// Feedback cap (P2)
// ─────────────────────────────────────────────────────────────────────────────

describe('findRelevantMemories — feedback MAX_FEEDBACK_FILES cap (P2)', () => {
  it('loads all feedback files when count ≤ 5', async () => {
    const dir = await tempMemoryDir()
    for (let i = 0; i < 4; i++) {
      await writeFeedbackFile(dir, `fb_${i}`, i * 1000)
    }
    const results = await findRelevantMemories({ query: 'anything', memoryDir: dir })
    const feedbackResults = results.filter(r => r.header.type === 'feedback')
    expect(feedbackResults).toHaveLength(4)
  })

  it('limits feedback to 5 most recent files when count > 5', async () => {
    const dir = await tempMemoryDir()
    // Write 8 feedback files with known mtime offsets (higher offset = more recent)
    for (let i = 0; i < 8; i++) {
      await writeFeedbackFile(dir, `fb_${i}`, i * 1000)
    }
    const results = await findRelevantMemories({ query: 'anything', memoryDir: dir })
    const feedbackResults = results.filter(r => r.header.type === 'feedback')
    expect(feedbackResults).toHaveLength(5)
  })

  it('keeps the most recent 5 feedback files (not the oldest 5)', async () => {
    const dir = await tempMemoryDir()
    // fb_0 is oldest (offset 0), fb_7 is most recent (offset 7000)
    for (let i = 0; i < 8; i++) {
      await writeFeedbackFile(dir, `fb_${i}`, i * 1000)
    }
    const results = await findRelevantMemories({ query: 'anything', memoryDir: dir })
    const feedbackNames = results
      .filter(r => r.header.type === 'feedback')
      .map(r => r.header.name)

    // Most recent: fb_7, fb_6, fb_5, fb_4, fb_3 (offsets 7000→3000)
    // Oldest should be excluded: fb_0, fb_1, fb_2
    expect(feedbackNames).not.toContain('fb 0')  // name is derived from filename (underscores→spaces)
    expect(feedbackNames).not.toContain('fb 1')
    expect(feedbackNames).not.toContain('fb 2')
  })

  it('user files are never capped (all loaded regardless of count)', async () => {
    const dir = await tempMemoryDir()
    // Write 3 user files (unusual, but the cap should not apply)
    for (let i = 0; i < 3; i++) {
      const path = join(dir, `user_${i}.md`)
      await writeFile(path, userFrontmatter(`user_${i}`), 'utf-8')
    }
    const results = await findRelevantMemories({ query: 'anything', memoryDir: dir })
    const userResults = results.filter(r => r.header.type === 'user')
    expect(userResults).toHaveLength(3)
  })

  it('empty memory dir returns no results without throwing', async () => {
    const dir = await tempMemoryDir()
    const results = await findRelevantMemories({ query: 'anything', memoryDir: dir })
    expect(results).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Unsupported legacy engineering memory types
// ─────────────────────────────────────────────────────────────────────────────

describe('findRelevantMemories — unsupported legacy engineering types', () => {
  it('excludes campaign_lessons in robotics mode', async () => {
    const dir = await tempMemoryDir()
    const path = join(dir, 'battery_threshold.md')
    await writeFile(path,
      '---\nname: battery threshold\ndescription: DOE threshold\ntype: campaign_lessons\ndate: 2025-01-01\n---\n\nThreshold data',
      'utf-8',
    )
    // robotics mode — should NOT load campaign_lessons
    const results = await findRelevantMemories({ query: 'battery', memoryDir: dir, sessionMode: 'robotics' })
    expect(results.filter(r => r.header.type === 'campaign_lessons')).toHaveLength(0)
  })

  it('excludes campaign_lessons in campaign mode too', async () => {
    const dir = await tempMemoryDir()
    const path = join(dir, 'battery_threshold.md')
    await writeFile(path,
      '---\nname: battery threshold\ndescription: DOE threshold\ntype: campaign_lessons\ndate: 2025-01-01\n---\n\nThreshold data',
      'utf-8',
    )
    const results = await findRelevantMemories({ query: 'battery threshold', memoryDir: dir, sessionMode: 'campaign' })
    expect(results.filter(r => r.header.type === 'campaign_lessons')).toHaveLength(0)
  })
})

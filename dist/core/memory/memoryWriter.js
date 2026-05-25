/**
 * Post-session memory writer.
 *
 * Runs a small Haiku side-call at session shutdown to decide whether the
 * conversation contains public, mode-wide memories worth persisting.  The model
 * returns structured proposals only; this module performs all filesystem writes
 * so frontmatter stays constrained and mode boundaries are enforced.
 */
import { appendFile, mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { ensureMemoryDirExists, loadMemoryIndex } from './memdir.js';
import { MEMORY_DIR, MEMORY_ENTRYPOINT_NAME } from './paths.js';
import { MEMORY_TYPES } from './types.js';
/**
 * Default model for the post-session memory writer side-call.
 * Callers can override via RunMemoryWriterOptions.model.
 *
 * Falls back to DeepSeek flash if no model is specified — it is inexpensive
 * and well-suited for the structured-JSON extraction task.  If the caller uses
 * a pure-Anthropic configuration they should pass `model: resolvedConfig.flashModel`
 * so the writer uses the same provider as the rest of the session.
 */
const DEFAULT_MEMORY_WRITER_MODEL = 'deepseek-v4-flash';
const MAX_TRANSCRIPT_CHARS = 32_000;
const MAX_EXISTING_INDEX_CHARS = 8_000;
const MAX_MEMORIES_PER_RUN = 3;
function withTimeout(promise, ms) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${ms} ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
function textFromBlocks(content) {
    if (typeof content === 'string')
        return content;
    return content
        .map(block => {
        if (block.type === 'text')
            return block.text;
        if (block.type === 'tool_use')
            return `[tool_use ${block.name}] ${JSON.stringify(block.input)}`;
        if (block.type === 'tool_result')
            return `[tool_result] ${block.content}`;
        return '';
    })
        .filter(Boolean)
        .join('\n');
}
function buildTranscript(messages) {
    const lines = messages.map((msg, i) => {
        const text = textFromBlocks(msg.content).trim();
        if (!text)
            return '';
        return `### ${i + 1}. ${msg.role}\n${text}`;
    }).filter(Boolean);
    const full = lines.join('\n\n');
    if (full.length <= MAX_TRANSCRIPT_CHARS)
        return full;
    return full.slice(full.length - MAX_TRANSCRIPT_CHARS);
}
function allowedTypesForMode(mode) {
    const base = ['user', 'feedback', 'domain_knowledge', 'reference'];
    if (mode === 'campaign')
        return new Set([...base, 'campaign_lessons']);
    if (mode === 'robotics')
        return new Set([...base, 'robot_lessons']);
    return new Set(base);
}
function sanitizeScalar(value, max = 240) {
    if (typeof value !== 'string')
        return undefined;
    // Strip \r and \n to prevent YAML frontmatter injection (a multi-line value
    // such as "name\ntype: injected" would add an extra key to the frontmatter).
    const trimmed = value.replace(/[\r\n]/g, ' ').trim();
    if (!trimmed)
        return undefined;
    return trimmed.slice(0, max);
}
function sanitizeFilename(value, fallbackName) {
    const raw = sanitizeScalar(value, 120) ?? fallbackName;
    const base = raw
        .toLowerCase()
        .replace(/\.md$/i, '')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 80);
    return `${base || 'memory'}.md`;
}
function stripUnsupportedFrontmatter(text) {
    return text
        .replace(/^---[\s\S]*?---\s*/m, '')
        .replace(/^\s*(campaign|valid_until|confidence)\s*:.*$/gmi, '')
        .trim();
}
function renderMemoryFile(proposal) {
    const lines = [
        '---',
        `name: ${sanitizeScalar(proposal.name, 160)}`,
        `description: ${sanitizeScalar(proposal.description, 240)}`,
        `type: ${sanitizeScalar(proposal.type, 80)}`,
        `date: ${new Date().toISOString().slice(0, 10)}`,
    ];
    const domain = sanitizeScalar(proposal.domain, 80);
    if (domain) {
        lines.push('scope: domain', `domain: ${domain}`);
    }
    const source = sanitizeScalar(proposal.source, 240);
    if (source)
        lines.push(`source: ${source}`);
    if (typeof proposal.source_verified === 'boolean') {
        lines.push(`source_verified: ${proposal.source_verified ? 'true' : 'false'}`);
    }
    if (typeof proposal.requires_revalidation === 'boolean') {
        lines.push(`requires_revalidation: ${proposal.requires_revalidation ? 'true' : 'false'}`);
    }
    lines.push('---', '', stripUnsupportedFrontmatter(String(proposal.body)), '');
    return lines.join('\n');
}
function extractJson(raw) {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match)
        return null;
    try {
        return JSON.parse(match[0]);
    }
    catch {
        return null;
    }
}
function buildSystemPrompt(mode) {
    return `You are a post-session memory curator for meta-agent-runtime.

Decide whether the session contains durable public memories worth saving.

Write memories only when they satisfy ALL criteria:
- Useful for future sessions in the same mode, not just this conversation.
- Public/general enough to apply across sessions.
- Specific enough to be searchable and actionable.
- Not already covered by the existing MEMORY.md index.

Mode-specific boundaries:
- campaign: do NOT save simulation/computation results, active campaign state, or project-specific parameters. Those belong to provenance, campaign_context, and campaign config.
- robotics: do NOT save mature engineering experience, workflows, tuning recipes, or reusable technical knowledge. Those belong to ExperienceStore. Save only public preferences, warnings, repeated mistakes, or risk checks.
- direct/agentic: do NOT save mode-specific campaign or robotics lessons.

Allowed memory types for this mode (${mode}): ${[...allowedTypesForMode(mode)].join(', ')}.

Frontmatter must NOT include campaign, valid_until, or confidence.

Return JSON only:
{"memories":[{"filename":"short_slug.md","name":"...","description":"...","type":"...","domain":"optional","source":"optional","source_verified":true,"requires_revalidation":false,"body":"markdown body","index_line":"- [Name](short_slug.md) - short hook"}]}

If nothing is worth saving, return {"memories":[]}.`;
}
function normalizeProposal(raw, mode, domain) {
    const name = sanitizeScalar(raw.name, 160);
    const description = sanitizeScalar(raw.description, 240);
    const body = sanitizeScalar(raw.body, 4000);
    const type = sanitizeScalar(raw.type, 80);
    if (!name || !description || !body || !type)
        return null;
    if (!MEMORY_TYPES.includes(type))
        return null;
    if (!allowedTypesForMode(mode).has(type))
        return null;
    const filename = sanitizeFilename(raw.filename, name);
    const normalizedDomain = sanitizeScalar(raw.domain, 80) ?? (type === 'domain_knowledge' ? domain : undefined);
    const indexLine = sanitizeScalar(raw.index_line, 300) ??
        `- [${name}](${filename}) - ${description}`;
    return {
        filename,
        name,
        description,
        type,
        domain: normalizedDomain,
        source: sanitizeScalar(raw.source, 240),
        source_verified: typeof raw.source_verified === 'boolean' ? raw.source_verified : undefined,
        requires_revalidation: typeof raw.requires_revalidation === 'boolean' ? raw.requires_revalidation : undefined,
        body,
        index_line: indexLine.includes(`](${filename})`)
            ? indexLine
            : `- [${name}](${filename}) - ${description}`,
    };
}
export async function runPostSessionMemoryWriter(opts) {
    const { client, mode, domain, messages, memoryDir = MEMORY_DIR, model = DEFAULT_MEMORY_WRITER_MODEL } = opts;
    if (!client || messages.length === 0) {
        return { attempted: false, written: [], skipped: ['no_client_or_messages'] };
    }
    if (memoryDir === MEMORY_DIR)
        await ensureMemoryDirExists();
    else
        await mkdir(memoryDir, { recursive: true });
    let existingIndex = '';
    try {
        const rawIndex = memoryDir === MEMORY_DIR
            ? await loadMemoryIndex()
            : await readFile(join(memoryDir, MEMORY_ENTRYPOINT_NAME), 'utf-8');
        existingIndex = rawIndex?.slice(0, MAX_EXISTING_INDEX_CHARS) ?? '';
    }
    catch {
        existingIndex = '';
    }
    const transcript = buildTranscript(messages);
    if (!transcript.trim()) {
        return { attempted: false, written: [], skipped: ['empty_transcript'] };
    }
    const response = await withTimeout(client.messages.create({
        model,
        max_tokens: 1800,
        system: buildSystemPrompt(mode),
        messages: [{
                role: 'user',
                content: [
                    `Mode: ${mode}`,
                    `Domain: ${domain ?? 'generic'}`,
                    '',
                    'Existing MEMORY.md index:',
                    existingIndex || '(empty)',
                    '',
                    'Session transcript:',
                    transcript,
                ].join('\n'),
            }],
    }), 8_000);
    const raw = response.content[0]?.type === 'text' ? response.content[0].text : '';
    const parsed = extractJson(raw);
    const proposals = Array.isArray(parsed?.memories)
        ? parsed.memories
        : [];
    const written = [];
    const skipped = [];
    let indexToCheck = existingIndex;
    for (const rawProposal of proposals.slice(0, MAX_MEMORIES_PER_RUN)) {
        const proposal = normalizeProposal(rawProposal, mode, domain);
        if (!proposal) {
            skipped.push('invalid_proposal');
            continue;
        }
        if (indexToCheck.includes(`](${proposal.filename})`) || indexToCheck.includes(proposal.name)) {
            skipped.push(`duplicate:${proposal.filename}`);
            continue;
        }
        const target = join(memoryDir, proposal.filename);
        try {
            await readFile(target, 'utf-8');
            skipped.push(`exists:${proposal.filename}`);
            continue;
        }
        catch {
            // File does not exist; proceed.
        }
        await writeFile(target, renderMemoryFile(proposal), 'utf-8');
        const indexLine = proposal.index_line.replace(/\r?\n/g, ' ').trim();
        await appendFile(join(memoryDir, MEMORY_ENTRYPOINT_NAME), `${indexToCheck.trim() ? '\n' : ''}${indexLine}\n`, 'utf-8');
        indexToCheck += `\n${indexLine}`;
        written.push(proposal.filename);
    }
    return { attempted: true, written, skipped };
}
//# sourceMappingURL=memoryWriter.js.map
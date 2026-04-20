/**
 * File Tools
 *
 * read_file   — read a file or directory listing
 * write_file  — create or overwrite a file
 * patch_file  — apply a unified diff patch
 * search_files — grep-style search across files
 */

import fs from 'fs/promises';
import path from 'path';
import { registerTools } from './registry.js';
import type { ToolEntry } from '../types.js';

const MAX_READ_CHARS = 100_000;
const MAX_SEARCH_RESULTS = 50;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readFileSafe(filePath: string, maxChars = MAX_READ_CHARS): Promise<string> {
  const stat = await fs.stat(filePath);

  if (stat.isDirectory()) {
    const entries = await fs.readdir(filePath, { withFileTypes: true });
    const lines = entries.map((e) => `${e.isDirectory() ? 'd' : 'f'} ${e.name}`);
    return `Directory listing of ${filePath}:\n${lines.join('\n')}`;
  }

  const content = await fs.readFile(filePath, 'utf-8');
  if (content.length > maxChars) {
    return content.slice(0, maxChars) + `\n\n[... file truncated at ${maxChars} chars ...]`;
  }
  return content;
}

async function searchInFile(
  filePath: string,
  pattern: RegExp,
  maxResults: number,
  contextLines: number,
): Promise<string[]> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch {
    return [];
  }
  const lines = content.split('\n');
  const results: string[] = [];
  for (let i = 0; i < lines.length && results.length < maxResults; i++) {
    if (pattern.test(lines[i] ?? '')) {
      const start = Math.max(0, i - contextLines);
      const end = Math.min(lines.length - 1, i + contextLines);
      const snippet = lines
        .slice(start, end + 1)
        .map((l, idx) => `${start + idx + 1}:${start + idx === i ? '>' : ' '} ${l}`)
        .join('\n');
      results.push(`${filePath}:${i + 1}\n${snippet}`);
    }
  }
  return results;
}

async function walkDir(
  dir: string,
  pattern: string,
  maxDepth: number,
  currentDepth = 0,
): Promise<string[]> {
  if (currentDepth > maxDepth) return [];
  let entries: string[] = [];
  try {
    const items = await fs.readdir(dir, { withFileTypes: true });
    for (const item of items) {
      if (item.name.startsWith('.') || item.name === 'node_modules' || item.name === '__pycache__') {
        continue;
      }
      const fullPath = path.join(dir, item.name);
      if (item.isDirectory()) {
        const sub = await walkDir(fullPath, pattern, maxDepth, currentDepth + 1);
        entries = entries.concat(sub);
      } else {
        entries.push(fullPath);
      }
    }
  } catch {
    // ignore permission errors
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const fileTools: ToolEntry[] = [
  // ---------------------------
  // read_file
  // ---------------------------
  {
    name: 'read_file',
    toolset: 'file',
    parallelSafe: true,
    emoji: '📄',
    maxResultSizeChars: 100_000,
    definition: {
      name: 'read_file',
      description:
        'Read the contents of a file at the given path. If the path is a directory, returns a directory listing. Supports optional line range (start_line, end_line).',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute or relative path to the file or directory.',
          },
          start_line: {
            type: 'integer',
            description: 'First line to read (1-based, inclusive). Optional.',
          },
          end_line: {
            type: 'integer',
            description: 'Last line to read (1-based, inclusive). Optional.',
          },
          max_chars: {
            type: 'integer',
            description: `Maximum characters to return. Defaults to ${MAX_READ_CHARS}.`,
          },
        },
        required: ['path'],
      },
    },
    handler: async (args) => {
      const filePath = args['path'] as string;
      const maxChars = (args['max_chars'] as number | undefined) ?? MAX_READ_CHARS;

      let content = await readFileSafe(filePath, maxChars);

      const startLine = args['start_line'] as number | undefined;
      const endLine = args['end_line'] as number | undefined;
      if (startLine !== undefined || endLine !== undefined) {
        const lines = content.split('\n');
        const s = (startLine ?? 1) - 1;
        const e = endLine ?? lines.length;
        content = lines.slice(s, e).join('\n');
      }

      return content;
    },
  },

  // ---------------------------
  // write_file
  // ---------------------------
  {
    name: 'write_file',
    toolset: 'file',
    parallelSafe: false,
    emoji: '✏️',
    definition: {
      name: 'write_file',
      description: 'Create or overwrite a file with the given content. Creates parent directories if needed.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute or relative path to write.',
          },
          content: {
            type: 'string',
            description: 'File content to write.',
          },
          append: {
            type: 'boolean',
            description: 'If true, append to existing file instead of overwriting. Default false.',
          },
        },
        required: ['path', 'content'],
      },
    },
    handler: async (args) => {
      const filePath = args['path'] as string;
      const content = args['content'] as string;
      const append = args['append'] as boolean | undefined;

      await fs.mkdir(path.dirname(path.resolve(filePath)), { recursive: true });

      if (append) {
        await fs.appendFile(filePath, content, 'utf-8');
        return `Appended ${content.length} characters to ${filePath}`;
      } else {
        await fs.writeFile(filePath, content, 'utf-8');
        return `Wrote ${content.length} characters to ${filePath}`;
      }
    },
  },

  // ---------------------------
  // patch_file
  // ---------------------------
  {
    name: 'patch_file',
    toolset: 'file',
    parallelSafe: false,
    emoji: '🔧',
    definition: {
      name: 'patch_file',
      description:
        'Apply an exact string replacement to a file. Replaces the first occurrence of `old_str` with `new_str`. Fails if `old_str` is not found.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path to the file to modify.',
          },
          old_str: {
            type: 'string',
            description: 'The exact string to find and replace. Must match exactly including whitespace.',
          },
          new_str: {
            type: 'string',
            description: 'The replacement string.',
          },
          replace_all: {
            type: 'boolean',
            description: 'If true, replace all occurrences. Default false.',
          },
        },
        required: ['path', 'old_str', 'new_str'],
      },
    },
    handler: async (args) => {
      const filePath = args['path'] as string;
      const oldStr = args['old_str'] as string;
      const newStr = args['new_str'] as string;
      const replaceAll = args['replace_all'] as boolean | undefined;

      const content = await fs.readFile(filePath, 'utf-8');

      if (!content.includes(oldStr)) {
        return `Error: old_str not found in ${filePath}. No changes made.`;
      }

      let newContent: string;
      if (replaceAll) {
        // Split/join avoids RegExp special-character issues and $ replacement
        // sequences that String.prototype.replace() interprets in the second arg.
        const parts = content.split(oldStr);
        const count = parts.length - 1;
        newContent = parts.join(newStr);
        await fs.writeFile(filePath, newContent, 'utf-8');
        return `Replaced ${count} occurrence(s) of the pattern in ${filePath}`;
      } else {
        // Use a replacer function so $& / $1 / $' etc. in newStr are treated
        // as literal characters, not replacement pattern specifiers.
        const idx = content.indexOf(oldStr);
        newContent = content.slice(0, idx) + newStr + content.slice(idx + oldStr.length);
        await fs.writeFile(filePath, newContent, 'utf-8');
        return `Successfully patched ${filePath}`;
      }
    },
  },

  // ---------------------------
  // search_files
  // ---------------------------
  {
    name: 'search_files',
    toolset: 'file',
    parallelSafe: true,
    emoji: '🔍',
    definition: {
      name: 'search_files',
      description:
        'Search for a pattern (regex) across files in a directory. Returns matching lines with context.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Directory or file to search in.',
          },
          pattern: {
            type: 'string',
            description: 'Regular expression pattern to search for.',
          },
          file_glob: {
            type: 'string',
            description: 'Optional file glob to restrict search (e.g. "*.ts", "*.py"). Default: all files.',
          },
          case_sensitive: {
            type: 'boolean',
            description: 'Case-sensitive matching. Default false.',
          },
          context_lines: {
            type: 'integer',
            description: 'Lines of context around each match. Default 2.',
          },
          max_results: {
            type: 'integer',
            description: `Maximum results to return. Default ${MAX_SEARCH_RESULTS}.`,
          },
          max_depth: {
            type: 'integer',
            description: 'Maximum directory depth to recurse. Default 10.',
          },
        },
        required: ['path', 'pattern'],
      },
    },
    handler: async (args) => {
      const searchPath = args['path'] as string;
      const patternStr = args['pattern'] as string;
      const fileGlob = args['file_glob'] as string | undefined;
      const caseSensitive = args['case_sensitive'] as boolean | undefined;
      const contextLines = (args['context_lines'] as number | undefined) ?? 2;
      const maxResults = (args['max_results'] as number | undefined) ?? MAX_SEARCH_RESULTS;
      const maxDepth = (args['max_depth'] as number | undefined) ?? 10;

      const flags = caseSensitive ? '' : 'i';
      let pattern: RegExp;
      try {
        pattern = new RegExp(patternStr, flags);
      } catch {
        return `Error: invalid regex pattern: ${patternStr}`;
      }

      const stat = await fs.stat(searchPath);
      let files: string[];

      if (stat.isFile()) {
        files = [searchPath];
      } else {
        files = await walkDir(searchPath, fileGlob ?? '*', maxDepth);
        if (fileGlob) {
          // Simple glob matching — convert glob to regex
          const globRegex = new RegExp(
            '^' +
              fileGlob
                .replace(/\./g, '\\.')
                .replace(/\*\*/g, '__DSTAR__')
                .replace(/\*/g, '[^/]*')
                .replace(/__DSTAR__/g, '.*') +
              '$',
          );
          files = files.filter((f) => globRegex.test(path.basename(f)));
        }
      }

      const allResults: string[] = [];
      for (const file of files) {
        if (allResults.length >= maxResults) break;
        const matches = await searchInFile(file, pattern, maxResults - allResults.length, contextLines);
        allResults.push(...matches);
      }

      if (allResults.length === 0) {
        return `No matches found for pattern "${patternStr}" in ${searchPath}`;
      }

      return allResults.join('\n\n---\n\n');
    },
  },
];

// Register all file tools
registerTools(fileTools);

export default fileTools;

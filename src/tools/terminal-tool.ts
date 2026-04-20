/**
 * Terminal Tool
 *
 * terminal — execute shell commands in a subprocess
 */

import { spawn } from 'child_process';
import { registerTools } from './registry.js';
import type { ToolEntry } from '../types.js';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_CHARS = 50_000;

// ---------------------------------------------------------------------------
// Execution helper
// ---------------------------------------------------------------------------

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

async function execShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  env?: Record<string, string>,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const proc = spawn('/bin/bash', ['-c', command], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, timeoutMs);

    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      // Trim to prevent memory issues
      if (stdout.length > MAX_OUTPUT_CHARS * 2) {
        stdout = stdout.slice(-MAX_OUTPUT_CHARS);
      }
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > MAX_OUTPUT_CHARS) {
        stderr = stderr.slice(-MAX_OUTPUT_CHARS);
      }
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        stdout: stdout.slice(-MAX_OUTPUT_CHARS),
        stderr: stderr.slice(-MAX_OUTPUT_CHARS / 2),
        exitCode: code ?? 1,
        timedOut,
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout: '', stderr: err.message, exitCode: 1, timedOut: false });
    });
  });
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

const terminalTools: ToolEntry[] = [
  {
    name: 'terminal',
    toolset: 'terminal',
    parallelSafe: false,
    emoji: '💻',
    maxResultSizeChars: 50_000,
    definition: {
      name: 'terminal',
      description:
        'Execute a shell command in a bash subprocess. Returns stdout, stderr, and exit code. Commands run in the working directory. Use for running scripts, installing packages, file operations, git commands, etc.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The bash command to execute.',
          },
          cwd: {
            type: 'string',
            description: 'Working directory. Defaults to process.cwd().',
          },
          timeout_ms: {
            type: 'integer',
            description: `Command timeout in milliseconds. Default ${DEFAULT_TIMEOUT_MS}.`,
          },
          env: {
            type: 'object',
            description: 'Additional environment variables as key-value pairs.',
            additionalProperties: { type: 'string' },
          },
        },
        required: ['command'],
      },
    },
    handler: async (args, context) => {
      const command = args['command'] as string;
      const cwd = (args['cwd'] as string | undefined) ?? process.cwd();
      const timeoutMs = (args['timeout_ms'] as number | undefined) ?? DEFAULT_TIMEOUT_MS;
      const env = (args['env'] as Record<string, string> | undefined) ?? {};

      const result = await execShell(command, cwd, timeoutMs, env);

      const parts: string[] = [];
      if (result.timedOut) {
        parts.push(`⚠️ Command timed out after ${timeoutMs}ms`);
      }
      parts.push(`Exit code: ${result.exitCode}`);
      if (result.stdout) parts.push(`stdout:\n${result.stdout}`);
      if (result.stderr) parts.push(`stderr:\n${result.stderr}`);

      return parts.join('\n\n');
    },
  },

  // ---------------------------
  // process_list — lightweight ps aux
  // ---------------------------
  {
    name: 'process_list',
    toolset: 'terminal',
    parallelSafe: true,
    emoji: '📊',
    definition: {
      name: 'process_list',
      description: 'List running processes. Optionally filter by name.',
      parameters: {
        type: 'object',
        properties: {
          filter: {
            type: 'string',
            description: 'Optional string to filter process names.',
          },
        },
        required: [],
      },
    },
    handler: async (args) => {
      const filter = args['filter'] as string | undefined;
      const cmd = filter
        ? `ps aux | head -1; ps aux | grep -i "${filter}" | grep -v grep`
        : 'ps aux | head -20';
      const result = await execShell(cmd, process.cwd(), 10_000);
      return result.stdout || result.stderr || 'No output';
    },
  },
];

// Register terminal tools
registerTools(terminalTools);

export default terminalTools;

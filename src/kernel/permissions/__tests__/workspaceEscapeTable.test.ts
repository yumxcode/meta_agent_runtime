/**
 * Workspace-jail escape table.
 *
 * A code review found several holes in the bash workspace scan that no test
 * covered. Each row below is a command plus the verdict the policy is expected
 * to return, so a regression is a failing row rather than a silent hole.
 *
 * READ THIS BEFORE RELAXING A ROW: the scan is a best-effort typo guard, NOT a
 * containment boundary (see SensitiveCommandPatterns.ts and the notes in
 * PermissionPolicy.ts). The `known bypasses` block deliberately asserts that
 * some escapes DO get through — those rows document the limit of this layer and
 * are the reason the OS sandbox must stay fail-closed in auto mode. If one of
 * them starts failing because you tightened the regex, that is an improvement:
 * move the row up into the denied block rather than weakening the check.
 */
import { describe, expect, it } from 'vitest'
import { createPermissionPolicy } from '../PermissionPolicy.js'
import type { KernelTool } from '../../types/KernelTool.js'

const WORKSPACE = '/tmp/ws-escape-table'

function shellTool(name: 'bash' | 'powershell' = 'bash'): KernelTool {
  return {
    name,
    description: '',
    inputSchema: { safeParse: (i: unknown) => ({ success: true, data: i }) },
    isConcurrencySafe: () => false,
    permission: { category: 'execute', cwdField: 'cwd', requiresWorkspace: true, sensitive: true },
    call: async () => ({ data: '' }),
  } as unknown as KernelTool
}

const ctx = { sessionId: 's', abortSignal: new AbortController().signal } as never

async function verdict(
  command: string,
  opts: Parameters<typeof createPermissionPolicy>[0] = {},
): Promise<'allow' | 'deny' | 'redirect'> {
  const policy = createPermissionPolicy({
    workspaceRoot: WORKSPACE,
    ignoreUserConfig: true,
    ...opts,
  })
  const res = await policy(shellTool(), { command }, 'a', 't', ctx)
  return res.behavior
}

describe('workspace jail — commands that MUST be denied', () => {
  const denied: Array<[label: string, command: string]> = [
    ['absolute path outside workspace', 'cat /etc/passwd'],
    ['option-glued absolute path',      'tar --exclude=/etc/shadow -cf a.tar .'],
    ['colon-separated absolute path',   'rsync -a src remote:/etc/'],
    ['home tilde path',                 'cat ~/.ssh/id_rsa'],
    ['bare home tilde',                 'rm -rf ~'],
    ['home tilde before separator',     'rm -rf ~ && echo done'],
    ['quoted home tilde',               'rm -rf "~"'],
    ['$HOME variable',                  'cat $HOME/.aws/credentials'],
    ['${HOME} variable',                'cat ${HOME}/.aws/credentials'],
    ['parent path traversal',           'cat ../../etc/passwd'],
    ['bare parent',                     'cd ..'],
    ['parent before separator',         'cd .. ; ls'],
    ['filesystem root',                 'rm -rf /'],
    ['root glob',                       'chmod -R 777 /*'],
    // The argument-wise rewrite must not soften these: a bare `/` argument is
    // still a root target however it is quoted or glued to an option.
    ['quoted filesystem root',          'rm -rf "/"'],
    ['root as a redirect target',       'echo x >/'],
    ['option-glued root',               'tar --exclude=/ -cf a.tar .'],
    ['root at end of a chain',          'cd src && rm -rf /'],
    // Regression: /dev/ used to be exempt WHOLESALE, so block-device writes
    // sailed past the scan — and dd/mkfs are not in SENSITIVE_SHELL_PATTERNS
    // either, so auto mode's auto-approve had nothing left to stop them.
    ['block device write via dd',       'dd if=/dev/zero of=/dev/sda bs=1M'],
    ['nvme block device',               'mkfs.ext4 /dev/nvme0n1p1'],
    ['raw disk redirect',               'cat img > /dev/sdb'],
  ]

  for (const [label, command] of denied) {
    it(`denies: ${label}`, async () => {
      expect(await verdict(command)).toBe('deny')
    })
  }
})

describe('workspace jail — commands that MUST be allowed', () => {
  const allowed: Array<[label: string, command: string]> = [
    ['plain in-workspace work',        'ls -la src'],
    ['interpreter reference',          '/usr/bin/python3 train.py'],
    ['toolchain lib reference',        'gcc -I/usr/include/foo a.c'],
    ['standard null device',           'make 2>/dev/null'],
    ['urandom read',                   'head -c 16 /dev/urandom | xxd'],
    ['process substitution fd',        'diff /dev/fd/3 /dev/fd/4'],
    ['tmp scratch file',               'echo hi > /tmp/scratch.txt'],
    // Regression: `~` is awk's MATCH OPERATOR and `..` appears in ordinary
    // text. Treating "followed by whitespace" as a path made these staples of
    // shell work undeniable-by-accident, and the error message pointed at
    // "references home" for a command containing no path at all.
    ['awk match operator',             "awk '$1 ~ /error/ { print }' log.txt"],
    ['awk negated match',              "awk '$0 !~ /debug/' log.txt"],
    ['perl bind operator',             "perl -ne 'print if $_ =~ /x/' f.txt"],
    ['bash regex compare',             'if [[ $x =~ ^foo ]]; then echo y; fi'],
    ['ellipsis inside a string',       'echo "loading .. done"'],
    ['git commit range',               'git log v1.0..v2.0 --oneline'],
    ['relative path with inner ..',    'cat src/a/../b/file.ts'],
    // Regression: the root check was a substring scan, so ANY lone `/` between
    // spaces or quotes read as "targets filesystem root" — including one inside
    // a commit message, which is where it bit hardest. The whole point of the
    // rule is a bare `/` ARGUMENT; text that merely contains a slash is not one.
    ['slash inside a commit message',  'git commit -m "x1: fix stance / swing gains"'],
    ['slash as a grep pattern',        'grep -n "/" log.txt'],
    ['slash as an awk field sep',      "awk -F '/' '{print $1}' paths.txt"],
    ['slash inside an echo string',    'echo "cfg / docs updated"'],
    ['compile then commit',            'python3 -m py_compile a/b.py && git add -A && git commit -m "sync cfg / docs"'],
    // `..` and `~` inside quoted text are the same class of false positive.
    ['parent-looking commit message',  'git commit -m "wip .. more to come"'],
    ['tilde inside a commit message',  'git commit -m "approx ~ 3x faster"'],
  ]

  for (const [label, command] of allowed) {
    it(`allows: ${label}`, async () => {
      expect(await verdict(command)).toBe('allow')
    })
  }
})

describe('workspace jail — KNOWN bypasses (documented limits, not a boundary)', () => {
  // These prove the scan is defeatable in one line, which is why auto mode
  // forces allowUnsandboxedFallback:false and why agentic/robotics now warn
  // loudly when no OS sandbox backend exists. Do not "fix" these by escalating
  // the regex arms race — fix them by keeping the OS sandbox mandatory.
  const bypasses: Array<[label: string, command: string]> = [
    ['variable-assembled path',  'X=etc; cat /$X/passwd'],
    ['base64-encoded path',      'echo L2V0Yy9wYXNzd2Q= | base64 -d | xargs cat'],
    ['computed parent via subshell', 'cd $(dirname $PWD)'],
  ]

  for (const [label, command] of bypasses) {
    it(`still gets through (by design of this layer): ${label}`, async () => {
      expect(await verdict(command)).toBe('allow')
    })
  }
})

describe('permissions.json authority over the shell approval gate', () => {
  // Regression: `tools.bash.sensitive` was hardcoded out of the gate condition,
  // so an operator asking to confirm EVERY shell command got silence — on the
  // single most dangerous tool, with no warning that the setting did nothing.
  it('sensitive:true makes an otherwise-innocuous command require approval', async () => {
    const res = await verdict('echo hello', {
      permissionConfig: { tools: { bash: { sensitive: true } } },
    })
    // No approval channel is wired here, so "needs approval" surfaces as deny.
    expect(res).toBe('deny')
  })

  it('sensitive:true routes through the approval channel when one exists', async () => {
    const asked: string[] = []
    const res = await verdict('echo hello', {
      permissionConfig: { tools: { bash: { sensitive: true } } },
      beforeToolCall: async (toolName) => { asked.push(toolName); return { action: 'allow' } },
    })
    expect(asked).toEqual(['bash'])
    expect(res).toBe('allow')
  })

  it('sensitive:false suppresses the gate even for a pattern match', async () => {
    // `rm` matches SENSITIVE_SHELL_PATTERNS; an explicit opt-out must win.
    const res = await verdict('rm -f build/out.o', {
      permissionConfig: { tools: { bash: { sensitive: false } } },
    })
    expect(res).toBe('allow')
  })

  it('without an override, only pattern matches are gated', async () => {
    expect(await verdict('echo hello')).toBe('allow')
    expect(await verdict('rm -f build/out.o')).toBe('deny')   // no approval channel → deny
  })
})

describe('auto-mode autonomy jail', () => {
  const autonomy = { autoApproveInWorkspace: true, lockWorkspace: true, deniedTools: [] as string[] }

  it('auto-approves in-workspace sensitive ops without prompting', async () => {
    expect(await verdict('rm -f build/out.o', { autonomy })).toBe('allow')
  })

  it('still denies escapes even with auto-approve on', async () => {
    expect(await verdict('rm -rf /etc/nginx', { autonomy })).toBe('deny')
    expect(await verdict('cat ~/.ssh/id_rsa', { autonomy })).toBe('deny')
    expect(await verdict('dd if=/dev/zero of=/dev/sda', { autonomy })).toBe('deny')
  })

  it('lockWorkspace overrides allowOutsideWorkspace from permissions.json', async () => {
    expect(await verdict('cat /etc/passwd', {
      autonomy,
      permissionConfig: { workspace: { allowOutsideWorkspace: true } },
    })).toBe('deny')
  })
})

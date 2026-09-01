# P1 沙箱基础工具访问配置方案 - 2026-09-01

**状态**：**已实现**（2026-09-01）。§8 验收表全部落为单测，全量 3527 测试通过，`tsc --noEmit` 干净。
**范围**：让 operator 通过 `config.json` 一处声明，使 `gh` / `git` / `docker` 等基础工具在 `agentic` / `robotics` / `auto` / `simple_auto` 各模式下可用。
**不在本次实现范围内**：凭证的安全存储与注入方式（见 §9.1，仍未决）；`campaign` 模式（见 §6.4）。

**落地文件**

| 文件 | 性质 |
|---|---|
| `src/sandbox/toolAccessPresets.ts` | 新增 — 预设表 + `expandToolAccess` |
| `src/sandbox/sandboxPolicyConfig.ts` | 改 — mode 覆盖、toolAccess 展开、diagnostics |
| `src/infra/env/childProcessEnv.ts` | 改 — `setEnvAllowlist` / `isBlockedEnvName` |
| `src/modes/AgenticSession.ts` | 改 — 接线 + 启动期 warn |
| `src/tools/system/sandbox_probe/` | 新增 — 只读诊断工具 |
| `src/sandbox/__tests__/toolAccess.test.ts` | 新增 — 32 例，覆盖 §8 全表 |
| `src/tools/system/__tests__/sandboxProbe.test.ts` | 新增 — 8 例 |

## 1. 决策摘要

1. operator 声明的单位从「路径 + 布尔开关」上升为「工具能力」。`sandbox.toolAccess: ["gh"]` 一条配置同时喂三层防线（env 过滤、workspace jail、OS 沙箱），operator 不需要自己反推 `gh` 依赖哪些路径和环境变量。
2. 环境变量白名单从硬编码常量改为「内置预设 + operator 可扩展」。今天 `GIT_CREDENTIAL_ALLOWLIST` 是四个写死的名字，`GH_ENTERPRISE_TOKEN` 这类变量无论如何配置都无法通过，只能改源码。
3. 引入 per-mode 覆盖 `sandbox.modes.<mode>`，但只能在 autonomy **地板之上**放宽。`lockWorkspace` 永远不可被 operator 解锁，`EXPLICIT_ENV_BLOCKLIST` 永远不可被 operator 白名单覆盖。
4. 所有静默丢弃改为可观测。当前 `resolveSandboxPolicy` 对每条路径做 `existsSync` 过滤后无声丢弃，operator 无法区分「配置未生效」和「配置生效但工具仍失败」。新增 `sandbox_probe` 工具与启动期 warn。
5. 预设表是**数据不是策略**。预设只是「这个工具惯例上需要什么」的知识库，它产出的授权仍然要走既有的 `applySandboxPolicy` 合并与 autonomy 收窄，不绕过任何现有检查。

## 2. 现状与根因

### 2.1 一次 `gh` 调用要通过的三层

| 层 | 代码 | 现有 operator 开关 | 失败表现 |
|---|---|---|---|
| 1. 子进程 env 过滤 | `src/infra/env/childProcessEnv.ts:126-137` | `sandbox.gitCredentialPassthrough`（布尔） | 命令正常执行但无凭证，表现为 401 / 匿名 |
| 2. workspace jail | `src/kernel/permissions/PermissionPolicy.ts:680, 729-731` | `sandbox.writeAllowPaths` / `readAllowPaths` → `allowedRoots` | 命令**根本没执行**，报 `path is outside workspace` |
| 3. OS 沙箱（Seatbelt / bwrap） | `src/sandbox/profiles/macos.ts`、`profiles/bwrap.ts` | 同上 + `sandbox.network` | 命令执行但文件写入或网络被拒 |

三层的开关分散在两个互不相关的配置键上，且没有任何一处以「我要让 gh 能用」的语言表达。operator 必须自己知道 `gh` 需要 `~/.config/gh` 可读写 + `GH_TOKEN` 在 env 里 + 网络可达，才能把三个键配对。

### 2.2 四个缺口

**缺口 1：env 白名单硬编码，operator 无法扩展。**

`childProcessEnv.ts:76-78`：

```ts
const GIT_CREDENTIAL_ALLOWLIST = new Set([
  'GITHUB_TOKEN', 'GH_TOKEN', 'GIT_TOKEN', 'GITLAB_TOKEN',
])
```

这是一个 `const Set`，唯一的 operator 开关是 `sandbox.gitCredentialPassthrough` 的 on/off（`childProcessEnv.ts:84-90`）。后果：

- `GH_ENTERPRISE_TOKEN` 匹配 `SENSITIVE_ENV_PATTERN` 的 `TOKEN$` 而不在册 → 被剥离，**无配置可解**。
- `GH_CONFIG_DIR`、`GH_HOST` 不匹配 pattern 所以能通过，但这是巧合而非设计——operator 无从判断哪些能过哪些不能。
- 任何自定义工具的凭证变量都要改源码才能通过。

这是四个缺口中最核心的一个，也是唯一一个 operator **完全无法绕过**的。

**缺口 2：静默丢弃，零诊断。**

`src/sandbox/sandboxPolicyConfig.ts:156-159`：

```ts
const writeAllow = readPathList('sandbox.writeAllowPaths', projectDir).filter(existsSync)
```

`existsSync` 为假的条目被无声丢弃。`~` 展开本身是正确的（`expandHostPath:112-121`），但路径拼错、平台差异（macOS 上 `~/.local/share/gh` 通常不存在）、乃至配置文件名拼错，全部表现为「配了但没有任何反应」。

`readPathList:127-129` 的 `catch { return [] }` 同样吞掉配置解析异常，`resolveSandboxPolicy:172-174` 的 `catch` 注释直言「malformed config — fall back to the safe defaults」。安全默认是对的，无声是错的。

**缺口 3：没有 per-mode 粒度。**

`sandbox.*` 是单一全局配置。但各模式的 autonomy 语义本就不同（`src/core/modes.ts`）：

| 模式 | autonomy | lockWorkspace | 语义 |
|---|---|---|---|
| `agentic` | 无 | — | 有人值守 |
| `robotics` | 无 | — | 有人值守，weight 3 |
| `auto` | 有 | `true` | 无人值守，硬监狱 |
| `simple_auto` | 有 | `true` | 无人值守，硬监狱 |

`isAutonomousMode()`（`core/modes.ts:187-191`）只认 `auto | simple_auto`。operator 今天只能一刀切：要么四个模式都能碰 `~/.config/gh`，要么都不能。合理的诉求「robotics 下允许 gh dispatch，auto 下只读」无法表达。

**缺口 4：没有能力预设。**

「让 gh 能用」这条知识——需要哪些路径、哪些环境变量、要不要网络——今天存在于 operator 的脑子里而不是 runtime 里。每接入一个工具（docker、kubectl、aws）都要重新推导一遍，且推导错误的反馈是缺口 2 描述的静默失败。

### 2.3 一个已被误诊的现象

排查过程中出现过一次典型误诊，值得写进文档作为诊断能力缺失的证据：在 macOS 上执行 `env | grep -i DBUS` 得到空结果，并据此判定「子进程没有 keyring 会话」。DBUS / gnome-keyring 是 Linux 的 keyring 机制，macOS 上 `gh` 走 Security framework（`/usr/bin/security` → login keychain），该探针在**任何** macOS 机器上都返回空，包括工作正常的用户终端。

这类误诊的根因不是推理能力，而是**运行时不提供可信的自省接口**。§7 的 `sandbox_probe` 直接针对这一点。

## 3. 配置契约

### 3.1 Schema

```jsonc
{
  "sandbox": {
    // 新增：能力预设，展开为 read/write/env/network 授权
    "toolAccess": ["gh", "git"],

    // 新增：env 白名单逃生舱，用于预设未覆盖的变量
    "envAllowlist": ["GH_ENTERPRISE_TOKEN", "MY_INTERNAL_REGISTRY_TOKEN"],

    // 新增：per-mode 覆盖。省略的模式继承顶层
    "modes": {
      "auto":     { "toolAccess": ["git"] },
      "robotics": { "toolAccess": ["gh", "git", "docker"] }
    },

    // 既有键，语义不变
    "writeAllowPaths": [],
    "readAllowPaths": [],
    "writeDenyPaths": [],
    "readDenyPaths": [],
    "protectCredentials": true,
    "network": "unrestricted",
    "allowUnsandboxedFallback": true,
    "gitCredentialPassthrough": true
  }
}
```

三个配置层的优先级沿用 `ConfigService` 既有约定（`src/core/config/ConfigService.ts:9-15`）：session > project > global。`sandbox.modes.<mode>` 在同一层内优先于该层的顶层 `sandbox.*`。

### 3.2 解析顺序

```
1. 按 ConfigService 三层合并，得到 sandbox.* 的有效值
2. 若当前 mode 在 sandbox.modes 中有条目，其字段覆盖顶层同名字段
3. toolAccess 展开为 {read, write, env, network} 四组授权
4. 展开结果与 writeAllowPaths / readAllowPaths / envAllowlist 并集
5. existsSync 过滤（丢弃项记入 diagnostics，不再静默）
6. protectCredentials 的默认 deny 减去被显式授权的路径（既有逻辑，
   sandboxPolicyConfig.ts:180-187，不变）
7. autonomy 地板收窄（§5）
8. 产出 ResolvedSandboxPolicy，同时喂 PermissionPolicy.externalAllowedRoots
   与 OS 沙箱 SandboxConfig
```

第 6 步与第 7 步的顺序不可交换：operator 的显式授权可以抵消 `protectCredentials` 的默认 deny（这是既有的、文档化的行为），但不能抵消 autonomy 地板。

## 4. 工具预设表

预设是纯数据，定义在 `src/sandbox/toolAccessPresets.ts`。

```ts
export interface ToolAccessPreset {
  read?: readonly string[]
  write?: readonly string[]
  env?: readonly string[]
  network?: 'unrestricted'
  /** 供 sandbox_probe 输出，解释这条预设为什么需要这些授权 */
  rationale: string
}
```

| 预设 | read | write | env | network |
|---|---|---|---|---|
| `gh` | `~/.config/gh` | `~/.config/gh` | `GH_TOKEN` `GITHUB_TOKEN` `GH_HOST` `GH_CONFIG_DIR` `GH_ENTERPRISE_TOKEN` `GH_REPO` | `unrestricted` |
| `git` | `~/.gitconfig` `~/.config/git` | — | `GIT_TOKEN` `GITLAB_TOKEN` `GIT_AUTHOR_*` `GIT_COMMITTER_*` `GIT_SSH_COMMAND` `SSH_AUTH_SOCK` | `unrestricted` |
| `docker` | `~/.docker/config.json` | — | `DOCKER_HOST` `DOCKER_CONTEXT` `DOCKER_CONFIG` `DOCKER_TLS_VERIFY` `DOCKER_CERT_PATH` | `unrestricted` |
| `kubectl` | `~/.kube/config` | `~/.kube/cache` | `KUBECONFIG` `KUBE_CONTEXT` `KUBERNETES_SERVICE_*` | `unrestricted` |
| `aws` | `~/.aws` | `~/.aws/cli/cache` | `AWS_PROFILE` `AWS_REGION` `AWS_DEFAULT_REGION` `AWS_CONFIG_FILE` `AWS_SHARED_CREDENTIALS_FILE` | `unrestricted` |
| `npm` | `~/.npmrc` | `~/.npm/_cacache` | `NPM_TOKEN` `NPM_CONFIG_REGISTRY` `NPM_CONFIG_USERCONFIG` | `unrestricted` |

**关于预设的四条设计约束：**

1. **`write` 只给工具确实回写的路径。** `gh` 会更新 `hosts.yml` 与缓存，所以 `~/.config/gh` 需要写；`git` 只读配置不回写用户级配置，所以 `write` 为空。宁可窄了再放宽，不可宽了再收。

2. **除 `git` 外，每个预设都会抵消 `protectCredentials` 的默认保护。** 实现时核实：`~/.config/gh`、`~/.aws`、`~/.kube`、`~/.npmrc`、`~/.docker/config.json` **全部**在 `DEFAULT_CREDENTIAL_DENY_PATHS`（`sandboxPolicyConfig.ts:77-92`）里——不只是最初以为的 aws 和 npm。

   这一条比设计时估计的更重要：它很可能就是 robotics 下 `gh` 失败的**直接原因**。`protectCredentials` 默认 true，沙箱因此 read-deny `~/.config/gh`，而 gh 的 token 正是从那里读的。也就是说在本方案之前，operator 想让 gh 工作必须要么关掉 `protectCredentials`（连带放开 `~/.ssh` `~/.aws`），要么手工把 `~/.config/gh` 写进 `readAllowPaths` 去触发第 6 步的抵消逻辑——后者可行但完全没有文档。

   `toolAccess: ["gh"]` 现在自动做对这件事。代价是默认保护被解除，所以 §3.2 第 6 步每解除一条都产出一条 `credential-deny-lifted` 诊断，`sandbox_probe` 逐条显示。**这是设计意图，不是漏洞——但它必须可见。**

   实现顺序上因此有一个约束：`toolAccess` 的展开必须发生在 credential deny 计算**之前**，否则抵消逻辑看不到预设授权的路径。见 `resolveSandboxPolicy` 中的注释。

3. **`aws` 预设在 autonomous 模式下默认拒绝。** 见 §5.3。

4. **`network: 'unrestricted'` 不能强制放宽。** `applySandboxPolicy` 的既有语义是 `network: 'none'` sticky（`sandboxPolicyConfig.ts:209-211`），任一侧要 none 就是 none。预设声明 `unrestricted` 表达的是「这个工具需要网络」，不是「强制开网」。若工具侧或 operator 侧声明了 `none`，预设不推翻它，但 `sandbox_probe` 应报告这一冲突——否则 operator 会看到「我配了 gh 但网络还是不通」的又一次静默失败。

## 5. 安全边界

这三条是本方案的硬约束，实现时不可为便利而放宽。

### 5.1 `EXPLICIT_ENV_BLOCKLIST` 不可被 operator 白名单覆盖

`envAllowlist` 与预设的 `env` 字段只能覆盖 `SENSITIVE_ENV_PATTERN`（后缀启发式，`childProcessEnv.ts:26-28`），**不能**覆盖 `EXPLICIT_ENV_BLOCKLIST`（`childProcessEnv.ts:50-55`，即 `ANTHROPIC_API_KEY` / `AWS_SECRET_ACCESS_KEY` / `NPM_TOKEN` 等）。

理由：后缀 pattern 是「过度匹配的启发式」，它误伤合法变量是常态，需要逃生舱；blocklist 是「已确认的凭证」的精确名单，为它开逃生舱等于把本特性变成 exfiltration 绕过通道。

`childProcessEnv.ts` 文件开头的注释记录了这个 runtime 已经犯过一次的错误：两个 spawn 点两套相反策略，其中一个悄悄拆掉了另一个声明的目标。不要造第二个。

注意 `npm` 预设的 `NPM_TOKEN` 与此条冲突——`NPM_TOKEN` 在 `EXPLICIT_ENV_BLOCKLIST` 中。实现时 `npm` 预设的 `NPM_TOKEN` 必须被拒绝并在 probe 中报告，或者把 `NPM_TOKEN` 从 blocklist 移到 pattern 覆盖范围（需要单独的安全评审，不在本方案范围内）。**默认取前者：预设不能突破 blocklist。**

### 5.2 `lockWorkspace` 不可被 operator 解锁

`PermissionPolicy.ts:674-676` 的既有逻辑：

```ts
const allowOutsideWorkspace =
  !autonomy?.lockWorkspace && permissionConfig.workspace?.allowOutsideWorkspace === true
```

`sandbox.modes.auto` 不得引入任何能改变这一行结果的字段。`toolAccess` 通过 `externalAllowedRoots` 起作用——那是 jail 内部的**授权白名单**，不是 jail 的开关，两者不可混淆。

### 5.3 autonomous 模式的预设默认收窄

`auto` / `simple_auto` 下，以下预设默认拒绝，必须由 operator 在 `sandbox.modes.<mode>.toolAccess` 中**显式重复声明**才生效：

- `aws`（`~/.aws` 是长期凭证，无人值守下被误用的代价最高）
- `docker`（`DOCKER_HOST` 可指向远端 daemon，等价于宿主机 root）
- `kubectl`（同上，集群级副作用）

`gh` / `git` / `npm` 在 autonomous 下随顶层配置生效——它们的副作用范围与既有的 `gitCredentialPassthrough` 默认开启的风险等级相当，不额外收窄。

这条规则的实现位置应在 §3.2 的第 7 步，与 `AUTO_DENIED_TOOL_NAMES`（`core/modes.ts:70-76`）同层，理由相同：「其效果无法被证明约束在工作区内」。

## 6. 实现改动点

### 6.1 `src/infra/env/childProcessEnv.ts`

- 新增 `setEnvAllowlist(names: readonly string[] | undefined)`，沿用既有 `setGitCredentialPassthrough`（第 85-87 行）的模块级注入模式，保持「配置变更无需重启」的现有特性。
- `buildChildEnv` 的 `gitAllowed` 判断（第 129 行）扩展为：

```ts
const operatorAllowed = envAllowlist.has(key) && !EXPLICIT_ENV_BLOCKLIST.has(key)
const gitAllowed = GIT_CREDENTIAL_ALLOWLIST.has(key) && gitCredentialPassthroughEnabled()
if (!gitAllowed && !operatorAllowed) {
  if (EXPLICIT_ENV_BLOCKLIST.has(key)) continue
  if (SENSITIVE_ENV_PATTERN.test(key) && !ENV_PATTERN_EXEMPTIONS.has(key)) continue
}
```

注意 `operatorAllowed` 的 blocklist 检查写在赋值处而非 if 内部，使 §5.1 的约束在类型层面就近可读。

### 6.2 `src/sandbox/toolAccessPresets.ts`（新文件）

预设表 + `expandToolAccess(names, mode): {read, write, env, network, dropped}`。`dropped` 携带被 §5.3 收窄或被 §5.1 拒绝的条目，供 probe 报告。

### 6.3 `src/sandbox/sandboxPolicyConfig.ts`

- `resolveSandboxPolicy(projectDir)` → `resolveSandboxPolicy(projectDir, mode?)`。保留单参数重载，既有调用点（`tools/shell/bash/index.ts:79`、`tools/shell/sessionSupport.ts:66`、`tools/shell/powershell/index.ts:70`、`tools/system/cron_create/index.ts:98`）不改也能编译，行为等同于「无 mode 覆盖」。
- 读取 `sandbox.modes.<mode>` 并覆盖顶层字段。
- 调用 `expandToolAccess` 并入 allow 列表。
- `ResolvedSandboxPolicy` 增加 `diagnostics: SandboxDiagnostics` 字段，记录：被 `existsSync` 丢弃的路径、被 §5.1/§5.3 拒绝的条目、被移除的默认 credential deny、network 冲突。
- `.filter(existsSync)` 保留（行为不变），但丢弃项写入 diagnostics。

### 6.4 `src/modes/AgenticSession.ts`

- 第 66 行 `resolveSandboxPolicy(projectDir)` 传入 mode。mode 表达式第 95 行已存在：`config.trajectory?.mode ?? config.promptMode ?? (config.autonomy ? 'auto' : 'agentic')`，提取为局部变量在第 66 行之前求值。
- 第 67 行 `setGitCredentialPassthrough(...)` 之后追加 `setEnvAllowlist(sandboxPolicy.envAllowlist)`。
- `RoboticsSession` 走 `AgenticSession`（`src/robotics/RoboticsSession.ts:449`）并已传入 `projectDir`（第 454 行），无需改动即可继承。
- **`CampaignSession` 不走这条路径**：`src/modes/CampaignSession.ts` 中检索不到 `AgenticSession` 或 `MetaAgentSession` 的引用，因此它不会继承 §6.4 的接线。`campaign` 模式的沙箱策略来源需单独核查后补充本节；在此之前，本方案对 `campaign` 模式**不生效**，`sandbox.modes.campaign` 应在实现中显式拒绝而非静默无效。

### 6.5 `src/tools/system/sandbox_probe/`（新工具）

只读、无副作用、不进 `AUTO_DENIED_TOOL_NAMES`。输出：

```
mode: robotics
config layers: global(~/.meta-agent/config.json) ✓  project(.meta-agent/config.json) ✗ 不存在

toolAccess: gh, git
  gh  → read/write ~/.config/gh ✓
        env GH_TOKEN ✓(已设置) GITHUB_TOKEN ✗(未设置) GH_HOST ✗(未设置)
        network unrestricted ✓
  git → read ~/.gitconfig ✓  ~/.config/git ✗(路径不存在，已丢弃)

allowedRoots (喂 PermissionPolicy.externalAllowedRoots):
  /Users/yumx/.config/gh
  /Users/yumx/.gitconfig

env allowlist 生效: GH_TOKEN GITHUB_TOKEN GH_HOST GH_CONFIG_DIR GH_ENTERPRISE_TOKEN
env 被拒绝: (无)

诊断:
  ⚠ writeAllowPaths 中 ~/.local/share/gh 不存在，已丢弃
  ⚠ ~/.ssh 被显式授权，已移除其 protectCredentials 默认 deny
```

这一节是缺口 2 和 §2.3 的直接补救。**建议优先于 §6.1-6.4 实现**——它能立刻把「配了没反应」变成可诊断，即便其余部分尚未落地。

### 6.6 启动期 warn

`resolveSandboxPolicy` 产出的 diagnostics 中，「被丢弃的路径」与「被拒绝的 env」在 session 初始化时打一条 warn 日志。不阻断启动。

## 7. 兼容与迁移

- 三个新键全部可省略，省略时行为与今日**逐字节一致**。
- `gitCredentialPassthrough` 保留，语义不变。`toolAccess: ["git"]` 与它是并集关系而非替代关系；未来如需废弃需单独 RFC。
- `resolveSandboxPolicy` 的单参数重载保证既有四个调用点零改动。
- `ResolvedSandboxPolicy` 新增字段为可选，既有解构不受影响。

## 8. 验收标准

| # | 场景 | 期望 |
|---|---|---|
| 1 | 无 `toolAccess` 配置 | `ResolvedSandboxPolicy` 与改动前逐字段相等 |
| 2 | `toolAccess: ["gh"]`，robotics 模式 | `~/.config/gh` 进入 `allowedRoots`；`GH_TOKEN` 通过 `buildChildEnv('filtered')` |
| 3 | `envAllowlist: ["ANTHROPIC_API_KEY"]` | 该变量**仍被剥离**；diagnostics 记录一条拒绝（§5.1） |
| 4 | `toolAccess: ["npm"]` | `NPM_TOKEN` 仍被剥离并报告；其余 npm 变量通过（§5.1 末段） |
| 5 | `toolAccess: ["aws"]`，auto 模式 | 默认拒绝；`sandbox.modes.auto.toolAccess: ["aws"]` 时生效（§5.3） |
| 6 | `sandbox.modes.auto` 试图开 `allowOutsideWorkspace` | 无效，`lockWorkspace` 地板保持（§5.2） |
| 7 | `toolAccess` 含不存在的预设名 | 忽略该条 + diagnostics 记录，不抛异常 |
| 8 | `toolAccess` 非数组 / 配置畸形 | 回退空集，不因畸形而放行（对齐 `docs/testing/TEST_PLAN.md:108` 既有约定） |
| 9 | 路径不存在被丢弃 | 仍被丢弃（行为不变）+ diagnostics 可见 |
| 10 | 工具侧声明 `network: 'none'` + 预设要 `unrestricted` | `none` 胜出（sticky 语义不变）+ diagnostics 报告冲突 |

第 1、3、6、8 条是回归防线，必须先写测试再改实现。

## 9. 未决问题

**9.1 凭证注入方式仍未解决。**

本方案让 `GH_TOKEN` 能**通过**过滤层，但没有回答它**从哪来**。今天的答案是「operator 在启动 meta-agent 的 shell 里 export」，而 `childProcessEnv.ts:63-68` 的注释已经写明这个方案的残留风险：转发的 token 对子进程里任何命令可见，`echo $GH_TOKEN` 会把值送进模型上下文，仅靠 `infra/redaction/secretRedaction.ts` 的值形状匹配兜底。

同一段注释也给出了正解方向：credential helper / `GIT_ASKPASS`，把 token 只交给单次调用而非整个进程树。那是独立议题，本方案不解决，但**不应加剧**——这是 §5.1 存在的原因。

在它落地前，operator 侧的缓解措施是使用最小 scope 的 PAT（`gh` dispatch 只需 `actions:write`，private repo 另加 `repo`），而非完整 scope 的 token。

**9.2 macOS keychain 在沙箱子进程中的可用性未经实测。**

Seatbelt profile 以 `(allow default)` 开头且不含任何 mach 相关 deny（`sandbox/profiles/macos.ts:76-84`），理论上 `mach-lookup` 到 `com.apple.SecurityServer` 是通的。但 keychain item ACL 绑定调用方代码签名，`sandbox-exec` 下的行为需要在真机上验证。

若实测可用，`gh` 预设可以不依赖 §9.1 的 env 注入，直接走 keychain——那会是明显更好的方案。**建议在实现前先用 `sandbox_probe` 打一次实测**，结论回填本节。

**9.3 `CampaignSession` 与 `spawn_sub_agent` 的继承路径未核实。**

`p0-workspace-jail-and-resume-integrity-plan-2026-07-10.md:22` 记录 `spawn_sub_agent` 暴露了 `sandbox.write_allow_paths` 且 `SubAgentBridge.setAutonomyJail()` 不收窄模型提供的外部路径。`toolAccess` 若经由 sub-agent 传播，需确认它不会成为该已知问题的新入口。实现前需单独核查。

## 10. 实施记录

设计阶段把 `sandbox_probe` 排在第 1 位（独立可交付）。实现时改为最后一步：probe 的输出以 `ResolvedSandboxPolicy.diagnostics` 为数据源，先做 probe 会得到一个只能打印旧策略的空壳，反而要写两遍。实际顺序：

1. `toolAccessPresets.ts` + `expandToolAccess`（无依赖）
2. `childProcessEnv` 的 `setEnvAllowlist` / `isBlockedEnvName`
3. `sandboxPolicyConfig` 的 mode 覆盖、toolAccess 展开、diagnostics
4. `AgenticSession` 接线 + 启动期 warn
5. `sandbox_probe`
6. §8 验收表 32 例 + probe 8 例

**实现中发现、与设计有出入的两处**，均已回填正文：

- §4 约束 2：受影响的不止 aws/npm，而是除 `git` 外的**全部**预设；且这很可能就是 gh 失败的直接原因。同时带出一条实现顺序约束（toolAccess 展开必须早于 credential deny 计算）。
- §6.4：`CampaignSession` 不经由 `AgenticSession`，本方案对 `campaign` 模式不生效。

**测试覆盖的重点**不是「功能可用」，而是四条**没有被放宽**的边界：验收 1（无配置行为逐字段不变）、3（blocklist 不可解锁，且 `buildChildEnv` 独立复检而非信任解析结果）、6（`lockWorkspace` 地板，用真实 `createPermissionPolicy` 驱动）、8（配置畸形回退空集）。预设表是易于扩展的数据，最可能的退化路径就是有人为了方便把某个名字塞进 blocklist 例外——`case 4` 的第二个断言正是为此存在。

尚未验证：§9.2（macOS keychain 在 `sandbox-exec` 下的可用性）需要真机，本环境是 Linux 容器。

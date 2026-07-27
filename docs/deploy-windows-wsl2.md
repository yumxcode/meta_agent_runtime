# 在 Windows 上部署 meta-agent（WSL2 路线）

这是目前**唯一受支持**的 Windows 部署方式。原生 win32 的阻塞项与改造计划见
[`docs/reviews/windows-port-review-2026-07-27.md`](reviews/windows-port-review-2026-07-27.md)。

在 WSL2 里，meta-agent 就是一个普通的 Linux 部署——沙箱（bubblewrap）、文件锁、
durable Loop 全部按 Linux 语义工作，代码零改动。

**唯一的硬性要求：workspace 和 `$META_AGENT_HOME` 必须放在发行版自己的文件系统里，
不能放在 `/mnt/c`。** 原因见下文第 4 节，这不是性能建议，是正确性要求。

---

## 1. 前置

- Windows 10 22H2 / Windows 11
- WSL2（不是 WSL1）
- Node.js ≥ 18（推荐 22）

安装 WSL2：

```powershell
wsl --install -d Ubuntu
wsl --set-default-version 2
```

确认版本（`VERSION` 列必须是 2）：

```powershell
wsl -l -v
```

如果显示 1：

```powershell
wsl --set-version Ubuntu 2
```

---

## 2. 安装

在 WSL2 shell 里：

```bash
# 1. 工具链
sudo apt-get update
sudo apt-get install -y git bubblewrap ripgrep

# 2. Node（nvm 方式；也可用 nodesource / distro 包）
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
exec "$SHELL" -l
nvm install 22 && nvm alias default 22

# 3. meta-agent
cd ~ && mkdir -p code && cd code
git clone <repo-url> meta_agent_runtime
cd meta_agent_runtime
npm ci
npm run build
npm link          # 或 npm i -g ./meta-agent-runtime-<version>.tgz

# 4. 校验
./scripts/setup-wsl2.sh
meta-agent --version
```

`scripts/setup-wsl2.sh` 会逐项检查 WSL 版本、文件系统位置、Node/git/bwrap/ripgrep，
并对每个失败项打印确切的修复命令。加 `--install` 可以让它直接 apt 装缺失的包。
它在有 required 项失败时返回非零，可以直接拿去 gate CI。

三个依赖的性质不同，值得分清：

| 依赖 | 缺失后果 |
|---|---|
| `bubblewrap` | sub-agent 沙箱降级为无隔离执行（`src/cli/bwrapCheck.ts` 会打印警告）；严格沙箱策略直接不可用 |
| `git` | `AutoWorktreeCoordinator`、`TeamStore`、`JudgeSnapshot` 不可用 |
| `ripgrep` | 仅性能——`grep` 工具有纯 JS 回退（`src/tools/fs/grep/index.ts:95`） |

---

## 3. 目录布局

```
~/code/<project>            ← workspace，放这里
~/.meta-agent/              ← 全局状态（sessions / loop-scheduler / config）
```

从 Windows 侧访问这些文件：资源管理器地址栏输入

```
\\wsl$\Ubuntu\home\<user>\code\<project>
```

VS Code 用 Remote-WSL 扩展直接 `code .`，不要用 Windows 侧的 VS Code 打开 `\\wsl$\` 路径。

---

## 4. 为什么不能放在 `/mnt/c`

WSL2 把 Windows 盘符通过 9p 协议代理进 Linux（WSL1 用 DrvFs）。在这个传输层上：

- `link()` 可能直接 EPERM
- `rename()` 不保证原子
- `mtime` 粒度粗、且不严格单调

而 durable Loop 运行时的三个核心机制正好依赖这三样：

| 机制 | 位置 | 依赖 |
|---|---|---|
| scheduler 锁 | `src/loop/daemon.ts:172` `acquireDaemonLock` | `link()` 做 create-if-absent；`mtime` 判断锁是否新鲜（`LOCK_FRESH_MS`） |
| `withFileLock` | `src/infra/persist/index.ts:158` | `rename()` 做 stale 锁的原子抢占；`mtime` 判 stale |
| `atomicWriteJson` | `src/infra/persist/index.ts:87` | `rename()` 的原子性保证 `instance.json` / `state.json` 不会写一半 |
| `WakeStore` orphan 回收 | `src/loop/wake/WakeStore.ts` | 心跳时间戳比较 |

具体故障形态：

- `link()` EPERM → `acquireDaemonLock` 返回 null → `meta-agent loop-scheduler`
  **静默退出并报 `lock_held`**，永远起不来，且没有任何提示指向真正原因
- `rename()` 非原子 → 崩溃窗口里可能留下半个 `instance.json`，
  `readJsonFile` 会把它重命名成 `.corrupt` 并返回 null，等于丢一次状态提交
- `mtime` 粗糙 → 活锁被判成 stale 并被抢走 → **两个 scheduler 同时跑同一个 workspace**，
  两份 graph tick 并发写同一份 journal

运行时会在启动时主动检测并警告（`src/cli/wslCheck.ts`）。如果你确实理解风险并要
在 `/mnt` 上跑，用 `META_AGENT_SUPPRESS_WSL_WARNING=1` 关掉提示。

> 顺带一提：给 `/etc/wsl.conf` 的 drvfs 挂载加 `metadata` 选项能修复权限位的表现，
> 但**修不了 rename 原子性和 link**。不要以为加了 metadata 就安全了。

---

## 5. 性能

Windows Defender 实时扫描会在 WSL2 的每次文件写上加一次 AV 往返。把 WSL 的 VHDX
排除掉（管理员 PowerShell）：

```powershell
Add-MpPreference -ExclusionPath "$env:LOCALAPPDATA\Packages\CanonicalGroupLimited*"
```

如果 `~/.meta-agent/sessions` 增长很快，`meta-agent` 自带 `loop gc` / `loop archive`
子命令做清理。

---

## 6. 与 Windows 侧工具链互操作

WSL2 可以直接执行 Windows 可执行文件：

```bash
nvidia-smi.exe                      # 直接可用
wslpath -w ~/code/proj              # → C:\Users\<user>\... 形式，喂给 Windows 程序
wslpath -u 'C:\data\x.npz'          # → /mnt/c/data/x.npz，反向转换
```

GPU：Windows 侧装好 NVIDIA 驱动后，WSL2 里 `nvidia-smi` 直接可用，CUDA 走 WSL 版
toolkit，**不要**在 WSL 里再装 Windows 显卡驱动。

注意一个常见陷阱：如果训练脚本本身在 WSL 里跑、但读的数据在 `/mnt/c` 上，IO 会非常
慢（9p 往返）。把数据也拷进发行版文件系统，或者反过来——整个训练放 Windows 侧、
meta-agent 通过 `.exe` 调用它。

---

## 7. 常见问题

**`loop-scheduler` 立刻退出，日志只有 `scheduler exit (lock_held)`**
八成是 workspace 在 `/mnt/c` 上，`link()` 拿不到锁。跑 `./scripts/setup-wsl2.sh` 确认。
也可能是真有另一个 scheduler 在跑：`meta-agent loop schedulers` 看一眼。

**`bwrap: setting up uid map: Permission denied`**
WSL2 默认允许 user namespace，但某些企业策略镜像会关掉。检查
`cat /proc/sys/kernel/unprivileged_userns_clone`（应为 1）。

**git 报 `warning: LF will be replaced by CRLF`**
说明这个仓库是从 Windows 侧 clone 的。在 WSL 里重新 clone，并确认
`git config core.autocrlf` 为 `input` 或 `false`。仓库根的 `.gitattributes`
已经强制 `eol=lf`，但那只对新 clone 生效。

**WSL 里看不到 Windows 侧设的环境变量（API key）**
WSL 默认继承 Windows 的 `PATH` 但不继承任意环境变量。把 key 写进 WSL 侧的
`~/.bashrc` 或 `~/.meta-agent/config.json`。

---

## 8. 这条路线不解决什么

- **不提供原生 win32 支持**。需要在 Windows 上直接跑 `node`（例如要驱动只有
  Windows 版本的仿真器、且不接受 `.exe` 跨界调用的开销）的，看迁移报告的 Phase 1–5。
- **不共享 `~/.meta-agent`**。WSL 侧和 Windows 侧是两份独立状态。
- **不改变沙箱语义**。WSL2 里 bubblewrap 正常工作，与 Linux 部署完全一致。

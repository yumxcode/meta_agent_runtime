#!/usr/bin/env bash
#
# setup-wsl2.sh — preflight + dependency setup for running meta-agent on a
# Windows machine via WSL2.
#
#   ./scripts/setup-wsl2.sh            # check only, print remediation
#   ./scripts/setup-wsl2.sh --install  # also apt-install the missing packages
#
# Exits non-zero when a REQUIRED check fails, so it can gate CI or an installer.
#
# Design note: this deliberately does NOT curl|bash a Node installer. Node
# version management is the operator's choice (nvm / nodesource / distro), and
# silently installing a runtime under sudo is not a thing a setup script should
# do. It tells you exactly what to run instead.

set -euo pipefail

INSTALL=0
[[ "${1:-}" == "--install" ]] && INSTALL=1

RED=$'\033[31m'; YELLOW=$'\033[33m'; GREEN=$'\033[32m'; DIM=$'\033[2m'; RESET=$'\033[0m'
FAILED=0
WARNED=0

ok()   { printf '%s  ok  %s %s\n' "$GREEN" "$RESET" "$1"; }
warn() { printf '%s warn %s %s\n' "$YELLOW" "$RESET" "$1"; WARNED=$((WARNED + 1)); }
fail() { printf '%s fail %s %s\n' "$RED" "$RESET" "$1"; FAILED=$((FAILED + 1)); }
hint() { printf '       %s%s%s\n' "$DIM" "$1" "$RESET"; }

echo "meta-agent — WSL2 preflight"
echo

# ── 1. Are we actually in WSL2? ──────────────────────────────────────────────
KERNEL="$(uname -r)"
if [[ ! "$KERNEL" =~ [Mm]icrosoft ]] && [[ -z "${WSL_DISTRO_NAME:-}" ]]; then
  fail "not running inside WSL (kernel: $KERNEL)"
  hint "Run this from a WSL2 shell. On Windows: wsl --install -d Ubuntu"
elif [[ "$KERNEL" =~ WSL2 ]] || [[ -n "${WSL_INTEROP:-}" ]]; then
  ok "WSL2 (${WSL_DISTRO_NAME:-unknown distro}, kernel $KERNEL)"
else
  fail "this looks like WSL1 (kernel: $KERNEL)"
  hint "WSL1 has no real Linux kernel; bwrap sandboxing and file semantics differ."
  hint "Convert: wsl --set-version ${WSL_DISTRO_NAME:-<distro>} 2"
fi

# ── 2. Is anything important on a Windows drive? ─────────────────────────────
# This is the single most consequential check in this script. See
# src/infra/platform/wsl.ts for why /mnt/<drive> breaks the durable Loop runtime.
fstype_of() {
  local target; target="$(readlink -f "$1" 2>/dev/null || echo "$1")"
  local best_len=0 best_type=""
  while read -r _dev mount type _rest; do
    [[ -z "$mount" || -z "$type" ]] && continue
    if [[ "$target" == "$mount" || "$target" == "$mount"/* || "$mount" == "/" ]]; then
      if (( ${#mount} >= best_len )); then best_len=${#mount}; best_type="$type"; fi
    fi
  done < /proc/mounts
  echo "$best_type"
}

check_path_fs() {
  local label="$1" path="$2"
  local type; type="$(fstype_of "$path")"
  case "$type" in
    9p|v9fs|virtiofs|drvfs|cifs|smbfs|smb3)
      fail "$label is on a Windows drive ($path, fstype=$type)"
      hint "link() can fail, rename() is not atomic and mtime is coarse there."
      hint "The Loop scheduler lock, withFileLock and WakeStore all depend on those."
      hint "Move it into the distro filesystem, e.g. ~/code/\$(basename \"$path\")"
      ;;
    "") warn "$label: could not determine filesystem for $path" ;;
    *)  ok "$label on $type ($path)" ;;
  esac
}

check_path_fs "workspace (cwd)" "$PWD"
check_path_fs "META_AGENT_HOME" "${META_AGENT_HOME:-$HOME/.meta-agent}"

# ── 3. Toolchain ─────────────────────────────────────────────────────────────
APT_WANTED=()

if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  if (( NODE_MAJOR >= 18 )); then
    ok "node $(node -v)"
    (( NODE_MAJOR < 20 )) && warn "node 18 is the floor; 20+ recommended (package.json engines: >=18)"
  else
    fail "node $(node -v) is below the required >=18"
    hint "nvm: nvm install 22 && nvm alias default 22"
  fi
else
  fail "node not found"
  hint "curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash && nvm install 22"
fi

command -v npm >/dev/null 2>&1 && ok "npm $(npm -v)" || fail "npm not found (ships with node)"

if command -v git >/dev/null 2>&1; then
  ok "git $(git --version | awk '{print $3}')"
else
  fail "git not found"; APT_WANTED+=(git)
fi

# bubblewrap gives sub-agents real OS-level sandboxing. Without it the runtime
# silently degrades to unsandboxed execution (see src/cli/bwrapCheck.ts).
if command -v bwrap >/dev/null 2>&1; then
  ok "bubblewrap $(bwrap --version | awk '{print $2}')"
else
  fail "bubblewrap (bwrap) not found — sub-agent sandboxing will be unavailable"
  APT_WANTED+=(bubblewrap)
fi

# ripgrep is optional: the grep tool has a pure-JS fallback, just much slower.
if command -v rg >/dev/null 2>&1; then
  ok "ripgrep $(rg --version | head -1 | awk '{print $2}')"
else
  warn "ripgrep (rg) not found — the grep tool falls back to a slow JS scan"
  APT_WANTED+=(ripgrep)
fi

# ── 4. Optional apt install ──────────────────────────────────────────────────
if (( ${#APT_WANTED[@]} > 0 )); then
  echo
  if (( INSTALL )); then
    echo "Installing: ${APT_WANTED[*]}"
    sudo apt-get update
    sudo apt-get install -y "${APT_WANTED[@]}"
    echo "Re-run this script to verify."
  else
    echo "To install the missing packages:"
    echo "  sudo apt-get update && sudo apt-get install -y ${APT_WANTED[*]}"
    echo "  (or re-run with --install)"
  fi
fi

# ── 5. Advisory notes ────────────────────────────────────────────────────────
echo
echo "Notes:"
echo "  - Exclude the WSL VHDX from Windows Defender real-time scanning, or every"
echo "    file write pays an AV round-trip:"
echo "      Add-MpPreference -ExclusionPath \"\$env:LOCALAPPDATA\\Packages\\CanonicalGroupLimited*\""
echo "  - Reach WSL files from Windows via \\\\wsl\$\\${WSL_DISTRO_NAME:-<distro>}\\home\\\$USER\\"
echo "  - Call Windows-side executables directly (nvidia-smi.exe), and convert paths"
echo "    with wslpath -w / wslpath -u when handing paths across the boundary."

echo
if (( FAILED > 0 )); then
  printf '%sPreflight failed: %d required check(s), %d warning(s).%s\n' "$RED" "$FAILED" "$WARNED" "$RESET"
  exit 1
fi
printf '%sPreflight passed%s%s\n' "$GREEN" "$( ((WARNED > 0)) && echo " with $WARNED warning(s)")" "$RESET"

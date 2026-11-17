#!/usr/bin/env bash
# eagle - EaglePanel commands on the server. Installed by deploy/install.sh as /usr/local/bin/eagle.
set -euo pipefail

APP=/opt/eaglepanel
INSTALLER=$APP/deploy/install.sh

usage() {
  cat <<'EOF'
Usage: eagle <command>

  eagle net                  choose how the panel is reached (menu)
  eagle net status           current panel access and installed VPNs or tunnels
  eagle net private [IP]     through the server private network (a private IP is created if there is none)
  eagle net public           through the public IP (opens the port in the firewall)
  eagle net tailscale        through the Tailscale IP
  eagle net wireguard [IP]   through the IP of a WireGuard interface
  eagle net cloudflared      how to connect with cloudflared
  eagle upgrade              install the latest release (the saved choices are kept)
  eagle upgrade --check      only say whether there is a newer release
  eagle upgrade --version V  install that release (--force to reinstall it or go back to an older one)
  eagle upgrade --full       also run every stack step (only the panel is replaced when the installer did not change)
  eagle version              installed panel version

  Option for net: --port PORT
EOF
}

[ "$(id -u)" -eq 0 ] || { echo "eagle must be run as root (sudo eagle ...)" >&2; exit 1; }
[ -f "$INSTALLER" ] || { echo "The panel was not found in /opt/eaglepanel." >&2; exit 1; }

net() {
  local mode="" args=()
  if [ $# -gt 0 ] && [ "${1#-}" = "$1" ]; then mode="$1"; shift; fi
  while [ $# -gt 0 ]; do
    case "$1" in
      --port) args+=(--panel-port "${2:-}"); shift ;;
      -h|--help) usage; exit 0 ;;
      *) args+=(--panel-ip "$1") ;;
    esac
    shift
  done
  case "$mode" in
    "") exec bash "$INSTALLER" --net-only "${args[@]}" ;;
    status|cloudflared) exec bash "$INSTALLER" --net-status ;;
    private|public|tailscale|wireguard) exec bash "$INSTALLER" --net-only --panel-access "$mode" "${args[@]}" ;;
    *) usage; exit 2 ;;
  esac
}

# The latest release of the update repository: the same one the panel checks (apps/api/src/updates.ts, or
# EAGLEPANEL_UPDATE_REPO in /etc/eaglepanel/update.env). The package is verified against its SHA256 before installing.
upgrade() {
  local check_only=0 force=0 mode=(--upgrade) target="" repo="" current latest order work
  while [ $# -gt 0 ]; do
    case "$1" in
      --check) check_only=1 ;;
      --force) force=1 ;;
      --full) mode=() ;;
      --version) target="${2:-}"; shift ;;
      -h|--help) usage; exit 0 ;;
      *) echo "Unknown option for upgrade: $1" >&2; usage; exit 2 ;;
    esac
    shift
  done

  if [ -f /etc/eaglepanel/update.env ]; then
    # Read as data, not sourced.
    repo="$(sed -n 's/^EAGLEPANEL_UPDATE_REPO=["'\'']\{0,1\}\([A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]*\)["'\'']\{0,1\}$/\1/p' /etc/eaglepanel/update.env | tail -n 1)"
    if [ -z "$repo" ] && grep -q '^EAGLEPANEL_UPDATE_URL=' /etc/eaglepanel/update.env; then
      echo "This server checks a custom update manifest (EAGLEPANEL_UPDATE_URL): install its packages by hand." >&2
      exit 1
    fi
  fi
  [ -n "$repo" ] || repo="$(sed -n 's/^const DEFAULT_UPDATE_REPO = "\(.*\)";$/\1/p' "$APP/apps/api/src/updates.ts")"
  [[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "No update repository is configured." >&2; exit 1; }

  current="$(cat "$APP/VERSION" 2>/dev/null || echo unknown)"
  if [ -n "$target" ]; then
    latest="${target#v}"
    [[ "$latest" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || { echo "Invalid version: $target (such as 0.2.0)" >&2; exit 1; }
  else
    latest="$(curl -fsSL --proto '=https' --tlsv1.2 --retry 3 -H 'accept: application/vnd.github+json' \
      "https://api.github.com/repos/$repo/releases/latest" |
      /usr/local/bin/bun -e 'const r = await Bun.stdin.json(); console.log(String(r.tag_name ?? "").replace(/^v/i, ""))')" || true
    [[ "$latest" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || latest=""
    [ -n "$latest" ] || { echo "Could not get the latest release of $repo." >&2; exit 1; }
  fi

  # The same comparison the panel uses (SemVer: 0.1.0+202611170126 equals 0.1.0).
  order="$(BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 /usr/local/bin/bun -e \
    'const { compareVersions } = await import(process.argv[1]); console.log(Math.sign(compareVersions(process.argv[2], process.argv[3])))' \
    "$APP/apps/api/src/updates.ts" "$latest" "$current" 2>/dev/null)" || order=1
  [[ "$order" =~ ^-?[01]$ ]] || order=1
  if [ "$order" -le 0 ] && { [ "$force" -eq 0 ] || [ "$check_only" -eq 1 ]; }; then
    if [ "$order" -eq 0 ]; then echo "EaglePanel $current is up to date."
    else echo "EaglePanel $current is newer than $latest. To install $latest anyway: eagle upgrade --version $latest --force"; fi
    exit 0
  fi
  if [ "$check_only" -eq 1 ]; then
    echo "Update available: $current -> $latest"
    echo "To install it: sudo eagle upgrade"
    exit 0
  fi

  work="$(mktemp -d /root/eaglepanel-upgrade.XXXXXX)"
  # shellcheck disable=SC2064 # expanded now on purpose: $work is local
  trap "rm -rf '$work'" EXIT
  local base="https://github.com/$repo/releases/download/v$latest" name="eaglepanel-$latest.tar.gz"
  echo "Downloading EaglePanel $latest ($current installed)"
  (cd "$work" &&
    curl -fsSL --proto '=https' --tlsv1.2 --retry 3 -o "$name" "$base/$name" &&
    curl -fsSL --proto '=https' --tlsv1.2 --retry 3 -o "$name.sha256" "$base/$name.sha256") ||
    { echo "Download failed: $base/$name" >&2; exit 1; }
  (cd "$work" && sha256sum -c --quiet "$name.sha256") || { echo "The package does not match its SHA256: not installed." >&2; exit 1; }
  tar -C "$work" -xzf "$work/$name"
  [ "$(cat "$work/eaglepanel/VERSION" 2>/dev/null)" = "$latest" ] || { echo "The package is not version $latest: not installed." >&2; exit 1; }

  # Not exec: the trap removes the download when the installer ends. The installer replaces this command too.
  # --upgrade: when its installer is the one that last completed here, only the panel is replaced.
  bash "$work/eaglepanel/deploy/install.sh" "${mode[@]}" </dev/null
}

case "${1:-}" in
  net) shift; net "$@" ;;
  upgrade) shift; upgrade "$@" ;;
  version) cat "$APP/VERSION" ;;
  ""|-h|--help|help) usage ;;
  *) echo "Unknown command: $1" >&2; usage; exit 2 ;;
esac

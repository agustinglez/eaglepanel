#!/usr/bin/env bash
# eagle - EaglePanel commands on the server. Installed by deploy/install.sh as /usr/local/bin/eagle.
set -euo pipefail

INSTALLER=/opt/eaglepanel/deploy/install.sh

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

case "${1:-}" in
  net) shift; net "$@" ;;
  version) cat /opt/eaglepanel/VERSION ;;
  ""|-h|--help|help) usage ;;
  *) echo "Unknown command: $1" >&2; usage; exit 2 ;;
esac

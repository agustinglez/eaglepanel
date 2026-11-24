#!/usr/bin/env bash
# EaglePanel - downloads a release, verifies it and runs its installer. Published with every release.
#
#   curl -fsSL https://eagle.agust.in | sudo bash
#
# eagle.agust.in redirects to this file in the latest GitHub release; the package always comes from GitHub.
#
# Every option goes to deploy/install.sh (see its --help). To update, the same line without options: the choices
# made on the first run are saved. A specific version instead of the latest: ... | sudo EAGLEPANEL_VERSION=0.2.0 bash
#
# Everything is inside main(), called on the last line: a download cut halfway runs nothing.

set -euo pipefail

REPO="agustinglez/eaglepanel"

main() {
  [ "$(id -u)" -eq 0 ] || { echo "Run it as root: curl -fsSL <url> | sudo bash -s -- [options]" >&2; exit 1; }
  for tool in curl tar sha256sum; do
    command -v "$tool" >/dev/null || { echo "$tool is needed: apt-get install -y $tool" >&2; exit 1; }
  done

  local base name
  if [ -n "${EAGLEPANEL_VERSION:-}" ]; then
    EAGLEPANEL_VERSION="${EAGLEPANEL_VERSION#v}"
    [[ "$EAGLEPANEL_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || { echo "Invalid version: $EAGLEPANEL_VERSION (such as 0.2.0)" >&2; exit 1; }
    base="https://github.com/$REPO/releases/download/v$EAGLEPANEL_VERSION"
    name="eaglepanel-$EAGLEPANEL_VERSION.tar.gz"
  else
    base="https://github.com/$REPO/releases/latest/download"
    name="eaglepanel.tar.gz"
  fi

  local work
  work="$(mktemp -d /root/eaglepanel-get.XXXXXX)"
  # shellcheck disable=SC2064 # expanded now on purpose: $work is local
  trap "rm -rf '$work'" EXIT

  echo "Downloading $base/$name"
  (cd "$work" &&
    curl -fsSL --proto '=https' --tlsv1.2 --retry 3 -o "$name" "$base/$name" &&
    curl -fsSL --proto '=https' --tlsv1.2 --retry 3 -o "$name.sha256" "$base/$name.sha256") ||
    { echo "Download failed." >&2; exit 1; }
  (cd "$work" && sha256sum -c --quiet "$name.sha256") || { echo "The package does not match its SHA256: not installed." >&2; exit 1; }
  tar -C "$work" -xzf "$work/$name"

  echo "EaglePanel $(cat "$work/eaglepanel/VERSION"): running the installer"
  # stdin is this script: the installer asks through /dev/tty when there is a terminal.
  bash "$work/eaglepanel/deploy/install.sh" "$@" </dev/null
}

main "$@"

#!/usr/bin/env bash
# EaglePanel - builds the package for a server. Runs on the development machine, from any directory.
# Usage: bash deploy/package.sh
#
# Produces dist-deploy/eaglepanel-<version>.tar.gz and its .sha256. On the server:
#   sha256sum -c eaglepanel-<version>.tar.gz.sha256
#   tar -xzf eaglepanel-<version>.tar.gz && cd eaglepanel
#   sudo bash deploy/install.sh --firewall cloudflare     (or --firewall open)

set -euo pipefail
cd "$(dirname "$0")/.."

# The version is the one in package.json (SemVer). A local build adds the build time, 0.1.0+202611162215: SemVer
# ignores it when comparing versions, but the installer sees a different version and updates the panel. The release
# workflow passes the exact version of its tag in EAGLEPANEL_VERSION.
SEMVER='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$'
BASE_VERSION="$(sed -n 's/^  "version": "\(.*\)",$/\1/p' package.json)"
VERSION="${EAGLEPANEL_VERSION:-$BASE_VERSION+$(date -u +%Y%m%d%H%M)}"
[[ "$VERSION" =~ $SEMVER ]] || { echo "Invalid version: $VERSION (expected SemVer, such as 1.2.3)" >&2; exit 1; }

bun test
bun run typecheck
bun run build

NAME="eaglepanel-$VERSION"
OUT="$PWD/dist-deploy"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$OUT" "$STAGE/eaglepanel"
# No local data, secrets or tests. deploy/ is included: it is the installer.
tar -cf - \
  --exclude='node_modules' \
  --exclude='.data' \
  --exclude='.sandbox' \
  --exclude='.env' \
  --exclude='.claude' \
  --exclude='.git' \
  --exclude='.github' \
  --exclude='dist-deploy' \
  --exclude='./deploy/package.sh' \
  --exclude='*.pem' \
  --exclude='*.key' \
  --exclude='*.tsbuildinfo' \
  --exclude='testdata' \
  --exclude='*.test.ts' \
  . | tar -C "$STAGE/eaglepanel" -xf -
printf '%s\n' "$VERSION" >"$STAGE/eaglepanel/VERSION"
# What runs on the server with root privileges: no Windows line endings.
for script in "$STAGE"/eaglepanel/deploy/*.sh; do sed -i 's/\r$//' "$script"; done

tar -C "$STAGE" -czf "$OUT/$NAME.tar.gz" eaglepanel
(cd "$OUT" && sha256sum "$NAME.tar.gz" >"$NAME.tar.gz.sha256")
echo "Done: dist-deploy/$NAME.tar.gz"
cat "$OUT/$NAME.tar.gz.sha256"

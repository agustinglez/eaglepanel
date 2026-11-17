#!/usr/bin/env bash
# shellcheck disable=SC2034
# EaglePanel - unified installer. Installs or updates everything: the stack (OpenLiteSpeed, lsphp, MySQL, Redis,
# Memcached, vsftpd, Podman, restic, Bun), server hardening and the panel.
#
# Safe to run as many times as needed: each step checks the current state and changes only what is missing. If a
# step fails, the installer stops there with the reason; running it again resumes from that step. Every system file
# it touches is backed up first to /var/backups/eaglepanel-installer. Third-party downloads are verified against
# fingerprints and hashes pinned here: no script downloaded from the internet is ever executed.
#
# Supports Ubuntu 24.04 and 26.04, and Debian 12 and 13, on amd64 or arm64.
#
# Usage, as root, from the package directory:
#   bash deploy/install.sh --firewall cloudflare|open [--public-ip IP] [--admin USERNAME]
#   bash deploy/install.sh --plan         shows what would be installed and changed, changes nothing
#   bash deploy/install.sh --check        checks an installed server, changes nothing
#
#   Before changing anything the installer shows its plan. What already exists on the server (MySQL, ufw, vsftpd,
#   /etc/fstab...) is listed with the exact changes; on a first installation with a terminal each one is confirmed:
#   apply it, or show the steps to do it by hand and stop. --yes applies everything without asking.
#
#   --firewall cloudflare  ports 80 and 443 from Cloudflare ranges only (servers behind its proxy)
#   --firewall open        ports 80 and 443 from any source
#   --panel-access private|public|tailscale|wireguard   how the panel is reached (always over HTTPS).
#                          Without this option, it is asked when a terminal is available; otherwise, private network.
#   --panel-ip IP          the exact IP, when there is more than one for that mode
#   --panel-port PORT      8090 by default
#   --admin-password-file PATH  the new admin password is written to that file (root only) instead of the screen
#   --yes                  no questions: apply the plan (always the case without a terminal)
#   Choices are saved: later runs do not need them again. To change panel access later: eagle net

set -Eeuo pipefail
umask 022
export LC_ALL=C DEBIAN_FRONTEND=noninteractive
exec </dev/null

# ---------------------------------------------------------------------------- Pinned versions
# To update: change the version and its hash, taken from the official SHA256SUMS of that version.
# They are read by name according to the architecture (${!sha_var}): hence the shellcheck SC2034 above.
BUN_VERSION=1.4.4
BUN_SHA256_amd64=bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c
BUN_SHA256_arm64=baa6bb36f51d6e58561e02bbea825038a9df454f673d6d776e8bbf86f8c7850e
RESTIC_VERSION=0.19.1
RESTIC_SHA256_amd64=f415415624dcc452f2a02b8c33641791a8c6d6d3b65bbb3543fcf9a25151585c
RESTIC_SHA256_arm64=a5f64aaab53d51e311fa3829124c5b703f2d14cf187d8640b6be3b2b49376465
# The distribution restic works from this version on (--stdin-from-command).
RESTIC_MIN=0.17.0
# Repository key fingerprints: if the downloaded key does not match, nothing is installed.
LITESPEED_KEYS=(
  "https://rpms.litespeedtech.com/debian/lst_repo.gpg 3E892522DB44E1B063D366C5011AA62DEDA1F085"
  "https://rpms.litespeedtech.com/debian/lst_debian_repo.gpg 42259994257E19EB6A91CA853F6F627083084D0E"
)
MYSQL_KEY="https://repo.mysql.com/RPM-GPG-KEY-mysql-2023 BCA43417C3B485DD128EC6D4B7B3B788A8D3785C"
PHP_VERSION=85

# ---------------------------------------------------------------------------- Paths
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE="$(cd "$HERE/.." && pwd)"
LSWS=/usr/local/lsws
OLS_CONF="$LSWS/conf/httpd_config.conf"
APP=/opt/eaglepanel
CONF_DIR=/etc/eaglepanel
SETTINGS="$CONF_DIR/install.conf"
BACKUPS=/var/backups/eaglepanel-installer
DB=/var/lib/eaglepanel/eaglepanel.db
LOG=/var/log/eaglepanel-install.log
FTP_DIR="$CONF_DIR/ftp"
FTP_CERT=/etc/ssl/private/eaglepanel-ftp.pem
PASV_MIN=9000
PASV_MAX=10000
CF_IPS="$CONF_DIR/cloudflare-ips.txt"
KEYRINGS=/usr/share/keyrings
STAMP="$(date +%Y%m%d-%H%M%S)"

# ---------------------------------------------------------------------------- Options
CHECK_ONLY=0
PLAN_ONLY=0
ASSUME_YES=0
FIREWALL=""
PUBLIC_IP=""
ADMIN_USER=""
ADMIN_PASSWORD_FILE=""
PANEL_ACCESS=""
PANEL_IP=""
PANEL_PORT=""
NET_ONLY=0
NET_STATUS=0
while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK_ONLY=1 ;;
    --plan) PLAN_ONLY=1 ;;
    -y|--yes) ASSUME_YES=1 ;;
    --firewall) FIREWALL="${2:-}"; shift ;;
    --public-ip) PUBLIC_IP="${2:-}"; shift ;;
    --admin) ADMIN_USER="${2:-}"; shift ;;
    --admin-password-file) ADMIN_PASSWORD_FILE="${2:-}"; shift ;;
    --panel-access) PANEL_ACCESS="${2:-}"; shift ;;
    --panel-ip) PANEL_IP="${2:-}"; shift ;;
    --panel-port) PANEL_PORT="${2:-}"; shift ;;
    # Used by `eagle net`: panel access only, on an existing installation.
    --net-only) NET_ONLY=1 ;;
    --net-status) NET_STATUS=1 ;;
    -h|--help) sed -n '2,/^$/p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)"; exit 2 ;;
  esac
  shift
done

# ---------------------------------------------------------------------------- Utilities
CURRENT="starting"
FAILS=0
step() { CURRENT="$1"; printf '\n==> %s\n' "$1"; }
info() { printf '    %s\n' "$*"; }
ok() { printf 'OK    %s\n' "$*"; }
bad() { printf 'FAIL  %s\n' "$*"; FAILS=$((FAILS + 1)); }
die() { printf '\nERROR in "%s": %s\n' "$CURRENT" "$*" >&2; exit 1; }
on_error() {
  local code=$? line=$1
  # An error inside $(...) also triggers the trap: it is reported only once, from the main process.
  [ "$BASH_SUBSHELL" -eq 0 ] || exit "$code"
  printf '\nERROR in "%s" (line %s, code %s).\n' "$CURRENT" "$line" "$code" >&2
  printf 'Everything done so far is consistent: each step is either complete or not applied. Check %s and run the installer again.\n' "$LOG" >&2
  exit "$code"
}
trap 'on_error $LINENO' ERR

apt_get() { apt-get -o DPkg::Lock::Timeout=600 -o Dpkg::Use-Pty=0 -o Dpkg::Options::=--force-confold "$@"; }
installed() { dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q 'ok installed'; }
apt_install() {
  local missing=()
  for pkg in "$@"; do installed "$pkg" || missing+=("$pkg"); done
  [ ${#missing[@]} -eq 0 ] && return 0
  info "installing: ${missing[*]}"
  apt_get install -y -q "${missing[@]}"
}

# Copy of a system file before touching it. The first one stays as the original.
backup() {
  local file="$1" dest
  [ -e "$file" ] || return 0
  dest="$BACKUPS/$STAMP$(dirname "$file")"
  install -d -m 700 "$dest"
  cp -a "$file" "$dest/"
}

# Writes stdin to $1 only if it changes; keeps the backup and signals it through the exit code (0: changed).
write_file() {
  local path="$1" mode="$2" tmp
  install -d "$(dirname "$path")"
  tmp="$(mktemp "$path.XXXXXX")"
  cat >"$tmp"
  if [ -f "$path" ] && cmp -s "$tmp" "$path"; then
    rm -f "$tmp"
    return 1
  fi
  backup "$path"
  chmod "$mode" "$tmp"
  mv -f "$tmp" "$path"
  return 0
}

# Downloads and verifies against the pinned hash. The file is kept only if it matches.
download() {
  local url="$1" sha="$2" dest="$3" tmp
  tmp="$(mktemp)"
  curl -fsSL --proto '=https' --tlsv1.2 --retry 3 -o "$tmp" "$url" || { rm -f "$tmp"; die "could not download $url"; }
  echo "$sha  $tmp" | sha256sum -c --quiet - || { rm -f "$tmp"; die "$url does not match its pinned hash: not used"; }
  mv -f "$tmp" "$dest"
}

# Fetches a key over HTTPS and stores it only if its fingerprint is the pinned one.
install_key() {
  local url="$1" fingerprint="$2" dest="$3" tmp got
  tmp="$(mktemp -d)"
  curl -fsSL --proto '=https' --tlsv1.2 --retry 3 -o "$tmp/key" "$url" || { rm -rf "$tmp"; die "could not download the key $url"; }
  got="$(gpg --show-keys --with-colons "$tmp/key" 2>/dev/null | awk -F: '/^fpr/ && !seen { print $10; seen = 1 }' || true)"
  [ "$got" = "$fingerprint" ] || { rm -rf "$tmp"; die "the key at $url has fingerprint $got; expected $fingerprint"; }
  gpg --dearmor <"$tmp/key" >"$tmp/key.gpg" 2>/dev/null || cp "$tmp/key" "$tmp/key.gpg"
  install -m 644 "$tmp/key.gpg" "$dest"
  rm -rf "$tmp"
}

version_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | sed -n 1p)" = "$2" ]; }
# Always exits with 0: on the first installation the file does not exist, and with set -e that would stop the installer.
setting() { [ -f "$SETTINGS" ] || return 0; sed -n "s/^$1=//p" "$SETTINGS" | tail -n 1; }
is_private_ip() { grep -qE '^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.)' <<<"$1"; }
valid_ipv4() { grep -qE '^([0-9]{1,3}\.){3}[0-9]{1,3}$' <<<"$1"; }
# `quotaon -p` exits with 1 when the quota is enabled: with pipefail, a `| grep` would always be false.
quota_on() { local out; out="$(quotaon -p / 2>/dev/null || true)"; grep -qE '^user quota on .* is on$' <<<"$out"; }
ols_valid() { ! timeout 30 "$LSWS/bin/openlitespeed" -t 2>&1 | grep -q '\[ERROR\]'; }

# ---------------------------------------------------------------------------- Preflight checks
preflight() {
  step "Preflight checks"
  [ "$(id -u)" -eq 0 ] || die "must be run as root"
  # shellcheck disable=SC1091
  . /etc/os-release
  OS_ID="${ID:-}"
  CODENAME="${VERSION_CODENAME:-}"
  case "$OS_ID:$CODENAME" in
    ubuntu:noble|ubuntu:resolute|debian:bookworm|debian:trixie) ok "$PRETTY_NAME" ;;
    *) die "unsupported system ($PRETTY_NAME): Ubuntu 24.04/26.04 or Debian 12/13" ;;
  esac
  ARCH="$(dpkg --print-architecture)"
  case "$ARCH" in amd64|arm64) ok "architecture $ARCH" ;; *) die "unsupported architecture: $ARCH" ;; esac
  [ -d /run/systemd/system ] || die "systemd is required"
  local kernel
  kernel="$(uname -r | cut -d- -f1)"
  # nosymfollow, which isolates the accounts, exists since Linux 5.10.
  version_ge "$kernel" 5.10 || die "kernel $kernel does not support nosymfollow (5.10 or later is required)"
  local free_gb
  free_gb="$(df -BG --output=avail / | tail -n 1 | tr -dc 0-9)"
  [ "${free_gb:-0}" -ge 10 ] || die "${free_gb} GB free on /: at least 10 are required"
  installed mariadb-server && die "MariaDB is installed and conflicts with MySQL. It is not removed automatically: that would delete data"
  [ -d /usr/local/CyberCP ] && die "CyberPanel is installed: refusing to install on top of it"
  systemctl is-active --quiet firewalld 2>/dev/null && die "firewalld is active: the installer uses ufw"

  # Ports 80 and 443 free, or already used by OpenLiteSpeed.
  local busy
  busy="$(ss -tlnpH 2>/dev/null | awk '$4 ~ /:(80|443)$/ && $4 !~ /^127\./ && $0 !~ /litespeed|lshttpd/' || true)"
  [ -z "$busy" ] || die "port 80 or 443 is already used by another service: $busy"

  if [ "$CHECK_ONLY" -eq 0 ]; then
    FIREWALL="${FIREWALL:-$(setting FIREWALL)}"
    case "$FIREWALL" in
      cloudflare|open) ok "site firewall: $FIREWALL" ;;
      *) [ "$PLAN_ONLY" -eq 1 ] && info "site firewall: not chosen yet (--firewall cloudflare|open)" || die "--firewall cloudflare|open is required on the first installation" ;;
    esac
    PUBLIC_IP="${PUBLIC_IP:-$(setting PUBLIC_IP)}"
    if [ -z "$PUBLIC_IP" ]; then
      PUBLIC_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1) }' | sed -n 1p)"
      if [ -z "$PUBLIC_IP" ] || is_private_ip "$PUBLIC_IP"; then
        # Behind NAT: Cloudflare is asked, since it is already trusted with the traffic.
        PUBLIC_IP="$(curl -4 -fsS --max-time 10 https://www.cloudflare.com/cdn-cgi/trace 2>/dev/null | sed -n 's/^ip=//p' || true)"
      fi
    fi
    valid_ipv4 "$PUBLIC_IP" && ! is_private_ip "$PUBLIC_IP" || die "could not determine the public IP (for passive FTP): pass it with --public-ip"
    ok "public IP: $PUBLIC_IP"
    ADMIN_USER="${ADMIN_USER:-$(setting ADMIN_USER)}"
    ADMIN_USER="${ADMIN_USER:-admin}"
    grep -qE '^[a-zA-Z0-9._-]{3,64}$' <<<"$ADMIN_USER" || die "invalid admin username: $ADMIN_USER"
  fi
}

save_settings() {
  install -d -m 755 "$CONF_DIR"
  write_file "$SETTINGS" 600 <<EOF || true
# Choices made by the installer. Used on later runs.
FIREWALL=$FIREWALL
PUBLIC_IP=$PUBLIC_IP
ADMIN_USER=$ADMIN_USER
PANEL_ACCESS=$PANEL_ACCESS
PANEL_ADDRESS=$PANEL_ADDRESS
PANEL_PORT=$PANEL_PORT
EOF
}

# ---------------------------------------------------------------------------- Installation plan
# Before changing anything, the installer reports what is already on the server and what it will do with it. Files and
# services that belong to EaglePanel are simply created. What already existed (a running MySQL, an active ufw,
# /etc/fstab...) is listed with the exact changes. On a first installation with a terminal, each of those is confirmed:
# apply it, or print the steps to do it by hand and stop without changing anything. The next run detects what was done
# and leaves it alone. Without a terminal, or with --yes, everything is applied (automation, updates).
PLAN_ROWS=()
BLOCKERS=()
REVIEW_KEYS=()
declare -A REVIEW_TITLE=() REVIEW_CHANGES=() REVIEW_NOTES=() REVIEW_MANUAL=()
NL=$'\n'
FTP_MARK="# Generated by the EaglePanel installer."

pkg_version() { dpkg-query -W -f='${Version}' "$1" 2>/dev/null | sed -E 's/^[0-9]+://; s/[-+~].*//' || true; }
plan_row() { PLAN_ROWS+=("$1|$2|$3"); }
review() { REVIEW_KEYS+=("$1"); REVIEW_TITLE[$1]="$2"; REVIEW_CHANGES[$1]="$3"; REVIEW_NOTES[$1]="$4"; REVIEW_MANUAL[$1]="$5"; }
joined() { local out; out="$(printf '%s, ' "$@")"; printf '%s' "${out%, }"; }
mysql_var() { mysql --protocol=socket -uroot -N -B -e "SELECT @@$1" 2>/dev/null || true; }
ssh_ports() { local p; p="$(sshd -T 2>/dev/null | awk '$1 == "port" { print $2 }' | sort -u || true)"; printf '%s\n' "${p:-22}"; }

# Rules not managed by the panel that open 80/443 to anyone, numbered, last first (to delete them in that order).
ufw_open_web_rules() { ufw status numbered 2>/dev/null | grep -vF 'EaglePanel' | grep -E '^\[ *[0-9]+\] +(80|443|80,443)(/tcp)?( \(v6\))? +ALLOW IN +Anywhere' | tac || true; }

# Ports listening outside loopback that enabling ufw would close: not SSH, FTP or web, and without a rule of their own.
# $2: ports to ignore (the plan runs before MySQL, Redis and the OLS WebAdmin are moved to 127.0.0.1).
ufw_would_close() {
  local ssh="$1" ignore="${2:-}" entry port proto status="" low high
  command -v ufw >/dev/null && status="$(ufw status 2>/dev/null | grep -w ALLOW || true)"
  # Bound UDP sockets in the ephemeral range are clients (DNS, a VPN, cloudflared), not services: replies get through.
  read -r low high </proc/sys/net/ipv4/ip_local_port_range
  for entry in $(ss -H -tuln | awk '{ split($5, a, ":"); port = a[length(a)]; addr = substr($5, 1, length($5) - length(port) - 1) }
      addr !~ /^(127\.|\[::1\]|::1)/ && port !~ /^(80|443|21)$/ { print port "/" $1 }' | sort -u); do
    port="${entry%/*}" proto="${entry#*/}"
    [[ "$port" =~ ^[0-9]+$ ]] || continue
    [ "$port" -ge "$PASV_MIN" ] && [ "$port" -le "$PASV_MAX" ] && continue
    if [ "$proto" = udp ]; then
      case "$port" in 68|546) continue ;; esac  # DHCP clients
      [ "$port" -ge "$low" ] && [ "$port" -le "$high" ] && continue
    fi
    grep -qxF "$port" <<<"$ssh" && continue
    grep -qwF "$port" <<<"$ignore" && continue
    # Already allowed, alone, in a list (80,443/tcp) or in a range (21115:21119/tcp).
    awk -v p="$port" -v pr="$proto" '{
        n = split($1, x, "/"); if (n > 1 && x[2] != pr) next
        m = split(x[1], list, ",")
        for (i = 1; i <= m; i++) {
          if (split(list[i], r, ":") == 2) { if (p + 0 >= r[1] + 0 && p + 0 <= r[2] + 0) found = 1 }
          else if (list[i] == p) found = 1
        }
      } END { exit !found }' <<<"$status" && continue
    echo "$port/$proto"
  done
}

plan_system() {
  local changes="" notes="" manual="" summary=() fstype links
  fstype="$(findmnt -no FSTYPE /)"
  [ "$fstype" = ext4 ] || BLOCKERS+=("/ is $fstype: the per-account disk quotas need ext4")
  if [ -z "$(swapon --noheadings --show=NAME 2>/dev/null)" ] && [ "$(awk '/MemTotal/ { print int($2 / 1048576) }' /proc/meminfo)" -lt 8 ]; then
    summary+=("2 GB swap")
    changes+="add a 2 GB swap file, /swapfile (less than 8 GB of RAM and no swap)$NL"
    manual+="fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile$NL"
    manual+="echo '/swapfile none swap sw 0 0' >>/etc/fstab$NL"
  fi
  if ! findmnt -no OPTIONS / | grep -q usrquota || ! quota_on; then
    summary+=("disk quotas")
    changes+="enable user and group disk quotas on / (usrquota,grpquota in /etc/fstab, then remount)$NL"
    manual+="apt install quota    # on Ubuntu cloud kernels also: apt install linux-modules-extra-\$(uname -r)$NL"
    manual+="# /etc/fstab: add usrquota,grpquota to the options of the / line, then:$NL"
    manual+="systemctl daemon-reload && mount -o remount / && quotacheck -cugm / && quotaon -ug /$NL"
  fi
  if ! grep -qE '^/home[[:space:]]+/home[[:space:]]+none[[:space:]]+bind,nosymfollow' /etc/fstab; then
    summary+=("/home nosymfollow")
    changes+="bind-mount /home onto itself with nosymfollow (/etc/fstab): symbolic links under /home are no longer followed, so an account cannot reach another one's files$NL"
    manual+="echo '/home /home none bind,nosymfollow,nofail 0 0' >>/etc/fstab && systemctl daemon-reload && mount /home$NL"
    links="$(find /home -mindepth 1 -maxdepth 4 -type l 2>/dev/null | wc -l || true)"
    [ "${links:-0}" -eq 0 ] || notes+="$links symbolic link(s) under /home stop working, for example $(find /home -mindepth 1 -maxdepth 4 -type l -print -quit 2>/dev/null || true)$NL"
  fi
  if ! awk '$2 == "/proc" && $1 !~ /^#/ && $4 ~ /hidepid=(2|invisible)/ { found = 1 } END { exit !found }' /etc/fstab; then
    summary+=("/proc hidepid")
    changes+="mount /proc with hidepid=invisible (/etc/fstab): each user sees only their own processes$NL"
    manual+="# /etc/fstab: replace the /proc line, or add it, with: proc /proc proc defaults,hidepid=invisible 0 0$NL"
    manual+="systemctl daemon-reload && mount -o remount,hidepid=invisible /proc$NL"
    notes+="monitoring tools that run as a regular user will only see their own processes$NL"
  fi
  if [ ${#summary[@]} -eq 0 ]; then plan_row "System" "-" "already configured"; return 0; fi
  plan_row "System" "-" "$(joined "${summary[@]}")"
  review system "System settings in /etc/fstab" "$changes" "$notes" "$manual"
}

plan_litespeed() {
  local php="lsphp$PHP_VERSION" missing=() pkg
  for pkg in "$php" "$php-common" "$php-mysql" "$php-redis" "$php-memcached"; do installed "$pkg" || missing+=("$pkg"); done
  if ! installed openlitespeed; then
    plan_row "OpenLiteSpeed" "not installed" "install, with $php and its extensions"
    return 0
  fi
  local version changes="" notes="" manual="" legacy admin="$LSWS/admin/conf/admin_config.conf" allow vhosts
  version="$(pkg_version openlitespeed)"
  [ ${#missing[@]} -eq 0 ] || changes+="install ${missing[*]}$NL"
  for legacy in /etc/apt/sources.list.d/lst_debian_repo.list /etc/apt/trusted.gpg.d/lst_repo.gpg /etc/apt/trusted.gpg.d/lst_debian_repo.gpg; do
    [ -e "$legacy" ] || continue
    changes+="replace the LiteSpeed apt source and its keys in trusted.gpg.d with keys valid only for that repository$NL"
    manual+="rm -f /etc/apt/sources.list.d/lst_debian_repo.list /etc/apt/trusted.gpg.d/lst_repo.gpg /etc/apt/trusted.gpg.d/lst_debian_repo.gpg$NL"
    break
  done
  if [ -f "$OLS_CONF" ]; then
    if grep -qE '^[[:space:]]*address[[:space:]]+\*:8088' "$OLS_CONF"; then
      changes+="example listener: *:8088 -> 127.0.0.1:8088$NL"
      manual+="# $OLS_CONF: in the listener on *:8088, set: address 127.0.0.1:8088$NL"
    fi
    if [ -f "$admin" ] && grep -qE '^[[:space:]]*address[[:space:]]+\*:7080' "$admin"; then
      changes+="WebAdmin: *:7080 -> 127.0.0.1:7080$NL"
      notes+="the WebAdmin is then reachable only from the server itself (SSH tunnel)$NL"
      manual+="# $admin: set: address 127.0.0.1:7080$NL"
    fi
    if ! grep -qE '^quicEnable[[:space:]]+0' "$OLS_CONF" || grep -qE '^[[:space:]]+quicEnable[[:space:]]+1[[:space:]]*$' "$OLS_CONF"; then
      changes+="QUIC off: Cloudflare does not use it toward the origin, and it keeps UDP 443 open$NL"
      manual+="# $OLS_CONF: quicEnable 0, both at server level and in the tuning block$NL"
    fi
    if ! grep -qE '^useIpInProxyHeader[[:space:]]+2' "$OLS_CONF"; then
      changes+="useIpInProxyHeader 2: the visitor IP is taken from the proxy header only when the request comes from Cloudflare$NL"
      manual+="# $OLS_CONF: useIpInProxyHeader 2$NL"
    fi
    allow="$(sed -n '/^accessControl/,/^}/ s/^[[:space:]]*allow[[:space:]]\{1,\}//p' "$OLS_CONF" | sed -n 1p)"
    if ! grep -qE '^ALL,.*T(,|$)' <<<"$allow"; then
      changes+="server access control: allow ALL, with the Cloudflare ranges as trusted proxies (now: ${allow:-empty})$NL"
      manual+="# $OLS_CONF, block accessControl: allow ALL, then each range of https://www.cloudflare.com/ips/ followed by T$NL"
      [ -z "$allow" ] || grep -qE '^ALL[[:space:]]*$' <<<"$allow" || notes+="the current allow list ($allow) is replaced$NL"
    fi
  fi
  if [ -z "$changes" ]; then plan_row "OpenLiteSpeed" "$version" "already configured"; return 0; fi
  changes+="restart OpenLiteSpeed (sites stop for a few seconds)$NL"
  manual+="systemctl stop lshttpd && systemctl start lshttpd$NL"
  vhosts="$(grep -cE '^virtualhost[[:space:]]' "$OLS_CONF" 2>/dev/null || true)"
  [ "${vhosts:-0}" -eq 0 ] || notes+="$vhosts existing virtual host(s) are kept as they are$NL"
  plan_row "OpenLiteSpeed" "$version" "configure (details below)"
  review ols "OpenLiteSpeed $version is already installed" "$changes" "$notes" "$manual"
}

mysql_cnf() {
  cat <<'EOF'
# Generated by the EaglePanel installer.
[mysqld]
bind-address = 127.0.0.1
mysqlx-bind-address = 127.0.0.1
disable_log_bin
local_infile = 0
EOF
}
mysql_dropin() {
  cat <<'EOF'
# Generated by the EaglePanel installer.
[Service]
RuntimeDirectoryPreserve=yes
EOF
}
# The settings the panel needs, read from the running MySQL: whoever already has them by other means is not touched.
mysql_settings_ok() {
  local xbind
  [ "$(mysql_var bind_address)" = 127.0.0.1 ] && [ "$(mysql_var log_bin)" = 0 ] && [ "$(mysql_var local_infile)" = 0 ] || return 1
  # Without the X plugin there is nothing listening, so there is nothing to restrict.
  xbind="$(mysql_var mysqlx_bind_address)"
  [ -z "$xbind" ] || [ "$xbind" = 127.0.0.1 ]
}

plan_mysql() {
  if ! command -v mysqld >/dev/null && ! installed mysql-server && ! installed mysql-community-server; then
    plan_row "MySQL" "not installed" "install $([ "$OS_ID" = debian ] && echo "8.4 LTS from the Oracle repository" || echo "from $PRETTY_NAME")"
    return 0
  fi
  local version now changes="" notes="" manual="" bind xbind dbs
  version="$(mysqld --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | sed -n 1p || true)"
  version="${version:-installed}"
  now="$version"
  if [ -f /etc/mysql/conf.d/eaglepanel.cnf ]; then
    : # Already the panel's: it is kept up to date without asking.
  elif ! systemctl is-active --quiet mysql; then
    now="$version, stopped"
    changes+="add /etc/mysql/conf.d/eaglepanel.cnf: only local connections, no binary logs, no LOAD DATA LOCAL (MySQL is stopped: its current settings cannot be read)$NL"
  elif [ -z "$(mysql_var version)" ]; then
    BLOCKERS+=("MySQL: root cannot log in through the socket (sudo mysql). The panel manages databases that way: give root@localhost the auth_socket plugin back, then run the installer again")
    plan_row "MySQL" "$version" "-"
    return 0
  elif ! mysql_settings_ok; then
    bind="$(mysql_var bind_address)"
    xbind="$(mysql_var mysqlx_bind_address)"
    [ "$bind" = 127.0.0.1 ] || { changes+="bind-address 127.0.0.1 (now $bind)$NL"; notes+="clients that connect from other hosts lose access$NL"; }
    [ -z "$xbind" ] || [ "$xbind" = 127.0.0.1 ] || changes+="mysqlx-bind-address 127.0.0.1 (now $xbind)$NL"
    if [ "$(mysql_var log_bin)" = 1 ]; then
      changes+="binary logs off (now on): they are not charged to any account and can fill the disk$NL"
      notes+="if this server is a replication source or you rely on point-in-time recovery, that stops working$NL"
    fi
    [ "$(mysql_var local_infile)" = 0 ] || changes+="local_infile off (LOAD DATA LOCAL)$NL"
    changes+="these settings go in a new file, /etc/mysql/conf.d/eaglepanel.cnf, and MySQL is restarted$NL"
  fi
  if [ -n "$changes" ]; then
    manual+="cat >/etc/mysql/conf.d/eaglepanel.cnf <<'EOF'$NL$(mysql_cnf)${NL}EOF$NL"
  fi
  if [ "$(systemctl show mysql.service -p RuntimeDirectoryPreserve --value 2>/dev/null || true)" != yes ]; then
    changes+="systemd drop-in: keep /run/mysqld when MySQL stops (apps mount it to reach the socket)$NL"
    manual+="mkdir -p /etc/systemd/system/mysql.service.d$NL"
    manual+="cat >/etc/systemd/system/mysql.service.d/eaglepanel.conf <<'EOF'$NL$(mysql_dropin)${NL}EOF$NL"
    manual+="systemctl daemon-reload$NL"
  fi
  [ -n "$changes" ] || { plan_row "MySQL" "$now" "already configured"; return 0; }
  manual+="systemctl restart mysql$NL"
  dbs="$(mysql --protocol=socket -uroot -N -B -e "SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name NOT IN ('mysql','information_schema','performance_schema','sys')" 2>/dev/null || true)"
  if [[ "${dbs:-0}" =~ ^[1-9][0-9]*$ ]]; then notes+="$dbs existing database(s) are kept$NL"; fi
  plan_row "MySQL" "$now" "configure (details below)"
  review mysql "MySQL $version is already installed" "$changes" "$notes" "$manual"
}

plan_services() {
  local svc changes="" notes="" manual="" now=()
  for svc in redis-server memcached; do
    installed "$svc" || continue
    if systemctl is-active --quiet "$svc" || systemctl is-enabled --quiet "$svc" 2>/dev/null; then
      now+=("$svc running")
      changes+="stop and disable the shared $svc: it has no authentication, so every account could read the others' data$NL"
      manual+="systemctl disable --now $svc$NL"
    fi
  done
  if [ -z "$changes" ]; then
    plan_row "Redis, Memcached" "$(installed redis-server && echo installed || echo "not installed")" "one instance per account, started from the panel"
    return 0
  fi
  notes+="applications that use them lose that cache or store; each account gets its own instance from the panel$NL"
  plan_row "Redis, Memcached" "$(joined "${now[@]}")" "stop the shared instances (details below)"
  review services "Shared Redis or Memcached instances are running" "$changes" "$notes" "$manual"
}

vsftpd_conf() {
  cat <<EOF
$FTP_MARK
listen=YES
listen_ipv6=NO
anonymous_enable=NO
local_enable=YES
write_enable=YES
local_umask=022
guest_enable=YES
guest_username=nobody
virtual_use_local_privs=YES
chroot_local_user=YES
allow_writeable_chroot=YES
secure_chroot_dir=/var/run/vsftpd/empty
pam_service_name=eaglepanel-ftp
user_config_dir=$FTP_DIR/vusers
pasv_enable=YES
pasv_address=$PUBLIC_IP
pasv_min_port=$PASV_MIN
pasv_max_port=$PASV_MAX
ssl_enable=YES
force_local_logins_ssl=YES
force_local_data_ssl=YES
allow_anon_ssl=NO
rsa_cert_file=$FTP_CERT
rsa_private_key_file=$FTP_CERT
seccomp_sandbox=NO
xferlog_enable=YES
EOF
}

plan_ftp() {
  local other
  other="$(ss -tlnpH '( sport = :21 )' 2>/dev/null | grep -v '"vsftpd"' | sed -nE 's/.*users:\(\("([^"]+)".*/\1/p' | sort -u | paste -sd, - || true)"
  [ -z "$other" ] || BLOCKERS+=("port 21 is used by $other: EaglePanel uses vsftpd. Stop and disable $other, then run the installer again")
  if ! installed vsftpd; then plan_row "FTP (vsftpd)" "not installed" "install: virtual users, FTPS required"; return 0; fi
  if [ ! -f /etc/vsftpd.conf ] || cmp -s <(vsftpd_conf) /etc/vsftpd.conf; then plan_row "FTP (vsftpd)" "$(pkg_version vsftpd)" "already configured"; return 0; fi
  if [ "$(sed -n 1p /etc/vsftpd.conf)" = "$FTP_MARK" ]; then plan_row "FTP (vsftpd)" "$(pkg_version vsftpd)" "update its configuration"; return 0; fi
  plan_row "FTP (vsftpd)" "$(pkg_version vsftpd)" "replace its configuration (details below)"
  review ftp "vsftpd $(pkg_version vsftpd) is already installed, with its own configuration" \
    "replace /etc/vsftpd.conf (a copy is kept): one virtual user per FTP account, FTPS required, passive ports $PASV_MIN-$PASV_MAX$NL" \
    "system users can no longer log in over FTP$NL" \
    "# Replace /etc/vsftpd.conf with the following. Do not restart vsftpd yet: the certificate and the user database$NL# it refers to are created by the installer, which then restarts it.$NL$(vsftpd_conf)$NL"
}

plan_apps() {
  if installed podman; then
    plan_row "Podman" "$(pkg_version podman)" "use it, with its own storage in /srv/eaglepanel (existing containers are not touched)"
  else
    plan_row "Podman" "not installed" "install podman, crun, conmon and catatonit (no recommended packages)"
  fi
  [ "$(cat /proc/sys/net/ipv4/ip_forward 2>/dev/null)" = 1 ] || plan_row "IPv4 forwarding" "off" "turn on, for the apps' outbound traffic (ufw keeps forwarding closed for the rest)"
}

plan_tools() {
  local current=""
  command -v restic >/dev/null && current="$(restic version 2>/dev/null | awk '{ print $2 }' || true)"
  if [ -n "$current" ] && version_ge "$current" "$RESTIC_MIN"; then plan_row "restic" "$current" "use it"
  else plan_row "restic" "${current:-not installed}" "install $RESTIC_VERSION"; fi
  current=""
  [ -x /usr/local/bin/bun ] && current="$(/usr/local/bin/bun --version 2>/dev/null || true)"
  if [ "$current" = "$BUN_VERSION" ]; then plan_row "Bun" "$current" "use it"
  elif [ -n "$current" ]; then plan_row "Bun" "$current" "replace /usr/local/bin/bun with $BUN_VERSION (the panel runs on it)"
  else plan_row "Bun" "not installed" "install $BUN_VERSION in /usr/local/bin"; fi
}

plan_firewall() {
  local ports web changes="" notes="" manual="" wan rules=/etc/ufw/before.rules line closed
  ports="$(ssh_ports | paste -sd, -)"
  case "$FIREWALL" in
    cloudflare) web="80/443 from Cloudflare only" ;;
    open) web="80/443 from anywhere" ;;
    *) web="80/443 (choose with --firewall cloudflare|open)" ;;
  esac
  if ! command -v ufw >/dev/null || ! ufw status 2>/dev/null | grep -q "Status: active"; then
    plan_row "Firewall (ufw)" "$(command -v ufw >/dev/null && echo inactive || echo "not installed")" "enable: SSH ($ports), FTP and $web; the rest closed"
    # MySQL, Redis, Memcached and the OLS WebAdmin are moved to 127.0.0.1 before the firewall step; the panel port is its own.
    closed="$(ufw_would_close "$(ssh_ports)" "3306 33060 6379 11211 7080 8088 ${PANEL_PORT:-8090} $(setting PANEL_PORT)" | paste -sd' ' -)"
    if [ -n "$closed" ]; then
      BLOCKERS+=("these ports listen on the network and enabling ufw would close them: $closed. If they must stay open, allow each one (ufw allow PORT/PROTO) and run the installer again")
    fi
    return 0
  fi
  local now
  now="active, $(ufw status numbered | grep -cE '^\[ *[0-9]+\]' || true) rules"
  if ! ufw status | grep -q 'EaglePanel FTP'; then
    changes+="allow FTP: 21/tcp and the passive ports $PASV_MIN-$PASV_MAX/tcp$NL"
    manual+="ufw allow 21/tcp comment 'EaglePanel FTP'${NL}ufw allow $PASV_MIN:$PASV_MAX/tcp comment 'EaglePanel FTP pasivo'$NL"
  fi
  if [ "$FIREWALL" = cloudflare ] && ! ufw status | grep -q 'EaglePanel Cloudflare'; then
    changes+="allow 80/443 from each Cloudflare range$NL"
    manual+="# for each range of https://www.cloudflare.com/ips-v4 and /ips-v6:${NL}ufw allow proto tcp from RANGE to any port 80,443 comment 'EaglePanel Cloudflare'$NL"
  elif [ "$FIREWALL" = open ] && ! ufw status | grep -q 'EaglePanel web'; then
    changes+="allow 80/443 from anywhere$NL"
    manual+="ufw allow 80,443/tcp comment 'EaglePanel web'$NL"
  fi
  if [ "$FIREWALL" = cloudflare ]; then
    while read -r line; do
      [ -n "$line" ] || continue
      changes+="remove the rule that opens the web to anyone: $(sed -E 's/^\[ *[0-9]+\] *//; s/  +/ /g' <<<"$line")$NL"
      manual+="ufw --force delete $(sed -E 's/^\[ *([0-9]+)\].*/\1/' <<<"$line")    # $(sed -E 's/^\[ *[0-9]+\] *//; s/  +/ /g' <<<"$line")$NL"
    done <<<"$(ufw_open_web_rules)"
    if grep -q 'remove the rule' <<<"$changes"; then notes+="sites are then reachable only through Cloudflare$NL"; fi
  fi
  if ! grep -qF "# EaglePanel: internet access for apps" "$rules" 2>/dev/null && ! grep -qF "# EaglePanel: salida a internet de las apps" "$rules" 2>/dev/null; then
    wan="$(ip route show default | awk 'NR == 1 { print $5 }')"
    changes+="$rules: let the apps' containers (interfaces ep+) reach the internet through $wan$NL"
    manual+="# $rules: add these two lines before the first COMMIT:${NL}# EaglePanel: internet access for apps${NL}-A ufw-before-forward -i ep+ -o $wan -j ACCEPT$NL"
  fi
  if [ -z "$changes" ]; then plan_row "Firewall (ufw)" "$now" "already configured"; return 0; fi
  manual+="ufw reload$NL"
  plan_row "Firewall (ufw)" "$now" "add the panel rules (details below)"
  review ufw "ufw is already active, with its own rules" "$changes" "$notes" "$manual"
}

print_plan() {
  step "Installation plan"
  local row a b c key line
  printf '    %-17s %-22s %s\n' "Component" "Now" "Action"
  for row in "${PLAN_ROWS[@]}"; do
    IFS='|' read -r a b c <<<"$row"
    printf '    %-17s %-22s %s\n' "$a" "$b" "$c"
  done
  for key in "${REVIEW_KEYS[@]}"; do
    printf '\n    %s. It will:\n' "${REVIEW_TITLE[$key]}"
    while IFS= read -r line; do [ -z "$line" ] || printf '      - %s\n' "$line"; done <<<"${REVIEW_CHANGES[$key]}"
    while IFS= read -r line; do [ -z "$line" ] || printf '      ! %s\n' "$line"; done <<<"${REVIEW_NOTES[$key]}"
  done
  if [ ${#BLOCKERS[@]} -gt 0 ]; then
    printf '\n    The installation cannot continue:\n'
    for line in "${BLOCKERS[@]}"; do printf '      x %s\n' "$line"; done
  fi
}

installation_plan() {
  plan_system
  plan_litespeed
  plan_mysql
  plan_services
  plan_ftp
  plan_apps
  plan_tools
  plan_firewall
  print_plan
  if [ ${#BLOCKERS[@]} -gt 0 ]; then
    [ "$PLAN_ONLY" -eq 1 ] && exit 1
    die "${#BLOCKERS[@]} problem(s) listed above must be solved first. Nothing was changed"
  fi
  [ "$PLAN_ONLY" -eq 0 ] || exit 0
  # Questions only on a first installation with someone at the terminal. Updates and automation apply the plan.
  [ "$INTERACTIVE" -eq 1 ] && [ "$ASSUME_YES" -eq 0 ] && [ ! -f "$SETTINGS" ] || return 0
  local tty=/dev/tty key answer manual=()
  for key in "${REVIEW_KEYS[@]}"; do
    while :; do
      printf '\n  %s\n    1) Apply these changes\n    2) Show the steps to do it by hand, and stop without changing anything\n  Option [1]: ' "${REVIEW_TITLE[$key]}" >"$tty"
      read -r answer <"$tty" || answer=""
      case "${answer:-1}" in
        1) break ;;
        2) manual+=("$key"); break ;;
        *) printf '  Choose 1 or 2.\n' >"$tty" ;;
      esac
    done
  done
  if [ ${#manual[@]} -gt 0 ]; then
    for key in "${manual[@]}"; do
      printf '\n==> By hand: %s\n' "${REVIEW_TITLE[$key]}"
      sed 's/^/    /' <<<"${REVIEW_MANUAL[$key]%$NL}"
    done
    printf '\nNothing was changed. Apply those steps and run the installer again: it detects them and goes on with the rest.\n'
    exit 0
  fi
  if [ ${#REVIEW_KEYS[@]} -eq 0 ]; then
    printf '\n  Continue with the installation? [Y/n]: ' >"$tty"
    read -r answer <"$tty" || answer=""
    case "$answer" in n|N|no|No) printf 'Nothing was changed.\n'; exit 0 ;; esac
  fi
}

# ---------------------------------------------------------------------------- Base packages
base_packages() {
  step "Base packages"
  apt_get update -q
  apt_install ca-certificates curl gnupg openssl quota zip unzip bzip2 util-linux nftables git ufw iproute2
  apt_install db-util 2>/dev/null || apt_install db5.3-util
}

# ---------------------------------------------------------------------------- System
system_hardening() {
  step "Swap"
  if [ -n "$(swapon --noheadings --show=NAME)" ]; then
    ok "swap already present"
  elif [ "$(awk '/MemTotal/ { print int($2 / 1048576) }' /proc/meminfo)" -ge 8 ]; then
    ok "8 GB of RAM or more: no swap added"
  else
    # 2 GB: a build or a MySQL peak does not end up in the OOM killer.
    [ -e /swapfile ] || { fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none; }
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
    swapon /swapfile
    grep -qE '^/swapfile[[:space:]]' /etc/fstab || { backup /etc/fstab; printf '/swapfile none swap sw 0 0\n' >>/etc/fstab; }
    ok "2 GB swap at /swapfile"
  fi

  step "Disk quotas"
  local fstype
  fstype="$(findmnt -no FSTYPE /)"
  [ "$fstype" = "ext4" ] || die "/ is $fstype: the installer quotas are for ext4"
  if ! findmnt -no OPTIONS / | grep -q usrquota; then
    backup /etc/fstab
    awk '$2 == "/" && $1 !~ /^#/ && $4 !~ /usrquota/ { $4 = $4 ",usrquota,grpquota" } { print }' /etc/fstab >/etc/fstab.eaglepanel
    findmnt --verify --tab-file /etc/fstab.eaglepanel >/dev/null 2>&1 || { rm -f /etc/fstab.eaglepanel; die "the / line in fstab could not be adjusted automatically"; }
    cat /etc/fstab.eaglepanel >/etc/fstab && rm -f /etc/fstab.eaglepanel
    systemctl daemon-reload
    mount -o remount /
  fi
  if ! quota_on; then
    # Ubuntu "cloud" kernels ship the quota module in a separate package.
    if ! modprobe quota_v2 2>/dev/null && [ "$OS_ID" = "ubuntu" ]; then
      apt_install "linux-modules-extra-$(uname -r)" || true
      modprobe quota_v2 2>/dev/null || die "the kernel has no quota module: reboot the server and run the installer again"
    fi
    [ -f /aquota.user ] || quotacheck -cugm /
    quotaon -ug / || die "could not enable quotas"
  fi
  ok "user quotas enabled on /"

  step "Isolation of /home and /proc"
  # A symlink from one account to another account's directory lets OLS serve its files: nosymfollow prevents it.
  if ! grep -qE '^/home[[:space:]]+/home[[:space:]]+none[[:space:]]+bind,nosymfollow' /etc/fstab; then
    backup /etc/fstab
    printf '/home /home none bind,nosymfollow,nofail 0 0\n' >>/etc/fstab
    systemctl daemon-reload
  fi
  findmnt -no OPTIONS /home 2>/dev/null | grep -q nosymfollow || mount /home
  findmnt -no OPTIONS /home | grep -q nosymfollow && ok "/home with nosymfollow" || die "/home is not mounted with nosymfollow"
  # No account sees the processes (or environment variables) of another.
  if ! awk '$2 == "/proc" && $4 ~ /hidepid=(2|invisible)/' /etc/fstab | grep -q .; then
    backup /etc/fstab
    awk '$2 != "/proc" || $1 ~ /^#/' /etc/fstab >/etc/fstab.eaglepanel
    printf 'proc /proc proc defaults,hidepid=invisible 0 0\n' >>/etc/fstab.eaglepanel
    cat /etc/fstab.eaglepanel >/etc/fstab && rm -f /etc/fstab.eaglepanel
    systemctl daemon-reload
  fi
  findmnt -no OPTIONS /proc | grep -qE 'hidepid=(2|invisible)' || mount -o remount,hidepid=invisible /proc
  ok "/proc with hidepid"
}

# ---------------------------------------------------------------------------- OpenLiteSpeed
litespeed() {
  step "LiteSpeed repository (verified keys)"
  local keys=() entry url fingerprint name
  for entry in "${LITESPEED_KEYS[@]}"; do
    read -r url fingerprint <<<"$entry"
    name="$KEYRINGS/eaglepanel-$(basename "$url")"
    install_key "$url" "$fingerprint" "$name"
    keys+=("$name")
  done
  # The official script leaves its keys in trusted.gpg.d, which are valid for any repository: they are replaced with
  # keys valid only for the LiteSpeed one. Two sources of the same repository with different signatures would break apt.
  for legacy in /etc/apt/sources.list.d/lst_debian_repo.list /etc/apt/trusted.gpg.d/lst_repo.gpg /etc/apt/trusted.gpg.d/lst_debian_repo.gpg; do
    [ -e "$legacy" ] && { backup "$legacy"; rm -f "$legacy"; info "replaced: $legacy"; }
  done
  local signed
  signed="$(IFS=,; echo "${keys[*]}")"
  if write_file /etc/apt/sources.list.d/eaglepanel-litespeed.list 644 <<EOF; then
deb [signed-by=$signed] https://rpms.litespeedtech.com/debian/ $CODENAME main
EOF
    apt_get update -q
  fi

  step "OpenLiteSpeed and lsphp$PHP_VERSION"
  local fresh=0
  installed openlitespeed || fresh=1
  apt_install openlitespeed "lsphp$PHP_VERSION" "lsphp$PHP_VERSION-common" "lsphp$PHP_VERSION-mysql" "lsphp$PHP_VERSION-redis" "lsphp$PHP_VERSION-memcached"
  systemctl enable lshttpd >/dev/null 2>&1 || true

  step "OpenLiteSpeed configuration"
  backup "$OLS_CONF"
  local before after
  before="$(sha256sum "$OLS_CONF")"
  # The example site and the WebAdmin listen on all interfaces by default: only on 127.0.0.1.
  grep -qE '^[[:space:]]*address[[:space:]]+\*:8088' "$OLS_CONF" && fresh=1
  sed -i -E 's/^([[:space:]]*address[[:space:]]+)\*:8088/\1127.0.0.1:8088/' "$OLS_CONF"
  if [ -f "$LSWS/admin/conf/admin_config.conf" ] && grep -qE '^[[:space:]]*address[[:space:]]+\*:7080' "$LSWS/admin/conf/admin_config.conf"; then
    backup "$LSWS/admin/conf/admin_config.conf"
    sed -i -E 's/^([[:space:]]*address[[:space:]]+)\*:7080/\1127.0.0.1:7080/' "$LSWS/admin/conf/admin_config.conf"
    fresh=1
  fi
  # Cloudflare does not speak QUIC to the origin: without this OLS opens UDP 443 for nothing.
  if grep -qE '^quicEnable' "$OLS_CONF"; then sed -i -E 's/^quicEnable.*/quicEnable                       0/' "$OLS_CONF"
  else sed -i '0,/^adminEmails/s//quicEnable                       0\n&/' "$OLS_CONF"; fi
  # The one that counts is in the tuning block (1 by default): measured on the VPS, with the one above at 0 and this one at 1,
  # OLS opened UDP 443 as soon as there was a listener on 443.
  sed -i -E 's/^([[:space:]]+quicEnable[[:space:]]+)1[[:space:]]*$/\10/' "$OLS_CONF"
  # A restart inherits the UDP socket already open: OLS must be stopped completely to close it.
  ss -ulnH | grep -qE ':443[[:space:]]' && fresh=1
  # The real visitor IP: OLS only trusts headers coming from the IPs marked with T (Cloudflare).
  # Tested on the VPS: from another origin, a fake header is ignored. It also holds with the firewall open.
  local trusted
  trusted="$(sed 's/$/T/' "$CF_IPS" | paste -sd, -)"
  sed -i -E "/^accessControl/,/^}/ s|^[[:space:]]*allow[[:space:]].*|  allow                   ALL, $trusted|" "$OLS_CONF"
  if grep -qE '^useIpInProxyHeader' "$OLS_CONF"; then sed -i -E 's/^useIpInProxyHeader.*/useIpInProxyHeader        2/' "$OLS_CONF"
  else sed -i '0,/^adminEmails/s//useIpInProxyHeader        2\n&/' "$OLS_CONF"; fi
  chown --reference="$LSWS/conf" "$OLS_CONF"
  after="$(sha256sum "$OLS_CONF")"
  if ! ols_valid; then
    cp -a "$BACKUPS/$STAMP$LSWS/conf/httpd_config.conf" "$OLS_CONF"
    die "OpenLiteSpeed rejected the new configuration: the previous one was restored"
  fi
  if [ "$fresh" -eq 1 ]; then
    # Changing a listener address requires stopping OLS completely: a restart inherits the old sockets.
    systemctl stop lshttpd || true
    for _ in $(seq 1 30); do pgrep -x litespeed >/dev/null || break; sleep 1; done
    systemctl start lshttpd
  elif [ "$before" != "$after" ]; then
    "$LSWS/bin/lswsctrl" restart >/dev/null
  fi
  systemctl is-active --quiet lshttpd || die "OpenLiteSpeed did not start"
  ok "OpenLiteSpeed running"
}

cloudflare_ips() {
  step "Cloudflare ranges"
  local tmp
  tmp="$(mktemp)"
  if curl -fsS --proto '=https' --retry 3 --max-time 20 https://www.cloudflare.com/ips-v4 >"$tmp" && printf '\n' >>"$tmp" &&
     curl -fsS --proto '=https' --retry 3 --max-time 20 https://www.cloudflare.com/ips-v6 >>"$tmp"; then
    # Only lines that are ranges: nothing downloaded reaches a configuration file without going through here.
    grep -E '^([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}$|^[0-9a-f:]+/[0-9]{1,3}$' "$tmp" | sort -u >"$tmp.ok" || true
    if [ "$(wc -l <"$tmp.ok")" -ge 10 ]; then
      install -d -m 755 "$CONF_DIR"
      write_file "$CF_IPS" 644 <"$tmp.ok" && info "ranges updated" || true
    fi
  fi
  rm -f "$tmp" "$tmp.ok"
  [ -s "$CF_IPS" ] || die "could not fetch the Cloudflare ranges and there is no previous copy"
  ok "$(wc -l <"$CF_IPS") Cloudflare ranges"
}

# ---------------------------------------------------------------------------- MySQL
mysql_server() {
  step "MySQL"
  if [ "$OS_ID" = "debian" ] && ! installed mysql-server && ! installed mysql-community-server; then
    # Debian only ships MariaDB: MySQL 8.4 LTS from the Oracle repository, with its verified key.
    local url fingerprint
    read -r url fingerprint <<<"$MYSQL_KEY"
    install_key "$url" "$fingerprint" "$KEYRINGS/eaglepanel-mysql.gpg"
    write_file /etc/apt/sources.list.d/eaglepanel-mysql.list 644 <<EOF || true
deb [signed-by=$KEYRINGS/eaglepanel-mysql.gpg] https://repo.mysql.com/apt/debian/ $CODENAME mysql-8.4-lts
EOF
    apt_get update -q
    # No root password: it logs in through the socket, as on Ubuntu. Nobody else can.
    printf 'mysql-community-server mysql-community-server/root-pass password \nmysql-community-server mysql-community-server/re-root-pass password \n' | debconf-set-selections
  fi
  apt_install mysql-server
  install -d -m 755 /etc/mysql/conf.d
  systemctl start mysql >/dev/null 2>&1 || true
  # Local only; no binlogs (they are not charged to any account and filled the disk); no LOAD DATA LOCAL.
  # If the server already has those settings in its own files (configured by hand from the plan), nothing is added.
  if [ -f /etc/mysql/conf.d/eaglepanel.cnf ] || ! mysql_settings_ok; then
    if mysql_cnf | write_file /etc/mysql/conf.d/eaglepanel.cnf 644; then systemctl restart mysql; fi
  fi
  # Apps get /run/mysqld mounted: if MySQL deleted it when stopping, on return it would create another one and the apps
  # would keep looking at the old one, without a socket, until restarted.
  if [ "$(systemctl show mysql.service -p RuntimeDirectoryPreserve --value 2>/dev/null || true)" != yes ] || [ -f /etc/systemd/system/mysql.service.d/eaglepanel.conf ]; then
    if mysql_dropin | write_file /etc/systemd/system/mysql.service.d/eaglepanel.conf 644; then systemctl daemon-reload; fi
  fi
  systemctl enable --now mysql >/dev/null 2>&1
  mysql --protocol=socket -uroot -N -e 'SELECT 1' >/dev/null 2>&1 || die "root cannot log in to MySQL through the socket"
  ok "MySQL $(mysql --version | awk '{ print $3 }') on 127.0.0.1"
}

# ---------------------------------------------------------------------------- Redis and Memcached
account_services() {
  step "Redis and Memcached (one instance per account)"
  apt_install redis-server memcached
  # Without authentication, a shared instance would let each account read the keys of the others.
  systemctl disable --now redis-server memcached >/dev/null 2>&1 || true
  local changed=0
  write_file /etc/systemd/system/eaglepanel-redis@.service 644 <<'EOF' && changed=1
[Unit]
Description=Redis for account %i
After=network.target

[Service]
User=%i
Group=%i
Environment=SERVICE_MEMORY_MB=64
RuntimeDirectory=eaglepanel-services/redis-%i
RuntimeDirectoryMode=0700
ExecStart=/usr/bin/redis-server --port 0 --unixsocket /run/eaglepanel-services/redis-%i/redis.sock --unixsocketperm 600 --dir /run/eaglepanel-services/redis-%i --save "" --appendonly no --maxmemory ${SERVICE_MEMORY_MB}mb --maxmemory-policy allkeys-lru
Restart=on-failure
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
MemoryMax=128M

[Install]
WantedBy=multi-user.target
EOF
  write_file /etc/systemd/system/eaglepanel-memcached@.service 644 <<'EOF' && changed=1
[Unit]
Description=Memcached for account %i
After=network.target

[Service]
User=%i
Group=%i
Environment=SERVICE_MEMORY_MB=64
RuntimeDirectory=eaglepanel-services/memcached-%i
RuntimeDirectoryMode=0700
ExecStart=/usr/bin/memcached -s /run/eaglepanel-services/memcached-%i/memcached.sock -a 0600 -m ${SERVICE_MEMORY_MB} -c 256
Restart=on-failure
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
MemoryMax=128M

[Install]
WantedBy=multi-user.target
EOF
  [ "$changed" -eq 1 ] && systemctl daemon-reload
  ok "templates ready, no shared instances"
}

# ---------------------------------------------------------------------------- FTP
ftp_server() {
  step "FTP (FTPS required, virtual users)"
  apt_install vsftpd libpam-modules
  [ -n "$(find /usr/lib /lib -name pam_userdb.so 2>/dev/null | sed -n 1p)" ] || die "pam_userdb is missing"
  install -d -o root -g root -m 700 "$FTP_DIR" "$FTP_DIR/vusers"
  install -d -m 755 /var/run/vsftpd/empty
  # Self-signed on purpose: FTP does not go through Cloudflare; the certificate encrypts, it does not identify a domain.
  # No ssl_tlsv1_2: the Ubuntu 26.04 vsftpd does not recognize it and does not start (measured). The TLS 1.2 minimum is
  # already set by OpenSSL in these versions.
  # seccomp_sandbox=NO: its filter is older than the kernel and glibc of these distributions and kills the session
  # with SIGSYS on alarm() (after login) and utimensat() (the MFMT that FileZilla sends after each upload). The child
  # dies inside the TLS session, vsftpd answers "500 OOPS" in plain text and the client sees "bad record type"
  # (measured on Ubuntu 26.04, kernel 7.0). Chroot and privilege separation still apply.
  [ -f "$FTP_CERT" ] || (umask 077; openssl req -x509 -nodes -newkey rsa:2048 -days 3650 -subj "/CN=$PUBLIC_IP" -keyout "$FTP_CERT" -out "$FTP_CERT" 2>/dev/null)
  local changed=0
  write_file /etc/pam.d/eaglepanel-ftp 644 <<EOF && changed=1
auth    required pam_userdb.so db=$FTP_DIR/users crypt=crypt
account required pam_userdb.so db=$FTP_DIR/users crypt=crypt
EOF
  vsftpd_conf | write_file /etc/vsftpd.conf 644 && changed=1
  systemctl enable vsftpd >/dev/null 2>&1
  if [ "$changed" -eq 1 ] || ! systemctl is-active --quiet vsftpd; then systemctl restart vsftpd; fi
  systemctl is-active --quiet vsftpd || die "vsftpd did not start"
  ok "vsftpd running"
}

# ---------------------------------------------------------------------------- Apps
apps_runtime() {
  step "Apps: Podman and Bun image"
  apt_install nftables git curl
  # Without recommended packages: about 100 MB instead of 240. The panel builds each container network.
  local missing=()
  for pkg in podman crun conmon catatonit; do installed "$pkg" || missing+=("$pkg"); done
  [ ${#missing[@]} -eq 0 ] || apt_get install -y -q --no-install-recommends "${missing[@]}"
  install -d -m 755 "$CONF_DIR" "$CONF_DIR/containers"
  install -d -m 711 /srv/eaglepanel
  install -d -m 700 /srv/eaglepanel/containers
  # The agent rewrites them anyway when preparing each app (apps/agent/src/apps.ts).
  write_file "$CONF_DIR/containers/storage.conf" 644 <<'EOF' || true
# Generated by EaglePanel. Do not edit by hand.
[storage]
driver = "overlay"
graphroot = "/srv/eaglepanel/containers"
runroot = "/run/eaglepanel-containers"
EOF
  write_file "$CONF_DIR/containers/containers.conf" 644 <<'EOF' || true
# Generated by EaglePanel. Do not edit by hand.
[containers]
default_sysctls = []
log_driver = "journald"

[engine]
cgroup_manager = "cgroupfs"
events_logger = "file"
EOF
  local podman_env=(env CONTAINERS_STORAGE_CONF="$CONF_DIR/containers/storage.conf" CONTAINERS_CONF_OVERRIDE="$CONF_DIR/containers/containers.conf")
  "${podman_env[@]}" podman image exists docker.io/oven/bun:1-slim ||
    "${podman_env[@]}" podman pull --quiet docker.io/oven/bun:1-slim >/dev/null || die "could not download the Bun image"
  ok "Bun image in the shared store"

  step "Apps: network forwarding"
  if write_file /etc/sysctl.d/90-eaglepanel-apps.conf 644 <<'EOF'; then
net.ipv4.ip_forward=1
EOF
    sysctl -q -p /etc/sysctl.d/90-eaglepanel-apps.conf
  fi
  [ "$(cat /proc/sys/net/ipv4/ip_forward)" = "1" ] || sysctl -q -w net.ipv4.ip_forward=1
  ok "ip_forward enabled"
}

# ---------------------------------------------------------------------------- Tools
tools() {
  step "restic"
  local current=""
  command -v restic >/dev/null && current="$(restic version 2>/dev/null | awk '{ print $2 }')"
  if [ -n "$current" ] && version_ge "$current" "$RESTIC_MIN"; then
    ok "restic $current"
  else
    if apt-cache policy restic 2>/dev/null | awk '/Candidate:/ { print $2 }' | grep -qE '^[0-9]'; then
      local candidate
      candidate="$(apt-cache policy restic | awk '/Candidate:/ { print $2 }' | cut -d- -f1)"
      version_ge "$candidate" "$RESTIC_MIN" && apt_install restic
    fi
    current="$(command -v restic >/dev/null && restic version | awk '{ print $2 }' || true)"
    if [ -z "$current" ] || ! version_ge "$current" "$RESTIC_MIN"; then
      local sha_var="RESTIC_SHA256_$ARCH" tmp
      tmp="$(mktemp)"
      download "https://github.com/restic/restic/releases/download/v${RESTIC_VERSION}/restic_${RESTIC_VERSION}_linux_${ARCH}.bz2" "${!sha_var}" "$tmp"
      bunzip2 -c "$tmp" >/usr/local/bin/restic.new && chmod 755 /usr/local/bin/restic.new && mv -f /usr/local/bin/restic.new /usr/local/bin/restic
      rm -f "$tmp"
    fi
    ok "restic $(restic version | awk '{ print $2 }')"
  fi

  step "Bun $BUN_VERSION"
  if [ -x /usr/local/bin/bun ] && [ "$(/usr/local/bin/bun --version)" = "$BUN_VERSION" ]; then
    ok "Bun $BUN_VERSION"
  else
    local sha_var="BUN_SHA256_$ARCH" asset tmp
    asset="bun-linux-$([ "$ARCH" = amd64 ] && echo x64 || echo aarch64)"
    tmp="$(mktemp -d)"
    download "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${asset}.zip" "${!sha_var}" "$tmp/bun.zip"
    unzip -q "$tmp/bun.zip" -d "$tmp"
    install -m 755 "$tmp/$asset/bun" /usr/local/bin/bun.new && mv -f /usr/local/bin/bun.new /usr/local/bin/bun
    rm -rf "$tmp"
    ok "Bun $(/usr/local/bin/bun --version)"
  fi
}

# ---------------------------------------------------------------------------- Firewall
firewall() {
  step "Firewall (ufw)"
  local ports active=0
  ports="$(ssh_ports)"
  ufw status | grep -q "Status: active" && active=1
  # SSH is only opened if the installer is the one enabling ufw, so nobody is locked out. If ufw was already active,
  # what is there is respected: SSH may be reachable only through a tunnel or a VPN, and opening it would be a step back.
  if [ "$active" -eq 0 ]; then
    for port in $ports; do ufw allow "$port/tcp" comment 'EaglePanel SSH' >/dev/null; done
  fi
  backup /etc/ufw/user.rules
  backup /etc/ufw/user6.rules
  ufw allow 21/tcp comment 'EaglePanel FTP' >/dev/null
  ufw allow "$PASV_MIN:$PASV_MAX/tcp" comment 'EaglePanel FTP pasivo' >/dev/null

  # Sites: only the panel's own rules (with their comment) are added or removed. Others are not touched.
  local wanted=() rule
  if [ "$FIREWALL" = "cloudflare" ]; then
    while read -r cidr; do wanted+=("$cidr"); done <"$CF_IPS"
    for cidr in "${wanted[@]}"; do ufw allow proto tcp from "$cidr" to any port 80,443 comment 'EaglePanel Cloudflare' >/dev/null; done
    while ufw status numbered | grep -q "EaglePanel web"; do
      rule="$(ufw status numbered | grep "EaglePanel web" | sed -n 1p | sed -E 's/^\[ *([0-9]+)\].*/\1/')"
      ufw --force delete "$rule" >/dev/null
    done
    # With 80/443 open to anyone, "Cloudflare only" would not be true: those generic rules are removed.
    while read -r line; do
      rule="$(sed -E 's/^\[ *([0-9]+)\].*/\1/' <<<"$line")"
      ufw --force delete "$rule" >/dev/null && info "removed open rule: $(sed -E 's/^\[ *[0-9]+\] *//' <<<"$line")"
    done < <(ufw_open_web_rules)
    # Ranges Cloudflare no longer uses.
    while read -r line; do
      local from
      from="$(awk '{ print $(NF-3) }' <<<"$line")"
      if ! printf '%s\n' "${wanted[@]}" | grep -qxF "$from"; then
        rule="$(sed -E 's/^\[ *([0-9]+)\].*/\1/' <<<"$line")"
        ufw --force delete "$rule" >/dev/null && info "removed $from"
      fi
    done < <(ufw status numbered | grep "EaglePanel Cloudflare" | tac)
  else
    ufw allow 80,443/tcp comment 'EaglePanel web' >/dev/null
    while ufw status numbered | grep -q "EaglePanel Cloudflare"; do
      rule="$(ufw status numbered | grep "EaglePanel Cloudflare" | sed -n 1p | sed -E 's/^\[ *([0-9]+)\].*/\1/')"
      ufw --force delete "$rule" >/dev/null
    done
  fi
  if ufw status | grep -E '^(80|443)([/ ,]|$)' | grep -v 'EaglePanel' | grep -q 'ALLOW'; then
    info "WARNING: there are 80/443 rules not managed by the panel that remain open: review them with 'ufw status'"
  fi

  # Internet access for apps: without this, the ufw FORWARD DROP cuts it. Panel interfaces only.
  local rules=/etc/ufw/before.rules mark="# EaglePanel: internet access for apps" wan
  # Servers installed before the English texts have the same rule under a Spanish comment: it is not added twice.
  local old_mark="# EaglePanel: salida a internet de las apps"
  wan="$(ip route show default | awk 'NR == 1 { print $5 }')"
  [ -n "$wan" ] || die "the outbound interface was not found"
  if ! grep -qF "$mark" "$rules" && ! grep -qF "$old_mark" "$rules"; then
    backup "$rules"
    awk -v mark="$mark" -v rule="-A ufw-before-forward -i ep+ -o $wan -j ACCEPT" '
      !done && /^COMMIT/ { print mark; print rule; done = 1 }
      { print }' "$rules" >"$rules.eaglepanel"
    cat "$rules.eaglepanel" >"$rules" && rm -f "$rules.eaglepanel"
  fi

  if [ "$active" -eq 0 ]; then
    # Enabling ufw cuts everything without a rule. If other services are already listening externally (RustDesk,
    # a VPN), it stops and warns instead of leaving them without access.
    local unknown=()
    mapfile -t unknown < <(ufw_would_close "$ports")
    if [ ${#unknown[@]} -gt 0 ]; then
      printf 'These ports are listening externally and ufw would close them: %s\n' "${unknown[*]}"
      printf 'If they must stay open, allow them and run the installer again:\n'
      for entry in "${unknown[@]}"; do printf '    ufw allow %s\n' "$entry"; done
      die "ufw was not enabled, to avoid cutting off services already in use"
    fi
    ufw default deny incoming >/dev/null
    ufw default allow outgoing >/dev/null
    ufw --force enable >/dev/null
  else
    ufw reload >/dev/null || { cp -a "$BACKUPS/$STAMP$rules" "$rules" 2>/dev/null; ufw reload >/dev/null || true; die "ufw rejected the rules: before.rules was restored"; }
  fi
  ok "ufw enabled: $([ "$active" -eq 0 ] && echo "SSH ($ports), ")FTP and 80/443 $([ "$FIREWALL" = cloudflare ] && echo "from Cloudflare only" || echo "open")"
}

# ---------------------------------------------------------------------------- Panel access
# The panel listens on a single server IP, chosen by whoever installs it, always over HTTPS with its own
# certificate. Separately, the internal API stays on 127.0.0.1:8090 (HTTP), through which OLS passes the webhooks.
PANEL_ADDRESS=""
PANEL_IFACE=""
PANEL_URL_HOST=""
PANEL_NEW_DUMMY=0
PANEL_CHANGED=0
DUMMY_IFACE=eagle0
TLS_DIR="$CONF_DIR/tls"
PANEL_ENV="$CONF_DIR/panel.env"
INTERACTIVE=0

iface_ipv4() { ip -4 -o addr show dev "$1" 2>/dev/null | awk '{ split($4, a, "/"); print a[1]; exit }'; }
is_dummy() { ip -d link show dev "$1" 2>/dev/null | grep -qw dummy; }
url_for() { printf 'https://%s:%s' "$1" "$2"; }

# "IP interface" of each private IPv4 of the server, excluding those of apps, containers and VPNs (handled separately).
private_ips() {
  local addr dev
  ip -4 -o addr show 2>/dev/null | awk '{ split($4, a, "/"); print a[1], $2 }' | while read -r addr dev; do
    case "$dev" in lo|ep*|veth*|podman*|docker*|br-*|cni*|tailscale*|wg*) continue ;; esac
    case "$addr" in 127.*|169.254.*) continue ;; esac
    if is_private_ip "$addr" && ! ip -d link show dev "$dev" 2>/dev/null | grep -qw wireguard; then echo "$addr $dev"; fi
  done
}

# The IP the server uses to reach the internet, and its interface. Behind NAT it is private: the public one is PUBLIC_IP.
route_source() { ip -4 route get 1.1.1.1 2>/dev/null | awk '{ for (i = 1; i < NF; i++) { if ($i == "src") s = $(i + 1); if ($i == "dev") d = $(i + 1) } } END { print s, d }'; }

tailscale_ip() { command -v tailscale >/dev/null && tailscale ip -4 2>/dev/null | sed -n 1p || true; }
wireguard_ifaces() { ip -o link show type wireguard 2>/dev/null | awk -F': ' '{ sub(/@.*/, "", $2); print $2 }'; }
cloudflared_present() { command -v cloudflared >/dev/null || systemctl is-active --quiet cloudflared 2>/dev/null; }

# A private IP that does not clash with any server network, for the dedicated panel interface.
free_private_ip() {
  local candidate
  for candidate in 10.200.0.1 10.210.0.1 10.220.0.1 10.230.0.1 172.31.250.1 192.168.250.1; do
    ip -4 -o addr show | grep -qF " ${candidate%.*}." && continue
    [ -z "$(ip -4 route show match "$candidate" 2>/dev/null | grep -v '^default' || true)" ] || continue
    echo "$candidate"
    return 0
  done
  die "no free private range found for the panel interface: pass an IP with --panel-ip"
}

valid_panel_port() {
  local port="$1" users
  [[ "$port" =~ ^[0-9]+$ ]] && [ "$port" -ge 1024 ] && [ "$port" -le 65535 ] || { echo "it must be a number between 1024 and 65535"; return 1; }
  case "$port" in 3306|33060|6379|7080|8088|8091|11211) echo "it is used by a server service"; return 1 ;; esac
  [ "$port" -ge "$PASV_MIN" ] && [ "$port" -le "$PASV_MAX" ] && { echo "it is in the passive FTP range ($PASV_MIN-$PASV_MAX)"; return 1; }
  # Used by another program (the panel itself, bun, does not count).
  users="$(ss -tlnpH "( sport = :$port )" 2>/dev/null | grep -v '"bun"' || true)"
  [ -z "$users" ] || { echo "it is already used by another program: $(awk '{ print $4 }' <<<"$users" | paste -sd' ' -)"; return 1; }
}

# Fills PANEL_ADDRESS, PANEL_IFACE and PANEL_URL_HOST for the chosen mode. Stops with a clear reason if it cannot.
resolve_panel_address() {
  PANEL_NEW_DUMMY=0
  case "$PANEL_ACCESS" in
    private)
      local list saved
      list="$(private_ips)"
      saved="$(setting PANEL_ADDRESS)"
      if [ -n "$PANEL_IP" ]; then
        grep -q "^$PANEL_IP " <<<"$list" || die "$PANEL_IP is not a private IP of this server (available: $(awk '{ print $1 }' <<<"$list" | paste -sd' ' -))"
        PANEL_ADDRESS="$PANEL_IP"
      elif [ -n "$saved" ] && grep -q "^$saved " <<<"$list"; then
        PANEL_ADDRESS="$saved"
      elif [ -n "$list" ]; then
        PANEL_ADDRESS="$(awk 'NR == 1 { print $1 }' <<<"$list")"
      else
        PANEL_ADDRESS="$(free_private_ip)"
        PANEL_IFACE="$DUMMY_IFACE"
        PANEL_NEW_DUMMY=1
      fi
      [ "$PANEL_NEW_DUMMY" -eq 1 ] || PANEL_IFACE="$(awk -v ip="$PANEL_ADDRESS" '$1 == ip { print $2; exit }' <<<"$list")"
      PANEL_URL_HOST="$PANEL_ADDRESS"
      ;;
    public)
      local src dev
      read -r src dev <<<"$(route_source)"
      [ -n "$src" ] || die "the internet-facing interface was not found"
      PANEL_ADDRESS="${PANEL_IP:-$src}"
      PANEL_IFACE="$dev"
      # Behind NAT the server does not have the public IP on an interface: it listens on its own and is reached through the public one.
      PANEL_URL_HOST="$PUBLIC_IP"
      is_private_ip "$PANEL_ADDRESS" || PANEL_URL_HOST="$PANEL_ADDRESS"
      ;;
    tailscale)
      command -v tailscale >/dev/null || die "Tailscale is not installed. Install it, then run: eagle net tailscale"
      PANEL_ADDRESS="${PANEL_IP:-$(tailscale_ip)}"
      [ -n "$PANEL_ADDRESS" ] || die "Tailscale is installed but not connected. Run 'tailscale up', then: eagle net tailscale"
      PANEL_IFACE=tailscale0
      PANEL_URL_HOST="$PANEL_ADDRESS"
      ;;
    wireguard)
      local ifaces wg addr
      ifaces="$(wireguard_ifaces)"
      [ -n "$ifaces" ] || die "there is no active WireGuard interface. Configure one, then run: eagle net wireguard"
      PANEL_ADDRESS=""
      for wg in $ifaces; do
        addr="$(iface_ipv4 "$wg")"
        [ -n "$addr" ] || continue
        if [ -z "$PANEL_IP" ] || [ "$PANEL_IP" = "$addr" ]; then PANEL_ADDRESS="$addr"; PANEL_IFACE="$wg"; break; fi
      done
      [ -n "$PANEL_ADDRESS" ] || die "${PANEL_IP:+$PANEL_IP is not the IP of any WireGuard interface}${PANEL_IP:-the WireGuard interfaces have no IPv4 address}"
      PANEL_URL_HOST="$PANEL_ADDRESS"
      ;;
    *) die "--panel-access must be private, public, tailscale or wireguard" ;;
  esac
  valid_ipv4 "$PANEL_ADDRESS" || die "invalid panel IP: $PANEL_ADDRESS"
}

# The menu. It goes to the terminal (fd 3 or /dev/tty), never to the log.
ask_panel_access() {
  local tty=/dev/tty options=() n=0 addr dev line default=1 choice current
  current="$(setting PANEL_ADDRESS)"
  {
    printf '\n  How will you access the panel?\n\n'
    local list
    list="$(private_ips)"
    if [ -n "$list" ]; then
      local first=1
      while read -r addr dev; do
        n=$((n + 1)); options+=("private $addr")
        [ "$addr" = "$current" ] && default=$n
        printf '  %d) %-15s %-30s %s\n' "$n" "$([ "$first" -eq 1 ] && echo "Private network")" "$(url_for "$addr" "$PANEL_PORT")" "($dev)"
        first=0
      done <<<"$list"
      printf '                     From the internal network of the server, or from a VPN that reaches it.\n'
    else
      addr="$(free_private_ip)"
      n=$((n + 1)); options+=("private $addr")
      printf '  %d) %-15s %-30s %s\n' "$n" "Private network" "$(url_for "$addr" "$PANEL_PORT")" "(new)"
      printf '                     The server has no private IP: a dedicated interface will be created\n'
      printf '                     for the panel (%s). It is reachable through a VPN or a tunnel.\n' "$DUMMY_IFACE"
    fi
    if cloudflared_present; then
      printf '                     ℹ cloudflared detected: to connect with Cloudflare One Client, the tunnel\n'
      printf '                       private network must include this IP. For a public hostname,\n'
      printf '                       point it to this URL with "No TLS Verify".\n'
    fi
    printf '\n'
    n=$((n + 1)); options+=("public")
    [ "$(setting PANEL_ACCESS)" = public ] && default=$n
    printf '  %d) %-15s %s\n' "$n" "Public IP" "$(url_for "$PUBLIC_IP" "$PANEL_PORT")"
    printf '                     From anywhere. Port %s is opened in the firewall.\n\n' "$PANEL_PORT"
    printf '     VPN\n'
    local ts
    ts="$(tailscale_ip)"
    if [ -n "$ts" ]; then
      n=$((n + 1)); options+=("tailscale $ts")
      [ "$(setting PANEL_ACCESS)" = tailscale ] && default=$n
      printf '  %d)   %-13s %s\n' "$n" "Tailscale" "$(url_for "$ts" "$PANEL_PORT")"
    elif command -v tailscale >/dev/null; then
      printf '       %-13s ✗ not connected · run "tailscale up", then: eagle net tailscale\n' "Tailscale"
    else
      printf '       %-13s ✗ not installed · install it, then run: eagle net tailscale\n' "Tailscale"
    fi
    local wg_any=0 wg
    for wg in $(wireguard_ifaces); do
      addr="$(iface_ipv4 "$wg")"
      [ -n "$addr" ] || continue
      wg_any=1
      n=$((n + 1)); options+=("wireguard $addr")
      [ "$addr" = "$current" ] && default=$n
      printf '  %d)   %-13s %-30s %s\n' "$n" "WireGuard" "$(url_for "$addr" "$PANEL_PORT")" "($wg)"
    done
    if [ "$wg_any" -eq 0 ]; then
      if command -v wg >/dev/null; then
        printf '       %-13s ✗ no active interface · configure one, then run: eagle net wireguard\n' "WireGuard"
      else
        printf '       %-13s ✗ not installed · install it, then run: eagle net wireguard\n' "WireGuard"
      fi
    fi
    printf '\n'
  } >"$tty"
  while :; do
    printf '  Option [%s]: ' "$default" >"$tty"
    read -r choice <"$tty" || choice=""
    choice="${choice:-$default}"
    if [[ "$choice" =~ ^[0-9]+$ ]] && [ "$choice" -ge 1 ] && [ "$choice" -le "$n" ]; then break; fi
    printf '  Choose a number from the list.\n' >"$tty"
  done
  line="${options[$((choice - 1))]}"
  PANEL_ACCESS="${line%% *}"
  PANEL_IP=""
  [ "$line" = "${line#* }" ] || PANEL_IP="${line#* }"
  # The new IP does not exist yet: resolve_panel_address picks it.
  [ "$PANEL_ACCESS" = private ] && [ -z "$(private_ips)" ] && PANEL_IP=""

  local port reason
  while :; do
    printf '  Panel port [%s]: ' "$PANEL_PORT" >"$tty"
    read -r port <"$tty" || port=""
    port="${port:-$PANEL_PORT}"
    if reason="$(valid_panel_port "$port")"; then PANEL_PORT="$port"; break; fi
    printf '  Port %s cannot be used: %s.\n' "$port" "$reason" >"$tty"
  done
  printf '\n' >"$tty"
}

# Decides the access: what was passed as an option, what was saved or, with a terminal, the menu. Without any of those, private network.
# $1 = 1 to always ask (eagle net), even if something is saved.
choose_panel_access() {
  local force="$1" reason
  PANEL_PORT="${PANEL_PORT:-$(setting PANEL_PORT)}"
  PANEL_PORT="${PANEL_PORT:-8090}"
  if [ -z "$PANEL_ACCESS" ]; then
    if [ "$INTERACTIVE" -eq 1 ] && { [ "$force" -eq 1 ] || [ -z "$(setting PANEL_ACCESS)" ]; }; then
      ask_panel_access
    else
      PANEL_ACCESS="$(setting PANEL_ACCESS)"
      PANEL_ACCESS="${PANEL_ACCESS:-private}"
    fi
  fi
  reason="$(valid_panel_port "$PANEL_PORT")" || die "--panel-port $PANEL_PORT: $reason"
  resolve_panel_address
  ok "panel at $(url_for "$PANEL_URL_HOST" "$PANEL_PORT") ($PANEL_ACCESS, $PANEL_IFACE$([ "$PANEL_NEW_DUMMY" -eq 1 ] && echo ", new interface"))"
}

create_dummy_iface() {
  info "creating interface $DUMMY_IFACE with $PANEL_ADDRESS"
  if command -v netplan >/dev/null; then
    write_file /etc/netplan/90-eaglepanel.yaml 600 <<EOF || true
# EaglePanel: dedicated panel interface with a private IP, reachable through a VPN or a tunnel.
network:
  version: 2
  dummy-devices:
    $DUMMY_IFACE:
      addresses:
        - $PANEL_ADDRESS/32
EOF
    if ! netplan generate 2>/dev/null; then
      rm -f /etc/netplan/90-eaglepanel.yaml
      die "netplan does not support dummy interfaces (netplan 1.0 or later is required): create a private IP manually or choose another access mode"
    fi
    netplan apply
  elif systemctl is-active --quiet systemd-networkd; then
    write_file "/etc/systemd/network/90-$DUMMY_IFACE.netdev" 644 <<EOF || true
[NetDev]
Name=$DUMMY_IFACE
Kind=dummy
EOF
    write_file "/etc/systemd/network/90-$DUMMY_IFACE.network" 644 <<EOF || true
[Match]
Name=$DUMMY_IFACE

[Network]
Address=$PANEL_ADDRESS/32
EOF
    networkctl reload
  else
    die "neither netplan nor systemd-networkd is available to create the interface: create a private IP manually or choose another access mode"
  fi
  for _ in $(seq 1 15); do [ "$(iface_ipv4 "$DUMMY_IFACE")" = "$PANEL_ADDRESS" ] && return 0; sleep 1; done
  die "interface $DUMMY_IFACE did not get the IP $PANEL_ADDRESS"
}

# Self-signed certificate for the IPs used to connect. Regenerated if they change or if it expires in less than 30 days.
panel_certificate() {
  local crt="$TLS_DIR/panel.crt" key="$TLS_DIR/panel.key" san sans host
  install -d -o root -g eaglepanel -m 750 "$TLS_DIR"
  host="$(hostname)"
  san="IP:$PANEL_ADDRESS"
  [ "$PANEL_URL_HOST" = "$PANEL_ADDRESS" ] || san="$san,IP:$PANEL_URL_HOST"
  case "$host" in ""|localhost*) host=EaglePanel ;; *) san="$san,DNS:$host" ;; esac
  if [ -f "$crt" ] && [ -f "$key" ] && openssl x509 -in "$crt" -noout -checkend 2592000 >/dev/null 2>&1; then
    sans="$(openssl x509 -in "$crt" -noout -ext subjectAltName 2>/dev/null | tr -d ' ' | tr ',' '\n')"
    if grep -qxF "IPAddress:$PANEL_ADDRESS" <<<"$sans" && grep -qxF "IPAddress:$PANEL_URL_HOST" <<<"$sans"; then
      ok "panel certificate is valid"
      return 0
    fi
  fi
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 \
    -subj "/CN=$host" -addext "subjectAltName=$san" \
    -keyout "$key.new" -out "$crt.new" >/dev/null 2>&1 || die "could not generate the panel certificate"
  chown root:eaglepanel "$key.new" "$crt.new"
  chmod 640 "$key.new"
  chmod 644 "$crt.new"
  mv -f "$key.new" "$key"
  mv -f "$crt.new" "$crt"
  PANEL_CHANGED=1
  ok "self-signed certificate for $san"
}

# A dedicated ufw rule for the panel IP and port; old ones are removed. A dummy interface does not need one:
# what arrives there (cloudflared, a routed VPN) is delivered by the server itself and ufw does not filter it.
panel_firewall() {
  local want="" line rule
  if ! is_dummy "$PANEL_IFACE"; then
    want="$PANEL_ADDRESS $PANEL_PORT/tcp on $PANEL_IFACE"
    ufw allow in on "$PANEL_IFACE" to "$PANEL_ADDRESS" port "$PANEL_PORT" proto tcp comment 'EaglePanel panel' >/dev/null
  fi
  while read -r line; do
    [ -n "$line" ] || continue
    [ -n "$want" ] && grep -qF "$want" <<<"$line" && continue
    rule="$(sed -E 's/^\[ *([0-9]+)\].*/\1/' <<<"$line")"
    ufw --force delete "$rule" >/dev/null && info "removed old panel rule: $(sed -E 's/^\[ *[0-9]+\] *//' <<<"$line")"
  done < <(ufw status numbered | grep "EaglePanel panel" | tac)
  if [ -n "$want" ]; then
    ok "ufw: port $PANEL_PORT open on $PANEL_IFACE ($PANEL_ADDRESS)"
  else
    ok "ufw: no rules for the panel ($PANEL_IFACE is a local interface)"
  fi
}

panel_access() {
  step "Panel: access"
  [ "$PANEL_NEW_DUMMY" -eq 1 ] && create_dummy_iface
  panel_certificate
  write_file "$PANEL_ENV" 644 <<EOF && PANEL_CHANGED=1 || true
# How the panel is reached. Written by the installer (or eagle net): do not edit by hand.
PANEL_ADDRESS=$PANEL_ADDRESS
PANEL_PORT=$PANEL_PORT
PANEL_TLS_CERT=$TLS_DIR/panel.crt
PANEL_TLS_KEY=$TLS_DIR/panel.key
EOF
  panel_firewall
}

# Waits for the panel to answer over HTTPS on the chosen IP.
panel_https_ok() {
  local url
  url="$(url_for "$PANEL_ADDRESS" "$PANEL_PORT")/api/auth/me"
  [ "$(curl -sk -m 3 -o /dev/null -w '%{http_code}' "$url" || true)" = "401" ]
}

panel_access_summary() {
  printf '\n  Panel:  %s\n' "$(url_for "$PANEL_URL_HOST" "$PANEL_PORT")"
  printf '  The browser warns about the self-signed certificate the first time: this is expected.\n'
  if [ "$PANEL_ACCESS" = private ] && cloudflared_present; then
    printf '\n  cloudflared is installed:\n'
    printf '    · Cloudflare One Client: the tunnel private network must include %s.\n' "$PANEL_ADDRESS"
    printf '    · Public hostname: point it to %s with "No TLS Verify".\n' "$(url_for "$PANEL_ADDRESS" "$PANEL_PORT")"
  fi
  printf '\n  To change how the panel is reached: eagle net\n'
}

net_status() {
  local access address port
  access="$(setting PANEL_ACCESS)"
  address="$(setting PANEL_ADDRESS)"
  port="$(setting PANEL_PORT)"
  if [ -n "$access" ]; then
    case "$access" in private) access="private network" ;; public) access="public IP" ;; tailscale) access="Tailscale" ;; wireguard) access="WireGuard" ;; esac
    [ "$(setting PANEL_ACCESS)" = public ] && [ -n "$(setting PUBLIC_IP)" ] && address="$(setting PUBLIC_IP)"
    printf '\nPanel: %s (%s)\n\n' "$(url_for "$address" "$port")" "$access"
  else
    printf '\nPanel access is not configured yet: run eagle net\n\n'
  fi
  if cloudflared_present; then
    printf '  %-12s ✓ installed     Cloudflare One Client: the tunnel private network must include %s.\n' "cloudflared" "${address:-the panel IP}"
    printf '  %-12s                 Public hostname: point it to %s with "No TLS Verify".\n' "" "$(url_for "${address:-IP}" "${port:-8090}")"
  else
    printf '  %-12s ✗ not installed Once installed, run: eagle net cloudflared\n' "cloudflared"
  fi
  if [ -n "$(tailscale_ip)" ]; then
    printf '  %-12s ✓ connected     %s · to use it: eagle net tailscale\n' "Tailscale" "$(tailscale_ip)"
  elif command -v tailscale >/dev/null; then
    printf '  %-12s ✗ not connected Run "tailscale up", then: eagle net tailscale\n' "Tailscale"
  else
    printf '  %-12s ✗ not installed Once installed, run: eagle net tailscale\n' "Tailscale"
  fi
  if [ -n "$(wireguard_ifaces)" ]; then
    printf '  %-12s ✓ active        %s · to use it: eagle net wireguard\n' "WireGuard" "$(wireguard_ifaces | paste -sd' ' -)"
  elif command -v wg >/dev/null; then
    printf '  %-12s ✗ no interface  Configure one, then run: eagle net wireguard\n' "WireGuard"
  else
    printf '  %-12s ✗ not installed Once installed, run: eagle net wireguard\n' "WireGuard"
  fi
  printf '\nTo change how the panel is reached: eagle net\n'
}

# eagle net: panel access only, on an existing installation.
net_only() {
  step "Panel access"
  [ "$(id -u)" -eq 0 ] || die "must be run as root"
  [ -f "$SETTINGS" ] && [ -d "$APP" ] || die "the panel is not installed: run the installer first"
  FIREWALL="$(setting FIREWALL)"
  PUBLIC_IP="$(setting PUBLIC_IP)"
  ADMIN_USER="$(setting ADMIN_USER)"
  choose_panel_access 1
  save_settings
  panel_access
  install_units
  if [ "$PANEL_CHANGED" -eq 1 ] || [ "$UNITS_CHANGED" -eq 1 ]; then systemctl restart eaglepanel-api; fi
  for _ in $(seq 1 20); do panel_https_ok && break; sleep 1; done
  panel_https_ok && ok "the panel responds at $(url_for "$PANEL_ADDRESS" "$PANEL_PORT")" || die "the panel does not respond at $(url_for "$PANEL_ADDRESS" "$PANEL_PORT"). See journalctl -u eaglepanel-api"
  panel_access_summary
}

# ---------------------------------------------------------------------------- Panel
panel() {
  step "Panel: user and directories"
  id eaglepanel >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin eaglepanel
  install -d -o root -g root -m 755 "$CONF_DIR"
  write_file "$CONF_DIR/agent.env" 644 <<EOF || true
AGENT_SOCKET_GID=$(getent group eaglepanel | cut -d: -f3)
EOF
  install -d -o root -g root -m 700 /var/lib/eaglepanel-db-backups
  # Database explorer: dumps waiting to be imported. Root only, outside the directory of the panel user.
  install -d -o root -g root -m 700 /var/lib/eaglepanel-db-imports

  panel_access

  step "Panel: application"
  [ -f "$SOURCE/package.json" ] && [ -d "$SOURCE/apps/web/dist" ] || die "this directory is not a panel package (apps/web/dist is missing): build it with deploy/package.sh"
  local new_version old_version=""
  new_version="$(cat "$SOURCE/VERSION" 2>/dev/null || echo unknown)"
  [ -f "$APP/VERSION" ] && old_version="$(cat "$APP/VERSION")"
  if [ -d "$APP" ] && [ "$old_version" = "$new_version" ] && [ "$new_version" != unknown ] && systemctl is-active --quiet eaglepanel-api; then
    install_units
    if [ "$UNITS_CHANGED" -eq 1 ]; then
      systemctl restart eaglepanel-agent && sleep 2 && systemctl restart eaglepanel-api
      start_and_check || die "the panel did not respond after updating its systemd units"
    elif [ "$PANEL_CHANGED" -eq 1 ]; then
      systemctl restart eaglepanel-api
      start_and_check || die "the panel did not respond after changing its access"
    fi
    ok "panel $new_version is already installed"
  else
    local staging
    staging="$(mktemp -d /opt/eaglepanel.new.XXXXXX)"
    tar -C "$SOURCE" --exclude=./node_modules --exclude='./apps/*/node_modules' --exclude='./packages/*/node_modules' -cf - . | tar -C "$staging" -xf -
    chown -R root:root "$staging"
    chmod 755 "$staging"
    (cd "$staging" && /usr/local/bin/bun install --frozen-lockfile --production) || { rm -rf "$staging"; die "bun install failed: the installed panel was not touched"; }

    # From here on, if the new panel does not respond, the previous version and its database come back.
    systemctl stop eaglepanel-api eaglepanel-agent 2>/dev/null || true
    local db_copy=""
    if [ -f "$DB" ]; then
      db_copy="/var/lib/eaglepanel-db-backups/eaglepanel-$STAMP.db"
      cp -a "$DB" "$db_copy"
      for extra in -wal -shm; do [ -f "$DB$extra" ] && cp -a "$DB$extra" "$db_copy$extra"; done
      # The last five are kept.
      ls -1t /var/lib/eaglepanel-db-backups/eaglepanel-*.db 2>/dev/null | tail -n +6 | while read -r old; do rm -f "$old" "$old-wal" "$old-shm"; done
    fi
    rm -rf "$APP.prev"
    [ -d "$APP" ] && mv "$APP" "$APP.prev"
    mv "$staging" "$APP"
    install_units
    if ! start_and_check; then
      bad "the new panel did not respond: rolling back to the previous version"
      systemctl stop eaglepanel-api eaglepanel-agent 2>/dev/null || true
      rm -rf "$APP"
      [ -d "$APP.prev" ] && mv "$APP.prev" "$APP"
      if [ -n "$db_copy" ]; then
        cp -a "$db_copy" "$DB"
        for extra in -wal -shm; do rm -f "$DB$extra"; [ -f "$db_copy$extra" ] && cp -a "$db_copy$extra" "$DB$extra"; done
        chown eaglepanel:eaglepanel "$DB"*
      fi
      [ -d "$APP" ] && { systemctl start eaglepanel-agent; sleep 2; systemctl start eaglepanel-api; }
      die "the update did not start; version ${old_version:-previous} remains. See journalctl -u eaglepanel-api -u eaglepanel-agent"
    fi
    ok "panel $new_version installed"
  fi
  # The server command: eagle net, and later eagle upgrade.
  install -m 755 "$APP/deploy/eagle.sh" /usr/local/bin/eagle.new && mv -f /usr/local/bin/eagle.new /usr/local/bin/eagle

  step "Panel: admin"
  local password created
  password="$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | cut -c1-24)"
  created="$(printf '%s' "$password" | runuser -u eaglepanel -- env EAGLEPANEL_DB="$DB" BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 /usr/local/bin/bun "$APP/apps/api/src/cli/set-admin.ts" "$ADMIN_USER" --if-missing)"
  if grep -q "saved" <<<"$created"; then
    # Delivered right away: if a later step fails, the password is not lost.
    if [ -n "$ADMIN_PASSWORD_FILE" ]; then
      (umask 077; printf 'Admin: %s\nPassword: %s\n' "$ADMIN_USER" "$password" >"$ADMIN_PASSWORD_FILE")
      chown root:root "$ADMIN_PASSWORD_FILE"
      chmod 600 "$ADMIN_PASSWORD_FILE"
      ok "admin $ADMIN_USER created: the password was written to $ADMIN_PASSWORD_FILE (root only); store it and delete the file"
    else
      ok "admin $ADMIN_USER created (the password is shown once, outside the log)"
      printf '\n    Password for %s: %s\n    Store it now. Change it with: printf %%s PASSWORD | bun run admin:set -- %s\n\n' "$ADMIN_USER" "$password" "$ADMIN_USER" >&3
    fi
  else
    ok "an admin already exists: unchanged"
  fi
}

UNITS_CHANGED=0
install_units() {
  UNITS_CHANGED=0
  write_file /etc/systemd/system/eaglepanel-agent.service 644 <"$HERE/eaglepanel-agent.service" && UNITS_CHANGED=1
  write_file /etc/systemd/system/eaglepanel-api.service 644 <"$HERE/eaglepanel-api.service" && UNITS_CHANGED=1
  [ "$UNITS_CHANGED" -eq 1 ] && systemctl daemon-reload
  systemctl enable eaglepanel-agent eaglepanel-api >/dev/null 2>&1
}

start_and_check() {
  systemctl start eaglepanel-agent
  for _ in $(seq 1 20); do [ -S /run/eaglepanel/agent.sock ] && break; sleep 1; done
  systemctl start eaglepanel-api
  for _ in $(seq 1 30); do
    [ "$(curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:8090/api/auth/me || true)" = "401" ] && return 0
    sleep 1
  done
  return 1
}

# ---------------------------------------------------------------------------- Verification
verify() {
  step "Verification"
  local listening
  listening="$(ss -tlnH)"
  findmnt -no OPTIONS /home 2>/dev/null | grep -q nosymfollow && ok "/home with nosymfollow" || bad "/home without nosymfollow"
  findmnt -no OPTIONS /proc | grep -qE 'hidepid=(2|invisible)' && ok "/proc with hidepid" || bad "/proc without hidepid"
  quota_on && ok "quotas enabled" || bad "quotas disabled"
  systemctl is-active --quiet lshttpd && ok "OpenLiteSpeed running" || bad "OpenLiteSpeed stopped"
  grep -qE '^useIpInProxyHeader[[:space:]]+2' "$OLS_CONF" 2>/dev/null && ok "OLS takes the real IP from Cloudflare only" || bad "OLS without useIpInProxyHeader 2"
  ss -ulnH | grep -qE ':443[[:space:]]' && bad "QUIC open on UDP 443" || ok "no QUIC"
  if grep -qE "(\*|0\.0\.0\.0|\[::\]):(8088|7080|3306|33060|6379|11211|8090)[[:space:]]" <<<"$listening"; then
    bad "an internal service is exposed to the network: $(grep -E "(\*|0\.0\.0\.0|\[::\]):(8088|7080|3306|33060|6379|11211|8090)[[:space:]]" <<<"$listening" | awk '{ print $4 }' | paste -sd' ' -)"
  else
    ok "MySQL, the OLS WebAdmin and the internal panel API are not exposed"
  fi
  "$LSWS/lsphp$PHP_VERSION/bin/php" -m 2>/dev/null | grep -qx redis && ok "lsphp$PHP_VERSION with redis, memcached and mysqli" || bad "lsphp$PHP_VERSION is missing its extensions"
  mysql --protocol=socket -uroot -N -e 'SELECT 1' >/dev/null 2>&1 && ok "MySQL responds" || bad "MySQL does not respond"
  [ "$(systemctl show mysql.service -p RuntimeDirectoryPreserve --value)" = "yes" ] && ok "MySQL keeps its socket directory (apps)" || bad "MySQL deletes /run/mysqld when it stops: apps would lose the socket"
  systemctl is-active --quiet vsftpd && ok "vsftpd running" || bad "vsftpd stopped"
  command -v restic >/dev/null && ok "restic $(restic version | awk '{ print $2 }')" || bad "restic is missing"
  ufw status | grep -q "Status: active" && ok "ufw enabled" || bad "ufw disabled"
  local ping='{"op":"system.ping","params":{}}'
  curl -s -m 5 --unix-socket /run/eaglepanel/agent.sock -H 'content-type: application/json' -d "$ping" http://agent/op 2>/dev/null | grep -q '"sandbox":false' && ok "the agent responds" || bad "the agent does not respond"
  runuser -u nobody -- curl -s -m 5 --unix-socket /run/eaglepanel/agent.sock -H 'content-type: application/json' -d "$ping" http://agent/op 2>/dev/null | grep -q pong && bad "another user can use the agent" || ok "only the panel can reach the agent"
  [ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:8090/api/auth/me || true)" = "401" ] && ok "the panel responds and requires a session" || bad "the panel does not respond"
  PANEL_ADDRESS="${PANEL_ADDRESS:-$(setting PANEL_ADDRESS)}"
  PANEL_PORT="${PANEL_PORT:-$(setting PANEL_PORT)}"
  if [ -n "$PANEL_ADDRESS" ]; then
    local tries=0
    until panel_https_ok || [ "$tries" -ge 10 ]; do tries=$((tries + 1)); sleep 1; done
    panel_https_ok && ok "the panel responds over HTTPS at $(url_for "$PANEL_ADDRESS" "$PANEL_PORT")" || bad "the panel does not respond over HTTPS at $(url_for "$PANEL_ADDRESS" "$PANEL_PORT")"
  else
    bad "panel access is not configured: eagle net"
  fi
}

# ---------------------------------------------------------------------------- Main
main() {
  if [ "$NET_STATUS" -eq 1 ]; then
    net_status
    exit 0
  fi
  if [ "$PLAN_ONLY" -eq 1 ]; then
    preflight
    installation_plan
  fi
  if [ "$CHECK_ONLY" -eq 1 ]; then
    preflight
    verify
    [ "$FAILS" -eq 0 ] && printf '\nAll checks passed.\n' || printf '\n%s check(s) failed.\n' "$FAILS"
    exit $((FAILS > 0))
  fi

  # One run at a time, and everything goes to the log.
  exec 9>/run/eaglepanel-install.lock
  flock -n 9 || { echo "An installation is already running."; exit 1; }
  (umask 077; touch "$LOG")
  # fd 3 is the original output: what goes there does not end up in the log.
  exec 3>&1
  exec > >(tee -a "$LOG") 2>&1
  printf '\n######## EaglePanel: installation %s ########\n' "$STAMP"
  # With a terminal, the installer can ask (through /dev/tty: stdin is /dev/null).
  if [ -t 3 ] && { : </dev/tty; } 2>/dev/null; then INTERACTIVE=1; fi

  if [ "$NET_ONLY" -eq 1 ]; then
    net_only
    exit 0
  fi

  preflight
  installation_plan
  step "Panel access"
  choose_panel_access 0
  install -d -m 700 "$BACKUPS"
  base_packages
  save_settings
  system_hardening
  cloudflare_ips
  litespeed
  mysql_server
  account_services
  ftp_server
  apps_runtime
  tools
  firewall
  panel
  verify

  if [ "$FAILS" -ne 0 ]; then
    printf '\nFINISHED WITH %s FAILURE(S): review the items marked above.\n' "$FAILS"
    exit 1
  fi
  printf '\nDONE.\n'
  panel_access_summary
}

main

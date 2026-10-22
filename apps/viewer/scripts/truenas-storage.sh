#!/usr/bin/env bash
set -euo pipefail

command_name="${1:-}"
target="${2:-}"
confirmation="${3:-}"
compose_dir="${COMPOSE_DIR:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"
viewer_config="${VIEWER_ENV_FILE:-/mnt/Plugins/App_Data/Model-Viewer/Config/viewer.env}"
storage_path=/mnt/Plugins/App_Data/Model-Viewer/Storage
storage_sentinel=.ltds-viewer-storage-root
required_paths=(data datasets models cache trash imports imports/datasets imports/terra)
cd -- "$compose_dir"

fail() { echo "viewer storage: $*" >&2; exit 1; }
require_storage_path() {
  [[ -d "$storage_path" ]] || fail "$storage_path does not exist; create it and its managed directories as uid/gid 568 before starting Compose"
  [[ ! -L "$storage_path" ]] || fail "$storage_path must not be a symlink"
  [[ "$(readlink -f -- "$storage_path")" == "$storage_path" ]] || fail "storage resolves outside the exact approved path: $storage_path"
  [[ -f "$storage_path/$storage_sentinel" ]] || fail "storage sentinel is missing: $storage_path/$storage_sentinel"
}
require_storage_owner() {
  local path owner
  owner="$(stat -c '%u:%g' -- "$storage_path/$storage_sentinel")"
  [[ "$owner" == 568:568 ]] || fail "$storage_path/$storage_sentinel is owned by $owner; expected 568:568"
  for path in "$storage_path" "${required_paths[@]/#/$storage_path/}"; do
    [[ -d "$path" ]] || fail "required managed directory is missing: $path"
    owner="$(stat -c '%u:%g' -- "$path")"
    [[ "$owner" == 568:568 ]] || fail "$path is owned by $owner; expected 568:568 (run repair-ownership only after reviewing the exact target)"
  done
}
[[ -r "$viewer_config" ]] || fail "cannot read $viewer_config"
require_storage_path
compose_args=(--env-file "$viewer_config")
mapfile -t images < <(docker compose "${compose_args[@]}" config --images | sort -u)
[[ "${#images[@]}" -eq 1 ]] || fail "Compose must resolve exactly one Viewer image"
viewer_image="${images[0]}"

api_was_running="$(docker compose "${compose_args[@]}" ps -q viewer-api 2>/dev/null || true)"
restart_previous() {
  [[ -n "$api_was_running" ]] || return 0
  local args=(--env-file "$viewer_config")
  docker compose "${args[@]}" up -d --wait --wait-timeout 180
}
stop_for_consistency() {
  docker compose "${compose_args[@]}" stop -t 120 viewer-worker viewer-api
}

case "$command_name" in
  diagnose)
    require_storage_owner
    echo "storage=$storage_path owner=$(stat -c '%u:%g' -- "$storage_path") mode=$(stat -c '%a' -- "$storage_path")"
    docker run --rm --read-only --user 568:568 --cap-drop ALL --security-opt no-new-privileges \
      -v "$storage_path:/app/storage" --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
      "$viewer_image" sh -ceu 'for path in data datasets models cache trash imports imports/datasets imports/terra; do test -d "/app/storage/$path" && test -r "/app/storage/$path" && test -w "/app/storage/$path"; done; marker=/app/storage/data/.uid-568-write-test; : > "$marker"; rm -f "$marker"; stat -c "storage uid=%u gid=%g mode=%a" /app/storage'
    ;;
  repair-ownership)
    [[ "$target" == CONFIRM_UID_568 ]] || fail "repair requires: $0 repair-ownership CONFIRM_UID_568"
    stop_for_consistency
    if ! docker run --rm --read-only --user 0:0 --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --security-opt no-new-privileges \
      -v "$storage_path:/app/storage" "$viewer_image" \
      sh -ceu 'chown -R 568:568 /app/storage; find /app/storage -type d -exec chmod u+rwx {} +; find /app/storage -type f -exec chmod u+rw {} +'; then
      restart_previous || true
      fail "ownership repair failed"
    fi
    restart_previous
    echo "repaired $storage_path ownership for uid/gid 568"
    ;;
  backup)
    require_storage_owner
    [[ "$target" == /* ]] || fail "backup target must be an absolute .tar.gz path"
    [[ "$target" == *.tar.gz ]] || fail "backup target must end in .tar.gz"
    backup_dir="$(dirname -- "$target")"; backup_file="$(basename -- "$target")"
    if [[ ! -d "$backup_dir" ]]; then install -d -m 700 -o 568 -g 568 -- "$backup_dir"; fi
    [[ ! -e "$target" ]] || fail "backup target already exists: $target"
    stop_for_consistency
    if ! docker run --rm --read-only --user 568:568 --cap-drop ALL --security-opt no-new-privileges \
      -v "$storage_path:/app/storage:ro" -v "$backup_dir:/backup" "$viewer_image" \
      sh -ceu 'cd /app/storage; tar -czf "/backup/$1" .' sh "$backup_file"; then
      restart_previous || true
      fail "backup failed"
    fi
    if ! (cd -- "$backup_dir" && sha256sum -- "$backup_file" > "$backup_file.sha256") || \
       ! chmod 600 -- "$target" "$target.sha256"; then
      restart_previous || true
      fail "backup archive was created, but checksum or permission finalization failed"
    fi
    restart_previous
    echo "backup complete: $target"
    ;;
  restore)
    [[ "$confirmation" == CONFIRM_RESTORE ]] || fail "restore requires: $0 restore /absolute/backup.tar.gz CONFIRM_RESTORE"
    [[ "$target" == /* && "$target" == *.tar.gz && -r "$target" ]] || fail "restore archive must be a readable absolute .tar.gz path"
    [[ -r "$target.sha256" ]] || fail "missing checksum file: $target.sha256"
    (cd -- "$(dirname -- "$target")" && sha256sum -c -- "$(basename -- "$target").sha256")
    restore_dir="$(dirname -- "$target")"; restore_file="$(basename -- "$target")"
    stop_for_consistency
    if ! docker run --rm --read-only --user 0:0 --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --security-opt no-new-privileges \
      -v "$storage_path:/app/storage" -v "$restore_dir:/backup:ro" "$viewer_image" \
      sh -ceu '
        test -f /app/storage/.ltds-viewer-storage-root
        tar -tzf "/backup/$1" | while IFS= read -r item; do case "$item" in /*|../*|*/../*) echo "unsafe archive path: $item" >&2; exit 4;; esac; done
        find /app/storage -mindepth 1 -maxdepth 1 ! -name .ltds-viewer-storage-root -exec rm -rf -- {} +
        tar -xzf "/backup/$1" -C /app/storage --no-same-owner
        chown -R 568:568 /app/storage
      ' sh "$restore_file"; then
      fail "restore failed; services remain stopped for operator inspection"
    fi
    restart_previous
    echo "restore complete: $target"
    ;;
  *) fail "usage: $0 diagnose | repair-ownership CONFIRM_UID_568 | backup /absolute/file.tar.gz | restore /absolute/file.tar.gz CONFIRM_RESTORE" ;;
esac

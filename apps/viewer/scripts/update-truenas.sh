#!/usr/bin/env bash
set -euo pipefail

compose_dir="${1:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"
viewer_config="${VIEWER_ENV_FILE:-/mnt/Plugins/App_Data/Model-Viewer/Config/viewer.env}"
requested_mode="${2:-auto}"
rollback_image="ltds-viewer-rollback:previous"
official_latest_image="ghcr.io/ledgetoptechnologies/ledgetop-ops-viewer:latest"
rollback_compose="$compose_dir/scripts/docker-compose.rollback.yml"
storage_path=/mnt/Plugins/App_Data/Model-Viewer/Storage
storage_sentinel=.ltds-viewer-storage-root
required_storage_paths=(data datasets models cache trash imports imports/datasets imports/terra)
cd -- "$compose_dir"

fail() { echo "viewer update: $*" >&2; exit 1; }
env_value() {
  local key="$1" value
  value="$(sed -n "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*//p" "$viewer_config" | tail -n 1 | tr -d '\r')"
  value="${value#\"}"; value="${value%\"}"; value="${value#\'}"; value="${value%\'}"
  printf '%s' "$value"
}

[[ -r "$viewer_config" ]] || fail "cannot read $viewer_config"
[[ -d "$storage_path" ]] || fail "$storage_path does not exist; pre-create the persistent Storage dataset as uid/gid 568"
[[ ! -L "$storage_path" ]] || fail "$storage_path must not be a symlink"
[[ "$(readlink -f -- "$storage_path")" == "$storage_path" ]] || fail "storage resolves outside the exact approved path: $storage_path"
[[ -f "$storage_path/$storage_sentinel" ]] || fail "storage sentinel is missing: $storage_path/$storage_sentinel"
# The updater never creates, moves, deletes, or chowns storage. The container,
# running as 568:568, creates only known subdirectories after root validation.
for managed_path in "$storage_path" "$storage_path/$storage_sentinel"; do
  storage_owner="$(stat -c '%u:%g' -- "$managed_path")"
  [[ "$storage_owner" == 568:568 ]] || fail "$managed_path is owned by $storage_owner; expected 568:568 (the updater will not change ownership)"
done
processing_value="$(env_value PROCESSING_PLATFORM_ENABLED)"
case "${processing_value,,}" in
  1|true|yes|on) derived_mode=processing ;;
  0|false|no|off|'') derived_mode=view-only ;;
  *) fail "PROCESSING_PLATFORM_ENABLED must be true or false" ;;
esac
case "$requested_mode" in
  auto) mode="$derived_mode" ;;
  processing|view-only)
    [[ "$requested_mode" == "$derived_mode" ]] || fail "requested mode $requested_mode conflicts with PROCESSING_PLATFORM_ENABLED=$processing_value"
    mode="$requested_mode"
    ;;
  *) fail "usage: $0 [compose-directory] [auto|processing|view-only]" ;;
esac

compose_args=(--env-file "$viewer_config")

mapfile -t images < <(docker compose "${compose_args[@]}" config --images | sort -u)
[[ "${#images[@]}" -eq 1 ]] || fail "Compose must resolve exactly one Viewer image"
target_image="${images[0]}"
if [[ "$target_image" != "$official_latest_image" && ! "$target_image" =~ @sha256:[a-fA-F0-9]{64}$ && ! "$target_image" =~ :sha-[a-fA-F0-9]{7,64}$ ]]; then
  fail "VIEWER_IMAGE must use $official_latest_image, a CI sha-<commit> tag, or an @sha256 digest: $target_image"
fi

api_id="$(docker compose "${compose_args[@]}" ps -q viewer-api 2>/dev/null || true)"
previous_image_id=""
if [[ -n "$api_id" ]]; then
  previous_image_id="$(docker inspect --format '{{.Image}}' "$api_id")"
  docker image tag "$previous_image_id" "$rollback_image"
fi

rollback() {
  local status="$1"
  echo "viewer update failed during $status" >&2
  if [[ -n "$previous_image_id" ]]; then
    echo "rolling back to $previous_image_id via $rollback_image" >&2
    VIEWER_ROLLBACK_IMAGE="$rollback_image" docker compose "${compose_args[@]}" -f docker-compose.yml -f "$rollback_compose" up -d --remove-orphans --pull never --wait --wait-timeout 180 || true
  else
    echo "no previous Viewer image was available for automatic rollback" >&2
  fi
  exit 1
}

docker compose "${compose_args[@]}" pull || rollback pull
if [[ -n "$api_id" && "${VIEWER_UPDATE_ALLOW_ACTIVE:-0}" != 1 ]]; then
  # Pull first, then check immediately before replacement. Operators must keep
  # Ops processing admission paused for the update so no new work can enter
  # between this check and Compose stopping the services.
  if ! docker exec "$api_id" node -e '
    const {DatabaseSync}=require("node:sqlite"),{config}=require("./server/config");
    const db=new DatabaseSync(config.databasePath,{readOnly:true});
    const checks=[
      ["nonterminal attempts","SELECT COUNT(*) n FROM processing_attempts WHERE status NOT IN (\"ready_for_review\",\"failed\",\"cancelled\",\"published\")"],
      ["processing jobs","SELECT COUNT(*) n FROM processing_jobs WHERE status=\"leased\""],
      ["derivative jobs","SELECT COUNT(*) n FROM derivative_jobs WHERE status=\"leased\""],
      ["dataset operations","SELECT COUNT(*) n FROM dataset_operations WHERE status=\"leased\""],
      ["storage mutations","SELECT COUNT(*) n FROM storage_mutations WHERE status IN (\"intent\",\"fs_applied\")"],
    ];
    const active=checks.map(([name,sql])=>[name,Number(db.prepare(sql).get().n)]).filter(([,n])=>n>0);db.close();
    if(active.length){console.error(active.map(([name,n])=>`${name}: ${n}`).join(", "));process.exit(3);}
  '; then
    fail "active durable work exists; keep Ops admission paused and let work settle, or set VIEWER_UPDATE_ALLOW_ACTIVE=1 only for emergency recovery"
  fi
fi
docker compose "${compose_args[@]}" up -d --remove-orphans --wait --wait-timeout 180 || rollback startup
for relative_path in "${required_storage_paths[@]}"; do
  managed_path="$storage_path/$relative_path"
  [[ -d "$managed_path" ]] || rollback "managed directory creation ($relative_path)"
  [[ "$(stat -c '%u:%g' -- "$managed_path")" == 568:568 ]] || rollback "managed directory ownership ($relative_path)"
done
readiness_args=()
[[ "$mode" == processing ]] && readiness_args+=(--require-processing)
docker compose "${compose_args[@]}" exec -T viewer-api node scripts/production-readiness.mjs "${readiness_args[@]}" || rollback readiness
docker compose "${compose_args[@]}" ps
echo "viewer update complete: $target_image ($mode)"
if [[ -n "$previous_image_id" ]]; then
  echo "previous image retained locally as $rollback_image ($previous_image_id)"
fi

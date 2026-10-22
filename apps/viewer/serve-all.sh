#!/usr/bin/env bash
# LTDS 3D Viewer — start all servers (app + assets + photos)
# Usage: ./serve-all.sh
set -u

VIEWER_DIR="$HOME/ltds-3d-viewer"
SMB_EXTRACTED="/mnt/Share/Ai_Storage/Hermes/temp/WebODM/extracted"
PHOTOS_DIR="/mnt/drone_jobs/Jobs/Clients/Randy Cadens LLC/Dump/8-4-26 Map/Map All"

start_if_free() {
  local port="$1"; shift
  if ss -tln | grep -q ":$port "; then
    echo "port $port already serving — skipped"
  else
    echo "starting :$port -> $*"
    nohup "$@" > "/tmp/ltds-serve-$port.log" 2>&1 &
  fi
}

cd "$VIEWER_DIR"

# 8080 — Vite app (dev). For production use: npx vite preview --host 0.0.0.0 --port 8080
start_if_free 8080 npx vite --host 0.0.0.0 --port 8080

# 8081 — local fast assets: GLB, 3D tiles, draco, potree, pointcloud.html
start_if_free 8081 npx http-server "$VIEWER_DIR/public" -p 8081 --cors -c-1

# 8082 — SMB WebODM outputs: EPT point cloud, GeoTIFFs, shots.geojson
start_if_free 8082 npx http-server "$SMB_EXTRACTED" -p 8082 --cors -c-1

# 8083 — original flight photos (full-res JPG per camera marker)
start_if_free 8083 npx http-server "$PHOTOS_DIR" -p 8083 --cors -c86400

sleep 2
echo '---'
for p in 8080 8081 8082 8083; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$p/" || echo ERR)
  echo "port $p -> HTTP $code"
done

#!/usr/bin/env bash
# Backup hotline DB — Postgres (DATABASE_URL) or SQLite (DATABASE_PATH).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="${BACKUP_DIR:-$ROOT/data/backups}"
mkdir -p "$OUT_DIR"

if [[ -n "${DATABASE_URL:-}" ]]; then
  FILE="$OUT_DIR/hotline-pg-$STAMP.sql.gz"
  echo "Backing up Postgres → $FILE"
  if command -v pg_dump >/dev/null 2>&1; then
    pg_dump "$DATABASE_URL" | gzip -c >"$FILE"
  elif command -v docker >/dev/null 2>&1; then
    # Compose service name
    docker compose -f "$ROOT/docker-compose.yml" exec -T postgres \
      pg_dump -U "${POSTGRES_USER:-hotline}" "${POSTGRES_DB:-hotline}" | gzip -c >"$FILE"
  else
    echo "Need pg_dump or docker compose for Postgres backup" >&2
    exit 1
  fi
else
  SRC="${DATABASE_PATH:-$ROOT/data/hotline.db}"
  FILE="$OUT_DIR/hotline-sqlite-$STAMP.db"
  echo "Backing up SQLite $SRC → $FILE"
  if [[ ! -f "$SRC" ]]; then
    echo "No SQLite DB at $SRC" >&2
    exit 1
  fi
  cp "$SRC" "$FILE"
  # WAL companions if present
  [[ -f "$SRC-wal" ]] && cp "$SRC-wal" "$FILE-wal" || true
  [[ -f "$SRC-shm" ]] && cp "$SRC-shm" "$FILE-shm" || true
fi

# Keep last N backups
KEEP="${BACKUP_KEEP:-14}"
# shellcheck disable=SC2012
ls -1t "$OUT_DIR"/hotline-* 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r old; do
  rm -f "$old"
done

echo "OK $FILE"
ls -lh "$FILE"

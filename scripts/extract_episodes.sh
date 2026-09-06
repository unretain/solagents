#!/usr/bin/env bash
# Episode extractor. Runs ON the box.
#
#   ./extract_episodes.sh --create                       create the table only
#   ./extract_episodes.sh --from '...' --to '...' [-H 60] extract one window
#   ./extract_episodes.sh --backfill                     every settled hour we still hold
#
# Credentials are read from the API .env, never passed in.
set -euo pipefail

API_DIR=${API_DIR:-/opt/polyx-api/apps/api}
SQL_DIR=${SQL_DIR:-$(cd "$(dirname "$0")/../clickhouse" && pwd)}
cd "$API_DIR"

CH_URL=$(grep -m1 '^CLICKHOUSE_URL=' .env | cut -d= -f2- | tr -d '"')
CH_USER=$(grep -m1 '^CLICKHOUSE_USER=' .env | cut -d= -f2- | tr -d '"')
CH_PASS=$(grep -m1 '^CLICKHOUSE_PASSWORD=' .env | cut -d= -f2- | tr -d '"')
CH_URL=${CH_URL:-http://127.0.0.1:8123}

# DDL and INSERT must be POST with --data-binary: HTTP GET is readonly, and the
# POST body is not url-decoded, so DEFAULT '' survives as written.
ch_write() { curl -sS -X POST "$CH_URL" --user "$CH_USER:$CH_PASS" --data-binary "$1"; }
ch_read()  { curl -sS --get "$CH_URL" --user "$CH_USER:$CH_PASS" --data-urlencode "query=$1"; }

HORIZON=60
FROM=""; TO=""; MODE=""

RECENT_HOURS=4

while [ $# -gt 0 ]; do
  case "$1" in
    --create)   MODE=create; shift ;;
    --backfill) MODE=backfill; shift ;;
    --recent)   MODE=recent; RECENT_HOURS=${2:-4};
                case "$RECENT_HOURS" in ''|*[!0-9]*) RECENT_HOURS=4 ;; *) shift ;; esac
                shift ;;
    --from)     FROM=$2; MODE=${MODE:-window}; shift 2 ;;
    --to)       TO=$2;   MODE=${MODE:-window}; shift 2 ;;
    -H|--horizon) HORIZON=$2; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

create_table() {
  echo "[episodes] creating tables (idempotent)"
  ch_write "$(cat "$SQL_DIR/01_episodes.sql")"
  ch_write "$(cat "$SQL_DIR/04_episode_paths.sql")"
  ch_write "$(cat "$SQL_DIR/03_episodes_enriched.sql")"
  echo "[episodes] ok"
}

render() { sed -e "s/{H}/$2/g" -e "s/{FROM}/$3/g" -e "s/{TO}/$4/g" "$SQL_DIR/$1"; }

extract_window() {
  local from=$1 to=$2 h=$3
  echo "[episodes] h=${h}s  $from -> $to"
  ch_write "$(render 02_extract_episodes.sql "$h" "$from" "$to")"
  # Paths are written in the same pass, from the same `launches` definition, so
  # an episode can never exist without its path or vice versa.
  ch_write "$(render 05_extract_paths.sql "$h" "$from" "$to")"
  ch_read "SELECT count() FROM episodes WHERE horizon_s = $h AND t0 >= toDateTime64('$from',3) AND t0 < toDateTime64('$to',3)"
}

case "${MODE:-}" in
  create) create_table ;;

  window)
    [ -n "$FROM" ] && [ -n "$TO" ] || { echo "--from and --to required" >&2; exit 2; }
    extract_window "$FROM" "$TO" "$HORIZON"
    ;;

  # Incremental catch-up, for cron. Re-extracting a window is idempotent
  # (ReplacingMergeTree keyed on (mint, horizon_s), and every read goes through
  # a FINAL view), so overlapping runs are safe — they only cost a little disk
  # until the next merge.
  recent)
    create_table
    LAG=$(( HORIZON + 3600 ))
    END=$(ch_read "SELECT toStartOfHour(now() - INTERVAL $LAG SECOND)" | tr -d '\r')
    end_e=$(date -u -d "$END UTC" +%s)
    cur_e=$(( end_e - RECENT_HOURS * 3600 ))
    echo "[episodes] recent ${RECENT_HOURS}h ending $END (horizon ${HORIZON}s)"
    while [ "$cur_e" -lt "$end_e" ]; do
      nxt_e=$(( cur_e + 3600 ))
      extract_window \
        "$(date -u -d "@$cur_e" '+%Y-%m-%d %H:%M:%S')" \
        "$(date -u -d "@$nxt_e" '+%Y-%m-%d %H:%M:%S')" \
        "$HORIZON"
      cur_e=$nxt_e
    done
    ;;

  backfill)
    create_table
    # An episode is only labelled once its 60m outcome window has closed, so the
    # newest extractable launch hour is (now - horizon - 60m), floored to the hour.
    # Anything fresher would be written with truncated outcomes and, because this
    # is a ReplacingMergeTree, would look settled forever after.
    LAG=$(( HORIZON + 3600 ))
    START=$(ch_read "SELECT toStartOfHour(min(ts)) FROM trades" | tr -d '\r')
    END=$(ch_read "SELECT toStartOfHour(now() - INTERVAL $LAG SECOND)" | tr -d '\r')
    echo "[episodes] backfill $START -> $END  (horizon ${HORIZON}s)"
    # Epoch arithmetic, not `date -d "$ts +1 hour"`: in that form GNU date reads
    # the "+1" as a UTC OFFSET on the timestamp rather than an increment, so the
    # cursor never advances and the loop spins forever.
    cur_e=$(date -u -d "$START UTC" +%s)
    end_e=$(date -u -d "$END UTC" +%s)
    while [ "$cur_e" -lt "$end_e" ]; do
      nxt_e=$(( cur_e + 3600 ))
      extract_window \
        "$(date -u -d "@$cur_e" '+%Y-%m-%d %H:%M:%S')" \
        "$(date -u -d "@$nxt_e" '+%Y-%m-%d %H:%M:%S')" \
        "$HORIZON"
      cur_e=$nxt_e
    done
    ;;

  *) sed -n '2,9p' "$0"; exit 2 ;;
esac

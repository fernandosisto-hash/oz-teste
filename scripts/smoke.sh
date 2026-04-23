#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
API_TOKEN_VALUE="${API_TOKEN:-}"
TASK_TITLE="${TASK_TITLE:-smoke task}"
TASK_MODE="${TASK_MODE:-local}"

curl_json() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  if [[ -n "$API_TOKEN_VALUE" ]]; then
    auth=(-H "Authorization: Bearer ${API_TOKEN_VALUE}")
  else
    auth=()
  fi

  if [[ -n "$body" ]]; then
    curl -fsS -X "$method" "${BASE_URL}${path}" \
      -H 'Content-Type: application/json' \
      "${auth[@]}" \
      -d "$body"
  else
    curl -fsS -X "$method" "${BASE_URL}${path}" \
      "${auth[@]}"
  fi
}

echo '[1/5] health'
HEALTH=$(curl_json GET /health)
echo "$HEALTH"
echo "$HEALTH" | jq -e '.status == "ok" and .checks.storage.ok == true' >/dev/null

echo '[2/5] create task'
CREATE=$(curl_json POST /tasks "{\"title\":\"${TASK_TITLE}\",\"executionMode\":\"${TASK_MODE}\"}")
echo "$CREATE"
TASK_ID=$(echo "$CREATE" | jq -r '.id')

echo '[3/5] dispatch task'
DISPATCH=$(curl_json POST "/tasks/${TASK_ID}/dispatch" '{}')
echo "$DISPATCH"
echo "$DISPATCH" | jq -e '.id > 0' >/dev/null

echo '[4/5] fetch task'
TASK=$(curl_json GET "/tasks/${TASK_ID}")
echo "$TASK"
echo "$TASK" | jq -e '.status == "done" or .status == "in_progress" or .status == "failed"' >/dev/null

echo '[5/5] notifications'
NOTIFS=$(curl_json GET "/tasks/${TASK_ID}/notifications")
echo "$NOTIFS"
echo "$NOTIFS" | jq -e '.notifications | type == "array"' >/dev/null

echo 'SMOKE_OK'

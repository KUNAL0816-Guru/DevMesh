#!/usr/bin/env bash
# DevMesh test runner for proot/Termux.
#
# Vitest deadlocks when attached to piped stdio in this environment, so we run
# it detached (setsid, stdin=/dev/null) with output captured to a log file,
# wait for completion, then print the tail and propagate the exit code.
#
# Usage: scripts/run-tests.sh [extra vitest args...]
set -u

LOG="${DEVMESH_TEST_LOG:-/tmp/opencode/devmesh-vitest.log}"
TIMEOUT="${DEVMESH_TEST_TIMEOUT:-900}"
TAIL_N="${DEVMESH_TEST_TAIL:-40}"
mkdir -p "$(dirname "$LOG")"

: > "$LOG"
setsid npx vitest run "$@" < /dev/null > "$LOG" 2>&1 &
pid=$!

done=0
for _ in $(seq 1 "$TIMEOUT"); do
  if ! kill -0 "$pid" 2>/dev/null; then
    done=1
    break
  fi
  sleep 1
done

if [ "$done" -ne 1 ]; then
  echo "tests timed out after ${TIMEOUT}s — log: $LOG" >&2
  kill -9 "$pid" 2>/dev/null
  tail -n "$TAIL_N" "$LOG"
  exit 2
fi

wait "$pid"
status=$?

tail -n "$TAIL_N" "$LOG"

if grep -qE "Tests +[0-9]+ failed|No test files found|Unhandled Error" "$LOG"; then
  exit 1
fi
if ! grep -qE "Test Files +[0-9]+ passed" "$LOG"; then
  exit 1
fi
exit "$status"

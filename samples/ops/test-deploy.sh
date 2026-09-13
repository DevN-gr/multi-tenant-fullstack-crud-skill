#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════════
#  Exercises ops/acme-deploy.sh — every path, including the ones you hope
#  never run — without a VPS and without Docker.
#
#      bash ops/test-deploy.sh
#
#  Two things make it worth trusting:
#
#    * the git repository is REAL — a bare "upstream", a clone standing in for
#      the deployment checkout, actual commits. The fetch/reset/rollback logic
#      is the thing under test, so faking git would test nothing.
#    * `docker` is a stub on PATH whose answers are driven by the environment,
#      so a build failure, an unhealthy container and one that never leaves
#      "starting" are all reachable in a second each.
#
#  The rollback path is the reason this file exists. It runs on the day
#  somebody pushes a broken commit, which is the worst possible day to find
#  out that the rollback itself is broken.
# ══════════════════════════════════════════════════════════════════════════
set -uo pipefail

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/acme-deploy.sh"
RED=$'\033[31m'; GREEN=$'\033[32m'; DIM=$'\033[2m'; RESET=$'\033[0m'
passed=0; failed=0

check() { # name, condition-already-evaluated
  if [ "$1" = pass ]; then passed=$((passed+1)); printf '    %s✓%s %s\n' "$GREEN" "$RESET" "$2"
  else failed=$((failed+1)); printf '    %s✗%s %s%s\n' "$RED" "$RESET" "$2" "${3:+ $DIM— $3$RESET}"; fi
}
expect() { [ "$2" = "$3" ] && check pass "$1" || check fail "$1" "expected '$3', got '$2'"; }

# ── A sandbox per case, so no case can be passing on another's leftovers ──
setup() {
  S="$(mktemp -d)"
  export S
  git init -q --bare -b main "$S/upstream"
  git clone -q "$S/upstream" "$S/work" 2>/dev/null
  git -C "$S/work" config user.email t@example.com
  git -C "$S/work" config user.name  Test
  printf 'services:\n  api: {}\n  web: {}\n' > "$S/work/docker-compose.yml"
  git -C "$S/work" add -A
  git -C "$S/work" commit -qm 'first'
  git -C "$S/work" push -q origin main

  mkdir -p "$S/deployment"
  git clone -q "$S/upstream" "$S/deployment/acme"

  # The stub. `compose up` fails when the tree carries a BROKEN marker, which
  # is how a bad commit is simulated: after a rollback the marker is gone and
  # the rebuild succeeds, exactly as it would on the real box.
  mkdir -p "$S/bin"
  cat > "$S/bin/docker" <<'STUB'
#!/usr/bin/env bash
case "$1 $2" in
  "compose up")
    [ -f ./BROKEN ] && { echo "stub: build failed" >&2; exit 1; }
    exit 0 ;;
esac
case "$1" in
  inspect) case "$3" in
             *State.Status*) echo "${FAKE_STATE:-running}" ;;
             *)              echo "${FAKE_HEALTH:-healthy}" ;;
           esac ;;
  logs)  echo "[container logs]" ;;
  image) exit 0 ;;
esac
exit 0
STUB
  chmod +x "$S/bin/docker"
}

teardown() { rm -rf "$S"; }

commit_to_upstream() { # message [marker-file] → prints the sha
  local msg="$1" marker="${2:-}"
  [ -n "$marker" ] && : > "$S/work/$marker"
  printf '%s\n' "$msg" >> "$S/work/CHANGELOG"
  git -C "$S/work" add -A
  git -C "$S/work" commit -qm "$msg"
  git -C "$S/work" push -q origin main
  git -C "$S/work" rev-parse HEAD
}

deploy() { # [ssh-original-command] → writes $OUT, returns the exit code
  local cmd="${1-}"
  OUT="$(
    env PATH="$S/bin:$PATH" \
        DEPLOY_DIR="$S/deployment" \
        CHECKOUT="$S/deployment/acme" \
        COMPOSE_DIR="$S/deployment/acme" \
        HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-30}" \
        FAKE_STATE="${FAKE_STATE:-running}" \
        FAKE_HEALTH="${FAKE_HEALTH:-healthy}" \
        PRUNE=0 \
        ${cmd:+SSH_ORIGINAL_COMMAND="$cmd"} \
        bash "$SCRIPT" 2>&1
  )"
  return $?
}

head_sha() { git -C "$S/deployment/acme" rev-parse HEAD; }

# ══════════════════════════════════════════════════════════════════════════
printf '\n  ops/acme-deploy.sh\n\n'

# ── 1. A valid SHA deploys ───────────────────────────────────────────────
printf '  a valid commit sha\n'
setup
sha="$(commit_to_upstream 'second')"
deploy "$sha"; rc=$?
expect 'exits 0'                     "$rc"          0
expect 'checkout is at that commit'  "$(head_sha)"  "$sha"
case "$OUT" in *"deployed ${sha:0:8}"*) check pass 'reports the commit it deployed' ;;
               *) check fail 'reports the commit it deployed' "$OUT" ;; esac
teardown

# ── 2. Anything that is not a sha is refused ─────────────────────────────
# This is what makes handing the private key to GitHub defensible: the key
# cannot run a command, and the one string it can pass is checked here.
printf '\n  a key that deploys a commit and does nothing else\n'
for attempt in 'bash -i' 'origin/main; rm -rf /' 'main' '$(whoami)' \
               'deadbeef' 'DEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF'; do
  setup
  before="$(head_sha)"
  deploy "$attempt"; rc=$?
  # The refusal MESSAGE, not merely a non-zero exit: most of these are not
  # valid git revisions either, so a build with the guard deleted still fails
  # — later, by accident, and for the wrong reason. Assert the guard.
  if [ "$rc" -ne 0 ] && [ "$(head_sha)" = "$before" ] && [[ "$OUT" == *refusing* ]]; then
    check pass "refuses ${attempt} — exit $rc, checkout untouched"
  else
    check fail "refuses ${attempt}" "exit $rc, ${OUT%%$'\n'*}"
  fi
  teardown
done
# ('DEADBEEF…' in capitals is in that list on purpose: the regex is anchored
#  and lower-case, and a case-insensitive match would let a tag named for a
#  branch through.)

# ── 3. No command at all falls back to origin/main ───────────────────────
printf '\n  an operator running it by hand\n'
setup
sha="$(commit_to_upstream 'third')"
deploy; rc=$?
expect 'exits 0'                 "$rc"         0
expect 'deploys origin/main'     "$(head_sha)" "$sha"
teardown

# ── 4. A container that comes up unhealthy rolls back ────────────────────
printf '\n  a commit whose containers never become healthy\n'
setup
good="$(commit_to_upstream 'good')"
deploy "$good" >/dev/null
bad="$(commit_to_upstream 'bad')"
FAKE_HEALTH=unhealthy deploy "$bad"; rc=$?
expect 'exits non-zero'                    "$rc"         1
expect 'checkout is back on the good one'  "$(head_sha)" "$good"
case "$OUT" in *"rolled back"*) check pass 'says it rolled back' ;;
               *) check fail 'says it rolled back' "$OUT" ;; esac
case "$OUT" in *"[container logs]"*) check pass 'prints the container logs' ;;
               *) check fail 'prints the container logs' "$OUT" ;; esac
teardown

# ── 5. A commit that does not build rolls back ───────────────────────────
printf '\n  a commit that does not build\n'
setup
good="$(commit_to_upstream 'good')"
deploy "$good" >/dev/null
bad="$(commit_to_upstream 'breaks the build' BROKEN)"
deploy "$bad"; rc=$?
expect 'exits non-zero'                    "$rc"         1
expect 'checkout is back on the good one'  "$(head_sha)" "$good"
case "$OUT" in *"rolled back"*) check pass 'the rebuild of the good commit succeeded' ;;
               *) check fail 'the rebuild of the good commit succeeded' "$OUT" ;; esac
teardown

# ── 6. A container stuck in "starting" times out and rolls back ──────────
printf '\n  a container that never finishes starting\n'
setup
good="$(commit_to_upstream 'good')"
deploy "$good" >/dev/null
bad="$(commit_to_upstream 'hangs')"
started=$SECONDS
FAKE_HEALTH=starting HEALTH_TIMEOUT=6 deploy "$bad"; rc=$?
elapsed=$(( SECONDS - started ))
expect 'exits non-zero'                    "$rc"         1
expect 'checkout is back on the good one'  "$(head_sha)" "$good"
[ "$elapsed" -ge 6 ] && [ "$elapsed" -lt 40 ] \
  && check pass "gave up after ${elapsed}s, not immediately and not for ever" \
  || check fail "waited for the timeout" "${elapsed}s"
teardown

# ── 7. The lock serialises two deploys ───────────────────────────────────
# Not one of the paths CI takes, but the one that corrupts a checkout when it
# is missing: two runs resetting the same tree while the other builds it.
printf '\n  two deploys at once\n'
setup
sha="$(commit_to_upstream 'second')"
( exec 9>"$S/deployment/.acme-deploy.lock"; flock 9; sleep 3 ) &
holder=$!
sleep 0.3
started=$SECONDS
deploy "$sha"; rc=$?
waited=$(( SECONDS - started ))
wait $holder
expect 'exits 0 once the lock is free' "$rc" 0
[ "$waited" -ge 2 ] \
  && check pass "waited ${waited}s for the other deploy instead of racing it" \
  || check fail 'waited for the lock' "${waited}s"
teardown

printf '\n  %s%d passed%s, %s%d failed%s\n\n' \
  "$GREEN" "$passed" "$RESET" "$([ "$failed" -gt 0 ] && echo "$RED")" "$failed" "$RESET"
[ "$failed" -eq 0 ]

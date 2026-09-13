#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════════
#  Acme — the deploy half of push-to-main.
#
#  This file lives on the VPS at ~/deployment/acme-deploy.sh and is pinned to
#  the CI key as a forced command, so a GitHub Actions run can deploy a commit
#  and can do NOTHING else:
#
#      command="/home/deploy/deployment/acme-deploy.sh",restrict ssh-ed25519 AAAA…
#
#  The copy in the repository is the reviewable source. `scp` it up after
#  changing it. **Do not symlink the server's copy into the checkout**: bash
#  reads a script as it executes it, and a deploy that `git reset`s its own
#  running file is a bug nobody wants to debug mid-build.
#
#      Name everything here for the project. `deploy.sh` and `.deploy.lock` on
#      a box that hosts three other apps are collisions waiting to happen, and
#      the one that bites is silent: two projects sharing one lock file means
#      one project's deploy blocks on the other's.
#
#  Layout it expects:
#
#      ~/deployment/                 DEPLOY_DIR   the lock lives here, OUTSIDE
#                                                 the checkout, so `git reset`
#                                                 can never remove it
#        acme-deploy.sh              this file
#        .acme-deploy.lock
#        acme/                       CHECKOUT     the repository
#          docker-compose.yml        COMPOSE_DIR  committed
#          .env                                   NOT committed; survives the
#                                                 reset because it is ignored
#
#  The other shape — a wrapper compose file in DEPLOY_DIR that `include:`s the
#  checkout's, which is what you want when this box's Traefik is shared with
#  other apps — works too: point COMPOSE_DIR at DEPLOY_DIR. Whichever it is,
#  it is the compose file in the DEPLOY directory that decides what runs, not
#  the one you are reading in the repository.
# ══════════════════════════════════════════════════════════════════════════
set -Eeuo pipefail

# Every path and timeout is overridable so ops/test-deploy.sh can drive this
# file itself rather than a copy of it that has drifted.
DEPLOY_DIR="${DEPLOY_DIR:-$HOME/deployment}"
CHECKOUT="${CHECKOUT:-$DEPLOY_DIR/acme}"
COMPOSE_DIR="${COMPOSE_DIR:-$CHECKOUT}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-180}"
PRUNE="${PRUNE:-1}"

# Compose SERVICE names — what gets rebuilt. `db` and `traefik` are not here:
# they are images we did not build, and restarting Traefik drops every other
# site on the box with it.
SERVICES=(api web)

# Docker CONTAINER names — what gets inspected. They are NOT the service
# names (docker-compose.yml sets container_name: acme_api), and `docker
# inspect api` on a box with another project's `api` service either fails or,
# worse, answers about someone else's container.
CONTAINERS=(acme_api acme_web)

log() { printf '%s  %s\n' "$(date -u +%H:%M:%S)" "$*"; }
die() { printf '\n!! %s\n' "$*" >&2; exit 1; }

# ── One deploy at a time ──────────────────────────────────────────────────
# Two runs interleaving over one checkout means one of them builds a tree the
# other is resetting. CI queues them (concurrency: production), but a human
# running this by hand does not know that.
mkdir -p "$DEPLOY_DIR"
exec 9>"$DEPLOY_DIR/.acme-deploy.lock"
flock -w 300 9 || die "another deploy held the lock for five minutes"

# ── What are we being asked to deploy? ────────────────────────────────────
# This block is the whole reason the CI key is safe to hand to GitHub. The key
# cannot run a command; it can only pass a string here, and a string that is
# not 40 hex characters is refused.
REQUESTED="${SSH_ORIGINAL_COMMAND:-}"
if   [ -z "$REQUESTED" ];                  then TARGET="origin/main"
elif [[ "$REQUESTED" =~ ^[0-9a-f]{40}$ ]]; then TARGET="$REQUESTED"
else die "refusing '$REQUESTED' — this key deploys a commit and does nothing else"
fi

[ -d "$CHECKOUT/.git" ] || die "no git checkout at $CHECKOUT"
compose_file=""
for f in docker-compose.yml docker-compose.yaml compose.yml compose.yaml; do
  [ -f "$COMPOSE_DIR/$f" ] && { compose_file="$f"; break; }
done
[ -n "$compose_file" ] || die "no compose file in $COMPOSE_DIR"

PREVIOUS="$(git -C "$CHECKOUT" rev-parse HEAD)"

# `git fetch`, never `git pull`. The checkout is a deployment artefact, not a
# workspace: a pull that stops on a local edit stops the deploy with it, and a
# merge commit created on the server is a commit that exists nowhere else.
#
# The failure to expect here is authentication. Pulling by hand works because
# an interactive session has a forwarded ssh-agent; a forced command has no
# agent and no terminal, so the checkout needs its own deploy key pinned with
# `git config core.sshCommand`. See ops/README.md.
git -C "$CHECKOUT" fetch --prune --quiet origin \
  || die "cannot fetch from origin — a forced command has no ssh-agent, so the checkout needs its own deploy key (git config core.sshCommand)"

git -C "$CHECKOUT" reset --hard --quiet "$TARGET"
NOW="$(git -C "$CHECKOUT" rev-parse HEAD)"
log "deploying ${NOW:0:8} (was ${PREVIOUS:0:8})"

# ── Rollback ──────────────────────────────────────────────────────────────
# Installed AFTER the fetch, deliberately: if the fetch failed nothing has
# changed yet and there is nothing to roll back to.
abort() {
  trap - ERR
  if [ "$NOW" = "$PREVIOUS" ]; then
    log "FAILED — already on ${PREVIOUS:0:8}, nothing earlier to fall back to"
    exit 1
  fi
  log "FAILED — restoring ${PREVIOUS:0:8}"
  git -C "$CHECKOUT" reset --hard --quiet "$PREVIOUS"
  if (cd "$COMPOSE_DIR" && docker compose up -d --build "${SERVICES[@]}"); then
    log "rolled back to ${PREVIOUS:0:8}"
  else
    log "ROLLBACK ALSO FAILED — the site needs a person"
  fi
  exit 1
}
trap abort ERR

cd "$COMPOSE_DIR"
docker compose up -d --build "${SERVICES[@]}"

# ── Wait for the containers' own healthchecks ─────────────────────────────
# Both Dockerfiles declare a HEALTHCHECK, so the containers already answer "am
# I up?" — and the API's does not answer until the schema is applied, because
# bin/www does not listen before db.init() resolves. A second, different probe
# written here would be a second thing to be wrong.
deadline=$(( SECONDS + HEALTH_TIMEOUT ))
for name in "${CONTAINERS[@]}"; do
  while :; do
    state="$(docker inspect -f '{{.State.Status}}' "$name" 2>/dev/null || echo missing)"
    health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$name" 2>/dev/null || echo none)"

    if [ "$state" = running ] && { [ "$health" = healthy ] || [ "$health" = none ]; }; then
      log "  $name healthy"
      break
    fi
    if [ "$state" != running ] || [ "$health" = unhealthy ]; then
      log "  $name is $state/$health"
      docker logs --tail 40 "$name" 2>&1 | sed 's/^/    /' || true
      abort
    fi
    if (( SECONDS >= deadline )); then
      log "  $name still $state/$health after ${HEALTH_TIMEOUT}s"
      docker logs --tail 40 "$name" 2>&1 | sed 's/^/    /' || true
      abort
    fi
    sleep 3
  done
done
trap - ERR

# ── Housekeeping ──────────────────────────────────────────────────────────
# Every build leaves the previous image untagged, and a VPS disk fills
# quietly. Dangling images only, and never `-a`: this command is box-wide, and
# `-a` on a shared box deletes every image without a running container —
# including the one another app is about to restart from.
if [ "$PRUNE" = 1 ]; then
  docker image prune -f --filter 'until=168h' >/dev/null 2>&1 || true
fi

log "deployed ${NOW:0:8}"

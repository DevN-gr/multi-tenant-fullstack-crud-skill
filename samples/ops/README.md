# ops/ — push to main, deploy to the VPS

Two files, and they are two halves of one thing:

| File | Where it runs |
|---|---|
| `../.github/workflows/deploy.yml` | A GitHub-hosted runner. Runs the gate, then opens one SSH connection. |
| `acme-deploy.sh` | The VPS. Fetches the verified commit, rebuilds, waits for health, rolls back if it has to. |
| `test-deploy.sh` | Your machine. Drives `acme-deploy.sh` through every path with a stubbed `docker`. |

The runner never touches the box beyond that one connection, and the key it
holds is pinned to `acme-deploy.sh` as a forced command — so the worst a
stolen CI key can do is deploy a commit that is already in your repository.

Everything below has to be done by a person with shell on the VPS. Do them in
order; each has a check, and a step that does not pass its check will fail
later in a way that is harder to read.

Replace `acme`, `deploy` and `vps.example.com` throughout.

---

## 1. The script, run by hand first

Get it deploying before any of CI exists. If this step does not work, nothing
after it can.

```bash
scp ops/acme-deploy.sh deploy@vps.example.com:~/deployment/acme-deploy.sh
ssh deploy@vps.example.com 'chmod +x ~/deployment/acme-deploy.sh && ~/deployment/acme-deploy.sh'
```

**Check:** it prints `deploying …`, then `acme_api healthy`, `acme_web healthy`,
then `deployed <sha>`.

> Keep the repository copy as the reviewable source and `scp` it up after each
> change. **Do not symlink the server's copy into the checkout.** Bash reads a
> script as it executes it, and this one `git reset`s the tree it would be
> living in — a deploy that rewrites its own running file mid-build is a bug
> nobody wants to debug at the time it happens.

---

## 2. A deploy key for the checkout

Pulling by hand works because your interactive session forwards your ssh-agent.
A forced command has no agent, so the same `git fetch` that works for you fails
under CI with `Permission denied (publickey)`. The checkout needs its own key.

```bash
ssh-keygen -t ed25519 -f ~/.ssh/acme_github -N '' -C 'acme-vps-deploy-key'
cat ~/.ssh/acme_github.pub
```

Add that public key to the repository on GitHub — **Settings → Deploy keys →
Add deploy key**, *without* write access — then point this one checkout at it:

```bash
git -C ~/deployment/acme config core.sshCommand \
  "ssh -i /home/deploy/.ssh/acme_github -o IdentitiesOnly=yes"
```

Per repository, through `core.sshCommand` — **not** a `Host github.com` block
in `~/.ssh/config`. This box runs other things, and a global rule silently
redirects every other project's `git` on it to this key.

**Check**, with the agent taken away, which is the condition CI runs under. An
interactive test passes here and proves nothing:

```bash
env -u SSH_AUTH_SOCK git -C ~/deployment/acme fetch --prune origin && echo OK
```

---

## 3. The CI key, pinned to the script

Generate it on the VPS and authorise it in **one** command chain. Split into
two, the second can be run alone against a `/tmp/ci.pub` that does not exist,
which appends a line with a command and no key — and every future connection,
including yours, is then read against a malformed `authorized_keys`.

```bash
ssh-keygen -t ed25519 -f /tmp/ci -N '' -C 'github-actions-deploy' && \
printf 'command="%s/deployment/acme-deploy.sh",restrict %s\n' \
  "$HOME" "$(cat /tmp/ci.pub)" >> ~/.ssh/authorized_keys
```

`restrict` switches off the pty, agent forwarding, port forwarding and X11.
With the forced command in front of it, the key can pass one string to
`acme-deploy.sh` and do nothing else at all.

**Check** — one fingerprint per parseable line, and a line that produces none
is malformed:

```bash
ssh-keygen -l -f ~/.ssh/authorized_keys
```

To undo a malformed line:

```bash
sed -i '/,restrict *$/d' ~/.ssh/authorized_keys
```

Now take the private key for GitHub, and destroy the copy on the box:

```bash
cat /tmp/ci            # copy ALL of it, including the BEGIN/END lines
shred -u /tmp/ci /tmp/ci.pub
```

---

## 4. The host key the runner will check

Build the line from the host's own key file rather than `ssh-keyscan` — no
network involved, so there is nothing to intercept:

```bash
printf '%s %s\n' "$(hostname -f)" "$(cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub)"
```

The hostname must be **exactly** what the workflow dials: `DEPLOY_HOST`. If
`hostname -f` disagrees with it, type the one the workflow uses. On a
non-standard port the form is `[vps.example.com]:2222 ssh-ed25519 AAAA…`. From
`ssh-keyscan` instead, drop its `#` banner lines.

If the host key is ever rotated the deploy fails closed and says so. That is
the feature.

---

## 5. GitHub

**Settings → Secrets and variables → Actions**

| Secret | Value |
|---|---|
| `DEPLOY_SSH_KEY` | the whole private key from step 3, `-----BEGIN`/`-----END` lines included |
| `DEPLOY_HOST` | `vps.example.com` |
| `DEPLOY_USER` | `deploy` |
| `DEPLOY_KNOWN_HOSTS` | the line from step 4 |

| Variable | Value |
|---|---|
| `DEPLOY_PORT` | only if SSH is not on 22 |

Then push to `main` — or run the workflow from **Actions → Deploy → Run
workflow**, which is the same path without waiting for a commit.

**Worth doing at the same time:** make `verify` a required status check on
pull requests (**Settings → Branches → Add branch ruleset → Require status
checks to pass**). Without it the gate only ever runs after the merge, and a
red suite reaches `main` before anyone sees it.

---

## When it goes wrong

**A fix to the workflow needs a new push, not a re-run.** Re-running a failed
run replays the same commit, and the workflow file *is* part of that commit —
so the run you re-run is the run that already failed. A fix to
`acme-deploy.sh` on the server is different: `scp` it up and the re-run button
works, because the server-side script is not versioned by the run.

| Symptom | Cause |
|---|---|
| `Could not find 'test/**/*.test.js'`, exit 1 | CI pinned to Node 20. The suite needs Node's own glob expansion, which landed in 21. |
| `git@github.com: Permission denied (publickey)`, exit 128 | Step 2 not done, or done in `~/.ssh/config` instead of `core.sshCommand`. |
| `Host key verification failed` | `DEPLOY_KNOWN_HOSTS` does not match `DEPLOY_HOST` exactly — a bare hostname against an FQDN, or a missing `[host]:port`. |
| `refusing '…' — this key deploys a commit and does nothing else` | Something other than a 40-character SHA reached the script. Expected, if you SSH in with that key by hand. |
| `another deploy held the lock for five minutes` | A previous deploy is still building, or died holding the lock. |
| `ROLLBACK ALSO FAILED — the site needs a person` | The previous commit no longer builds either. Nothing automatic is going to fix this one. |

## Changing the deploy script

```bash
bash ops/test-deploy.sh
```

It builds a real git repository and stubs `docker`, then drives the script
through a good deploy, six refused commands, a by-hand run, an unhealthy
container, a commit that does not build, one that never finishes starting, and
two deploys racing for the lock. The rollback path is the reason it exists: it
runs on the day somebody pushes a broken commit, which is the worst possible
day to discover the rollback was broken too.

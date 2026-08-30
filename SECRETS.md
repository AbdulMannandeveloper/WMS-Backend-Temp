# Secrets — one confirmed exposure, one unverified claim

> An earlier version of this file asserted that a production Aiven connection string "was
> committed to git history". That was repeated from a comment in `.env` and **had not been
> verified**. It is not true of this repository. Checking it properly turned up a *different*
> exposure that is real, and that nobody had recorded.

---

## 1. CONFIRMED — SMTP credentials, committed and pushed

`QUICK_REFERENCE.md` contained a worked example with live values:

```
SMTP_HOST=…      identical to the value in .env
SMTP_USER=…      a 26-character address
SMTP_PASS=…      16 characters — the shape of a Google App Password
```

- Introduced in commit **`e6031f5`** ("Implement complete authentication").
- **Pushed.** That commit is reachable from at least five remote branches — `origin/auth`,
  `origin/authentication`, `origin/authentication-flow-issue-resolved`,
  `origin/client-services-module`, `origin/fixes-for-reset-password`.
- `SMTP_USER` and `SMTP_PASS` in the local `.env` are now **empty**, which is consistent with
  someone clearing `.env` at some point and not realising the same values were in a document.

The values have been replaced with placeholders in the working tree. **That is not the fix.**
The commit is on the remote and in every clone anyone has taken.

### What actually needs doing

1. **Revoke the app password.** In the Google account that owns `SMTP_USER`:
   Security → 2-Step Verification → App passwords → revoke it. Revoking is instant and does not
   require touching this repo.
2. Generate a replacement, put it in `.env` on each environment (never in a tracked file), and
   restart.
3. Check the mailbox's recent activity for sends you do not recognise. An SMTP credential is
   most often abused to send phishing from a domain people already trust.

Rotation is the fix. Rewriting history is optional tidying afterwards, and it cannot reach a
clone somebody already has.

---

## 2. UNVERIFIED — the Aiven note in `.env`

`.env` carries this comment:

> `# NOTE: The previous production Aiven connection string was removed from this file.`
> `# The credentials it contained were exposed in git history and MUST be rotated in Aiven.`

That claim is **not reproducible in this repository**:

| Question | Answer |
|---|---|
| Was `.env` ever committed? | **No** — never added, in either repo, across all 66 commits |
| Does `aivencloud` appear anywhere in history? | **No** |
| Any real connection string in history? | **No.** Only the placeholder `postgres://user:password@localhost` in `.env.example` and the local dev pair `propackers:propackers` in `docker-compose.yml` |

Three explanations fit: it refers to a history rewritten before this clone (which would *not*
reach existing clones or forks), to a repository not on this machine, or to a leak that was never
in git at all — a chat paste, a screenshot, a CI log. None of those are checkable from here.

**Ask whoever wrote that comment what they saw.** "Not in this repo" is not "never leaked", and
given finding #1 the instinct behind the note was clearly sound.

If it did leak, `.env` holds three secrets and an exposure of the file is an exposure of all of
them:

| Variable | Why | Cost of rotating |
|---|---|---|
| `DATABASE_URL` | The credential itself | Update every environment, then restart — Prisma reads it at client construction |
| `JWT_SECRET` | Anyone holding it can mint a valid admin session token | **Signs every user out.** That is the point |
| `OTP_PEPPER` | Lets anyone with a DB dump brute-force the 6-digit OTP hashes | OTPs in flight stop working; users request a new code |

```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

One run per secret. Never reuse a value across environments.

---

## 3. How this was checked, so you can re-check

```bash
git log --all --oneline --diff-filter=A -- .env    # was .env ever added?
git log --all --oneline -S "aivencloud"            # the Aiven host, anywhere in history
git log --all --oneline -S "postgres://"           # any connection string
git branch -r --contains <commit>                  # is a commit on a remote?
```

And, going forward:

```bash
npm run check:secrets
```

Scans every git-tracked file for credential shapes — connection strings carrying a password,
long hex secrets, populated `SMTP_PASS`/`*_TOKEN`/`*_SECRET` assignments, AWS keys, private key
blocks. Placeholders in `.env.example` are allow-listed, and findings print redacted so the
output is safe in a CI log.

**It is what found #1.** Worth running before a push, and worth wiring into CI when there is one.

Note it reads the current tree, not history — it will not tell you what is already published.
`git log -S` does that.

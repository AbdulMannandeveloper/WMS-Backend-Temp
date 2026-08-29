# Secrets — outstanding rotation

## Rotate these before going near production

`.env` in this repo carries the note that **a production Aiven connection string was
committed to git history and its credentials were exposed**. Removing the line from `.env`
does not undo that: anyone with a clone of the repository can still read it out of an old
commit.

Three secrets shared that file and should all be treated as compromised:

| Variable | Why it needs rotating | Effect of rotating |
|---|---|---|
| `DATABASE_URL` | The exposed credential itself | Update every environment before restarting |
| `JWT_SECRET` | Anyone holding it can mint a valid admin session token | **Signs every user out.** That is the point |
| `OTP_PEPPER` | Lets an attacker with a DB dump brute-force the 6-digit OTP hashes | Invalidates OTPs in flight; users request a new code |

## Generating replacements

```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

Run it once per secret. Never reuse a value across environments.

## Rotating the database password

Do this in the Aiven console — reset the service user's password, then update
`DATABASE_URL` everywhere it is set (deployment environment, CI, any developer `.env`).
Restart the API afterwards; Prisma reads the URL at client construction.

## Why the history cannot simply be cleaned

Rewriting history with `git filter-repo` or BFG would remove the string from this
repository, but it does not reach clones, forks, or anything that mirrored it. Rotation is
the only reliable fix; history rewriting is optional tidying afterwards, and it breaks every
outstanding branch.

## Checking nothing new has leaked

```bash
git log -p --all -S "postgres://" -- .env .env.example
```

`.env` is gitignored (`.gitignore` covers `.env` and `.env.*`, with `.env.example` and
`.env.test.example` explicitly re-included), so the exposure is historical rather than
ongoing — but the credentials in that history are still live until rotated.

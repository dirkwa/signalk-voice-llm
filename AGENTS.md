# signalk-voice-llm

Signal K plugin that answers spoken boat questions with an LLM. It subscribes
to `voice.command`, builds a compact snapshot of live boat data, asks an
OpenAI-compatible chat endpoint, and speaks the reply back through
signalk-wyoming's `say()`.

```
voice.command (signalk-wyoming)  →  buildContext()  →  chat()  →  say()
```

## Architecture rules you must keep in mind

- **signalk-wyoming is a hard runtime dependency, declared only in
  `signalk.requires`.** It supplies both halves this plugin needs: the
  `voice.command` path and the `say()` function. There is deliberately no npm
  dependency and no `peerDependencies` entry — the handle arrives at runtime
  over PropertyValues, not through the module graph.
- **`say()` is acquired via PropertyValues, not imported.**
  `app.onPropertyValues("signalk-wyoming.api", …)` replays history
  newest-last; walk it backwards and take the first entry carrying a callable
  `say`. Never assume the handle exists at `start()` time — wyoming may not
  have loaded yet.
- **`stop()` deliberately does not clear `say`.** Signal K keeps the module
  loaded across a stop()/start() cycle, but PropertyValues does not reliably
  re-deliver history to the re-subscribing plugin. Dropping the handle would
  silently break voice replies after any config change until wyoming itself
  restarts. The facade is stable across wyoming restarts and rejects cleanly
  if wyoming is stopped, so holding a stale handle is safe. This is
  counter-intuitive on purpose — do not "fix" it.
- **Never crash signalk-server.** Every failure path (LLM unreachable, no
  `say()` handle, missing `subscriptionmanager`) calls `app.error(...)` or
  `app.setPluginError(...)` and returns. Never throw out of `start()` — a
  thrown plugin can take down the whole server.
- **Spread `SCHEMA_DEFAULTS` at `start()`.** Signal K does not seed JSON
  Schema defaults at runtime; `start()` receives the saved config verbatim,
  which is `{}` on first enable and may be partial after the schema gains a
  field. `SCHEMA_DEFAULTS` is the single source of truth and the schema's
  `default` values read from it, so the two cannot drift. The merge is one
  level deep on purpose — a plain spread would leave a newly-added `llm.*`
  field undefined for existing users. Never read `config.llm.*` off the raw
  argument.
- **Replies are spoken, not read.** The system prompt constrains the model to
  one or two short sentences, no markdown, no lists, no emoji. Any change that
  invites longer or formatted output is a regression — TTS reads punctuation
  and markup aloud.
- **Speech-to-text input is lossy.** The prompt tells the model its input came
  from STT and may be misheard, so it should interpret nautically ("debt" →
  "depth"). Keep that framing.
- **The LLM endpoint is plain HTTP.** This plugin spawns nothing and manages
  no container. It is not a signalk-container consumer — do not add one.

## Workflow Conventions

This repo is maintained by Dirk Wahrheit.

- Branch names use **hyphens**, never slashes.
- **Angular conventional commits** — see below. This applies to PR titles too,
  since PRs are squash-merged and the title becomes the commit subject.
- One logical change per commit and per PR.
- No `Co-Authored-By` lines and no AI-attribution of any kind, in commits, PR
  bodies, or code.
- Never commit directly to `main`. Every change goes through a PR.
- **Release bumps are their own PR** — see below.
- PR descriptions: no checkboxes. "Tested" lists what actually ran, not what
  was planned.

### Release PRs

A version bump is a `chore(release): X.Y.Z` PR containing **nothing but the
bump** — `package.json`, `package-lock.json`, and a changelog entry if one
exists. No fixes, no tooling, no "while I was in there" changes riding along.
Only cut one when explicitly asked.

Two reasons this matters concretely:

- The tag is the publish trigger. A release PR that also carries code means
  the published artifact contains changes that were never reviewed as a
  release, and `git show <tag>` stops being a straight answer to "what
  shipped?".
- `.coderabbit.yaml` skips review on titles starting `chore(release):`. Code
  hidden in a release PR is code that silently bypasses review.

If a fix and a release are both wanted, that is two PRs: the fix merges
first, then the bump. Rewriting a release commit to extract mixed-in changes
afterwards is strictly worse than splitting up front.

### Commit and PR titles

Angular conventional commits:

```
<type>(<scope>): <subject>
```

- **Subject** ≤ 50 chars, imperative mood ("add", not "adds" or "added"), no
  trailing period, lower-case after the colon.
- **Scope** is optional and names the area touched — `llm`, `context`,
  `schema`, `ci`, `release`, `deps`. Omit it rather than inventing a vague one.
- **Body** (after a blank line) explains _why_, wrapped at 72 chars. The diff
  already shows what changed; the body should say what the reader can't see —
  the failure it fixes, the constraint that forced the approach, what was
  verified.

Types used here:

| Type       | For                                                              |
| ---------- | ---------------------------------------------------------------- |
| `feat`     | A new capability                                                 |
| `fix`      | A bug fix                                                        |
| `docs`     | Documentation only, including this file                          |
| `refactor` | Behaviour-preserving restructuring                               |
| `test`     | Adding or correcting tests                                       |
| `build`    | Build config, TypeScript settings, packaging                     |
| `ci`       | Workflows and CI configuration                                   |
| `chore`    | Everything else — tooling, dependencies, `chore(release): X.Y.Z` |

Examples from this repo's history, rewritten to the convention:

```
fix(schema): spread defaults before reading config
ci: gate PRs on eslint and prettier
chore(release): 0.2.1
```

Breaking changes get a `!` before the colon (`feat(llm)!: …`) and a
`BREAKING CHANGE:` footer explaining the migration.

Note that commits predating this convention do not follow it; `.github/release.yml`
groups release notes by PR **label**, not by commit type, so the older
subjects don't break changelog generation.

### Pre-PR checklist

```bash
npm run format        # prettier --write, then eslint --fix
npm run build:all     # ci-lint, then tsc, then the test suite
npm pack --dry-run    # confirm the tarball contents
```

## Tests

`src/test/` holds an end-to-end suite (`npm test`, run via `node --test`
against the compiled output). It drives the **real** plugin module the way
Signal K does — factory, `start()`, a `voice.command` delta, the spoken reply
— against a stub LLM served over loopback HTTP. Nothing in the plugin's own
code path is mocked: `fetch` really goes over TCP, and the PropertyValues and
subscriptionmanager plumbing runs as written.

Two harness details are load-bearing:

- The stub server and its sockets are `unref()`d. A failing assertion aborts
  the test before its `close()` call, and an open listener would then hold
  Node's event loop open forever — turning a test failure into a CI hang,
  which is far worse to diagnose than a red X.
- `!dist/test` in the `files` allowlist keeps the compiled tests out of the
  published tarball. `files: ["dist"]` alone ships them.

New tests should assert against **observable behaviour** — what was spoken,
what reached the LLM — rather than internal state. Every regression this
plugin has shipped has a test named after it; keep that habit, and prefer
adding to the suite over adding a claim to a PR description.

`ci-lint` is wired into the plugin CI workflow as `format-check-command`, so
a formatting or lint failure blocks the PR. `.gitattributes` forces LF —
without it the Windows runner checks out CRLF and `prettier --check` reports
every line as changed.

## Releasing

Publishing is driven entirely by tags — never by hand.

1. Merge a release PR that bumps `version` in `package.json` (and the two
   entries in `package-lock.json`).
2. Push a matching `vX.Y.Z` tag to `main`.
3. `.github/workflows/publish.yml` creates the GitHub Release and runs
   `npm publish --provenance` using npm's OIDC trusted publisher — there is no
   `NPM_TOKEN` secret.

Constraints that have bitten this setup before:

- **npm ≥ 11 is required** for the OIDC token exchange. The workflow pins Node
  24 to get it; older Node ships npm 10.x, which silently skips the exchange
  and fails with a 404.
- **`repository.url` must match the GitHub repo** signing the attestation, or
  provenance fails with a 422.
- Tags matching `*-beta.*` / `*-rc.*` publish under the `beta` dist-tag.

## TypeScript

- CommonJS (`module.exports = function (app) {…}`) — this is the shape Signal K
  loads. Do not convert to ESM without changing how the server loads it.
- `strict` is on. Prefer `unknown` plus narrowing over `any`; the remaining
  `any` uses sit on Signal K's own delta/subscription types, which are
  untyped upstream.
- `files` in package.json is an allowlist. `dist/`, the icon, README, and
  LICENSE ship; `src/` and `tsconfig.json` do not.

## File layout

| Path             | Purpose                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `src/index.ts`   | Plugin entry. Config schema, PropertyValues acquisition of `say()`, `voice.command` subscription, reply orchestration.   |
| `src/llm.ts`     | OpenAI-compatible chat client. Timeout handling, no SDK dependency.                                                      |
| `src/context.ts` | Builds the boat-data snapshot handed to the model. One function per group (navigation, anchor, environment, electrical). |
| `app-icon.svg`   | App Store icon, referenced from `signalk.appIcon`.                                                                       |

## Companion plugins

- `signalk-wyoming` — **required**. Provides `voice.command` and `say()`.
  Declared in `signalk.requires`; see the coupling rules above.

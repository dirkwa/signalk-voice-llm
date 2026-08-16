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
- **Replies are spoken, not read.** The system prompt must keep output
  speakable: no markdown, no bullet lists, no headings, no emoji — TTS reads
  punctuation and markup aloud. Length is deliberately conversational (a
  sentence or two for simple questions, a short paragraph when warranted), not
  hard-capped; the assistant is a general companion, not boat-topics-only.
  A change that reintroduces markup/formatting is a regression; a change that
  lets it answer non-boat questions is intended.
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
- The `files` allowlist in package.json excludes the compiled tests. Allowing
  the whole build directory ships them to users, so re-check the pack dry-run
  after changing what the build emits.

New tests should assert against **observable behaviour** — what was spoken,
what reached the LLM — rather than internal state. Every regression this
plugin has shipped has a test named after it; keep that habit, and prefer
adding to the suite over adding a claim to a PR description.

`ci-lint` is wired into the plugin CI workflow as `format-check-command`, so
a formatting or lint failure blocks the PR. `.gitattributes` forces LF —
without it the Windows runner checks out CRLF and `prettier --check` reports
every line as changed.

## Licensing

From **0.5.0** this plugin is source-available, not open source: use and
modification are free, redistribution is not. `LICENSE.md` is authoritative.

- **0.4.0 and earlier were Apache-2.0 and stay that way, permanently.** Never
  rewrite history, retag old releases, or edit the license on an existing tag.
  Apache-2.0's patent grant (§3) and redistribution rights (§4) for those
  versions are irrevocable, and pretending otherwise weakens the current
  license rather than strengthening it.
- `LICENSE-APACHE-2.0-through-v0.4.0.txt` keeps that history discoverable in
  the tarball. Do not delete it.
- **Never propose returning to a permissive license** — that is a decision for
  the copyright holder alone.
- `package.json` uses `"license": "SEE LICENSE IN LICENSE.md"`. This is not an
  SPDX-listed license; inventing an identifier breaks tooling validation.
- `CONTRIBUTING.md` carries an inbound contribution grant. Without it, merged
  contributions would fragment ownership and remove the ability to make this
  kind of decision again.
- The license text derives from a plain-language template whose authors permit
  adaptation only if all mention of their project is removed. It has been. Do
  not add attribution to them back in.
- **Dependency licenses gate this.** A copyleft runtime dependency would
  override the whole arrangement. The production tree is currently MIT/ISC
  except `@osm_borders/maritime_10m`, which is ODbL — a share-alike _database_
  license. That is fine only because the dataset is never bundled into our
  tarball; it stays a separate npm package the user installs. If a future
  change vendors that data into `dist/`, the ODbL share-alike terms attach and
  this must be re-examined.

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
- `files` in package.json is an allowlist. `dist/`, the icon, README, and both
  license files ship; `src/` and `tsconfig.json` do not.
- **Every source file in this repo is TypeScript**, tooling config included.
  `eslint.config.ts` is loaded by ESLint through `jiti` (hence the devDep) and
  type-checked by `npm run lint:config`, which `ci-lint` runs — so a broken
  config fails the PR rather than being silently transpiled.
- **`tsconfig.tools.json` is separate on purpose, not duplication.** The main
  tsconfig sets `rootDir: "src"` so `dist/` mirrors `src/`, which makes a
  root-level file an error rather than something merely excluded. It also
  builds as CommonJS/node, and the flat-config packages `eslint.config.ts`
  imports only resolve their type entry points under `"bundler"` resolution.
  The tools config emits nothing — it is a pure check.

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

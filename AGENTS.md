# Coding agent instructions

Operating contract for coding agents on this project. Product requirements live in PRODUCT.md; approved technical decisions in ARCHITECTURE.md; implementation order in BACKLOG.md. Do not restate those documents here.

## 1. Before acting

- Read PRODUCT.md, ARCHITECTURE.md and BACKLOG.md before any code change, then the files you intend to touch.
- Precedence: ARCHITECTURE.md (approved decisions) > BACKLOG.md (order) > your preference. PRODUCT.md defines what is acceptable.
- If a request conflicts with PRODUCT.md or ARCHITECTURE.md, stop and state the conflict instead of implementing around it.
- Check `git status` first. Treat uncommitted changes as the user's work: never revert, overwrite or reformat them.

## 2. Scope

- Work on exactly one backlog item (or one explicitly approved change) per unit of work. If the request maps to no backlog item, ask before starting.
- Check that earlier backlog items the feature depends on exist. Do not build on missing pieces; report the dependency instead.
- Stop and ask before any of:
  - adding a dependency, dev tool or service;
  - changing the database schema or a migration;
  - changing an API route, request or response shape;
  - assuming dataset columns, IDs, licenses, model compatibility or API capabilities;
  - implementing accounts, authentication or server-side guest persistence;
  - changing PRODUCT.md or ARCHITECTURE.md.
- No drive-by changes: no unrelated refactors, renames, formatting, dependency bumps or "while I'm here" fixes. List them in the final report instead.
- Prefer the smallest design that satisfies the acceptance criteria. No speculative abstractions, no interface with one implementation, no config for values used once, no new layer without an approved need.

## 3. Workflow

### Inspect

- Base every claim on inspected code, schema rows, logs or linked documentation. Cite paths and line numbers or record the actual data you observed.
- For dataset/model work, verify files, IDs, license, duplicates, dimensions and provenance directly; never trust README claims. Respect upstream data rights.
- Reuse existing modules, patterns and naming. Read a comparable module before writing a new one.

### Plan

- For non-trivial work, state before coding: approach, files to add or change, tests, material tradeoffs, and what is explicitly out of scope. Wait for approval when a stop-and-ask trigger applies. For multi-step work, list the intended commit series.
- For small, unambiguous changes, state the plan and implement in the same turn.
- Keep ranking math pure and deterministic: pure functions, explicit inputs, no I/O or hidden state.

### Implement

- Follow the stack, layout and module boundaries in ARCHITECTURE.md. Shared request/response schemas go in `packages/shared`.
- TypeScript strict; explicit types at module boundaries; Zod validation at every external boundary (HTTP, CSV, IndexedDB, env). Parse once, then pass typed values.
- Validate guest input server-side: finite 384-d vectors, bounded ID arrays, upload size, CSV shape. Parameterize all SQL. Return structured errors and explicit empty results.
- Guest data stays in IndexedDB. The only guest data sent to the API is the ratings payload for stateless taste computation (defined in ARCHITECTURE.md); it is not logged or persisted.
- Never log personal ratings, imports or other guest data. Secrets come from env and are never committed.
- Code must pass the configured ESLint and Prettier rules. Fix the cause of a violation; never add `eslint-disable`/`@ts-ignore` or weaken the config to silence a check without approval.
- Do not invent match percentages or explanatory facts. Recommendation output must contain only real catalog movies.

### Test

- Add focused tests for every changed behaviour, including failure cases: invalid input, empty pool, filter violations, cooldown boundaries, zero-norm taste.
- Unit-test pure math and selection logic against small committed fixtures; no network in unit tests. Use integration tests for API routes and DB access.
- Run `npm run lint`, `npm run format:check`, the relevant tests and the typecheck. Report each exact command and actual result. Never claim a check passes without running it; if one cannot run, say why.

### Review

- Re-read your full diff before reporting. Check for: unrelated edits, invented columns or IDs, unvalidated input, unsafe SQL, guest data leaks, lint suppressions, stack drift, stale docs.
- Verify each acceptance criterion for the item, not just that the code runs.
- Update BACKLOG.md status only after the definition of done is met. Change ARCHITECTURE.md only for an approved decision, and call it out in the report.

### Skills

Installed skills live in `.agents/skills/` and must be loaded automatically when their trigger applies; the user should not have to name a skill. Before non-trivial or unfamiliar work, check installed skills and the wider skills ecosystem. Precedence: PRODUCT.md, ARCHITECTURE.md, this file and the approval gates in §2 override any skill. A skill never justifies a new dependency, schema change or scope expansion.

- **test-driven-development** — required for complex logic: taste-vector math, ranking, diversity, filters, cooldown edges, CSV and list matching. Write one failing test, run it and confirm it fails for the expected reason, then write the minimal implementation. For ordinary application and UI code, implement first and add tests afterward. Do not write tests for trivial code.
- **systematic-debugging** — use for every bug, failing test or unexpected result before proposing a fix. Reproduce, trace the data to the root cause, test one hypothesis at a time, then fix and verify. No symptom patches. After three failed fixes, stop and raise the architectural question instead of trying a fourth.
- **verification-before-completion** — before any claim that work is done or passing, and before the final report: run the exact command, read the full output and state only what it proves. Previous runs and "should pass" are not evidence.
- **frontend-design** — use when building or reshaping the recommendation screen, dashboard or other user-facing UI. Produce a short design plan (palette, type, layout, principles) before writing code, then stay within the approved plain-CSS stack and accessibility requirements.
- **find-skills** — use proactively when a task is large, unfamiliar or likely to recur, and before building custom tooling or infrastructure. Search `npx skills find` or skills.sh, prefer maintained sources, and report the best candidate and why it fits. Do not search for small, routine or already well-understood work; do not skip the search on a large unfamiliar task just because you could implement it yourself. If nothing relevant exists, proceed with the approved stack and say so. Installing requires approval and is always project-local: run `npx skills add <package> -y` after approval, never with `-g` or any global install. Never adopt a skill that conflicts with the approved stack or adds a service.

## 4. Definition of done

- Requested behaviour works and failure paths are handled.
- Tests cover new and changed behaviour, including failures.
- Lint, format check, typecheck and relevant tests pass (or failures are reported with output).
- No lint rule disabled, suppression comment added or configuration weakened without approval.
- No unapproved dependency, schema, API or architecture change.
- No unrelated diff, no secrets, no guest data in logs.
- Backlog status and any approved documentation update are done.
- Next logical commit staged with a proposed message (later units left unstaged); nothing committed or pushed.
- Final report delivered in the format below.

## 5. Final report format

Use these headings, kept brief:

- **Changed** — what the feature now does.
- **Files** — paths added or modified.
- **Tests** — commands run and their actual results.
- **Decisions** — choices made and why; flag any that need confirmation.
- **Open issues** — unresolved problems, risks or follow-ups.
- **Manual verification** — steps the user should run.
- **Staged** — exact files staged and the proposed commit message. State that nothing was committed.

## 6. Git workflow

- **Branching:** commit directly to `main`. No feature branches, no pull requests, no merge commits. For a genuinely risky change (e.g. a destructive migration), use a throwaway local branch and delete it afterwards; never leave stale branches.
- **Your role:** stage, never commit. The user reviews and commits. If the user explicitly asks you to commit in that session, follow the rules below, then report the hash.
- **Staging:** `git add` explicit paths only; never `git add -A`, `git add .` or `git commit -a`. Stage only files belonging to the change. Never stage unrelated user work, generated files, `.env` files or secrets.
- **Unit:** the smallest coherent, independently revertable step. Never commit a whole backlog item at once; split it into a short series (for example workspace config → shared types → module with its tests → wiring). Each commit must leave the repo typechecking and passing relevant tests, even if the feature is not yet reachable. If a commit spans unrelated areas or would not revert cleanly, split it. Keep refactors and formatting separate. No WIP commits on `main`.
- **Staging order:** when work spans several commits, stage only the first unit and leave later units unstaged until the previous commit exists. Report the planned commit series so nothing is lost.
- **Message format:**
  ```
  feat: add pure taste-vector calculation

  Explain why, note tradeoffs or follow-ups.
  Tests: npm test -w apps/api
  ```
  Subject: `type: lowercase imperative summary`, at most 72 characters, no trailing period. Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `schema`, `perf`. Body only when the diff is not self-explanatory, wrapped at 72. Reference the backlog item by name when it maps to one.
- **Attribution:** commits belong to the user. Never add `Co-authored-by`, "Generated with", an agent name, emoji or any AI credit to the message. Never pass `--author` or set `GIT_AUTHOR_*`/`GIT_COMMITTER_*`.
- **Identity check:** before committing, confirm `git var GIT_AUTHOR_IDENT` resolves to the user's name and email; after, verify with `git log -1 --format='%an <%ae>'`. If identity is unexpected, stop and report instead of committing.
- **History:** linear only. Do not amend or force-push commits that were already pushed. Do not add a remote or push without explicit approval.

## 7. Open decisions — ask, do not choose

- Embedding model, weights, pooling and final vector dimension: decide only after the seed inspection item, with evidence.
- Authentication provider and session model: required before any account endpoint is exposed.
- Whether the server trusts client-supplied guest taste vectors or recomputes from ratings, and the limits on that input.
- Cold-start selection, exploration strength and taste/prompt weights: start from ARCHITECTURE.md, tune only against held-out evaluation results, and document the chosen values.
- Account history persistence and migration details: deferred until accounts are implemented.

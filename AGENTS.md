# Coding agent instructions

Read PRODUCT.md and ARCHITECTURE.md before making changes. BACKLOG.md is the implementation order, not a rigid process.

- Work on one requested feature at a time. Explain the proposed approach and any material tradeoff before implementing ambiguous decisions.
- Use the agreed TypeScript stack. Do not introduce frameworks, paid services, infrastructure or dependencies without justification and approval.
- Prefer small, readable modules, explicit types, Zod at boundaries and pure functions for recommendation math. Avoid speculative abstractions.
- Never invent dataset columns, identifiers, model compatibility or API capabilities. Inspect actual data and documentation first. Respect upstream data rights.
- Keep guest data local by default; never log personal ratings or imports unnecessarily. Validate input, parameterize queries and keep secrets out of git.
- Add focused tests for changed behavior, including failure cases. Run relevant tests/typechecks and report actual results, not assumed success.
- Do not change unrelated code. Do not silently expand scope. Update docs if an approved architectural decision changes.
- Provide a concise summary of changes, files, tests, unresolved issues and any manual verification steps. Do not commit or push unless requested.

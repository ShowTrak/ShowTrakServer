# ShowTrak Workspace Implementation Brief (Opinionated)

Use this brief for all feature work in this workspace. Prioritize predictable architecture, reuse over rewrite, and consistent delivery standards across ShowTrak Server, ShowTrak Client, and shared Scripts.

## 1) Project Summary and Reuse-First Direction

ShowTrak is a multi-app Electron platform:

- ShowTrakServer: control plane, persistence, orchestration, desktop UI, Web UI, IPC bridge, Socket.IO server, rule engine, script execution, alert actions.
- ShowTrakClient: endpoint agent, telemetry and heartbeat, adoption lifecycle, process/USB/network monitoring, local runtime automation.
- Scripts: OS-specific script catalog and metadata for remote execution workflows.

Primary architecture model:

- Server is authoritative for orchestration and persisted state.
- Client is authoritative for machine-local runtime signals.
- Script catalog is data-driven and should remain declarative and portable.

Reuse-first rule (mandatory):

1. Before creating new modules, search existing modules for extension points.
2. Prefer extending registries, managers, validators, and transport adapters.
3. Keep protocol and payload shapes compatible with existing Socket.IO and IPC patterns.
4. Avoid introducing parallel abstractions when a current manager can be extended.

## 2) Non-Negotiable Engineering Standards

1. Pattern consistency:
- Follow existing module boundaries and naming conventions.
- Use manager-centric orchestration (Manager APIs), not ad-hoc cross-module calls.
- Keep renderer logic out of main process and vice versa.

2. Validation and contracts:
- All new IPC routes must include validator wiring.
- All new invoke channels must be allowlisted where channel allowlists are enforced.
- Maintain strict payload shape parity between sender and receiver.

3. State handling:
- Persist only durable state to DB.
- Keep high-churn telemetry/runtime state in memory.
- Preserve existing online/degraded/offline transition semantics.

4. Error handling:
- Fail soft for optional integrations.
- Use existing logging conventions and avoid noisy duplicate logs.
- Do not hide critical failures that affect operator actions.

5. Test discipline:
- Add or update tests for every feature.
- Prefer targeted tests for touched modules first, then broader suites.
- Keep behavior-focused assertions; avoid brittle implementation-coupled assertions.

## 3) Required Feature Implementation Workflow

For every new feature, execute this exact sequence:

1. Discover reuse opportunities
- Identify existing modules/managers/registries to extend.
- Document the chosen extension path in the task notes.

2. Define scope boundaries
- Identify whether change belongs to Server, Client, Scripts, or cross-repo.
- Explicitly list protocol/data contract impacts.

3. Implement minimal cohesive changes
- Extend existing APIs first.
- Keep changes small and composable.
- Avoid broad refactors unless required for correctness.

4. Wire full path end-to-end
- Main/process <-> bridge <-> renderer paths for app UI changes.
- Namespace/server/client routes for network changes.
- Validator and allowlist updates for all new channels.

5. Test and verify
- Run lint and targeted tests for changed surfaces.
- Add regression tests for bug fixes and new behavior.

6. Version bump (mandatory on completed features)
- Whenever a feature is completed, increment version in affected package.json file(s).
- Use semantic versioning and no git tag creation:
  - New feature: bump minor (`npm version minor --no-git-tag-version`).
  - Fix-only follow-up without a new feature: bump patch.
- If a feature spans both Server and Client, bump both package versions in the same change set.

7. Final delivery checklist
- Confirm tests/lint relevant to the feature.
- Confirm version bumps are included.
- Confirm docs/instruction touchpoints are updated if behavior changed.

## 4) Cross-Codebase Reuse Playbook

When adding capability, prefer these in order:

1. Registry extension
- Alert trigger/action registries
- Validation registries
- Method/action maps

2. Manager extension
- ClientManager, GroupManager, AlertsManager, ScriptManager, related lifecycle managers

3. Transport extension
- Existing Socket.IO namespaces
- Existing IPC channels and bridge exposure

4. UI composition
- Extend existing state stores and render/update flows before creating new UI subsystems

5. New module creation (last resort)
- Only when no existing manager/registry can own the concern cleanly

## 5) Commit and Changelog Prefix Standard

At the end of every completed task, always ask the user:

"Would you like me to commit these changes now?"

Then provide commit options and a proposed commit message.

Commit message standard (Conventional Commits):

- `feat(scope): summary` for new features (default for feature delivery)
- `fix(scope): summary` for bug fixes
- `refactor(scope): summary` for internal restructuring without behavior change
- `perf(scope): summary` for performance improvements
- `docs(scope): summary` for documentation-only updates
- `test(scope): summary` for tests-only changes
- `chore(scope): summary` for maintenance tasks
- `ci(scope): summary` for CI updates
- `build(scope): summary` for build/release tooling changes

Scope examples:

- `server`, `client`, `scripts`, `ipc`, `alerts`, `ui`, `db`, `network`, `monitoring`

If feature spans repos, prefer separate commits per repo with aligned prefix and summary.

## 6) Guardrails

- Do not introduce duplicate business logic across Server and Client.
- Do not bypass validators or invoke allowlists.
- Do not skip version bump when a feature is complete.
- Do not end a completed task without asking whether to commit.

# omo-herdr-todo

Native Todo, workflow DAG and ordinary workers remain visible together in three fixed Herdr panes. Todo reads the selected stock Senpi branch; the dashboard never creates a second checklist store.

## Everyday controls

The unified `omo-herdr-dashboard` extension loads both runtime components in an eligible parent session. Todo sits above ordinary workers in the left dashboard column; DAG uses the full right dashboard column. The conversation keeps 40% of the terminal width. Child sessions cannot own the layout.

Each role starts with automatic follow. Press `f` in one pane to toggle its follow. Scrolling/selecting manually pauses only that pane; `f` resumes it. `c` controls completed work for that role. Completed ordinary workers and closed Todo phases fold automatically; active/error descendants and manual expansions remain accessible. DAG topology stays canonical. Fixed DAG/workers panes ignore `t`.

Press `q` to close one role. Source updates respect that closure. `/dashboard` is the single command to open or explicitly reopen all three roles. Surviving role identities and verified input selection remain intact. Losing current ready coverage restores the actual native inline widget factory.

Read errors, valid empty state and disconnected last-known state have distinct labels. A disconnected cache is not live progress. Cost is producer-reported or unknown; zero is shown only when reported. Speed uses generation time, not wall time. These figures are not an invoice.

## Local verification

Node24 or later and an already running Herdr session are required. SDK version and file hashes must match `config/native-source-manifest.json`; there is no ambient SDK fallback or provider/model request.

Run verification and build commands from the source checkout. The extracted runtime archive omits development scripts/tests and installs through `node bin/omo-herdr-todo.mjs install --agent-dir <disposable-agent-directory>`.

```bash
npm test
npm run build
npm run test:package
npm run test:host -- --senpi-root <installed-senpi-sdk>
npm run qa:live -- --senpi-root <installed-senpi-sdk> --dag-root <dag-source-checkout> --evidence <private-evidence-directory>
```

`test:pty` aliases that same actual native/Herdr scenario with the same arguments. QA creates isolated HOME/agent/cache and an unfocused owned tab, installs candidates there, checks real processes/painted ACKs, records visible ANSI frames, and removes its own resources.

Optional arguments: `--herdr-bin` selects the existing CLI; `--session` defaults to `piomo`; `--todo-package` and `--dag-package` select local archives instead of packing source; `--static-agent-dir` adds a read-only comparison of declared installation anchors.

The host uses real stock ResourceLoader, SessionManager, registered tool/command callbacks and InteractiveMode factories through a bounded component facade, without running the user's conversation or full parent chat TUI. QA DAG/worker records are synthetic protocol-consumer fixtures; Todo uses real native mutations. ANSI replay images are terminal snapshots, not desktop screenshots.

See [installation](docs/INSTALL.md), [protocol](docs/PROTOCOL.md), and [roadmap](docs/ROADMAP.md). The current source history is available on the [`feat/concurrent-dashboard` branch](https://github.com/grim-susemi/omo-herdr-todo/tree/feat/concurrent-dashboard), with the matching [DAG companion source](https://github.com/grim-susemi/omo-herdr-dag/tree/feat/concurrent-views-and-metrics). These are source checkouts, not a new npm release.

## Restart recovery and activation

`install --dry-run --agent-dir <dir>` writes nothing and touches no panes. A real install first validates the existing generation, wrapper and locale (unmanaged, malformed or interrupted state is rejected before promotion), then promotes an immutable generation that includes the parent-slot runtime; prior generations stay as backups. Normal recovery re-claims the parent slot on the next session; after a fatal exit the dashboard shows a visible BLOCKED state instead of silently relaunching. `q` closes one role only; `/dashboard` reopens all three. Installing files never activates a session: start a new session or run `/reload` as a separate, explicit step.

## Privacy and provenance

Runtime packages include compiled runtime, CLI, README, MIT license and third-party notices. They exclude tests, private evidence, session/task logs, auth/config profiles and copied SDK files. Public-source preflight is separate from the runtime scan. Hostile examples in safety tests are synthetic rejection fixtures.

The SDK is imported read-only and is not redistributed. Reuse origins are recorded in `THIRD-PARTY-NOTICES.md`.

From a clean source checkout, `npm run record:preflight` prints reviewed files/hashes, local heads, target repositories/branches and exclusions without external writes. If the named companion checkout is unavailable, pass `-- --dag-root <dag-source-checkout>`. See the [sanitized plan](docs/plans/omo-herdr-todo.md) and [verified history](docs/HISTORY.md). Running the preflight never grants upload permission or activates an installed harness.

## 한국어 요약

- DAG·작업자·Todo를 동시에 봅니다. 각 화면의 `f` 추적과 수동 탐색은 독립적입니다.
- `c`로 완료 항목을 펼치고 `q`로 해당 화면만 닫습니다. `/dashboard` 하나로 세 화면을 다시 엽니다.
- 재시작 복구: 정상 종료는 다음 세션에서 슬롯을 다시 확보하고, 치명적 종료는 BLOCKED로 표시됩니다. `--dry-run`은 아무것도 쓰지 않습니다.
- 설치 파일 복사와 세션 활성화는 다릅니다. 보고된 비용과 연결이 끊긴 화면을 실제 청구·최신 진행으로 혼동하지 마세요.
- 최신 소스 이력은 위 두 GitHub 브랜치에 있습니다. npm 정식 배포와 실사용 설치는 별도입니다.

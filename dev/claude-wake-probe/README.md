# Claude desktop wake probe (run 27 September 2026)

Disposable scripts that demonstrated hook-triggered wake in `docs/claude-event-delivery.md` inside the Claude desktop app (bundled Claude Code 2.1.280). The room listener remained running during the first idle probe; repeating it with an empty background-task list remains the final listener-free acceptance check. With Illiana's explicit OK, one temporary `.claude/settings.local.json` was added to the chat's project folder and removed afterwards. The hook scripts react only to the target chat's own signal file; every other chat and file exits 0. Evidence: `docs/claude-wake-probe-2026-09-27.jsonl` (paths and session redacted).

- `wake-literal.mjs`: FileChanged with a literal matcher, `asyncRewake: true`, exit 2 for the target chat's non-empty signal.
- `register-cwd.mjs`: CwdChanged registering an absolute signal path through `hookSpecificOutput.watchPaths`, as a SessionStart hook would.
- `register.mjs` and `wake.mjs`: the SessionStart plus matcher-less FileChanged pair for a fresh chat. Prepared but not needed, since the running chat proved the same wake path.

Setting shapes used (placeholders for local paths):

```json
{ "hooks": {
  "CwdChanged": [ { "hooks": [ { "type": "command", "command": "node <kit>/register-cwd.mjs <signals-dir> <log>", "timeout": 10 } ] } ],
  "FileChanged": [ { "hooks": [ { "type": "command", "command": "node <kit>/wake.mjs <signals-dir> <log>", "asyncRewake": true, "timeout": 10 } ] } ]
} }
```

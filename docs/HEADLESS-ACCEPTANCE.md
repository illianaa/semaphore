# Historical headless acceptance — 2026-09-22

This records the earlier prototype. For the current desktop app and inbox delivery, see [release acceptance](ACCEPTANCE.md).

The implementation was exercised against real GPT Astra and Claude responses using existing local authentication. No mock responses were used for these exchanges.

## Results

1. Started room `first-light` with `test/first-exchange.txt` and a two-turn limit. The initial attempt failed before an Astra response because the standalone Codex 0.152.1 runtime was too old for `gpt-6-astra`. The room stopped with the delivery journal intact.
2. Inspected the failed native Codex turn, selected the installed desktop app's bundled 0.154.0-alpha.6.2 runtime, explicitly acknowledged the failed attempt, and passed the stick again. The same native thread was retained. Astra proposed highlighting the current speaker and nominated Claude Fable 5. Claude responded to that proposal and returned the stick to the human.
3. Started a separate Semaphore process using `test/resume-exchange.txt`. Astra and Claude both recalled `copper lantern`, discussed the earlier proposal, and completed the same handoff order. Both native session IDs were unchanged. Astra also received Claude's reply that had arrived while Astra was idle.
4. Read Astra's completed native turns using the Codex desktop tools. The task appeared in the app's task listing, and the app's navigation tool confirmed opening it. Direct visual inspection of the Codex UI was unavailable because Computer Use disallows controlling that app; no screenshot-based UI verification is claimed.
5. Reopened Claude interactively using its exact session ID. It loaded both earlier exchanges under Fable 5. Exited without making another model request.
6. Claude's schema mode put the substantive answer in a structured tool event while the interactive transcript showed a summary. Changed the Claude adapter to request JSON in the normal assistant reply, then verified an additional response in the same persistent session. The complete reply recalled the shared marker and the accessible text-label suggestion, and appeared in the native terminal transcript when reopened.

Claude Code auto-updated during this work from 2.1.186 to 2.1.280. The final extra turn reported `claude-fable-5-1` after the earlier turns reported `claude-fable-5`, because the initial implementation used the `fable` alias. The final adapter now retains the resolved model ID for continuation and native resume commands; new rooms explicitly request `claude-fable-5`. No global update command was run by Semaphore.

## Local records

Native conversation IDs and transcripts remain in the private local room store. They are not part of the source repository.

## Limits of this verification

The automatic tests cover routing, unseen-message delivery, persistence, overlapping calls, late results after interruption, malformed nominations, crash recovery, room locks, automatic turn limits, and provider errors. This is a local prototype, not a production reliability certification.

Native-app access is verified for the Codex desktop task and Claude Code's terminal. The separate Claude desktop Code history is not integrated. Simultaneous editing from native clients, native-to-shared message import, live word streaming, and a dedicated graphical interface are outside this first milestone.

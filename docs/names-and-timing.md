# Room names and delivery timing

These features ship with Batch 5. Development uses the `semaphore-field` CLI until the reviewed cutover.

## Names

New rooms created from an opening use its first nonblank line. Long lines end at a word boundary with an ellipsis, up to 80 graphemes; a single long word is cut at an intact grapheme. The opening is saved and dispatched without waiting for a naming call.

Explicit names from `new` or the app are marked `titleSource: "human"`. Automatic opening excerpts have `titleSource: "opening"`. Old rooms without provenance keep their names: the code does not guess whether they were chosen by the person.

While holding and having received the first AI turn, its bound participant may call:

```sh
semaphore title <room> --root <absolute-root> --turn <turn-id> "A concise name"
```

This works once, only for the opening's first speaker and before any AI reply, and only while the title is still an opening excerpt. It records the speaker and turn. An identical retry is harmless. It cannot replace a human name, rename a legacy room, or keep changing a suggested name. The full first-turn envelope includes the optional command; naming never requires an extra turn.

The person can rename a room through `POST /api/rooms/<room>/title` with `{title}` and the normal control authentication/origin checks. The response is `{room}`. A local terminal can use `semaphore title <room> "..."` without `--turn`; a native AI chat cannot impersonate that terminal path. Names normalize whitespace and allow 1–100 graphemes, including Unicode. The server is authoritative about length. Room detail and summaries expose `titleSource` (`human`, `opening`, `astra`, `claude`, or `existing`).

Human renaming preserves the stick, pending turn, messages and reply budget, including while this app server is delivering a turn. Another process's room lock is respected; busy lock errors are retryable rather than silently overwriting it. A user rename also protects the title against a later AI suggestion, even if its text was unchanged.

## Timing stages

`semaphore timings <room> --root <absolute-root>` and authenticated `GET /api/rooms/<room>/timings` return a read-only report: `{room, measuredAt, note, groups, samples}`. Room detail/summary also expose the pending turn's `pending.timing`; the existing progress label remains **queued** until authenticated receive.

| Field | Evidence |
|---|---|
| `startedAt` | Semaphore saved the pending delivery intent |
| `queuedAt` | Timestamp on the transport's successful queue receipt; inbox transport timestamps the immutable entry just before writing it |
| `listenerObservedAt` | The bound CLI listener first found this still-open turn in its inbox |
| `nativeQueuedAt` | Automatic wake saved its native queue receipt |
| `hostStartedObservedAt` | Automatic wake discovered a native turn containing this wake notice; an upper bound, not the host's actual start time |
| `hostDeliveredAt` | Currently null: no exact host-delivery timestamp is established by these adapters |
| `acknowledgedAt` | The bound native chat explicitly ran `receive`; repeated receipts preserve the first timestamp |
| `repliedAt` | The accepted reply was committed |
| `failedAt`, `failureCode` | A delivery exception was recorded, including an interrupted delivery |

An observation does not set `receivedAt`, mark human messages read, move the seen cursor, consume a reply, remove inbox mail or wake another model. The CLI checks its native binding and pending ownership before recording it. An exclusive, private `inbox/<speaker>/observed/<turn>.json` records the first observation without acquiring the sender's room lock. Readback matches room, turn, speaker and native session. Missing, incomplete or foreign observations stay unknown. Failure to record optional instrumentation never prevents delivery.

The core saves `turn-timing` events at queueing, acknowledgment, reply, pause, recovery and delivery failure; the report collapses them by turn ID and overlays the current pending turn. Repeated replies and receipts do not create another sample. Historical queue and receive events plus reply timestamps remain useful, but are labeled `legacy`: absent observation data and failure counts are unknown. No historical timestamps are invented or written back.

Reports group by speaker, transport, observed route and instrumentation version. Routes distinguish inbox without observation, listener, automatic wake, both automatic wake and a listener, manual queue and headless work. Each phase has its own sample count, missing count, reversed-clock count and min/p50/p95/max milliseconds (nearest-rank percentiles). Missing timestamps are not zero. Reversed wall-clock intervals are excluded and counted. Failure counts cover recorded delivery exceptions, not unseen host failures; `outcomes` also counts unresolved, paused and recovered turns.

These are local wall-clock observations. They do not isolate host scheduling, busy time, approvals, model work or tool use, and they are not a transport benchmark. No latency optimization or automatic acknowledgment was introduced.

## Validation and baseline

The isolated checks run the real CLI through send → listen → repeated listen → receive → reply, and verify that read state changes only on receive and all first timestamps survive reopening. Other cases cover foreign observations, failures/recovery without redispatch, missing and reversed clocks, legacy data, title ownership and retries, Unicode, and a human rename while delivery is active. Fake native identities stay in throwaway roots and never contact real apps.

A read-only baseline from this existing development conversation on 24 September 2026 at 21:04 UTC found the following completed legacy turns:

| Speaker / transport | Samples | Queue-to-ack p50 | p95 | Range |
|---|---:|---:|---:|---:|
| Claude / claude-inbox | 20 | 21.664 s | 67.258 s | 6.346–69.712 s |
| Astra / astra-inbox | 18 | 9.305 s | 50.216 s | 5.142–50.216 s |

These runs mixed active work, host states and earlier releases; listener-versus-wake routing was not historically instrumented. They are not comparable controlled benchmarks, do not establish a cause, and do not justify optimizing one host. The current uncompleted turn is excluded from this table. After cutover, normal handoffs will accumulate separated stages without generating extra AI turns.

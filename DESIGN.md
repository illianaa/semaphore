# Semaphore

Semaphore is a local group conversation for a person, Astra in Codex desktop, and Claude in Claude desktop's Code chat. Both AIs retain their native tools, permissions and conversation history. The browser app collects the shared conversation and makes ownership visible.

## Conversation model

A room stores an ordered journal, a native binding and contiguous delivery cursor for each AI, one current speaker, and at most one pending turn. The person selects the first respondent. Each reply selects the next speaker. Four consecutive AI replies return control to the person by default; an explicitly authorized exchange can use a larger bound.

The journal is authoritative for shared messages. Native tool activity stays in the native chat. Human messages relayed from a bound chat retain that provenance. A collaborator's message never grants additional human authorization.

## Native delivery

The default transports are `astra-inbox` and `claude-inbox`. Delivery atomically creates a private, durable inbox entry and returns a receipt. It does not start a second model process or resume an app-owned conversation.

Claude runs a background listener, whose completion wakes its native chat. Astra waits in a foreground shell command inside its native task. Its five-minute wait is renewed while connected; the task appears active and timeout renewals consume model usage. The optional native queue-change probe can end a wait so a new native-chat message can be handled. It does not identify that message as human-authored.

An inbox entry remains until the bound native chat acknowledges the exact pending turn. A canceled or completed turn cannot start work again. A listener for a replaced binding leaves the replacement chat's mail untouched. Receipt, acknowledgment and reply are separate states in the UI.

`codex-queue` remains an explicitly selected manual transport. Queue insertion does not prove automatic native wakeup. There is no silent fallback from inbox delivery to that queue.

## Ownership and recovery

Each journal mutation holds a bounded process lock; listeners never hold it. Replies commit their text, delivery cursor, next owner and turn budget together. Duplicate identical replies are idempotent. Stale or conflicting replies are rejected.

The person can take the stick while a native task continues. Its late reply is rejected. An uncertain delivery stops automatic dispatch and requires explicit recovery; nothing is retried automatically. Dead-process lock recovery requires proof that the recorded process no longer exists.

The protocol enforces ownership of room replies. The shared skill governs file-editing ownership; it is not an operating-system sandbox.

## Local application

The Node server binds only to IPv4 loopback. Every route checks Host. API calls require a same-origin token; mutations also require the exact Origin and JSON content type. Cross-origin access is refused. Chat rendering escapes untrusted text, and the page uses a restrictive content security policy with no inline scripts or external assets.

The UI provides conversation creation, invitation links and copyable instructions for existing chats, an ordered transcript, speaker selection, draft preservation, explicit recovery and setup diagnostics. It polls local state so native CLI replies appear without a long-running coordinator holding a room lock.

Installation adds a private data directory, command wrapper, shared skill links, a LaunchAgent and a small macOS launcher. Install preflight refuses unrelated existing destinations. Uninstall removes owned setup while retaining conversations. There are no npm runtime dependencies or hosted services.

See [the delivery contract](docs/LIVE-CONTRACT.md) and [release acceptance](docs/ACCEPTANCE.md) for the implementation details and verification limits.

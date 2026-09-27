// Keep a lost-response retry identical across the upgrade that added maxTurns.
// Older requests omitted the field; sending an explicit 4 with their ID would
// conflict, while assigning a new ID could create a duplicate conversation.
export function prepareStartRequest({ text, to, members, maxTurns }, previous, newId = () => crypto.randomUUID()) {
  const base = { text, to, members };
  const fingerprint = JSON.stringify({ ...base, maxTurns });
  const validId = typeof previous?.clientId === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(previous.clientId);
  const legacy = validId && maxTurns === 4 && previous.fingerprint === JSON.stringify(base);
  const request = validId && (legacy || previous.fingerprint === fingerprint)
    ? previous : { fingerprint, clientId: newId() };
  return { request, body: { ...base, ...(legacy ? {} : { maxTurns }), clientId: request.clientId } };
}

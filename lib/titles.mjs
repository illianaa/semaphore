const graphemes = text => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map(item => item.segment);

export function titleText(value) {
  if (typeof value !== "string") throw new Error("Give the conversation a title of 1–100 characters.");
  const title = value.replace(/\s+/gu, " ").trim();
  if (!title || graphemes(title).length > 100)
    throw new Error("Give the conversation a title of 1–100 characters.");
  return title;
}

export function openingTitle(text) {
  const line = text.split(/\r?\n/).find(line => line.trim())?.replace(/\s+/gu, " ").trim() || "New conversation";
  const characters = graphemes(line);
  if (characters.length <= 80) return line;
  const prefix = characters.slice(0, 79).join("");
  // A single very long word still has a safe grapheme boundary.
  const boundary = prefix.lastIndexOf(" ");
  return (boundary > 0 ? prefix.slice(0, boundary) : prefix).trimEnd() + "…";
}

export function maySuggestTitle(room, speaker) {
  return room.titleSource === "opening" && room.opening?.to === speaker &&
    !room.messages.some(message => message.speaker !== "human");
}

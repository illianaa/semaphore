import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

export const projectDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const dataHome = path.resolve(
  process.env.SEMAPHORE_HOME || path.join(os.homedir(), ".semaphore"),
);
export const defaultRoomRoot = path.join(dataHome, "rooms");
export const shellQuote = (value) =>
  `'${String(value).replaceAll("'", "'\\''")}'`;

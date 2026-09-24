import { createRequire } from 'node:module';

// Suppress only Node's routine SQLite startup notice, synchronously while loading
// that built-in. Keep every other warning and restore the handler immediately.
let DatabaseSync;
export function sqliteDatabase() {
  if (DatabaseSync) return DatabaseSync;
  const emitWarning = process.emitWarning;
  process.emitWarning = (warning, ...rest) => {
    const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type;
    if (type === 'ExperimentalWarning' && warning === 'SQLite is an experimental feature and might change at any time') return;
    return emitWarning.call(process, warning, ...rest);
  };
  try { ({ DatabaseSync } = createRequire(import.meta.url)('node:sqlite')); }
  finally { process.emitWarning = emitWarning; }
  return DatabaseSync;
}

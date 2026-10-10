const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ID_PATTERN = new RegExp(`^${UUID}$`, "i");

/** Local desktop sessions are UUIDs; other namespaces (e.g. `native-pi:`) are not advertised. */
export function normalizeSessionId(value) {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return ID_PATTERN.test(id) ? id.toLowerCase() : null;
}

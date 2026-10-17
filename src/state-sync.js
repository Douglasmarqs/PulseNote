// Three-way merge of local edits with newer Firestore data. Keeping this
// separate from the UI lets us test app ↔ WhatsApp/Autopilot concurrency.
const COLLECTION_KEYS = new Set([
  "finances", "tasks", "events", "goals", "notes", "customCategories",
  "monthClosures", "finGoals", "finRecurrents",
]);

export function cloneState(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function equal(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function itemKey(item) {
  if (item && typeof item === "object") {
    if (item.id != null) return `id:${item.id}`;
    if (item.monthKey != null) return `month:${item.monthKey}`;
    if (item.categoryId != null) return `category:${item.categoryId}`;
  }
  return `value:${JSON.stringify(item)}`;
}

export function changedStateKeys(before, after, ignored = []) {
  const excluded = new Set(ignored);
  return [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])]
    .filter((key) => !excluded.has(key) && !equal(before?.[key], after?.[key]));
}

export function mergeCollection(base, local, remote) {
  if (!Array.isArray(base) || !Array.isArray(local) || !Array.isArray(remote)) return cloneState(local);
  const original = new Map(base.map((item) => [itemKey(item), item]));
  const wanted = new Map(local.map((item) => [itemKey(item), item]));
  const changed = new Map();
  const deleted = new Set();
  for (const [key, item] of original) {
    if (!wanted.has(key)) deleted.add(key);
    else if (!equal(item, wanted.get(key))) changed.set(key, wanted.get(key));
  }
  for (const [key, item] of wanted) {
    if (!original.has(key)) changed.set(key, item);
  }

  const remoteKeys = new Set(remote.map(itemKey));
  const additions = local.filter((item) => {
    const key = itemKey(item);
    return changed.has(key) && !remoteKeys.has(key);
  });
  const retained = remote
    .filter((item) => !deleted.has(itemKey(item)))
    .map((item) => changed.get(itemKey(item)) || item);
  return cloneState([...additions, ...retained]);
}

export function mergeDirtyState(remote, local, dirtyBases) {
  const result = cloneState(remote || {});
  for (const [key, base] of Object.entries(dirtyBases || {})) {
    result[key] = COLLECTION_KEYS.has(key)
      ? mergeCollection(base, local?.[key], remote?.[key])
      : cloneState(local?.[key]);
  }
  return result;
}

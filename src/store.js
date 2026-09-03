/**
 * Local persistence.
 *
 * These apps are worth using twice, which means the data has to survive a
 * refresh - and the only place it can survive is this machine. There is no
 * account, no sync, and no export endpoint, so `localStorage` is not a
 * compromise here, it is the whole storage layer.
 *
 * Every read is defensive. Storage throws outright in private windows and in
 * browsers configured to block site data, and a journal that white-screens
 * because a preference could not be read is worse than one that forgets.
 */

const PREFIX = "agent-suite:";

export function read(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function write(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    // Quota exceeded, or storage denied. The caller keeps working in memory.
    return false;
  }
}

export function remove(key) {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    /* nothing to do */
  }
}

/**
 * A small append-only collection with a cap.
 *
 * The cap matters: the journal and the library both grow without a natural
 * limit, and `localStorage` is a few megabytes. Dropping the oldest entries is
 * the right failure - silently refusing to save the newest one is not.
 */
export function collection(name, { cap = 500 } = {}) {
  let items = read(name, []);

  const persist = () => write(name, items);

  return {
    all: () => items,
    count: () => items.length,
    add(item) {
      const entry = { id: crypto.randomUUID(), at: Date.now(), ...item };
      items = [entry, ...items].slice(0, cap);
      persist();
      return entry;
    },
    update(id, patch) {
      items = items.map((it) => (it.id === id ? { ...it, ...patch } : it));
      persist();
    },
    remove(id) {
      items = items.filter((it) => it.id !== id);
      persist();
    },
    replaceAll(next) {
      items = next.slice(0, cap);
      persist();
    },
    clear() {
      items = [];
      persist();
    },
  };
}

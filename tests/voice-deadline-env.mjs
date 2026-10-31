import { VoiceDeadline } from '../worker/voice-deadline.ts';

/** Durable storage survives constructing a new object, as after Worker eviction. */
export function deadlineState() {
  const values = new Map();
  const storage = {
    values, alarm: null,
    async get(key) { return structuredClone(values.get(key)); },
    async put(key, value) { values.set(key, structuredClone(value)); },
    async setAlarm(time) { storage.alarm = Number(time); },
    async deleteAlarm() { storage.alarm = null; },
    async transaction(callback) {
      const before = structuredClone(values), alarm = storage.alarm;
      try { return await callback(storage); }
      catch (error) { values.clear(); for (const pair of before) values.set(...pair); storage.alarm = alarm; throw error; }
    },
  };
  let serial = Promise.resolve();
  return { storage, blockConcurrencyWhile(callback) {
    const running = serial.then(callback); serial = running.catch(() => {}); return running;
  } };
}
export function deadlineNamespace(bindings) {
  const entries = new Map();
  return {
    entries, idFromName: (name) => name,
    get(name) {
      if (!entries.has(name)) {
        const state = deadlineState();
        entries.set(name, { state, object: new VoiceDeadline(state, bindings) });
      }
      return { fetch: (url, init) => entries.get(name).object.fetch(new Request(url, init)) };
    },
    restart(name) { const entry = entries.get(name); entry.object = new VoiceDeadline(entry.state, bindings); return entry; },
  };
}

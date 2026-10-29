// The Plex server's owner's own sign-ins, as fingerprints: SHA-256 hashes of
// their tokens, never the tokens. Kept where the Plex server lets this
// container in without signing in, so the owner's devices carry on through
// /pms/ while plex.tv can't be reached to say whose a sign-in is (see
// pmsAuth in index.js). One is kept once plex.tv has said it's the owner's,
// for 30 days after it was last used, and goes as soon as plex.tv says it's
// no good, or isn't theirs. In the data folder (owners.json, the service's
// alone), so a restart meanwhile doesn't lose them; in memory only without
// one.
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const OWNER_LIMITS = {
  keepMs: 30 * 24 * 3600 * 1000,
  kept: 50, // the owner's devices and browsers, the most recently used
  writeDelayMs: 5000,
  touchMs: 6 * 3600 * 1000, // a use is written down at most this often (each, otherwise only in memory)
};

const FINGERPRINT = /^[0-9a-f]{64}$/;
const FILE_VERSION = 1;

export class OwnerSignIns {
  constructor({ dir = null, log = null, now = () => Date.now() } = {}) {
    this.file = dir ? join(dir, 'owners.json') : null;
    this.log = log;
    this.now = now;
    this.map = new Map(); // fingerprint -> last used (ms), oldest first
    this.saved = new Map(); // fingerprint -> last used, as written
    this.timer = null;
    this.load();
  }

  load() {
    if (!this.file || !existsSync(this.file)) return;
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8'));
      const list = data && data.version === FILE_VERSION && data.owners && typeof data.owners === 'object' ? Object.entries(data.owners) : [];
      const cutoff = this.now() - OWNER_LIMITS.keepMs;
      for (const [k, at] of list.sort((a, b) => Number(a[1]) - Number(b[1]))) {
        if (FINGERPRINT.test(k) && Number.isFinite(Number(at)) && Number(at) > cutoff) this.map.set(k, Number(at));
      }
      while (this.map.size > OWNER_LIMITS.kept) this.map.delete(this.map.keys().next().value);
      this.saved = new Map(this.map);
    } catch (err) {
      this.log?.warn(`owner sign-ins: couldn't read ${this.file} (${err.message}): starting afresh`);
    }
  }

  // Whether a fingerprint is one of the owner's, used in the last 30 days.
  has(fingerprint) {
    const at = this.map.get(fingerprint);
    if (at === undefined) return false;
    if (this.now() - at > OWNER_LIMITS.keepMs) {
      this.drop(fingerprint);
      return false;
    }
    return true;
  }

  // plex.tv said it's the owner's (or it's in use while it can't say).
  add(fingerprint) {
    if (!FINGERPRINT.test(fingerprint)) return;
    const now = this.now();
    const had = this.saved.get(fingerprint);
    this.map.delete(fingerprint);
    this.map.set(fingerprint, now);
    while (this.map.size > OWNER_LIMITS.kept) this.map.delete(this.map.keys().next().value);
    if (had === undefined || now - had > OWNER_LIMITS.touchMs) this.changed();
  }

  // plex.tv said it's no good, or not the owner's.
  drop(fingerprint) {
    if (this.map.delete(fingerprint)) this.changed();
  }

  // Written now, if anything's waiting to be (the service is stopping).
  flush() {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.write();
  }

  changed() {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.write();
    }, OWNER_LIMITS.writeDelayMs);
    this.timer.unref?.();
  }

  write() {
    if (!this.file) return;
    const tmp = `${this.file}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify({ version: FILE_VERSION, owners: Object.fromEntries(this.map) }), { mode: 0o600 });
      renameSync(tmp, this.file);
      this.saved = new Map(this.map);
    } catch (err) {
      this.log?.error(`owner sign-ins: couldn't save them to ${this.file}: ${err.message}`);
    }
  }
}

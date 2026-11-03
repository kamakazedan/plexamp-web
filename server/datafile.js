// The service's files in the data folder (shares.json, settings.json,
// missing.json, musicbrainz.json and owners.json): read back as they were
// written, and written so that a power cut leaves the file as it was or as
// it's written now, never part of it.
import { readFileSync, writeFileSync, renameSync, existsSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { basename } from 'node:path';

// What's kept in `file` (JSON), handed to `use` as it's read (`what`: what
// it holds, for the log). One that can't be read (cut short, say, or not
// what was written, or `use` couldn't take it) is moved aside, as
// <name>.unreadable-<when>, so that nothing's written over it, and the log
// says so. Returns whether the file may be written to from now on: not
// where one that couldn't be read couldn't be moved aside either.
export function readDataFile(file, use, { log = null, what }) {
  if (!file || !existsSync(file)) return true;
  let problem;
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('it isn’t what was written there');
    use(data);
    return true;
  } catch (err) {
    problem = err.message;
  }
  const when = new Date().toISOString().replace(/\.\d+Z$/, 'Z').replace(/:/g, '-');
  let aside = `${file}.unreadable-${when}`;
  for (let n = 2; existsSync(aside); n += 1) aside = `${file}.unreadable-${when}-${n}`;
  try {
    renameSync(file, aside);
  } catch (err) {
    log?.error(`${what}: couldn't read ${file} (${problem}), nor move it aside (${err.message}), so it's left as it is: what changes is kept in memory only, till the service restarts`);
    return false;
  }
  log?.warn(`${what}: couldn't read ${file} (${problem}), so it's kept aside as ${basename(aside)}, and the service starts without what it held`);
  return true;
}

// `data` written to `file` as JSON, readable by the service only: to a file
// beside it first, and onto the disk, before it takes the file's place.
export function writeDataFile(file, data) {
  const text = JSON.stringify(data);
  const tmp = `${file}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeFileSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

#!/usr/bin/env node
// Resolve concurrent, durable queue-state updates made by separate Actions
// runs.  A publisher run may add a container/media ID while a collector or
// carousel job updates the same record.  Treat the upstream record as the
// conservative base and apply only fields changed by the committing run.  This
// avoids a retry loop that can leave an otherwise healthy publisher unable to
// save its state.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import fs from 'node:fs/promises';

const exec = promisify(execFile);
const git = async (...args) => (await exec('git', args, {maxBuffer: 16 * 1024 * 1024})).stdout;
const parseStage = async (stage, file) => JSON.parse(await git('show', `:${stage}:${file}`));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function merge(base, upstream, incoming) {
  if (equal(incoming, base)) return upstream;
  if (equal(upstream, base)) return incoming;
  if (Array.isArray(base) || Array.isArray(upstream) || Array.isArray(incoming)) {
    return Array.from(new Set([...(Array.isArray(upstream) ? upstream : []), ...(Array.isArray(incoming) ? incoming : [])]));
  }
  if (base && upstream && incoming && typeof base === 'object' && typeof upstream === 'object' && typeof incoming === 'object') {
    const result = {...upstream};
    for (const key of new Set([...Object.keys(base), ...Object.keys(upstream), ...Object.keys(incoming)])) {
      if (!(key in incoming)) continue;
      if (!(key in upstream)) { result[key] = incoming[key]; continue; }
      result[key] = merge(base[key], upstream[key], incoming[key]);
    }
    return result;
  }
  // Both writers changed one scalar.  Preserve the upstream value: it is the
  // one already visible on main and is safer than overwriting a verified ID.
  return upstream;
}

const {stdout} = await exec('git', ['diff', '--name-only', '--diff-filter=U']);
const files = stdout.trim().split('\n').filter(Boolean);
if (!files.length) process.exit(0);
for (const file of files) {
  if (!/^queue\/[^/]+\.json$/.test(file)) throw new Error(`Refusing non-queue conflict: ${file}`);
  const [base, upstream, incoming] = await Promise.all([parseStage(1, file), parseStage(2, file), parseStage(3, file)]);
  await fs.writeFile(file, `${JSON.stringify(merge(base, upstream, incoming), null, 2)}\n`);
  await exec('git', ['add', '--', file]);
}
await exec('git', ['-c', 'core.editor=true', 'rebase', '--continue']);

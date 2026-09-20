export function failedCandidates(runs = [], now = Date.now()) {
  const blocked = new Set();
  for (const run of runs) {
    const at = Date.parse(run.finished_at || run.started_at || '');
    if (!Number.isFinite(at) || at > now) continue;
    for (const failure of run.errors || []) {
      if (!['score', 'queue', 'cached_reserve'].includes(failure.stage)) continue;
      const editorial = /caption|unambiguous|unrelated audio|complete audio/i.test(failure.error || '');
      if (now - at < (editorial ? 6 * 3600000 : 30 * 60000)) {
        const code = String(failure.source_url || '').match(/\/(?:p|reel)\/([\w-]+)/)?.[1];
        if (code) blocked.add(code);
      }
    }
  }
  return blocked;
}

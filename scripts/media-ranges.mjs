// Assemble only a complete response, allowing retransmitted/overlapping ranges.
export function assembleRanges(parts, { allowBufferedRanges = false } = {}) {
  const sorted = [...parts].sort((a,b) => a.rangeStart - b.rangeStart || b.body.length - a.body.length);
  const chunks = [];
  let offset = 0;
  let total;
  for (const part of sorted) {
    const declared = Number(part.headers?.['content-range']?.match(/\/(\d+)$/)?.[1]);
    if (declared > 0) {
      if (total !== undefined && total !== declared) return null;
      total = declared;
    }
    if (part.rangeStart > offset) return null;
    const skip = offset - part.rangeStart;
    if (skip < part.body.length) { chunks.push(part.body.subarray(skip)); offset += part.body.length - skip; }
  }
  // A 206 response must supply a total; a standalone 200 response is complete.
  if (!offset || (total !== undefined && total !== offset)) return null;
  const completeResponse = sorted.some(part => part.status === 200 && part.rangeStart === 0 && part.body.length === offset && part.rangeEnd === undefined);
  // Instagram's CDN also serves URL byte ranges as HTTP 200, without a total.
  // These require a fully buffered DOM video AND decoded-duration validation
  // by the caller; contiguous ranges alone are not proof of a full video.
  const bufferedRanges = allowBufferedRanges && sorted.every(part => Number.isInteger(part.rangeEnd) && part.rangeEnd - part.rangeStart + 1 === part.body.length);
  if (total === undefined && !completeResponse && !bufferedRanges) return null;
  return Buffer.concat(chunks);
}

import assert from 'node:assert/strict';

// Missing evidence must not be coerced into an empty, successfully restored table.
export function compareRestoreCounts(source, restoredCounts, bindings) {
  const comparisons = {};
  for (const [target, [domain, table]] of Object.entries(bindings)) {
    const expected = source?.domains?.[domain]?.row_counts?.[table];
    const actual = restoredCounts?.[target];
    assert.ok(Number.isSafeInteger(expected) && expected >= 0,
      `${domain}.${table}: source count missing or invalid`);
    assert.ok(Number.isSafeInteger(actual) && actual >= 0,
      `${target}: restored count missing or invalid`);
    assert.equal(actual, expected,
      `${target}: restored count ${actual} does not equal source ${expected}`);
    comparisons[target] = { expected, actual };
  }
  return comparisons;
}

export function compareRestoreHashes(source, restoredHashes, domainTables) {
  const comparisons = {};
  for (const [domain, tables] of Object.entries(domainTables)) {
    for (const table of tables) {
      const expected = source?.domains?.[domain]?.table_sha256?.[table];
      const actual = restoredHashes?.[table];
      assert.ok(typeof expected === 'string' && /^[0-9a-f]{64}$/.test(expected),
        `${domain}.${table}: source hash missing or invalid`);
      assert.ok(typeof actual === 'string' && /^[0-9a-f]{64}$/.test(actual),
        `${table}: restored hash missing or invalid`);
      assert.equal(actual, expected, `${table}: restored content hash mismatch`);
      comparisons[table] = { expected, actual };
    }
  }
  return comparisons;
}

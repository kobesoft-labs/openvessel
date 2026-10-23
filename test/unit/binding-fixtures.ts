// Compares a binding's results on the shared fixture cases (test/fixtures-gen/*.cases.mjs) with what
// the real Node produced (test/unit/fixtures/*.json).
import assert from 'node:assert/strict';

type Item = { args: unknown[]; r: unknown };
type Results = Record<string, Item[]>;

/**
 * Asserts section by section that `actual` (OpenVessel's binding) matches `expected` (Node).
 * `known` lists accepted differences as predicates over a case, keyed by the reason.
 */
export function compareFixtures(actual: Results, expected: Results, known: Record<string, (section: string, item: Item) => boolean> = {}) {
  actual = JSON.parse(JSON.stringify(actual));
  const failures: string[] = [];
  const accepted: Record<string, number> = {};
  let total = 0;
  for (const section of Object.keys(expected)) {
    const exp = expected[section];
    const act = actual[section] ?? [];
    assert.equal(act.length, exp.length, `${section}: case count differs; regenerate the fixture`);
    exp.forEach((e, i) => {
      total++;
      const a = act[i];
      assert.deepEqual(a.args, e.args, `${section}[${i}]: cases out of sync with the fixture; regenerate it`);
      try {
        assert.deepEqual(a.r, e.r);
      } catch {
        const why = Object.keys(known).find((k) => known[k](section, e));
        if (why) accepted[why] = (accepted[why] ?? 0) + 1;
        else failures.push(`${section}${JSON.stringify(e.args)}\n    node: ${JSON.stringify(e.r)}\n    ours: ${JSON.stringify(a.r)}`);
      }
    });
  }
  if (Object.keys(accepted).length) console.log(`accepted differences: ${JSON.stringify(accepted)}`);
  assert.ok(failures.length === 0, `${failures.length} of ${total} cases differ from Node:\n  ${failures.slice(0, 60).join('\n  ')}`);
  return total;
}

const test = require("node:test");
const assert = require("node:assert/strict");

const { createSeededRandom } = require("./trainDistilledModel");

test("seeded random generator is reproducible", () => {
  const first = createSeededRandom(1234);
  const second = createSeededRandom(1234);
  const firstValues = [first(), first(), first(), first()];
  const secondValues = [second(), second(), second(), second()];
  assert.deepEqual(firstValues, secondValues);
});

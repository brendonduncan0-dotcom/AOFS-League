import { test } from "node:test"
import assert from "node:assert/strict"
import { pairKey, pairingState, shuffle, swissPair } from "./lib/league.ts"

const meetingsOf = (...pairs: [string, string][]) => {
  const m = new Map<string, number>()
  for (const [a, b] of pairs) m.set(pairKey(a, b), (m.get(pairKey(a, b)) ?? 0) + 1)
  return m
}
const noByes = new Map<string, number>()

test("pairs top-down by standings with no history", () => {
  const r = swissPair({ order: ["A", "B", "C", "D"], meetings: new Map(), byes: noByes })
  assert.deepEqual(r.pairs, [
    ["A", "B"],
    ["C", "D"],
  ])
  assert.equal(r.bye, undefined)
  assert.equal(r.rematches, 0)
})

test("avoids a rematch by taking the next closest opponent", () => {
  const r = swissPair({ order: ["A", "B", "C", "D"], meetings: meetingsOf(["A", "B"]), byes: noByes })
  assert.deepEqual(r.pairs, [
    ["A", "C"],
    ["B", "D"],
  ])
  assert.equal(r.rematches, 0)
})

test("backtracks when the greedy choice leaves an impossible remainder", () => {
  // A-B and C-D met; greedy A-C leaves B-D (fine), but also forbid B-D so A must take D.
  const r = swissPair({
    order: ["A", "B", "C", "D"],
    meetings: meetingsOf(["A", "B"], ["C", "D"], ["B", "D"]),
    byes: noByes,
  })
  assert.deepEqual(r.pairs, [
    ["A", "D"],
    ["B", "C"],
  ])
  assert.equal(r.rematches, 0)
})

test("allows the fewest rematches when none-free is impossible", () => {
  // 4 players who have all met: every pairing is a rematch
  const r = swissPair({
    order: ["A", "B", "C", "D"],
    meetings: meetingsOf(["A", "B"], ["A", "C"], ["A", "D"], ["B", "C"], ["B", "D"], ["C", "D"]),
    byes: noByes,
  })
  assert.equal(r.pairs.length, 2)
  assert.equal(r.rematches, 2)
})

test("odd count: bye goes to the lowest-placed player without a bye", () => {
  const r = swissPair({
    order: ["A", "B", "C", "D", "E"],
    meetings: new Map(),
    byes: new Map([["E", 1]]),
  })
  assert.equal(r.bye, "D")
  assert.deepEqual(r.pairs, [
    ["A", "B"],
    ["C", "E"],
  ])
})

test("every player appears exactly once", () => {
  const order = ["A", "B", "C", "D", "E", "F", "G"]
  const r = swissPair({ order, meetings: meetingsOf(["A", "B"], ["C", "D"]), byes: noByes })
  const seen = [...r.pairs.flat(), r.bye].sort()
  assert.deepEqual(seen, [...order].sort())
})

test("shuffle keeps every player and can be made deterministic", () => {
  const seq = [0.1, 0.9, 0.5, 0.3]
  let i = 0
  const out = shuffle(["A", "B", "C", "D", "E"], () => seq[i++ % seq.length])
  assert.deepEqual([...out].sort(), ["A", "B", "C", "D", "E"])
})

const pairing = { a: "Ann", b: "Bob", round: 2 }
const resultFile = `${process.cwd()}/content/Leagues/L/Results/Round 2/Ann vs Bob.md`

test("pairing with a result: played, VP copied, result linked", () => {
  const st = pairingState(pairing, { a: "Ann", b: "Bob", vpA: 12, vpB: 7, file: resultFile }, 1)
  assert.deepEqual(st, {
    status: "played",
    vp_a: 12,
    vp_b: 7,
    result: "[[Leagues/L/Results/Round 2/Ann vs Bob|Ann vs Bob]]",
  })
})

test("result listing players the other way round is flipped to the pairing's order", () => {
  const st = pairingState(pairing, { a: "Bob", b: "Ann", vpA: 7, vpB: 12, file: resultFile }, 1)
  assert.equal(st.vp_a, 12)
  assert.equal(st.vp_b, 7)
})

test("no result: scheduled while the round is open, unplayed once it is closed", () => {
  assert.equal(pairingState(pairing, undefined, 1).status, "scheduled")
  assert.equal(pairingState(pairing, undefined, 2).status, "unplayed")
  assert.deepEqual(
    { vp_a: pairingState(pairing, undefined, 2).vp_a, result: pairingState(pairing, undefined, 2).result },
    { vp_a: null, result: null },
  )
})

test("a protected player (late joiner's first round) never gets the bye", () => {
  const r = swissPair({
    order: ["A", "B", "C", "D", "E"],
    meetings: new Map(),
    byes: noByes,
    noBye: new Set(["E"]),
  })
  assert.equal(r.bye, "D")
})

test("if every player is protected, the normal bye rule still applies", () => {
  const r = swissPair({ order: ["A", "B", "C"], meetings: new Map(), byes: noByes, noBye: new Set(["A", "B", "C"]) })
  assert.equal(r.bye, "C")
})

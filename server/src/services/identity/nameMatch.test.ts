import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeName, nameSimilarity, scoreCandidate, type CandidateAnchor } from "./nameMatch";

test("normalizeName: exact diacritic equivalents fold together", () => {
  assert.equal(normalizeName("Martínez"), normalizeName("Martinez"));
  assert.equal(normalizeName("Håland"), "haland");
});

test("nameSimilarity: Haaland vs Håland scores high", () => {
  assert.ok(nameSimilarity("Erling Haaland", "Erling Håland") >= 0.85);
});

test("normalizeName: Jr/Sr/II/III suffixes are stripped", () => {
  assert.equal(normalizeName("Carlos Augusto Jr"), normalizeName("Carlos Augusto"));
  assert.equal(normalizeName("Robert Smith III"), normalizeName("Robert Smith"));
});

test("nameSimilarity: initial matches full first name (F. de Jong vs Frenkie de Jong)", () => {
  assert.ok(nameSimilarity("F. de Jong", "Frenkie de Jong") >= 0.8);
});

test("normalizeName: non-Latin script normalises to empty string, not a false match", () => {
  const a = normalizeName("Фёдор Смолов");
  const b = normalizeName("Другой Игрок");
  assert.equal(a, "");
  assert.equal(b, "");
  assert.equal(nameSimilarity("Фёдор Смолов", "Другой Игрок"), 0);
});

test("nameSimilarity: apostrophe names (O'Neil) normalise cleanly", () => {
  assert.equal(normalizeName("O'Neil"), normalizeName("O Neil"));
});

test("nameSimilarity: Rodri vs Jay Rodriguez stays below the match floor", () => {
  assert.ok(nameSimilarity("Rodri", "Jay Rodriguez") < 0.5);
});

test("nameSimilarity: Pedri vs Pedrinho stays below the safe-merge threshold", () => {
  assert.ok(nameSimilarity("Pedri", "Pedrinho") < 0.6);
});

test("nameSimilarity: Alisson vs Alisson Becker (subset) scores high", () => {
  assert.ok(nameSimilarity("Alisson", "Alisson Becker") >= 0.8);
});

test("nameSimilarity: fuller legal name (Rodrigo Hernández vs Rodrigo Hernández Cascante)", () => {
  assert.ok(nameSimilarity("Rodrigo Hernández", "Rodrigo Hernández Cascante") >= 0.8);
});

test("scoreCandidate: TheSportsDB idAPIfootball cross-ref short-circuits to 1.0", () => {
  const anchor: CandidateAnchor = { name: "Erling Haaland" };
  const candidate: CandidateAnchor = { name: "E Haaland", idAPIfootball: 12345 };
  const r = scoreCandidate(anchor, candidate, { fdId: 12345 });
  assert.equal(r.confidence, 1);
  assert.equal(r.status, "auto_high");
});

test("scoreCandidate: two different same-named players, DOB hard rejects the wrong one (Bernardo Silva case)", () => {
  // Man City's Bernardo Silva (1994) vs a different, unrelated Bernardo Silva (2002).
  const anchor: CandidateAnchor = { name: "Bernardo Silva", dob: "1994-08-10", club: "Manchester City FC" };
  const wrongCandidate: CandidateAnchor = { name: "Bernardo Silva", dob: "2002-03-15", club: "Vitória SC" };
  const r = scoreCandidate(anchor, wrongCandidate);
  assert.equal(r.confidence, 0);
  assert.equal(r.status, "discarded");
});

test("scoreCandidate: same name + same DOB + same club is auto_high", () => {
  const anchor: CandidateAnchor = { name: "Bernardo Silva", dob: "1994-08-10", club: "Manchester City FC" };
  const rightCandidate: CandidateAnchor = { name: "Bernardo Silva", dob: "1994-08-10", club: "Manchester City" };
  const r = scoreCandidate(anchor, rightCandidate);
  assert.equal(r.status, "auto_high");
});

test("scoreCandidate: two same-name same-club candidates with no DOB both cap at auto_low and queue", () => {
  const anchor: CandidateAnchor = { name: "João Silva", club: "Sporting CP" };
  const c1: CandidateAnchor = { name: "João Silva", club: "Sporting CP" };
  const c2: CandidateAnchor = { name: "João Silva", club: "Sporting CP" };
  const r1 = scoreCandidate(anchor, c1, { peers: [c2] });
  const r2 = scoreCandidate(anchor, c2, { peers: [c1] });
  assert.ok(r1.confidence < 0.85, "ambiguous candidate must not auto-pin");
  assert.ok(r2.confidence < 0.85, "ambiguous candidate must not auto-pin");
});

test("scoreCandidate: name + DOB + club evidence is enough for auto_high without needing a peer-based bonus", () => {
  const anchor: CandidateAnchor = { name: "Kylian Mbappe", dob: "1998-12-20", club: "Real Madrid" };
  const candidate: CandidateAnchor = { name: "Kylian Mbappé", dob: "1998-12-20", club: "Real Madrid CF" };
  const r = scoreCandidate(anchor, candidate, { peers: [] });
  assert.equal(r.status, "auto_high");
});

test("scoreCandidate: a peer that's clearly not competitive earns a uniqueness bonus", () => {
  const anchor: CandidateAnchor = { name: "Kylian Mbappe", club: "Real Madrid" };
  const candidate: CandidateAnchor = { name: "Kylian Mbappé", club: "Real Madrid CF" };
  const unrelatedPeer: CandidateAnchor = { name: "Random Unrelated Player", club: "Some Other Club" };
  const withPeer = scoreCandidate(anchor, candidate, { peers: [unrelatedPeer] });
  const withoutPeer = scoreCandidate(anchor, candidate, { peers: [] });
  assert.ok(withPeer.confidence > withoutPeer.confidence);
});

test("scoreCandidate: this exact mechanism would have rejected the Unai/Fermín López cross-match", () => {
  const anchor: CandidateAnchor = { name: "Unai López", club: "Rayo Vallecano" };
  const wrongCandidate: CandidateAnchor = { name: "Fermín López", club: "FC Barcelona" };
  const r = scoreCandidate(anchor, wrongCandidate);
  assert.equal(r.status, "discarded");
});

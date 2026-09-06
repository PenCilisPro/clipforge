import { snapToBounds } from "../worker/src/lib/zai.js";

// Case 1 (user's example, pref 15-30 => {min:13,max:32}):
// AI suggests start=3,end=28 but the sentence finishes at word "end." (31.5→31.9).
const words2 = [];
for (let i = 0; i < 90; i++) {
  const start = i * 0.5;
  words2.push({ word: i === 63 ? "end." : `w${i}`, start, end: start + 0.4 });
}
const out1 = snapToBounds({ start: 3, end: 28, title: "t" }, words2, { min: 13, max: 32 });
console.log("case1 (extend to sentence end):", JSON.stringify(out1));

// Case 2: sentence ends way past the grace window — end stays ~28.
const words3 = words2.map((w) => (w.word === "end." ? { word: "end.", start: 40, end: 40.4 } : w));
const out2 = snapToBounds({ start: 3, end: 28, title: "t" }, words3, { min: 13, max: 32 });
console.log("case2 (no sentence within grace):", JSON.stringify(out2));

// Case 3: stretching to the sentence end overflows max → front gets clipped.
const words4 = [];
for (let i = 0; i < 90; i++) {
  const start = i * 0.5;
  words4.push({ word: i === 70 ? "finish!" : `w${i}`, start, end: start + 0.4 });
}
const out3 = snapToBounds({ start: 0, end: 30, title: "t" }, words4, { min: 13, max: 32 });
console.log("case3 (front clipped):", JSON.stringify(out3));

// Case 4: after front-clipping, start lands inside a word → pulled back to its start.
const longWords = words4.map((w) => ({ ...w, end: w.end + 0.35 }));
const out4 = snapToBounds({ start: 0, end: 30, title: "t" }, longWords, { min: 13, max: 32 });
console.log("case4 (front clip mid-word):", JSON.stringify(out4));

// Case 5: no transcript words — clip untouched.
console.log("case5 (no words):", JSON.stringify(snapToBounds({ start: 1, end: 20 }, [], { min: 13, max: 32 })));

// Case 6: suggested end already at a sentence end — unchanged (plus word completion).
const out6 = snapToBounds({ start: 3, end: 31.9, title: "t" }, words2, { min: 13, max: 32 });
console.log("case6 (already at sentence end):", JSON.stringify(out6));

// Case 7: sentence end within grace pushes duration past max → front clipped to fit.
const words7 = [];
for (let i = 0; i < 90; i++) {
  const start = i * 0.5;
  words7.push({ word: i === 70 ? "okay?" : `w${i}`, start, end: start + 0.4 });
}
// sentence ends at 35.4; clip 2→34 stretched to 35.4 = 33.4s > 32 max → start 3.4,
// pulled back to the containing word's start (3.0).
const out7 = snapToBounds({ start: 2, end: 34, title: "t" }, words7, { min: 13, max: 32 });
console.log("case7 (front clipped to fit max):", JSON.stringify(out7));


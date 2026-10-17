/*
 * When a pasted name is offered as a possible registered blader.
 *
 *   node tests/matching.test.mjs
 */
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");

function grab(name) {
  for (const p of [`function ${name}(`, `const ${name} = `]) {
    const at = src.indexOf(p);
    if (at < 0) continue;
    if (p.startsWith("function")) {
      let i = src.indexOf("{", at), d = 0;
      for (; i < src.length; i++) {
        if (src[i] === "{") d++;
        else if (src[i] === "}") { d--; if (!d) return src.slice(at, i + 1); }
      }
    } else {
      let d = 0;
      for (let i = at; i < src.length; i++) {
        const c = src[i];
        if ("{([".includes(c)) d++;
        else if ("})]".includes(c)) d--;
        else if (c === ";" && d === 0) return src.slice(at, i + 1);
      }
    }
  }
  throw new Error("not found in App.jsx: " + name);
}

const names = ["normName", "nameWords", "editDistance", "nameLikeness", "matchBladers"];
const mod = await import(`data:text/javascript,${encodeURIComponent(
  names.map(grab).join("\n") + `\nexport { ${names.join(", ")} };`)}`);
const { nameLikeness, matchBladers, editDistance } = mod;

let fails = 0;
const check = (label, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) console.log("PASS ", label);
  else { fails++; console.log("FAIL ", label, "\n  got  ", a, "\n  want ", b); }
};

/* ---- how alike two names are ---- */
check("the same name", nameLikeness("Joy", "Joy"), 3);
check("case and stray spaces do not matter", nameLikeness("joy ", "JOY"), 3);
check("punctuation does not matter", nameLikeness("Shark-Boy", "sharkboy"), 3);
check("accents do not matter", nameLikeness("Zoë", "Zoe"), 3);
check("one name inside the other", nameLikeness("Rusab", "rusab_10"), 2);
check("a one-letter slip in a short name", nameLikeness("Ayon", "Ayan"), 2);
check("a two-letter slip in a longer name", nameLikeness("Tanveer", "Tanvir"), 2);
check("a short name off by its first letter is someone else", nameLikeness("Joy", "Roy"), 0);
check("a first name inside a full real name", nameLikeness("Joy", "Joy Hasan"), 1);
check("unrelated names", nameLikeness("Alif", "Mahi"), 0);
check("a short name is not 'inside' a longer one", nameLikeness("Jo", "Jonathan"), 0);
check("nothing is like an empty name", nameLikeness("", "Joy"), 0);
check("non-Latin names compare too", nameLikeness("রাফি", "রাফি"), 3);
check("edit distance", editDistance("kitten", "sitting"), 3);

/* ---- which bladers a name is offered as ---- */
const dir = [
  { id: "1", blader_name: "The Scarlet Blader", real_name: "Rusab Sarmun" },
  { id: "2", blader_name: "rusabjapan", real_name: null },
  { id: "3", blader_name: "Ayan", real_name: "Ayan Khan" },
  { id: "4", blader_name: "Sharkboy", real_name: "Ahnaf" },
];
const ids = (r) => r.map((x) => x.blader.id);

check("a near blader name beats a shared word in a real name",
  ids(matchBladers("Rusab", dir)), ["2", "1"]);
check("and says which it matched on",
  matchBladers("Rusab", dir).map((x) => x.on), ["blader name", "real name"]);
check("a real name alone is enough", ids(matchBladers("Ahnaf", dir)), ["4"]);
check("someone already in the tournament is not offered",
  ids(matchBladers("Rusab", dir, new Set(["2"]))), ["1"]);
check("a real name hidden from us is never matched",
  ids(matchBladers("Ahnaf", dir.map((b) => ({ ...b, real_name: null })))), []);
check("no likely blader, no offer", ids(matchBladers("Zidan", dir)), []);
{
  const many = [...Array(9)].map((_, i) => ({ id: String(i), blader_name: `Joy ${i}`, real_name: null }));
  check("at most five offered", matchBladers("Joy", many).length, 5);
}

console.log(fails ? `\n${fails} FAILED` : "\nAll matching checks passed.");
process.exit(fails ? 1 : 0);

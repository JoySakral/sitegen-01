// sitegen-fast: the program the harness runs. It reads every case from
// /input/cases.json (or MAKEFUN_INPUT_DIR), answers each one alone with run()
// from solve.js, and writes /output/answers.json (or MAKEFUN_OUTPUT_DIR): a
// JSON array of the answers, one per case and in the cases' order.
//
// The driver keeps V8's incremental marking off, the same tuning the house
// baseline runs under, set before solve.js is imported so all of its work
// runs under it. The build itself reads no clock, no environment and no
// randomness, so two runs write byte-identical output.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

setFlagsFromString('--no-incremental-marking');

/** solve.js, imported by its URL (a .js module carries no types) and typed by its contract. */
const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as { run: (input: unknown) => unknown };

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The cases file read and checked: a JSON array of { id, input }. */
function readCases(): { id: string; input: unknown }[] {
  const raw = readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('cases.json is not a JSON array');
  for (let i = 0; i < parsed.length; i++) {
    const c = parsed[i] as { id?: unknown; input?: unknown };
    if (c === null || typeof c !== 'object' || typeof c.id !== 'string' || !('input' in c)) {
      throw new Error(`case ${i} has no id or input`);
    }
  }
  return parsed as { id: string; input: unknown }[];
}

const cases = readCases();
const answers: unknown[] = [];
for (const c of cases) {
  const answer = run(c.input);
  if (answer === null || typeof answer !== 'object' || Array.isArray(answer)) {
    throw new Error(`case ${c.id} did not answer with an output tree`);
  }
  answers.push(answer);
}
writeFileSync(join(OUTPUT_DIR, 'answers.json'), JSON.stringify(answers));
console.error(`sitegen-fast: answered ${answers.length} case(s)`);

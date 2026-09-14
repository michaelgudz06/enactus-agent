// Does the planner still route each kind of message to the right branch?
//
// selfcheck.ts cannot cover this: the rule being tested is a paragraph of
// English inside the planner's system prompt, and the only thing that can
// evaluate it is the model. Run it after touching planPrompt() or the intent
// instruction -- a wording change that reads fine has already regressed this
// once, sending "credit unions ... with community grant programs" to the
// answer branch while every other example chip still searched.
//
//   node --experimental-strip-types scripts/intent-cases.ts      # 5 samples
//   node --experimental-strip-types scripts/intent-cases.ts 9    # more, for a close call
//
// Costs one cheap STRUCTURER call per sample and writes nothing.
import fs from "node:fs";
import { QUERY_GUARDRAILS, planPrompt } from "../src/lib/targeting.ts";

const src = fs.readFileSync("src/lib/agent.ts", "utf8");
const env = Object.fromEntries(
  fs.readFileSync(".env.local", "utf8").split("\n")
    .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")])
);

// The planner's own system prompt, imported rather than restated, so editing
// the policy cannot leave this file quietly testing the old wording. It used to
// be recovered by splitting agent.ts on a literal prefix; the prompt now lives
// in one module and can simply be called.
//
// The JSON-shape instruction is still scraped, because it is built inline at
// the call site out of run-specific values (queryCount, the mode branches). The
// guard below fails loudly if that template stops resolving.
const shape = ("Respond ONLY with JSON of shape:" + src.split("Respond ONLY with JSON of shape:")[1].split("` },")[0])
  .replace(/\$\{queryCount\}/g, "3")
  .replace(/\$\{\s*\n?\s*mode === "sales"\s*\n?\s*\?\s*""\s*\n?\s*:\s*QUERY_GUARDRAILS\s*\n?\s*\}/, QUERY_GUARDRAILS)
  .replace(/\$\{\s*\n?\s*mode === "sales"[\s\S]*?:\s*'([\s\S]*?)'\s*\n?\s*\}/, "$1");
if (shape.includes("${")) {
  console.error("Could not resolve the prompt template -- agent.ts changed shape:");
  console.error(shape.match(/\$\{[^]{0,120}/)?.[0] ?? shape.slice(0, 120));
  process.exit(1);
}
const system = `${planPrompt("sponsor")}\n\n${shape}`;

async function intentOf(prompt: string): Promise<string> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "deepseek/deepseek-v3.2",
      provider: { order: ["Baidu"], allow_fallbacks: true },
      messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
      max_tokens: 800,
      response_format: { type: "json_object" },
    }),
  });
  const d = await res.json();
  try { return JSON.parse(d.choices[0].message.content).intent ?? "(absent)"; } catch { return "(unparseable)"; }
}

// The three example chips the UI ships are here on purpose: they are verbless
// noun phrases, which is exactly the shape that regressed.
const CASES = [
  ["leads", "Catering & food companies in Burnaby that could sponsor student events"],
  ["leads", "SFU alumni-founded tech startups in Vancouver open to giving back"],
  ["leads", "Credit unions and banks in the Lower Mainland with community grant programs"],
  ["leads", "20 more"],
  ["leads", "same thing for Richmond"],
  ["leads", "Find me 4 climbing gyms near SFU that could donate a day pass"],
  ["answer", "hi"],
  ["answer", "thanks!"],
  ["answer", "What does Enactus SFU actually do?"],
  ["answer", "What's on our board right now?"],
  ["answer", "Tell me about Alara"],
];

const N = Number(process.argv[2]) || 5;
let failed = 0;
for (const [want, prompt] of CASES) {
  const got = await Promise.all(Array.from({ length: N }, () => intentOf(prompt)));
  const hits = got.filter((g) => g === want).length;
  // Unanimous or it is a failure: a rule that holds 4 times in 5 is a rule the
  // user hits the wrong side of once a week.
  if (hits < N) failed++;
  console.log(`${hits < N ? "FAIL" : "ok  "}  want=${want.padEnd(6)} ${hits}/${N}  ${hits < N ? JSON.stringify(got) + "  " : ""}${prompt}`);
}
console.log(failed ? `\n${failed} case(s) not unanimous` : `\nall ${CASES.length} cases unanimous over ${N} samples`);
process.exit(failed ? 1 : 0);

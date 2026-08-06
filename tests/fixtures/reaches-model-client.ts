// The CONTROL for tests/no-model-client.test.ts, and nothing else.
//
// A module that genuinely reaches the model boundary. Without one, a broken vi.doMock trap would
// make every "filter.ts / scoring.ts loaded without touching the boundary" assertion vacuously
// true. It lives here rather than pointing at src/lib/agent.ts — the real model-calling module —
// because that file is out of scope for this task and a parallel task is rewriting it; anchoring
// the control there would let unrelated work break this suite.

import { REASONER } from "../../src/lib/llm";

export const reasoner = REASONER;

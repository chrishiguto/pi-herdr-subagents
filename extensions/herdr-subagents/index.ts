// Public Pi extension composition root.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerChildRuntime } from "../../src/child-runtime.ts";
import { registerHerdrAgentState } from "../../src/herdr/agent-state.ts";
import { registerOrchestrator } from "../../src/orchestrator.ts";

export default function herdrSubagents(pi: ExtensionAPI): void {
  registerHerdrAgentState(pi);
  registerChildRuntime(pi);
  registerOrchestrator(pi);
}

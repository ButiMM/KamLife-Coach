import { AsyncLocalStorage } from "node:async_hooks";
import type { RuntimeDecisionResult } from "./state";

/** Request-scoped coaching decision. Never store this in module-global mutable state. */
const storage = new AsyncLocalStorage<RuntimeDecisionResult>();

export function rememberDecision(decision: RuntimeDecisionResult): RuntimeDecisionResult {
  storage.enterWith(decision);
  return decision;
}

export function currentDecision(): RuntimeDecisionResult | undefined {
  return storage.getStore();
}

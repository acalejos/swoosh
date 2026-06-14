import type { RoutePlan, RouterAttempt } from "@swoosh-dev/router";

export const printPlan = (plan: RoutePlan): void => {
  const cost = plan.estimate.costUsd !== undefined ? `$${plan.estimate.costUsd.toFixed(4)}` : "n/a";
  console.log(`task        ${plan.task}`);
  console.log(`preference  ${plan.preference}`);
  console.log(`selected    ${plan.selected.capability.providerId}/${plan.selected.capability.modelId} (est. ${cost})`);
  console.log(`            ${plan.selected.reason}`);
  for (const fallback of plan.fallbacks) {
    console.log(`fallback    ${fallback.capability.providerId}/${fallback.capability.modelId}`);
  }
  for (const rejectedModel of plan.rejected) {
    console.log(`rejected    ${rejectedModel.providerId}/${rejectedModel.modelId} — ${rejectedModel.reason}`);
  }
};

export const printAttempts = (attempts: readonly RouterAttempt[]): void => {
  for (const attempt of attempts) {
    const outcome = attempt.ok ? "ok" : `failed: ${attempt.error}`;
    console.log(`attempt     ${attempt.providerId}/${attempt.modelId} — ${outcome}`);
  }
};

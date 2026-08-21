import { WORKFLOW_VERSION, type ProviderRequest, type SensitivityClass, type Stage } from "./types.js";

export function buildPrompt(stage: Stage, stableInstructions: string, schema: string, projectSummary: string, dynamicInput: string, sensitivity: SensitivityClass): Pick<ProviderRequest, "stablePrefix" | "projectSummary" | "dynamicInput"> {
  const stablePrefix = [
    `workflow-version:${WORKFLOW_VERSION}`,
    `stage:${stage}`,
    "Follow the approved scope. Return only schema-valid output. Fail closed on ambiguity.",
    stableInstructions.trim(),
    `OUTPUT_SCHEMA\n${schema.trim()}`,
  ].join("\n\n");
  return {
    stablePrefix: sensitivity === "normal" ? stablePrefix : `${stablePrefix}\n\nCACHE_POLICY:no-reusable-sensitive-prefix`,
    projectSummary: projectSummary.trim(),
    dynamicInput: dynamicInput.trim(),
  };
}

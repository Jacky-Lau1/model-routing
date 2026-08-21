import { classifyTask } from "./classifier.js";
import { decideRoute } from "./policy.js";

const CASES = [
  { name: "normal-code", input: "Fix a bounded TypeScript parser bug", stage: "EXECUTE" as const, expected: "deepseek-v4-flash" },
  { name: "complex-code", input: "Cross-module architecture refactor", stage: "EXECUTE" as const, expected: "deepseek-v4-pro" },
  { name: "text", input: "Write a proposal document", stage: "TEXT_EXPAND" as const, expected: "deepseek-v4-flash" },
  { name: "visual", input: "Review this UI screenshot layout", stage: "VISUAL_REVIEW" as const, expected: "gpt-5.6-terra" },
  { name: "private", input: "Fix private proprietary source code", stage: "EXECUTE" as const, expected: "gpt-5.6-terra" },
  { name: "high-risk", input: "Plan production authentication migration", stage: "PLAN" as const, expected: "gpt-5.6-sol" },
];

export function runRoutingBenchmark(iterations = 10) {
  const results = CASES.map(testCase => {
    let passed = 0;
    for (let index = 0; index < iterations; index++) {
      const route = decideRoute(testCase.stage, classifyTask(testCase.input));
      if (route.model === testCase.expected) passed++;
    }
    return { case: testCase.name, expected: testCase.expected, passed, total: iterations };
  });
  return { passed: results.every(result => result.passed === result.total), iterations, results };
}

import type { TaskProfile } from "./types.js";

const HIGH_RISK = /\b(auth|payment|security|secret|credential|migration|deploy|production|delete|irreversible)\b|认证|支付|安全|密钥|迁移|部署|生产|删除|不可逆/i;
const COMPLEX = /\b(architecture|multi[- ]module|cross[- ]module|distributed|database|refactor all)\b|架构|跨模块|多模块|分布式|数据库|全局重构/i;
const VISUAL = /\b(image|screenshot|visual|figma|ui|ux|layout)\b|图片|截图|视觉|界面|布局/i;
const TEXT = /\b(proposal|document|copywriting|outline|report|essay)\b|方案|文档|文案|大纲|报告|文章/i;
const RESTRICTED = /\b(restricted|classified|highly confidential)\b|受限|机密|绝密/i;
const PRIVATE = /\b(private|proprietary|confidential|internal)\b|私有|内部|保密/i;

export function classifyTask(input: string, overrides: Partial<TaskProfile> = {}): TaskProfile {
  const signals: string[] = [];
  const hasVisualInput = overrides.hasVisualInput ?? VISUAL.test(input);
  const risk = overrides.risk ?? (HIGH_RISK.test(input) ? "high" : "normal");
  const complexity = overrides.complexity ?? (COMPLEX.test(input) ? "complex" : "normal");
  const sensitivity = overrides.sensitivity ?? (RESTRICTED.test(input) ? "restricted" : PRIVATE.test(input) ? "private" : "normal");
  const kind = overrides.kind ?? (hasVisualInput ? "visual" : TEXT.test(input) ? "text" : "code");
  if (risk === "high") signals.push("high-risk keyword");
  if (complexity === "complex") signals.push("complexity keyword");
  if (sensitivity !== "normal") signals.push(`${sensitivity} data marker`);
  if (hasVisualInput) signals.push("visual input marker");
  return { kind, risk, complexity, sensitivity, hasVisualInput, signals, ...overrides };
}

import os from "node:os";
import path from "node:path";
import { DEFAULT_QUALITY_GATE_POLICY, LocalQualityGate, type QualityGateOptions } from "../quality-gate.js";
import type { ProviderAdapter, ProviderRequest, ProviderResponse, QualityGatePolicy } from "../types.js";
import { LOCAL_ADAPTER_ID } from "../route-preflight.js";

export interface LocalValidationAdapterOptions extends Omit<QualityGateOptions, "policy" | "evidenceRoot"> {
  policy?: QualityGatePolicy;
  evidenceRoot?: string;
}

export class LocalValidationAdapter implements ProviderAdapter {
  readonly provider = "local" as const;
  readonly adapterId = LOCAL_ADAPTER_ID;
  readonly policy: QualityGatePolicy;
  private readonly gate: LocalQualityGate;

  constructor(options: LocalValidationAdapterOptions = {}) {
    this.policy = options.policy ?? DEFAULT_QUALITY_GATE_POLICY;
    this.gate = new LocalQualityGate({ ...options, policy: this.policy, evidenceRoot: options.evidenceRoot ?? path.join(os.tmpdir(), "codex-model-router-state") });
  }

  async preflight(request: ProviderRequest): Promise<void> {
    if (!request.qualityGate || !request.workingDirectory) throw new Error("Local validation requires an approved structured quality-gate request");
    await this.gate.preflight(request.qualityGate, request.workingDirectory);
  }

  async invoke(request: ProviderRequest): Promise<ProviderResponse> {
    if (!request.qualityGate || !request.workingDirectory) throw new Error("Local validation requires an approved structured quality-gate request");
    const report = await this.gate.run(request.qualityGate, request.workingDirectory);
    const requestId = `local-${request.qualityGate.run_id}-${report.report_hash.slice(0, 16)}`;
    return {
      text: JSON.stringify(report), requestId, provider: "local", model: "local-quality-gates", usageAvailability: { inputTokens: true, outputTokens: true, reasoningTokens: true, cacheHitTokens: true, cacheMissTokens: true },
      usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 },
      routeEvidence: {
        routeBindingHash: null, adapterId: this.adapterId, expectedProvider: "local", expectedModel: "local-quality-gates", expectedOrigin: null, expectedPath: null,
        actualOrigin: null, actualPath: null, actualModel: "local-quality-gates", wireProtocol: "local", authAlias: null, requestId, requestIds: [requestId], bodyResponseIds: [null], headerRequestIds: [null],
        requestIdSource: "local", redirectPolicy: "local", redirected: false, routeTupleVerified: true, evidenceComplete: true, unverifiedReasons: [], verificationStatus: "local", observations: [], peerVerification: "local", proxyVerification: "local",
      },
    };
  }
}

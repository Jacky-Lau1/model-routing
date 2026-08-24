import os from "node:os";
import path from "node:path";
import { DEFAULT_QUALITY_GATE_POLICY, LocalQualityGate, type QualityGateOptions } from "../quality-gate.js";
import { createQualityGateApprovalBoundary, type TrustedQualityCommandCatalog } from "../quality-gate-config.js";
import { runHiddenAcceptance } from "../hidden-acceptance.js";
import type { ProviderAdapter, ProviderRequest, ProviderResponse, QualityGatePolicy } from "../types.js";
import { LOCAL_ADAPTER_ID } from "../route-preflight.js";

export interface LocalValidationAdapterOptions extends Omit<QualityGateOptions, "policy" | "evidenceRoot" | "runHiddenAcceptance" | "trustedCatalog"> {
  policy?: QualityGatePolicy;
  evidenceRoot?: string;
  trustedCatalog?: TrustedQualityCommandCatalog;
  hiddenRoot?: string | null;
  realPilot?: boolean;
}

export class LocalValidationAdapter implements ProviderAdapter {
  readonly provider = "local" as const;
  readonly adapterId = LOCAL_ADAPTER_ID;
  readonly policy: QualityGatePolicy;
  private readonly gate: LocalQualityGate;

  constructor(private readonly options: LocalValidationAdapterOptions = {}) {
    this.policy = options.policy ?? DEFAULT_QUALITY_GATE_POLICY;
    const evidenceRoot = options.evidenceRoot ?? path.join(os.tmpdir(), "codex-model-router-state");
    const trusted = options.trustedCatalog;
    const commandCatalog = options.commandCatalog ?? trusted?.commands.map(command => ({ command_id: command.command_id, executable: command.executable, args: [...command.argv], timeout_ms: command.timeout_ms }));
    const hiddenRunner = trusted?.commands.some(command => command.visibility === "hidden")
      ? async (request: NonNullable<ProviderRequest["qualityGate"]>, cwd: string) => {
        if (!options.hiddenRoot) throw new Error("Hidden acceptance root is unavailable");
        const boundary = createQualityGateApprovalBoundary({ request, policy: this.policy, catalog: trusted, fixtureHash: request.fixture_hash, hiddenRootHash: request.hidden_root_hash, worktreeRoot: cwd, evidenceRoot: path.resolve(evidenceRoot), realPilot: options.realPilot ?? false });
        return runHiddenAcceptance({ hiddenRoot: path.resolve(options.hiddenRoot), worktreeRoot: cwd, evidenceRoot: path.resolve(evidenceRoot), egressPaths: [], catalog: trusted, boundary });
      }
      : undefined;
    this.gate = new LocalQualityGate({ ...options, policy: this.policy, evidenceRoot, commandCatalog, trustedCatalog: trusted, runHiddenAcceptance: hiddenRunner });
  }

  async preflight(request: ProviderRequest): Promise<void> {
    if (!request.qualityGate || !request.workingDirectory) throw new Error("Local validation requires an approved structured quality-gate request");
    await this.gate.preflight(request.qualityGate, request.workingDirectory);
  }

  async invoke(request: ProviderRequest): Promise<ProviderResponse> {
    if (!request.qualityGate || !request.workingDirectory) throw new Error("Local validation requires an approved structured quality-gate request");
    const boundary = optionsBoundary(this.policy, request.qualityGate, request.workingDirectory, this.options);
    const report = await this.gate.run(request.qualityGate, request.workingDirectory, boundary?.approval_boundary_hash);
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

function optionsBoundary(policy: QualityGatePolicy, request: NonNullable<ProviderRequest["qualityGate"]>, cwd: string, options: LocalValidationAdapterOptions) {
  if (!options.trustedCatalog) return undefined;
  return createQualityGateApprovalBoundary({ request, policy, catalog: options.trustedCatalog, fixtureHash: request.fixture_hash, hiddenRootHash: request.hidden_root_hash, worktreeRoot: cwd, evidenceRoot: path.resolve(options.evidenceRoot ?? path.join(os.tmpdir(), "codex-model-router-state")), realPilot: options.realPilot ?? false });
}

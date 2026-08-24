import { stableHash } from "./canonical.js";
import type { ProviderRequest, ProviderResponse } from "./types.js";

/** Canonical provider side-effect fingerprint shared by legacy and S7 core paths. */
export function providerRequestFingerprint(request: ProviderRequest): string {
  const legacyBody = {
    stage: request.stage,
    route: request.route,
    stable_prefix: request.stablePrefix,
    project_summary: request.projectSummary,
    dynamic_input: request.dynamicInput,
    sensitivity: request.sensitivity,
    allowed_files: request.allowedFiles ?? [],
    route_binding: request.routeBinding ?? null,
    executor_capabilities: request.executorCapabilities ?? null,
    quality_gate: request.qualityGate ?? null,
    tools: request.tools ?? [],
  };
  return request.contractProvenance === "canonical"
    ? stableHash({ ...legacyBody, contract_provenance: "canonical" })
    : stableHash(legacyBody);
}

/** Reject any response that does not prove every locally observable bound tuple field. */
export function assertProviderRouteEvidence(request: ProviderRequest, response: ProviderResponse): void {
  const binding = request.routeBinding;
  if (!binding) throw new Error("Provider request did not include a RouteBinding");
  const item = response.routeEvidence;
  if (!item || item.routeBindingHash !== binding.route_binding_hash || item.adapterId !== binding.adapter_id) throw new Error("Provider route evidence was missing or bound to a different adapter");
  if (item.expectedProvider !== binding.provider_id || item.expectedModel !== binding.model_id || item.expectedOrigin !== binding.endpoint_origin || item.expectedPath !== binding.endpoint_path || item.wireProtocol !== binding.wire_protocol || item.authAlias !== binding.auth_alias) throw new Error("Provider route evidence did not match the approved binding");
  if (!item.routeTupleVerified || !item.evidenceComplete || item.verificationStatus !== "route_tuple_verified_peer_unobserved" || item.peerVerification !== "not_observable" || item.proxyVerification !== "not_observable" || item.unverifiedReasons.join("|") !== "network_peer_not_observable|proxy_not_observable" || item.actualOrigin !== binding.endpoint_origin || item.actualPath !== binding.endpoint_path || item.actualModel !== binding.model_id || item.redirected !== false) throw new Error("Provider route tuple was not completely verified");
  if (!item.requestId || item.requestId !== response.requestId || !item.requestIds.includes(item.requestId)) throw new Error("Provider request ID evidence was incomplete");
  const targetUrl = new URL(binding.endpoint_path, `${binding.endpoint_origin}/`).href;
  if (item.requestIds.length !== item.observations.length || item.bodyResponseIds.length !== item.observations.length || item.headerRequestIds.length !== item.observations.length || item.observations.some((observation, index) => !observation.routeTupleVerified || observation.failureReason !== null || observation.targetUrl !== targetUrl || observation.responseUrl !== targetUrl || observation.status === null || observation.status < 200 || observation.status >= 300 || observation.actualOrigin !== binding.endpoint_origin || observation.actualPath !== binding.endpoint_path || observation.actualModel !== binding.model_id || observation.redirected !== false || !observation.requestId || observation.requestId !== item.requestIds[index] || observation.bodyResponseId !== item.bodyResponseIds[index] || observation.headerRequestId !== item.headerRequestIds[index])) throw new Error("One or more provider transport turns lacked complete route evidence");
}

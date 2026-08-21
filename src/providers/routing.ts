import type { ProviderAdapter, ProviderRequest, ProviderResponse } from "../types.js";

export class RoutingProviderAdapter implements ProviderAdapter {
  readonly provider = "openai-codex" as const;
  readonly adapterId = "provider-router";
  private readonly adapters: Map<string, ProviderAdapter>;
  constructor(adapters: Map<string, ProviderAdapter>) { this.adapters = new Map(adapters); }
  preflight(request: ProviderRequest): void | Promise<void> {
    const adapter = this.adapters.get(request.route.provider);
    if (!adapter) throw new Error(`No provider adapter configured for ${request.route.provider}`);
    if (adapter.provider !== request.route.provider) throw new Error("Selected adapter identity does not match the approved provider");
    if (request.routeBinding && adapter.adapterId !== request.routeBinding.adapter_id) throw new Error("Selected adapter ID does not match the approved RouteBinding");
    if (request.routeBinding && !adapter.preflight) throw new Error("Bound provider adapter does not implement route preflight");
    return adapter.preflight?.(request);
  }
  async invoke(request: ProviderRequest): Promise<ProviderResponse> {
    await this.preflight(request);
    const adapter = this.adapters.get(request.route.provider);
    if (!adapter) throw new Error(`No provider adapter configured for ${request.route.provider}`);
    return adapter.invoke(request);
  }
}

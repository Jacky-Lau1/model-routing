import type { ProviderAdapter, ProviderRequest, ProviderResponse } from "../types.js";

export class RoutingProviderAdapter implements ProviderAdapter {
  readonly provider = "openai-codex" as const;
  constructor(private readonly adapters: Map<string, ProviderAdapter>) {}
  invoke(request: ProviderRequest): Promise<ProviderResponse> {
    const adapter = this.adapters.get(request.route.provider);
    if (!adapter) throw new Error(`No provider adapter configured for ${request.route.provider}`);
    return adapter.invoke(request);
  }
}

import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadDeepSeekApiKey } from "./credentials.js";
import { DEFAULT_QUALITY_GATE_POLICY } from "./quality-gate.js";
import { DeepSeekChatAdapter } from "./providers/deepseek-chat.js";
import { LocalValidationAdapter } from "./providers/local.js";
import { RoutingProviderAdapter } from "./providers/routing.js";
import { RouterCoreService, type RouterCoreDependencies, type RouterRouteProfile } from "./router-core.js";
import type { ProjectPolicy, ProviderAdapter, UserPolicy } from "./types.js";

const MAX_CONFIG_BYTES = 1024 * 1024;

export interface RouterRuntimeFileOptions {
  project: string;
  stateRoot: string;
  userPolicy: string;
  projectPolicy: string;
  routeProfile: string;
}

export async function createRouterCoreFromFiles(options: RouterRuntimeFileOptions, overrides: Partial<RouterCoreDependencies> = {}): Promise<RouterCoreService> {
  const [userPolicy, projectPolicy, routeProfile] = await Promise.all([
    readRouterJsonFile(options.userPolicy), readRouterJsonFile(options.projectPolicy), readRouterJsonFile(options.routeProfile),
  ]);
  const stateRoot = path.resolve(options.stateRoot);
  const model = overrides.model_adapter ?? new RoutingProviderAdapter(new Map<string, ProviderAdapter>([[
    "deepseek", new DeepSeekChatAdapter({ credentialResolver: authAlias => loadDeepSeekApiKey(authAlias) }),
  ]]));
  const qualityPolicy = overrides.quality_policy ?? DEFAULT_QUALITY_GATE_POLICY;
  const local = overrides.local_adapter ?? new LocalValidationAdapter({ policy: qualityPolicy, evidenceRoot: stateRoot });
  return new RouterCoreService({
    project_directory: path.resolve(options.project), state_root: stateRoot,
    user_policy: userPolicy as UserPolicy, project_policy: projectPolicy as ProjectPolicy,
    route_profile: routeProfile as RouterRouteProfile,
  }, { ...overrides, model_adapter: model, local_adapter: local, quality_policy: qualityPolicy });
}

export async function readRouterJsonFile(file: string): Promise<unknown> {
  const bytes = await readFile(path.resolve(file));
  if (bytes.length > MAX_CONFIG_BYTES) throw new Error("Router runtime input exceeds the local size limit");
  return JSON.parse(bytes.toString("utf8")) as unknown;
}

import { createFileRoute } from "@tanstack/react-router";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { useEffect } from "react";

import { ProviderSettingsPanel } from "../components/settings/ProviderSettingsPanel";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import {
  parseVercelCallbackSearch,
  vercelCallbackToast,
  withoutVercelCallbackSearch,
} from "../components/settings/VercelAccountSection.logic";
import { toastManager } from "../components/ui/toast";

/**
 * Providers are machine state, so the page shows one environment at a time:
 * the chosen one, or the representative of the selection. A project crumb
 * narrows the candidates to the environments that project is registered on.
 */
function SettingsProvidersRoute() {
  const target = Route.useSearch();
  const navigate = Route.useNavigate();
  const { environment, scope } = useSettingsScope();
  useEffect(() => {
    const flag = parseVercelCallbackSearch(target.vercel);
    if (flag === undefined) return;
    toastManager.add(vercelCallbackToast(flag));
    void navigate({
      search: (previous) => withoutVercelCallbackSearch(previous),
      replace: true,
    });
  }, [navigate, target.vercel]);
  if (!environment) {
    return (
      <p className="p-8 text-sm text-muted-foreground">
        {scope.kind === "environment"
          ? `Reconnect ${scope.label} to set up its providers.`
          : "Connect an environment to set up its providers."}
      </p>
    );
  }
  return (
    <ProviderSettingsPanel
      environmentId={environment.environmentId}
      {...(target.instanceId ? { instanceId: target.instanceId } : {})}
      scoped
    />
  );
}

export const Route = createFileRoute("/settings/providers")({
  validateSearch: (raw: Record<string, unknown>) => {
    const vercel = parseVercelCallbackSearch(raw.vercel);
    return {
      ...(typeof raw.environmentId === "string" && raw.environmentId.trim()
        ? { environmentId: EnvironmentId.make(raw.environmentId) }
        : {}),
      ...(typeof raw.instanceId === "string" && raw.instanceId.trim()
        ? { instanceId: ProviderInstanceId.make(raw.instanceId) }
        : {}),
      ...(vercel !== undefined ? { vercel } : {}),
    };
  },
  component: SettingsProvidersRoute,
});

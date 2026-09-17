import { RefreshIcon } from "~/components/ui/refresh-icon";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { ChevronDownIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { refreshUsageLimits } from "@t3tools/client-runtime/state/usage";

import { isElectron } from "../../env";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Menu, MenuCheckboxItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { UsageLimitsSection } from "./UsageLimits";

export function UsagePage() {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const [selectedEnvironmentIds, setSelectedEnvironmentIds] =
    useState<ReadonlySet<EnvironmentId> | null>(null);
  const [limitsNow, setLimitsNow] = useState(() => Date.now());
  const [isRefreshing, setIsRefreshing] = useState(false);
  const refreshingRef = useRef(false);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });

  const environments = [...presentations].map(([environmentId, presentation]) => ({
    environmentId,
    label: presentation.entry.target.label,
    connected: presentation.connection.phase === "connected" && presentation.serverConfig !== null,
  }));
  const selectedEnvironments =
    selectedEnvironmentIds === null
      ? environments
      : environments.filter((environment) => selectedEnvironmentIds.has(environment.environmentId));

  const refreshLimits = async (automatic = false) => {
    try {
      await Promise.all(
        environments
          .filter(
            (environment) =>
              environment.connected &&
              (selectedEnvironmentIds === null ||
                selectedEnvironmentIds.has(environment.environmentId)),
          )
          .map((environment) =>
            refreshUsageLimits(
              environment.environmentId,
              () => refreshProviders({ environmentId: environment.environmentId, input: {} }),
              automatic,
            ),
          ),
      );
    } finally {
      setLimitsNow(Date.now());
    }
  };

  const refreshWindow = () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setIsRefreshing(true);
    void refreshLimits().finally(() => {
      refreshingRef.current = false;
      setIsRefreshing(false);
    });
  };

  const connectedLimitsEnvironments = environments
    .filter(
      (environment) =>
        environment.connected &&
        (selectedEnvironmentIds === null || selectedEnvironmentIds.has(environment.environmentId)),
    )
    .map((environment) => environment.environmentId)
    .sort()
    .join(",");
  const autoRefreshLimits = useEffectEvent(() => {
    void refreshLimits(true);
  });
  useEffect(() => {
    if (connectedLimitsEnvironments) autoRefreshLimits();
  }, [connectedLimitsEnvironments]);

  const refreshButton = (
    <Button
      onClick={refreshWindow}
      aria-label="Refresh limits"
      aria-busy={isRefreshing}
      disabled={isRefreshing}
      size="icon-sm"
      variant="ghost"
    >
      <RefreshIcon className="size-3.5" refreshing={isRefreshing} />
    </Button>
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron} className="h-auto">
          <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 py-2 xl:flex">
            <WorkspaceBreadcrumb ariaLabel="Usage breadcrumb" className="col-span-2 min-w-0">
              <WorkspaceBreadcrumbItem>
                <h1>Usage</h1>
              </WorkspaceBreadcrumbItem>
              <WorkspaceBreadcrumbSeparator />
              <WorkspaceBreadcrumbItem current className="min-w-10">
                <UsageEnvironmentFilter
                  environments={environments}
                  selectedEnvironments={selectedEnvironments}
                  selectedEnvironmentIds={selectedEnvironmentIds}
                  onSelectionChange={setSelectedEnvironmentIds}
                />
              </WorkspaceBreadcrumbItem>
            </WorkspaceBreadcrumb>
            <div className="ms-auto hidden min-w-0 items-center justify-end gap-2 xl:flex">
              {refreshButton}
            </div>
            <div className="col-span-2 ms-auto flex min-w-0 items-center justify-end gap-1 xl:hidden">
              {refreshButton}
            </div>
          </div>
        </WorkspacePageHeader>

        <ScrollArea className="min-h-0 flex-1">
          <WorkspacePageContainer width="wide">
            {selectedEnvironments.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {environments.length === 0
                  ? "Connect an environment to see limits."
                  : "Select an environment to see limits."}
              </p>
            ) : (
              <UsageLimitsSection selectedEnvironmentIds={selectedEnvironmentIds} now={limitsNow} />
            )}
          </WorkspacePageContainer>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}

function UsageEnvironmentFilter({
  environments,
  selectedEnvironments,
  selectedEnvironmentIds,
  onSelectionChange,
}: {
  readonly environments: readonly {
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }[];
  readonly selectedEnvironments: readonly {
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }[];
  readonly selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
  readonly onSelectionChange: (ids: ReadonlySet<EnvironmentId> | null) => void;
}) {
  const allSelected = selectedEnvironmentIds === null;
  const label = allSelected
    ? "All environments"
    : selectedEnvironments.length === 1
      ? selectedEnvironments[0]!.label
      : `${selectedEnvironments.length} environments`;

  return (
    <Menu>
      <MenuTrigger className="group/usage-environment inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1 rounded-sm text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring">
        <span className="min-w-0 truncate">{label}</span>
        <span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
          <ChevronDownIcon
            className="size-3.5 opacity-0 transition-opacity group-hover/usage-environment:opacity-100 group-focus-visible/usage-environment:opacity-100 group-data-popup-open/usage-environment:opacity-100"
            aria-hidden
          />
        </span>
      </MenuTrigger>
      <MenuPopup align="start" className="w-80 max-w-[calc(100vw-2rem)]">
        <MenuCheckboxItem
          checked={allSelected}
          closeOnClick={false}
          onCheckedChange={(checked) => onSelectionChange(checked ? null : new Set())}
        >
          All environments
        </MenuCheckboxItem>
        <MenuSeparator />
        {environments.map((environment) => {
          const checked =
            selectedEnvironmentIds === null ||
            selectedEnvironmentIds.has(environment.environmentId);
          return (
            <MenuCheckboxItem
              key={environment.environmentId}
              checked={checked}
              closeOnClick={false}
              className="grid-cols-[1rem_minmax(0,1fr)]"
              onCheckedChange={(nextChecked) => {
                const next = new Set(selectedEnvironments.map((entry) => entry.environmentId));
                if (nextChecked) next.add(environment.environmentId);
                else next.delete(environment.environmentId);
                onSelectionChange(next.size === environments.length ? null : next);
              }}
            >
              <span className="min-w-0 truncate">{environment.label}</span>
            </MenuCheckboxItem>
          );
        })}
        {environments.length === 0 ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">No environments connected.</p>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

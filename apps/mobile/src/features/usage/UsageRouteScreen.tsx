import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { EnvironmentId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { useCallback, useLayoutEffect, useMemo, useState } from "react";
import { Platform, Pressable, RefreshControl, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { environmentPresentations } from "../../state/presentation";
import { ControlPillMenu } from "../../components/ControlPill";
import { SymbolView } from "../../components/AppSymbol";
import { toggleUsageEnvironment } from "./usageEnvironmentSelection";
import { useRefreshLimits } from "./UsageLimitsSection";
import { UsageLimitsSection } from "./UsageLimitsPooled";

export function UsageRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const [selectedEnvironmentIds, setSelectedEnvironmentIds] =
    useState<ReadonlySet<EnvironmentId> | null>(null);
  const environments = [...presentations].map(([environmentId, presentation]) => ({
    environmentId,
    label: presentation.entry.target.label,
  }));
  const limits = useRefreshLimits(selectedEnvironmentIds, true);

  const showEnvironmentFilter = environments.length > 0 || selectedEnvironmentIds !== null;
  const filterAccessibilityLabel = "Filter usage environments";
  const filterIcon =
    selectedEnvironmentIds === null
      ? "line.3.horizontal.decrease"
      : "line.3.horizontal.decrease.circle.fill";
  const environmentActions = useMemo(
    () => [
      {
        id: "all",
        title: "All environments",
        subtitle: undefined,
        state: selectedEnvironmentIds === null ? ("on" as const) : ("off" as const),
      },
      ...environments.map((environment) => ({
        id: environment.environmentId,
        title: environment.label,
        subtitle: undefined,
        state:
          selectedEnvironmentIds === null || selectedEnvironmentIds.has(environment.environmentId)
            ? ("on" as const)
            : ("off" as const),
      })),
    ],
    [environments, selectedEnvironmentIds],
  );
  const selectEnvironment = useCallback(
    (value: string) => {
      if (value === "all") {
        setSelectedEnvironmentIds(null);
        return;
      }
      const id = EnvironmentId.make(value);
      setSelectedEnvironmentIds((selected) => toggleUsageEnvironment(selected, environments, id));
    },
    [environments],
  );
  const environmentFilter = useMemo(
    () =>
      showEnvironmentFilter ? (
        <ControlPillMenu
          accessible
          accessibilityRole="button"
          accessibilityLabel={filterAccessibilityLabel}
          title="Environments"
          actions={environmentActions}
          onPressAction={({ nativeEvent }) => selectEnvironment(nativeEvent.event)}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={filterAccessibilityLabel}
            className={cn(
              "items-center justify-center rounded-full",
              Platform.OS === "ios" ? "size-[28px]" : "size-[44px]",
            )}
          >
            <SymbolView name={filterIcon} size={22} tintColorClassName="accent-icon" />
          </Pressable>
        </ControlPillMenu>
      ) : null,
    [showEnvironmentFilter, environmentActions, selectEnvironment, filterIcon],
  );

  useLayoutEffect(() => {
    if (Platform.OS === "ios") {
      navigation.setOptions({ headerRight: () => environmentFilter });
    }
  }, [navigation, environmentFilter]);

  return (
    <SettingsScreen title="Usage" trailing={environmentFilter}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        refreshControl={
          <RefreshControl refreshing={limits.refreshing} onRefresh={() => void limits.refresh()} />
        }
      >
        {environments.length === 0 ? (
          <Text className="py-16 text-center text-base text-foreground-muted">
            Connect an environment to see limits.
          </Text>
        ) : (
          <UsageLimitsSection
            now={limits.now}
            failedLabels={limits.failedLabels}
            selectedEnvironmentIds={selectedEnvironmentIds}
          />
        )}
        <View />
      </ScrollView>
    </SettingsScreen>
  );
}

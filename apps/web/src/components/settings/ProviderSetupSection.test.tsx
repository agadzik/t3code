import { type FunctionComponent, type ReactElement } from "react";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderAuthState,
  type ProviderInstallState,
  type ServerProvider,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const setup = vi.hoisted(() => ({
  auth: null as ProviderAuthState | null,
  installation: null as ProviderInstallState | null,
  authState: vi.fn(() => "auth"),
  installState: vi.fn(() => "installation"),
  startAuth: vi.fn(),
  completeAuth: vi.fn(),
  cancelAuth: vi.fn(),
  logoutAuth: vi.fn(),
  startInstall: vi.fn(),
  cancelInstall: vi.fn(),
  removeInstall: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("../../state/server", () => ({
  serverEnvironment: {
    providerAuthState: setup.authState,
    providerInstallState: setup.installState,
    startProviderAuth: setup.startAuth,
    completeProviderAuth: setup.completeAuth,
    cancelProviderAuth: setup.cancelAuth,
    logoutProviderAuth: setup.logoutAuth,
    startProviderInstall: setup.startInstall,
    cancelProviderInstall: setup.cancelInstall,
    removeProviderInstallation: setup.removeInstall,
  },
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => command,
}));

vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: string) => ({
    data: atom === "auth" ? setup.auth : setup.installation,
    error: null,
    isPending: false,
    refresh: vi.fn(),
  }),
}));

vi.mock("../../localApi", () => ({
  ensureLocalApi: () => ({ dialogs: { confirm: setup.confirm } }),
}));

import { ProviderSetupSection } from "./ProviderSetupSection";

const environmentId = EnvironmentId.make("remote-device");
const instanceId = ProviderInstanceId.make("testDriver_work");
const provider: ServerProvider = {
  instanceId,
  driver: ProviderDriverKind.make("testDriver"),
  installed: true,
  enabled: true,
  version: "test-version",
  status: "error",
  auth: { status: "unauthenticated" },
  checkedAt: "2026-09-02T00:00:00.000Z",
  models: [],
  skills: [],
  slashCommands: [],
  setup: { canAuthenticate: true, canInstall: true },
};

function authState(patch: Partial<ProviderAuthState> = {}): ProviderAuthState {
  return {
    instanceId,
    phase: "idle",
    flowId: null,
    authorizationUrl: null,
    expiresAt: null,
    message: null,
    ...patch,
  };
}

function renderSetup(
  options: {
    readOnly?: boolean;
    provider?: ServerProvider;
    enabled?: boolean;
  } = {},
) {
  hooks.beginRender();
  const view = ProviderSetupSection({
    environmentId,
    environmentLabel: "Remote device",
    instanceId,
    provider: options.provider ?? provider,
    enabled: options.enabled ?? true,
    readOnly: options.readOnly ?? false,
    onEnable: vi.fn(),
  });
  const actions = visitElements(
    view,
    (element) =>
      typeof element.type === "function" &&
      element.props.environmentId === environmentId &&
      element.props.instanceId === instanceId,
  );
  if (!actions) return view;
  const Actions = actions.type as FunctionComponent<Record<string, unknown>>;
  return Actions(actions.props) as ReactElement<Record<string, unknown>>;
}

function button(view: unknown, label: string) {
  return visitElements(
    view,
    (element) =>
      (element.props.children === label || element.props["aria-label"] === label) &&
      typeof element.props.onClick === "function",
  );
}

describe("Provider setup", () => {
  beforeEach(() => {
    hooks.reset();
    vi.clearAllMocks();
    setup.auth = authState();
    setup.installation = {
      driver: ProviderDriverKind.make("testDriver"),
      operationId: null,
      phase: "idle",
      downloadedBytes: 0,
      totalBytes: null,
      version: null,
      installedVersion: null,
      canRemove: false,
      message: null,
    };
    for (const command of [
      setup.startAuth,
      setup.completeAuth,
      setup.cancelAuth,
      setup.logoutAuth,
      setup.startInstall,
      setup.cancelInstall,
      setup.removeInstall,
    ]) {
      command.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
    }
    setup.confirm.mockReset().mockResolvedValue(false);
  });

  it("starts auth on the selected environment", () => {
    const view = renderSetup();
    const target = button(view, "Sign in");
    expect(target).not.toBeNull();
    (target?.props.onClick as () => void)();
    expect(setup.startAuth).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId },
    });
  });

  it.each(["read-only", "older-server"] as const)(
    "does not open private setup subscriptions for a %s view",
    (mode) => {
      const { setup: _setup, ...olderProvider } = provider;
      renderSetup(mode === "read-only" ? { readOnly: true } : { provider: olderProvider });
      expect(setup.authState).not.toHaveBeenCalled();
      expect(setup.installState).not.toHaveBeenCalled();
      expect(setup.startAuth).not.toHaveBeenCalled();
    },
  );
});

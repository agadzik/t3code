import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId } from "@t3tools/contracts";
import { useRef, useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { searchableSetting } from "./settingsSearch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import {
  resolveVercelAuthStatus,
  sameOriginVercelAuthorizePath,
  vercelAccountView,
} from "./VercelAccountSection.logic";

export function VercelAccountSection({
  environmentId,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly readOnly: boolean;
}) {
  const target = { environmentId, input: {} };
  const statusQuery = useEnvironmentQuery(serverEnvironment.vercelAuthStatus(target));
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const view = vercelAccountView(
    resolveVercelAuthStatus({
      query: statusQuery.data,
      fromConfig: config?.vercelAuth,
    }),
  );
  const commandOptions = { reportFailure: false, reportDefect: false };
  const startAuth = useAtomCommand(serverEnvironment.startVercelAuth, commandOptions);
  const logoutAuth = useAtomCommand(serverEnvironment.logoutVercelAuth, commandOptions);
  const setApiToken = useAtomCommand(serverEnvironment.setVercelApiToken, commandOptions);
  const setGatewayKey = useAtomCommand(serverEnvironment.setVercelGatewayKey, commandOptions);
  const [pendingLabel, setPendingLabel] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [gatewayDraft, setGatewayDraft] = useState("");
  const [apiTokenDraft, setApiTokenDraft] = useState("");

  async function runCommand<A, E>(
    label: string,
    request: () => Promise<AtomCommandResult<A, E>>,
  ): Promise<A | undefined> {
    if (pendingRef.current) return undefined;
    pendingRef.current = true;
    setPendingLabel(label);
    setActionError(null);
    try {
      const result = await request();
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const failure = squashAtomCommandFailure(result);
          setActionError(
            failure instanceof Error ? failure.message : "Vercel account request failed.",
          );
        }
        return undefined;
      }
      statusQuery.refresh();
      return result.value;
    } catch {
      setActionError("Vercel account request failed. Try again.");
      return undefined;
    } finally {
      pendingRef.current = false;
      setPendingLabel(null);
    }
  }

  const actionsDisabled = readOnly || pendingLabel !== null;
  const queryError = statusQuery.error;
  const disconnectedError =
    view.kind === "disconnected"
      ? (view.error ?? actionError ?? queryError)
      : (actionError ?? queryError);

  return (
    <SettingsSection {...searchableSetting("vercel-account")}>
      {view.kind === "unknown" ? (
        <SettingsRow title="Vercel account" description="Reading Vercel account." />
      ) : null}
      {view.kind === "pending" ? (
        <SettingsRow title="Vercel account" description="Finish sign-in in the browser." />
      ) : null}
      {view.kind === "disconnected" ? (
        <SettingsRow
          title="Vercel account"
          description={
            disconnectedError ?? "Connect a Vercel account for AI Gateway and API access."
          }
          control={
            readOnly ? undefined : (
              <Button
                size="sm"
                disabled={actionsDisabled}
                onClick={() => {
                  void (async () => {
                    const started = await runCommand("Starting Vercel sign-in", () =>
                      startAuth(target),
                    );
                    if (started === undefined) return;
                    const href = sameOriginVercelAuthorizePath(started.authorizationUrl);
                    if (href === null) {
                      setActionError("Sign-in URL was not on this server.");
                      return;
                    }
                    window.location.assign(href);
                  })();
                }}
              >
                {pendingLabel === "Starting Vercel sign-in"
                  ? "Starting sign-in"
                  : "Sign in with Vercel"}
              </Button>
            )
          }
        />
      ) : null}
      {view.kind === "connected" ? (
        <>
          <SettingsRow
            title={view.heading}
            description={view.username ?? "Signed in with Vercel."}
            control={
              readOnly ? undefined : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={actionsDisabled}
                  onClick={() => {
                    void runCommand("Signing out", () => logoutAuth(target));
                  }}
                >
                  {pendingLabel === "Signing out" ? "Signing out" : "Sign out"}
                </Button>
              )
            }
          />
          <VercelSecretRow
            title="AI Gateway key"
            description={view.hasGatewayKey ? "provisioned" : "not configured"}
            inputId="vercel-gateway-key"
            hasSecret={view.hasGatewayKey}
            value={gatewayDraft}
            onValueChange={setGatewayDraft}
            disabled={actionsDisabled}
            pending={pendingLabel === "Saving AI Gateway key"}
            onSet={() => {
              const key = gatewayDraft.trim();
              if (key.length === 0) return;
              void (async () => {
                const saved = await runCommand("Saving AI Gateway key", () =>
                  setGatewayKey({ environmentId, input: { key } }),
                );
                if (saved !== undefined) setGatewayDraft("");
              })();
            }}
          />
          <VercelSecretRow
            title="Vercel API token"
            description={view.hasApiToken ? "set" : "not set"}
            inputId="vercel-api-token"
            hasSecret={view.hasApiToken}
            value={apiTokenDraft}
            onValueChange={setApiTokenDraft}
            disabled={actionsDisabled}
            pending={pendingLabel === "Saving Vercel API token"}
            onSet={() => {
              const token = apiTokenDraft.trim();
              if (token.length === 0) return;
              void (async () => {
                const saved = await runCommand("Saving Vercel API token", () =>
                  setApiToken({ environmentId, input: { token } }),
                );
                if (saved !== undefined) setApiTokenDraft("");
              })();
            }}
          />
          {actionError !== null || queryError !== null ? (
            <SettingsRow title="Vercel account" description={actionError ?? queryError} />
          ) : null}
        </>
      ) : null}
    </SettingsSection>
  );
}

function VercelSecretRow({
  title,
  description,
  inputId,
  hasSecret,
  value,
  onValueChange,
  disabled,
  pending,
  onSet,
}: {
  readonly title: string;
  readonly description: string;
  readonly inputId: string;
  readonly hasSecret: boolean;
  readonly value: string;
  readonly onValueChange: (next: string) => void;
  readonly disabled: boolean;
  readonly pending: boolean;
  readonly onSet: () => void;
}) {
  return (
    <SettingsRow
      title={<label htmlFor={inputId}>{title}</label>}
      description={description}
      control={
        disabled && !pending ? undefined : (
          <div className="flex w-full min-w-0 items-center gap-2 sm:w-56">
            <Input
              id={inputId}
              size="sm"
              type="password"
              autoComplete="off"
              spellCheck={false}
              className="min-w-0 flex-1"
              value={value}
              placeholder={hasSecret ? "••••••••" : undefined}
              disabled={disabled}
              onChange={(event) => onValueChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") onSet();
              }}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={disabled || value.trim().length === 0}
              onClick={onSet}
            >
              {pending ? "Saving" : "Set"}
            </Button>
          </div>
        )
      }
    />
  );
}

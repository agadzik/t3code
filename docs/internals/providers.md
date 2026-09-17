# Provider constraints

Orchestration records intent and state without knowing which provider runs a
thread. Provider protocols, account ownership, permissions, and capabilities
belong at the
[adapter boundary](../../apps/server/src/provider/Services/ProviderAdapter.ts).
Normalize there instead of spreading provider checks through reactors and
clients.

A driver kind identifies an integration. An instance identifies one
configuration and account lifecycle. Route work by instance, so two accounts
using the same driver do not share mutable session or catalog state.

Driver availability is discovered through the runtime registry. `ProviderDriverKind`
is an open branded slug. Unknown drivers must parse and then be marked
unavailable rather than crashing.

## Process and account isolation

Each instance owns its session and catalog state. Sharing a helper process
across instances is only safe when the helper cannot mutate another instance's
account, credentials, or approvals.

## Setup must not happen as a health-check side effect

Opening a provider session can start MCP servers, run hooks, or launch a login
browser. Background probes should avoid authentication and session creation.
Authenticated catalog sessions belong to explicit setup or model refresh.

Sign-in belongs to the initiating T3 auth session. The client carries a return
URL back to the environment because the provider's loopback listener may be on
another machine. A successful callback HTTP request is not proof that provider
authentication finished.

Sign-out closes admission to new processes and stops existing processes before
clearing account metadata. Cached model lists do not establish current access.
An authoritative empty catalog must clear the old list.

## Provider updates run only through the owning installer

A one-click update is offered only when the resolved executable's path proves
which installer owns it. Anything unproven stays manual-only but still reports
the version gap. Ownership is cached per instance and re-read immediately
before an update runs. The
[runner](../../apps/server/src/provider/providerMaintenanceRunner.ts) refuses
when the lock key changed since the advisory, and reports success only when the
refreshed provider is still installed with a readable, current version.

## Protocol traps

Async questions can outlive the turn or a server restart. The engine reads that
request's durable activity before resolving it because the in-memory command
snapshot omits old activities. Do not infer that a request has disappeared
merely because it is outside the recent window.

Capabilities must describe what the provider can actually do. Native permission
and question option IDs must survive normalization. A display label is not
necessarily a valid reply.

## Attachments and stored history

Attachments live outside the project workspace.
[ProviderService](../../apps/server/src/provider/Layers/ProviderService.ts)
puts their environment-local paths in turn input and lets adapters choose
native input formats. A path in the prompt does not grant filesystem access.
Keep provider sandbox and approval rules in force.

File attachments introduced a replay compatibility limit. Image-only clients
cannot decode file-bearing messages, and an image-only server can fail the
entire environment's startup when replaying one such event. Rollouts and
downgrades must account for persisted history as well as current client
support.

Model classification has its own [manifest constraints](./model-manifest.md).
Assistant-reference handling is documented under
[citations](./assistant-citations.md).

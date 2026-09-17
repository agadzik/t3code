# Providers

A provider is the agent runtime T3 Code talks to. A provider instance is one
configured copy of that runtime, with its own settings and lifecycle. You can
run more than one instance of the same driver.

Zero instances is a valid state. The composer cannot send until at least one
instance is ready.

## Add an instance

Open Settings, then Providers. Choose the environment that should host the
instance, then add an instance. The form asks for a driver, an optional label,
and optional driver settings.

Instance ids are slugs. T3 Code builds them from the driver and label, for
example `fx_work`. You can override the id before saving.

## Use an instance

Pick the instance and model in the composer. Threads remember the instance they
started with. If that instance is later disabled or removed, T3 Code falls back
to another ready instance or shows that no provider is available.

## Set up and sign in

If a driver supports install or sign-in, the instance editor shows a setup
section. Use it to install the runtime or authenticate. Those actions run on
the selected environment through `provider.auth.*` RPCs.

## Updates

When an instance reports a newer version and T3 Code can prove which installer
owns the binary, Settings offers an update. Otherwise update the runtime
yourself, then refresh provider status.

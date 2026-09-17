# Providers

This fork talks to one agent runtime: fx. An fx instance is one configured copy of that runtime, with its own model and gateway key. You can add more than one instance.

The composer cannot send until at least one instance is ready.

## Add an fx instance

1. Open Settings, then Providers.
2. Sign in with Vercel in the Vercel account section.
3. Choose the environment that should host the instance, then add an instance.
4. Select **fx**. Give it an optional label. Instance ids are slugs such as `fx_work`. You can override the id before saving.
5. Optionally set a default model. The gateway key is not a form field.

After you save, open the instance. Add `FX_API_KEY` as a sensitive environment variable if you did not sign in with Vercel.

## Choose a model

Pick the instance and model in the composer. Threads remember the instance they started with. If that instance is later disabled or removed, T3 Code falls back to another ready instance or shows that no provider is available.

## Gateway key

Sign in with Vercel in the Vercel account section to provision the gateway key. You can also set `FX_API_KEY` on the instance environment and mark it sensitive. The key never lives in the instance config blob.

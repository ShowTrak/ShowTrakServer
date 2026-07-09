# @showtrak/protocol

Shared **wire-protocol type definitions** for the ShowTrak platform — the payload
shapes exchanged over Socket.IO between:

- **ShowTrak Server** (control plane)
- **ShowTrak Client** (endpoint agent)
- **ShowTrak SDKs** (e.g. the Android integration SDK)

## Why this folder exists

These types are authored as ambient TypeScript declaration files (`.d.ts`) with
**no runtime code**. That keeps them:

- **Reusable** — any TypeScript project can consume them as-is.
- **Portable** — this folder is structured so it can later be extracted into its
  own repository and re-added to each app as a **git submodule**, giving every
  ShowTrak surface a single source of truth for the protocol.
- **Safe to import** — because they contain only types, `import type { ... }`
  statements are fully erased at compile time (no runtime dependency).

## Usage (within ShowTrakServer today)

The server `tsconfig.json` maps the package name to this folder:

```jsonc
"paths": {
  "@showtrak/protocol": ["shared/src/index.d.ts"],
  "@showtrak/protocol/*": ["shared/src/*"]
}
```

Consume with **type-only imports**:

```ts
import type { HeartbeatPayload, Vitals } from '@showtrak/protocol';
```

## Layout

```text
shared/
  package.json          # @showtrak/protocol (types-only)
  tsconfig.json         # standalone type-check config
  src/
    index.d.ts          # barrel re-export
    common.d.ts         # shared primitives (MacAddressMap, etc.)
    vitals.d.ts         # CPU / RAM / uptime telemetry
    telemetry.d.ts      # heartbeat, system info, USB, displays, network, apps
    adoption.d.ts       # adoption handshake + lifecycle
    integrated.d.ts     # integrated-client actions / state (SDK surface)
    execution.d.ts      # script / event execution contracts
    events.d.ts         # Socket.IO client<->server event maps
```

## Future extraction

When migrating other apps/SDKs, move this `shared/` folder to a dedicated repo
(e.g. `ShowTrak-Protocol`) and add it back to each project as a submodule at the
same relative path, preserving the `@showtrak/protocol` path mapping.

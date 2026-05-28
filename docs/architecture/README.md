# openSlate architecture notes

Reference docs for the load-bearing pieces of openSlate. Read these
before refactoring anything they describe.

- [`osl-bundle.md`](./osl-bundle.md) — the `.osl` project bundle format.
  The cross-surface contract. Lets a project move freely between
  MCP/CLI, Mac app, and webapp.
- [`dual-renderer.md`](./dual-renderer.md) — the Remotion (export) +
  PixiJS (preview) split, the parity contract, and where the shared
  camera math lives.

See `NOTICE.md` for attributions of third-party patterns referenced
during the build.

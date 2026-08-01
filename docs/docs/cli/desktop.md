---
sidebar_position: 4
---

# Windows Desktop Control Plane

The desktop application provides a local control plane for Claude Code Router on Windows. It supervises the router process, keeps it available from the system tray, and provides a configuration workspace.

## Development startup

From the repository root, run:

```bat
start-desktop.bat
```

The launcher builds `@CCR/shared` and `@CCR/server`, then starts `@CCR/desktop`.

## Lifecycle

- Closing the window hides it to the system tray. The router process stays available.
- Use the tray menu or the dashboard to start, stop, or restart the router.
- The dashboard reports **Running** only after `GET /health` succeeds. A spawned process alone is not considered healthy.
- Exiting from the tray stops the desktop-owned router process.

## Configuration workspace

The workspace reads `~/.claude-code-router/config.json` through the desktop main process.

- API keys and other sensitive fields are displayed as `[configured]`; their raw values are not sent to the renderer.
- Saving creates a timestamped backup and uses a temporary file plus atomic rename.
- A stale revision is rejected instead of overwriting newer changes written by another process.
- The advanced editor preserves unknown fields, but saving rewrites the document as standard JSON. JSON5 comments and trailing commas are not preserved.
- Use **Save and restart** for configuration changes to take effect. The result is successful only after the restarted service passes its health check.

## Security boundary

The Electron renderer has no Node.js access. It can only call a small preload API for service status, lifecycle controls, configuration snapshots, configuration writes, and opening the CCR log directory.
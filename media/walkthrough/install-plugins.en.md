# Install AT capability plugins (zero MCP config)

The agent gets its evidence-gathering abilities from **AT Series capability plugins**: install them and they just work — **no MCP configuration files needed**.

## 1. Install the plugins

Search the Extension Marketplace and install the AT plugins your environment uses:

- **AT Terminal** — connect to hosts / bastion servers for read-only evidence gathering (`Ctrl+Shift+X`, search `AT Terminal`).
- **AT Grafana** — query metric dashboards and alerts.
- Others like AT Jenkins and AT Nacos are available too; install what you need.

## 2. No configuration required

Once installed, plugins **register automatically** with the agent through the in-process hub:

- No `mcp.json`, no command-line arguments, no VS Code restart.
- Each plugin keeps its own login credentials. The agent can only call the tools the plugin exposes — it **never sees your passwords or tokens**.
- Write and exec operations always go through in-IDE approval first, and the plugin may ask you to confirm again.

## 3. Verify the connection

Open [Settings → Capability plugins](command:atOpsAgent.openSettings). The plugins you just installed should be listed with their health status and tool counts.

Not showing up? Run [Refresh bridges](command:atOpsAgent.refreshBridges) to rescan, or [Diagnose hub](command:atOpsAgent.diagnoseHub) to see step-by-step connection logs.

## Done when

Back in chat, ask "which capability plugins are available in my environment?" — the agent lists the connected plugins and their tools.

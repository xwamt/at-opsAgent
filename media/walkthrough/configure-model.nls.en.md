# Configure a model (about 1 minute)

AT Ops Agent needs an LLM before it can start troubleshooting with you. Setup takes three steps and about one minute.

## 1. Open model settings

Click [Open model settings](command:atOpsAgent.openModels), or run **AT Ops Agent: Open Models** from the Command Palette (`Ctrl+Shift+P`).

## 2. Pick a provider and paste your API key

- Choose your service from the presets: **internal company gateway (OpenAI-compatible)**, OpenAI, Anthropic (browser sign-in, no key to paste), Qwen / DeepSeek, or custom.
- Picking a preset pre-fills the Base URL and API flavor — usually all you need is to paste the **API key** and confirm the model ID (e.g. `qwen3-max`).
- Not sure which one? Ask your platform team; it is usually the internal gateway.

> 🔒 Your key is stored only in VS Code SecretStorage. `models.json` on disk keeps a `${secret:…}` placeholder — the key never appears in plaintext or in logs.

## 3. Verify and save

Click **Verify & Save**. The extension immediately runs a connectivity test:

- ✓ Success: shows "connected" with the first-token latency, and the config takes effect right away.
- ✗ Failure: the error is shown inline in plain language — `401` means the key is invalid or expired; for network errors check the Base URL and proxy settings. Fix and retry here instead of finding out later in chat.

## Done when

Back in the chat view, the model selector in the composer now lists your model. Send "introduce yourself in one sentence" and watch the reply **stream in token by token** — that's a successful setup.

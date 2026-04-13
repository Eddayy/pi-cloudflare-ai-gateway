# Cloudflare Workers AI — Pi Extension

Adds Cloudflare Workers AI models to the [Pi coding agent](https://github.com/badlogic/pi-mono). Models are fetched dynamically from the Cloudflare API at startup, so you always get the full up-to-date catalog without any hardcoded list.

## Installation

1. Copy this directory into your Pi extensions folder:

   ```
   ~/.pi/agent/extensions/cloudflare-ai-gateway/
   ```

2. Start Pi and run the setup command:

   ```
   /cloudflare-setup
   ```

3. Pi will prompt you for your credentials one by one (see [Configuration](#configuration) below). After the last step it saves `config.json` and reloads automatically.

4. Use `/model` to switch to any Workers AI model.

## Configuration

Run `/cloudflare-setup` inside Pi to configure interactively. You will be asked for:

| Field | Description |
|---|---|
| **Cloudflare Account ID** | Found in the Cloudflare dashboard → right sidebar |
| **AI Gateway name** | The slug of your AI Gateway (create one at dash.cloudflare.com → AI → AI Gateway) |
| **Cloudflare API token** | Create at dash.cloudflare.com → Profile → API Tokens — needs **Workers AI** read/run permissions |
| **Gateway auth token** | Only required if your gateway has authentication enabled; leave empty otherwise |

Credentials are saved to `config.json` next to `index.ts`. This file is gitignored — use `config.example.json` as a reference.

### Manual configuration

Instead of the interactive command, you can copy `config.example.json` to `config.json` and fill in the values directly:

```json
{
  "accountId": "your-cloudflare-account-id",
  "gatewayName": "your-ai-gateway-slug",
  "apiToken": "your-cloudflare-api-token",
  "gatewayToken": ""
}
```

Then `/reload` Pi to apply.

### Environment variable fallbacks

If you prefer not to use `config.json`, all fields can be set via environment variables:

| Env var | Config field |
|---|---|
| `CF_ACCOUNT_ID` | `accountId` |
| `CF_GATEWAY_NAME` | `gatewayName` |
| `CF_API_TOKEN` | `apiToken` |
| `CF_GATEWAY_TOKEN` | `gatewayToken` |

## How it works

On startup the extension calls:

```
GET https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/models/search?task=Text+Generation
```

and maps the results into Pi's provider format. Pricing and context window sizes come directly from the API response, so they stay accurate as Cloudflare updates their catalog.

All requests are routed through your AI Gateway, giving you observability, caching, and rate limiting in the Cloudflare dashboard.

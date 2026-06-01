# Aspire Foundry Copilot SDK E2E

End-to-end sample that runs a browser chat app against a Microsoft Foundry hosted agent backed by the GitHub Copilot SDK.

The Aspire AppHost wires together:

| Resource | Path | Purpose |
| --- | --- | --- |
| `agentweb` | `web/` | React + Vite chat UI. |
| `apiservice` | `apiservice/` | .NET gateway that serves the web app, owns browser sessions, and calls the hosted agent through Foundry. |
| `agent-ha` | `api/` | Node.js Express hosted-agent endpoint that runs the Copilot SDK with an Azure Foundry model provider. |
| `foundry` / `project` / `chat` | `apphost/apphost.mts` | Foundry account, project, and GPT-5 deployment referenced by the hosted agent. |
| `aca` | `apphost/apphost.mts` | Azure Container Apps environment used for published compute. |

## Prerequisites

- [.NET 10 SDK](https://dotnet.microsoft.com/en-us/download/dotnet/10.0)
- [Node.js](https://nodejs.org/en) 22.20 or later for the hosted-agent API
- [Aspire CLI](https://aspire.dev/reference/cli/overview/) 13.4
- Azure credentials available to `DefaultAzureCredential` with access to Azure AI Foundry, for example through `az login`

## Run locally

Start the distributed app from the repository root:

```bash
aspire start
```

Open the Aspire dashboard URL printed by the CLI, then launch the `agentweb` endpoint. The UI creates an HttpOnly browser identity cookie, keeps the user-visible transcript in `localStorage`, and asks `apiservice` to invoke the Foundry hosted agent.

## How requests flow

1. The browser posts chat messages to `apiservice` at `/invocations`.
2. `apiservice` maps the browser cookie to a server-side Foundry agent session id and calls `agent-ha` through Aspire service discovery.
3. Foundry routes the call to the hosted-agent sandbox using `agent_session_id`.
4. `agent-ha` sends the prompt to the Copilot SDK using the configured Foundry model deployment and returns the assistant response.

The Foundry session id is never exposed to the browser. `/session/reset` rotates the browser identity so the UI can test an isolated user conversation.

## Configuration notes

The AppHost injects the Foundry model reference into `agent-ha` through environment variables such as `CHAT_URI`, `CHAT_AIINFERENCEURI`, `CHAT_MODELNAME`, and `ConnectionStrings__chat`. The hosted-agent API also accepts these overrides when run outside Aspire:

| Variable | Used by | Description |
| --- | --- | --- |
| `FOUNDRY_PROJECT_ENDPOINT` | `api/` | Explicit Foundry project OpenAI endpoint. |
| `COPILOT_PROVIDER_BASE_URL` | `api/` | Alternate explicit provider endpoint. |
| `FOUNDRY_PROJECT_NAME` | `api/`, `apphost/` | Project name used when deriving the project endpoint. Defaults to `project`. |
| `COPILOT_MODEL_ID` | `api/`, `apphost/` | Copilot SDK model id. Defaults to the Foundry deployment name. |
| `COPILOT_LOG_LEVEL` | `api/` | Copilot SDK log level. Defaults to `info`. |

## Deployment

Deploy the app from the repository root:

```bash
aspire deploy
```

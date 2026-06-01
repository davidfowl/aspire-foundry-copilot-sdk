import express from 'express';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { CopilotClient, approveAll } from '@github/copilot-sdk';
import { DefaultAzureCredential } from '@azure/identity';

const app = express();
const port = Number.parseInt(process.env.PORT ?? '8088', 10);

const workingDirectory = os.tmpdir();
const copilotHome = path.join(workingDirectory, '.copilot-hosted-agent');
const sessions = new Map();
const sessionLocks = new Map();

// withReference(model) injects CHAT_URI, CHAT_AIINFERENCEURI, CHAT_MODELNAME, and a flattened
// ConnectionStrings__chat value. The Copilot SDK BYOK provider needs the Foundry project OpenAI
// endpoint, so local/Aspire runs derive it from CHAT_URI/EndpointAIInference and the project name;
// hosted Foundry can also provide FOUNDRY_PROJECT_ENDPOINT directly.
function parseConnectionString(cs) {
  const out = {};
  if (!cs) {
    return out;
  }
  for (const part of cs.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) {
      continue;
    }
    out[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
  }
  return out;
}

const conn = parseConnectionString(process.env['ConnectionStrings__chat']);
const deploymentName = process.env['CHAT_MODELNAME'] ?? conn['deployment'] ?? 'chat';
const copilotModelId = process.env.COPILOT_MODEL_ID ?? deploymentName;
const credential = new DefaultAzureCredential();
let client;
let providerConfig;
let providerTokenExpiresOn = 0;

app.use(express.json({ limit: '1mb' }));
app.use(express.text({ type: 'text/*', limit: '1mb' }));

function getSessionId(req) {
  // Foundry routes an invocation to a sandbox by the ?agent_session_id=<id> QUERY STRING parameter and
  // sets FOUNDRY_AGENT_SESSION_ID inside the resulting sandbox. Body fields (session_id) and headers
  // (x-ms-foundry-session-id / x-session-id) are forwarded to us untouched but do NOT influence routing,
  // so they are spoofable and must not be trusted as the session key. We therefore treat the platform's
  // env var as authoritative and only fall back to the request-supplied values for local dev where the
  // platform isn't in the loop (vite proxies straight here, bypassing Foundry).
  // See https://learn.microsoft.com/azure/foundry/agents/how-to/manage-hosted-sessions
  const headerSessionId = req.get('x-ms-foundry-session-id') ?? req.get('x-session-id');
  const bodySessionId = typeof req.body === 'object' && req.body ? req.body.session_id : undefined;
  return process.env.FOUNDRY_AGENT_SESSION_ID ?? headerSessionId ?? bodySessionId ?? 'local-session';
}

function extractUserMessage(body) {
  if (typeof body === 'string') {
    return body.trim();
  }
  if (!body || typeof body !== 'object') {
    return '';
  }
  if (typeof body.message === 'string' && body.message.trim()) {
    return body.message.trim();
  }
  if (typeof body.input === 'string' && body.input.trim()) {
    return body.input.trim();
  }
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (item?.type === 'message' && Array.isArray(item.content)) {
        const textPart = item.content.find(p => p?.type === 'input_text' && typeof p.text === 'string');
        if (textPart?.text?.trim()) {
          return textPart.text.trim();
        }
      }
    }
  }
  return '';
}

function trimTrailingSlash(value) {
  return value?.replace(/\/+$/, '');
}

function normalizeProjectEndpoint(endpoint) {
  const base = trimTrailingSlash(endpoint);
  if (base.includes('/api/projects/')) {
    return base.endsWith('/openai/v1') ? base : `${base}/openai/v1`;
  }
  return base;
}

function deriveProjectEndpoint() {
  const explicit = process.env.FOUNDRY_PROJECT_ENDPOINT ?? process.env.COPILOT_PROVIDER_BASE_URL;
  if (explicit) {
    return normalizeProjectEndpoint(explicit);
  }

  const servicesEndpoint =
    process.env.CHAT_URI ??
    process.env.CHAT_AIINFERENCEURI ??
    conn['endpointaiinference'];
  if (!servicesEndpoint) {
    throw new Error('Missing Foundry model reference. Expected FOUNDRY_PROJECT_ENDPOINT or CHAT_URI/CHAT_AIINFERENCEURI.');
  }

  const normalized = normalizeProjectEndpoint(servicesEndpoint);
  if (normalized.includes('/api/projects/')) {
    return normalized;
  }

  const base = normalized.replace(/\/models$/i, '');

  const projectName = process.env.FOUNDRY_PROJECT_NAME ?? 'project';
  return `${base}/api/projects/${encodeURIComponent(projectName)}/openai/v1`;
}

async function ensureProviderConfig() {
  if (providerConfig && Date.now() < providerTokenExpiresOn - 5 * 60 * 1000) {
    return providerConfig;
  }

  const token = await credential.getToken('https://ai.azure.com/.default');
  providerTokenExpiresOn = token.expiresOnTimestamp;
  providerConfig = {
    type: 'openai',
    wireApi: 'completions',
    baseUrl: deriveProjectEndpoint(),
    bearerToken: token.token,
    modelId: copilotModelId,
    wireModel: deploymentName,
  };
  sessions.clear();
  console.log(`[copilot] configured BYOK provider ${providerConfig.baseUrl} model=${copilotModelId} deployment=${deploymentName}`);
  return providerConfig;
}

async function ensureClient() {
  if (client) {
    return client;
  }

  client = new CopilotClient({
    mode: 'empty',
    useLoggedInUser: false,
    baseDirectory: copilotHome,
    workingDirectory,
    logLevel: process.env.COPILOT_LOG_LEVEL ?? 'info',
  });
  try {
    await client.start();
  } catch (err) {
    throw new Error(`Copilot SDK client start failed: ${err?.message ?? err}`);
  }
  return client;
}

async function createOrResumeSession(sessionId) {
  const copilot = await ensureClient();
  const provider = await ensureProviderConfig();
  const config = {
    model: copilotModelId,
    provider,
    availableTools: [],
    onPermissionRequest: approveAll,
    systemMessage: {
      mode: 'append',
      content: 'You are a helpful assistant.',
    },
  };

  try {
    const session = await copilot.resumeSession(sessionId, config);
    console.log(`[copilot] resumed session ${sessionId}`);
    return session;
  } catch (err) {
    console.log(`[copilot] creating session ${sessionId}: ${err?.message ?? err}`);
    let session;
    try {
      session = await copilot.createSession({ ...config, sessionId });
    } catch (createErr) {
      throw new Error(`Copilot SDK session create failed: ${createErr?.message ?? createErr}`);
    }
    console.log(`[copilot] created session ${sessionId}`);
    return session;
  }
}

async function getSession(sessionId) {
  let session = sessions.get(sessionId);
  if (session) {
    return session;
  }

  session = await createOrResumeSession(sessionId);
  sessions.set(sessionId, session);
  return session;
}

async function withSessionLock(sessionId, callback) {
  const prior = sessionLocks.get(sessionId) ?? Promise.resolve();
  let release;
  const current = new Promise(resolve => {
    release = resolve;
  });
  const tail = prior.then(() => current);
  sessionLocks.set(sessionId, tail);
  await prior;
  try {
    return await callback();
  } finally {
    release();
    if (sessionLocks.get(sessionId) === tail) {
      sessionLocks.delete(sessionId);
    }
  }
}

async function generateReply(sessionId, userMessage) {
  return await withSessionLock(sessionId, async () => {
    const session = await getSession(sessionId);
    let response;
    try {
      response = await session.sendAndWait({ prompt: userMessage }, 90_000);
    } catch (err) {
      throw new Error(`Copilot SDK send failed: ${err?.message ?? err}`);
    }
    const content = response?.data?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new Error('Copilot SDK completed without an assistant text response.');
    }
    return content;
  });
}

app.get('/readiness', (_req, res) => res.status(200).json({ status: 'ready' }));
app.get('/liveness', (_req, res) => res.status(200).json({ status: 'alive' }));

app.post('/invocations', async (req, res) => {
  const userMessage = extractUserMessage(req.body);
  if (!userMessage) {
    res.status(400).json({ error: 'Missing message. Provide message, input, or text body.' });
    return;
  }

  const sessionId = getSessionId(req);
  let assistantMessage;
  try {
    assistantMessage = await generateReply(sessionId, userMessage);
  } catch (err) {
    console.error('[copilot] invocation failed: ' + (err?.stack ?? err?.message ?? err));
    res.status(502).json({
      error: 'copilot_invocation_failed',
      message: err?.message ?? 'Copilot SDK invocation failed.',
    });
    return;
  }

  res.status(200).json({
    invocation_id: crypto.randomUUID(),
    session_id: sessionId,
    output: { role: 'assistant', content: assistantMessage },
  });
});

app.listen(port, () => console.log(`Hosted agent listening on http://localhost:${port}`));

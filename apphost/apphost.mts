// Aspire TypeScript AppHost - Scenario A (Foundry hosted agent, cross-compute-env)
// PR #17756 / issue #17749.
//
// A Foundry hosted agent (node app 'agent-ha') is deployed as a Foundry agent version. A C#
// auth-proxy + static frontend host ('apiservice') on Azure Container Apps references that hosted
// agent and invokes it on behalf of the browser. This consumer reference crosses compute
// environments (ACA -> Foundry), which is exactly the path fixed by the PR: the injected URL
// resolves to the agent's real deployed name '{FoundryEndpoint}/agents/agent-ha' (NOT
// '/agents/agent').
//
// Why host the SPA in the C# service instead of publishAsStaticWebsite proxying straight to the
// agent: invoking a Foundry hosted agent requires a managed-identity bearer token plus the
// 'Foundry-Features' preview header. A static reverse proxy cannot attach those, so the browser
// talks to apiservice, which acquires the token, adds the header, and forwards to the agent's
// invocations endpoint.

import { createBuilder, FoundryModels } from './.aspire/modules/aspire.mjs';

const builder = await createBuilder();

const foundry = await builder.addFoundry('foundry');
const project = foundry.addProject('project');
const model = await foundry.addDeployment('chat', FoundryModels.OpenAI.Gpt5);
await model.skuCapacity.set(10);

const aca = await builder.addAzureContainerAppEnvironment('aca');

const hostedAgent = await builder
    .addNodeApp('agent-ha', '../api', 'src/server.js')
    .withDockerfileBaseImage({
        buildImage: 'node:22.20.0-bookworm',
        runtimeImage: 'node:22.20.0-bookworm'
    })
    .withHttpEndpoint({ env: 'PORT' })
    .withExternalHttpEndpoints()
    .withHttpHealthCheck({ path: '/readiness' })
    .withEnvironment('FOUNDRY_PROJECT_NAME', 'project')
    .withEnvironment('COPILOT_MODEL_ID', 'gpt-5')
    .withReference(model);

await hostedAgent.asHostedAgent(project, {
    protocols: [{ protocol: 'invocations', version: '1.0.0' }]
});

// C# auth-proxy + SPA host on ACA. References the hosted agent (cross-compute-env reference fixed
// by the PR), acquires a managed-identity token, and forwards browser POST /invocations to the
// agent.
const apiservice = await builder
    .addProject('apiservice', '../apiservice/apiservice.csproj')
    .withReference(hostedAgent)
    .withHttpHealthCheck({ path: '/readiness' })
    .withExternalHttpEndpoints()
    .withComputeEnvironment(aca);

// Keep the Vite app as a build-output resource, not a deployed/static-site compute resource.
// During Aspire publish/deploy, its dist output is copied into the C# service container's wwwroot.
const frontend = await builder
    .addViteApp('agentweb', '../web')
    .withComputeEnvironment(aca);
await apiservice.publishWithContainerFiles(frontend, './wwwroot');

await builder.build().run();

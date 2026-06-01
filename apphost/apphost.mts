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


const apiservice = await builder
    .addProject('apiservice', '../apiservice/apiservice.csproj')
    .withReference(hostedAgent)
    .withHttpHealthCheck({ path: '/readiness' })
    .withExternalHttpEndpoints()
    .withComputeEnvironment(aca);

const frontend = await builder
    .addViteApp('agentweb', '../web')
    .withComputeEnvironment(aca);
await apiservice.publishWithContainerFiles(frontend, './wwwroot');

await builder.build().run();

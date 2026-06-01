using ApiService;
using Azure.Core;
using Azure.Identity;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddSingleton<TokenCredential, DefaultAzureCredential>();
builder.Services.AddSingleton<FoundryAccessTokenProvider>();
builder.Services.AddSingleton<UserSessionService>();
builder.Services.AddServiceDiscovery();
builder.Services.ConfigureHttpClientDefaults(http =>
{
    http.AddServiceDiscovery();
});
builder.Services.AddHttpClient<FoundryAgentClient>(client =>
{
    client.BaseAddress = new Uri("https+http://agent-ha/");
});

var app = builder.Build();

app.UseFileServer();

app.MapGet("/readiness", () => Results.Ok(new { status = "ready" }));
app.MapGet("/liveness", () => Results.Ok(new { status = "alive" }));

app.MapGet("/session", (HttpContext context, UserSessionService sessions) =>
{
    return Results.Ok(sessions.GetOrCreateSession(context));
});

app.MapPost("/session/reset", (HttpContext context, UserSessionService sessions) =>
{
    return Results.Ok(sessions.ResetSession(context));
});

app.MapPost("/invocations", async (
    InvocationRequest req,
    HttpContext context,
    UserSessionService sessions,
    FoundryAgentClient agent,
    CancellationToken ct) =>
{
    var userId = sessions.GetOrCreateUserId(context);
    var text = req.Message ?? req.Input ?? "(empty)";
    var result = await agent.InvokeAsync(text, sessions.GetAgentSessionId(userId), ct);

    if (!string.IsNullOrWhiteSpace(result.AgentSessionId))
    {
        sessions.SetAgentSessionId(userId, result.AgentSessionId);
    }

    return Results.Ok(new InvocationResponse(
        Guid.NewGuid().ToString(),
        sessions.CreateSessionInfo(userId),
        new AgentOutput("assistant", result.Content)));
});

app.MapFallbackToFile("index.html");

app.Run();

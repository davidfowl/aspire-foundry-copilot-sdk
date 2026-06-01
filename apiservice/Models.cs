using System.Text.Json.Serialization;

namespace ApiService;

public sealed record InvocationRequest(
    [property: JsonPropertyName("message")] string? Message,
    [property: JsonPropertyName("input")] string? Input);

public sealed record InvocationResponse(
    [property: JsonPropertyName("invocation_id")] string InvocationId,
    SessionInfo Session,
    AgentOutput Output);

public sealed record AgentOutput(
    [property: JsonPropertyName("role")] string Role,
    [property: JsonPropertyName("content")] string Content);

public sealed record SessionInfo(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("has_agent_session")] bool HasAgentSession);

public sealed record AgentInvocationResult(
    string Content,
    string? AgentSessionId);

internal sealed record FoundryInvocationResponse(
    [property: JsonPropertyName("session_id")] string? SessionId,
    [property: JsonPropertyName("output")] FoundryInvocationOutput? Output);

internal sealed record FoundryInvocationOutput(
    [property: JsonPropertyName("content")] string? Content);

internal sealed record FoundryInvocationRequest(
    [property: JsonPropertyName("message")] string Message);

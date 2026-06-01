using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
namespace ApiService;

// Small typed wrapper for the Foundry hosted-agent Invocations protocol.
// The HttpClient base address is the Aspire service-discovery name for the hosted agent
// ("https+http://agent-ha/"), which resolves to the Foundry agent data-plane endpoint. Each call
// posts a JSON message to endpoint/protocols/invocations, authenticates with the app's
// managed identity, and captures Foundry's returned session id so this service can keep
// sandbox affinity server-side.
public sealed class FoundryAgentClient
{
    private readonly HttpClient _httpClient;
    private readonly FoundryAccessTokenProvider _tokenProvider;

    public FoundryAgentClient(HttpClient httpClient, FoundryAccessTokenProvider tokenProvider)
    {
        _httpClient = httpClient;
        _tokenProvider = tokenProvider;
    }

    public async Task<AgentInvocationResult> InvokeAsync(
        string message,
        string? agentSessionId,
        CancellationToken cancellationToken)
    {
        var token = await _tokenProvider.GetTokenAsync(cancellationToken);

        // Foundry binds an Invocations call to a stateful sandbox ONLY via this query string. Keep it
        // server-side so clients cannot read or guess another user's Foundry sandbox id.
        var url = "endpoint/protocols/invocations?api-version=v1";
        if (!string.IsNullOrWhiteSpace(agentSessionId))
        {
            url += $"&agent_session_id={Uri.EscapeDataString(agentSessionId)}";
        }

        HttpResponseMessage? response = null;
        AgentInvocationResult? result = null;
        var invocationRequest = new FoundryInvocationRequest(message);

        for (var attempt = 0; attempt < 4; attempt++)
        {
            using var request = CreateInvocationRequest(url, token, invocationRequest);
            response = await _httpClient.SendAsync(request, cancellationToken);
            result = await ReadResultAsync(response.Content, cancellationToken);

            // Foundry hosted agents can return HTTP 424 while the backed sandbox
            // is still coming online. We observed this during the first turn of a
            // new session; retrying briefly lets the same invocation complete
            // once the sandbox dependency is ready.
            if ((int)response.StatusCode != 424)
            {
                break;
            }

            await Task.Delay(TimeSpan.FromSeconds(2), cancellationToken);
        }

        var finalResult = result ?? new AgentInvocationResult(string.Empty, AgentSessionId: null);
        if (response is not null && !response.IsSuccessStatusCode)
        {
            finalResult = finalResult with { Content = $"[agent HTTP {(int)response.StatusCode}] {finalResult.Content}" };
        }

        return finalResult;
    }

    private static HttpRequestMessage CreateInvocationRequest(
        string url,
        string token,
        FoundryInvocationRequest invocationRequest)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, url);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        request.Headers.Add("Foundry-Features", "HostedAgents=V1Preview");
        request.Content = JsonContent.Create(invocationRequest);
        return request;
    }

    private static async Task<AgentInvocationResult> ReadResultAsync(
        HttpContent content,
        CancellationToken cancellationToken)
    {
        if (!IsJsonContent(content))
        {
            return new AgentInvocationResult("Foundry returned a non-JSON response.", AgentSessionId: null);
        }

        try
        {
            var response = await content.ReadFromJsonAsync<FoundryInvocationResponse>(cancellationToken);
            if (response?.Output?.Content is { } output)
            {
                return new AgentInvocationResult(output, response.SessionId);
            }
        }
        catch (JsonException)
        {
            return new AgentInvocationResult("Foundry returned an invalid JSON response.", AgentSessionId: null);
        }

        return new AgentInvocationResult("Foundry returned an unexpected JSON response.", AgentSessionId: null);
    }

    private static bool IsJsonContent(HttpContent content)
    {
        var mediaType = content.Headers.ContentType?.MediaType;
        return mediaType is null ||
            mediaType.Equals("application/json", StringComparison.OrdinalIgnoreCase) ||
            mediaType.EndsWith("+json", StringComparison.OrdinalIgnoreCase);
    }
}

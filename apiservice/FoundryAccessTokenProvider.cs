using Azure.Core;

namespace ApiService;

// Caches the managed-identity access token used to call AI Foundry so every
// invocation does not independently hit Entra ID. The semaphore keeps one
// concurrent caller responsible for refreshing when the cached token is close
// to expiring.
public sealed class FoundryAccessTokenProvider
{
    private static readonly TokenRequestContext TokenRequestContext = new(["https://ai.azure.com/.default"]);
    private static readonly TimeSpan RefreshBuffer = TimeSpan.FromMinutes(5);

    private readonly TokenCredential _credential;
    private readonly SemaphoreSlim _refreshLock = new(1, 1);
    private AccessToken _cachedToken;

    public FoundryAccessTokenProvider(TokenCredential credential)
    {
        _credential = credential;
    }

    public async Task<string> GetTokenAsync(CancellationToken cancellationToken)
    {
        if (HasUsableToken())
        {
            return _cachedToken.Token;
        }

        await _refreshLock.WaitAsync(cancellationToken);
        try
        {
            if (!HasUsableToken())
            {
                _cachedToken = await _credential.GetTokenAsync(TokenRequestContext, cancellationToken);
            }

            return _cachedToken.Token;
        }
        finally
        {
            _refreshLock.Release();
        }
    }

    private bool HasUsableToken()
    {
        return !string.IsNullOrEmpty(_cachedToken.Token) &&
            _cachedToken.ExpiresOn > DateTimeOffset.UtcNow.Add(RefreshBuffer);
    }
}

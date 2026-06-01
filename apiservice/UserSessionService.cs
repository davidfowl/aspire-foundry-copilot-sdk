using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;

namespace ApiService;

// Maintains per-browser affinity to a Foundry agent session without exposing the
// Foundry session id to the client. The cookie contains only an opaque random
// user id, so data protection is not required for confidentiality; it is still a
// bearer handle protected with HttpOnly/Secure/SameSite cookie flags. The
// Foundry session id lives in this process-local map, which is simple for the
// sample but not durable across restarts or multiple replicas without adding a
// distributed store or sticky sessions.
public sealed class UserSessionService
{
    private const string UserCookieName = "agent_user_id";

    private static readonly string[] LegacyClientCookieNames = ["aspire-user", "aspire-user-name"];
    private static readonly string[] Adjectives =
    [
        "Brave", "Clever", "Curious", "Mellow", "Swift", "Witty", "Sunny", "Jolly", "Nimble", "Quiet"
    ];
    private static readonly string[] Animals =
    [
        "Otter", "Fox", "Heron", "Lynx", "Panda", "Falcon", "Badger", "Marten", "Ibis", "Gecko"
    ];

    private readonly ConcurrentDictionary<string, string> _agentSessions = new();

    // User ids are revoked when /session/reset rotates the browser to a new
    // cookie. This prevents an in-flight request carrying the previous cookie
    // from restoring its old Foundry session mapping after reset completes.
    private readonly ConcurrentDictionary<string, byte> _revokedUserIds = new();

    public SessionInfo GetOrCreateSession(HttpContext context)
    {
        return CreateSessionInfo(GetOrCreateUserId(context));
    }

    public SessionInfo ResetSession(HttpContext context)
    {
        DeleteLegacyClientCookies(context);
        if (TryGetValidUserId(context, out var previousUserId))
        {
            RevokeUserId(previousUserId);
        }

        var userId = CreateUserId();
        _revokedUserIds.TryRemove(userId, out _);
        context.Response.Cookies.Append(UserCookieName, userId, CreateUserCookieOptions(context));
        return CreateSessionInfo(userId);
    }

    public string GetOrCreateUserId(HttpContext context)
    {
        DeleteLegacyClientCookies(context);

        if (TryGetValidUserId(context, out var userId))
        {
            return userId;
        }

        userId = CreateUserId();
        context.Response.Cookies.Append(UserCookieName, userId, CreateUserCookieOptions(context));
        return userId;
    }

    public string? GetAgentSessionId(string userId)
    {
        if (_revokedUserIds.ContainsKey(userId))
        {
            return null;
        }

        return _agentSessions.GetValueOrDefault(userId);
    }

    public void SetAgentSessionId(string userId, string agentSessionId)
    {
        if (_revokedUserIds.ContainsKey(userId))
        {
            return;
        }

        _agentSessions[userId] = agentSessionId;
    }

    // Returns the browser-visible session projection. It is derived from the
    // opaque cookie value so the UI can show a stable friendly identity without
    // exposing either the cookie handle or the Foundry agent session id.
    public SessionInfo CreateSessionInfo(string userId)
    {
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(userId));
        var publicId = Convert.ToHexString(hash[..6]).ToLowerInvariant();
        var name = $"{Adjectives[hash[6] % Adjectives.Length]} {Animals[hash[7] % Animals.Length]}";
        return new SessionInfo(publicId, name, !_revokedUserIds.ContainsKey(userId) && _agentSessions.ContainsKey(userId));
    }

    private bool TryGetValidUserId(HttpContext context, out string userId)
    {
        if (context.Request.Cookies.TryGetValue(UserCookieName, out var value) &&
            IsValidUserId(value) &&
            !_revokedUserIds.ContainsKey(value))
        {
            userId = value;
            return true;
        }

        userId = string.Empty;
        return false;
    }

    private static string CreateUserId()
    {
        return Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
    }

    private static bool IsValidUserId(string value)
    {
        return value.Length == 64 && value.All(Uri.IsHexDigit);
    }

    private void RevokeUserId(string userId)
    {
        _agentSessions.TryRemove(userId, out _);
        _revokedUserIds.TryAdd(userId, 0);
    }

    private static CookieOptions CreateUserCookieOptions(HttpContext context)
    {
        return new CookieOptions
        {
            HttpOnly = true,
            Secure = context.Request.IsHttps ||
                string.Equals(context.Request.Headers["X-Forwarded-Proto"], "https", StringComparison.OrdinalIgnoreCase),
            SameSite = SameSiteMode.Lax,
            Path = "/",
            MaxAge = TimeSpan.FromDays(1)
        };
    }

    private static void DeleteLegacyClientCookies(HttpContext context)
    {
        foreach (var cookieName in LegacyClientCookieNames)
        {
            context.Response.Cookies.Delete(cookieName, new CookieOptions { Path = "/" });
        }
    }
}

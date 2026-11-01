using System;
using System.Threading.Tasks;

namespace Recharge.Server
{
    /// <summary>A request the server refuses, with the HTTP status to answer.</summary>
    public sealed class SocialException : Exception
    {
        public SocialException(int status, string message, double retryAfter = 0) : base(message)
        {
            Status = status;
            RetryAfter = retryAfter;
        }

        public int Status { get; }
        public double RetryAfter { get; }
    }

    public sealed class HubUser
    {
        public HubUser(string username, bool admin) { Username = username; Admin = admin; }
        public string Username { get; }
        public bool Admin { get; }
    }

    /// <summary>The hub, as far as the social server needs it: who owns a session token, and whether a username exists.</summary>
    public interface IHubDirectory
    {
        /// <summary>The user a session token belongs to, or null when the hub rejects it. Throws SocialException(503) when the hub can't be reached.</summary>
        Task<HubUser?> Authenticate(string token);

        /// <summary>The hub's spelling of a username, or null when there is no such user.</summary>
        Task<string?> LookupUser(string username);
    }

    public sealed class SignedLink
    {
        public SignedLink(string url, DateTimeOffset expires) { Url = url; Expires = expires; }
        public string Url { get; }
        public DateTimeOffset Expires { get; }
    }

    /// <summary>Makes a short-lived download link for a private object. The real R2 signer is wired at deploy time.</summary>
    public interface IShareSigner
    {
        SignedLink Sign(string objectKey, DateTimeOffset expires);
    }
}

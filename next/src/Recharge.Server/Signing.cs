using System;
using System.Security.Cryptography;
using System.Text;

namespace Recharge.Server
{
    /// <summary>For tests and the demo only: an HMAC-signed link on a placeholder host.</summary>
    public sealed class TestShareSigner : IShareSigner
    {
        private readonly byte[] _key;
        private readonly string _host;

        public TestShareSigner(string key, string host = "https://signed.test")
        {
            _key = Encoding.UTF8.GetBytes(key);
            _host = host.TrimEnd('/');
        }

        public SignedLink Sign(string objectKey, DateTimeOffset expires)
        {
            long exp = expires.ToUnixTimeSeconds();
            string url = _host + "/" + objectKey + "?expires=" + exp + "&signature=" + Signature(objectKey, exp);
            return new SignedLink(url, expires);
        }

        public bool Verify(string objectKey, long expires, string signature, DateTimeOffset now) =>
            now.ToUnixTimeSeconds() <= expires &&
            CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(Signature(objectKey, expires)), Encoding.ASCII.GetBytes(signature));

        private string Signature(string objectKey, long exp)
        {
            using var hmac = new HMACSHA256(_key);
            return Convert.ToHexString(hmac.ComputeHash(Encoding.UTF8.GetBytes(objectKey + "\n" + exp))).ToLowerInvariant();
        }
    }

    /// <summary>The default until the R2 signer is wired in: downloads answer 503.</summary>
    public sealed class UnconfiguredShareSigner : IShareSigner
    {
        public SignedLink Sign(string objectKey, DateTimeOffset expires) =>
            throw new SocialException(503, "Private downloads are not configured on this server.");
    }
}

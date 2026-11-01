using System;
using System.Threading.Tasks;
using Recharge.App.Account;
using Recharge.Core.Json;

namespace Recharge.App.Bridge
{
    /// <summary>The account bridge: log in, register, who am I, log out, and authenticated hub requests.</summary>
    public static class AccountCommands
    {
        public static void Register(CommandRegistry registry)
        {
            registry.Register("account.login", Login);
            registry.Register("account.register", RegisterAccount);
            registry.Register("account.me", Me);
            registry.Register("account.logout", Logout);
            registry.Register("account.image", Image);
            registry.Register("hub.request", Request);
        }

        private static Task<JsonNode> Login(JsonObject args)
        {
            string username = Required(args, "username");
            string password = Required(args, "password");
            return new AccountService().Login(username, password);
        }

        private static Task<JsonNode> RegisterAccount(JsonObject args)
        {
            string username = Required(args, "username");
            string password = Required(args, "password");
            return new AccountService().Register(username, password);
        }

        private static Task<JsonNode> Me(JsonObject args) => new AccountService().Me();

        private static Task<JsonNode> Logout(JsonObject args) => new AccountService().Logout();

        private static Task<JsonNode> Request(JsonObject args)
        {
            string method = OptionalString(args, "method") ?? "GET";
            string path = Required(args, "path");
            JsonNode? body = args.TryGetValue("body", out JsonNode node) && node is not JsonNull ? node : null;
            return new AccountService().Request(method, path, body);
        }

        private static Task<JsonNode> Image(JsonObject args) => new AccountService().Image(Required(args, "path"));

        private static string Required(JsonObject args, string key)
        {
            if (!args.TryGetValue(key, out JsonNode node) || node is not JsonString value || string.IsNullOrEmpty(value.Value))
            {
                throw new ArgumentException("missing string argument: " + key, nameof(args));
            }
            return value.Value;
        }

        private static string? OptionalString(JsonObject args, string key)
        {
            return args.TryGetValue(key, out JsonNode node) && node is JsonString value ? value.Value : null;
        }
    }
}

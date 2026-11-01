using System;

namespace Recharge.MapDoc
{
    public class DocOpException : Exception
    {
        public DocOpException(string message) : base(message) { }
        public DocOpException(string message, Exception inner) : base(message, inner) { }
    }
}
using System;
using System.Globalization;

namespace Recharge.Core.Json
{
    /// <summary>Formats a double the way JavaScript's Number.prototype.toString does.</summary>
    public static class JsNumber
    {
        public static string Format(double d)
        {
            // JSON.stringify turns NaN/Infinity into null.
            if (double.IsNaN(d) || double.IsInfinity(d))
            {
                return "null";
            }

            // -0 is "0" in JS.
            if (d == 0.0)
            {
                return "0";
            }

            string s = d.ToString("R", CultureInfo.InvariantCulture);
            bool neg = s.StartsWith("-", StringComparison.Ordinal);
            if (neg)
            {
                s = s.Substring(1);
            }

            // Split off an exponent if "R" produced one.
            string mantissa = s;
            int exp = 0;
            int eIndex = s.IndexOf('E');
            if (eIndex < 0)
            {
                eIndex = s.IndexOf('e');
            }
            if (eIndex >= 0)
            {
                mantissa = s.Substring(0, eIndex);
                exp = int.Parse(s.Substring(eIndex + 1), CultureInfo.InvariantCulture);
            }

            // Remove the decimal point and track how many places it moved.
            int dotIndex = mantissa.IndexOf('.');
            string digits = mantissa;
            int afterDot = 0;
            if (dotIndex >= 0)
            {
                afterDot = mantissa.Length - 1 - dotIndex;
                digits = mantissa.Substring(0, dotIndex) + mantissa.Substring(dotIndex + 1);
            }

            // digits * 10^decExp == original magnitude.
            int decExp = exp - afterDot;

            // Normalise to one digit before the decimal point.
            int sciExp = decExp + (digits.Length - 1);

            string result;
            if (sciExp >= 21 || sciExp <= -7)
            {
                // Exponential notation.
                string m = digits.Length == 1
                    ? digits
                    : digits.Substring(0, 1) + "." + digits.Substring(1);

                // Strip trailing zeros after the decimal point (they are never needed).
                if (m.Contains("."))
                {
                    m = m.TrimEnd('0').TrimEnd('.');
                    if (m == "" || m == "-" || m == ".")
                    {
                        m = "0";
                    }
                }

                string expStr = sciExp >= 0
                    ? "+" + sciExp.ToString(CultureInfo.InvariantCulture)
                    : sciExp.ToString(CultureInfo.InvariantCulture);

                result = m + "e" + expStr;
            }
            else
            {
                // Fixed notation.
                if (decExp >= 0)
                {
                    result = digits + new string('0', decExp);
                }
                else
                {
                    int k = -decExp; // digits after decimal point
                    if (k >= digits.Length)
                    {
                        result = "0." + new string('0', k - digits.Length) + digits;
                    }
                    else if (k == 0)
                    {
                        result = digits;
                    }
                    else
                    {
                        result = digits.Substring(0, digits.Length - k) + "." + digits.Substring(digits.Length - k);
                    }
                }
            }

            if (neg)
            {
                result = "-" + result;
            }

            return result;
        }
    }
}

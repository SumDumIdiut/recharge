using System;
using UnityEngine;
using Recharge.ModApi;

// Several ways to end up with a Sprite through host.LoadSprite, all starting
// from a procedurally-built Texture2D so this file doesn't need to bundle any
// binary assets. A real mod would usually just File.ReadAllBytes a real .png
// from its own folder or data dir instead and skip straight to LoadSprite.
internal static class SpriteDemo
{
    public static readonly string[] StyleNames = { "Solid", "Checkerboard", "Gradient", "Vignette", "Noise" };

    public static Sprite ByStyleIndex(IRechargeHost host, int index, int seed = 0)
    {
        var orange = new Color(1f, 0.55f, 0.15f);
        var blue = new Color(0.25f, 0.55f, 1f);
        switch (((index % StyleNames.Length) + StyleNames.Length) % StyleNames.Length)
        {
            case 0: return SolidColor(host, orange);
            case 1: return Checkerboard(host, orange, blue);
            case 2: return HorizontalGradient(host, orange, blue);
            case 3: return RadialVignette(host, blue);
            default: return Noise(host, seed: seed);
        }
    }

    public static Sprite SolidColor(IRechargeHost host, Color color, int size = 32)
        => FromTexture(host, size, (x, y) => color);

    public static Sprite Checkerboard(IRechargeHost host, Color a, Color b, int size = 32, int cell = 4)
        => FromTexture(host, size, (x, y) => ((x / cell) + (y / cell)) % 2 == 0 ? a : b);

    public static Sprite HorizontalGradient(IRechargeHost host, Color from, Color to, int size = 32)
        => FromTexture(host, size, (x, y) => Color.Lerp(from, to, (float)x / (size - 1)));

    public static Sprite RadialVignette(IRechargeHost host, Color color, int size = 32)
    {
        var center = (size - 1) / 2f;
        return FromTexture(host, size, (x, y) =>
        {
            var dist = Vector2.Distance(new Vector2(x, y), new Vector2(center, center));
            var c = color;
            c.a = Mathf.Clamp01(1f - dist / center);
            return c;
        });
    }

    public static Sprite Noise(IRechargeHost host, int size = 32, int seed = 0)
    {
        var rng = new System.Random(seed == 0 ? Environment.TickCount : seed);
        return FromTexture(host, size, (x, y) =>
        {
            var v = (float)rng.NextDouble();
            return new Color(v, v, v, 1f);
        });
    }

    private static Sprite FromTexture(IRechargeHost host, int size, Func<int, int, Color> pixelFn)
    {
        var tex = new Texture2D(size, size, TextureFormat.RGBA32, false) { filterMode = FilterMode.Point };
        for (int y = 0; y < size; y++)
            for (int x = 0; x < size; x++)
                tex.SetPixel(x, y, pixelFn(x, y));
        tex.Apply();
        var pngBytes = ImageConversion.EncodeToPNG(tex);
        UnityEngine.Object.Destroy(tex);
        return host.LoadSprite(pngBytes);
    }
}

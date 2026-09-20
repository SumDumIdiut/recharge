using UnityEngine;
using UnityEngine.UI;
using Recharge.ModApi;

// A tiny sprite-sheet-free animation: several procedurally generated frames
// (reusing SpriteDemo's generators with a rotating hue) cycled onto a UI
// Image via host.OnUpdate on a fixed interval - the same technique as a real
// flipbook animation, just with generated frames instead of an imported strip.
internal class FlipbookSpriteDemo
{
    private readonly IRechargeHost _host;
    private readonly Sprite[] _frames;
    private Image _target;
    private float _accumulator;
    private int _frameIndex;
    private bool _playing;
    private const float SecondsPerFrame = 0.12f;

    public FlipbookSpriteDemo(IRechargeHost host, int frameCount = 8)
    {
        _host = host;
        _frames = new Sprite[frameCount];
        for (int i = 0; i < frameCount; i++)
        {
            var hue = (float)i / frameCount;
            var color = Color.HSVToRGB(hue, 0.7f, 1f);
            _frames[i] = SpriteDemo.RadialVignette(host, color);
        }
        host.OnUpdate += Tick;
    }

    public void PlayOn(Image target)
    {
        _target = target;
        _frameIndex = 0;
        _accumulator = 0f;
        _playing = true;
        if (_target != null && _frames.Length > 0) _target.sprite = _frames[0];
    }

    public void Stop() => _playing = false;

    public bool IsPlaying => _playing;

    private void Tick()
    {
        if (!_playing || _target == null || _frames.Length == 0) return;

        _accumulator += Time.deltaTime;
        if (_accumulator < SecondsPerFrame) return;
        _accumulator = 0f;

        _frameIndex = (_frameIndex + 1) % _frames.Length;
        _target.sprite = _frames[_frameIndex];
    }
}

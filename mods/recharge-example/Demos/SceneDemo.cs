using UnityEngine;
using UnityEngine.SceneManagement;
using Recharge.ModApi;

// SceneManager.sceneLoaded directly - the same event RechargeEvents.SceneLoaded
// is itself built on - versus the loader's wrapped, string-only version, plus
// spawning and cleaning up a real world-space object across scene loads.
internal class SceneDemo
{
    private readonly IRechargeHost _host;
    private GameObject _spawnedMarker;

    public SceneDemo(IRechargeHost host)
    {
        _host = host;

        // Subscribing directly is useful when you need the Scene struct
        // itself (buildIndex, LoadSceneMode) rather than just its name - the
        // wrapped RechargeEvents.SceneLoaded payload is a bare string.
        SceneManager.sceneLoaded += OnSceneLoadedDirect;
    }

    private void OnSceneLoadedDirect(Scene scene, LoadSceneMode mode)
    {
        _host.Log($"[direct SceneManager.sceneLoaded] {scene.name} (buildIndex {scene.buildIndex}, mode {mode})");
        CleanUpMarker();
    }

    public void SpawnWorldMarker(Sprite sprite)
    {
        var player = GameObject.FindGameObjectWithTag("Player");
        var origin = player != null ? player.transform.position + Vector3.up * 2f : Vector3.zero;

        CleanUpMarker();
        _spawnedMarker = new GameObject("ExampleModMarker", typeof(SpriteRenderer));
        _spawnedMarker.transform.position = origin;
        var spriteRenderer = _spawnedMarker.GetComponent<SpriteRenderer>();
        spriteRenderer.sprite = sprite;
        spriteRenderer.sortingOrder = 100;

        // Deliberately NOT DontDestroyOnLoad - CleanUpMarker() runs on the very
        // next scene load (above), demonstrating "cleans itself up" rather
        // than "survives forever unless someone remembers to destroy it."
        _host.Log($"Spawned a world-space marker at {origin}.");
    }

    private void CleanUpMarker()
    {
        if (_spawnedMarker == null) return;
        Object.Destroy(_spawnedMarker);
        _spawnedMarker = null;
    }

    public void Dispose()
    {
        SceneManager.sceneLoaded -= OnSceneLoadedDirect;
        CleanUpMarker();
    }
}

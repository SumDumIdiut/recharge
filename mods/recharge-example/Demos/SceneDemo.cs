using UnityEngine;
using UnityEngine.SceneManagement;
using Recharge.ModApi;

// SceneManager.sceneLoaded directly, versus the loader's wrapped, string-only
// RechargeEvents.SceneLoaded, plus spawning/cleaning up a world-space object.
internal class SceneDemo
{
    private readonly IRechargeHost _host;
    private GameObject _spawnedMarker;

    public SceneDemo(IRechargeHost host)
    {
        _host = host;
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

        // Deliberately not DontDestroyOnLoad - OnSceneLoadedDirect above cleans it up.
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

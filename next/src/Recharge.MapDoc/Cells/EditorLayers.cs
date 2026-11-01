using System;

namespace Recharge.MapDoc
{
    public sealed class EditorLayers
    {
        public CellLayer Blocks { get; }
        public CellLayer Spikes { get; }
        public CellLayer Vines { get; }
        public CellLayer Moss { get; }
        public CellLayer CellGroups { get; }
        public TileLayerSet Tiles { get; }

        private EditorLayers(CellLayer blocks, CellLayer spikes, CellLayer vines, CellLayer moss, CellLayer cellGroups, TileLayerSet tiles)
        {
            Blocks = blocks;
            Spikes = spikes;
            Vines = vines;
            Moss = moss;
            CellGroups = cellGroups;
            Tiles = tiles;
        }

        public static EditorLayers For(MapDocument doc)
        {
            if (doc is null)
            {
                throw new ArgumentNullException(nameof(doc));
            }
            return new EditorLayers(
                new CellLayer(doc, DocPath.Parse("/editor/blocks")),
                new CellLayer(doc, DocPath.Parse("/editor/spikes")),
                new CellLayer(doc, DocPath.Parse("/editor/vines")),
                new CellLayer(doc, DocPath.Parse("/editor/moss")),
                new CellLayer(doc, DocPath.Parse("/editor/cellGroups")),
                new TileLayerSet(doc, DocPath.Parse("/editor/tiles")));
        }

        public void Dispose()
        {
            Blocks.Dispose();
            Spikes.Dispose();
            Vines.Dispose();
            Moss.Dispose();
            CellGroups.Dispose();
            Tiles.Dispose();
        }
    }
}

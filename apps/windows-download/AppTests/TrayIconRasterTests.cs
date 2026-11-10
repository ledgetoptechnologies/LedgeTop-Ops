using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using LedgeTop.Files;

internal static class TrayIconRasterTests
{
    internal static Task Run()
    {
        var source = ShellTrayIcon.RenderBrandBitmap();
        if (source.PixelWidth != 32 || source.PixelHeight != 32) throw new Exception("Unexpected tray raster size.");
        foreach (var size in new[] { 16, 20, 24, 32 }) {
            var visual = new DrawingVisual();
            RenderOptions.SetBitmapScalingMode(visual, BitmapScalingMode.HighQuality);
            using (var drawing = visual.RenderOpen()) drawing.DrawImage(source, new Rect(0, 0, size, size));
            var rendered = new RenderTargetBitmap(size, size, 96, 96, PixelFormats.Pbgra32);
            rendered.Render(visual);
            var bitmap = new FormatConvertedBitmap(rendered, PixelFormats.Bgra32, null, 0);
            var pixels = new byte[size * size * 4]; bitmap.CopyPixels(pixels, size * 4, 0);
            var dark = 0; var light = 0; var orange = 0;
            for (var i = 0; i < pixels.Length; i += 4) {
                var b = pixels[i]; var g = pixels[i + 1]; var r = pixels[i + 2]; var a = pixels[i + 3];
                if (a < 200) continue;
                if (r < 70 && g < 70 && b < 70) dark++;
                if (r > 175 && g > 175 && b > 175) light++;
                if (r > 150 && g is > 35 and < 170 && b < 100) orange++;
            }
            if (dark < size || light < 3 || orange == 0)
                throw new Exception($"Tray mark lost its dark backing or light/orange details at {size}px.");
            // The opaque backing makes the light mark contrast with both a light
            // and a dark notification area; corners should remain transparent.
            if (pixels[3] >= 200) throw new Exception($"Tray corners are unexpectedly opaque at {size}px.");
        }
        return Task.CompletedTask;
    }
}

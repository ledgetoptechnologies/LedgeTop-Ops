using LedgeTop.Files.Explorer;

internal static class BoundedManifestReadTests
{
    internal static int Run()
    {
        using (var exact = new ChangingStream([1, 2, 3, 4], 4, 4)) {
            if (!ConnectedGenerationHandleLease.ReadBounded(exact, 4).SequenceEqual(new byte[] { 1, 2, 3, 4 })) throw new IOException("Exact cap failed.");
        }
        using (var over = new ChangingStream([1, 2, 3, 4, 5], 5, 5)) {
            Refuse(() => ConnectedGenerationHandleLease.ReadBounded(over, 4));
            if (over.ReadCalls != 0) throw new IOException("Over-cap input was read.");
        }
        using (var mismatch = new ChangingStream([1, 2, 3, 4], 4, 4)) {
            Refuse(() => ConnectedGenerationHandleLease.ReadBounded(mismatch, 4, 3));
            if (mismatch.ReadCalls != 0) throw new IOException("Mismatched file was read.");
        }
        using (var shrink = new ChangingStream([1, 2, 3], 4, 3)) Refuse(() => ConnectedGenerationHandleLease.ReadBounded(shrink, 4));
        using (var growth = new ChangingStream([1, 2, 3, 4], 4, 5)) Refuse(() => ConnectedGenerationHandleLease.ReadBounded(growth, 4));
        Console.WriteLine("PASS bounded manifest read: cap, cap+1, expected-length mismatch, shrink and growth; synthetic stream only.");
        return 0;
    }
    private static void Refuse(Action operation)
    {
        try { operation(); } catch (IOException) { return; }
        throw new IOException("Expected bounded read refusal.");
    }
    private sealed class ChangingStream(byte[] bytes, long before, long after) : Stream
    {
        private long position;
        internal int ReadCalls { get; private set; }
        public override bool CanRead => true;
        public override bool CanSeek => true;
        public override bool CanWrite => false;
        public override long Length => ReadCalls == 0 ? before : after;
        public override long Position { get => position; set => position = value; }
        public override int Read(Span<byte> buffer)
        {
            ReadCalls++;
            var count = Math.Min(buffer.Length, Math.Max(0, bytes.Length - (int)position));
            bytes.AsSpan((int)position, count).CopyTo(buffer); position += count; return count;
        }
        public override int Read(byte[] buffer, int offset, int count) => Read(buffer.AsSpan(offset, count));
        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}

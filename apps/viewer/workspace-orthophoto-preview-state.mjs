// Decoding may finish after a task panel has replaced its original canvas.
// Apply the cached result to the currently mounted previews without rebuilding
// the task, its live output, or the user's current workspace focus.
export function synchronizeOrthophotoPreviews(container, outputId, preview) {
  if (!container || !['ready', 'failed'].includes(preview?.status)) return 0;
  if (preview.status === 'ready' && (typeof preview.dataUrl !== 'string' || !preview.dataUrl.startsWith('data:image/png;base64,'))) return 0;
  let updated = 0;
  for (const canvas of container.querySelectorAll('[data-ortho-output-id]')) {
    if (canvas.dataset.orthoOutputId !== outputId) continue;
    const figure = canvas.closest('.task-ortho-preview');
    if (!figure) continue;
    if (preview.status === 'failed') {
      figure.className = 'task-ortho-preview unavailable';
      figure.innerHTML = '<div role="img" aria-label="Orthophoto preview unavailable">Preview unavailable</div><figcaption>Published orthophoto</figcaption>';
    } else {
      const image = canvas.ownerDocument.createElement('img');
      image.src = preview.dataUrl;
      image.alt = 'Published orthophoto preview';
      canvas.replaceWith(image);
      figure.className = 'task-ortho-preview';
    }
    updated++;
  }
  return updated;
}

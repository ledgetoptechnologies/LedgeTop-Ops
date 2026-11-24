// Small DOM helper for the Marks panel: text is set as text, never as HTML.
export function h(document, tag, attributes = {}, ...children) {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === false || value == null) continue;
    if (name === 'class') element.className = value;
    else if (name === 'text') element.textContent = value;
    else element.setAttribute(name, value === true ? '' : value);
  }
  element.append(...children.filter(child => child != null));
  return element;
}

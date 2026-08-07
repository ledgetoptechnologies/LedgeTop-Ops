import { Marked } from "marked";
import sanitizeHtml from "sanitize-html";

export const SOP_SANITIZER_VERSION = 1;

export interface SopTocItem {
  id: string;
  level: number;
  text: string;
}

export interface RenderedSopMarkdown {
  html: string;
  toc: SopTocItem[];
  sanitizerVersion: number;
}

const markdown = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    // Raw HTML is not part of the SOP Markdown dialect. It is removed before
    // the allow-list sanitizer runs, rather than interpreted as authored HTML.
    html() {
      return "";
    },
  },
});

const attachmentPath = /^\/api\/operations\/[^/?#]+\/job-brief\/attachments\/[^/?#]+\/content$/;
const sopPath = /^\/sops(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)?\/?$/;

function safeLocalPath(value: string, attachmentOnly = false): boolean {
  if (!value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(value))
    return false;
  if (/%(?:2f|5c)/i.test(value)) return false;
  try {
    const parsed = new URL(value, "https://operations.invalid");
    if (parsed.origin !== "https://operations.invalid" || parsed.username || parsed.password)
      return false;
    const segments = parsed.pathname.split("/");
    if (segments.some(segment => {
      const decoded = decodeURIComponent(segment);
      return decoded === "." || decoded === "..";
    })) return false;
    return attachmentPath.test(parsed.pathname) || (!attachmentOnly && sopPath.test(parsed.pathname));
  } catch {
    return false;
  }
}

export function isSafeSopLink(value: string): boolean {
  const candidate = value.trim();
  if (!candidate || /[\u0000-\u001f\u007f\\]/.test(candidate)) return false;
  if (candidate.startsWith("#")) return /^#[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(candidate);
  if (safeLocalPath(candidate)) return true;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

export function isSafeSopImage(value: string): boolean {
  return safeLocalPath(value.trim(), true);
}

function sanitize(value: string): string {
  return sanitizeHtml(value, {
    allowedTags: [
      "h1", "h2", "h3", "h4", "h5", "h6", "p", "ul", "ol", "li",
      "strong", "em", "del", "code", "pre", "blockquote", "table", "thead",
      "tbody", "tr", "th", "td", "a", "img", "hr", "br", "input",
    ],
    allowedAttributes: {
      a: ["href", "title", "rel"],
      img: ["src", "alt", "title"],
      input: ["type", "checked", "disabled"],
      h1: ["id"], h2: ["id"], h3: ["id"], h4: ["id"], h5: ["id"], h6: ["id"],
      ul: ["class"], li: ["class"],
    },
    allowedClasses: {
      ul: ["contains-task-list"],
      li: ["task-list-item"],
    },
    allowedSchemes: ["https"],
    allowedSchemesAppliedToAttributes: ["href", "src"],
    allowProtocolRelative: false,
    enforceHtmlBoundary: true,
    transformTags: {
      a: (_tagName, attributes) => {
        const href = attributes.href || "";
        if (!isSafeSopLink(href)) return { tagName: "span", attribs: {} };
        const external = href.startsWith("https://");
        return {
          tagName: "a",
          attribs: {
            ...attributes,
            href,
            ...(external ? { rel: "noopener noreferrer nofollow" } : {}),
          },
        };
      },
      img: (_tagName, attributes) => isSafeSopImage(attributes.src || "")
        ? { tagName: "img", attribs: attributes }
        : { tagName: "span", attribs: {} },
      input: (_tagName, attributes) => attributes.type === "checkbox"
        ? {
            tagName: "input",
            attribs: {
              type: "checkbox",
              disabled: "",
              ...(Object.hasOwn(attributes, "checked") ? { checked: "" } : {}),
            },
          }
        : { tagName: "span", attribs: {} },
    },
  });
}

function textFromHeading(value: string): string {
  return sanitizeHtml(value, { allowedTags: [], allowedAttributes: {} })
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity: string) => {
      const normalized = entity.toLowerCase();
      if (normalized === "amp") return "&";
      if (normalized === "lt") return "<";
      if (normalized === "gt") return ">";
      if (normalized === "quot") return '"';
      if (normalized === "apos") return "'";
      const codePoint = normalized.startsWith("#x")
        ? Number.parseInt(normalized.slice(2), 16)
        : Number.parseInt(normalized.slice(1), 10);
      return Number.isSafeInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : match;
    })
    .replace(/\s+/g, " ")
    .trim();
}

function headingSlug(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "section";
}

export function renderSopMarkdown(source: string): RenderedSopMarkdown {
  const parsed = markdown.parse(source, { async: false });
  const clean = sanitize(typeof parsed === "string" ? parsed : "");
  const toc: SopTocItem[] = [];
  const counts = new Map<string, number>();
  const withHeadings = clean.replace(
    /<h([1-6])>([\s\S]*?)<\/h\1>/g,
    (_match, rawLevel: string, content: string) => {
      const text = textFromHeading(content);
      const base = headingSlug(text);
      const count = (counts.get(base) || 0) + 1;
      counts.set(base, count);
      const id = `sop-heading-${base}${count > 1 ? `-${count}` : ""}`;
      const level = Number(rawLevel);
      toc.push({ id, level, text });
      return `<h${level} id="${id}">${content}</h${level}>`;
    },
  );
  return {
    html: sanitize(withHeadings),
    toc,
    sanitizerVersion: SOP_SANITIZER_VERSION,
  };
}

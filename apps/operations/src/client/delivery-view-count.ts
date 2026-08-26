type DeliveryCountItem = { prefix?: string; kind?: string };

type DeliveryViewCountOptions = {
  items: readonly DeliveryCountItem[];
  searching?: boolean;
  loading?: boolean;
  error?: boolean;
  partial?: boolean;
};

const number = new Intl.NumberFormat("en-US");

/** Count the current listing only, never a folder's descendant metadata. */
export function deliveryViewCountText({
  items,
  searching = false,
  loading = false,
  error = false,
  partial = false,
}: DeliveryViewCountOptions): string {
  if (loading) return searching ? "Updating search results…" : "Loading folder items…";
  if (error) return "Item count unavailable. Reload this view to try again.";

  const folders = items.filter((item) => item.kind === "folder" || Boolean(item.prefix)).length;
  const files = items.length - folders;
  const label = (count: number, singular: string) => `${number.format(count)} ${singular}${count === 1 ? "" : "s"}`;
  const total = label(items.length, searching ? "matching item" : "item");
  return `${total}${partial ? " loaded" : ""} · ${label(folders, "folder")} · ${label(files, "file")}`;
}

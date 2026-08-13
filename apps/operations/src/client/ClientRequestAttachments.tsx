import { useEffect, useState } from "react";
import { Card, EmptyState, Loading } from "@ltds/ui";
import { api } from "./api";

interface RequestAttachment {
  id: string;
  name: string;
  contentType: string;
  size: number;
  downloadPath: string;
}

function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB"];
  let size = value / 1024, index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[index]}`;
}

function label(contentType: string): string {
  if (contentType === "application/pdf") return "PDF";
  if (contentType.startsWith("image/"))
    return contentType.slice("image/".length).toUpperCase();
  return "File";
}

export function ClientRequestAttachments({ requestId }: { requestId: string }) {
  const [attachments, setAttachments] = useState<RequestAttachment[] | null>(null),
    [error, setError] = useState("");

  const load = (signal?: AbortSignal) => {
    setError("");
    return api<{ attachments: RequestAttachment[] }>(
      `/api/client-service-requests/${encodeURIComponent(requestId)}/attachments`,
      { signal },
    )
      .then(value => setAttachments(value.attachments))
      .catch(caught => {
        if ((caught as Error).name !== "AbortError") setError((caught as Error).message);
      });
  };

  useEffect(() => {
    const controller = new AbortController();
    setAttachments(null);
    void load(controller.signal);
    return () => controller.abort();
  }, [requestId]);

  return (
    <Card title="Supporting files">
      {!attachments && !error ? <Loading /> : null}
      {error ? (
        <div className="request-attachment-error" role="alert">
          <span>{error}</span>
          <button type="button" className="button-ghost button-small" onClick={() => void load()}>
            Retry
          </button>
        </div>
      ) : null}
      {attachments?.length ? (
        <div className="request-attachments">
          {attachments.map(attachment => (
            <article key={attachment.id}>
              <div>
                <strong>{attachment.name}</strong>
                <small>{label(attachment.contentType)} · {bytes(attachment.size)}</small>
              </div>
              <a className="button-ghost button-small" href={attachment.downloadPath} download>
                Download {attachment.name}
              </a>
            </article>
          ))}
        </div>
      ) : attachments ? (
        <EmptyState title="No supporting files" detail="The client did not attach files to this request." />
      ) : null}
    </Card>
  );
}

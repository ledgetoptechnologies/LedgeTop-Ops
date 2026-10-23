import { useCallback, useEffect, useState } from "react";
import {
  APP_PLATFORMS, APP_PLATFORM_NAMES, APP_RELEASES_PATH, appDownloadSize, detectAppPlatform, parseAppReleases,
  type AppPlatform, type AppRelease,
} from "@ltds/shared";
import { Dialog, Skeleton } from "./index";

type Releases = { state: "loading" } | { state: "error" } | { state: "ready"; releases: AppRelease[] };

/**
 * "Get the app" from the account menu. Lists the signed-in desktop downloads the
 * current site offers; the app signs in with the same account used here.
 */
export function GetAppDialog({ open, onClose, releasesPath = APP_RELEASES_PATH }: {
  open: boolean; onClose: () => void; releasesPath?: string;
}) {
  const [releases, setReleases] = useState<Releases>({ state: "loading" });
  const load = useCallback((signal?: AbortSignal) => {
    setReleases({ state: "loading" });
    fetch(releasesPath, { credentials: "same-origin", cache: "no-store", headers: { accept: "application/json" }, signal })
      .then(async response => {
        // Not offered on this site yet: show the same "coming" state as an empty list.
        if (response.status === 404) return setReleases({ state: "ready", releases: [] });
        if (!response.ok) throw new Error(String(response.status));
        setReleases({ state: "ready", releases: parseAppReleases(await response.json()) });
      })
      .catch(error => { if (!signal?.aborted) { console.warn("App releases unavailable", error); setReleases({ state: "error" }); } });
  }, [releasesPath]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load, open]);

  const mine = typeof navigator === "undefined" ? null : detectAppPlatform(navigator.userAgent);
  const order = mine ? [mine, ...APP_PLATFORMS.filter(p => p !== mine)] : [...APP_PLATFORMS];
  return <Dialog open={open} onClose={onClose} title="Get the Ledge Top app"
    description="Download your files to your computer and pick up where you left off. Sign in to the app with the same account you use here.">
    {releases.state === "loading" && <Skeleton variant="list" rows={3} label="Checking for the app…" />}
    {releases.state === "error" && <div className="get-app-message" role="alert">
      <p>We couldn't check for the app just now.</p>
      <button type="button" className="button-ghost" onClick={() => load()}>Try again</button>
    </div>}
    {releases.state === "ready" && <>
      {releases.releases.length === 0 && <p className="get-app-message">The app isn't ready to download yet. It will show up here as soon as it is.</p>}
      <ul className="get-app-list">
        {order.map(platform => <PlatformRow key={platform} platform={platform} mine={platform === mine}
          release={releases.releases.find(r => r.platform === platform)} />)}
      </ul>
    </>}
  </Dialog>;
}

function PlatformRow({ platform, release, mine }: { platform: AppPlatform; release?: AppRelease; mine: boolean }) {
  const name = APP_PLATFORM_NAMES[platform];
  if (!release) return <li className="get-app-row is-unavailable">
    <div><strong>{name}</strong><span>Coming later</span></div>
  </li>;
  const published = new Date(release.publishedAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  return <li className={`get-app-row${mine ? " is-mine" : ""}`}>
    <div>
      <strong>{name}{mine && <small>This computer</small>}</strong>
      <span>Version {release.version} · {appDownloadSize(release.sizeBytes)} · {published}</span>
      {release.requirements && <span>{release.requirements}</span>}
      {release.notes && <p>{release.notes}</p>}
      <details><summary>Check the download</summary><code aria-label="SHA-256">{release.sha256}</code></details>
    </div>
    <a className={mine ? "button-orange" : "button-ghost"} href={release.downloadPath} download>Download for {name}</a>
  </li>;
}

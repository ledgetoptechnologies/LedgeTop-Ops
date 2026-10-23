import { useCallback, useEffect, useState } from "react";
import {
  APP_PLATFORMS, APP_PLATFORM_NAMES, appDownloadSize, appLatestPath, detectAppPlatform, parseAppLatest,
  type AppPlatform, type AppRelease,
} from "@ltds/shared";
import { Dialog, Skeleton } from "./index";

type Releases = { state: "loading" } | { state: "error" } | { state: "ready"; releases: AppRelease[] };

async function latest(base: string, platform: AppPlatform, signal?: AbortSignal): Promise<AppRelease | null> {
  const response = await fetch(appLatestPath(base, platform),
    { credentials: "same-origin", cache: "no-store", headers: { accept: "application/json" }, signal });
  // Not offered on this site yet: the same "coming" state as { available: false }.
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${platform}: ${response.status}`);
  return parseAppLatest(await response.json(), platform, base);
}

/**
 * "Get the app" from the account menu. Lists the signed-in desktop downloads this
 * site offers (`appApi` is its route base); the app signs in with the same account.
 */
export function GetAppDialog({ open, onClose, appApi }: { open: boolean; onClose: () => void; appApi: string }) {
  const [releases, setReleases] = useState<Releases>({ state: "loading" });
  const load = useCallback((signal?: AbortSignal) => {
    setReleases({ state: "loading" });
    Promise.all(APP_PLATFORMS.map(platform => latest(appApi, platform, signal)))
      .then(found => setReleases({ state: "ready", releases: found.filter((r): r is AppRelease => r !== null) }))
      .catch(error => { if (!signal?.aborted) { console.warn("App releases unavailable", error); setReleases({ state: "error" }); } });
  }, [appApi]);
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
  return <li className={`get-app-row${mine ? " is-mine" : ""}`}>
    <div>
      <strong>{name}{mine && <small>This computer</small>}{release.channel === "pilot" && <small className="is-pilot">Early access</small>}</strong>
      <span>Version {release.version} · {appDownloadSize(release.sizeBytes)}</span>
      {release.minSupported && <span>{release.minSupported}</span>}
      {release.notes && <p>{release.notes}</p>}
      <details><summary>Check the download</summary><code aria-label="SHA-256">{release.sha256}</code></details>
    </div>
    <a className={mine ? "button-orange" : "button-ghost"} href={release.downloadUrl} download>Download for {name}</a>
  </li>;
}

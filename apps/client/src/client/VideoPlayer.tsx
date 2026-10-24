import { useEffect, useRef, useState } from "react";
import "./VideoPlayer.css";

const clock = (seconds: number) => {
  const value = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
};

/** Persistent controls complement the browser's native player, which can hide its controls during playback. */
export function VideoPlayer({ src, name, onError }: { src: string; name: string; onError?: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const media = useRef<HTMLVideoElement>(null);
  const [paused, setPaused] = useState(true);
  const [muted, setMuted] = useState(true);
  const [loading, setLoading] = useState(true);
  const [blocked, setBlocked] = useState(false);
  const [failed, setFailed] = useState(false);
  const [duration, setDuration] = useState(0);
  const [position, setPosition] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const video = media.current;
    if (!video) return;
    let active = true;
    setPaused(true); setMuted(true); setLoading(true); setBlocked(false); setFailed(false);
    setDuration(0); setPosition(0); setNotice("");
    video.muted = true;
    void video.play().catch(error => {
      if (active && error?.name !== "AbortError" && error?.name !== "NotSupportedError") setBlocked(true);
    });
    return () => { active = false; video.pause(); };
  }, [src]);

  useEffect(() => {
    const changed = () => setFullscreen(document.fullscreenElement === root.current);
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !document.fullscreenElement || !root.current?.contains(document.fullscreenElement)) return;
      event.preventDefault(); event.stopPropagation();
      void document.exitFullscreen().catch(() => setNotice("Use the browser's fullscreen exit control."));
    };
    document.addEventListener("fullscreenchange", changed);
    document.addEventListener("keydown", escape, true);
    return () => { document.removeEventListener("fullscreenchange", changed); document.removeEventListener("keydown", escape, true); };
  }, []);

  const play = async () => {
    const video = media.current;
    if (!video) return;
    setNotice("");
    if (!video.paused) { video.pause(); return; }
    try { await video.play(); setBlocked(false); }
    catch { setBlocked(true); }
  };
  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement === root.current) await document.exitFullscreen();
      else if (root.current?.requestFullscreen) await root.current.requestFullscreen();
      else {
        const video = media.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
        if (video?.webkitEnterFullscreen) video.webkitEnterFullscreen();
        else setNotice("Fullscreen is unavailable in this browser. You can use the video's native controls.");
      }
    } catch { setNotice("Fullscreen is unavailable in this browser. You can use the video's native controls."); }
  };

  return <div ref={root} className="client-video-player" data-video-player aria-label={`Video player: ${name}`}>
    <div className="client-video-picture" aria-busy={loading && !blocked && !failed}>
      <video ref={media} src={src} aria-label={name} controls autoPlay muted playsInline preload="metadata"
        onLoadedData={() => setLoading(false)}
        onDurationChange={event => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)}
        onTimeUpdate={event => setPosition(event.currentTarget.currentTime)}
        onPlaying={() => { setPaused(false); setLoading(false); setBlocked(false); }}
        onPause={() => setPaused(true)} onEnded={() => setPaused(true)}
        onWaiting={() => setLoading(true)} onCanPlay={() => setLoading(false)}
        onVolumeChange={event => setMuted(event.currentTarget.muted)}
        onError={() => { setFailed(true); setLoading(false); onError?.(); }} />
      {!failed && (blocked || (paused && !loading)) && <button type="button" className="client-video-start" onClick={() => void play()} aria-label="Start video">▶ <span>Play video</span></button>}
      {(failed || blocked || loading) && <span className="client-video-status" role="status">
        {failed ? "This video could not be loaded. You can download the original file." : blocked ? "Playback is paused. Press Play to start the video." : "Loading video…"}
      </span>}
    </div>
    <div className="client-video-controls" role="group" aria-label="Video playback controls">
      <button type="button" disabled={failed} onClick={() => void play()} aria-label={paused ? "Play video" : "Pause video"}>{paused ? "▶ Play" : "Ⅱ Pause"}</button>
      <input type="range" aria-label="Seek video" min={0} max={duration || 0} step="0.1" value={Math.min(position, duration || 0)} disabled={!duration || failed}
        onChange={event => { if (media.current) { try { media.current.currentTime = Number(event.currentTarget.value); setPosition(media.current.currentTime); } catch { setNotice("Seeking is not available yet. Try again once the video has loaded."); } } }} />
      <span className="client-video-time" aria-label="Playback time">{clock(position)} / {clock(duration)}</span>
      <button type="button" disabled={failed} aria-label={muted ? "Unmute video" : "Mute video"} aria-pressed={!muted}
        onClick={() => { if (media.current) media.current.muted = !media.current.muted; }}>{muted ? "Unmute" : "Mute"}</button>
      <button type="button" onClick={() => void toggleFullscreen()} aria-label={fullscreen ? "Exit fullscreen" : "Enter fullscreen"}>{fullscreen ? "Exit fullscreen" : "Fullscreen"}</button>
    </div>
    {notice && <p className="client-video-notice" role="status">{notice}</p>}
  </div>;
}

import { useEffect, useRef, useState } from "react";
import { mediaSrc } from "../lib/blobs";
import { isGifBackground, isVideoBackground } from "../lib/chatBackground";
import { useReducedMotion } from "../lib/motion";

function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const on = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return visible;
}

/**
 * A chat background filling its box: a picture, or a muted video loop that
 * plays only while `animate` is on, the OS doesn't ask for reduced motion and
 * the window is showing (paused, it holds its first frame). A GIF kept as-is
 * (devices that can't make video) is frozen on a canvas when paused.
 */
export function ChatBackdrop({ value, animate, className }: { value: string; animate: boolean; className?: string }) {
  const reduce = useReducedMotion();
  const visible = usePageVisible();
  const moving = animate && !reduce;
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (moving && visible) void v.play().catch(() => {});
    else v.pause();
  }, [moving, visible, value]);

  if (isVideoBackground(value))
    return (
      <video
        ref={videoRef}
        src={mediaSrc(value)}
        className={className}
        muted
        loop
        playsInline
        autoPlay={moving}
        preload="auto"
        disablePictureInPicture
        aria-hidden
      />
    );
  if (isGifBackground(value) && !moving) return <FrozenImage src={mediaSrc(value)} className={className} />;
  return <img src={mediaSrc(value)} alt="" className={className} />;
}

/** A GIF's current frame painted once onto a canvas: a still picture of it. */
function FrozenImage({ src, className }: { src: string; className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      const c = canvasRef.current;
      if (!c) return;
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext("2d")?.drawImage(img, 0, 0);
    };
    img.src = src;
  }, [src]);
  // object-fit works on a canvas element in both engines, like on <img>.
  return <canvas ref={canvasRef} className={className} aria-hidden />;
}

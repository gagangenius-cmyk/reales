"use client";

import { useCallback, useEffect, useState } from "react";

export interface GalleryImage { src: string; alt: string }

/** Mosaic of the first photos that opens a full-screen viewer (keyboard arrows, Escape, swipe). Each image is a real button for accessibility. */
export function Gallery({ images, more, empty }: { images: GalleryImage[]; more: string; empty: string }) {
  const [open, setOpen] = useState<number | null>(null);
  const go = useCallback((d: number) => setOpen((i) => (i === null ? i : (i + d + images.length) % images.length)), [images.length]);
  useEffect(() => {
    if (open === null) return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(null); else if (e.key === "ArrowRight") go(1); else if (e.key === "ArrowLeft") go(-1); };
    document.addEventListener("keydown", key);
    const prev = document.body.style.overflow; document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", key); document.body.style.overflow = prev; };
  }, [open, go]);
  const [x0, setX0] = useState<number | null>(null);
  if (images.length === 0) return <div className="pf-gal-empty">{empty}</div>;
  const shown = images.slice(0, 5);
  return (
    <>
      <div className="pf-gal">
        {shown.map((im, i) => (
          <button key={im.src} type="button" onClick={() => setOpen(i)} aria-label={im.alt || `Photo ${i + 1}`}>
            <img src={im.src} alt={im.alt} loading={i === 0 ? "eager" : "lazy"} />
            {i === shown.length - 1 && images.length > shown.length && <span className="more">+{images.length - shown.length} {more}</span>}
          </button>
        ))}
      </div>
      {open !== null && (
        <div className="pf-lb" role="dialog" aria-modal="true" aria-label="Photos" onClick={() => setOpen(null)} onTouchStart={(e) => setX0(e.touches[0]!.clientX)} onTouchEnd={(e) => { if (x0 !== null) { const dx = e.changedTouches[0]!.clientX - x0; if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1); } setX0(null); }}>
          <img src={images[open]!.src} alt={images[open]!.alt} onClick={(e) => e.stopPropagation()} key={open} />
          <button className="x" type="button" aria-label="Close" onClick={() => setOpen(null)}>&times;</button>
          {images.length > 1 && <><button className="p" type="button" aria-label="Previous" onClick={(e) => { e.stopPropagation(); go(-1); }}>&lsaquo;</button><button className="n" type="button" aria-label="Next" onClick={(e) => { e.stopPropagation(); go(1); }}>&rsaquo;</button></>}
          <span className="c">{open + 1} / {images.length}</span>
        </div>
      )}
    </>
  );
}

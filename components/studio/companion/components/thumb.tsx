/** Local image preview from an object URL; nothing is fetched or optimised. */
export function Thumb({ src, alt, className }: { src: string; alt: string; className: string }) {
  // eslint-disable-next-line @next/next/no-img-element -- local object URL supplied by the file picker
  return <img src={src} alt={alt} className={className} />;
}

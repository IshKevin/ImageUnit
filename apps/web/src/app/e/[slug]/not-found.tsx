import { ImageOff } from 'lucide-react';

export default function NotFound() {
  return (
    <main className="relative grid min-h-screen place-items-center overflow-hidden px-6 text-center">
      <div aria-hidden className="absolute left-1/2 top-1/3 -z-10 size-96 -translate-x-1/2 rounded-full bg-accent/10 blur-3xl" />
      <div className="max-w-sm space-y-3">
        <div className="mx-auto mb-5 grid size-14 place-items-center rounded-2xl bg-accent/10 text-accent ring-8 ring-accent/5">
          <ImageOff className="size-6" aria-hidden />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">Gallery not found</h1>
        <p className="text-sm leading-relaxed text-muted">Check the link, or ask the organiser to share it again.</p>
      </div>
    </main>
  );
}

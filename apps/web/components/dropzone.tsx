"use client";

import { useState } from "react";
import { useDropzone, type Accept, type FileRejection } from "react-dropzone";

/** "image/png,.csv,image/*" (the HTML accept syntax pages already use) into react-dropzone's {mime: [extensions]} shape. */
function toAccept(accept?: string): Accept | undefined {
  if (!accept) return undefined;
  const out: Record<string, string[]> = {};
  for (const a of accept.split(",").map((x) => x.trim()).filter(Boolean)) {
    if (a.startsWith(".")) (out["application/octet-stream"] ??= []).push(a);
    else (out[a] ??= []);
  }
  // Extension-only lists (".csv") should not widen to every file type: give each extension a likely MIME key.
  if (out["application/octet-stream"] && Object.keys(out).length === 1) {
    const exts = out["application/octet-stream"];
    delete out["application/octet-stream"];
    for (const e of exts) {
      const mime = e === ".csv" ? "text/csv" : e === ".pdf" ? "application/pdf" : "application/octet-stream";
      (out[mime] ??= []).push(e);
    }
  }
  return out;
}

const reason = (r: FileRejection[], maxBytes?: number) => {
  const codes = new Set(r.flatMap((x) => x.errors.map((e) => e.code)));
  const parts = [codes.has("file-invalid-type") && "wrong type", codes.has("file-too-large") && `over ${Math.round((maxBytes ?? 0) / 1_048_576)} MB`, codes.has("too-many-files") && "only one file allowed"].filter(Boolean);
  return `${r.length} file${r.length === 1 ? " was" : "s were"} skipped (${parts.join(", ") || "not accepted"}).`;
};

/**
 * Drag-and-drop file picker built on react-dropzone (click and keyboard work too). Controlled: the page keeps the selected files and passes them back in
 * `files` so their names show. Rejected files are reported instead of being passed on.
 */
export function Dropzone({ onFiles, files = [], accept, multiple = false, disabled = false, label, hint, required = false, maxBytes }: {
  onFiles: (files: File[]) => void; files?: File[]; accept?: string; multiple?: boolean; disabled?: boolean; label?: string; hint?: string; required?: boolean; maxBytes?: number;
}) {
  const [msg, setMsg] = useState<string | null>(null);
  const { getRootProps, getInputProps, isDragActive, isDragReject } = useDropzone({
    accept: toAccept(accept), multiple, disabled, maxSize: maxBytes,
    onDrop: (ok, rejected) => {
      setMsg(rejected.length ? reason(rejected, maxBytes) : null);
      if (ok.length) onFiles(multiple ? ok : ok.slice(0, 1));
    },
  });
  const border = isDragReject ? "var(--danger, #dc2626)" : isDragActive ? "var(--accent)" : "var(--border)";

  return (
    <div className="flex flex-col gap-1.5 text-sm">
      {label && <span className="muted text-xs font-medium">{label}</span>}
      <div
        {...getRootProps({ "aria-label": label ?? "File upload" })}
        className="flex min-h-24 flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed px-4 py-5 text-center transition-colors"
        style={{ borderColor: border, background: isDragActive ? "var(--card-2)" : "transparent", opacity: disabled ? 0.5 : 1, cursor: disabled ? "not-allowed" : "pointer" }}
      >
        <input {...getInputProps({ required: required && files.length === 0 })} />
        <span className="font-medium">{isDragReject ? "This file type is not accepted" : isDragActive ? "Drop to add" : multiple ? "Drag files here or click to choose" : "Drag a file here or click to choose"}</span>
        {hint && <span className="muted text-xs">{hint}</span>}
        {files.length > 0 && <span className="text-xs" style={{ color: "var(--accent)" }}>{files.length === 1 ? files[0]!.name : `${files.length} files selected`}</span>}
      </div>
      {msg && <span role="alert" className="err text-xs">{msg}</span>}
    </div>
  );
}

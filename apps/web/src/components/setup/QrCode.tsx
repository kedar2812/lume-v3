"use client";
import { useMemo } from "react";
import { qrMatrix, qrPath } from "@/lib/qr";
import s from "./setup.module.css";

const QUIET = 4; // the standard's quiet zone, in modules

/**
 * The QR code, drawn here from the matrix — no network, no image service. The plate stays white in
 * both themes: a QR code is only readable at full contrast, and phones are unforgiving about it.
 */
export function QrCode({ text, size = 172 }: { text: string; size?: number }) {
  const matrix = useMemo(() => {
    try {
      return qrMatrix(text);
    } catch {
      return null; // longer than version 10 holds: the key below is then the only way in
    }
  }, [text]);
  if (!matrix) return null;
  const n = matrix.length;
  const span = n + QUIET * 2;
  return (
    <svg
      className={s.qr}
      width={size}
      height={size}
      viewBox={`0 0 ${span} ${span}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label="QR code for your authenticator app"
    >
      <rect width={span} height={span} fill="#fff" />
      <g transform={`translate(${QUIET} ${QUIET})`}>
        <path d={qrPath(matrix)} fill="#000" />
      </g>
    </svg>
  );
}

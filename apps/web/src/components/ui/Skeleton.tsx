import s from "./Skeleton.module.css";

export function Skeleton({
  width = "100%",
  height = 14,
  radius,
}: {
  width?: number | string;
  height?: number | string;
  radius?: number;
}) {
  return <span aria-hidden className={s.sk} style={{ width, height, borderRadius: radius }} />;
}

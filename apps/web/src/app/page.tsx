export const dynamic = "force-dynamic";

export default function Home() {
  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        background: "#EEF0F3",
        color: "#0A0C11",
      }}
    >
      <div style={{ textAlign: "center" }}>
        <img src="/lume-mark.png" alt="" width={64} height={64} />
        <h1 style={{ letterSpacing: "0.14em", margin: "16px 0 4px" }}>LUME</h1>
        <p style={{ color: "#5A606D", margin: 0 }}>Foundations are up.</p>
      </div>
    </main>
  );
}

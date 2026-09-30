"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { day } from "@/lib/format";
import { formatMoney, inr } from "@/lib/money";
import { Bell } from "./Bell";
import { Head } from "./Shell";

type Payment = {
  id: string;
  clientId: string;
  clientName: string;
  amount: number;
  currency: string;
  rateToInr: number | null;
  amountInr: number | null;
  paidAt: string;
  paidUntil: string | null;
  note: string | null;
};

/** Payments (spec §4.4): every payment, in its own currency and in rupees at its day's rate, newest first. */
export function PaymentsScreen() {
  const [list, setList] = useState<Payment[] | null>(null);
  useEffect(() => {
    void api.get<{ payments: Payment[] }>("/api/payments").then((x) => x.ok && setList(x.data.payments));
  }, []);
  const total = (list ?? []).reduce((t, p) => t + (p.amountInr ?? 0), 0);
  return (
    <>
      <Head
        title="Payments"
        sub="Every payment marked, in its own currency and in rupees at the rate of its day."
      >
        <Bell />
      </Head>
      <div className="body">
        {list && list.length > 0 && (
          <section className="card" aria-label="Received">
            <h2 className="h">Received, all time</h2>
            <span className="big">{inr(total)}</span>
          </section>
        )}
        {list && list.length > 0 && (
          <section className="card" style={{ padding: 8 }}>
            <table className="list">
              <thead>
                <tr>
                  <th>Paid</th>
                  <th>Client</th>
                  <th>Amount</th>
                  <th>In rupees</th>
                  <th>Paid until</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {list.map((p) => (
                  <tr key={p.id}>
                    <td className="num">{day(p.paidAt.slice(0, 10))}</td>
                    <td>
                      <Link
                        href={`/clients/${p.clientId}`}
                        style={{ fontWeight: 600, textDecoration: "none" }}
                      >
                        {p.clientName}
                      </Link>
                    </td>
                    <td className="num">{formatMoney(p.amount, p.currency)}</td>
                    <td className="num">
                      {p.amountInr !== null ? inr(p.amountInr) : <span className="note">rate unknown</span>}
                      {p.currency !== "INR" && p.rateToInr !== null && (
                        <span className="note"> · at ₹{p.rateToInr.toFixed(2)}</span>
                      )}
                    </td>
                    <td className="num">{p.paidUntil ? day(p.paidUntil) : "—"}</td>
                    <td className="note">{p.note ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
        {list && list.length === 0 && (
          <p className="empty">No payments yet. Mark paid on a client&apos;s page records one.</p>
        )}
      </div>
    </>
  );
}

import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { Header } from "@/components/Header";
import { WalletProvider } from "@/lib/wallet";

export const metadata: Metadata = {
  title: "SealedLaunch",
  description: "Sealed-bid, uniform-price token launches on NEAR testnet. No snipers: everyone pays the same clearing price.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <WalletProvider>
          <Header />
          <main className="wrap">{children}</main>
        </WalletProvider>
      </body>
    </html>
  );
}
